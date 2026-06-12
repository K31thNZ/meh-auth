// server/notify-routes.ts
// Routes called by Event-Hub (and future hubs) after events are published.
// Also exposes admin routes for availability match management.

import type { Express } from "express";
import { requireAuth, requireAdmin } from "./auth";
import { notifyMatchingUsers, notifyOrganiserDemand, sendToUser, EventData } from "./bot"; // new import
import { storage } from "./storage";
import { db } from "./db";
import { availabilityMatches, hosts, users } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { runAvailabilityMatcher, runIncrementalMatcher } from "./matcher";
import { z } from "zod";

const notifyEventSchema = z.object({
  id:           z.number(),
  title:        z.string(),
  category:     z.string(),
  date:         z.coerce.date(),
  venueCity:    z.string(),
  venueAddress: z.string(),
  locationName: z.string().optional().nullable(),
  description:  z.string(),
  organizerId:  z.number().optional(),   // new
  imageUrl:     z.string().url().optional(), // new
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
      const raw = notifyEventSchema.parse(req.body);

      // Fetch organiser's Telegram ID if an organiser user ID is provided
      let organizerTelegramId: string | undefined;
      if (raw.organizerId) {
        const [orgUser] = await db
          .select({ telegramId: users.telegramId })
          .from(users)
          .where(eq(users.id, raw.organizerId));
        organizerTelegramId = orgUser?.telegramId ?? undefined;
      }

      const event: EventData = {
        id: raw.id,
        title: raw.title,
        category: raw.category,
        date: raw.date,
        venueCity: raw.venueCity,
        venueAddress: raw.venueAddress,
        locationName: raw.locationName,
        description: raw.description,
        organizerId: raw.organizerId ? String(raw.organizerId) : undefined,
        organizerTelegramId,
        imageUrl: raw.imageUrl,
      };

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

  // ── POST /api/notify/send ────────────────────────────────────────────────
  // Sends a Telegram message to a specific user identified by their meh-auth
  // numeric user ID. Used by expatevents for ticket reminders and any other
  // per-user notifications where the sender knows the user ID.
  // Body: { userId: string | number, message: string }
  app.post("/api/notify/send", async (req, res) => {
    if (!validateServiceSecret(req, res)) return;

    const { userId, message } = req.body;

    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    try {
      const [user] = await db
        .select({ telegramId: users.telegramId })
        .from(users)
        .where(eq(users.id, Number(userId)));

      if (!user?.telegramId) {
        // User exists but has no Telegram connected — not an error, just skip
        return res.json({ ok: true, sent: false, reason: "no_telegram" });
      }

      const ok = await sendToUser(user.telegramId, message);
      res.json({ ok: true, sent: ok });
    } catch (err: any) {
      console.error("[notify/send]", err.message);
      res.status(500).json({ error: "Failed to send message" });
    }
  });

  // ── POST /api/notify/profile-updated ─────────────────────────────────────
  // Called after a user saves interests or availability slots.
  // Body: { userId: number }
  //
  // If userId is provided → runs the fast incremental matcher for that user
  // only, checking their new slots against all others and notifying admin of
  // any new matches in real time.
  //
  // Falls back to the full scan if no userId is given.
  // Always responds immediately — matcher runs in the background.
  app.post("/api/notify/profile-updated", async (req, res) => {
    if (!validateServiceSecret(req, res)) return;

    const userId = typeof req.body?.userId === "number" ? req.body.userId : null;

    // Respond before the matcher runs so the user's profile save isn't delayed
    res.json({ ok: true, message: userId ? "Incremental matcher queued" : "Full matcher queued" });

    setImmediate(async () => {
      try {
        if (userId) {
          await runIncrementalMatcher(userId);
        } else {
          await runAvailabilityMatcher();
        }
        console.log(`[notify] Profile-triggered matcher complete (userId: ${userId ?? "full"})`);
      } catch (err: any) {
        console.error("[notify] Profile-triggered matcher failed:", err.message);
      }
    });
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

      const [match] = await db
        .select()
        .from(availabilityMatches)
        .where(eq(availabilityMatches.id, matchId));

      if (!match) return res.status(404).json({ error: "Match not found" });

      await notifyOrganiserDemand(organiserId, {
        category: match.category,
        day: match.day,
        hour: match.hour,
        userCount: match.userIds.length,
      });

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

  // ── POST /api/internal/send-message ──────────────────────────────────────
  // Called by expatevents to deliver a Telegram message to a user by their
  // meh-auth numeric userId. Used for ticket reminders and other expatevents
  // notifications that need to reach the user's Telegram.
  // Body: { userId: number, message: string }
  app.post("/api/internal/send-message", async (req, res) => {
    if (!validateServiceSecret(req, res)) return;

    const { userId, message } = req.body;
    if (!userId || !message) {
      return res.status(400).json({ error: "userId and message are required" });
    }

    try {
      const [user] = await db
        .select({ telegramId: users.telegramId })
        .from(users)
        .where(eq(users.id, Number(userId)));

      if (!user?.telegramId) {
        return res.json({ ok: false, reason: "no_telegram" });
      }

      const sent = await sendToUser(user.telegramId, message);
      res.json({ ok: sent });
    } catch (err: any) {
      console.error("[send-message]", err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/notify/rsvp ─────────────────────────────────────────────────
  // Called by Event-Hub when a user RSVPs via the web/mini-app.
  // Triggers the bot to notify the event organiser.
  // Body: { eventId, userId, status, going, maybe }
  app.post("/api/notify/rsvp", async (req, res) => {
    if (!validateServiceSecret(req, res)) return;

    // A3 fix: ticketCount now forwarded from Event-Hub so the organiser notification
    //         shows the real ticket count instead of always 0.
    const { eventId, userId, status, going = 0, maybe = 0, ticketCount = 0 } = req.body;
    if (!eventId || !userId || !status) {
      return res.status(400).json({ error: "eventId, userId, status are required" });
    }

    try {
      // Fire the organiser notification via the bot (non-blocking)
      const { notifyOrganiserRsvp } = await import("./bot");
      const counts = { going: Number(going), maybe: Number(maybe), no: 0 };
      notifyOrganiserRsvp(
        Number(eventId),
        status === "going" ? "going" : "maybe",
        counts,
        { count: Number(ticketCount), buyers: [] },
      ).catch((err: any) => console.warn("[notify/rsvp] organiser notify failed:", err?.message));

      res.json({ ok: true });
    } catch (err: any) {
      console.error("[POST /api/notify/rsvp]", err);
      res.status(500).json({ error: err.message ?? "Failed to trigger RSVP notification" });
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
