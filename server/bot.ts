// server/bot.ts
// Telegram bot for ExpatEvents — grammY, database-backed state,
// RU/EN localisation, preview cards with images, group-aware RSVP,
// organiser commands, rate-limiting, idempotent notifications.
// RSVPs are stored in the ExpatEvents database, accessed via its API.
// rsvps.userId stores the meh-auth integer user ID (no FK — cross-database reference).

import { Bot, Context, session, SessionFlavor, InlineKeyboard } from "grammy";
import { db } from "./db";
import { users, pendingApprovals, events, notifications } from "@shared/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { getCategoryLabel } from "@shared/categories";

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
type BotContext = Context & SessionFlavor<SessionData>;

// ── Environment ────────────────────────────────────────────────────────────────

const EXPAT_API_URL     = (process.env.EXPAT_API_URL ?? "https://expatevents.org").replace(/\/$/, "");
const EXPAT_API_SECRET  = process.env.EXPAT_API_SECRET ?? "";
const ADMIN_TELEGRAM_ID = process.env.ADMIN_TELEGRAM_ID;

// Single source of truth — shared with auth.ts via this map.
// TODO: move to shared/categories.ts to eliminate all duplication.
const CATEGORY_ICONS: Record<string, string> = {
  networking: "🔗", tech: "💻", culture: "🎨", food: "🍔",
  sports: "⚽", music: "🎵", language: "🌍", outdoor: "🏕️",
  games: "🎮", business: "💼", wellness: "🧘", family: "👨‍👩‍👧",
  social: "🤝", volunteering: "🙌", other: "📌",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Fetch with timeout ─────────────────────────────────────────────────────────
// Node's global fetch has no built-in timeout. Without this, a call to a
// sleeping Render service hangs indefinitely and blocks the entire approval flow.

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ── Localisation ───────────────────────────────────────────────────────────────

const LOCALE: Record<string, Record<string, any>> = {
  ru: {
    welcome:       "👋 Добро пожаловать в *ExpatEvents*!\n\nЯ оповещаю о событиях, которые вам интересны.",
    accountLinked: "✅ *Ваш аккаунт ExpatEvents привязан!*\n\nВы будете получать уведомления о мероприятиях.",
    linkExpired:   "❌ Ссылка устарела. Создайте новую в настройках аккаунта.",
    helpText:      "🤖 *Помощь* — я пришлю события по вашим интересам, здесь можно сразу RSVP.\n\n/myevents — ваши мероприятия\n/stop — отписаться от уведомлений",
    going:         "✅ Вы идёте!",
    maybe:         "🤔 Возможно",
    no:            "❌ Не смогу",
    cleared:       "Ответ удалён.",
    eventLive:     "🎉 *Ваше событие опубликовано!*\n\nВот карточка для форварда — люди могут RSVP прямо из Telegram.",
    stopped:       "🔕 Вы отписались от уведомлений ExpatEvents.\n\nОтправьте /start чтобы снова подписаться.",
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) =>
      `${icon} *Новое событие в категории ${cat}*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[Подробнее](https://expatevents.org/events/${id})`,
    demandSignal: (count: number, day: string, hour: string, cat: string) =>
      `*${count} экспатов* свободны в *${day} в ${hour}* и интересуются *${cat}*.\nПодумайте о проведении мероприятия!`,
  },
  en: {
    welcome:       "👋 Welcome to *ExpatEvents*!\n\nI'll keep you updated on events matching your interests.",
    accountLinked: "✅ *Your ExpatEvents account is linked!*\n\nYou'll receive event notifications.",
    linkExpired:   "❌ That link has expired. Please generate a new one from your account settings.",
    helpText:      "🤖 *Help* — I send you events matching your interests and let you RSVP directly.\n\n/myevents — your organised events\n/stop — unsubscribe from notifications",
    going:         "✅ You're going!",
    maybe:         "🤔 Maybe",
    no:            "❌ Can't make it",
    cleared:       "Response cleared.",
    eventLive:     "🎉 *Your event is live!*\n\nHere's your shareable preview card. Forward it to any chat — people can RSVP directly from Telegram.",
    stopped:       "🔕 You've unsubscribed from ExpatEvents notifications.\n\nSend /start to resubscribe at any time.",
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
      .select({ language: users.language })
      .from(users)
      .where(eq(users.telegramId, telegramId));
    return user?.language ?? "en";
  } catch {
    return "en";
  }
}

