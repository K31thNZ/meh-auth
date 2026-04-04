// server/telegram-link.ts
// Telegram deep link account linking via /start token flow.
//
// Flow:
//   1. User clicks "Connect Telegram" on their profile page
//   2. Profile page calls POST /api/telegram/link-token → gets a secure token
//   3. Backend returns a deep link: https://t.me/BOT_NAME?start=TOKEN
//   4. User taps the link → opens Telegram → bot receives /start TOKEN
//   5. Bot looks up the token, links the user's telegramId to their account
//   6. Bot sends confirmation message, token is deleted

import type { Express } from "express";
import { randomUUID } from "crypto";
import { db } from "./db";
import { users, telegramLinkTokens } from "@shared/schema";
import { eq, lt, and } from "drizzle-orm";
import { getBot } from "./bot";

const TOKEN_EXPIRY_MS = 20 * 60 * 1000; // 20 minutes
const BOT_NAME = process.env.TELEGRAM_BOT_NAME ?? "";

// ── Rate limit: max 3 token requests per user per hour ─────────────────────
const rateLimitMap = new Map<number, number[]>();

function checkRateLimit(userId: number): boolean {
  const now = Date.now();
  const window = 60 * 60 * 1000; // 1 hour
  const timestamps = (rateLimitMap.get(userId) ?? []).filter(t => now - t < window);
  if (timestamps.length >= 3) return false;
  timestamps.push(now);
  rateLimitMap.set(userId, timestamps);
  return true;
}

// ── API routes ──────────────────────────────────────────────────────────────
export function registerTelegramLinkRoutes(app: Express) {

  // POST /api/telegram/link-token
  // Authenticated user requests a linking token.
  // Returns the deep link URL to open in Telegram.
  app.post("/api/telegram/link-token", async (req: any, res) => {
    const userId = req.user?.id ?? req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    if (!checkRateLimit(userId)) {
      return res.status(429).json({ error: "Too many requests. Please wait before trying again." });
    }

    if (!BOT_NAME) {
      return res.status(503).json({ error: "Telegram bot not configured" });
    }

    try {
      // Delete any existing unused tokens for this user
      await db.delete(telegramLinkTokens)
        .where(eq(telegramLinkTokens.userId, userId));

      // Generate a new secure token
      const token = randomUUID().replace(/-/g, ""); // 32 hex chars, no dashes (Telegram start param limit)
      const expiresAt = new Date(Date.now() + TOKEN_EXPIRY_MS);

      await db.insert(telegramLinkTokens).values({
        token,
        userId,
        expiresAt,
        used: false,
      });

      const deepLink = `https://t.me/${BOT_NAME}?start=${token}`;

      res.json({
        deepLink,
        expiresIn: TOKEN_EXPIRY_MS / 1000, // seconds
      });
    } catch (err: any) {
      console.error("[telegram-link] Token generation error:", err.message);
      res.status(500).json({ error: "Failed to generate link token" });
    }
  });

  // GET /api/telegram/status
  // Returns whether the current user has Telegram connected.
  app.get("/api/telegram/status", async (req: any, res) => {
    const userId = req.user?.id ?? req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      const [user] = await db.select({ telegramId: users.telegramId })
        .from(users)
        .where(eq(users.id, userId));

      res.json({ connected: !!user?.telegramId });
    } catch (err) {
      res.status(500).json({ error: "Failed to check status" });
    }
  });

  // POST /api/telegram/unlink
  // Removes the Telegram link from the user's account.
  app.post("/api/telegram/unlink", async (req: any, res) => {
    const userId = req.user?.id ?? req.session?.userId;
    if (!userId) return res.status(401).json({ error: "Not authenticated" });

    try {
      await db.update(users)
        .set({ telegramId: null })
        .where(eq(users.id, userId));

      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to unlink Telegram" });
    }
  });
}

// ── Bot /start handler with token ───────────────────────────────────────────
// Called from bot.ts when /start TOKEN is received.
export async function handleTelegramStartToken(
  chatId: number,
  telegramId: string,
  token: string,
  firstName: string
): Promise<void> {
  const bot = getBot();
  if (!bot) return;

  // Clean expired tokens first
  await db.delete(telegramLinkTokens)
    .where(lt(telegramLinkTokens.expiresAt, new Date()));

  // Look up the token
  const [linkToken] = await db.select()
    .from(telegramLinkTokens)
    .where(
      and(
        eq(telegramLinkTokens.token, token),
        eq(telegramLinkTokens.used, false)
      )
    );

  if (!linkToken) {
    await bot.sendMessage(chatId,
      "This link has expired or already been used.\n\n" +
      "Go to your profile page and tap Connect Telegram to get a new link."
    );
    return;
  }

  // Idempotency: check if this Telegram account is already linked to THIS user
  const [existingUser] = await db.select()
    .from(users)
    .where(eq(users.id, linkToken.userId));

  if (existingUser?.telegramId === telegramId) {
    await db.delete(telegramLinkTokens)
      .where(eq(telegramLinkTokens.token, token));

    await bot.sendMessage(chatId,
      `Your Telegram is already connected to your ExpatEvents account, ${firstName}!`,
      { parse_mode: "Markdown" }
    );
    return;
  }

  // Mark token as used (idempotency) then delete it
  await db.update(telegramLinkTokens)
    .set({ used: true })
    .where(eq(telegramLinkTokens.token, token));

  await db.delete(telegramLinkTokens)
    .where(eq(telegramLinkTokens.token, token));

  // Link the Telegram ID to the user account
  await db.update(users)
    .set({ telegramId })
    .where(eq(users.id, linkToken.userId));

  const [user] = await db.select()
    .from(users)
    .where(eq(users.id, linkToken.userId));

  const interestCount = Array.isArray(user?.interests) ? user.interests.length : 0;

  await bot.sendMessage(chatId,
    `*Connected!* Your Telegram is now linked to your ExpatEvents account.\n\n` +
    `You'll receive notifications for events matching your interests.\n\n` +
    `${interestCount > 0
      ? `Your current interests: ${(user.interests as string[]).join(", ")}`
      : `You haven't set any interests yet — visit your profile to choose what events you want to hear about.`
    }\n\n` +
    `[Update your profile](https://expatevents.org/profile)`,
    { parse_mode: "Markdown" }
  );

  console.log(`[telegram-link] User ${linkToken.userId} linked Telegram ${telegramId}`);
}
