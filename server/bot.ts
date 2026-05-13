// server/bot.ts
// Telegram bot for ExpatEvents — grammY, database-backed state,
// RU/EN localisation, preview cards with images, group-aware RSVP,
// organiser commands, rate-limiting, idempotent notifications.
//
// Key fixes vs previous version:
//   1. approve_event: answerCallbackQuery FIRST, then async work in try/catch
//   2. editMessageText uses ctx.callbackQuery.message (not ctx.msg which is
//      undefined in callback handlers) with a plain fallback text
//   3. users.language / users.blocked guarded with optional chaining so missing
//      columns don't crash the handler — falls back to "en" / false
//   4. decline_event same defensive pattern

import { Bot, Context, session, SessionFlavor, InlineKeyboard } from "grammy";
import { conversations, ConversationFlavor } from "@grammyjs/conversations";
import { db } from "./db";
import { users, rsvps, pendingApprovals, events, notifications } from "@shared/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { EVENT_CATEGORIES, getCategoryLabel } from "@shared/categories";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface EventData {
  id: number;
  title: string;
  category: string;
  date: Date;
  venueCity: string;
  venueAddress: string;
  description: string;
  organizerId?: string;
  imageUrl?: string;
  organizerTelegramId?: string;
}

interface SessionData {
  editingEventId?: number;
  awaitingField?: string;
}
type BotContext = Context & SessionFlavor<SessionData> & ConversationFlavor;

// ── Environment ────────────────────────────────────────────────────────────────

const EXPAT_API_URL    = (process.env.EXPAT_API_URL ?? "https://expatevents.org").replace(/\/$/, "");
const EXPAT_API_SECRET = process.env.EXPAT_API_SECRET ?? "";
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

const CATEGORY_ICONS: Record<string, string> = {
  networking: "🔗", tech: "💻", culture: "🎨", food: "🍔",
  sports: "⚽", music: "🎵", language: "🌍", outdoor: "🏕️",
  games: "🎮", business: "💼", wellness: "🧘", family: "👨‍👩‍👧",
  social: "🤝", volunteering: "🙌", other: "📌",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Localisation ───────────────────────────────────────────────────────────────

const LOCALE: Record<string, Record<string, any>> = {
  ru: {
    welcome:       "👋 Добро пожаловать в *ExpatEvents*!\n\nЯ оповещаю о событиях, которые вам интересны.",
    accountLinked: "✅ *Ваш аккаунт ExpatEvents привязан!*\n\nВы будете получать уведомления о мероприятиях.",
    linkExpired:   "❌ Ссылка устарела. Создайте новую в настройках аккаунта.",
    helpText:      "🤖 *Помощь* — я пришлю события по вашим интересам, здесь можно сразу RSVP.",
    going:         "✅ Вы идёте!",
    maybe:         "🤔 Возможно",
    no:            "❌ Не смогу",
    cleared:       "Ответ удалён.",
    eventLive:     "🎉 *Ваше событие опубликовано!*\n\nВот карточка для форварда — люди могут RSVP прямо из Telegram.",
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) =>
      `${icon} *Новое событие в категории ${cat}*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[Подробнее](https://expatevents.org/events/${id})`,
    demandSignal: (count: number, day: string, hour: string, cat: string) =>
      `*${count} экспатов* свободны в *${day} в ${hour}* и интересуются *${cat}*.\nПодумайте о проведении мероприятия!`,
  },
  en: {
    welcome:       "👋 Welcome to *ExpatEvents*!\n\nI'll keep you updated on events matching your interests.",
    accountLinked: "✅ *Your ExpatEvents account is linked!*\n\nYou'll receive event notifications.",
    linkExpired:   "❌ That link has expired. Please generate a new one from your account settings.",
    helpText:      "🤖 *Help* — I send you events matching your interests and let you RSVP directly.",
    going:         "✅ You're going!",
    maybe:         "🤔 Maybe",
    no:            "❌ Can't make it",
    cleared:       "Response cleared.",
    eventLive:     "🎉 *Your event is live!*\n\nHere's your shareable preview card. Forward it to any chat — people can RSVP directly from Telegram.",
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) =>
      `${icon} *New ${cat} event*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[View event](https://expatevents.org/events/${id})`,
    demandSignal: (count: number, day: string, hour: string, cat: string) =>
      `*${count} expats* are free on *${day} at ${hour}* and interested in *${cat}*.\nConsider hosting an event!`,
  },
};

