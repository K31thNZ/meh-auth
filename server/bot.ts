// server/bot.ts
// Telegram bot running inside meh-auth.
// Uses the users table directly — no separate subscribers table.
// A user becomes a "subscriber" the moment they /start the bot,
// which links their telegramId to their meh-auth account.
//
// New event notification flow:
//   1. expatevents calls POST /api/notify/event
//   2. notifyMatchingUsers() sends admin an Approve/Decline inline keyboard
//   3. Admin taps Approve →
//        a. dispatchEventNotifications() fires to all matching users
//        b. organiser receives a shareable preview card + RSVP keyboard
//   4. Admin taps Decline → dropped silently
//
// RSVP flow:
//   Users tap Going / Maybe / Can't make it on the preview card.
//   Responses are recorded in memory and relayed to the expatevents API.
//   The organiser's card is updated live with a headcount.

import TelegramBot from "node-telegram-bot-api";
import { db } from "./db";
import { users, notifications } from "@shared/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { EVENT_CATEGORIES, getCategoryLabel } from "@shared/categories";
import { handleTelegramStartToken } from "./telegram-link";

// ── Expatevents API client (for RSVP write-back) ──────────────────────────────

const EXPAT_API_URL    = (process.env.EXPAT_API_URL ?? "https://expatevents.org").replace(/\/$/, "");
const EXPAT_API_SECRET = process.env.EXPAT_API_SECRET ?? "";

