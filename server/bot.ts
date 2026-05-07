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
//
// Spark flow:
//   /sparks  — browse active sparks matching the user's interests
//   /spark   — guided multi-step wizard to create a new spark
//   Inline "I'm in" / "Pass" buttons on each spark card

import TelegramBot from "node-telegram-bot-api";
import { db } from "./db";
import { users, notifications, sparks as sparksTable } from "@shared/schema";
import { eq, and, isNotNull, inArray, sql, gte, lte, or } from "drizzle-orm";
import { EVENT_CATEGORIES, getCategoryLabel } from "@shared/categories";
import { handleTelegramStartToken } from "./telegram-link";

const CATEGORY_ICONS: Record<string, string> = {
  networking: "🔗", tech: "💻", culture: "🎨", food: "🍔",
  sports: "⚽", music: "🎵", language: "🌍", outdoor: "🏕️",
  games: "🎮", business: "💼", wellness: "🧘", family: "👨‍👩‍👧",
  social: "🤝", volunteering: "🙌", other: "📌",
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const SPARK_ACTIVITIES = [
  { value: "social",     label: "Social",     icon: "🤝" },
  { value: "food",       label: "Food & Drink", icon: "🍔" },
  { value: "outdoor",    label: "Outdoor",    icon: "🏕️" },
  { value: "sports",     label: "Sports",     icon: "⚽" },
  { value: "culture",    label: "Culture",    icon: "🎨" },
  { value: "games",      label: "Games",      icon: "🎮" },
  { value: "wellness",   label: "Wellness",   icon: "🧘" },
  { value: "networking", label: "Networking", icon: "🔗" },
  { value: "language",   label: "Language",   icon: "🌍" },
];

const EXPIRE_OPTIONS = [
  { value: 30,  label: "30 min" },
  { value: 60,  label: "1 hour" },
  { value: 120, label: "2 hours" },
  { value: 240, label: "4 hours" },
  { value: 480, label: "8 hours" },
];

// ── Safe date helpers ─────────────────────────────────────────────────────────

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

function fmtHour(h: number): string {
  return `${String(h).padStart(2, "0")}:00`;
}

// ── Singleton bot reference ───────────────────────────────────────────────────

let bot: TelegramBot | null = null;

export function getBot(): TelegramBot | null {
  return bot;
}

// ── Pending event approval store ──────────────────────────────────────────────

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

// ── Spark creation wizard state machine ───────────────────────────────────────
//
// Steps (in order):
//   activity     — inline keyboard, pick category
//   description  — free text (the noticeboard message)
//   location     — free text (place name; no map in Telegram)
//   meetTime     — free text (e.g. "today 19:00" or "2025-06-01 18:30")
//   expires      — inline keyboard, pick expiry window
//   maxPeople    — free text, number
//   confirm      — inline keyboard, Send / Cancel

type SparkWizardStep =
  | "activity"
  | "description"
  | "location"
  | "meetTime"
  | "expires"
  | "maxPeople"
  | "confirm";

interface SparkWizardState {
  step: SparkWizardStep;
  activity?: string;
  description?: string;
  location?: string;
  meetTime?: string;       // ISO string
  expiresInMins?: number;
  maxRespondents?: number;
  // Keep the message_id of the last bot prompt so we can edit it
  lastMessageId?: number;
}

// Keyed by Telegram chat ID (string)
const sparkWizards = new Map<string, SparkWizardState>();

// ── Send helpers ──────────────────────────────────────────────────────────────

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

// ── Format a single spark as a Telegram message ───────────────────────────────

function formatSparkCard(spark: any): string {
  const icon  = SPARK_ACTIVITIES.find(a => a.value === spark.activity)?.icon ?? "⚡";
  const label = SPARK_ACTIVITIES.find(a => a.value === spark.activity)?.label ?? spark.activity;
  const dateStr = safeMoscowStr(spark.meetTime);
  const accepted = Array.isArray(spark.responses)
    ? spark.responses.filter((r: any) => r.status === "accepted").length
    : 0;

  return (
    `⚡ *Spark — ${label}* ${icon}\n\n` +
    `*${spark.title}*\n` +
    `${spark.description ? spark.description.slice(0, 200) + (spark.description.length > 200 ? "…" : "") + "\n\n" : ""}` +
    `📍 ${spark.location}\n` +
    `🕐 ${dateStr}\n` +
    `👥 ${accepted}/${spark.maxRespondents} going\n` +
    `⏳ Expires ${safeMoscowStr(spark.expiresAt)}`
  );
}

function sparkInlineKeyboard(sparkId: number): TelegramBot.InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: "⚡ I'm in", callback_data: `spark_join:${sparkId}` },
      { text: "👋 Pass",   callback_data: `spark_pass:${sparkId}` },
    ]],
  };
}