function t(ctx: Context, key: string, ...args: any[]): string {
  const lang = ctx.from?.language_code?.startsWith("ru") ? "ru" : "en";
  const template = LOCALE[lang]?.[key] ?? LOCALE.en[key];
  return typeof template === "function" ? template(...args) : (template ?? key);
}

function tStatic(lang: string, key: string, ...args: any[]): string {
  const loc = LOCALE[lang]?.[key] ?? LOCALE.en[key];
  return typeof loc === "function" ? loc(...args) : (loc ?? key);
}

// ── Date helpers ───────────────────────────────────────────────────────────────

function safeMoscowStr(utcDate: any): string {
  try {
    const d = new Date(utcDate);
    if (isNaN(d.getTime())) return "Date TBD";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone:  "Europe/Moscow",
      weekday:   "short", day: "numeric", month: "short",
      hour:      "2-digit", minute: "2-digit",
    }).format(d);
  } catch {
    return "Date TBD";
  }
}

function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

// ── Safe column accessors ──────────────────────────────────────────────────────
// users.language and users.blocked may not exist in the meh-auth schema yet.
// We guard with (user as any) so a missing column doesn't throw at query time.

function userLang(user: any): string {
  return (user as any)?.language ?? "en";
}

function userBlocked(user: any): boolean {
  return (user as any)?.blocked === true;
}

// ── DB helpers ─────────────────────────────────────────────────────────────────

async function getUserLang(telegramId: string): Promise<string> {
  try {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.telegramId, telegramId));
    return userLang(user);
  } catch {
    return "en";
  }
}

async function markUserBlocked(telegramId: string): Promise<void> {
  try {
    // Only attempt if column exists; silently skip otherwise
    await db
      .update(users)
      .set({ blocked: true } as any)
      .where(eq(users.telegramId, telegramId));
    console.log(`[bot] User ${telegramId} marked blocked`);
  } catch {
    // Column may not exist yet — not critical
  }
}

const notifiedForEvent = new Map<number, Set<string>>();

// ── RSVP persistence ───────────────────────────────────────────────────────────

async function loadRsvpCounts(eventId: number): Promise<{ going: number; maybe: number; no: number }> {
  try {
    const rows = await db
      .select({ status: rsvps.status })
      .from(rsvps)
      .where(eq(rsvps.eventId, eventId));
    const counts = { going: 0, maybe: 0, no: 0 };
    for (const r of rows) {
      const k = r.status as keyof typeof counts;
      if (k in counts) counts[k]++;
    }
    return counts;
  } catch {
    return { going: 0, maybe: 0, no: 0 };
  }
}

async function setRsvpStatus(
  userId: number,
  eventId: number,
  status: "going" | "maybe" | "no" | "none",
  sourceChatId?: number,
  sourceChatTitle?: string
): Promise<void> {
  if (status === "none") {
    await db
      .delete(rsvps)
      .where(and(eq(rsvps.userId, userId), eq(rsvps.eventId, eventId)));
  } else {
    await db
      .insert(rsvps)
      .values({
        userId, eventId, status,
        sourceChatId:    sourceChatId    ?? null,
        sourceChatTitle: sourceChatTitle ?? null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rsvps.userId, rsvps.eventId],
        set: {
          status,
          sourceChatId:    sourceChatId    ?? null,
          sourceChatTitle: sourceChatTitle ?? null,
          updatedAt: new Date(),
        },
      });
  }
}

