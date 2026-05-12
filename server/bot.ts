// server/bot.ts
// Telegram bot for ExpatEvents — re-architected with grammy, database-backed state,
// RU/EN localisation, preview cards with images, group-aware RSVP, organiser commands,
// rate-limiting, and idempotent notifications.

import { Bot, Context, session, SessionFlavor, InlineKeyboard } from "grammy";
import { conversations, createConversation, ConversationFlavor } from "@grammyjs/conversations";
import { db } from "./db";
import { users, rsvps, pendingApprovals, events, notifications } from "@shared/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { EVENT_CATEGORIES, getCategoryLabel } from "@shared/categories";

// ── Types ──────────────────────────────────────────────────────────────────
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

// ── Environment & constants ────────────────────────────────────────────────
const EXPAT_API_URL = (process.env.EXPAT_API_URL ?? "https://expatevents.org").replace(/\/$/, "");
const EXPAT_API_SECRET = process.env.EXPAT_API_SECRET ?? "";
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

const CATEGORY_ICONS: Record<string, string> = {
  networking: "🔗", tech: "💻", culture: "🎨", food: "🍔",
  sports: "⚽", music: "🎵", language: "🌍", outdoor: "🏕️",
  games: "🎮", business: "💼", wellness: "🧘", family: "👨‍👩‍👧",
  social: "🤝", volunteering: "🙌", other: "📌",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Localization (RU/EN) ──────────────────────────────────────────────────
const LOCALE: Record<string, Record<string, any>> = {
  ru: {
    welcome: "👋 Добро пожаловать в *ExpatEvents*!\n\nЯ оповещаю о событиях, которые вам интересны.",
    accountLinked: "✅ *Ваш аккаунт ExpatEvents привязан!*\n\nВы будете получать уведомления о мероприятиях.",
    linkExpired: "❌ Ссылка устарела. Создайте новую в настройках аккаунта.",
    helpText: "🤖 *Помощь* — я пришлю события по вашим интересам, здесь можно сразу RSVP.",
    going: "✅ Вы идёте!",
    maybe: "🤔 Возможно",
    no: "❌ Не смогу",
    cleared: "Ответ удалён.",
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) =>
      `${icon} *Новое событие в категории ${cat}*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[Подробнее](https://expatevents.org/events/${id})`,
    demandSignal: (count: number, day: string, hour: string, cat: string) =>
      `*${count} экспатов* свободны в *${day} в ${hour}* и интересуются *${cat}*.\nПодумайте о проведении мероприятия!`,
    eventLive: "🎉 *Ваше событие опубликовано!* …",
  },
  en: {
    welcome: "👋 Welcome to *ExpatEvents*!\n\nI'll keep you updated on events matching your interests.",
    accountLinked: "✅ *Your ExpatEvents account is linked!*\n\nYou'll receive event notifications.",
    linkExpired: "❌ That link has expired. Please generate a new one from your account settings.",
    helpText: "🤖 *Help* — I send you events matching your interests and let you RSVP directly.",
    going: "✅ You're going!",
    maybe: "🤔 Maybe",
    no: "❌ Can't make it",
    cleared: "Response cleared.",
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) =>
      `${icon} *New ${cat} event*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[View event](https://expatevents.org/events/${id})`,
    demandSignal: (count: number, day: string, hour: string, cat: string) =>
      `*${count} expats* are free on *${day} at ${hour}* and interested in *${cat}*.\nConsider hosting an event!`,
    eventLive: "🎉 *Your event is live!* …",
  }
};
function t(ctx: Context, key: string, ...args: any[]): string {
  const lang = ctx.from?.language_code?.startsWith("ru") ? "ru" : "en";
  const template = LOCALE[lang]?.[key] ?? LOCALE.en[key];
  return typeof template === "function" ? template(...args) : template;
}
function tStatic(lang: string, key: string, ...args: any[]): string {
  const loc = LOCALE[lang]?.[key] ?? LOCALE.en[key];
  return typeof loc === "function" ? loc(...args) : loc;
}

// ── Date / Time helpers ────────────────────────────────────────────────────
function safeMoscowStr(utcDate: any): string {
  try {
    const d = new Date(utcDate);
    if (isNaN(d.getTime())) return "Date TBD";
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Moscow",
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    }).format(d);
  } catch {
    return "Date TBD";
  }
}
function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