async function persistUserLanguage(telegramId: string, languageCode: string | undefined): Promise<void> {
  const lang = languageCode?.startsWith("ru") ? "ru" : "en";
  try {
    await db.update(users).set({ language: lang }).where(eq(users.telegramId, telegramId));
  } catch { /* non-fatal */ }
}

async function markUserBlocked(telegramId: string): Promise<void> {
  try {
    await db.update(users).set({ blocked: true } as any).where(eq(users.telegramId, telegramId));
    console.log(`[bot] User ${telegramId} marked blocked`);
  } catch { /* column may not exist yet */ }
}

async function markUserUnblocked(telegramId: string): Promise<void> {
  try {
    await db.update(users).set({ blocked: false } as any).where(eq(users.telegramId, telegramId));
  } catch { /* non-fatal */ }
}

// ── In-memory dedup ────────────────────────────────────────────────────────────
// Tracks which telegramIds have already been notified for a given event ID
// within this server session. Cleared on restart — acceptable because a restart
// would only cause a harmless duplicate notification at worst.
//
// IMPORTANT: This map must be cleared for an event before re-dispatching
// (e.g. after a failed attempt). See clearNotifiedForEvent().
const notifiedForEvent = new Map<number, Set<string>>();

function clearNotifiedForEvent(eventId: number): void {
  notifiedForEvent.delete(eventId);
  console.log(`[bot] Cleared in-memory dedup for event ${eventId}`);
}

// ── RSVP operations — all via ExpatEvents API ──────────────────────────────────

interface RsvpCounts {
  going: number;
  maybe: number;
  no: number;
}

interface Attendee {
  userId: number;
  status: string;
  telegramId?: string;
  username?: string;
  sourceChatTitle?: string;
}

async function loadRsvpCounts(eventId: number): Promise<RsvpCounts> {
  try {
    const res = await fetchWithTimeout(
      `${EXPAT_API_URL}/api/bot/events/${eventId}/rsvp-summary`,
      { headers: { "X-Bot-Secret": EXPAT_API_SECRET } },
    );
    if (res.ok) {
      const data = await res.json();
      return { going: data.going ?? 0, maybe: data.maybe ?? 0, no: data.no ?? 0 };
    }
  } catch (err: any) {
    // Timeout or network error — return zeros rather than blocking
    console.warn(`[bot] loadRsvpCounts for event ${eventId} failed (${err?.message}) — using 0`);
  }
  return { going: 0, maybe: 0, no: 0 };
}

async function setRsvpStatus(
  mehAuthUserId: number,
  eventId: number,
  status: "going" | "maybe" | "no" | "none",
  sourceChatId?: number,
  sourceChatTitle?: string,
): Promise<RsvpCounts> {
  try {
    const res = await fetchWithTimeout(
      `${EXPAT_API_URL}/api/bot/events/${eventId}/rsvp`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Bot-Secret": EXPAT_API_SECRET,
        },
        body: JSON.stringify({ userId: mehAuthUserId, status, sourceChatId, sourceChatTitle }),
      },
    );
    if (res.ok) {
      const data = await res.json();
      return {
        going: data.counts?.going ?? 0,
        maybe: data.counts?.maybe ?? 0,
        no:    data.counts?.no    ?? 0,
      };
    }
  } catch (err: any) {
    console.error(`[bot] setRsvpStatus failed:`, err?.message);
  }
  return { going: 0, maybe: 0, no: 0 };
}