async function getEventAttendees(eventId: number): Promise<{
  userId: number;
  telegramId?: string;
  username?: string;
  status: string;
  sourceChatTitle?: string;
}[]> {
  const rows = await db
    .select({ userId: rsvps.userId, status: rsvps.status, sourceChatTitle: rsvps.sourceChatTitle })
    .from(rsvps)
    .where(eq(rsvps.eventId, eventId));

  const result = [];
  for (const row of rows) {
    const [user] = await db
      .select({ telegramId: users.telegramId, username: users.username })
      .from(users)
      .where(eq(users.id, row.userId));
    result.push({ ...row, telegramId: user?.telegramId ?? undefined, username: user?.username ?? undefined });
  }
  return result;
}

// ── Pending approvals ──────────────────────────────────────────────────────────

async function storePendingApproval(event: EventData): Promise<string> {
  const token = Math.random().toString(36).slice(2, 10);
  await db.insert(pendingApprovals).values({
    token,
    eventId:   event.id,
    eventData: JSON.stringify(event),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return token;
}

async function getPendingApproval(token: string): Promise<EventData | null> {
  const [row] = await db
    .select()
    .from(pendingApprovals)
    .where(and(
      eq(pendingApprovals.token, token),
      sql`${pendingApprovals.expiresAt} > NOW()`
    ));
  if (!row) return null;
  return JSON.parse(row.eventData as string) as EventData;
}

async function deletePendingApproval(token: string): Promise<void> {
  await db.delete(pendingApprovals).where(eq(pendingApprovals.token, token));
}

// ── Event cache ────────────────────────────────────────────────────────────────

async function saveEvent(event: EventData): Promise<void> {
  await db
    .insert(events)
    .values({
      id:           event.id,
      title:        event.title,
      category:     event.category,
      date:         event.date,
      venueCity:    event.venueCity,
      venueAddress: event.venueAddress,
      description:  event.description,
      organizerId:  event.organizerId ? parseInt(event.organizerId) : null,
      imageUrl:     event.imageUrl ?? null,
      dispatched:   true,
      createdAt:    new Date(),
    })
    .onConflictDoUpdate({
      target: [events.id],
      set: {
        title: event.title,   category:     event.category,
        date:  event.date,    venueCity:    event.venueCity,
        venueAddress: event.venueAddress,
        description:  event.description,
        imageUrl:     event.imageUrl ?? null,
      },
    });
}

// ── Notification queue ─────────────────────────────────────────────────────────

const notificationQueue: Array<{
  userId:    number;
  telegramId: string;
  text:      string;
  imageUrl?: string;
  keyboard:  InlineKeyboard;
  lang:      string;
}> = [];
let processingQueue = false;

async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;
  while (notificationQueue.length > 0) {
    const item = notificationQueue.shift()!;
    try {
      if (item.imageUrl) {
        await bot.api.sendPhoto(item.telegramId, item.imageUrl, {
          caption:      item.text,
          parse_mode:   "Markdown",
          reply_markup: item.keyboard,
        });
      } else {
        await bot.api.sendMessage(item.telegramId, item.text, {
          parse_mode:   "Markdown",
          reply_markup: item.keyboard,
        });
      }
    } catch (err: any) {
      if (err?.error_code === 403) await markUserBlocked(item.telegramId);
      else console.error(`[bot] Failed to deliver to ${item.telegramId}:`, err?.message);
    }
    await new Promise(r => setTimeout(r, 50)); // ~20 msg/sec, within Telegram limits
  }
  processingQueue = false;
}

function enqueueNotification(n: typeof notificationQueue[number]): void {
  notificationQueue.push(n);
  processQueue();
}

// ── Bot instance ───────────────────────────────────────────────────────────────

export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);
const rsvpCooldown = new Map<string, number>();

bot.use(session({ initial: () => ({} as SessionData) }));
bot.use(conversations());

// ── /start ─────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const token = ctx.match?.trim();
  if (token) {
    try {
      const { handleTelegramStartToken } = await import("./telegram-link");
      await handleTelegramStartToken(String(ctx.chat.id), token);
      await ctx.reply(t(ctx, "accountLinked"), { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(t(ctx, "linkExpired"));
    }
    return;
  }
  await ctx.reply(t(ctx, "welcome"), { parse_mode: "Markdown" });
});