// ── DB helpers ─────────────────────────────────────────────────────────────
async function getUserLang(telegramId: string): Promise<string> {
  const [user] = await db.select({ language: users.language }).from(users).where(eq(users.telegramId, telegramId));
  return user?.language ?? "en";
}

async function markUserBlocked(telegramId: string): Promise<void> {
  await db.update(users).set({ blocked: true }).where(eq(users.telegramId, telegramId));
  console.log(`[bot] User ${telegramId} marked blocked`);
}

const notifiedForEvent = new Map<number, Set<string>>();

// ── RSVP persistence ───────────────────────────────────────────────────────
async function loadRsvpCounts(eventId: number): Promise<{ going: number; maybe: number; no: number }> {
  const rows = await db.select({ status: rsvps.status }).from(rsvps).where(eq(rsvps.eventId, eventId));
  const counts = { going: 0, maybe: 0, no: 0 };
  for (const r of rows) counts[r.status as keyof typeof counts]++;
  return counts;
}

async function setRsvpStatus(userId: number, eventId: number, status: "going" | "maybe" | "no" | "none", sourceChatId?: number, sourceChatTitle?: string): Promise<void> {
  if (status === "none") {
    await db.delete(rsvps).where(and(eq(rsvps.userId, userId), eq(rsvps.eventId, eventId)));
  } else {
    await db.insert(rsvps).values({
      userId, eventId, status,
      sourceChatId: sourceChatId ?? null,
      sourceChatTitle: sourceChatTitle ?? null,
      updatedAt: new Date(),
    }).onConflictDoUpdate({
      target: [rsvps.userId, rsvps.eventId],
      set: {
        status,
        sourceChatId: sourceChatId ?? null,
        sourceChatTitle: sourceChatTitle ?? null,
        updatedAt: new Date(),
      }
    });
  }
}

async function getEventAttendees(eventId: number): Promise<{ userId: number; telegramId?: string; username?: string; status: string; sourceChatTitle?: string }[]> {
  const rows = await db.select({
    userId: rsvps.userId,
    status: rsvps.status,
    sourceChatTitle: rsvps.sourceChatTitle,
  }).from(rsvps).where(eq(rsvps.eventId, eventId));
  const result = [];
  for (const row of rows) {
    const [user] = await db.select({
      telegramId: users.telegramId,
      username: users.telegramUsername
    }).from(users).where(eq(users.id, row.userId));
    result.push({ ...row, telegramId: user?.telegramId, username: user?.username });
  }
  return result;
}

// ── Pending approvals in DB ────────────────────────────────────────────────
async function storePendingApproval(event: EventData): Promise<string> {
  const token = Math.random().toString(36).slice(2, 10);
  await db.insert(pendingApprovals).values({
    token,
    eventId: event.id,
    eventData: JSON.stringify(event),
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
  });
  return token;
}

async function getPendingApproval(token: string): Promise<EventData | null> {
  const [row] = await db.select().from(pendingApprovals).where(
    and(eq(pendingApprovals.token, token), sql`${pendingApprovals.expiresAt} > NOW()`)
  );
  if (!row) return null;
  return JSON.parse(row.eventData) as EventData;
}

async function deletePendingApproval(token: string): Promise<void> {
  await db.delete(pendingApprovals).where(eq(pendingApprovals.token, token));
}

// ── Event store (cached locally) ───────────────────────────────────────────
async function saveEvent(event: EventData): Promise<void> {
  await db.insert(events).values({
    id: event.id,
    title: event.title,
    category: event.category,
    date: event.date,
    venueCity: event.venueCity,
    venueAddress: event.venueAddress,
    description: event.description,
    organizerId: event.organizerId ? parseInt(event.organizerId) : null,
    imageUrl: event.imageUrl,
    dispatched: true,
    createdAt: new Date(),
  }).onConflictDoUpdate({
    target: [events.id],
    set: {
      title: event.title,
      category: event.category,
      date: event.date,
      venueCity: event.venueCity,
      venueAddress: event.venueAddress,
      description: event.description,
      imageUrl: event.imageUrl,
    }
  });
}