async function getEventAttendees(eventId: number): Promise<Attendee[]> {
  try {
    const res = await fetchWithTimeout(
      `${EXPAT_API_URL}/api/bot/events/${eventId}/attendees`,
      { headers: { "X-Bot-Secret": EXPAT_API_SECRET } },
    );
    if (res.ok) return await res.json();
  } catch (err: any) {
    console.error(`[bot] getEventAttendees failed:`, err?.message);
  }
  return [];
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
    .where(eq(pendingApprovals.token, token));

  if (!row) {
    console.log(`[bot] getPendingApproval: no row for token "${token}"`);
    return null;
  }
  if (new Date(row.expiresAt) < new Date()) {
    console.log(`[bot] getPendingApproval: token "${token}" expired`);
    return null;
  }

  return JSON.parse(row.eventData as string) as EventData;
}

async function deletePendingApproval(token: string): Promise<void> {
  await db.delete(pendingApprovals).where(eq(pendingApprovals.token, token));
}

// ── Event cache ────────────────────────────────────────────────────────────────
// Saves a local copy of the event in the meh-auth DB for /myevents, /reshare etc.
// This is best-effort — a failure here must never block notification dispatch.

async function saveEvent(event: EventData): Promise<void> {
  try {
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
          title:        event.title,
          category:     event.category,
          date:         event.date,
          venueCity:    event.venueCity,
          venueAddress: event.venueAddress,
          description:  event.description,
          imageUrl:     event.imageUrl ?? null,
        },
      });
  } catch (err: any) {
    // Non-fatal — log and continue. Notifications must still go out.
    console.error(`[bot] saveEvent failed for event ${event.id}:`, err?.message);
  }
}

// ── Notification queue ─────────────────────────────────────────────────────────
// Capped at MAX_QUEUE_SIZE to prevent unbounded memory growth under rate-limiting.
// If the cap is hit, the oldest items are dropped and a warning is logged.
// In practice this only triggers if Telegram rate-limits the bot for an extended
// period while a large event is being dispatched.

const MAX_QUEUE_SIZE = 2000;

const notificationQueue: Array<{
  userId:     number;
  telegramId: string;
  text:       string;
  imageUrl?:  string;
  keyboard:   InlineKeyboard;
  lang:       string;
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
      console.log(`[bot] Delivered notification to ${item.telegramId}`);
    } catch (err: any) {
      if (err?.error_code === 403) {
        await markUserBlocked(item.telegramId);
      } else {
        console.error(`[bot] Failed to deliver to ${item.telegramId}:`, err?.message);
      }
    }
    await new Promise(r => setTimeout(r, 50));
  }
  processingQueue = false;
}

function enqueueNotification(n: typeof notificationQueue[number]): void {
  if (notificationQueue.length >= MAX_QUEUE_SIZE) {
    // Drop the oldest item to make room — it will have already waited too long
    const dropped = notificationQueue.shift();
    console.warn(`[bot] Notification queue full (${MAX_QUEUE_SIZE}); dropped queued item for ${dropped?.telegramId}`);
  }
  notificationQueue.push(n);
  // Kick off processing without awaiting — fire and forget
  processQueue().catch(err =>
    console.error("[bot] processQueue threw unexpectedly:", err?.message)
  );
}

// ── Bot instance ───────────────────────────────────────────────────────────────

export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);
const rsvpCooldown = new Map<string, number>();

bot.use(session({ initial: () => ({} as SessionData) }));

// ── /start ─────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const telegramId = String(ctx.chat.id);
  await persistUserLanguage(telegramId, ctx.from?.language_code);
  await markUserUnblocked(telegramId);

  const token = ctx.match?.trim();
  if (token) {
    try {
      const { handleTelegramStartToken } = await import("./telegram-link");
      await handleTelegramStartToken(telegramId, token);
      await ctx.reply(t(ctx, "accountLinked"), { parse_mode: "Markdown" });
    } catch {
      await ctx.reply(t(ctx, "linkExpired"));
    }
    return;
  }
  await ctx.reply(t(ctx, "welcome"), { parse_mode: "Markdown" });
});

// ── /stop ──────────────────────────────────────────────────────────────────────

