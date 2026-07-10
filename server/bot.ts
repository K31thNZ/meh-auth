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
  locationName?: string | null;
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
const BOT_USERNAME       = (process.env.TELEGRAM_BOT_NAME ?? process.env.TELEGRAM_BOT_USERNAME ?? "").replace(/^@/, "");

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
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) => {
      const miniAppUrl = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}/app?startapp=event_${id}`
        : `https://expatevents.org/events/${id}`;
      return `${icon} *Новое событие в категории ${cat}*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[👀 Подробнее & RSVP →](${miniAppUrl})`;
    },
    demandSignal: (count: number, day: string, hour: string, cat: string) =>
      `*${count} экспатов* свободны в *${day} в ${hour}* и интересуются *${cat}*.\nПодумайте о проведении мероприятия!`,
  },
  en: {
    welcome:       "👋 Welcome to *ExpatEvents*!\n\nI'll keep you updated on events matching your interests.",
    accountLinked: "✅ *Your ExpatEvents account is linked!*\n\nYou'll receive event notifications.",
    linkExpired:   "❌ That link has expired. Please generate a new one from your account settings.",
    helpText:      "🤖 *Help* — I send you events matching your interests and let you RSVP directly.\n\n/myevents — your organised events\n/stop — unsubscribe from notifications",
    going:         "✅ You're going!",
    maybe:         "🤔 I'm interested",
    no:            "❌ Can't make it",
    cleared:       "Response cleared.",
    eventLive:     "🎉 *Your event is live!*\n\nHere's your shareable preview card. Forward it to any chat — people can RSVP directly from Telegram.",
    stopped:       "🔕 You've unsubscribed from ExpatEvents notifications.\n\nSend /start to resubscribe at any time.",
    newEvent: (icon: string, cat: string, title: string, dateStr: string, city: string, addr: string, desc: string, id: number) => {
      const miniAppUrl = BOT_USERNAME
        ? `https://t.me/${BOT_USERNAME}/app?startapp=event_${id}`
        : `https://expatevents.org/events/${id}`;
      return `${icon} *New ${cat} event*\n\n*${title}*\n📅 ${dateStr}\n📍 ${addr}, ${city}\n\n${desc}\n\n[👀 View event & RSVP →](${miniAppUrl})`;
    },
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

// ── In-memory dedup — with TTL to prevent unbounded memory growth ─────────────
//
// Each entry records which Telegram IDs were notified for a given event.
// Entries are automatically evicted after DEDUP_TTL_MS (12 hours) so the Map
// can't grow indefinitely on a long-running server.
//
// MAX_DEDUP_EVENTS caps how many distinct events we track at once. When the
// cap is hit, the oldest entry is evicted (LRU-style via Map insertion order).

const DEDUP_TTL_MS    = 12 * 60 * 60 * 1000;  // 12 hours
const MAX_DEDUP_EVENTS = 200;

interface DedupEntry {
  notified:  Set<string>;
  createdAt: number;       // Date.now() when the entry was first created
}

const notifiedForEvent = new Map<number, DedupEntry>();

/** Remove entries older than DEDUP_TTL_MS or beyond MAX_DEDUP_EVENTS cap. */
function pruneDedup(): void {
  const now = Date.now();
  for (const [eventId, entry] of notifiedForEvent) {
    if (now - entry.createdAt > DEDUP_TTL_MS) {
      notifiedForEvent.delete(eventId);
    }
  }
  // LRU eviction: if still over cap, remove oldest (Map preserves insertion order)
  while (notifiedForEvent.size > MAX_DEDUP_EVENTS) {
    const oldestKey = notifiedForEvent.keys().next().value;
    if (oldestKey !== undefined) notifiedForEvent.delete(oldestKey);
  }
}

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
    console.warn(`[bot] loadRsvpCounts for event ${eventId} failed (${err?.message}) — using 0`);
  }
  return { going: 0, maybe: 0, no: 0 };
}

interface TicketBuyer {
  attendeeId:   number;
  attendeeName: string;
  username?:    string | null;
  telegramId?:  string | null;
}

async function loadTicketBuyers(eventId: number): Promise<{ count: number; buyers: TicketBuyer[] }> {
  try {
    const res = await fetchWithTimeout(
      `${EXPAT_API_URL}/api/bot/events/${eventId}/ticket-buyers`,
      { headers: { "X-Bot-Secret": EXPAT_API_SECRET } },
    );
    if (res.ok) return await res.json();
  } catch (err: any) {
    console.warn(`[bot] loadTicketBuyers for event ${eventId} failed (${err?.message})`);
  }
  return { count: 0, buyers: [] };
}

// ══════════════════════════════════════════════════════════════════════════════
// ⚠️  FIXED: setRsvpStatus now throws on failure so callers can react
// ══════════════════════════════════════════════════════════════════════════════
async function setRsvpStatus(
  mehAuthUserId: number,
  eventId: number,
  status: "going" | "maybe" | "no" | "none",
  sourceChatId?: number,
  sourceChatTitle?: string,
): Promise<RsvpCounts> {
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`RSVP API ${res.status}: ${text}`);
  }
  const data = await res.json();
  return {
    going: data.counts?.going ?? 0,
    maybe: data.counts?.maybe ?? 0,
    no:    data.counts?.no    ?? 0,
  };
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

  const raw = row.eventData;
  return (typeof raw === "string" ? JSON.parse(raw) : raw) as EventData;
}

async function deletePendingApproval(token: string): Promise<void> {
  await db.delete(pendingApprovals).where(eq(pendingApprovals.token, token));
}

// ── Event cache ────────────────────────────────────────────────────────────────

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
    console.error(`[bot] saveEvent failed for event ${event.id}:`, err?.message);
  }
}

// ── Notification queue ─────────────────────────────────────────────────────────

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
    const dropped = notificationQueue.shift();
    console.warn(`[bot] Notification queue full (${MAX_QUEUE_SIZE}); dropped queued item for ${dropped?.telegramId}`);
  }
  notificationQueue.push(n);
  processQueue().catch(err =>
    console.error("[bot] processQueue threw unexpectedly:", err?.message)
  );
}

// ── Bot instance ───────────────────────────────────────────────────────────────

// botInfo is hardcoded so bot.isInited() is true immediately on startup —
// bypassing the bot.init() network call that hangs on Render's free tier.
// Update this object if the bot token ever changes.
const HARDCODED_BOT_INFO = {
  id: 8745167732,
  is_bot: true as const,
  first_name: "ExpatEvents",
  username: "ExpatEvents_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
};
export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!, {
  botInfo: HARDCODED_BOT_INFO,
  client: {
    // Force grammY to use Node's native fetch (available since Node 18).
    // Fixes: TypeError: Expected signal to be an instanceof AbortSignal
    // which is caused by grammY's bundled node-fetch conflicting with the
    // native AbortSignal on Render's Node runtime.
    fetch: globalThis.fetch,
  },
});
const rsvpCooldown = new Map<string, number>();
// A4 fix: periodic TTL prune so the map can't grow unboundedly between taps.
// Runs every 60 s and evicts entries older than the 10-second cooldown window.
setInterval(() => {
  const cutoff = Date.now() - 10_000;
  for (const [k, v] of rsvpCooldown) {
    if (v < cutoff) rsvpCooldown.delete(k);
  }
}, 60_000).unref();

bot.use(session({ initial: () => ({} as SessionData) }));

// ── /start ─────────────────────────────────────────────────────────────────────