// ── Public: notify users about a new spark (called from API route) ────────────

export async function notifySparkToMatching(spark: {
  id: number;
  title: string;
  description?: string;
  activity: string;
  location: string;
  meetTime: Date | string;
  expiresAt: Date | string;
  maxRespondents: number;
  senderId: string;       // the creator's user.id (number stored as string)
}): Promise<{ sent: number }> {
  if (!bot) return { sent: 0 };

  // Find users who share this interest (excluding the sender)
  const matchingUsers = await db
    .select()
    .from(users)
    .where(
      and(
        isNotNull(users.telegramId),
        sql`${spark.activity} = ANY(${users.interests})`,
        sql`${users.id}::text != ${spark.senderId}`
      )
    );

  const icon    = SPARK_ACTIVITIES.find(a => a.value === spark.activity)?.icon ?? "⚡";
  const label   = SPARK_ACTIVITIES.find(a => a.value === spark.activity)?.label ?? spark.activity;
  const dateStr = safeMoscowStr(spark.meetTime);

  const text =
    `⚡ *New Spark near you!*\n\n` +
    `${icon} *${label}* — ${spark.title}\n` +
    `${spark.description ? spark.description.slice(0, 150) + "\n\n" : ""}` +
    `📍 ${spark.location}\n` +
    `🕐 ${dateStr}\n\n` +
    `Tap below to join or pass.`;

  let sent = 0;
  for (const user of matchingUsers) {
    if (!user.telegramId) continue;
    try {
      await bot.sendMessage(user.telegramId, text, {
        parse_mode:   "Markdown",
        reply_markup: sparkInlineKeyboard(spark.id),
      });
      sent++;
    } catch (err: any) {
      console.error(`[bot] Failed to notify spark to ${user.telegramId}:`, err.message);
    }
  }

  console.log(`[bot] Spark ${spark.id} notified to ${sent} users`);
  return { sent };
}

// ── /sparks — browse active sparks matching user interests ────────────────────