bot.command("stop", async (ctx) => {
  await markUserBlocked(String(ctx.from!.id));
  await ctx.reply(t(ctx, "stopped"), { parse_mode: "Markdown" });
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
  // events.organizerId is stored as integer in the meh-auth events cache table.
  // resolveOrganiserUserId returns a number — cast explicitly to avoid silent
  // type mismatches if the column type ever changes.
  const rows = await db.select().from(events).where(eq(events.organizerId, Number(userId)));
  if (rows.length === 0) {
    await ctx.reply("You have no events yet.");
    return;
  }
  for (const e of rows) {
    const counts = await loadRsvpCounts(e.id);
    await ctx.reply(
      `*${e.title}*\n📅 ${safeMoscowStr(e.date)}\n✅ ${counts.going}  🤔 ${counts.maybe}  ❌ ${counts.no}\n\n` +
      `/attendees_${e.id}   /reshare_${e.id}   /edit_${e.id}`,
      { parse_mode: "Markdown" },
    );
  }
});

// ── /attendees_{id} ────────────────────────────────────────────────────────────

bot.hears(/^\/attendees_(\d+)$/, async (ctx) => {
  const eventId   = parseInt(ctx.match[1]);
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
  if (!event) { await ctx.reply("Event not found."); return; }
  const cardText = buildPreviewCardText(event as unknown as EventData);
  const counts   = await loadRsvpCounts(eventId);
  const keyboard = rsvpKeyboardForCounts(eventId, counts);
  try {
    if (event.imageUrl) {
      await ctx.replyWithPhoto(event.imageUrl, { caption: cardText, parse_mode: "Markdown", reply_markup: keyboard });
    } else {
      await ctx.reply(cardText, { parse_mode: "Markdown", reply_markup: keyboard });
    }
  } catch {
    await ctx.reply("Failed to regenerate preview. Try again later.");
  }
});

// ── Demand signal ──────────────────────────────────────────────────────────────

export async function notifyOrganiserDemand(organiserId: number, match: {
  category: string; day: number; hour: number; userCount: number;
}): Promise<void> {
  const [organiser] = await db.select().from(users).where(eq(users.id, organiserId));
  if (!organiser?.telegramId) return;

  const icon      = CATEGORY_ICONS[match.category] ?? "📌";
  const lang      = userLang(organiser);
  const text      = tStatic(lang, "demandSignal", match.userCount, DAYS[match.day], fmtHour(match.hour), getCategoryLabel(match.category));
  const createUrl = `https://expatevents.org/create-event?category=${match.category}&day=${match.day}&hour=${match.hour}`;
  const keyboard  = new InlineKeyboard().url("✨ Create event", createUrl);

  try {
    await bot.api.sendMessage(organiser.telegramId, `${icon} ${text}`, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch (err: any) {
    if (err?.error_code === 403) await markUserBlocked(organiser.telegramId);
  }
}

// ── RSVP keyboard ──────────────────────────────────────────────────────────────

function rsvpKeyboardForCounts(
  eventId: number,
  counts: { going: number; maybe: number; no: number },
): InlineKeyboard {
  return new InlineKeyboard()
    .text(`✅ Going${counts.going ? ` (${counts.going})` : ""}`,   `rsvp:going:${eventId}`)
    .text(`🤔 Maybe${counts.maybe ? ` (${counts.maybe})` : ""}`,   `rsvp:maybe:${eventId}`)
    .text(`❌ Can't${counts.no   ? ` (${counts.no})`   : ""}`,     `rsvp:no:${eventId}`);
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
        caption: cardText, parse_mode: "Markdown", reply_markup: keyboard,
      });
    } else {
      await bot.api.sendMessage(event.organizerTelegramId, cardText, {
        parse_mode: "Markdown", reply_markup: keyboard,
      });
    }
  } catch (err: any) {
    if (err?.error_code === 403) await markUserBlocked(event.organizerTelegramId);
    else console.error(`[bot] sendOrgPreviewCard failed:`, err?.message);
  }
}

// ── Dispatch notifications ─────────────────────────────────────────────────────
// Separated into two distinct phases so a failure in saveEvent (DB cache) can
// never prevent Telegram messages from going out.
//
// Phase 1 — in-app notifications + Telegram queue (must complete fully)
// Phase 2 — saveEvent to local cache (best-effort, errors logged not thrown)