// ── Notification queue ─────────────────────────────────────────────────────
const notificationQueue: Array<{
  userId: number;
  telegramId: string;
  text: string;
  imageUrl?: string;
  keyboard: InlineKeyboard;
  lang: string;
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
          caption: item.text,
          parse_mode: "Markdown",
          reply_markup: item.keyboard,
        });
      } else {
        await bot.api.sendMessage(item.telegramId, item.text, {
          parse_mode: "Markdown",
          reply_markup: item.keyboard,
        });
      }
    } catch (err: any) {
      if (err?.error_code === 403) await markUserBlocked(item.telegramId);
    }
    // Telegram rate limit: 30 msg/sec, we play safe with 50ms delay
    await new Promise(r => setTimeout(r, 50));
  }
  processingQueue = false;
}

function enqueueNotification(notification: typeof notificationQueue[number]): void {
  notificationQueue.push(notification);
  processQueue();
}

// ── Bot instance and rate‑limiting ─────────────────────────────────────────
export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);
const rsvpCooldown = new Map<string, number>();

// ── Middleware ──────────────────────────────────────────────────────────────
bot.use(session({ initial: () => ({}) }));
bot.use(conversations());

// ── /start ─────────────────────────────────────────────────────────────────
bot.command("start", async (ctx) => {
  const token = ctx.match?.trim();
  if (token) {
    try {
      await import("./telegram-link").then(m => m.handleTelegramStartToken(String(ctx.chat.id), token));
      await ctx.reply(t(ctx, "accountLinked"), { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(t(ctx, "linkExpired"));
    }
    return;
  }
  await ctx.reply(t(ctx, "welcome"), { parse_mode: "Markdown" });
});

// ── /help ──────────────────────────────────────────────────────────────────
bot.command("help", async (ctx) => {
  await ctx.reply(t(ctx, "helpText"), { parse_mode: "Markdown" });
});

// ── Organiser commands ─────────────────────────────────────────────────────
async function getOrganiserTelegramId(ctx: Context): Promise<string | null> {
  const user = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, String(ctx.from!.id)));
  return user?.[0]?.id ? String(user[0].id) : null;
}

bot.command("myevents", async (ctx) => {
  const orgId = await getOrganiserTelegramId(ctx);
  if (!orgId) {
    await ctx.reply("Your account is not linked as an organiser.");
    return;
  }
  const rows = await db.select().from(events).where(eq(events.organizerId, parseInt(orgId)));
  if (rows.length === 0) {
    await ctx.reply("You have no events.");
    return;
  }
  for (const e of rows) {
    const counts = await loadRsvpCounts(e.id);
    await ctx.reply(
      `*${e.title}*\n📅 ${safeMoscowStr(e.date)}\n✅${counts.going} 🤔${counts.maybe} ❌${counts.no}\n/attendees_${e.id} /edit_${e.id} /reshare_${e.id}`,
      { parse_mode: "Markdown" }
    );
  }
});

bot.hears(/^\/attendees_(\d+)/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  const attendees = await getEventAttendees(eventId);
  if (attendees.length === 0) {
    await ctx.reply("No RSVPs yet.");
    return;
  }
  let msg = `*Attendees for event #${eventId}*\n`;
  for (const a of attendees) {
    if (a.status === "going") msg += `✅ @${a.username ?? a.telegramId ?? a.userId}`;
    else if (a.status === "maybe") msg += `🤔 @${a.username ?? a.telegramId ?? a.userId}`;
    if (a.sourceChatTitle) msg += ` (from ${a.sourceChatTitle})`;
    msg += "\n";
  }
  await ctx.reply(msg, { parse_mode: "Markdown" });
});

bot.hears(/^\/edit_(\d+)/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  await ctx.reply(`Edit your event: https://expatevents.org/events/${eventId}/edit`);
});

