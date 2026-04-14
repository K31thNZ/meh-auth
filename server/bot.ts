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

let bot: TelegramBot | null = null;

export function getBot(): TelegramBot | null {
  return bot;
}

// ── Pending approval store ────────────────────────────────────────────────
// Keyed by a short random token embedded in callback_data.
// Entries expire after 24 hours so the Map never grows unboundedly.
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
  const dateStr = new Date(event.date).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });

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
// Called by notify-routes.ts when expatevents publishes a new event.
// Returns { sent: 0, inApp: 0 } immediately — actual sends happen after approval.
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

  // No admin configured → dispatch immediately without approval step
  if (!adminTelegramId || !bot) {
    console.warn("[bot] ADMIN_TELEGRAM_ID not set — dispatching without approval");
    return dispatchEventNotifications(event);
  }

  // Count how many users would be notified
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
  const dateStr = new Date(event.date).toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short",
    hour: "2-digit", minute: "2-digit",
  });

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
    // Can't reach admin — fall back to immediate dispatch
    console.error("[bot] Failed to message admin, dispatching immediately:", err.message);
    pendingApprovals.delete(token);
    return dispatchEventNotifications(event);
  }

  return { sent: 0, inApp: 0 };
}

// ── Notify admin of an availability match ────────────────────────────────
// Sends an inline keyboard so admin can immediately notify hosts in one tap.
export async function notifyAdminAvailabilityMatch(match: {
  category: string;
  day: number;
  hour: number;
  userCount: number;
  userIds: number[];
}): Promise<void> {
  const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
  if (!adminTelegramId || !bot) return;

  const dayName = DAYS[match.day] ?? `Day ${match.day}`;
  const hourStr = fmtHour(match.hour);
  const icon = CATEGORY_ICONS[match.category] ?? "📌";

  const message =
    `${icon} *Availability match — ${getCategoryLabel(match.category)}*\n\n` +
    `*${match.userCount} user${match.userCount !== 1 ? "s" : ""}* ` +
    `want *${getCategoryLabel(match.category)}* on *${dayName} at ${hourStr}*\n\n` +
    `Notify hosts to create an event at this slot?`;

  try {
    await bot.sendMessage(adminTelegramId, message, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          {
            text: "📣 Notify hosts",
            callback_data: `notify_hosts:${match.category}:${match.day}:${match.hour}`,
          },
          {
            text: "✖ Dismiss",
            callback_data: `dismiss_match:${match.category}:${match.day}:${match.hour}`,
          },
        ]],
      },
    });
  } catch (err: any) {
    console.error("[bot] Failed to notify admin of match:", err.message);
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

// ── Init bot ──────────────────────────────────────────────────────────────
export function initBot(): void {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN not set — Telegram bot disabled");
    return;
  }

  bot = new TelegramBot(botToken, { polling: true });
  console.log("[bot] Telegram bot started");

  bot.on("polling_error", (err: any) => {
    if (err?.code === "ETELEGRAM" && err?.message?.includes("409")) {
      console.warn("[bot] Another instance running (409) — stopping polling");
      bot?.stopPolling();
    } else {
      console.error("[bot] Polling error:", err?.message ?? err);
    }
  });

  // ── Inline keyboard: Approve / Decline event notification ────────────────
  bot.on("callback_query", async (query) => {
    const adminTelegramId = process.env.ADMIN_TELEGRAM_ID;
    const callerId = String(query.from.id);

    if (callerId !== adminTelegramId) {
      await bot!.answerCallbackQuery(query.id, { text: "⛔ Not authorised." });
      return;
    }

    const data = query.data ?? "";
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const originalText = query.message?.text ?? "";

    if (data.startsWith("approve_event:")) {
      const token = data.replace("approve_event:", "");
      const pending = pendingApprovals.get(token);

      if (!pending) {
        await bot!.answerCallbackQuery(query.id, {
          text: "⚠️ This approval has expired (>24h).",
          show_alert: true,
        });
        // Remove buttons so they can't be clicked again
        if (chatId && messageId) {
          await bot!.editMessageReplyMarkup(
            { inline_keyboard: [] },
            { chat_id: chatId, message_id: messageId }
          ).catch(() => {});
        }
        return;
      }

      pendingApprovals.delete(token);
      await bot!.answerCallbackQuery(query.id, { text: "Sending notifications…" });

      // Show sending state while we work
      if (chatId && messageId) {
        await bot!.editMessageText(
          originalText + "\n\n⏳ _Sending…_",
          { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
        ).catch(() => {});
      }

      const { sent, inApp } = await dispatchEventNotifications(pending.event);

      // Update message with final result
      if (chatId && messageId) {
        await bot!.editMessageText(
          originalText + `\n\n✅ *Approved & sent* — ${sent} Telegram, ${inApp} in-app`,
          { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
        ).catch(() => {});
      }

    } else if (data.startsWith("decline_event:")) {
      const token = data.replace("decline_event:", "");
      pendingApprovals.delete(token);

      await bot!.answerCallbackQuery(query.id, { text: "Declined." });

      if (chatId && messageId) {
        await bot!.editMessageText(
          originalText + "\n\n❌ *Declined* — no notifications sent.",
          { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
        ).catch(() => {});
      }

    } else if (data.startsWith("notify_hosts:")) {
      // Format: notify_hosts:<category>:<day>:<hour>
      const [, category, dayStr, hourStr] = data.split(":");
      const day  = parseInt(dayStr);
      const hour = parseInt(hourStr);

      await bot!.answerCallbackQuery(query.id, { text: "Notifying hosts…" });

      // Find host/admin users with this interest and Telegram connected
      const organisers = await db
        .select({ id: users.id, telegramId: users.telegramId })
        .from(users)
        .where(
          and(
            isNotNull(users.telegramId),
            inArray(users.role, ["host", "admin"]),
            sql`${category} = ANY(${users.interests})`
          )
        );

      const dayName = DAYS[day] ?? `Day ${day}`;
      const hourFmt = fmtHour(hour);
      const icon = CATEGORY_ICONS[category] ?? "📌";

      const demandMessage =
        `${icon} *Demand signal for ${getCategoryLabel(category)}*\n\n` +
        `Expats are looking for *${getCategoryLabel(category)}* events on *${dayName} at ${hourFmt}*.\n\n` +
        `Consider hosting an event at this time!\n` +
        `[Create an event](https://expatevents.org/create-event)`;

      let notified = 0;
      for (const org of organisers) {
        if (org.telegramId) {
          const ok = await sendToUser(org.telegramId, demandMessage);
          if (ok) notified++;
        }
      }

      // Mark match as notified in DB
      await db
        .update(availabilityMatches)
        .set({ notified: true })
        .where(
          and(
            eq(availabilityMatches.category, category),
            eq(availabilityMatches.day, day),
            eq(availabilityMatches.hour, hour)
          )
        );

      if (chatId && messageId) {
        await bot!.editMessageText(
          originalText + `\n\n📣 *Sent* — notified ${notified} host${notified !== 1 ? "s" : ""}`,
          { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
        ).catch(() => {});
      }

    } else if (data.startsWith("dismiss_match:")) {
      const [, category, dayStr, hourStr] = data.split(":");
      const day  = parseInt(dayStr);
      const hour = parseInt(hourStr);

      pendingApprovals.delete(data); // no-op but harmless

      await bot!.answerCallbackQuery(query.id, { text: "Dismissed." });

      // Mark as notified so it won't re-alert on next matcher run
      await db
        .update(availabilityMatches)
        .set({ notified: true })
        .where(
          and(
            eq(availabilityMatches.category, category),
            eq(availabilityMatches.day, day),
            eq(availabilityMatches.hour, hour)
          )
        );

      if (chatId && messageId) {
        await bot!.editMessageText(
          originalText + "\n\n✖ _Dismissed_",
          { chat_id: chatId, message_id: messageId, parse_mode: "Markdown" }
        ).catch(() => {});
      }
    }
  });

  // /start
  bot.onText(/\/start(?:\s+(.+))?/, async (msg, match) => {
    const chatId = msg.chat.id;
    const telegramId = String(msg.from?.id ?? chatId);
    const firstName = msg.from?.first_name ?? "there";
    const deepLinkToken = match?.[1]?.trim();

    if (deepLinkToken) {
      if (typeof handleTelegramStartToken === "function") {
        await handleTelegramStartToken(chatId, telegramId, deepLinkToken, firstName);
      } else {
        await bot!.sendMessage(chatId, "Sorry, the linking feature is temporarily unavailable.");
      }
      return;
    }

    const [existing] = await db.select().from(users).where(eq(users.telegramId, telegramId));

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

  // /interests
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

  // /stop
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
    if (telegramId !== process.env.ADMIN_TELEGRAM_ID) {
      await bot!.sendMessage(msg.chat.id, "⛔ You are not authorized to use this command.");
      return;
    }

    const category = match?.[1];
    const day = parseInt(match?.[2] ?? "0");
    const hour = parseInt(match?.[3] ?? "0");

    if (!category || isNaN(day) || isNaN(hour)) {
      await bot!.sendMessage(msg.chat.id, "Invalid format. Use: /approve_match <category> <day> <hour>");
      return;
    }

    const organisers = await db
      .select({ id: users.id, telegramId: users.telegramId })
      .from(users)
      .where(
        and(
          isNotNull(users.telegramId),
          inArray(users.role, ["host", "admin"]),
          sql`${category} = ANY(${users.interests})`
        )
      );

    if (organisers.length === 0) {
      await bot!.sendMessage(msg.chat.id,
        `No hosts found for *${getCategoryLabel(category)}* with a Telegram ID connected.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const dayName = days[day] ?? `Day ${day}`;
    const hourStr = `${String(hour).padStart(2, "0")}:00`;

    const demandMessage =
      `${CATEGORY_ICONS[category] ?? "📌"} *Demand signal for ${getCategoryLabel(category)}*\n\n` +
      `We've detected expats interested in *${getCategoryLabel(category)}* who are free on *${dayName} at ${hourStr}*.\n\n` +
      `Consider hosting an event at this time!\n` +
      `[Create an event](https://expatevents.org/create-event)`;

    let notified = 0;
    for (const org of organisers) {
      if (org.telegramId) {
        const ok = await sendToUser(org.telegramId, demandMessage);
        if (ok) notified++;
      }
    }

    await bot!.sendMessage(msg.chat.id,
      `✅ Sent demand signal to ${notified} host(s) in *${getCategoryLabel(category)}*.`,
      { parse_mode: "Markdown" }
    );
  });

  // ── /summary (admin) ─────────────────────────────────────────────────────
  // Shows a full breakdown of all current availability matches grouped by
  // category, sorted by user count descending. Re-runs the matcher first so
  // the data is always fresh when the admin asks for it.
  bot.onText(/\/summary/, async (msg) => {
    const telegramId = String(msg.from?.id ?? msg.chat.id);
    if (telegramId !== process.env.ADMIN_TELEGRAM_ID) {
      await bot!.sendMessage(msg.chat.id, "⛔ Admin only command.");
      return;
    }

    await bot!.sendMessage(msg.chat.id, "⏳ Running matcher and compiling summary…");

    try {
      await runAvailabilityMatcher();
    } catch (err: any) {
      console.error("[bot] /summary matcher error:", err.message);
    }

    const matches = await db
      .select()
      .from(availabilityMatches)
      .orderBy(availabilityMatches.category);

    if (matches.length === 0) {
      await bot!.sendMessage(msg.chat.id,
        `No availability matches found yet.

Users need to set their interests and availability slots at expatevents.org/profile.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    // Group by category
    const byCategory: Record<string, typeof matches> = {};
    for (const m of matches) {
      if (!byCategory[m.category]) byCategory[m.category] = [];
      byCategory[m.category].push(m);
    }

    // Sort categories by total user coverage (sum of userIds across slots)
    const sortedCategories = Object.entries(byCategory)
      .map(([cat, rows]) => ({
        cat,
        rows,
        totalUsers: Math.max(...rows.map(r => r.userIds.length)),
      }))
      .sort((a, b) => b.totalUsers - a.totalUsers);

    let text = `📊 *Availability Summary*
${matches.length} active match${matches.length !== 1 ? "es" : ""} across ${sortedCategories.length} categories

`;

    for (const { cat, rows } of sortedCategories) {
      const icon = CATEGORY_ICONS[cat] ?? "📌";
      // Sort slots by user count desc, show top 3
      const topSlots = [...rows]
        .sort((a, b) => b.userIds.length - a.userIds.length)
        .slice(0, 3);

      text += `${icon} *${getCategoryLabel(cat)}*
`;
      for (const slot of topSlots) {
        const notifiedMark = slot.notified ? " ✓" : "";
        text += `  • ${DAYS[slot.day]} ${fmtHour(slot.hour)} — ${slot.userIds.length} users${notifiedMark}
`;
      }
      if (rows.length > 3) {
        text += `  _…and ${rows.length - 3} more slots_
`;
      }
      text += "\n";
    }

    text += `_Use /matches <category> for details_
_Use /approve\_match <category> <day> <hour> to notify hosts_`;

    // Telegram messages max 4096 chars — split if needed
    if (text.length <= 4096) {
      await bot!.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
    } else {
      const chunks = text.match(/[\s\S]{1,4000}/g) ?? [];
      for (const chunk of chunks) {
        await bot!.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
      }
    }
  });

  // ── /matches [category] (admin) ───────────────────────────────────────────
  // Drill into a specific category and see every slot with user count.
  // If no category given, lists available categories.
  bot.onText(/\/matches(?:\s+(\w+))?/, async (msg, match) => {
    const telegramId = String(msg.from?.id ?? msg.chat.id);
    if (telegramId !== process.env.ADMIN_TELEGRAM_ID) {
      await bot!.sendMessage(msg.chat.id, "⛔ Admin only command.");
      return;
    }

    const category = match?.[1]?.toLowerCase().trim();

    if (!category) {
      // List all categories that have matches
      const allMatches = await db.select({ category: availabilityMatches.category }).from(availabilityMatches);
      const categories = [...new Set(allMatches.map(m => m.category))].sort();

      if (categories.length === 0) {
        await bot!.sendMessage(msg.chat.id, "No matches found. Try /summary first.");
        return;
      }

      const list = categories
        .map(c => `${CATEGORY_ICONS[c] ?? "📌"} /matches\_${c}`)
        .join("\n");

      await bot!.sendMessage(msg.chat.id,
        `*Categories with availability matches:*

${list}`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const rows = await db
      .select()
      .from(availabilityMatches)
      .where(sql`${availabilityMatches.category} = ${category}`)
      .orderBy(availabilityMatches.day, availabilityMatches.hour);

    if (rows.length === 0) {
      await bot!.sendMessage(msg.chat.id,
        `No matches found for *${getCategoryLabel(category)}*.

Try /matches to see available categories.`,
        { parse_mode: "Markdown" }
      );
      return;
    }

    const icon = CATEGORY_ICONS[category] ?? "📌";
    let text = `${icon} *${getCategoryLabel(category)} — all slots*

`;

    // Group by day
    const byDay: Record<number, typeof rows> = {};
    for (const row of rows) {
      if (!byDay[row.day]) byDay[row.day] = [];
      byDay[row.day].push(row);
    }

    for (const day of [1, 2, 3, 4, 5, 6, 0]) { // Mon–Sun order
      if (!byDay[day]) continue;
      text += `*${DAYS[day]}*
`;
      const sorted = byDay[day].sort((a, b) => a.hour - b.hour);
      for (const slot of sorted) {
        const bar = "█".repeat(Math.min(slot.userIds.length, 10));
        const notifiedMark = slot.notified ? " ✓ notified" : "";
        text += `  ${fmtHour(slot.hour)}  ${bar} ${slot.userIds.length} users${notifiedMark}
`;
      }
      text += "\n";
    }

    text += `_/approve\_match ${category} <day 0-6> <hour> to notify hosts_`;

    await bot!.sendMessage(msg.chat.id, text, { parse_mode: "Markdown" });
  });

  // ── /runmatcher (admin) ───────────────────────────────────────────────────
  // Manually re-run the matcher and report how many matches were found.
  bot.onText(/\/runmatcher/, async (msg) => {
    const telegramId = String(msg.from?.id ?? msg.chat.id);
    if (telegramId !== process.env.ADMIN_TELEGRAM_ID) {
      await bot!.sendMessage(msg.chat.id, "⛔ Admin only command.");
      return;
    }

    await bot!.sendMessage(msg.chat.id, "⏳ Running availability matcher…");

    try {
      await runAvailabilityMatcher();
      const count = await db.$count(availabilityMatches);
      await bot!.sendMessage(msg.chat.id,
        `✅ Matcher complete — *${count}* active match${count !== 1 ? "es" : ""} found.

Use /summary for a full breakdown.`,
        { parse_mode: "Markdown" }
      );
    } catch (err: any) {
      await bot!.sendMessage(msg.chat.id, `❌ Matcher failed: ${err.message}`);
    }
  });

  console.log("[bot] Bot commands registered");
}
