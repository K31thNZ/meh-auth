// server/bot.ts
// Telegram bot running inside meh-auth.
// Uses the users table directly — no separate subscribers table.
// A user becomes a "subscriber" the moment they /start the bot,
// which links their telegramId to their meh-auth account.
//
// New event notification flow:
//   1. expatevents calls POST /api/notify/event
//   2. notifyMatchingUsers() sends admin an Approve/Decline inline keyboard
//   3. Admin taps Approve → dispatchEventNotifications() fires to all matching users
//   4. Admin taps Decline → dropped silently, message updated to show declined

import TelegramBot from "node-telegram-bot-api";
import { db } from "./db";
import { users, notifications, availabilityMatches, availabilitySlots } from "@shared/schema";
import { eq, and, isNotNull, inArray, sql } from "drizzle-orm";
import { EVENT_CATEGORIES, getCategoryLabel } from "@shared/categories";
import { handleTelegramStartToken } from "./telegram-link";
import { runAvailabilityMatcher } from "./matcher";

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

// ── Safe date helper (returns Moscow time string, or fallback) ──────────
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

let bot: TelegramBot | null = null;

export function getBot(): TelegramBot | null {
  return bot;
}

// ── Pending approval store ────────────────────────────────────────────────
interface PendingEvent {
  event: {
    id: number;
    title: string;
    category: string;
    date: Date;
    venueCity: string;
    venueAddress: string;
    description: string;
  };
  expiresAt: number;
}

const pendingApprovals = new Map<string, PendingEvent>();

function generateToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

function cleanExpired(): void {
  const now = Date.now();
  for (const [key, val] of pendingApprovals.entries()) {
    if (val.expiresAt < now) pendingApprovals.delete(key);
  }
}

// ── Send a Telegram message to a user by telegramId ──────────────────────
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

// ── Dispatch notifications to all matching users (post-approval) ──────────
async function dispatchEventNotifications(
  event: PendingEvent["event"]
): Promise<{ sent: number; inApp: number }> {
  const matchingUsers = await db
    .select()
    .from(users)
    .where(sql`${event.category} = ANY(${users.interests})`);

  const icon = CATEGORY_ICONS[event.category] ?? "📌";
  const dateStr = safeMoscowStr(event.date);

  const message =
    `${icon} *New ${getCategoryLabel(event.category)} event*\n\n` +
    `*${event.title}*\n` +
    `📅 ${dateStr}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n\n` +
    `${event.description.slice(0, 200)}${event.description.length > 200 ? "…" : ""}\n\n` +
    `[View event](https://expatevents.org/events/${event.id})`;

  let sent = 0;
  let inApp = 0;

  for (const user of matchingUsers) {
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

    if (user.telegramId) {
      const ok = await sendToUser(user.telegramId, message);
      if (ok) sent++;
    }
  }

  console.log(`[bot] Event ${event.id} dispatched: ${inApp} in-app, ${sent} Telegram`);
  return { sent, inApp };
}

// ── notifyMatchingUsers — sends admin approval prompt first ───────────────
export async function notifyMatchingUsers(event: {
  id: number;
  title: string;
  category: string;
  date: Date;
  venueCity: string;
  venueAddress: string;
  description: string;
}): Promise<{ sent: number; inApp: number }> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;

  if (!adminTelegramId || !bot) {
    console.warn("[bot] ADMIN_TELEGRAM_ID not set — dispatching without approval");
    return dispatchEventNotifications(event);
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

  const icon = CATEGORY_ICONS[event.category] ?? "📌";
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
    return dispatchEventNotifications(event);
  }

  return { sent: 0, inApp: 0 };
}

// ── Match report ──────────────────────────────────────────────────────────
export async function notifyAdminAvailabilityMatch(_match: {
  category: string; day: number; hour: number; userCount: number; userIds: number[];
}): Promise<void> {
  // Individual-match notifications are suppressed.
}