bot.hears(/^\/reshare_(\d+)/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  const [event] = await db.select().from(events).where(eq(events.id, eventId));
  if (!event) {
    await ctx.reply("Event not found.");
    return;
  }
  const cardText = buildPreviewCardText(event as EventData);
  const counts = await loadRsvpCounts(eventId);
  const keyboard = rsvpKeyboardForCounts(eventId, counts);
  try {
    if (event.imageUrl) {
      await ctx.replyWithPhoto(event.imageUrl, {
        caption: cardText,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(cardText, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } catch {
    await ctx.reply("Failed to regenerate preview.");
  }
});

// ── Demand signal follow-up (enhanced) ─────────────────────────────────────
export async function notifyOrganiserDemand(organiserId: number, match: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
}): Promise<void> {
  const [organiser] = await db.select().from(users).where(eq(users.id, organiserId));
  if (!organiser?.telegramId) return;
  const dayName = DAYS[match.day];
  const hourStr = fmtHour(match.hour);
  const icon = CATEGORY_ICONS[match.category] ?? "📌";
  const lang = organiser.language ?? "en";
  const text = tStatic(lang, "demandSignal", match.userCount, dayName, hourStr, getCategoryLabel(match.category));
  const createUrl = `https://expatevents.org/create-event?category=${match.category}&day=${match.day}&hour=${match.hour}`;
  const keyboard = new InlineKeyboard().url("✨ Create event", createUrl);
  await bot.api.sendMessage(organiser.telegramId, `${icon} ${text}`, { parse_mode: "Markdown", reply_markup: keyboard });
}

// ── RSVP keyboard builders ─────────────────────────────────────────────────
function rsvpKeyboardForCounts(eventId: number, counts: { going: number; maybe: number; no: number }): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Going${counts.going ? ` (${counts.going})` : ""}`, `rsvp:going:${eventId}`)
    .text(`🤔 Maybe${counts.maybe ? ` (${counts.maybe})` : ""}`, `rsvp:maybe:${eventId}`)
    .text(`❌ Can't make it${counts.no ? ` (${counts.no})` : ""}`, `rsvp:no:${eventId}`);
}

// ── Preview card text ──────────────────────────────────────────────────────
function buildPreviewCardText(event: EventData): string {
  const icon = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc = (event.description ?? "").slice(0, 180);
  return (
    `${icon} *${event.title}*\n\n` +
    `📅 ${dateStr}\n📍 ${event.venueAddress}, ${event.venueCity}\n🏷 ${getCategoryLabel(event.category)}\n\n` +
    (desc ? `${desc}${event.description.length > 180 ? "…" : ""}\n\n` : "") +
    `[View & register →](https://expatevents.org/events/${event.id})`
  );
}

// ── Send organiser preview card ────────────────────────────────────────────
async function sendOrgPreviewCard(event: EventData): Promise<void> {
  if (!event.organizerTelegramId) return;
  const cardText = buildPreviewCardText(event);
  const counts = await loadRsvpCounts(event.id);
  const keyboard = rsvpKeyboardForCounts(event.id, counts);
  const lang = (await getUserLang(event.organizerTelegramId));
  const intro = tStatic(lang, "eventLive");

  try {
    await bot.api.sendMessage(event.organizerTelegramId, intro, { parse_mode: "Markdown" });
    if (event.imageUrl) {
      await bot.api.sendPhoto(event.organizerTelegramId, event.imageUrl, {
        caption: cardText,
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await bot.api.sendMessage(event.organizerTelegramId, cardText, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });
    }
  } catch (err: any) {
    if (err?.error_code === 403) await markUserBlocked(event.organizerTelegramId);
  }
}

// ── Dispatch notifications (idempotent, queued, image support, block‑aware) ─
export async function dispatchEventNotifications(event: EventData): Promise<{ sent: number; inApp: number }> {
  const matchingUsers = await db.select().from(users).where(
    sql`${event.category} = ANY(${users.interests})`
  );

  if (!notifiedForEvent.has(event.id)) notifiedForEvent.set(event.id, new Set());

  const icon = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc = (event.description ?? "").slice(0, 200);

  let sent = 0, inApp = 0;
  const alreadyNotified = notifiedForEvent.get(event.id)!;

  for (const user of matchingUsers) {
    if (user.telegramId && alreadyNotified.has(user.telegramId)) continue;

    // In‑app notification
    await db.insert(notifications).values({
      userId: user.id,
      type: "new_event",
      title: `New ${getCategoryLabel(event.category)} event`,
      body: `${event.title} — ${dateStr} at ${event.venueCity}`,
      appScope: "expat",
      eventId: event.id,
      link: `/events/${event.id}`,
    });
    inApp++;

    // Telegram notification
    if (user.telegramId && !user.blocked) {
      const lang = getUserLang ? await getUserLang(user.telegramId) : "en";
      const text = tStatic(lang, "newEvent", icon, getCategoryLabel(event.category), event.title, dateStr, event.venueCity, event.venueAddress, desc, event.id);
      const counts = await loadRsvpCounts(event.id);
      const keyboard = rsvpKeyboardForCounts(event.id, counts);
      enqueueNotification({
        userId: user.id,
        telegramId: user.telegramId,
        text,
        imageUrl: event.imageUrl,
        keyboard,
        lang,
      });
      alreadyNotified.add(user.telegramId);
      sent++;
    }
  }

  await saveEvent(event);
  return { sent, inApp };
}

// ── Admin approval flow ────────────────────────────────────────────────────
export async function notifyMatchingUsers(event: EventData): Promise<{ sent: number; inApp: number }> {
  if (!ADMIN_TELEGRAM_ID) {
    const result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    return result;
  }

  const [totalMatches, telegramMatches] = await Promise.all([
    db.select({ id: users.id }).from(users).where(sql`${event.category} = ANY(${users.interests})`),
    db.select({ id: users.id }).from(users).where(and(isNotNull(users.telegramId), sql`${event.category} = ANY(${users.interests})`))
  ]);

  const token = await storePendingApproval(event);
  const icon = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const adminText =
    `${icon} *New event — notification approval*\n\n` +
    `*${event.title}*\n📅 ${dateStr}\n📍 ${event.venueAddress}, ${event.venueCity}\n🏷 ${getCategoryLabel(event.category)}\n\n` +
    `*${totalMatches.length}* users with this interest (${telegramMatches.length} with Telegram).`;

  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve_event:${token}`)
    .text("❌ Decline", `decline_event:${token}`);

  await bot.api.sendMessage(ADMIN_TELEGRAM_ID, adminText, {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
  return { sent: 0, inApp: 0 };
}

// ── Callback handlers ──────────────────────────────────────────────────────
bot.callbackQuery(/^rsvp:(going|maybe|no):(\d+)$/, async (ctx) => {
  const status = ctx.match[1] as "going" | "maybe" | "no";
  const eventId = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  const key = `${userId}:${eventId}`;

  const now = Date.now();
  if (rsvpCooldown.has(key) && now - rsvpCooldown.get(key)! < 2000) {
    await ctx.answerCallbackQuery({ text: "Please wait a moment", show_alert: false });
    return;
  }
  rsvpCooldown.set(key, now);

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, String(userId)));
  if (!user) {
    await ctx.answerCallbackQuery({ text: "Link your account first!", show_alert: true });
    return;
  }

  const [existing] = await db.select({ status: rsvps.status }).from(rsvps).where(and(eq(rsvps.userId, user.id), eq(rsvps.eventId, eventId)));
  const oldStatus = existing?.status;
  const newStatus = (oldStatus === status) ? "none" : status;

  const chat = ctx.chat;
  const sourceChatId = chat?.id ?? 0;
  const sourceChatTitle = "title" in (chat ?? {}) ? (chat as any).title : undefined;

  await setRsvpStatus(user.id, eventId, newStatus, sourceChatId ?? 0, sourceChatTitle);

  const lang = user.language ?? "en";
  if (newStatus === "none") {
    await ctx.answerCallbackQuery({ text: tStatic(lang, "cleared") });
  } else {
    await ctx.answerCallbackQuery({ text: tStatic(lang, newStatus as any) ?? "" });
  }

  const counts = await loadRsvpCounts(eventId);
  const newKeyboard = rsvpKeyboardForCounts(eventId, counts);
  await ctx.editMessageReplyMarkup({ reply_markup: newKeyboard }).catch(() => {});

  try {
    await fetch(`${EXPAT_API_URL}/api/bot/events/${eventId}/rsvp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Bot-Secret": EXPAT_API_SECRET },
      body: JSON.stringify({ userId: String(user.id), status: newStatus }),
    });
  } catch (err) {
    console.error("[bot] RSVP write-back failed:", err);
  }
});

