// server/bot.ts
// Telegram bot running inside meh-auth.
// Uses the users table directly — no separate subscribers table.
// A user becomes a "subscriber" the moment they /start the bot,
// which links their telegramId to their meh-auth account.

import TelegramBot from "node-telegram-bot-api";
import { db } from "./db";
import { users, notifications } from "@shared/schema";
import { eq, and, gte, inArray, isNotNull } from "drizzle-orm";
import { EVENT_CATEGORIES, getCategoryLabel } from "@shared/categories";
import { handleTelegramStartToken } from "./telegram-link";

const CATEGORY_ICONS: Record<string, string> = {
  networking: "🔗", tech: "💻", culture: "🎨", food: "🍔",
  sports: "⚽", music: "🎵", language: "🌍", outdoor: "🏕️",
  games: "🎮", business: "💼", wellness: "🧘", family: "👨‍👩‍👧",
  social: "🤝", volunteering: "🙌", other: "📌",
};

let bot: TelegramBot | null = null;

export function getBot(): TelegramBot | null {
  return bot;
}

// ── Send a Telegram message to a user by telegramId ────────────────────────
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

// ── Notify users whose interests match a new event ─────────────────────────
export async function notifyMatchingUsers(event: {
  id: number;
  title: string;
  category: string;
  date: Date;
  venueCity: string;
  venueAddress: string;
  description: string;
}): Promise<{ sent: number; inApp: number }> {
  // Find users with matching interest AND a telegram ID
  const matchingUsers = await db
    .select()
    .from(users)
    .where(
      and(
        isNotNull(users.telegramId),
        // interests is a text array — check if category is included
        // Using raw SQL for array contains
      )
    );

  // Filter in JS for interests match (Drizzle array contains support varies)
  const interested = matchingUsers.filter(u =>
    Array.isArray(u.interests) && u.interests.includes(event.category)
  );

  const icon = CATEGORY_ICONS[event.category] ?? "📌";
  const date = new Date(event.date).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });

  const message =
    `${icon} *New ${getCategoryLabel(event.category)} event*\n\n` +
    `*${event.title}*\n` +
    `📅 ${date}\n` +
    `📍 ${event.venueAddress}, ${event.venueCity}\n\n` +
    `${event.description.slice(0, 200)}${event.description.length > 200 ? "…" : ""}\n\n` +
    `[View event](https://expatevents.org/events/${event.id})`;

  let sent = 0;
  let inApp = 0;

  for (const user of interested) {
    // In-app notification (always)
    await db.insert(notifications).values({
      userId: user.id,
      type: "new_event",
      title: `New ${getCategoryLabel(event.category)} event`,
      body: `${event.title} — ${date} at ${event.venueCity}`,
      appScope: "expat",
      eventId: event.id,
      link: `/events/${event.id}`,
    });
    inApp++;

    // Telegram (if connected)
    if (user.telegramId) {
      const ok = await sendToUser(user.telegramId, message);
      if (ok) sent++;
    }
  }

  console.log(`[bot] Event ${event.id}: notified ${inApp} in-app, ${sent} via Telegram`);
  return { sent, inApp };
}

// ── Notify admin of an availability match ─────────────────────────────────
export async function notifyAdminAvailabilityMatch(match: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
  userIds: number[];
}): Promise<void> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTelegramId || !bot) return;

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[match.day] ?? `Day ${match.day}`;
  const hourStr = `${String(match.hour).padStart(2, "0")}:00`;
  const icon = CATEGORY_ICONS[match.category] ?? "📌";

  const message =
    `${icon} *Availability match detected*\n\n` +
    `*${match.userCount} users* are interested in *${getCategoryLabel(match.category)}* ` +
    `and are free on *${dayName} at ${hourStr}*\n\n` +
    `Approve an organiser for this slot? Reply with:\n` +
    `/approve_match ${match.category} ${match.day} ${match.hour}`;

  await sendToUser(adminTelegramId, message);
}

// ── Notify an event organiser of a demand signal ──────────────────────────
export async function notifyOrganiserDemand(organiserId: number, match: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
}): Promise<void> {
  const [organiser] = await db.select().from(users).where(eq(users.id, organiserId));
  if (!organiser?.telegramId || !bot) return;

  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayName = days[match.day] ?? `Day ${match.day}`;
  const hourStr = `${String(match.hour).padStart(2, "0")}:00`;
  const icon = CATEGORY_ICONS[match.category] ?? "📌";

  const message =
    `${icon} *Demand signal for your events*\n\n` +
    `*${match.userCount} expats* are free on *${dayName} at ${hourStr}* ` +
    `and interested in *${getCategoryLabel(match.category)}*\n\n` +
    `Consider hosting an event at this time!\n` +
    `[Create an event](https://expatevents.org/create-event)`;

  await sendToUser(organiser.telegramId, message);
}