async function handleSparksBrowse(chatId: string): Promise<void> {
  if (!bot) return;

  // Resolve user from telegramId
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, chatId));

  if (!user) {
    await bot.sendMessage(chatId,
      "You need to link your ExpatEvents account first.\n" +
      "Visit [expatevents.org](https://expatevents.org) → Settings → Connect Telegram.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const now = new Date();

  // Fetch active, non-expired sparks
  const activeSparks = await db
    .select()
    .from(sparksTable)
    .where(
      and(
        inArray(sparksTable.status, ["pending", "active"]),
        gte(sparksTable.expiresAt, now),
        gte(sparksTable.meetTime,  now)
      )
    );

  if (activeSparks.length === 0) {
    await bot.sendMessage(chatId,
      "⚡ *No active sparks right now.*\n\nBe the first — use /spark to create one!",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Filter to user's interests if they have any; otherwise show all
  const userInterests: string[] = (user.interests ?? []) as string[];
  const relevant = userInterests.length > 0
    ? activeSparks.filter(s => userInterests.includes(s.activity))
    : activeSparks;

  const toShow = relevant.length > 0 ? relevant : activeSparks;

  await bot.sendMessage(chatId,
    `⚡ *${toShow.length} active Spark${toShow.length !== 1 ? "s" : ""}* near you:`,
    { parse_mode: "Markdown" }
  );

  // Send each spark as a separate card with action buttons
  for (const spark of toShow.slice(0, 8)) { // cap at 8 to avoid flooding
    await bot.sendMessage(chatId, formatSparkCard(spark), {
      parse_mode:   "Markdown",
      reply_markup: sparkInlineKeyboard(spark.id),
    });
    // Small delay to avoid hitting Telegram rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  if (toShow.length > 8) {
    await bot.sendMessage(chatId,
      `_…and ${toShow.length - 8} more. View all at [expatevents.org/sparks](https://expatevents.org/sparks)_`,
      { parse_mode: "Markdown" }
    );
  }
}

// ── Spark creation wizard helpers ─────────────────────────────────────────────

async function startSparkWizard(chatId: string): Promise<void> {
  if (!bot) return;

  // Check user is linked
  const [user] = await db.select().from(users).where(eq(users.telegramId, chatId));
  if (!user) {
    await bot.sendMessage(chatId,
      "You need to link your ExpatEvents account first.\n" +
      "Visit [expatevents.org](https://expatevents.org) → Settings → Connect Telegram.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Kill any existing wizard for this chat
  sparkWizards.delete(chatId);
  sparkWizards.set(chatId, { step: "activity" });

  // Build activity keyboard (3 columns)
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  for (let i = 0; i < SPARK_ACTIVITIES.length; i += 3) {
    rows.push(
      SPARK_ACTIVITIES.slice(i, i + 3).map(a => ({
        text: `${a.icon} ${a.label}`,
        callback_data: `swiz_activity:${a.value}`,
      }))
    );
  }
  rows.push([{ text: "❌ Cancel", callback_data: "swiz_cancel" }]);

  const sent = await bot.sendMessage(chatId,
    "⚡ *Create a Spark*\n\n*Step 1/6 — What are you up for?*",
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
  );
  const state = sparkWizards.get(chatId)!;
  state.lastMessageId = sent.message_id;
}

async function wizardPromptDescription(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  const icon = SPARK_ACTIVITIES.find(a => a.value === state.activity)?.icon ?? "⚡";
  await bot.sendMessage(chatId,
    `${icon} *Step 2/6 — Tell people about it*\n\n` +
    `Write a short noticeboard message (10–300 chars).\n` +
    `_e.g. "Looking for someone to grab coffee and chat in English. I'm B2 Russian, friendly!"_`,
    { parse_mode: "Markdown" }
  );
  state.step = "description";
}

async function wizardPromptLocation(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  await bot.sendMessage(chatId,
    `📍 *Step 3/6 — Where?*\n\nType the venue or area name.\n_e.g. "Gorky Park", "Surf Coffee on Tverskaya"_`,
    { parse_mode: "Markdown" }
  );
  state.step = "location";
}

async function wizardPromptMeetTime(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  await bot.sendMessage(chatId,
    `🕐 *Step 4/6 — When?*\n\nType a date and time.\n_e.g. "today 19:00", "tomorrow 14:30", "2025-06-01 18:00"_`,
    { parse_mode: "Markdown" }
  );
  state.step = "meetTime";
}

async function wizardPromptExpiry(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  const rows: TelegramBot.InlineKeyboardButton[][] = [
    EXPIRE_OPTIONS.slice(0, 3).map(o => ({
      text: o.label,
      callback_data: `swiz_expires:${o.value}`,
    })),
    EXPIRE_OPTIONS.slice(3).map(o => ({
      text: o.label,
      callback_data: `swiz_expires:${o.value}`,
    })),
    [{ text: "❌ Cancel", callback_data: "swiz_cancel" }],
  ];

  await bot.sendMessage(chatId,
    `⏳ *Step 5/6 — How long should this ping stay open?*`,
    { parse_mode: "Markdown", reply_markup: { inline_keyboard: rows } }
  );
  state.step = "expires";
}

async function wizardPromptMaxPeople(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  await bot.sendMessage(chatId,
    `👥 *Step 6/6 — Max people?*\n\nHow many people can join? (1–20)\n_Just type a number._`,
    { parse_mode: "Markdown" }
  );
  state.step = "maxPeople";
}

async function wizardShowConfirm(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  const icon  = SPARK_ACTIVITIES.find(a => a.value === state.activity)?.icon ?? "⚡";
  const label = SPARK_ACTIVITIES.find(a => a.value === state.activity)?.label ?? state.activity;
  const expLabel = EXPIRE_OPTIONS.find(o => o.value === state.expiresInMins)?.label ?? `${state.expiresInMins} min`;

  const summary =
    `⚡ *Ready to send your Spark?*\n\n` +
    `${icon} *${label}*\n` +
    `📝 ${state.description}\n` +
    `📍 ${state.location}\n` +
    `🕐 ${state.meetTime}\n` +
    `⏳ Ping open for ${expLabel}\n` +
    `👥 Up to ${state.maxRespondents} people\n\n` +
    `_Tap Send to publish, or Cancel to discard._`;

  state.step = "confirm";

  await bot.sendMessage(chatId, summary, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: [[
        { text: "🚀 Send Spark", callback_data: "swiz_send" },
        { text: "❌ Cancel",     callback_data: "swiz_cancel" },
      ]],
    },
  });
}

// Parse natural-language time inputs ("today 19:00", "tomorrow 14:30", ISO)
function parseNaturalTime(input: string): Date | null {
  const now = new Date();
  const lower = input.toLowerCase().trim();

  // "today HH:MM"
  const todayMatch = lower.match(/^today\s+(\d{1,2}):(\d{2})$/);
  if (todayMatch) {
    const d = new Date(now);
    d.setHours(parseInt(todayMatch[1]), parseInt(todayMatch[2]), 0, 0);
    return d > now ? d : null;
  }

  // "tomorrow HH:MM"
  const tomorrowMatch = lower.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/);
  if (tomorrowMatch) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    d.setHours(parseInt(tomorrowMatch[1]), parseInt(tomorrowMatch[2]), 0, 0);
    return d;
  }

  // "YYYY-MM-DD HH:MM" or ISO
  const isoMatch = input.match(/(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/);
  if (isoMatch) {
    const d = new Date(`${isoMatch[1]}T${isoMatch[2]}:00`);
    return isNaN(d.getTime()) ? null : d;
  }

  // "HH:MM" — assume today, must be in the future
  const timeOnly = lower.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnly) {
    const d = new Date(now);
    d.setHours(parseInt(timeOnly[1]), parseInt(timeOnly[2]), 0, 0);
    if (d <= now) d.setDate(d.getDate() + 1); // push to tomorrow if past
    return d;
  }

  return null;
}

// ── Submit a completed wizard to the DB ───────────────────────────────────────

async function submitSparkWizard(chatId: string): Promise<void> {
  if (!bot) return;
  const state = sparkWizards.get(chatId);
  if (!state) return;

  const [user] = await db.select().from(users).where(eq(users.telegramId, chatId));
  if (!user) {
    await bot.sendMessage(chatId, "Session expired — please /start again.");
    sparkWizards.delete(chatId);
    return;
  }

  try {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + (state.expiresInMins ?? 60) * 60_000);

    // Derive a short title from the activity
    const label = SPARK_ACTIVITIES.find(a => a.value === state.activity)?.label ?? "Meetup";
    const icon  = SPARK_ACTIVITIES.find(a => a.value === state.activity)?.icon ?? "⚡";

    const [inserted] = await db
      .insert(sparksTable)
      .values({
        senderId:      String(user.id),
        title:         `${icon} ${label}`,
        description:   state.description ?? "",
        activity:      state.activity ?? "social",
        location:      state.location ?? "Moscow",
        meetTime:      new Date(state.meetTime!),
        expiresAt,
        maxRespondents: state.maxRespondents ?? 5,
        status:        "pending",
      })
      .returning();

    sparkWizards.delete(chatId);

    await bot.sendMessage(chatId,
      `✅ *Spark sent!* ⚡\n\n` +
      `People nearby with matching interests will be notified.\n` +
      `[View on ExpatEvents](https://expatevents.org/sparks)`,
      { parse_mode: "Markdown" }
    );

    // Notify matching users
    await notifySparkToMatching({
      id:            inserted.id,
      title:         inserted.title,
      description:   inserted.description ?? undefined,
      activity:      inserted.activity,
      location:      inserted.location,
      meetTime:      inserted.meetTime,
      expiresAt:     inserted.expiresAt,
      maxRespondents: inserted.maxRespondents,
      senderId:      String(user.id),
    });

  } catch (err: any) {
    console.error("[bot] Failed to insert spark:", err.message);
    await bot.sendMessage(chatId,
      "❌ Something went wrong creating your Spark. Please try again."
    );
    sparkWizards.delete(chatId);
  }
}