export async function dispatchEventNotifications(
  event: EventData,
): Promise<{ sent: number; inApp: number }> {
  console.log(`[bot] dispatchEventNotifications START — event ${event.id} "${event.title}" category="${event.category}"`);

  // ── Find matching users ──────────────────────────────────────────────────
  let matchingUsers: any[] = [];
  try {
    matchingUsers = await db
      .select()
      .from(users)
      .where(sql`${event.category} = ANY(${users.interests})`);
  } catch (err: any) {
    console.error(`[bot] dispatchEventNotifications: DB query failed:`, err?.message);
    throw err; // re-throw so the caller knows dispatch failed
  }

  console.log(`[bot] dispatchEventNotifications — ${matchingUsers.length} user(s) match category "${event.category}"`);

  if (matchingUsers.length === 0) {
    console.log(`[bot] dispatchEventNotifications — no matching users, saving event cache and returning`);
    await saveEvent(event); // best-effort cache
    return { sent: 0, inApp: 0 };
  }

  // ── Dedup: ensure the set exists for this event ─────────────────────────
  // NOTE: The set is NOT pre-populated from the DB. If the server was
  // restarted between a failed attempt and a re-approval, the set is empty
  // and all users will be notified again. This is intentional — a restart
  // clears the in-memory dedup so re-approvals work correctly.
  if (!notifiedForEvent.has(event.id)) {
    notifiedForEvent.set(event.id, new Set());
  }
  const alreadyNotified = notifiedForEvent.get(event.id)!;

  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc    = (event.description ?? "").slice(0, 200);

  // ── Fetch RSVP counts ONCE for the keyboard (not per user) ─────────────
  // Uses fetchWithTimeout — if expatevents is sleeping this returns {0,0,0}
  // and does not block the entire notification loop.
  const counts = await loadRsvpCounts(event.id);
  console.log(`[bot] dispatchEventNotifications — RSVP counts: going=${counts.going} maybe=${counts.maybe} no=${counts.no}`);

  let sent = 0;
  let inApp = 0;

  // ── Phase 1: notify each user ────────────────────────────────────────────
  for (const user of matchingUsers) {

    // ── In-app notification (always attempted, even without telegramId) ────
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
      // Duplicate key = already notified — safe to ignore
      if (!err?.message?.includes("duplicate") && !err?.message?.includes("unique")) {
        console.error(`[bot] in-app notification failed for user ${user.id}:`, err?.message);
      }
    }

    // ── Telegram notification ──────────────────────────────────────────────
    if (!user.telegramId) continue;
    if (userBlocked(user)) {
      console.log(`[bot] Skipping blocked user ${user.id} (${user.telegramId})`);
      continue;
    }
    if (alreadyNotified.has(user.telegramId)) {
      console.log(`[bot] Skipping already-notified ${user.telegramId}`);
      continue;
    }

    const lang     = userLang(user);
    const text     = tStatic(lang, "newEvent", icon, getCategoryLabel(event.category), event.title, dateStr, event.venueCity, event.venueAddress, desc, event.id);
    const keyboard = rsvpKeyboardForCounts(event.id, counts);

    enqueueNotification({ userId: user.id, telegramId: user.telegramId, text, imageUrl: event.imageUrl, keyboard, lang });
    alreadyNotified.add(user.telegramId);
    sent++;
    console.log(`[bot] Queued notification for user ${user.id} (${user.telegramId})`);
  }

  // ── Phase 2: cache the event (best-effort, non-blocking) ─────────────────
  await saveEvent(event);

  console.log(`[bot] dispatchEventNotifications DONE — event ${event.id}: ${inApp} in-app, ${sent} Telegram queued`);
  return { sent, inApp };
}

// ── notifyMatchingUsers — admin gate ───────────────────────────────────────────