async function expatApi<T = any>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: object
): Promise<T> {
  const res = await fetch(`${EXPAT_API_URL}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Bot-Secret": EXPAT_API_SECRET,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(`expatApi ${method} ${path} → ${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const CATEGORY_ICONS: Record<string, string> = {
  networking: "🔗", tech: "💻", culture: "🎨", food: "🍔",
  sports: "⚽", music: "🎵", language: "🌍", outdoor: "🏕️",
  games: "🎮", business: "💼", wellness: "🧘", family: "👨‍👩‍👧",
  social: "🤝", volunteering: "🙌", other: "📌",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

function safeMoscowStr(utcDate: any): string {
  try {
    const d = new Date(utcDate);
    if (isNaN(d.getTime())) return "Date TBD";
    const moscow = new Date(d.getTime() + 3 * 60 * 60 * 1000);
    return moscow.toLocaleDateString("en-GB", {
      weekday: "short", day: "numeric", month: "short",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return "Date TBD";
  }
}

// ── Singleton bot reference ───────────────────────────────────────────────────

let bot: TelegramBot | null = null;

export function getBot(): TelegramBot | null {
  return bot;
}

// ── Pending event approval store ──────────────────────────────────────────────

interface PendingEventPayload {
  id: number;
  title: string;
  category: string;
  date: Date;
  venueCity: string;
  venueAddress: string;
  description: string;
  organizerId?: string;
}

interface PendingApproval {
  event: PendingEventPayload;
  expiresAt: number;
}

const pendingApprovals   = new Map<string, PendingApproval>();
const matchReportMessages = new Map<string, { chatId: number; messageId: number }>();

function generateToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, val] of pendingApprovals.entries()) {
    if (val.expiresAt < now) pendingApprovals.delete(key);
  }
}

// ── RSVP state ────────────────────────────────────────────────────────────────
// In-memory: eventId → { going: Set<userId>, maybe: Set<userId>, no: Set<userId> }
// Also tracks the organiser's card message so it can be edited with live counts.

type RsvpStatus = "going" | "maybe" | "no";

interface RsvpState {
  going: Set<string>;
  maybe: Set<string>;
  no:    Set<string>;
  // Organiser's preview card message (to edit with updated counts)
  organiserChatId?:  string;
  organiserMsgId?:   number;
  // Original card text (so we can reconstruct it when editing)
  cardText: string;
}

const rsvpStates = new Map<number, RsvpState>(); // keyed by event id

function getOrCreateRsvp(eventId: number, cardText = ""): RsvpState {
  if (!rsvpStates.has(eventId)) {
    rsvpStates.set(eventId, { going: new Set(), maybe: new Set(), no: new Set(), cardText });
  }
  return rsvpStates.get(eventId)!;
}

function rsvpKeyboard(eventId: number): TelegramBot.InlineKeyboardMarkup {
  const state = rsvpStates.get(eventId);
  const g = state?.going.size ?? 0;
  const m = state?.maybe.size ?? 0;
  return {
    inline_keyboard: [[
      { text: `✅ Going${g > 0 ? ` (${g})` : ""}`,       callback_data: `rsvp:going:${eventId}` },
      { text: `🤔 Maybe${m > 0 ? ` (${m})` : ""}`,       callback_data: `rsvp:maybe:${eventId}` },
      { text: "❌ Can't make it",                          callback_data: `rsvp:no:${eventId}`    },
    ]],
  };
}

async function refreshOrgCard(eventId: number): Promise<void> {
  const state = rsvpStates.get(eventId);
  if (!state?.organiserChatId || !state.organiserMsgId || !bot) return;

  const g = state.going.size;
  const m = state.maybe.size;
  const n = state.no.size;
  const summary =
    g + m + n === 0
      ? ""
      : `\n\n*RSVP so far:* ✅ ${g} going · 🤔 ${m} maybe · ❌ ${n} can't`;

  try {
    await bot.editMessageText(state.cardText + summary, {
      chat_id:      state.organiserChatId,
      message_id:   state.organiserMsgId,
      parse_mode:   "Markdown",
      reply_markup: rsvpKeyboard(eventId),
    });
  } catch { /* message unchanged or deleted — ignore */ }
}

// ── Build event preview card text ─────────────────────────────────────────────

function buildPreviewCardText(event: PendingEventPayload): string {
  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);
  const desc    = event.description?.slice(0, 180) ?? "";

  return (
    `${icon} *${event.title}*\n\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n` +
    `🏷 ${getCategoryLabel(event.category)}\n\n` +
    (desc ? `${desc}${event.description.length > 180 ? "…" : ""}\n\n` : "") +
    `[View & register → expatevents.org/events/${event.id}](https://expatevents.org/events/${event.id})`
  );
}

// ── Send preview card to organiser ────────────────────────────────────────────

async function sendOrgPreviewCard(event: PendingEventPayload): Promise<void> {
  if (!bot || !event.organizerId) return;

  // Look up organiser's Telegram ID via their user id
  const [organiser] = await db
    .select()
    .from(users)
    .where(sql`${users.id}::text = ${event.organizerId}`);

  if (!organiser?.telegramId) return;

  const cardText = buildPreviewCardText(event);
  const rsvp     = getOrCreateRsvp(event.id, cardText);

  const intro =
    `🎉 *Your event is live!*\n\n` +
    `Here's your shareable preview card. Forward it to any chat or channel — ` +
    `people can RSVP directly from Telegram.\n\n`;

  try {
    // Send the intro as a separate non-editable message
    await bot.sendMessage(organiser.telegramId, intro, { parse_mode: "Markdown" });

    // Send the card itself (this one gets edited with live RSVP counts)
    const sent = await bot.sendMessage(organiser.telegramId, cardText, {
      parse_mode:   "Markdown",
      reply_markup: rsvpKeyboard(event.id),
    });

    rsvp.organiserChatId = organiser.telegramId;
    rsvp.organiserMsgId  = sent.message_id;
    rsvp.cardText        = cardText;

    console.log(`[bot] Preview card sent to organiser ${organiser.telegramId} for event ${event.id}`);
  } catch (err: any) {
    console.error(`[bot] Failed to send preview card for event ${event.id}:`, err.message);
  }
}

// ── Dispatch notifications to matching users (post-approval) ─────────────────

async function dispatchEventNotifications(
  event: PendingEventPayload
): Promise<{ sent: number; inApp: number }> {
  if (!bot) return { sent: 0, inApp: 0 };

  const matchingUsers = await db
    .select()
    .from(users)
    .where(sql`${event.category} = ANY(${users.interests})`);

  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);

  const message =
    `${icon} *New ${getCategoryLabel(event.category)} event*\n\n` +
    `*${event.title}*\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n\n` +
    `${event.description.slice(0, 200)}${event.description.length > 200 ? "…" : ""}\n\n` +
    `[View event](https://expatevents.org/events/${event.id})`;

  // Ensure RSVP state exists for the card keyboard on subscriber messages
  getOrCreateRsvp(event.id, buildPreviewCardText(event));

  let sent = 0;
  let inApp = 0;

  const { notifications: notificationsTable } = await import("@shared/schema");

  for (const user of matchingUsers) {
    // In-app notification
    await db.insert(notificationsTable).values({
      userId:   user.id,
      type:     "new_event",
      title:    `New ${getCategoryLabel(event.category)} event`,
      body:     `${event.title} — ${dateStr} at ${event.venueCity}`,
      appScope: "expat",
      eventId:  event.id,
      link:     `/events/${event.id}`,
    });
    inApp++;

    // Telegram notification with RSVP keyboard so subscribers can respond too
    if (user.telegramId) {
      try {
        await bot.sendMessage(user.telegramId, message, {
          parse_mode:   "Markdown",
          reply_markup: rsvpKeyboard(event.id),
        });
        sent++;
      } catch (err: any) {
        console.error(`[bot] Failed to notify ${user.telegramId}:`, err.message);
      }
    }
  }

  console.log(`[bot] Event ${event.id} dispatched: ${inApp} in-app, ${sent} Telegram`);
  return { sent, inApp };
}

// ── Public: notifyMatchingUsers — admin approval gate ────────────────────────

export async function notifyMatchingUsers(event: {
  id: number;
  title: string;
  category: string;
  date: Date;
  venueCity: string;
  venueAddress: string;
  description: string;
  organizerId?: string;
}): Promise<{ sent: number; inApp: number }> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;

  if (!adminTelegramId || !bot) {
    console.warn("[bot] ADMIN_TELEGRAM_ID not set — dispatching without approval");
    const result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    return result;
  }

  const [allMatches, telegramMatches] = await Promise.all([
    db.select({ id: users.id }).from(users)
      .where(sql`${event.category} = ANY(${users.interests})`),
    db.select({ id: users.id }).from(users)
      .where(and(isNotNull(users.telegramId), sql`${event.category} = ANY(${users.interests})`)),
  ]);

  cleanExpired();
  const token = generateToken();
  pendingApprovals.set(token, {
    event,
    expiresAt: Date.now() + 24 * 60 * 60 * 1000,
  });

  const icon    = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);

  const adminMessage =
    `${icon} *New event — notification approval*\n\n` +
    `*${event.title}*\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n` +
    `🏷 ${getCategoryLabel(event.category)}\n\n` +
    `*${allMatches.length}* users have this interest ` +
    `(${telegramMatches.length} with Telegram connected).\n\n` +
    `Approve sending notifications?`;

  try {
    await bot.sendMessage(adminTelegramId, adminMessage, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Approve", callback_data: `approve_event:${token}` },
          { text: "❌ Decline", callback_data: `decline_event:${token}` },
        ]],
      },
    });
    console.log(`[bot] Event ${event.id} awaiting admin approval (token: ${token})`);
  } catch (err: any) {
    console.error("[bot] Failed to message admin, dispatching immediately:", err.message);
    pendingApprovals.delete(token);
    const result = await dispatchEventNotifications(event);
    await sendOrgPreviewCard(event);
    return result;
  }

  return { sent: 0, inApp: 0 };
}

