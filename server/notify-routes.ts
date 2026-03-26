// server/notify-routes.ts
// Routes called by Event-Hub (and future hubs) after events are published.
// Also exposes admin routes for availability match management.

import type { Express } from "express";
import { requireAuth, requireAdmin } from "./auth";
import { notifyMatchingUsers, notifyOrganiserDemand } from "./bot";
import { storage } from "./storage";
import { db } from "./db";
import { availabilityMatches, hosts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { runAvailabilityMatcher } from "./matcher";
import { z } from "zod";

const notifyEventSchema = z.object({
  id:           z.number(),
  title:        z.string(),
  category:     z.string(),
  date:         z.coerce.date(),
  venueCity:    z.string(),
  venueAddress: z.string(),
  description:  z.string(),
});

// Shared secret — Event-Hub sets this header so only trusted callers can notify
function validateServiceSecret(req: any, res: any): boolean {
  const secret = process.env.SERVICE_SECRET;
  if (!secret) return true; // if not set, allow (dev mode)
  if (req.headers["x-service-secret"] !== secret) {
    res.status(403).json({ error: "Invalid service secret" });
    return false;
  }
  return true;
}

export function registerNotifyRoutes(app: Express) {

  // ── POST /api/notify/event ────────────────────────────────────────────────
  // Called by Event-Hub after an event is published.
  // Finds users whose interests match the event category and sends:
  //   - In-app notification (stored in notifications table)
  //   - Telegram message (if user has telegramId)
  app.post("/api/notify/event", async (req, res) => {
    if (!validateServiceSecret(req, res)) return;

    try {
      const event = notifyEventSchema.parse(req.body);
      const result = await notifyMatchingUsers(event);
      res.json({ ok: true, ...result });
    } catch (err: any) {
      if (err?.name === "ZodError") {
        return res.status(400).json({ error: "Invalid event data", details: err.errors });
      }
      console.error("[notify] Error:", err);
      res.status(500).json({ error: "Notification failed" });
    }
  });

  // ── GET /api/admin/availability-matches ───────────────────────────────────
  // Returns all availability matches for the admin to review.
  // Admin sees: category, day, hour, how many users, whether notified.
  app.get("/api/admin/availability-matches", requireAdmin, async (req, res) => {
    try {
      const matches = await db.select().from(availabilityMatches);
      res.json(matches);
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch matches" });
    }
  });

  // ── POST /api/admin/availability-matches/:id/approve ─────────────────────
  // Admin approves a match and selects which organiser to notify.
  // Body: { organiserId: number }
  app.post("/api/admin/availability-matches/:id/approve", requireAdmin, async (req, res) => {
    try {
      const matchId = parseInt(req.params.id);
      const { organiserId } = req.body;

      if (!organiserId) {
        return res.status(400).json({ error: "organiserId required" });
      }

      // Get the match
      const [match] = await db
        .select()
        .from(availabilityMatches)
        .where(eq(availabilityMatches.id, matchId));

      if (!match) return res.status(404).json({ error: "Match not found" });

      // Notify the organiser
      await notifyOrganiserDemand(organiserId, {
        category: match.category,
        day: match.day,
        hour: match.hour,
        userCount: match.userIds.length,
      });

      // Mark as notified
      await db
        .update(availabilityMatches)
        .set({ notified: true })
        .where(eq(availabilityMatches.id, matchId));

      res.json({ ok: true });
    } catch (err) {
      console.error("[notify] Approve error:", err);
      res.status(500).json({ error: "Failed to approve match" });
    }
  });

  // ── POST /api/admin/run-matcher ───────────────────────────────────────────
  // Manually trigger the availability matcher (useful for testing).
  app.post("/api/admin/run-matcher", requireAdmin, async (req, res) => {
    try {
      await runAvailabilityMatcher();
      res.json({ ok: true, message: "Matcher ran successfully" });
    } catch (err) {
      res.status(500).json({ error: "Matcher failed" });
    }
  });

  // ── GET /api/admin/telegram-stats ─────────────────────────────────────────
  // How many users have Telegram connected, breakdown by interest.
  app.get("/api/admin/telegram-stats", requireAdmin, async (req, res) => {
    try {
      const allUsers = await storage.getUsersWithTelegramId();
      const interestCounts: Record<string, number> = {};

      for (const user of allUsers) {
        for (const interest of user.interests ?? []) {
          interestCounts[interest] = (interestCounts[interest] ?? 0) + 1;
        }
      }

      res.json({
        totalConnected: allUsers.length,
        byInterest: interestCounts,
      });
    } catch (err) {
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });
}