bot.callbackQuery(/^approve_event:(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  const event = await getPendingApproval(token);
  if (!event) {
    await ctx.answerCallbackQuery({ text: "Approval expired or invalid.", show_alert: true });
    return;
  }
  await deletePendingApproval(token);
  await ctx.editMessageText(ctx.msg?.text + "\n\n✅ *Approved*", { parse_mode: "Markdown" });
  const result = await dispatchEventNotifications(event);
  await sendOrgPreviewCard(event);
  await ctx.reply(`📬 Sent: *${result.sent}* Telegram, *${result.inApp}* in-app notifications.`);
});

bot.callbackQuery(/^decline_event:(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  await deletePendingApproval(token);
  await ctx.editMessageText(ctx.msg?.text + "\n\n❌ *Declined*", { parse_mode: "Markdown" });
});

// ── Admin commands ─────────────────────────────────────────────────────────
bot.command("pending", async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_TELEGRAM_ID) return;
  const rows = await db.select().from(pendingApprovals).where(sql`${pendingApprovals.expiresAt} > NOW()`);
  if (rows.length === 0) {
    await ctx.reply("No pending approvals.");
    return;
  }
  for (const row of rows) {
    const event = JSON.parse(row.eventData);
    const icon = CATEGORY_ICONS[event.category] ?? "📌";
    await ctx.reply(
      `${icon} ${event.title} (${getCategoryLabel(event.category)})\n📅 ${safeMoscowStr(event.date)}\n/approve_${row.token} /decline_${row.token}`,
      { parse_mode: "Markdown" }
    );
  }
  await ctx.reply("Use /approve_all to approve all.");
});