bot.command("start", async (ctx) => {
  const telegramId = String(ctx.chat.id);
  await persistUserLanguage(telegramId, ctx.from?.language_code);
  await markUserUnblocked(telegramId);

  const token = ctx.match?.trim() ?? "";

  // ── Deep-link: RSVP from forwarded card ───────────────────────────────────
  // Pattern: rsvp_EVENTID_yes  |  rsvp_EVENTID_interested
  const rsvpMatch = token.match(/^rsvp_(\d+)_(yes|interested)$/);
  if (rsvpMatch) {
    const eventId = parseInt(rsvpMatch[1]);
    const status  = rsvpMatch[2] === "yes" ? "going" as const : "maybe" as const;

    const [existingUser] = await db.select({ id: users.id }).from(users).where(eq(users.telegramId, telegramId));

    if (!existingUser) {
      // Not linked — onboard first, then send back to event
      const returnUrl = `https://expatevents.org/events/${eventId}`;
      await ctx.reply(
        `👋 Welcome to *ExpatEvents*!\n\nTo RSVP you need a free account — it only takes a minute.\n\n` +
        `[Create your account →](https://expatevents.org/register?return_to=${encodeURIComponent(returnUrl)})\n\n` +
        `Once signed up, tap the RSVP button again!`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    // A2 fix: fetch current status first so the deep-link toggles (same as Path A callback)
    let currentStatus: string | null = null;
    try {
      const curRes = await fetchWithTimeout(
        `${EXPAT_API_URL}/api/bot/events/${eventId}/my-rsvp`,
        { headers: { "X-Bot-Secret": EXPAT_API_SECRET, "X-User-Id": String(existingUser.id) } },
      );
      if (curRes.ok) currentStatus = (await curRes.json()).status ?? null;
    } catch { /* non-fatal — treat as no existing status */ }

    const newStatus = currentStatus === status ? "none" : status;

    try {
      const [counts, ticketData] = await Promise.all([
        setRsvpStatus(existingUser.id, eventId, newStatus, 0, undefined),
        loadTicketBuyers(eventId),
      ]);

      const label = newStatus === "none"
        ? "↩️ RSVP removed."
        : newStatus === "going"
          ? "✅ You're going!"
          : "🤔 You're marked as interested!";
      const footer = buildRsvpStatusFooter(counts, ticketData, newStatus === "none" ? undefined : newStatus);
      const eventUrl = `https://expatevents.org/events/${eventId}`;
      await ctx.reply(
        `${label}${footer}\n\n[View event & purchase tickets →](${eventUrl})`,
        { parse_mode: "Markdown" },
      );

      // Notify the organiser (non-blocking — skip if RSVP was cleared)
      if (newStatus !== "none") {
        notifyOrganiserRsvp(eventId, newStatus as "going" | "maybe", counts, ticketData).catch(() => {});
      }
    } catch (err: any) {
      const detail = err?.message ?? "unknown error";
      console.error(`[bot] RSVP deep-link failed: ${detail}`);
      await ctx.reply(
        `❌ Sorry, we couldn't save your RSVP right now.\n\n`
        + `You can also RSVP on the website: [View event →](https://expatevents.org/events/${eventId})`,
        { parse_mode: "Markdown" },
      );
    }
    return;
  }

  // ── Deep-link: View ticket buyers list ────────────────────────────────────
  // Pattern: buyers_EVENTID
  const buyersMatch = token.match(/^buyers_(\d+)$/);
  if (buyersMatch) {
    const eventId    = parseInt(buyersMatch[1]);
    const ticketData = await loadTicketBuyers(eventId);

    if (ticketData.count === 0) {
      await ctx.reply(`🎟 No tickets sold yet for event #${eventId}.`);
      return;
    }

    const lines = [`🎟 *${ticketData.count} ticket buyer${ticketData.count !== 1 ? "s" : ""}* — event #${eventId}\n`];
    for (const b of ticketData.buyers) {
      const name = b.username ? `@${b.username}` : b.attendeeName;
      lines.push(`• ${name}`);
    }
    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    return;
  }

  // ── Account linking token ──────────────────────────────────────────────────
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

// ── /myevents — upgraded version defined in insights section below ──────────────

// ── /attendees — upgraded with summary + broadcast, defined in insights section ──

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
  const [counts, ticketData] = await Promise.all([loadRsvpCounts(eventId), loadTicketBuyers(eventId)]);
  const keyboard = rsvpKeyboardForCounts(eventId, counts, ticketData.count);
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

// ── Demand signal — see upgraded notifyOrganiserDemand below ──────────────────

// ── RSVP keyboard ──────────────────────────────────────────────────────────────

function rsvpKeyboardForCounts(
  eventId: number,
  counts: { going: number; maybe: number; no: number },
  ticketCount?: number,
): InlineKeyboard {
  // ── Keyboard shown on DIRECT messages (not forwarded) ─────────────────
  // These buttons open the mini-app event page. The ✅/🤔 RSVP buttons
  // are inside the mini-app — cleaner UX, no bot-chat redirect.
  const miniAppUrl = BOT_USERNAME
    ? `https://t.me/${BOT_USERNAME}/app?startapp=event_${eventId}`
    : `https://expatevents.org/events/${eventId}`;

  const kb = new InlineKeyboard()
    .url(`✅ Going${counts.going ? ` (${counts.going})` : ""}`, `${miniAppUrl}&rsvp=going`)
    .url(`🤔 Interested${counts.maybe ? ` (${counts.maybe})` : ""}`, `${miniAppUrl}&rsvp=maybe`);

  if (ticketCount && BOT_USERNAME) {
    const base = `https://t.me/${BOT_USERNAME}`;
    kb.row().url(`🎟 ${ticketCount} ticket${ticketCount !== 1 ? "s" : ""} sold — see list`, `${base}?start=buyers_${eventId}`);
  }
  return kb;
}
function buildRsvpStatusLine(
  counts: { going: number; maybe: number; no: number },
  ticketCount: number,
  userStatus?: string,
): string {
  const parts: string[] = [];
  if (counts.going) parts.push(`✅ *${counts.going}* going`);
  if (counts.maybe) parts.push(`🤔 *${counts.maybe}* interested`);
  if (ticketCount)  parts.push(`🎟 *${ticketCount}* ticket${ticketCount !== 1 ? "s" : ""} sold`);
  const line = parts.length ? parts.join("  ·  ") : "";
  const myStatus = userStatus && userStatus !== "none"
    ? `\n_Your RSVP: ${userStatus === "going" ? "✅ going" : userStatus === "maybe" ? "🤔 interested" : "❌ can\'t make it"}_`
    : "";
  return line ? `\n\n${line}${myStatus}` : myStatus;
}

// ── RSVP status footer helpers ────────────────────────────────────────────────

/**
 * Builds the live-counts footer appended to every event card.
 * Ticket buyers list is shown when there are paid orders.
 */
function buildRsvpStatusFooter(
  counts: { going: number; maybe: number; no: number },
  ticketData: { count: number; buyers: TicketBuyer[] },
  myStatus?: string,
): string {
  const lines: string[] = [];

  // Interest / going counts
  const countParts: string[] = [];
  if (counts.going) countParts.push(`✅ *${counts.going}* going`);
  if (counts.maybe) countParts.push(`🤔 *${counts.maybe}* interested`);
  if (countParts.length) lines.push(countParts.join("  ·  "));

  // Ticket buyers list
  if (ticketData.count > 0) {
    const names = ticketData.buyers
      .slice(0, 8)
      .map(b => b.username ? `@${b.username}` : b.attendeeName)
      .join(", ");
    const extra = ticketData.count > 8 ? ` +${ticketData.count - 8} more` : "";
    lines.push(`🎟 *${ticketData.count}* ticket${ticketData.count !== 1 ? "s" : ""} sold: ${names}${extra}`);
  }

  // User's own RSVP status
  if (myStatus && myStatus !== "none") {
    const label = myStatus === "going"
      ? "✅ you're going"
      : myStatus === "maybe"
      ? "🤔 you're interested"
      : "❌ you can't make it";
    lines.push(`_${label}_`);
  }

  return lines.length ? "\n\n" + lines.join("\n") : "";
}

/**
 * Strips any previously appended RSVP footer from message text
 * so we can replace it with fresh data.
 * Footer always starts with a blank line followed by ✅/🤔/🎟/_you
 */
function stripRsvpFooter(text: string): string {
  // Remove the RSVP counts block (starts with a blank line then ✅/🤔/🎟/_you)
  return text
    .replace(/\n\n(?:[✅🤔🎟]|_you)[\s\S]*$/, "")
    .trimEnd();
}

// ── Preview card text ──────────────────────────────────────────────────────────

function buildPreviewCardText(event: EventData): string {
  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc    = (event.description ?? "").slice(0, 180);

  // When the card is FORWARDED, inline keyboards are stripped by Telegram.
  // We embed a "View event" link directly in the text — it survives forwarding.
  // Users tap it to open the mini-app where they can RSVP with the ✅/🤔 buttons.
  const miniAppUrl = BOT_USERNAME
    ? `https://t.me/${BOT_USERNAME}/app?startapp=event_${event.id}`
    : `https://expatevents.org/events/${event.id}`;

  return (
    `${icon} *${event.title}*\n\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.locationName || event.venueAddress}, ${event.venueCity}\n` +
    `🏷 ${getCategoryLabel(event.category)}\n\n` +
    (desc ? `${desc}${(event.description ?? "").length > 180 ? "…" : ""}\n\n` : "") +
    `[👀 View event & RSVP →](${miniAppUrl})`
  );
}

// ── Send organiser preview card ────────────────────────────────────────────────

async function sendOrgPreviewCard(event: EventData): Promise<void> {
  if (!event.organizerTelegramId) return;

  const lang     = await getUserLang(event.organizerTelegramId);
  const intro    = tStatic(lang, "eventLive");
  const cardText = buildPreviewCardText(event);
  const [counts, ticketData] = await Promise.all([loadRsvpCounts(event.id), loadTicketBuyers(event.id)]);
  const keyboard = rsvpKeyboardForCounts(event.id, counts, ticketData.count);

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

// ── Dispatch notifications — notifyOrganiserRsvp is now debounced, defined below ──


export async function dispatchEventNotifications(
  event: EventData,
): Promise<{ sent: number; inApp: number }> {
  console.log(`[bot] dispatchEventNotifications START — event ${event.id} "${event.title}" category="${event.category}"`);

  let matchingUsers: any[] = [];
  try {
    matchingUsers = await db
      .select()
      .from(users)
      .where(sql`${event.category} = ANY(${users.interests})`);
  } catch (err: any) {
    console.error(`[bot] dispatchEventNotifications: DB query failed:`, err?.message);
    throw err;
  }

  console.log(`[bot] dispatchEventNotifications — ${matchingUsers.length} user(s) match category "${event.category}"`);

  if (matchingUsers.length === 0) {
    console.log(`[bot] dispatchEventNotifications — no matching users, saving event cache and returning`);
    await saveEvent(event);
    return { sent: 0, inApp: 0 };
  }

  // Prune stale entries before reading/writing dedup state
  pruneDedup();

  if (!notifiedForEvent.has(event.id)) {
    notifiedForEvent.set(event.id, { notified: new Set(), createdAt: Date.now() });
  }
  const alreadyNotified = notifiedForEvent.get(event.id)!.notified;

  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc    = (event.description ?? "").slice(0, 200);

  const counts = await loadRsvpCounts(event.id);
  console.log(`[bot] dispatchEventNotifications — RSVP counts: going=${counts.going} maybe=${counts.maybe} no=${counts.no}`);

  let sent = 0;
  let inApp = 0;

  for (const user of matchingUsers) {
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
      if (!err?.message?.includes("duplicate") && !err?.message?.includes("unique")) {
        console.error(`[bot] in-app notification failed for user ${user.id}:`, err?.message);
      }
    }

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
    const text     = tStatic(lang, "newEvent", icon, getCategoryLabel(event.category), event.title, dateStr, event.venueCity, event.locationName || event.venueAddress, desc, event.id);
    const footer  = buildRsvpStatusFooter(counts, { count: 0, buyers: [] });
    const msgText = footer ? text + footer : text;
    const keyboard = rsvpKeyboardForCounts(event.id, counts, 0);

    enqueueNotification({ userId: user.id, telegramId: user.telegramId, text: msgText, imageUrl: event.imageUrl, keyboard, lang });
    alreadyNotified.add(user.telegramId);
    sent++;
    console.log(`[bot] Queued notification for user ${user.id} (${user.telegramId})`);
  }

  await saveEvent(event);
  if (sent > 0) {
    recordNotificationsSent(event.id, sent).catch(() => {});
  }

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
    `📍 ${event.locationName || event.venueAddress}, ${event.venueCity}\n` +
    `🏷 ${getCategoryLabel(event.category)}\n\n` +
    `*${totalMatches.length}* users with this interest ` +
    `(${telegramMatches.length} with Telegram connected).\n\n` +
    `Approve sending notifications?`;

  const keyboard = new InlineKeyboard()
    .text("✅ Approve", `approve_event:${token}`)
    .text("❌ Decline", `decline_event:${token}`);

  try {
    if (event.imageUrl) {
      await bot.api.sendPhoto(ADMIN_TELEGRAM_ID, event.imageUrl, {
        caption:      adminText,
        parse_mode:   "Markdown",
        reply_markup: keyboard,
      });
    } else {
      await bot.api.sendMessage(ADMIN_TELEGRAM_ID, adminText, { parse_mode: "Markdown", reply_markup: keyboard });
    }
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

  // ════════════════════════════════════════════════════════════════════════
  // ⚠️  FIXED: Wrap RSVP with try/catch so we can show an error to the user
  // ════════════════════════════════════════════════════════════════════════
  let newCounts: RsvpCounts;
  let ticketData: { count: number; buyers: TicketBuyer[] };
  try {
    const [countsResult, ticketResult] = await Promise.all([
      setRsvpStatus(user.id, eventId, newStatus, sourceChatId, sourceChatTitle),
      loadTicketBuyers(eventId),
    ]);
    newCounts = countsResult;
    ticketData = ticketResult;
  } catch (err) {
    console.error(`[bot] RSVP callback failed:`, (err as Error).message);
    await ctx.answerCallbackQuery({ text: "❌ Failed to save your RSVP. Please try again.", show_alert: true });
    return;
  }

  const msg = ctx.callbackQuery.message;
  if (!msg) return;

  // Build the refreshed keyboard with live counts
  const newKeyboard = rsvpKeyboardForCounts(eventId, newCounts, ticketData.count);

  // Build the status footer to append/replace at end of message
  const statusFooter = buildRsvpStatusFooter(newCounts, ticketData, newStatus);

  // Strip any old status footer from existing text
  const existingText = "text" in msg ? (msg.text ?? "") : ("caption" in msg ? ((msg as any).caption ?? "") : "");
  const baseText = stripRsvpFooter(existingText);
  const updatedText = baseText + statusFooter;

  try {
    if ("text" in msg) {
      await ctx.api.editMessageText(msg.chat.id, msg.message_id, updatedText, {
        parse_mode:   "Markdown",
        reply_markup: newKeyboard,
      });
    } else if ("caption" in msg) {
      await ctx.api.editMessageCaption(msg.chat.id, msg.message_id, {
        caption:      updatedText,
        parse_mode:   "Markdown",
        reply_markup: newKeyboard,
      });
    }
  } catch (err: any) {
    if (!err?.message?.includes("not modified")) {
      console.error(`[bot] Failed to edit RSVP message: ${err?.message}`);
    }
  }
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

bot.command("testnotify", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;

  const tgId = String(ctx.from!.id);
  const testEvent: EventData = {
    id:          999999,
    title:       "🧪 Test Event — Pipeline Check",
    category:    "social",
    date:        new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
    venueCity:   "Moscow",
    venueAddress: "Test Venue, 1 Test Street",
    description: "This is a test notification to verify the dispatch pipeline is working end-to-end.",
    organizerTelegramId: tgId,
  };

  await ctx.reply("🧪 Sending test notification directly to you…");

  const counts   = await loadRsvpCounts(testEvent.id);
  const keyboard = rsvpKeyboardForCounts(testEvent.id, counts, 0);
  const text     = buildPreviewCardText(testEvent);

  try {
    await bot.api.sendMessage(tgId, text, { parse_mode: "Markdown", reply_markup: keyboard });
    await ctx.reply("✅ Test message delivered. If you see the card above, the pipeline works.");
  } catch (err: any) {
    await ctx.reply(`❌ Test failed: ${err?.message}`);
  }
});

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

// ── /stats — upgraded version defined in insights section below ─────────────────



// ── Compatibility exports (upgraded) ─────────────────────────────────────────

export async function notifyAdminAvailabilityMatch(_match: any): Promise<void> {
  // No-op — sendMatchReport handles everything in one batched digest.
}

// ──────────────────────────────────────────────────────────────────────────────
// ── 1. ADMIN MATCH REPORT — structured digest grouped by category ─────────────
// ──────────────────────────────────────────────────────────────────────────────

interface MatchEntry {
  category:  string;
  day:       number;
  hour:      number;
  userCount: number;
  userIds:   number[];
}

function barChart(n: number, max: number, width = 8): string {
  const filled = max > 0 ? Math.round((n / max) * width) : 0;
  return "█".repeat(filled) + "░".repeat(width - filled);
}

export async function sendMatchReport(matches: MatchEntry[]): Promise<void> {
  if (!ADMIN_TELEGRAM_ID || matches.length === 0) return;

  // ── Bulk-fetch profiles for all user IDs referenced in matches ─────────
  const allUserIds = [...new Set(matches.flatMap(m => m.userIds))];
  let profileMap = new Map<number, { nativeLanguage: string | null; city: string | null; myAgeGroup: string | null }>();
  try {
    const { inArray: inArr } = await import("drizzle-orm");
    const profiles = await db
      .select({ id: users.id, nativeLanguage: users.nativeLanguage, city: users.city, myAgeGroup: users.myAgeGroup })
      .from(users)
      .where(allUserIds.length > 0 ? inArr(users.id, allUserIds) : sql`false`);
    for (const p of profiles) profileMap.set(p.id, p);
  } catch (err: any) {
    console.warn("[bot] sendMatchReport: could not fetch profiles:", err?.message);
  }

  // Helper: build top-3 breakdown for a set of userIds + a profile field
  function topBreakdown(
    uids: number[],
    key: "nativeLanguage" | "city" | "myAgeGroup",
    fmt: (val: string, n: number) => string,
  ): string {
    const counter = new Map<string, number>();
    for (const id of uids) {
      const val = profileMap.get(id)?.[key];
      if (val) counter.set(val, (counter.get(val) ?? 0) + 1);
    }
    return [...counter.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([v, n]) => fmt(v, n))
      .join(", ");
  }

  // ── Group by category ──────────────────────────────────────────────────
  const byCategory = new Map<string, MatchEntry[]>();
  for (const m of matches) {
    if (!byCategory.has(m.category)) byCategory.set(m.category, []);
    byCategory.get(m.category)!.push(m);
  }

  // Sort categories by unique user count descending
  const sortedCats = [...byCategory.entries()]
    .map(([cat, ms]) => {
      const sorted     = [...ms].sort((a, b) => b.userCount - a.userCount);
      const allCatIds  = [...new Set(ms.flatMap(m => m.userIds))];
      return { cat, topSlot: sorted[0], total: allCatIds.length, slots: sorted, allCatIds };
    })
    .sort((a, b) => b.total - a.total);

  const maxTotal = sortedCats[0]?.total ?? 1;

  // ── Global top slot ────────────────────────────────────────────────────
  const topSlotMap = new Map<string, { count: number; uids: number[] }>();
  for (const m of matches) {
    const key = `${DAYS[m.day]} ${fmtHour(m.hour)}`;
    const existing = topSlotMap.get(key);
    if (existing) {
      for (const uid of m.userIds) {
        if (!existing.uids.includes(uid)) { existing.uids.push(uid); existing.count++; }
      }
    } else {
      topSlotMap.set(key, { count: m.userIds.length, uids: [...m.userIds] });
    }
  }
  const topSlotEntry = [...topSlotMap.entries()].sort((a, b) => b[1].count - a[1].count)[0];

  // ── Header ─────────────────────────────────────────────────────────────
  const now = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Moscow", weekday: "short", day: "numeric", month: "short",
  }).format(new Date());

  const totalUniqueUsers = allUserIds.length;

  const lines: string[] = [
    `📊 *Availability Digest — ${now}*\n`,
    `_${totalUniqueUsers} user${totalUniqueUsers !== 1 ? "s" : ""} · ${matches.length} slot${matches.length !== 1 ? "s" : ""} · ${sortedCats.length} categor${sortedCats.length !== 1 ? "ies" : "y"}_\n`,
  ];

  // ── Per-category rows ─────────────────────────────────────────────────
  for (const { cat, topSlot, total, slots, allCatIds } of sortedCats.slice(0, 8)) {
    const icon       = CATEGORY_ICONS[cat] ?? "📌";
    const bar        = barChart(total, maxTotal);
    const topSlotStr = `${DAYS[topSlot.day]} ${fmtHour(topSlot.hour)}`;
    const extraSlots = slots.length > 1
      ? ` +${slots.length - 1} more slot${slots.length > 2 ? "s" : ""}`
      : "";

    lines.push(`${icon} *${getCategoryLabel(cat)}*  \`${bar}\`  ${total} people`);
    lines.push(`  📅 ${topSlotStr} (${topSlot.userCount} available)${extraSlots}`);

    // Real profile data for this category's actual users
    const langStr = topBreakdown(allCatIds, "nativeLanguage", (code, n) => {
      const lang = LANGUAGES_SIMPLE.find(l => l.code === code);
      return `${lang?.flag ?? "🌐"}${lang?.label ?? code}×${n}`;
    });
    const cityStr = topBreakdown(allCatIds, "city",           (city, n) => `${city}×${n}`);
    const ageStr  = topBreakdown(allCatIds, "myAgeGroup",     (ag,   n) => `${ag}yr×${n}`);

    const details: string[] = [];
    if (langStr) details.push(`🌍 ${langStr}`);
    if (cityStr) details.push(`📍 ${cityStr}`);
    if (ageStr)  details.push(`👥 ${ageStr}`);
    if (details.length) lines.push(`  ${details.join("  ")}`);
  }

  if (topSlotEntry) {
    lines.push(`\n🏆 *Hottest slot:* ${topSlotEntry[0]} — ${topSlotEntry[1].count} people across categories`);
  }

  lines.push(`\n_Tap a button to nudge organisers in that category:_`);

  // ── Keyboard: top 3 categories ────────────────────────────────────────
  const keyboard = new InlineKeyboard();
  for (const { cat, topSlot } of sortedCats.slice(0, 3)) {
    const icon = CATEGORY_ICONS[cat] ?? "📌";
    keyboard.text(
      `${icon} Nudge ${getCategoryLabel(cat)} organiser`,
      `demand_nudge:${cat}:${topSlot.day}:${topSlot.hour}:${topSlot.userCount}`,
    ).row();
  }

  try {
    await bot.api.sendMessage(ADMIN_TELEGRAM_ID, lines.join("\n"), {
      parse_mode:   "Markdown",
      reply_markup: keyboard,
    });
  } catch (err: any) {
    console.error("[bot] sendMatchReport failed:", err?.message);
  }
}


// ── Callback: demand_nudge (admin triggers organiser demand signal) ────────────
bot.callbackQuery(/^demand_nudge:([^:]+):(\d+):(\d+):(\d+)$/, async (ctx) => {
  if (String(ctx.from.id) !== ADMIN_TELEGRAM_ID) {
    await ctx.answerCallbackQuery({ text: "Admin only." });
    return;
  }
  await ctx.answerCallbackQuery({ text: "Sending demand signal…" });

  const category  = ctx.match[1];
  const day       = parseInt(ctx.match[2]);
  const hour      = parseInt(ctx.match[3]);
  const userCount = parseInt(ctx.match[4]);

  // Find organisers who have hosted events in this category
  const { db: botDb } = await import("./db");
  const { users: usersT, events: eventsT } = await import("@shared/schema");
  const { inArray: inArrayFn, eq: eqFn } = await import("drizzle-orm");

  const categoryEvents = await botDb
    .select({ organizerId: eventsT.organizerId })
    .from(eventsT)
    .where(eqFn(eventsT.category, category));

  const orgIds = [...new Set(categoryEvents.map(e => e.organizerId).filter(Boolean))] as number[];

  if (orgIds.length === 0) {
    await ctx.reply(`No organisers found for category "${getCategoryLabel(category)}". Signal not sent.`);
    return;
  }

  let sent = 0;
  for (const orgId of orgIds) {
    try {
      await notifyOrganiserDemandRich(orgId, { category, day, hour, userCount });
      sent++;
    } catch { /* continue */ }
  }

  await ctx.reply(`✅ Demand signal sent to ${sent} organiser${sent !== 1 ? "s" : ""} for ${getCategoryLabel(category)}.`);
});

// ──────────────────────────────────────────────────────────────────────────────
// ── 2. RICH ORGANISER DEMAND SIGNAL ──────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

export async function notifyOrganiserDemand(organiserId: number, match: {
  category: string; day: number; hour: number; userCount: number;
}): Promise<void> {
  return notifyOrganiserDemandRich(organiserId, match);
}

async function notifyOrganiserDemandRich(organiserId: number, match: {
  category: string; day: number; hour: number; userCount: number;
}): Promise<void> {
  const [organiser] = await db.select().from(users).where(eq(users.id, organiserId));
  if (!organiser?.telegramId) return;

  // Check ignore list — skip if organiser suppressed this slot within 14 days
  const { ignoredDemandSlots } = await import("@shared/schema");
  const { and: andFn, eq: eqFn, gte: gteFn } = await import("drizzle-orm");
  const [ignored] = await db
    .select({ id: ignoredDemandSlots.id })
    .from(ignoredDemandSlots)
    .where(andFn(
      eqFn(ignoredDemandSlots.userId,   organiserId),
      eqFn(ignoredDemandSlots.category, match.category),
      eqFn(ignoredDemandSlots.day,      match.day),
      eqFn(ignoredDemandSlots.hour,     match.hour),
      gteFn(ignoredDemandSlots.expiresAt, new Date()),
    ));
  if (ignored) {
    console.log(`[bot] Demand signal suppressed for organiser ${organiserId} (ignored slot)`);
    return;
  }

  // Gather profile breakdown of the waiting users
  const matchingProfiles = await db
    .select({
      nativeLanguage: users.nativeLanguage,
      city:           users.city,
      myAgeGroup:     users.myAgeGroup,
    })
    .from(users)
    .where(sql`${match.category} = ANY(${users.interests})`);

  // Language breakdown (top 3)
  const langCount = new Map<string, number>();
  for (const p of matchingProfiles) {
    if (p.nativeLanguage) langCount.set(p.nativeLanguage, (langCount.get(p.nativeLanguage) ?? 0) + 1);
  }
  const topLangs = [...langCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([code, n]) => {
      const lang = LANGUAGES_SIMPLE.find(l => l.code === code);
      return `${lang?.flag ?? "🌐"} ${lang?.label ?? code} ×${n}`;
    });

  // City breakdown (top 3)
  const cityCount = new Map<string, number>();
  for (const p of matchingProfiles) {
    if (p.city) cityCount.set(p.city, (cityCount.get(p.city) ?? 0) + 1);
  }
  const topCities = [...cityCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([city, n]) => `${city} ×${n}`);

  // Age breakdown
  const ageCount = new Map<string, number>();
  for (const p of matchingProfiles) {
    if (p.myAgeGroup) ageCount.set(p.myAgeGroup, (ageCount.get(p.myAgeGroup) ?? 0) + 1);
  }
  const topAges = [...ageCount.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ag, n]) => `${ag}yrs ×${n}`);

  // How many times this slot has appeared in the last 4 weeks
  const { availabilityMatches } = await import("@shared/schema");
  const recurrenceRows = await db
    .select({ id: availabilityMatches.id })
    .from(availabilityMatches)
    .where(andFn(
      eqFn(availabilityMatches.category, match.category),
      eqFn(availabilityMatches.day,      match.day),
      eqFn(availabilityMatches.hour,     match.hour),
    ));
  const recurrenceCount = recurrenceRows.length;

  // Last event in this category
  const [lastEvent] = await db
    .select({ title: events.title, createdAt: events.createdAt })
    .from(events)
    .where(eqFn(events.category, match.category))
    .orderBy(sql`${events.createdAt} DESC`)
    .limit(1);

  const icon       = CATEGORY_ICONS[match.category] ?? "📌";
  const catLabel   = getCategoryLabel(match.category);
  const slotStr    = `${DAYS[match.day]} ${fmtHour(match.hour)}`;
  const createUrl  = `https://expatevents.org/create-event?category=${match.category}&day=${match.day}&hour=${match.hour}`;
  const ignoreKey  = `ignore_demand:${organiserId}:${match.category}:${match.day}:${match.hour}`;

  const lines: string[] = [
    `${icon} *${match.userCount} people want a ${catLabel} event*`,
    `📅 *${slotStr}*\n`,
  ];

  if (topLangs.length)  lines.push(`🌍 Languages: ${topLangs.join(", ")}`);
  if (topCities.length) lines.push(`📍 Cities: ${topCities.join(", ")}`);
  if (topAges.length)   lines.push(`👥 Ages: ${topAges.join(", ")}`);
  lines.push("");

  if (recurrenceCount > 1) {
    lines.push(`🔁 This slot has shown demand *${recurrenceCount} times* in recent reports.`);
  }
  if (lastEvent) {
    const when = safeMoscowStr(lastEvent.createdAt!);
    lines.push(`📅 Last ${catLabel} event: _${lastEvent.title}_ (${when})`);
  }

  const keyboard = new InlineKeyboard()
    .url("✨ Create event for this slot", createUrl)
    .row()
    .text("🔕 Ignore this slot for 2 weeks", ignoreKey);

  const lang = userLang(organiser);
  try {
    await bot.api.sendMessage(
      organiser.telegramId,
      lines.join("\n"),
      { parse_mode: "Markdown", reply_markup: keyboard },
    );
  } catch (err: any) {
    if (err?.error_code === 403) await markUserBlocked(organiser.telegramId);
  }
}

// Simple language lookup for demand signal profile breakdown
const LANGUAGES_SIMPLE: { code: string; label: string; flag: string }[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "ru", label: "Russian", flag: "🇷🇺" },
  { code: "de", label: "German",  flag: "🇩🇪" },
  { code: "fr", label: "French",  flag: "🇫🇷" },
  { code: "es", label: "Spanish", flag: "🇪🇸" },
  { code: "it", label: "Italian", flag: "🇮🇹" },
  { code: "pt", label: "Portuguese", flag: "🇵🇹" },
  { code: "zh", label: "Chinese", flag: "🇨🇳" },
  { code: "ja", label: "Japanese", flag: "🇯🇵" },
  { code: "ar", label: "Arabic",  flag: "🇸🇦" },
  { code: "tr", label: "Turkish", flag: "🇹🇷" },
  { code: "ko", label: "Korean",  flag: "🇰🇷" },
  { code: "hi", label: "Hindi",   flag: "🇮🇳" },
  { code: "uk", label: "Ukrainian", flag: "🇺🇦" },
  { code: "pl", label: "Polish",  flag: "🇵🇱" },
];

