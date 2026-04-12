// server/matcher.ts
// Finds groups of users with matching interests + availability.
//
// Two modes:
//   runAvailabilityMatcher()      — full scan, run daily at 09:00 Moscow time
//   runIncrementalMatcher(userId) — checks only the slots/interests of one user
//                                   after they update their profile; fires admin
//                                   notifications for any NEW matches found

import { db } from "./db";
import { users, availabilitySlots, availabilityMatches } from "@shared/schema";
import { eq, and, isNotNull, sql, inArray } from "drizzle-orm";
import { notifyAdminAvailabilityMatch } from "./bot";

// ── Threshold ─────────────────────────────────────────────────────────────
// Notify admin when 2 or more users share the same interest + day + hour.
const MIN_GROUP_SIZE = 2;

// ── Full matcher ──────────────────────────────────────────────────────────
export async function runAvailabilityMatcher(): Promise<void> {
  console.log("[matcher] Starting full availability analysis…");
  try {
    const usersWithSlots = await db
      .select({
        userId:      availabilitySlots.userId,
        day:         availabilitySlots.day,
        hour:        availabilitySlots.hour,
        interests:   users.interests,
      })
      .from(availabilitySlots)
      .innerJoin(users, eq(availabilitySlots.userId, users.id));

    const groups = buildGroups(usersWithSlots);
    const matches = Array.from(groups.values())
      .filter(g => g.userIds.length >= MIN_GROUP_SIZE);

    console.log(`[matcher] Found ${matches.length} group(s) with ${MIN_GROUP_SIZE}+ users`);

    // Replace old unnotified matches with fresh data
    await db.delete(availabilityMatches);

    for (const match of matches) {
      await db.insert(availabilityMatches).values({
        day:      match.day,
        hour:     match.hour,
        category: match.category,
        userIds:  match.userIds,
        appScope: "expat",
        notified: false,
      }).onConflictDoNothing();

      await notifyAdminAvailabilityMatch({
        category:  match.category,
        day:       match.day,
        hour:      match.hour,
        userCount: match.userIds.length,
        userIds:   match.userIds,
      });
    }

    console.log(`[matcher] Done — ${matches.length} matches processed`);
  } catch (err) {
    console.error("[matcher] Error during full analysis:", err);
  }
}

// ── Incremental matcher ───────────────────────────────────────────────────
// Called immediately after a single user updates their profile.
// Only checks slots belonging to that user against all other users.
// Sends admin a notification for each NEW match (not already in the DB).
// Does NOT delete existing matches — only adds new ones.
export async function runIncrementalMatcher(userId: number): Promise<void> {
  console.log(`[matcher] Incremental run for user ${userId}`);
  try {
    // Get the updated user's slots and interests
    const [updatedUser] = await db
      .select({ interests: users.interests })
      .from(users)
      .where(eq(users.id, userId));

    if (!updatedUser?.interests?.length) return;

    const userSlots = await db
      .select({ day: availabilitySlots.day, hour: availabilitySlots.hour })
      .from(availabilitySlots)
      .where(eq(availabilitySlots.userId, userId));

    if (!userSlots.length) return;

    // For each of this user's (interest, day, hour) combinations,
    // count how many OTHER users share the same combination.
    for (const interest of updatedUser.interests) {
      for (const slot of userSlots) {
        // Find other users who have this interest AND this slot
        const overlapping = await db
          .select({ userId: availabilitySlots.userId })
          .from(availabilitySlots)
          .innerJoin(users, eq(availabilitySlots.userId, users.id))
          .where(
            and(
              eq(availabilitySlots.day, slot.day),
              eq(availabilitySlots.hour, slot.hour),
              sql`${interest} = ANY(${users.interests})`,
              // Exclude the user who just updated
              sql`${availabilitySlots.userId} != ${userId}`
            )
          );

        const allUserIds = [userId, ...overlapping.map(r => r.userId)];

        if (allUserIds.length < MIN_GROUP_SIZE) continue;

        // Check if this exact match already exists in the DB
        const [existing] = await db
          .select({ id: availabilityMatches.id, notified: availabilityMatches.notified })
          .from(availabilityMatches)
          .where(
            and(
              eq(availabilityMatches.category, interest),
              eq(availabilityMatches.day, slot.day),
              eq(availabilityMatches.hour, slot.hour)
            )
          );

        if (existing) {
          // Match already known — update userIds if this user is new to it
          const existingMatch = await db
            .select()
            .from(availabilityMatches)
            .where(eq(availabilityMatches.id, existing.id));

          const knownIds: number[] = existingMatch[0]?.userIds ?? [];
          if (!knownIds.includes(userId)) {
            const updatedIds = [...new Set([...knownIds, userId])];
            await db
              .update(availabilityMatches)
              .set({ userIds: updatedIds, notified: false })
              .where(eq(availabilityMatches.id, existing.id));

            // Notify admin of the updated count
            await notifyAdminAvailabilityMatch({
              category:  interest,
              day:       slot.day,
              hour:      slot.hour,
              userCount: updatedIds.length,
              userIds:   updatedIds,
            });
          }
        } else {
          // Brand new match — insert and notify admin
          await db.insert(availabilityMatches).values({
            day:      slot.day,
            hour:     slot.hour,
            category: interest,
            userIds:  allUserIds,
            appScope: "expat",
            notified: false,
          });

          await notifyAdminAvailabilityMatch({
            category:  interest,
            day:       slot.day,
            hour:      slot.hour,
            userCount: allUserIds.length,
            userIds:   allUserIds,
          });
        }
      }
    }

    console.log(`[matcher] Incremental run complete for user ${userId}`);
  } catch (err) {
    console.error(`[matcher] Incremental error for user ${userId}:`, err);
  }
}

// ── Shared helper ─────────────────────────────────────────────────────────
function buildGroups(rows: {
  userId: number;
  day: number;
  hour: number;
  interests: string[] | null;
}[]): Map<string, { category: string; day: number; hour: number; userIds: number[] }> {
  const groups = new Map<string, { category: string; day: number; hour: number; userIds: number[] }>();

  for (const row of rows) {
    if (!Array.isArray(row.interests) || row.interests.length === 0) continue;
    for (const interest of row.interests) {
      const key = `${interest}:${row.day}:${row.hour}`;
      const existing = groups.get(key);
      if (existing) {
        if (!existing.userIds.includes(row.userId)) existing.userIds.push(row.userId);
      } else {
        groups.set(key, { category: interest, day: row.day, hour: row.hour, userIds: [row.userId] });
      }
    }
  }

  return groups;
}

// ── Scheduler ─────────────────────────────────────────────────────────────
export function scheduleMatcher(): void {
  const TARGET_UTC_HOUR = 6; // 09:00 Moscow (UTC+3)
  const now = new Date();
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const targetUtcMinutes = TARGET_UTC_HOUR * 60;
  const msUntilTarget = ((targetUtcMinutes - utcMinutes + 24 * 60) % (24 * 60)) * 60 * 1000;

  console.log(`[matcher] Daily run scheduled in ${Math.round(msUntilTarget / 1000 / 60)} minutes`);

  setTimeout(() => {
    runAvailabilityMatcher();
    setInterval(runAvailabilityMatcher, 24 * 60 * 60 * 1000);
  }, msUntilTarget);
}