// ── Send helper ───────────────────────────────────────────────────────────────

export async function sendToUser(telegramId: string, text: string): Promise<boolean> {
  if (!bot) return false;
  try {
    await bot.sendMessage(telegramId, text, { parse_mode: "Markdown" });
    return true;
  } catch (err: any) {
    console.error(`[bot] Failed to send to ${telegramId}:`, err.message);
    return false;
  }
}

// ── Availability match report ─────────────────────────────────────────────────

export async function notifyAdminAvailabilityMatch(_match: {
  category: string; day: number; hour: number; userCount: number; userIds: number[];
}): Promise<void> {
  // Individual-match notifications suppressed — report batching handles this.
}

interface MatchSlot {
  category: string;
  day: number;
  hour: number;
  userCount: number;
  userIds: number[];
}

interface TimeBlock {
  day: number;
  startHour: number;
  endHour: number;
  durationHours: number;
  totalUsers: number;
  categories: { category: string; userCount: number }[];
}

function mergeHoursIntoBlocks(daySlots: MatchSlot[]): TimeBlock[] {
  const sorted = [...daySlots].sort((a, b) => a.hour - b.hour);
  const day    = sorted[0].day;

  const hourMap = new Map<number, Map<string, number>>();
  for (const s of sorted) {
    if (!hourMap.has(s.hour)) hourMap.set(s.hour, new Map());
    const cats = hourMap.get(s.hour)!;
    cats.set(s.category, (cats.get(s.category) ?? 0) + s.userCount);
  }

  const hours  = [...hourMap.keys()].sort((a, b) => a - b);
  const blocks: TimeBlock[] = [];
  let blockStart = 0;

  while (blockStart < hours.length) {
    let blockEnd = blockStart;

    while (blockEnd + 1 < hours.length) {
      const curHour  = hours[blockEnd];
      const nextHour = hours[blockEnd + 1];
      if (nextHour !== curHour + 1) break;
      const curCats  = new Set(hourMap.get(curHour)!.keys());
      const nextCats = [...hourMap.get(nextHour)!.keys()];
      if (!nextCats.some(c => curCats.has(c))) break;
      blockEnd++;
    }

    const catTotals = new Map<string, number>();
    for (let i = blockStart; i <= blockEnd; i++) {
      for (const [cat, count] of hourMap.get(hours[i])!) {
        catTotals.set(cat, (catTotals.get(cat) ?? 0) + count);
      }
    }

    const categories = [...catTotals.entries()]
      .map(([category, userCount]) => ({ category, userCount }))
      .sort((a, b) => b.userCount - a.userCount);

    blocks.push({
      day,
      startHour:     hours[blockStart],
      endHour:       hours[blockEnd],
      durationHours: hours[blockEnd] - hours[blockStart] + 1,
      totalUsers:    categories.reduce((s, c) => s + c.userCount, 0),
      categories,
    });

    blockStart = blockEnd + 1;
  }

  return blocks;
}