// ── /help ──────────────────────────────────────────────────────────────────────

bot.command("help", async (ctx) => {
  await ctx.reply(t(ctx, "helpText"), { parse_mode: "Markdown" });
});

// ── Organiser helpers ──────────────────────────────────────────────────────────

async function resolveOrganiserUserId(telegramId: string): Promise<number | null> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramId, telegramId));
  return user?.id ?? null;
}

// ── /myevents ─────────────────────────────────────────────────────────────────

bot.command("myevents", async (ctx) => {
  const userId = await resolveOrganiserUserId(String(ctx.from!.id));
  if (!userId) {
    await ctx.reply("Your account is not linked. Visit expatevents.org → Settings → Connect Telegram.");
    return;
  }
  const rows = await db.select().from(events).where(eq(events.organizerId, userId));
  if (rows.length === 0) {
    await ctx.reply("You have no events yet.");
    return;
  }
  for (const e of rows) {
    const counts = await loadRsvpCounts(e.id);
    await ctx.reply(
      `*${e.title}*\n📅 ${safeMoscowStr(e.date)}\n✅ ${counts.going}  🤔 ${counts.maybe}  ❌ ${counts.no}\n\n` +
      `/attendees_${e.id}   /reshare_${e.id}   /edit_${e.id}`,
      { parse_mode: "Markdown" }
    );
  }
});

// ── /attendees_{id} ────────────────────────────────────────────────────────────