// ── Callback: organiser ignores a demand slot ──────────────────────────────────
bot.callbackQuery(/^ignore_demand:(\d+):([^:]+):(\d+):(\d+)$/, async (ctx) => {
  await ctx.answerCallbackQuery({ text: "Slot ignored for 2 weeks." });
  const userId   = parseInt(ctx.match[1]);
  const category = ctx.match[2];
  const day      = parseInt(ctx.match[3]);
  const hour     = parseInt(ctx.match[4]);

  const { ignoredDemandSlots } = await import("@shared/schema");
  const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
  try {
    await db.insert(ignoredDemandSlots).values({ userId, category, day, hour, expiresAt })
      .onConflictDoNothing();
  } catch { /* non-fatal */ }

  const msg = ctx.callbackQuery.message;
  if (msg && "text" in msg) {
    await ctx.api.editMessageText(
      msg.chat.id, msg.message_id,
      (msg as any).text + "\n\n🔕 _You won't be reminded about this slot for 2 weeks._",
      { parse_mode: "Markdown", reply_markup: new InlineKeyboard() },
    ).catch(() => {});
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── 3. /myevents — per-event momentum + conversion stats ─────────────────────
// ──────────────────────────────────────────────────────────────────────────────

bot.command("myevents", async (ctx) => {
  const userId = await resolveOrganiserUserId(String(ctx.from!.id));
  if (!userId) {
    await ctx.reply("Your account is not linked. Visit expatevents.org → Settings → Connect Telegram.");
    return;
  }
  const myEvents = await db.select().from(events).where(eq(events.organizerId, userId));
  if (myEvents.length === 0) {
    await ctx.reply("You have no events yet.");
    return;
  }
  for (const e of myEvents) {
    const [counts, ticketData] = await Promise.all([
      loadRsvpCounts(e.id),
      loadTicketBuyers(e.id),
    ]);

    const totalRsvps = counts.going + counts.maybe;
    const notifSent  = (e as any).notificationsSent ?? 0;
    const momentum   = (e as any).rsvpMomentum24h ?? 0;
    const conversion = notifSent > 0 ? Math.round((totalRsvps / notifSent) * 100) : null;

    const eventDate = new Date(e.date);
    const daysAway  = Math.ceil((eventDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    const timeLabel = daysAway > 0 ? `${daysAway}d away` : daysAway === 0 ? "Today" : "Past";

    const lines: string[] = [
      `*${e.title}*`,
      `📅 ${safeMoscowStr(e.date)} · _${timeLabel}_`,
      ``,
      `✅ ${counts.going} going  🤔 ${counts.maybe} interested  🎟 ${ticketData.count} tickets`,
    ];

    if (notifSent > 0) {
      lines.push(`📣 ${notifSent} notified${conversion !== null ? `  →  ${conversion}% conversion` : ""}`);
    }
    if (momentum > 0) {
      lines.push(`📈 +${momentum} RSVPs in the last 24h`);
    } else if (totalRsvps > 0 && notifSent > 0) {
      lines.push(`→ No new RSVPs in the last 24h`);
    }

    // Suggestion for low conversion
    const goingRatio = notifSent > 0 ? counts.going / notifSent : 0;
    if (counts.maybe >= 5 && counts.going < 2) {
      lines.push(`\n💡 ${counts.maybe} people are Interested but not committed — try /nudge_${e.id} to message them`);
    } else if (goingRatio < 0.05 && notifSent >= 20) {
      lines.push(`\n💡 Low conversion — consider resharing at a different time via /reshare_${e.id}`);
    }

    lines.push(`\n/attendees_${e.id}   /reshare_${e.id}   /nudge_${e.id}`);

    await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── 4. RSVP DEBOUNCE — batch RSVP notifications to organiser ─────────────────
// ──────────────────────────────────────────────────────────────────────────────

// In-memory debounce buffer: eventId → { count, timer }
const rsvpFlushTimers = new Map<number, { count: number; timer: ReturnType<typeof setTimeout> }>();
const RSVP_DEBOUNCE_MS = 10 * 60 * 1000; // 10 minutes
const RSVP_MILESTONES  = new Set([1, 5, 10, 25, 50, 100]);

export async function notifyOrganiserRsvp(
  eventId: number,
  status: "going" | "maybe",
  counts: { going: number; maybe: number; no: number },
  ticketData: { count: number; buyers: TicketBuyer[] },
): Promise<void> {
  let organizerTelegramId: string | undefined;
  try {
    const [ev] = await db.select({ organizerId: events.organizerId }).from(events).where(eq(events.id, eventId));
    if (ev?.organizerId) {
      const [org] = await db.select({ telegramId: users.telegramId }).from(users).where(eq(users.id, ev.organizerId));
      organizerTelegramId = org?.telegramId ?? undefined;
    }
  } catch { /* non-fatal */ }
  if (!organizerTelegramId) return;

  const totalRsvps = counts.going + counts.maybe;

  // Always send immediately for the very first RSVP and for milestones
  const isFirstRsvp  = totalRsvps === 1;
  const isMilestone  = RSVP_MILESTONES.has(totalRsvps);

  if (isFirstRsvp || isMilestone) {
    // Flush any buffered count first, then send milestone message
    const buffered = rsvpFlushTimers.get(eventId);
    if (buffered) {
      clearTimeout(buffered.timer);
      rsvpFlushTimers.delete(eventId);
    }

    const emoji = isFirstRsvp ? "🎉" : "🚀";
    const footer = buildRsvpStatusFooter(counts, ticketData);
    const msg    = isFirstRsvp
      ? `${emoji} *First RSVP!* — event #${eventId}${footer}`
      : `${emoji} *${totalRsvps} RSVPs* — event #${eventId}${footer}`;

    try {
      await bot.api.sendMessage(organizerTelegramId, msg, { parse_mode: "Markdown" });
    } catch (err: any) {
      if (err?.error_code === 403) await markUserBlocked(organizerTelegramId);
    }
    return;
  }

  // Buffer all other RSVPs — flush after RSVP_DEBOUNCE_MS of silence
  const existing = rsvpFlushTimers.get(eventId);
  const newCount = (existing?.count ?? 0) + 1;
  if (existing) clearTimeout(existing.timer);

  const finalOrgTgId = organizerTelegramId; // capture for closure
  const timer = setTimeout(async () => {
    rsvpFlushTimers.delete(eventId);
    const latestCounts    = await loadRsvpCounts(eventId);
    const latestTickets   = await loadTicketBuyers(eventId);
    const footer          = buildRsvpStatusFooter(latestCounts, latestTickets);
    const msg             = `📬 *+${newCount} new RSVP${newCount !== 1 ? "s" : ""}* in the last 10 min — event #${eventId}${footer}`;
    try {
      await bot.api.sendMessage(finalOrgTgId, msg, { parse_mode: "Markdown" });
    } catch (err: any) {
      if (err?.error_code === 403) await markUserBlocked(finalOrgTgId);
    }
  }, RSVP_DEBOUNCE_MS);

  rsvpFlushTimers.set(eventId, { count: newCount, timer });
}

// ──────────────────────────────────────────────────────────────────────────────
// ── 5. /attendees — summary header + broadcast button ────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

bot.hears(/^\/attendees_(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  const [ev, attendees, ticketData] = await Promise.all([
    db.select().from(events).where(eq(events.id, eventId)).then(r => r[0]),
    getEventAttendees(eventId),
    loadTicketBuyers(eventId),
  ]);

  const going    = attendees.filter(a => a.status === "going");
  const maybe    = attendees.filter(a => a.status === "maybe");
  const notifSent = (ev as any)?.notificationsSent ?? 0;
  const eventDate = ev ? new Date(ev.date) : null;
  const daysAway  = eventDate
    ? Math.ceil((eventDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
    : null;

  const lines: string[] = [
    `📋 *${ev?.title ?? `Event #${eventId}`}*`,
    `📅 ${ev ? safeMoscowStr(ev.date) : "—"}${daysAway !== null ? `  ·  _${daysAway > 0 ? `${daysAway}d away` : daysAway === 0 ? "Today!" : "Past"}_` : ""}`,
    ``,
    `✅ Going:      *${going.length}*`,
    `🤔 Interested: *${maybe.length}*`,
    `🎟 Tickets:    *${ticketData.count}*`,
  ];

  if (notifSent > 0) {
    const totalRsvp  = going.length + maybe.length;
    const conversion = Math.round((totalRsvp / notifSent) * 100);
    lines.push(`📣 Reach:      *${notifSent}* notified  →  *${conversion}%* conversion`);
  }

  lines.push(``);

  // ── Going list ────────────────────────────────────────────────────────
  if (going.length === 0) {
    lines.push(`_No confirmed attendees yet._`);
  } else {
    lines.push(`*Going (${going.length}):*`);
    for (const a of going) {
      const name  = a.username ? `@${a.username}` : a.telegramId ?? String(a.userId);
      const from  = a.sourceChatTitle ? ` _(${a.sourceChatTitle})_` : "";
      lines.push(`  ✅ ${name}${from}`);
    }
  }

  // ── Interested list ───────────────────────────────────────────────────
  if (maybe.length > 0) {
    lines.push(`\n*Interested (${maybe.length}):*`);
    for (const a of maybe) {
      const name = a.username ? `@${a.username}` : a.telegramId ?? String(a.userId);
      lines.push(`  🤔 ${name}`);
    }
  }

  // ── Ticket buyers ─────────────────────────────────────────────────────
  if (ticketData.count > 0) {
    lines.push(`\n*🎟 Ticket buyers (${ticketData.count}):*`);
    for (const b of ticketData.buyers) {
      const name = b.username ? `@${b.username}` : b.attendeeName;
      lines.push(`  • ${name}`);
    }
  }

  // Broadcast keyboard
  const keyboard = new InlineKeyboard();
  if (going.length > 0) {
    keyboard.text(`📤 Message all Going (${going.length})`, `broadcast_going:${eventId}`).row();
  }
  if (maybe.length > 0) {
    keyboard.text(`📤 Message Interested (${maybe.length})`, `broadcast_maybe:${eventId}`).row();
  }

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown", reply_markup: keyboard.inline_keyboard.length ? keyboard : undefined });
});

// ── Callback: broadcast to Going / Interested ──────────────────────────────────
bot.callbackQuery(/^broadcast_(going|maybe):(\d+)$/, async (ctx) => {
  const group   = ctx.match[1] as "going" | "maybe";
  const eventId = parseInt(ctx.match[2]);

  // Must be the organiser of this event
  const callerId = await resolveOrganiserUserId(String(ctx.from.id));
  if (!callerId) {
    await ctx.answerCallbackQuery({ text: "Link your account first.", show_alert: true });
    return;
  }
  const [ev] = await db.select({ organizerId: events.organizerId, title: events.title }).from(events).where(eq(events.id, eventId));
  if (!ev || ev.organizerId !== callerId) {
    await ctx.answerCallbackQuery({ text: "You are not the organiser of this event.", show_alert: true });
    return;
  }

  await ctx.answerCallbackQuery({ text: "Enter your broadcast message in the next message." });

  // Store pending broadcast state in session
  ctx.session.editingEventId = eventId;
  ctx.session.awaitingField  = `broadcast_${group}`;

  await ctx.reply(
    `📝 Send the message you want to broadcast to all *${group === "going" ? "Going" : "Interested"}* attendees of *${ev.title}*.\n\n_Reply with your message text:_`,
    { parse_mode: "Markdown" },
  );
});

// ── Catch broadcast reply (session-based) ────────────────────────────────────
bot.on("message:text", async (ctx) => {
  const field = ctx.session.awaitingField ?? "";
  const eventId = ctx.session.editingEventId;

  if (field.startsWith("broadcast_") && eventId) {
    ctx.session.awaitingField  = undefined;
    ctx.session.editingEventId = undefined;

    const group = field.replace("broadcast_", "") as "going" | "maybe";
    const msgText = ctx.message.text;
    const attendees = await getEventAttendees(eventId);
    const targets   = attendees.filter(a => a.status === group && a.telegramId);

    if (targets.length === 0) {
      await ctx.reply("No attendees with Telegram linked in that group.");
      return;
    }

    let sent = 0;
    const [ev] = await db.select({ title: events.title }).from(events).where(eq(events.id, eventId));
    for (const a of targets) {
      try {
        await bot.api.sendMessage(
          a.telegramId!,
          `📢 *Message from the organiser of "${ev?.title ?? `Event #${eventId}`}":*\n\n${msgText}`,
          { parse_mode: "Markdown" },
        );
        sent++;
        await new Promise(r => setTimeout(r, 60)); // rate-limit
      } catch { /* skip blocked users */ }
    }

    await ctx.reply(`✅ Broadcast sent to *${sent}* attendee${sent !== 1 ? "s" : ""}.`, { parse_mode: "Markdown" });
    return;
  }

  // ── Existing edit flow (keep as-is) ──────────────────────────────────────
  if (field && eventId) {
    const updateData: Record<string, any> = {};
    if (field === "title")        updateData.title       = ctx.message.text;
    if (field === "description")  updateData.description = ctx.message.text;
    if (!Object.keys(updateData).length) return;

    await db.update(events).set(updateData).where(eq(events.id, eventId));
    ctx.session.awaitingField  = undefined;
    ctx.session.editingEventId = undefined;
    await ctx.reply(`✅ *${field}* updated.`, { parse_mode: "Markdown" });
  }
});

// ──────────────────────────────────────────────────────────────────────────────
// ── 6. /stats — full admin weekly snapshot ────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────────

bot.command("stats", async (ctx) => {
  if (String(ctx.from!.id) !== ADMIN_TELEGRAM_ID) return;

  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [
    [evtCount],
    [newEvtCount],
    [userCount],
    [newUserCount],
    [tgCount],
    [intCount],
    [langCount],
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(events),
    db.select({ count: sql<number>`count(*)` }).from(events)
      .where(sql`${events.createdAt} > ${oneWeekAgo}`),
    db.select({ count: sql<number>`count(*)` }).from(users),
    db.select({ count: sql<number>`count(*)` }).from(users)
      .where(sql`${users.createdAt} > ${oneWeekAgo}`),
    db.select({ count: sql<number>`count(*)` }).from(users).where(isNotNull(users.telegramId)),
    db.select({ count: sql<number>`count(*)` }).from(users)
      .where(sql`array_length(${users.interests}, 1) > 0`),
    db.select({ count: sql<number>`count(*)` }).from(users)
      .where(isNotNull(users.nativeLanguage)),
  ]);

  // Notifications sent this week
  const [notifsThisWeek] = await db
    .select({ total: sql<number>`coalesce(sum(notifications_sent), 0)` })
    .from(events)
    .where(sql`${events.createdAt} > ${oneWeekAgo}`);

  // Top category by notification count
  const topCatRows = await db
    .select({
      category: events.category,
      total: sql<number>`coalesce(sum(notifications_sent), 0)`,
    })
    .from(events)
    .groupBy(events.category)
    .orderBy(sql`sum(notifications_sent) DESC`)
    .limit(3);

  const topCatsStr = topCatRows
    .filter(r => r.total > 0)
    .map(r => `${CATEGORY_ICONS[r.category] ?? "📌"} ${getCategoryLabel(r.category)} (${r.total} notified)`)
    .join("\n  ");

  // Queue depth
  const qDepth = notificationQueue.length;

  const lines = [
    `📈 *ExpatEvents — weekly snapshot*\n`,
    `👥 Users: *${userCount.count}* total, *+${newUserCount.count}* this week`,
    `🔔 Telegram linked: *${tgCount.count}*`,
    `🎯 Interests set: *${intCount.count}*`,
    `🌍 Language profiles: *${langCount.count}*`,
    ``,
    `📅 Events: *${evtCount.count}* total, *+${newEvtCount.count}* this week`,
    `📣 Notifications sent (7d): *${notifsThisWeek?.total ?? 0}*`,
    ``,
    topCatRows.length > 0 ? `🏆 Top categories:\n  ${topCatsStr}` : "",
    ``,
    `⚡️ Queue depth now: *${qDepth}*`,
    ``,
    `_Data from meh-auth DB. RSVPs stored in ExpatEvents DB._`,
  ].filter(l => l !== undefined);

  await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
});

// ── /nudge_{id} — message all Interested attendees ────────────────────────────
bot.hears(/^\/nudge_(\d+)$/, async (ctx) => {
  const eventId = parseInt(ctx.match[1]);
  const userId  = await resolveOrganiserUserId(String(ctx.from!.id));
  if (!userId) { await ctx.reply("Account not linked."); return; }

  const [ev] = await db.select().from(events).where(eq(events.id, eventId));
  if (!ev || ev.organizerId !== userId) {
    await ctx.reply("You are not the organiser of this event.");
    return;
  }

  const attendees = await getEventAttendees(eventId);
  const maybe     = attendees.filter(a => a.status === "maybe" && a.telegramId);
  if (maybe.length === 0) {
    await ctx.reply("No Interested attendees with Telegram linked yet.");
    return;
  }

  const eventUrl = `https://expatevents.org/events/${eventId}`;
  const [counts, ticketData] = await Promise.all([loadRsvpCounts(eventId), loadTicketBuyers(eventId)]);
  const keyboard = rsvpKeyboardForCounts(eventId, counts, ticketData.count);

  let sent = 0;
  for (const a of maybe) {
    try {
      await bot.api.sendMessage(
        a.telegramId!,
        `👋 *${ev.title}* is coming up!\n\nYou marked yourself as *Interested* — have you made up your mind? Grab your spot now 👇`,
        { parse_mode: "Markdown", reply_markup: keyboard },
      );
      sent++;
      await new Promise(r => setTimeout(r, 60));
    } catch { /* skip blocked */ }
  }

  await ctx.reply(`✅ Nudge sent to *${sent}* interested attendee${sent !== 1 ? "s" : ""}.`, { parse_mode: "Markdown" });
});

// ── Track notifications_sent on dispatchEventNotifications ────────────────────
// Patch the saveEvent call to also record notification count.
// This is called at the end of dispatchEventNotifications.
export async function recordNotificationsSent(eventId: number, count: number): Promise<void> {
  try {
    await db.update(events).set({ notificationsSent: sql`notifications_sent + ${count}` } as any)
      .where(eq(events.id, eventId));
  } catch { /* non-fatal */ }
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

  // botInfo is pre-supplied in the Bot constructor — no bot.init() network call needed.
  // Render free-tier outbound connections to api.telegram.org hang indefinitely,
  // so we skip the init round-trip entirely and log the hardcoded identity.
  console.log(`[bot] Bot @${bot.botInfo.username} ready (hardcoded botInfo, no init call)`);

  const webhookUrl = process.env.WEBHOOK_URL;
  if (!webhookUrl) {
    console.log("[bot] No WEBHOOK_URL — polling mode not supported on Render, skipping");
  }
  // Webhook is registered externally (via Telegram API curl) — no setWebhook call needed.
}

// ── Readiness promise ──────────────────────────────────────────────────────────
// On Render's free tier the service spins down on idle and cold-starts on the
// next incoming request. bot.init() makes a network round-trip to Telegram's
// API to fetch botInfo, so a webhook POST can arrive and be routed to Express
// before that call resolves — grammY then throws "Bot not initialized!" on
// bot.handleUpdate(). Exporting this promise lets the webhook route `await`
// it before touching the bot, eliminating the race instead of hoping init
// finishes first. .catch() also prevents an unhandled rejection from crashing
// the whole process if Telegram's API is briefly unreachable on startup.
export const botReady: Promise<void> = startBot().catch(err => {
  console.error("[bot] Failed to initialize:", err?.message ?? err);
});
