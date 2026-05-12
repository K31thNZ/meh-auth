// server/telegram-link.ts
import { bot } from "./bot";                // grammy bot instance
import { db } from "./db";
import { users, telegramLinkTokens } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";

export async function handleTelegramStartToken(chatId: string, token: string) {
  const [linkToken] = await db.select().from(telegramLinkTokens).where(
    and(eq(telegramLinkTokens.token, token), isNull(telegramLinkTokens.used))
  );

  if (!linkToken || linkToken.expiresAt < new Date()) {
    throw new Error("Token invalid or expired");
  }

  // Mark token as used
  await db.update(telegramLinkTokens)
    .set({ used: true })
    .where(eq(telegramLinkTokens.token, token));

  // Link the Telegram ID to the user
  await db.update(users)
    .set({ telegramId: chatId })
    .where(eq(users.id, linkToken.userId));

  // Send confirmation via grammy
  await bot.api.sendMessage(chatId, "✅ Your Telegram account has been linked!");
}

export function registerTelegramLinkRoutes(app: any) {
  // No routes needed – linking is handled inside /start
}