// ── Handle "I'm in" / "Pass" callbacks ───────────────────────────────────────

async function handleSparkJoin(
  chatId: string,
  sparkId: number,
  callbackQueryId: string
): Promise<void> {
  if (!bot) return;

  const [user] = await db.select().from(users).where(eq(users.telegramId, chatId));
  if (!user) {
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "Link your account first at expatevents.org",
      show_alert: true,
    });
    return;
  }

  const [spark] = await db.select().from(sparksTable).where(eq(sparksTable.id, sparkId));
  if (!spark) {
    await bot.answerCallbackQuery(callbackQueryId, { text: "Spark not found.", show_alert: true });
    return;
  }
  if (!["pending", "active"].includes(spark.status)) {
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "This Spark is no longer open.",
      show_alert: true,
    });
    return;
  }
  if (new Date(spark.expiresAt) < new Date()) {
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "This Spark has expired.",
      show_alert: true,
    });
    return;
  }

  // Insert or update a response row
  // (Assumes a spark_responses table; adjust table/column names to match your schema)
  try {
    await db.execute(
      sql`
        INSERT INTO spark_responses (spark_id, responder_id, status, created_at, updated_at)
        VALUES (${sparkId}, ${String(user.id)}, 'accepted', NOW(), NOW())
        ON CONFLICT (spark_id, responder_id)
        DO UPDATE SET status = 'accepted', updated_at = NOW()
      `
    );

    // Update spark status to 'active' once it has at least one accepted response
    await db
      .update(sparksTable)
      .set({ status: "active" })
      .where(and(eq(sparksTable.id, sparkId), eq(sparksTable.status, "pending")));

    await bot.answerCallbackQuery(callbackQueryId, {
      text: `⚡ You're in! See you at ${spark.location}.`,
    });

    // Notify the spark creator
    const [creator] = await db
      .select()
      .from(users)
      .where(sql`${users.id}::text = ${spark.senderId}`);

    if (creator?.telegramId && creator.telegramId !== chatId) {
      const displayName = user.displayName ?? user.username ?? "Someone";
      await sendToUser(
        creator.telegramId,
        `⚡ *${displayName} joined your Spark!*\n\n` +
        `"${spark.title}" at ${spark.location}\n` +
        `[Manage on ExpatEvents](https://expatevents.org/sparks)`
      );
    }
  } catch (err: any) {
    console.error("[bot] spark_join error:", err.message);
    await bot.answerCallbackQuery(callbackQueryId, {
      text: "Something went wrong. Please try on the website.",
      show_alert: true,
    });
  }
}