export async function sendMatchReport(matches: MatchSlot[]): Promise<void> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTelegramId || !bot || matches.length === 0) return;

  const byDay = new Map<number, MatchSlot[]>();
  for (const m of matches) {
    if (!byDay.has(m.day)) byDay.set(m.day, []);
    byDay.get(m.day)!.push(m);
  }

  const allBlocks: TimeBlock[] = [];
  for (const daySlots of byDay.values()) {
    allBlocks.push(...mergeHoursIntoBlocks(daySlots));
  }

  allBlocks.sort((a, b) => {
    if (b.durationHours !== a.durationHours) return b.durationHours - a.durationHours;
    return b.totalUsers - a.totalUsers;
  });

  const nowStr      = safeMoscowStr(new Date());
  const uniqueUsers = new Set(matches.flatMap(m => m.userIds)).size;

  let text =
    `📊 *Availability Report*\n` +
    `_${nowStr} · ${allBlocks.length} time block${allBlocks.length !== 1 ? "s" : ""} · ${uniqueUsers} user${uniqueUsers !== 1 ? "s" : ""}_\n\n`;

  const visibleBlocks = allBlocks.slice(0, 12);

  for (const block of visibleBlocks) {
    const dayName  = DAYS[block.day] ?? `Day ${block.day}`;
    const start    = fmtHour(block.startHour);
    const end      = fmtHour(block.endHour + 1);
    const durLabel = block.durationHours === 1 ? "1 hr" : `${block.durationHours} hrs`;
    text += `🕐 *${dayName}  ${start}–${end}*  _(${durLabel})_\n`;

    for (const { category, userCount } of block.categories.slice(0, 6)) {
      text += `  ${CATEGORY_ICONS[category] ?? "📌"} ${getCategoryLabel(category)} — ${userCount} user${userCount !== 1 ? "s" : ""}\n`;
    }
    if (block.categories.length > 6) {
      text += `  _…+${block.categories.length - 6} more interests_\n`;
    }
    text += "\n";
  }

  if (allBlocks.length > 12) {
    text += `_…and ${allBlocks.length - 12} more blocks not shown_\n\n`;
  }
  text += "_Tap a time block below to act on it_";

  const inline_keyboard: TelegramBot.InlineKeyboardButton[][] = visibleBlocks.map(block => {
    const dayName  = DAYS[block.day] ?? `Day ${block.day}`;
    const start    = fmtHour(block.startHour);
    const end      = fmtHour(block.endHour + 1);
    const durLabel = block.durationHours === 1 ? "1hr" : `${block.durationHours}hr`;
    const topCats  = block.categories.slice(0, 2).map(c => CATEGORY_ICONS[c.category] ?? "📌").join("");
    return [{
      text:          `${topCats} ${dayName} ${start}–${end} (${durLabel}, ${block.totalUsers} users)`,
      callback_data: `block_action:${block.day}:${block.startHour}:${block.endHour}`,
    }];
  });

  const existing = matchReportMessages.get(adminTelegramId);

  const sendOrEdit = async () => {
    if (existing) {
      try {
        await bot!.editMessageText(text, {
          chat_id:      existing.chatId,
          message_id:   existing.messageId,
          parse_mode:   "Markdown",
          reply_markup: { inline_keyboard },
        });
        return;
      } catch (err: any) {
        if (err?.message?.includes("message to edit not found") || err?.message?.includes("MESSAGE_ID_INVALID")) {
          matchReportMessages.delete(adminTelegramId);
        } else {
          throw err;
        }
      }
    }
    const sent = await bot!.sendMessage(adminTelegramId, text, {
      parse_mode:   "Markdown",
      reply_markup: { inline_keyboard },
    });
    matchReportMessages.set(adminTelegramId, { chatId: sent.chat.id, messageId: sent.message_id });
  };

  try {
    await sendOrEdit();
    console.log(`[bot] Match report sent/updated (${allBlocks.length} blocks from ${matches.length} slots)`);
  } catch (err: any) {
    console.error("[bot] Failed to send match report:", err.message);
  }
}

