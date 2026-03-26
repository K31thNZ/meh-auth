// server/matcher.ts
// Daily cron that finds groups of users with matching interests + availability.
// Runs at 09:00 Moscow time (06:00 UTC).
// Flow:
//   1. Find all users with at least one interest and at least one availability slot
//   2. Group by (interest, day, hour) — any slot with 3+ users is a "match"
//   3. Notify platform admin via Telegram
//   4. Admin reviews and can approve → organiser gets notified

import { db } from "./db";
import { users, availabilitySlots, availabilityMatches } from "@shared/schema";
import { eq, and, isNotNull, sql } from "drizzle-orm";
import { notifyAdminAvailabilityMatch } from "./bot";

const MIN_GROUP_SIZE = 3; // minimum users to trigger a match notification

export async function runAvailabilityMatcher(): Promise<void> {
  console.log("[matcher] Starting availability analysis...");

  try {
    // Get all users who have interests AND availability slots AND telegram
    const usersWithSlots = await db
      .select({
        userId: availabilitySlots.userId,
        day: availabilitySlots.day,
        hour: availabilitySlots.hour,
        interests: users.interests,
        telegramId: users.telegramId,
        displayName: users.displayName,
        username: users.username,
      })
      .from(availabilitySlots)
      .innerJoin(users, eq(availabilitySlots.userId, users.id));

    // Group by day + hour + each interest
    const groups: Map<string, {
      category: string;
      day: number;
      hour: number;
      userIds: number[];
    }> = new Map();

    for (const row of usersWithSlots) {
      if (!Array.isArray(row.interests) || row.interests.length === 0) continue;

      for (const interest of row.interests) {
        const key = `${interest}:${row.day}:${row.hour}`;
        const existing = groups.get(key);
        if (existing) {
          if (!existing.userIds.includes(row.userId)) {
            existing.userIds.push(row.userId);
          }
        } else {
          groups.set(key, {
            category: interest,
            day: row.day,
            hour: row.hour,
            userIds: [row.userId],
          });
        }
      }
    }

    // Find groups above threshold
    const matches = Array.from(groups.values())
      .filter(g => g.userIds.length >= MIN_GROUP_SIZE);

    console.log(`[matcher] Found ${matches.length} groups with ${MIN_GROUP_SIZE}+ users`);

    // Clear old unnotified matches before inserting new ones
    await db.delete(availabilityMatches);

    // Save new matches and notify admin
    for (const match of matches) {
      // Save to DB
      await db.insert(availabilityMatches).values({
        day: match.day,
        hour: match.hour,
        category: match.category,
        userIds: match.userIds,
        appScope: "expat",
        notified: false,
      }).onConflictDoNothing();

      // Notify admin via Telegram
      await notifyAdminAvailabilityMatch({
        category: match.category,
        day: match.day,
        hour: match.hour,
        userCount: match.userIds.length,
        userIds: match.userIds,
      });
    }

    console.log(`[matcher] Done — ${matches.length} matches processed`);
  } catch (err) {
    console.error("[matcher] Error during availability analysis:", err);
  }
}

// Schedule the cron — call this from server/index.ts
export function scheduleMatcher(): void {
  // Run immediately on startup (for testing), then every 24h
  const MOSCOW_OFFSET = 3 * 60; // UTC+3
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const moscowMinutes = (utcMinutes + MOSCOW_OFFSET) % (24 * 60);

  // Target: 09:00 Moscow = 06:00 UTC
  const targetUtcMinutes = 6 * 60;
  const msUntilTarget = ((targetUtcMinutes - (utcMinutes % (24 * 60)) + 24 * 60) % (24 * 60)) * 60 * 1000;

  console.log(`[matcher] Scheduled — next run in ${Math.round(msUntilTarget / 1000 / 60)} minutes`);

  setTimeout(() => {
    runAvailabilityMatcher();
    // Then repeat every 24 hours
    setInterval(runAvailabilityMatcher, 24 * 60 * 60 * 1000);
  }, msUntilTarget);
}