async function handleSparkPass(
  chatId: string,
  sparkId: number,
  callbackQueryId: string
): Promise<void> {
  if (!bot) return;

  const [user] = await db.select().from(users).where(eq(users.telegramId, chatId));
  if (!user) {
    await bot.answerCallbackQuery(callbackQueryId, { text: "Not linked.", show_alert: true });
    return;
  }

  try {
    await db.execute(
      sql`
        INSERT INTO spark_responses (spark_id, responder_id, status, created_at, updated_at)
        VALUES (${sparkId}, ${String(user.id)}, 'declined', NOW(), NOW())
        ON CONFLICT (spark_id, responder_id)
        DO UPDATE SET status = 'declined', updated_at = NOW()
      `
    );
    await bot.answerCallbackQuery(callbackQueryId, { text: "👋 Passed." });
  } catch (err: any) {
    console.error("[bot] spark_pass error:", err.message);
    await bot.answerCallbackQuery(callbackQueryId, { text: "Error — try on the website." });
  }
}

// ── Dispatch event notifications (post-admin approval) ────────────────────────

async function dispatchEventNotifications(
  event: PendingEvent["event"]
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

  let sent = 0;
  let inApp = 0;

  const { notifications: notificationsTable } = await import("@shared/schema");

  for (const user of matchingUsers) {
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

    if (user.telegramId) {
      const ok = await sendToUser(user.telegramId, message);
      if (ok) sent++;
    }
  }

  console.log(`[bot] Event ${event.id} dispatched: ${inApp} in-app, ${sent} Telegram`);
  return { sent, inApp };
}

// ── notifyMatchingUsers — sends admin approval prompt first ───────────────────

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
    return dispatchEventNotifications(event);
  }

  return { sent: 0, inApp: 0 };
}

// ── Match report ──────────────────────────────────────────────────────────────

export async function notifyAdminAvailabilityMatch(_match: {
  category: string; day: number; hour: number; userCount: number; userIds: number[];
}): Promise<void> {
  // Individual-match notifications suppressed — report batching handles this.
}