// ── Notify organiser of a demand signal ───────────────────────────────────────

export async function notifyOrganiserDemand(organiserId: number, match: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
}): Promise<void> {
  const [organiser] = await db.select().from(users).where(eq(users.id, organiserId));
  if (!organiser?.telegramId || !bot) return;

  const dayName = DAYS[match.day] ?? `Day ${match.day}`;
  const hourStr = fmtHour(match.hour);
  const icon    = CATEGORY_ICONS[match.category] ?? "📌";

  await sendToUser(
    organiser.telegramId,
    `${icon} *Demand signal for your events*\n\n` +
    `*${match.userCount} expats* are free on *${dayName} at ${hourStr}* ` +
    `and interested in *${getCategoryLabel(match.category)}*\n\n` +
    `Consider hosting an event at this time!\n` +
    `[Create an event](https://expatevents.org/create-event)`
  );
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

export async function broadcastMessage(message: string): Promise<{ sent: number; failed: number }> {
  const allUsers = await db.select().from(users).where(isNotNull(users.telegramId));
  let sent = 0, failed = 0;
  for (const user of allUsers) {
    if (user.telegramId) {
      (await sendToUser(user.telegramId, message)) ? sent++ : failed++;
    }
  }
  return { sent, failed };
}

// ── initBot ───────────────────────────────────────────────────────────────────

export function initBot(): void {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  if (!process.env.NTBA_FIX_319) process.env.NTBA_FIX_319 = "1";

  bot = new TelegramBot(botToken, { polling: true });
  console.log("[bot] Telegram bot started");

  bot.on("polling_error", (err: any) => {
    if (err?.code === "ETELEGRAM" && err?.message?.includes("409")) {
      console.warn("[bot] Another instance running (409) — destroying this instance");
      bot?.stopPolling().then(() => { bot = null; }).catch(() => { bot = null; });
    } else {
      console.error("[bot] Polling error:", err?.message ?? err);
    }
  });

  // ── /start ────────────────────────────────────────────────────────────────
  bot.onText(/\/start(.*)/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const token  = match?.[1]?.trim();

    if (token) {
      try {
        await handleTelegramStartToken(chatId, token);
        await bot!.sendMessage(chatId,
          "✅ *Your ExpatEvents account is now linked!*\n\n" +
          "You'll receive event notifications matching your interests, " +
          "and organisers can share RSVP cards directly through this bot.\n\n" +
          "Use /help to see available commands.",
          { parse_mode: "Markdown" }
        );
      } catch {
        await bot!.sendMessage(chatId,
          "❌ That link has expired. Please generate a new one from your account settings."
        );
      }
      return;
    }

    await bot!.sendMessage(chatId,
      "👋 Welcome to *ExpatEvents*!\n\n" +
      "I'll keep you updated on events matching your interests, " +
      "and let you RSVP directly from Telegram.\n\n" +
      "*Commands:*\n" +
      "• /help — show this message\n\n" +
      "Link your account at [expatevents.org](https://expatevents.org) → Settings → Connect Telegram.",
      { parse_mode: "Markdown" }
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot!.sendMessage(chatId,
      "*ExpatEvents Bot*\n\n" +
      "I notify you when new events matching your interests are published, " +
      "and let you RSVP with one tap.\n\n" +
      "• /help — show this message\n\n" +
      "Manage your interests at [expatevents.org](https://expatevents.org).",
      { parse_mode: "Markdown" }
    );
  });

  // ── Callback query handler ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;

    const chatId = String(query.message.chat.id);
    const userId = String(query.from.id);
    const data   = query.data;
    const qId    = query.id;

    // ── RSVP callbacks: rsvp:{status}:{eventId} ───────────────────────────
    if (data.startsWith("rsvp:")) {
      const [, statusRaw, eventIdRaw] = data.split(":");
      const status  = statusRaw as RsvpStatus;
      const eventId = parseInt(eventIdRaw, 10);

      if (!["going", "maybe", "no"].includes(status) || isNaN(eventId)) {
        await bot!.answerCallbackQuery(qId);
        return;
      }

      const rsvp = getOrCreateRsvp(eventId);

      // Remove from all buckets first (toggle / change)
      const wasIn = rsvp[status].has(userId);
      rsvp.going.delete(userId);
      rsvp.maybe.delete(userId);
      rsvp.no.delete(userId);

      if (!wasIn) {
        // Set new status (tapping the same button again clears it)
        rsvp[status].add(userId);
      }

      const labels: Record<RsvpStatus, string> = {
        going: "✅ You're going!",
        maybe: "🤔 Marked as maybe.",
        no:    "❌ Marked as can't make it.",
      };

      await bot!.answerCallbackQuery(qId, {
        text: wasIn ? "Response cleared." : labels[status],
      });

      // Update the inline keyboard on the message the user tapped
      try {
        await bot!.editMessageReplyMarkup(rsvpKeyboard(eventId), {
          chat_id:    query.message.chat.id,
          message_id: query.message.message_id,
        });
      } catch { /* ignore — message may be identical */ }

      // Update the organiser's card with fresh counts
      await refreshOrgCard(eventId);

      // Write-back to expatevents API (best-effort)
      try {
        const [user] = await db.select().from(users).where(eq(users.telegramId, userId));
        if (user) {
          await expatApi("POST", `/api/bot/events/${eventId}/rsvp`, {
            userId: String(user.id),
            status: wasIn ? "none" : status,
          });
        }
      } catch (err: any) {
        // Non-critical — log and continue
        console.error("[bot] RSVP write-back failed:", err.message);
      }

      return;
    }

    // ── Event approval callbacks ──────────────────────────────────────────
    if (data.startsWith("approve_event:")) {
      const token   = data.split(":")[1];
      const pending = pendingApprovals.get(token);

      if (!pending || pending.expiresAt < Date.now()) {
        await bot!.answerCallbackQuery(qId, { text: "This approval has expired.", show_alert: true });
        try {
          await bot!.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: query.message.chat.id, message_id: query.message.message_id }
          );
        } catch { /* ignore */ }
        return;
      }

      pendingApprovals.delete(token);
      await bot!.answerCallbackQuery(qId, { text: "Approved! Sending notifications…" });

      try {
        await bot!.editMessageText(
          query.message.text! + "\n\n✅ *Approved — notifications dispatched*",
          {
            chat_id:      query.message.chat.id,
            message_id:   query.message.message_id,
            parse_mode:   "Markdown",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } catch { /* ignore */ }

      const { sent, inApp } = await dispatchEventNotifications(pending.event);

      // Send preview card to organiser
      await sendOrgPreviewCard(pending.event);

      await bot!.sendMessage(
        String(query.message.chat.id),
        `📬 Sent: *${sent}* Telegram, *${inApp}* in-app notifications. Preview card sent to organiser.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    if (data.startsWith("decline_event:")) {
      const token = data.split(":")[1];
      pendingApprovals.delete(token);
      await bot!.answerCallbackQuery(qId, { text: "Declined." });
      try {
        await bot!.editMessageText(
          query.message.text! + "\n\n❌ *Declined — no notifications sent*",
          {
            chat_id:      query.message.chat.id,
            message_id:   query.message.message_id,
            parse_mode:   "Markdown",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } catch { /* ignore */ }
      return;
    }

    // ── Block action (availability report) ────────────────────────────────
    if (data.startsWith("block_action:")) {
      const [, dayStr, startStr, endStr] = data.split(":");
      const day       = parseInt(dayStr,   10);
      const startHour = parseInt(startStr, 10);
      const endHour   = parseInt(endStr,   10);
      const dayName   = DAYS[day] ?? `Day ${day}`;
      await bot!.answerCallbackQuery(qId, {
        text: `${dayName} ${fmtHour(startHour)}–${fmtHour(endHour + 1)} — use the admin panel to notify organisers for this slot.`,
        show_alert: true,
      });
      return;
    }

    // Fallback
    await bot!.answerCallbackQuery(qId);
  });
}