bot.command("approve_all", async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_TELEGRAM_ID) return;
  const rows = await db.select().from(pendingApprovals).where(sql`${pendingApprovals.expiresAt} > NOW()`);
  for (const row of rows) {
    const event = JSON.parse(row.eventData);
    await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    await db.delete(pendingApprovals).where(eq(pendingApprovals.token, row.token));
  }
  await ctx.reply(`✅ Approved ${rows.length} events.`);
});

bot.command("findevents", async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_TELEGRAM_ID) return;
  const query = ctx.match?.trim() || "";
  const results = await db.select().from(events).where(sql`LOWER(title) LIKE LOWER('%${query}%')`);
  if (results.length === 0) {
    await ctx.reply("No events found.");
    return;
  }
  for (const e of results) {
    await ctx.reply(`${e.title} (ID ${e.id}) /attendees_${e.id}`);
  }
});

bot.command("stats", async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_TELEGRAM_ID) return;
  const totalEvents = (await db.select({ count: sql<number>`count(*)` }).from(events))[0].count;
  const totalRsvps = (await db.select({ count: sql<number>`count(*)` }).from(rsvps))[0].count;
  await ctx.reply(`Events: ${totalEvents}\nRSVPs: ${totalRsvps}`);
});

// ── Utils for matcher (compatibility) ──────────────────────────────────────
export async function notifyAdminAvailabilityMatch(_match: any): Promise<void> {
  // Individual-match notifications suppressed — report batching handles this.
}

export async function sendMatchReport(matches: any[]): Promise<void> {
  if (!ADMIN_TELEGRAM_ID || matches.length === 0) return;
  // Simplified: just send a count for now. Full report logic can be extended.
  try {
    await bot.api.sendMessage(ADMIN_TELEGRAM_ID, `Match report: ${matches.length} new matches`);
  } catch (err) {
    console.error("[bot] Failed to send match report:", err);
  }
}

// Send a message to a user by Telegram ID (used by other modules)
export async function sendToUser(telegramId: string, text: string): Promise<boolean> {
  try {
    await bot.api.sendMessage(telegramId, text, { parse_mode: "Markdown" });
    return true;
  } catch (err: any) {
    console.error(`[bot] Failed to send to ${telegramId}:`, err.message);
    return false;
  }
}

// ── Start bot (webhook or polling) ─────────────────────────────────────────
async function startBot() {
  if (!process.env.TELEGRAM_BOT_TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set");
    return;
  }

  const webhookUrl = process.env.WEBHOOK_URL;
  if (webhookUrl) {
    console.log("[bot] Starting webhook mode on", webhookUrl);
    await bot.api.setWebhook(`${webhookUrl}/telegram`);
    // Webhook route is set up in server/index.ts
  } else {
    console.log("[bot] Starting polling mode");
    bot.start({
      onStart: (info) => console.log(`[bot] Bot @${info.username} started`),
    });
  }
}

startBot();