// ── Broadcast to all users with a telegramId ──────────────────────────────
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

// ── Init bot ───────────────────────────────────────────────────────────────
export function initBot(): void {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  bot = new TelegramBot(token, { polling: true });
  console.log("[bot] Telegram bot started");

  bot.on("polling_error", (err: any) => {
    if (err?.code === "ETELEGRAM" && err?.message?.includes("409")) {
      console.warn("[bot] Another instance running (409) — stopping polling");
      bot?.stopPolling();
    } else {
      console.error("[bot] Polling error:", err?.message ?? err);
    }
  });

  // /start — link Telegram account to meh-auth user or prompt sign-in
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const telegramId = String(msg.from?.id ?? chatId);
  const firstName = msg.from?.first_name ?? "there";
  const token = match?.[1]?.trim();

  // If a token was passed, handle the deep link flow
  if (token) {
    await handleTelegramStartToken(chatId, telegramId, token, firstName);
    return;
  }

  // Plain /start — check if already linked
  const [existing] = await db
    .select()
    .from(users)
    .where(eq(users.telegramId, telegramId));

  if (existing) {
    await bot!.sendMessage(chatId,
      `👋 Welcome back, *${existing.displayName ?? existing.username}*!\n\n` +
      `You're subscribed to ExpatEvents notifications.\n` +
      `Your interests: ${existing.interests?.map((i: string) => `${CATEGORY_ICONS[i] ?? ""} ${getCategoryLabel(i)}`).join(", ") || "none set yet"}\n\n` +
      `[Update your profile](https://expatevents.org/profile)`,
      { parse_mode: "Markdown" }
    );
  } else {
    await bot!.sendMessage(chatId,
      `👋 Hi ${firstName}! Welcome to *ExpatEvents*.\n\n` +
      `To receive personalised event notifications, connect your account:\n\n` +
      `1. Go to [expatevents.org](https://expatevents.org)\n` +
      `2. Sign in and open your profile\n` +
      `3. Tap *Connect Telegram* — you'll get a link that brings you straight back here\n\n` +
      `Your accounts will be linked automatically.`,
      { parse_mode: "Markdown" }
    );
  }
});

  // /interests — show current interests
  bot.onText(/\/interests/, async (msg) => {
    const telegramId = String(msg.from?.id ?? msg.chat.id);
    const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId));

    if (!user) {
      await bot!.sendMessage(msg.chat.id,
        "You're not connected to an ExpatEvents account yet.\nSend /start for instructions."
      );
      return;
    }

    const list = user.interests?.length
      ? user.interests.map(i => `${CATEGORY_ICONS[i] ?? "•"} ${getCategoryLabel(i)}`).join("\n")
      : "No interests set yet.";

    await bot!.sendMessage(msg.chat.id,
      `*Your current interests:*\n${list}\n\nUpdate them at [expatevents.org/profile](https://expatevents.org/profile)`,
      { parse_mode: "Markdown" }
    );
  });

  // /stop — unlink telegram from notifications (doesn't delete account)
  bot.onText(/\/stop/, async (msg) => {
    const telegramId = String(msg.from?.id ?? msg.chat.id);
    const [user] = await db.select().from(users).where(eq(users.telegramId, telegramId));

    if (user) {
      await db.update(users).set({ telegramId: null }).where(eq(users.id, user.id));
    }

    await bot!.sendMessage(msg.chat.id,
      "You've been unsubscribed from Telegram notifications.\n" +
      "Your account is still active at expatevents.org.\n" +
      "Send /start to reconnect anytime. 👋"
    );
  });

  // Admin: /approve_match <category> <day> <hour>
  bot.onText(/\/approve_match (\w+) (\d+) (\d+)/, async (msg, match) => {
    const telegramId = String(msg.from?.id ?? msg.chat.id);
    if (telegramId !== process.env.ADMIN_TELEGRAM_ID) return;

    const category = match?.[1];
    const day = parseInt(match?.[2] ?? "0");
    const hour = parseInt(match?.[3] ?? "0");

    if (!category) return;

    // Find organisers for this category (users who have created events in this category)
    // For now notify all admins and users who have listed events
    // This is a stub — expand when host registry is wired up
    await bot!.sendMessage(msg.chat.id,
      `✅ Approved. Looking for organisers for *${getCategoryLabel(category)}*...\n` +
      `(Organiser notification coming — wire up host registry to complete this)`,
      { parse_mode: "Markdown" }
    );
  });

  console.log("[bot] Bot commands registered");
}