export async function notifyMatchingUsers(
  event: EventData,
): Promise<{ sent: number; inApp: number }> {
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
    await bot.api.sendMessage(ADMIN_TELEGRAM_ID, adminText, { parse_mode: "Markdown", reply_markup: keyboard });
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

// ── Callback: RSVP ────────────────────────────────────────────────────────────

bot.callbackQuery(/^rsvp:(going|maybe|no):(\d+)$/, async (ctx) => {
  const status  = ctx.match[1] as "going" | "maybe" | "no";
  const eventId = parseInt(ctx.match[2]);
  const tgId    = String(ctx.from.id);
  const key     = `${tgId}:${eventId}`;

  const now = Date.now();
  if (rsvpCooldown.has(key) && now - rsvpCooldown.get(key)! < 2000) {
    await ctx.answerCallbackQuery({ text: "Please wait a moment." });
    return;
  }
  rsvpCooldown.set(key, now);
  // Evict entries older than 10 s to prevent unbounded map growth
  for (const [k, v] of rsvpCooldown) {
    if (now - v > 10_000) rsvpCooldown.delete(k);
  }

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, tgId));
  if (!user) {
    await ctx.answerCallbackQuery({ text: "Link your account first at expatevents.org", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery();

  let oldStatus: string | undefined;
  try {
    const res = await fetchWithTimeout(
      `${EXPAT_API_URL}/api/bot/events/${eventId}/my-rsvp`,
      { headers: { "X-Bot-Secret": EXPAT_API_SECRET, "X-User-Id": String(user.id) } },
    );
    if (res.ok) oldStatus = (await res.json()).status;
  } catch { /* non-fatal */ }

  const newStatus   = (oldStatus === status) ? "none" : status;
  const chat        = ctx.chat;
  const sourceChatId    = chat?.id ?? 0;
  const sourceChatTitle = chat && "title" in chat ? (chat as any).title : undefined;

  const counts = await setRsvpStatus(user.id, eventId, newStatus, sourceChatId, sourceChatTitle);
  await ctx.editMessageReplyMarkup({ reply_markup: rsvpKeyboardForCounts(eventId, counts) }).catch(() => {});
});

// ── Callback: Approve event ───────────────────────────────────────────────────

bot.callbackQuery(/^approve_event:(.+)$/, async (ctx) => {
  const token = ctx.match[1];

  // 1. Acknowledge immediately — Telegram requires this within 10 s
  await ctx.answerCallbackQuery({ text: "Approving…" }).catch(() => {});

  // 2. Load the pending event
  let event: EventData | null = null;
  try {
    event = await getPendingApproval(token);
  } catch (err: any) {
    console.error("[bot] approve_event: DB error:", err?.message);
    await ctx.reply("❌ Database error loading approval. Check server logs.");
    return;
  }

  if (!event) {
    console.warn(`[bot] approve_event: token "${token}" not found or expired`);
    await ctx.reply("⚠️ This approval has expired or was already processed.");
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    return;
  }

  console.log(`[bot] approve_event: processing event ${event.id} "${event.title}"`);

  // 3. Delete token immediately to prevent double-dispatch on re-tap
  await deletePendingApproval(token).catch((err: any) =>
    console.warn("[bot] approve_event: could not delete token:", err?.message)
  );

  // 4. Clear any stale in-memory dedup for this event so re-approvals work
  clearNotifiedForEvent(event.id);

  // 5. Edit admin message to show progress
  const adminMsg = ctx.callbackQuery.message;
  const originalText = (adminMsg && "text" in adminMsg) ? (adminMsg as any).text as string : "";
  if (adminMsg && "text" in adminMsg) {
    await ctx.api.editMessageText(
      adminMsg.chat.id, adminMsg.message_id,
      `${originalText}\n\n⏳ Dispatching notifications…`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard() },
    ).catch((err: any) => console.warn("[bot] approve_event: could not edit admin message:", err?.message));
  }

  // 6. Dispatch — this is the critical step
  let result = { sent: 0, inApp: 0 };
  try {
    result = await dispatchEventNotifications(event);
  } catch (err: any) {
    console.error("[bot] approve_event: dispatchEventNotifications threw:", err?.message);
    await ctx.reply(`❌ Dispatch failed: ${err?.message ?? "unknown error"}\n\nCheck server logs.`);
    return;
  }

  // 7. Send organiser card (non-critical)
  try {
    await sendOrgPreviewCard(event);
  } catch (err: any) {
    console.warn("[bot] approve_event: sendOrgPreviewCard failed:", err?.message);
  }

  // 8. Update admin message with result
  const summary = `✅ *Done — ${result.sent} Telegram, ${result.inApp} in-app*`;
  if (adminMsg && "text" in adminMsg) {
    await ctx.api.editMessageText(
      adminMsg.chat.id, adminMsg.message_id,
      `${originalText}\n\n${summary}`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard() },
    ).catch(async () => {
      // If editing fails, send a new message
      await ctx.reply(
        `📬 *Notifications sent for "${event!.title}"*\n\n• *${result.sent}* Telegram\n• *${result.inApp}* in-app`,
        { parse_mode: "Markdown" },
      );
    });
  } else {
    await ctx.reply(
      `📬 *Notifications sent for "${event.title}"*\n\n• *${result.sent}* Telegram\n• *${result.inApp}* in-app`,
      { parse_mode: "Markdown" },
    );
  }
});