export async function sendMatchReport(matches: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
  userIds: number[];
}[]): Promise<void> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTelegramId || !bot || matches.length === 0) return;

  const byCat: Record<string, typeof matches> = {};
  for (const m of matches) {
    if (!byCat[m.category]) byCat[m.category] = [];
    byCat[m.category].push(m);
  }
  const sortedCats = Object.entries(byCat)
    .sort((a, b) =>
      Math.max(...b[1].map(m => m.userCount)) - Math.max(...a[1].map(m => m.userCount))
    );

  const nowStr = safeMoscowStr(new Date());
  let text = `📊 *Availability Report* — ${matches.length} match${matches.length !== 1 ? "es" : ""}\n_${nowStr}_\n\n`;

  for (const [cat, rows] of sortedCats) {
    const icon     = CATEGORY_ICONS[cat] ?? "📌";
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
        chat_id:      existing.chatId,
        message_id:   existing.messageId,
        parse_mode:   "Markdown",
        reply_markup: { inline_keyboard },
      });
    } else {
      const sent = await bot.sendMessage(adminTelegramId, text, {
        parse_mode:   "Markdown",
        reply_markup: { inline_keyboard },
      });
      matchReportMessages.set(adminTelegramId, { chatId: sent.chat.id, messageId: sent.message_id });
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

// ── Notify event organiser of a demand signal ─────────────────────────────────

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

// ── Broadcast to all linked users ─────────────────────────────────────────────

export async function broadcastMessage(message: string): Promise<{ sent: number; failed: number }> {
  const allUsers = await db.select().from(users).where(isNotNull(users.telegramId));
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
          "✅ Your ExpatEvents account is now linked!\n\n" +
          "Use /sparks to browse live meetup pings, or /spark to create your own."
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
      "I'll keep you updated on events and instant meetup pings (Sparks).\n\n" +
      "*Commands:*\n" +
      "• /sparks — browse active Sparks near you\n" +
      "• /spark — create a new Spark\n" +
      "• /help — show this message\n\n" +
      "Link your account at [expatevents.org](https://expatevents.org) to get personalised notifications.",
      { parse_mode: "Markdown" }
    );
  });

  // ── /help ─────────────────────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot!.sendMessage(chatId,
      "*ExpatEvents Bot — Commands*\n\n" +
      "• /sparks — browse active Sparks matching your interests\n" +
      "• /spark — create an impromptu meetup ping\n" +
      "• /help — show this message\n\n" +
      "Manage your interests and notifications at [expatevents.org](https://expatevents.org).",
      { parse_mode: "Markdown" }
    );
  });

  // ── /sparks — browse ──────────────────────────────────────────────────────
  bot.onText(/\/sparks/, async (msg) => {
    const chatId = String(msg.chat.id);
    await handleSparksBrowse(chatId);
  });

  // ── /spark — start creation wizard ────────────────────────────────────────
  bot.onText(/\/spark$/, async (msg) => {
    const chatId = String(msg.chat.id);
    await startSparkWizard(chatId);
  });

  // ── Free-text messages — routed to active wizard ──────────────────────────
  bot.on("message", async (msg) => {
    // Ignore commands
    if (!msg.text || msg.text.startsWith("/")) return;

    const chatId = String(msg.chat.id);
    const state  = sparkWizards.get(chatId);
    if (!state) return; // no active wizard

    const text = msg.text.trim();

    switch (state.step) {
      case "description": {
        if (text.length < 10) {
          await bot!.sendMessage(chatId, "Please write at least 10 characters so people know what to expect.");
          return;
        }
        if (text.length > 300) {
          await bot!.sendMessage(chatId, "Please keep it under 300 characters.");
          return;
        }
        state.description = text;
        await wizardPromptLocation(chatId);
        break;
      }

      case "location": {
        if (text.length < 2) {
          await bot!.sendMessage(chatId, "Please enter a location name.");
          return;
        }
        state.location = text;
        await wizardPromptMeetTime(chatId);
        break;
      }

      case "meetTime": {
        const parsed = parseNaturalTime(text);
        if (!parsed) {
          await bot!.sendMessage(chatId,
            '❌ Could not parse that time. Try something like "today 19:00", "tomorrow 14:30", or "2025-06-01 18:00".'
          );
          return;
        }
        state.meetTime = parsed.toISOString();
        await wizardPromptExpiry(chatId);
        break;
      }

      case "maxPeople": {
        const n = parseInt(text, 10);
        if (isNaN(n) || n < 1 || n > 20) {
          await bot!.sendMessage(chatId, "Please enter a number between 1 and 20.");
          return;
        }
        state.maxRespondents = n;
        await wizardShowConfirm(chatId);
        break;
      }

      default:
        break;
    }
  });

  // ── Callback query handler ────────────────────────────────────────────────
  bot.on("callback_query", async (query) => {
    if (!query.data || !query.message) return;

    const chatId = String(query.message.chat.id);
    const data   = query.data;
    const qId    = query.id;

    // ── Spark wizard callbacks ──────────────────────────────────────────────

    if (data.startsWith("swiz_activity:")) {
      const activity = data.split(":")[1];
      const state    = sparkWizards.get(chatId);
      if (!state) { await bot!.answerCallbackQuery(qId); return; }
      state.activity = activity;
      await bot!.answerCallbackQuery(qId);
      // Edit the activity message to confirm selection
      const icon  = SPARK_ACTIVITIES.find(a => a.value === activity)?.icon ?? "⚡";
      const label = SPARK_ACTIVITIES.find(a => a.value === activity)?.label ?? activity;
      try {
        await bot!.editMessageText(
          `⚡ *Create a Spark*\n\n*Step 1/6 — Activity:* ${icon} ${label} ✓`,
          {
            chat_id:    query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
          }
        );
      } catch { /* edit may fail if identical */ }
      await wizardPromptDescription(chatId);
      return;
    }

    if (data.startsWith("swiz_expires:")) {
      const mins  = parseInt(data.split(":")[1], 10);
      const state = sparkWizards.get(chatId);
      if (!state) { await bot!.answerCallbackQuery(qId); return; }
      state.expiresInMins = mins;
      await bot!.answerCallbackQuery(qId);
      try {
        const label = EXPIRE_OPTIONS.find(o => o.value === mins)?.label ?? `${mins} min`;
        await bot!.editMessageText(
          `⏳ *Step 5/6 — Ping open for:* ${label} ✓`,
          {
            chat_id:    query.message.chat.id,
            message_id: query.message.message_id,
            parse_mode: "Markdown",
          }
        );
      } catch { /* ignore */ }
      await wizardPromptMaxPeople(chatId);
      return;
    }

    if (data === "swiz_send") {
      await bot!.answerCallbackQuery(qId);
      await submitSparkWizard(chatId);
      return;
    }

    if (data === "swiz_cancel") {
      sparkWizards.delete(chatId);
      await bot!.answerCallbackQuery(qId);
      await bot!.sendMessage(chatId, "Spark cancelled. Use /spark to start again.");
      return;
    }

    // ── Spark join / pass ───────────────────────────────────────────────────

    if (data.startsWith("spark_join:")) {
      const sparkId = parseInt(data.split(":")[1], 10);
      await handleSparkJoin(chatId, sparkId, qId);
      return;
    }

    if (data.startsWith("spark_pass:")) {
      const sparkId = parseInt(data.split(":")[1], 10);
      await handleSparkPass(chatId, sparkId, qId);
      return;
    }

    // ── Event approval callbacks ────────────────────────────────────────────

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
          query.message.text + "\n\n✅ *Approved — notifications dispatched*",
          {
            chat_id:      query.message.chat.id,
            message_id:   query.message.message_id,
            parse_mode:   "Markdown",
            reply_markup: { inline_keyboard: [] },
          }
        );
      } catch { /* ignore */ }

      const { sent, inApp } = await dispatchEventNotifications(pending.event);
      await bot!.sendMessage(
        String(query.message.chat.id),
        `📬 Sent: *${sent}* Telegram, *${inApp}* in-app notifications.`,
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
          query.message.text + "\n\n❌ *Declined — no notifications sent*",
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

    // ── Match action (availability report row tap) ──────────────────────────

    if (data.startsWith("match_action:")) {
      await bot!.answerCallbackQuery(qId, {
        text: "Feature coming soon — notify organisers from the admin panel.",
        show_alert: true,
      });
      return;
    }

    // Fallback
    await bot!.answerCallbackQuery(qId);
  });
}