bot.hears(/^\/attendees_(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  const attendees = await getEventAttendees(eventId);
  if (attendees.length === 0) {
    await ctx.reply("No RSVPs yet for this event.");
    return;
  }
  const lines: string[] = [`*Attendees — event #${eventId}*\n`];
  for (const a of attendees) {
    const emoji = a.status === "going" ? "✅" : a.status === "maybe" ? "🤔" : "❌";
    const name  = a.username ? `@${a.username}` : a.telegramId ?? String(a.userId);
    const from  = a.sourceChatTitle ? ` _(${a.sourceChatTitle})_` : "";
    lines.push(`${emoji} ${name}${from}`);
  }
  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// ── /edit_{id} ────────────────────────────────────────────────────────────────

bot.hears(/^\/edit_(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  await ctx.reply(`Edit your event:\nhttps://expatevents.org/events/${eventId}/edit`);
});

// ── /reshare_{id} ─────────────────────────────────────────────────────────────

bot.hears(/^\/reshare_(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) {
    await ctx.reply("Event not found.");
    return;
  }
  const cardText = buildPreviewCardText(event as unknown as EventData);
  const counts   = await loadRsvpCounts(eventId);
  const keyboard = rsvpKeyboardForCounts(eventId, counts);
  try {
    if (event.imageUrl) {
      await ctx.replyWithPhoto(event.imageUrl, {
        caption:      cardText,
        parse_mode:   "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(cardText, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } catch {
    await ctx.reply("Failed to regenerate preview. Try again later.");
  }
});

// ── Demand signal ──────────────────────────────────────────────────────────────

export async function notifyOrganiserDemand(organiserId: number, match: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
}): Promise<void> {
  const [organiser] = await db.select().from(users).where(eq(users.id, organiserId));
  if (!organiser?.telegramId) return;

  const icon      = CATEGORY_ICONS[match.category] ?? "📌";
  const lang      = userLang(organiser);
  const text      = tStatic(lang, "demandSignal", match.userCount, DAYS[match.day], fmtHour(match.hour), getCategoryLabel(match.category));
  const createUrl = `https://expatevents.org/create-event?category=${match.category}&day=${match.day}&hour=${match.hour}`;
  const keyboard  = new InlineKeyboard().url("✨ Create event", createUrl);

  try {
    await bot.api.sendMessage(organiser.telegramId, `${icon} ${text}`, {
      parse_mode:   "Markdown",
      reply_markup: keyboard,
    });
  } catch (err: any) {
    if (err?.error_code === 403) await markUserBlocked(organiser.telegramId);
  }
}

// ── RSVP keyboard ──────────────────────────────────────────────────────────────

function rsvpKeyboardForCounts(
  eventId: number,
  counts: { going: number; maybe: number; no: number }
): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Going${counts.going ? ` (${counts.going})` : ""}`,          `rsvp:going:${eventId}`)
    .text(`🤔 Maybe${counts.maybe ? ` (${counts.maybe})` : ""}`,          `rsvp:maybe:${eventId}`)
    .text(`❌ Can't make it${counts.no ? ` (${counts.no})` : ""}`,        `rsvp:no:${eventId}`);
}

// ── Preview card text ──────────────────────────────────────────────────────────

function buildPreviewCardText(event: EventData): string {
  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc    = (event.description ?? "").slice(0, 180);
  return (
    `${icon} *${event.title}*\n\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n` +
    `🏷 ${getCategoryLabel(event.category)}\n\n` +
    (desc ? `${desc}${(event.description ?? "").length > 180 ? "…" : ""}\n\n` : "") +
    `[View & register →](https://expatevents.org/events/${event.id})`
  );
}

// ── Send organiser preview card ────────────────────────────────────────────────

async function sendOrgPreviewCard(event: EventData): Promise<void> {
  if (!event.organizerTelegramId) return;

  const lang     = await getUserLang(event.organizerTelegramId);
  const intro    = tStatic(lang, "eventLive");
  const cardText = buildPreviewCardText(event);
  const counts   = await loadRsvpCounts(event.id);
  const keyboard = rsvpKeyboardForCounts(event.id, counts);

  try {
    await bot.api.sendMessage(event.organizerTelegramId, intro, { parse_mode: "Markdown" });

    if (event.imageUrl) {
      await bot.api.sendPhoto(event.organizerTelegramId, event.imageUrl, {
        caption:      cardText,
        parse_mode:   "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await bot.api.sendMessage(event.organizerTelegramId, cardText, {
        parse_mode:   "Markdown",
        reply_markup: keyboard,
      });
    }
  } catch (err: any) {
    if (err?.error_code === 403) await markUserBlocked(event.organizerTelegramId);
    else console.error(`[bot] Failed to send preview card to organiser:`, err?.message);
  }
}

// ── Dispatch notifications ─────────────────────────────────────────────────────

export async function dispatchEventNotifications(
  event: EventData
): Promise<{ sent: number; inApp: number }> {
  const matchingUsers = await db
    .select()
    .from(users)
    .where(sql`${event.category} = ANY(${users.interests})`);

  if (!notifiedForEvent.has(event.id)) notifiedForEvent.set(event.id, new Set());
  const alreadyNotified = notifiedForEvent.get(event.id)!;

  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc    = (event.description ?? "").slice(0, 200);

  let sent = 0, inApp = 0;

  for (const user of matchingUsers) {
    if (user.telegramId && alreadyNotified.has(user.telegramId)) continue;

    // In-app notification
    try {
      await db.insert(notifications).values({
        userId:   user.id,
        type:     "new_event",
        title:    `New ${getCategoryLabel(event.category)} event`,
        body:     `${event.title} — ${dateStr} at ${event.venueCity}`,
        appScope: "expat",
        eventId:  event.id,
        link:     `/events/${event.id}`,
      });
      inApp++;
    } catch (err: any) {
      console.error(`[bot] Failed to insert in-app notification for user ${user.id}:`, err?.message);
    }

    // Telegram notification
    if (user.telegramId && !userBlocked(user)) {
      const lang     = userLang(user);
      const text     = tStatic(lang, "newEvent", icon, getCategoryLabel(event.category), event.title, dateStr, event.venueCity, event.venueAddress, desc, event.id);
      const counts   = await loadRsvpCounts(event.id);
      const keyboard = rsvpKeyboardForCounts(event.id, counts);
      enqueueNotification({ userId: user.id, telegramId: user.telegramId, text, imageUrl: event.imageUrl, keyboard, lang });
      alreadyNotified.add(user.telegramId);
      sent++;
    }
  }

  await saveEvent(event);
  console.log(`[bot] Event ${event.id} dispatched: ${inApp} in-app, ${sent} Telegram queued`);
  return { sent, inApp };
}

// ── notifyMatchingUsers — admin gate ───────────────────────────────────────────

export async function notifyMatchingUsers(
  event: EventData
): Promise<{ sent: number; inApp: number }> {
  // No admin configured → dispatch immediately
  if (!ADMIN_TELEGRAM_ID) {
    console.warn("[bot] ADMIN_TELEGRAM_ID not set — dispatching without approval");
    const result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    return result;
  }

  const [totalMatches, telegramMatches] = await Promise.all([
    db.select({ id: users.id }).from(users)
      .where(sql`${event.category} = ANY(${users.interests})`),
    db.select({ id: users.id }).from(users)
      .where(and(isNotNull(users.telegramId), sql`${event.category} = ANY(${users.interests})`)),
  ]);

  let token: string;
  try {
    token = await storePendingApproval(event);
  } catch (err: any) {
    // If DB storage fails, fall back to immediate dispatch
    console.error("[bot] Could not store pending approval, dispatching immediately:", err?.message);
    const result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    return result;
  }

  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);

  const adminText =
    `${icon} *New event — notification approval*\n\n` +
    `*${event.title}*\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n` +
    `🏷 ${getCategoryLabel(event.category)}\n\n` +
    `*${totalMatches.length}* users with this interest ` +
    `(${telegramMatches.length} with Telegram connected).\n\n` +
    `Approve sending notifications?`;

  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve_event:${token}`)
    .text("❌ Decline", `decline_event:${token}`);

  try {
    await bot.api.sendMessage(ADMIN_TELEGRAM_ID, adminText, {
      parse_mode:   "Markdown",
      reply_markup: keyboard,
    });
    console.log(`[bot] Event ${event.id} awaiting admin approval (token: ${token})`);
  } catch (err: any) {
    console.error("[bot] Failed to message admin, dispatching immediately:", err?.message);
    await deletePendingApproval(token);
    const result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    return result;
  }

  return { sent: 0, inApp: 0 };
}

// ── Callback handlers ──────────────────────────────────────────────────────────

// ── RSVP ──────────────────────────────────────────────────────────────────────

bot.callbackQuery(/^rsvp:(going|maybe|no):(\d+)$/, async (ctx) => {
  const status  = ctx.match[1] as "going" | "maybe" | "no";
  const eventId = parseInt(ctx.match[2]);
  const userId  = ctx.from.id;
  const key     = `${userId}:${eventId}`;

  // Rate-limit: 2 s cooldown per user per event
  const now = Date.now();
  if (rsvpCooldown.has(key) && now - rsvpCooldown.get(key)! < 2000) {
    await ctx.answerCallbackQuery({ text: "Please wait a moment." });
    return;
  }
  rsvpCooldown.set(key, now);

  // Answer immediately so Telegram stops the spinner regardless of what follows
  await ctx.answerCallbackQuery();

  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.telegramId, String(userId)));

  if (!user) {
    await ctx.answerCallbackQuery({ text: "Link your account first at expatevents.org", show_alert: true });
    return;
  }

  const [existing] = await db
    .select({ status: rsvps.status })
    .from(rsvps)
    .where(and(eq(rsvps.userId, user.id), eq(rsvps.eventId, eventId)));

  const newStatus = (existing?.status === status) ? "none" : status;

  const chat           = ctx.chat;
  const sourceChatId   = chat?.id ?? 0;
  const sourceChatTitle = chat && "title" in chat ? (chat as any).title : undefined;

  await setRsvpStatus(user.id, eventId, newStatus, sourceChatId, sourceChatTitle);

  // Now send the real answer text
  const lang     = await getUserLang(String(userId));
  const feedback = newStatus === "none" ? tStatic(lang, "cleared") : tStatic(lang, newStatus);
  await ctx.answerCallbackQuery({ text: feedback }).catch(() => {});

  // Update keyboard with new counts
  const counts    = await loadRsvpCounts(eventId);
  const newKboard = rsvpKeyboardForCounts(eventId, counts);
  await ctx.editMessageReplyMarkup({ reply_markup: newKboard }).catch(() => {});

  // Write-back to expatevents (best-effort)
  fetch(`${EXPAT_API_URL}/api/bot/events/${eventId}/rsvp`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "X-Bot-Secret": EXPAT_API_SECRET },
    body:    JSON.stringify({ userId: String(user.id), status: newStatus }),
  }).catch(err => console.error("[bot] RSVP write-back failed:", err?.message));
});

// ── Approve event ─────────────────────────────────────────────────────────────
//
// FIX 1: answerCallbackQuery FIRST before any async DB work, so Telegram
//         stops the spinner immediately and doesn't time out.
// FIX 2: use ctx.callbackQuery.message (not ctx.msg) for editMessageText —
//         ctx.msg is undefined in callback query handlers in grammY.
// FIX 3: wrap the editMessageText in its own try/catch so a parse error
//         or "message not modified" never blocks the dispatch.

bot.callbackQuery(/^approve_event:(.+)$/, async (ctx) => {
  const token = ctx.match[1];

  // ── Answer immediately — stops the Telegram loading spinner ──────────────
  await ctx.answerCallbackQuery({ text: "Approving…" });

  // ── Load the pending approval ─────────────────────────────────────────────
  let event: EventData | null;
  try {
    event = await getPendingApproval(token);
  } catch (err: any) {
    console.error("[bot] Failed to load pending approval:", err?.message);
    await ctx.reply("❌ Database error loading approval. Please try again.");
    return;
  }

  if (!event) {
    await ctx.reply("⚠️ This approval has expired or was already processed.");
    // Remove the keyboard so it can't be tapped again
    try {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() });
    } catch { /* ignore */ }
    return;
  }

  // ── Delete from DB immediately (idempotency) ──────────────────────────────
  await deletePendingApproval(token).catch(() => {});

  // ── Mark the admin message as approved (best-effort edit) ─────────────────
  try {
    const adminMsg = ctx.callbackQuery.message;
    if (adminMsg) {
      const originalText = "text" in adminMsg ? adminMsg.text : "";
      await ctx.api.editMessageText(
        adminMsg.chat.id,
        adminMsg.message_id,
        `${originalText}\n\n✅ *Approved — dispatching notifications…*`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard() }
      );
    }
  } catch (editErr: any) {
    // Non-critical — don't let an edit failure block the actual dispatch
    console.warn("[bot] Could not edit admin approval message:", editErr?.message);
  }

  // ── Dispatch notifications + organiser card ────────────────────────────────
  let result = { sent: 0, inApp: 0 };
  try {
    result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
  } catch (dispatchErr: any) {
    console.error("[bot] Dispatch failed after approval:", dispatchErr?.message);
    await ctx.reply(`❌ Dispatch failed: ${dispatchErr?.message ?? "unknown error"}`);
    return;
  }

  // ── Confirmation message to admin ─────────────────────────────────────────
  await ctx.reply(
    `📬 *Notifications sent for "${event.title}"*\n\n` +
    `• *${result.sent}* Telegram messages queued\n` +
    `• *${result.inApp}* in-app notifications created\n` +
    `• Preview card sent to organiser`,
    { parse_mode: "Markdown" }
  );
});

// ── Decline event ─────────────────────────────────────────────────────────────

bot.callbackQuery(/^decline_event:(.+)$/, async (ctx) => {
  const token = ctx.match[1];

  // Answer immediately
  await ctx.answerCallbackQuery({ text: "Declined." });

  await deletePendingApproval(token).catch(() => {});

  try {
    const adminMsg = ctx.callbackQuery.message;
    if (adminMsg) {
      const originalText = "text" in adminMsg ? adminMsg.text : "";
      await ctx.api.editMessageText(
        adminMsg.chat.id,
        adminMsg.message_id,
        `${originalText}\n\n❌ *Declined — no notifications sent*`,
        { parse_mode: "Markdown", reply_markup: new InlineKeyboard() }
      );
    }
  } catch { /* non-critical */ }
});

// ── Admin commands ─────────────────────────────────────────────────────────────

bot.command("pending", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const rows = await db
    .select()
    .from(pendingApprovals)
    .where(sql`${pendingApprovals.expiresAt} > NOW()`);
  if (rows.length === 0) {
    await ctx.reply("No pending approvals.");
    return;
  }
  for (const row of rows) {
    const ev   = JSON.parse(row.eventData as string);
    const icon = CATEGORY_ICONS[ev.category] ?? "📌";
    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `approve_event:${row.token}`)
      .text("❌ Decline", `decline_event:${row.token}`);
    await ctx.reply(
      `${icon} *${ev.title}* (${getCategoryLabel(ev.category)})\n📅 ${safeMoscowStr(ev.date)}`,
      { parse_mode: "Markdown", reply_markup: keyboard }
    );
  }
});

bot.command("approve_all", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const rows = await db
    .select()
    .from(pendingApprovals)
    .where(sql`${pendingApprovals.expiresAt} > NOW()`);
  for (const row of rows) {
    const ev = JSON.parse(row.eventData as string);
    await dispatchEventNotifications(ev);
    await sendOrgPreviewCard(ev);
    await db.delete(pendingApprovals).where(eq(pendingApprovals.token, row.token));
  }
  await ctx.reply(`✅ Approved and dispatched ${rows.length} event${rows.length !== 1 ? "s" : ""}.`);
});

bot.command("findevents", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const query = ctx.match?.trim() ?? "";
  if (!query) { await ctx.reply("Usage: /findevents <title>"); return; }
  const results = await db
    .select()
    .from(events)
    .where(sql`LOWER(${events.title}) LIKE ${"%" + query.toLowerCase() + "%"}`);
  if (results.length === 0) { await ctx.reply("No events found."); return; }
  for (const e of results) {
    await ctx.reply(`*${e.title}* (ID ${e.id})\n/attendees_${e.id}  /reshare_${e.id}`, { parse_mode: "Markdown" });
  }
});

bot.command("stats", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const [evtCount] = await db.select({ count: sql<number>`count(*)` }).from(events);
  const [rsvCount] = await db.select({ count: sql<number>`count(*)` }).from(rsvps);
  await ctx.reply(`📊 *Stats*\nEvents: ${evtCount.count}\nRSVPs: ${rsvCount.count}`, { parse_mode: "Markdown" });
});

// ── Compatibility exports (used by matcher.ts / notify-routes.ts) ──────────────

export async function notifyAdminAvailabilityMatch(_match: any): Promise<void> {
  // Individual-match notifications suppressed — batched report handles this.
}

export async function sendMatchReport(matches: any[]): Promise<void> {
  if (!ADMIN_TELEGRAM_ID || matches.length === 0) return;
  try {
    await bot.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      `📊 *Availability match report*\n${matches.length} new time-slot match${matches.length !== 1 ? "es" : ""} found.`,
      { parse_mode: "Markdown" }
    );
  } catch (err: any) {
    console.error("[bot] Failed to send match report:", err?.message);
  }
}

export async function sendToUser(telegramId: string, text: string): Promise<boolean> {
  try {
    await bot.api.sendMessage(telegramId, text, { parse_mode: "Markdown" });
    return true;
  } catch (err: any) {
    console.error(`[bot] Failed to send to ${telegramId}:`, err?.message);
    return false;
  }
}

// ── Start (webhook or polling) ─────────────────────────────────────────────────

async function startBot(): Promise<void> {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }
  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    await bot.api.setWebhook(`${webhookUrl}/telegram`);
    console.log(`[bot] Webhook set → ${webhookUrl}/telegram`);
  } else {
    bot.start({ onStart: info => console.log(`[bot] @${info.username} polling`) });
  }
}

startBot();