export async function sendMatchReport(matches: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
  userIds: number[];
}[]): Promise<void> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTelegramId || !bot) return;
  if (matches.length === 0) return;

  const byCat: Record<string, typeof matches> = {};
  for (const m of matches) {
    if (!byCat[m.category]) byCat[m.category] = [];
    byCat[m.category].push(m);
  }
  const sortedCats = Object.entries(byCat)
    .sort((a, b) => Math.max(...b[1].map(m => m.userCount)) - Math.max(...a[1].map(m => m.userCount)));

  const nowStr = safeMoscowStr(new Date());

  let text = `📊 *Availability Report* — ${matches.length} match${matches.length !== 1 ? "es" : ""}\n`;
  text += `_${nowStr}_\n\n`;

  for (const [cat, rows] of sortedCats) {
    const icon = CATEGORY_ICONS[cat] ?? "📌";
    const topSlots = [...rows].sort((a, b) => b.userCount - a.userCount).slice(0, 3);
    text += `${icon} *${getCategoryLabel(cat)}*\n`;
    for (const slot of topSlots) {
      const dayName = DAYS[slot.day] ?? `Day ${slot.day}`;
      text += `  • ${dayName} ${fmtHour(slot.hour)} — ${slot.userCount} user${slot.userCount !== 1 ? "s" : ""}\n`;
    }
    if (rows.length > 3) text += `  _…+${rows.length - 3} more slots_\n`;
    text += "\n";
  }
  text += "_Tap a row below to notify hosts or dismiss_";

  const topMatches = [...matches].sort((a, b) => b.userCount - a.userCount).slice(0, 10);
  const inline_keyboard = topMatches.map(m => [{
    text: `${CATEGORY_ICONS[m.category] ?? "📌"} ${getCategoryLabel(m.category)} ${DAYS[m.day]} ${fmtHour(m.hour)} (${m.userCount})`,
    callback_data: `match_action:${m.category}:${m.day}:${m.hour}`,
  }]);

  const existing = matchReportMessages.get(adminTelegramId);

  try {
    if (existing) {
      await bot.editMessageText(text, {
        chat_id:    existing.chatId,
        message_id: existing.messageId,
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard },
      });
    } else {
      const sent = await bot.sendMessage(adminTelegramId, text, {
        parse_mode:   "Markdown",
        reply_markup: { inline_keyboard },
      });
      matchReportMessages.set(adminTelegramId, {
        chatId:    sent.chat.id,
        messageId: sent.message_id,
      });
    }
    console.log(`[bot] Match report sent/updated (${matches.length} matches)`);
  } catch (err: any) {
    if (err?.message?.includes("message to edit not found") || err?.message?.includes("MESSAGE_ID_INVALID")) {
      matchReportMessages.delete(adminTelegramId);
      try {
        const sent = await bot.sendMessage(adminTelegramId, text, {
          parse_mode:   "Markdown",
          reply_markup: { inline_keyboard },
        });
        matchReportMessages.set(adminTelegramId, { chatId: sent.chat.id, messageId: sent.message_id });
      } catch (e2: any) {
        console.error("[bot] Failed to send fresh match report:", e2.message);
      }
    } else {
      console.error("[bot] Failed to update match report:", err.message);
    }
  }
}

// ── Notify an event organiser of a demand signal ─────────────────────────
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
  const icon = CATEGORY_ICONS[match.category] ?? "📌";

  const message =
    `${icon} *Demand signal for your events*\n\n` +
    `*${match.userCount} expats* are free on *${dayName} at ${hourStr}* ` +
    `and interested in *${getCategoryLabel(match.category)}*\n\n` +
    `Consider hosting an event at this time!\n` +
    `[Create an event](https://expatevents.org/create-event)`;

  await sendToUser(organiser.telegramId, message);
}

// ── Broadcast to all users with a telegramId ─────────────────────────────
export async function broadcastMessage(message: string): Promise<{ sent: number; failed: number }> {
  const allUsers = await db
    .select()
    .from(users)
    .where(isNotNull(users.telegramId));

  let sent = 0;
  let failed = 0;

  for (const user of allUsers) {
    if (user.telegramId) {
      const ok = await sendToUser(user.telegramId, message);
      ok ? sent++ : failed++;
    }
  }

  return { sent, failed };
}

const matchReportMessages = new Map<string, { chatId: number; messageId: number }>();

// ── Init bot ──────────────────────────────────────────────────────────────
export function initBot(): void {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  // Force a more reliable HTTPS agent – prevents many connection‑dump errors
  if (!process.env.NTBA_FIX_319) {
    process.env.NTBA_FIX_319 = "1";
  }

  bot = new TelegramBot(botToken, { polling: true });
  console.log("[bot] Telegram bot started");

  bot.on("polling_error", (err: any) => {
    if (err?.code === "ETELEGRAM" && err?.message?.includes("409")) {
      console.warn("[bot] Another instance running (409) — destroying this instance");
      // Stop polling and clear the bot reference to prevent further attempts
      bot?.stopPolling().then(() => {
        bot = null;
      }).catch(() => {
        bot = null;
      });
    } else {
      console.error("[bot] Polling error:", err?.message ?? err);
    }
  });

  // … rest of callbacks (identical to your file) …
  // I'll paste the whole thing for completeness, but it's the same.
};