// ── Callback: Decline event ───────────────────────────────────────────────────

bot.callbackQuery(/^decline_event:(.+)$/, async (ctx) => {
  const token = ctx.match[1];
  await ctx.answerCallbackQuery({ text: "Declined." });
  await deletePendingApproval(token).catch(() => {});
  const adminMsg = ctx.callbackQuery.message;
  if (adminMsg && "text" in adminMsg) {
    await ctx.api.editMessageText(
      adminMsg.chat.id, adminMsg.message_id,
      `${(adminMsg as any).text}\n\n❌ *Declined — no notifications sent*`,
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard() },
    ).catch(() => {});
  }
});

// ── Admin commands ─────────────────────────────────────────────────────────────

bot.command("pending", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const rows = await db.select().from(pendingApprovals)
    .where(sql`${pendingApprovals.expiresAt} > NOW()`);
  if (rows.length === 0) { await ctx.reply("No pending approvals."); return; }
  for (const row of rows) {
    const ev = JSON.parse(row.eventData as string);
    const keyboard = new InlineKeyboard()
      .text("✅ Approve", `approve_event:${row.token}`)
      .text("❌ Decline", `decline_event:${row.token}`);
    await ctx.reply(
      `${CATEGORY_ICONS[ev.category] ?? "📌"} *${ev.title}* (${getCategoryLabel(ev.category)})\n📅 ${safeMoscowStr(ev.date)}`,
      { parse_mode: "Markdown", reply_markup: keyboard },
    );
  }
});

bot.command("approve_all", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const rows = await db.select().from(pendingApprovals)
    .where(sql`${pendingApprovals.expiresAt} > NOW()`);
  for (const row of rows) {
    const ev = JSON.parse(row.eventData as string);
    clearNotifiedForEvent(ev.id);
    await dispatchEventNotifications(ev);
    await sendOrgPreviewCard(ev);
    await db.delete(pendingApprovals).where(eq(pendingApprovals.token, row.token));
  }
  await ctx.reply(`✅ Approved and dispatched ${rows.length} event${rows.length !== 1 ? "s" : ""}.`);
});

// ── /testnotify — sends a test message directly to the admin ──────────────────
// Use this to verify the full pipeline without publishing a real event.
// Usage: /testnotify
// The bot will send you a sample event card with RSVP buttons.

bot.command("testnotify", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;

  const tgId = String(ctx.from!.id);
  const testEvent: EventData = {
    id:          999999,
    title:       "🧪 Test Event — Pipeline Check",
    category:    "social",
    date:        new Date(Date.now() + 2 * 24 * 60 * 60 * 1000), // 2 days from now
    venueCity:   "Moscow",
    venueAddress: "Test Venue, 1 Test Street",
    description: "This is a test notification to verify the dispatch pipeline is working end-to-end.",
    organizerTelegramId: tgId,
  };

  await ctx.reply("🧪 Sending test notification directly to you…");

  const counts   = await loadRsvpCounts(testEvent.id);
  const keyboard = rsvpKeyboardForCounts(testEvent.id, counts);
  const text     = buildPreviewCardText(testEvent);

  try {
    await bot.api.sendMessage(tgId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    await ctx.reply("✅ Test message delivered. If you see the card above, the pipeline works.");
  } catch (err: any) {
    await ctx.reply(`❌ Test failed: ${err?.message}`);
  }
});

// ── /testdispatch — runs dispatchEventNotifications for a real event ──────────
// Usage: /testdispatch <eventId>
// Clears the dedup set first so all matching users are notified even if they
// were notified before. Use on a test event only.

bot.command("testdispatch", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const idStr = ctx.match?.trim();
  if (!idStr || isNaN(parseInt(idStr))) {
    await ctx.reply("Usage: /testdispatch <eventId>");
    return;
  }
  const eventId = parseInt(idStr);
  const [cached] = await db.select().from(events).where(eq(events.id, eventId));
  if (!cached) {
    await ctx.reply(`Event ${eventId} not found in local cache. It must have been dispatched at least once.`);
    return;
  }
  await ctx.reply(`⏳ Running dispatch for event ${eventId} "${cached.title}"…\nDedup cleared — all matching users will be notified.`);
  clearNotifiedForEvent(eventId);
  try {
    const result = await dispatchEventNotifications(cached as unknown as EventData);
    await ctx.reply(`✅ Done: ${result.sent} Telegram, ${result.inApp} in-app`);
  } catch (err: any) {
    await ctx.reply(`❌ Dispatch failed: ${err?.message}`);
  }
});

bot.command("findevents", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const query = ctx.match?.trim() ?? "";
  if (!query) { await ctx.reply("Usage: /findevents <title>"); return; }
  const results = await db.select().from(events)
    .where(sql`LOWER(${events.title}) LIKE ${"%" + query.toLowerCase() + "%"}`);
  if (results.length === 0) { await ctx.reply("No events found."); return; }
  for (const e of results) {
    await ctx.reply(`*${e.title}* (ID ${e.id})\n/attendees_${e.id}  /reshare_${e.id}  /testdispatch ${e.id}`, { parse_mode: "Markdown" });
  }
});

bot.command("stats", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;
  const [evtCount]  = await db.select({ count: sql<number>`count(*)` }).from(events);
  const [userCount] = await db.select({ count: sql<number>`count(*)` }).from(users);
  const [tgCount]   = await db.select({ count: sql<number>`count(*)` }).from(users).where(isNotNull(users.telegramId));
  const [intCount]  = await db.select({ count: sql<number>`count(*)` }).from(users)
    .where(sql`array_length(${users.interests}, 1) > 0`);
  await ctx.reply(
    `📊 *Stats*\n` +
    `Users total: ${userCount.count}\n` +
    `With Telegram: ${tgCount.count}\n` +
    `With interests set: ${intCount.count}\n` +
    `Events cached: ${evtCount.count}\n` +
    `Queue depth: ${notificationQueue.length}\n` +
    `RSVPs: stored in ExpatEvents DB`,
    { parse_mode: "Markdown" },
  );
});

// ── Compatibility exports ──────────────────────────────────────────────────────

export async function notifyAdminAvailabilityMatch(_match: any): Promise<void> {
  // Suppressed — batched report handles this.
}

export async function sendMatchReport(matches: any[]): Promise<void> {
  if (!ADMIN_TELEGRAM_ID || matches.length === 0) return;
  try {
    await bot.api.sendMessage(
      ADMIN_TELEGRAM_ID,
      `📊 *Availability match report*\n${matches.length} new time-slot match${matches.length !== 1 ? "es" : ""} found.`,
      { parse_mode: "Markdown" },
    );
  } catch (err: any) {
    console.error("[bot] sendMatchReport failed:", err?.message);
  }
}

export async function sendToUser(telegramId: string, text: string): Promise<boolean> {
  try {
    await bot.api.sendMessage(telegramId, text, { parse_mode: "Markdown" });
    return true;
  } catch (err: any) {
    console.error(`[bot] sendToUser ${telegramId} failed:`, err?.message);
    return false;
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────

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
