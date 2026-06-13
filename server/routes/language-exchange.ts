// server/routes/language-exchange.ts
//
// GET /api/language-exchange/users
//   Returns public profiles of users who have set a native language.
//   Used by Event-Hub's LanguageExchange page to show real members.
//
// Query params (all optional):
//   language   – ISO 639-1 code; matches native OR learning languages
//   city       – exact city name (case-insensitive)
//   ageGroup   – one of: 18-25 | 26-35 | 36-45 | 46+
//   meetingType – one of: 1on1 | small_group | social
//   interest   – category value (e.g. "music")
//   limit      – max results (default 50, max 200)
//   offset     – pagination offset (default 0)

import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, availabilitySlots } from "@shared/schema";
import { isNotNull, sql, eq } from "drizzle-orm";

const router = Router();

// Only these fields are exposed publicly — no emails, passwords, OAuth IDs, etc.
const PUBLIC_FIELDS = {
  id:               users.id,
  displayName:      users.displayName,
  avatarUrl:        users.avatarUrl,
  city:             users.city,
  myAgeGroup:       users.myAgeGroup,
  nativeLanguage:   users.nativeLanguage,
  learningLanguages:users.learningLanguages,
  interests:        users.interests,
  meetingTypes:     users.meetingTypes,
  bio:              users.bio,
  telegramUsername: users.telegramUsername,
  leHidden:         users.leHidden,
  lastSeenAt:       users.lastSeenAt,     // Task 4
} as const;

router.get("/users", async (req: Request, res: Response) => {
  try {
    const {
      language,
      city,
      ageGroup,
      meetingType,
      interest,
      limit:   limitStr  = "50",
      offset:  offsetStr = "0",
    } = req.query as Record<string, string | undefined>;

    const limit  = Math.min(200, Math.max(1, parseInt(limitStr  ?? "50",  10) || 50));
    const offset =                           parseInt(offsetStr ?? "0",   10) || 0;

    // Fetch users who have set a native language (opted into matching)
    // and are not blocked
    let rows = await db
      .select(PUBLIC_FIELDS)
      .from(users)
      .where(isNotNull(users.nativeLanguage))
      .limit(500); // fetch generous pool then filter in JS (avoids complex jsonb SQL)

    // Filter: hidden-by-admin users never appear in public listing
    rows = rows.filter(u => !u.leHidden);

    // Filter: language — matches native OR any learning language code
    if (language) {
      rows = rows.filter(u => {
        const native   = u.nativeLanguage === language;
        const learning = Array.isArray(u.learningLanguages) &&
          u.learningLanguages.some((l: { code: string }) => l.code === language);
        return native || learning;
      });
    }

    // Filter: city (case-insensitive)
    if (city && city !== "all") {
      const lc = city.toLowerCase();
      rows = rows.filter(u => u.city?.toLowerCase() === lc);
    }

    // Filter: age group
    if (ageGroup && ageGroup !== "all") {
      rows = rows.filter(u => u.myAgeGroup === ageGroup);
    }

    // Filter: meeting type
    if (meetingType && meetingType !== "all") {
      rows = rows.filter(u =>
        Array.isArray(u.meetingTypes) && u.meetingTypes.includes(meetingType)
      );
    }

    // Filter: interest
    if (interest && interest !== "all") {
      rows = rows.filter(u =>
        Array.isArray(u.interests) && u.interests.includes(interest)
      );
    }

    // Total before pagination
    const total = rows.length;

    // Paginate
    const page = rows.slice(offset, offset + limit);

    // Shape the response — never expose nulls for arrays
    const data = page.map(u => ({
      id:               u.id,
      full_name:        u.displayName ?? "Anonymous",
      avatar_url:       u.avatarUrl   ?? "",
      city:             u.city        ?? "",
      age_group:        u.myAgeGroup  ?? "",
      native:           u.nativeLanguage ? [u.nativeLanguage] : [],
      learning:         Array.isArray(u.learningLanguages) ? u.learningLanguages : [],
      interests:        Array.isArray(u.interests)         ? u.interests         : [],
      meeting_types:    Array.isArray(u.meetingTypes)      ? u.meetingTypes      : [],
      bio:              u.bio ?? "",
      telegram_username: u.telegramUsername ?? null,
      last_seen_at:      u.lastSeenAt ? u.lastSeenAt.toISOString() : null,  // Task 4
    }));

    return res.json({ data, total, limit, offset });
  } catch (err) {
    console.error("[language-exchange] GET /users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});


// ── POST /api/language-exchange/spark ────────────────────────────────────────
// Logged-in user sends a language-exchange spark invitation to another user.
// - Both parties receive a Telegram message if they have telegram_id set.
// - Returns { ok: true, senderHasTelegram, recipientHasTelegram }

router.post("/spark", async (req: Request, res: Response) => {
  const currentUser = (req as any).user;
  if (!currentUser) return res.status(401).json({ error: "Not authenticated" });

  const { recipientId, availableTimes, suggestedEvent } = req.body as {
    recipientId:     number;
    availableTimes?: string[];   // ISO strings of suggested slots (optional)
    suggestedEvent?: {           // Task 2 — event suggestion from SuggestEventDialog
      id:    number;
      title: string;
      date:  string;
      city:  string;
      url:   string;
    } | null;
  };

  if (!recipientId || isNaN(Number(recipientId))) {
    return res.status(400).json({ error: "recipientId required" });
  }
  if (currentUser.id === Number(recipientId)) {
    return res.status(400).json({ error: "Cannot spark yourself" });
  }

  try {
    // Fetch both users
    const [sender, recipient] = await Promise.all([
      db.select({
        id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl,
        city: users.city, nativeLanguage: users.nativeLanguage,
        learningLanguages: users.learningLanguages, bio: users.bio,
        telegramId: users.telegramId, telegramUsername: users.telegramUsername,
        leHidden: users.leHidden, blocked: users.blocked,
      }).from(users).where(eq(users.id, currentUser.id)).limit(1),

      db.select({
        id: users.id, displayName: users.displayName, avatarUrl: users.avatarUrl,
        city: users.city, nativeLanguage: users.nativeLanguage,
        learningLanguages: users.learningLanguages, bio: users.bio,
        telegramId: users.telegramId, telegramUsername: users.telegramUsername,
        leHidden: users.leHidden, blocked: users.blocked,
      }).from(users).where(eq(users.id, Number(recipientId))).limit(1),
    ]);

    if (!sender[0]) return res.status(404).json({ error: "Sender not found" });
    if (!recipient[0]) return res.status(404).json({ error: "Recipient not found" });
    if (recipient[0].leHidden || recipient[0].blocked) {
      return res.status(403).json({ error: "This profile is not available" });
    }

    const s = sender[0];
    const r = recipient[0];

    // ── Format a profile summary for the message ──────────────────────────
    function profileSummary(u: typeof s): string {
      const langs = [
        u.nativeLanguage ? `🗣 Native: ${u.nativeLanguage}` : null,
        Array.isArray(u.learningLanguages) && u.learningLanguages.length > 0
          ? `📖 Learning: ${(u.learningLanguages as any[]).map((l: any) => l.code ?? l).join(", ")}`
          : null,
        u.city ? `📍 ${u.city}` : null,
        u.bio ? `💬 "${u.bio}"` : null,
      ].filter(Boolean);
      return langs.join("\n");
    }

    // ── Format suggested times ─────────────────────────────────────────────
    function formatTimes(slots?: string[]): string {
      if (!slots || slots.length === 0) return "";
      const formatted = slots.map(s => {
        try {
          return new Intl.DateTimeFormat("en-GB", {
            weekday: "short", day: "numeric", month: "short",
            hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow",
          }).format(new Date(s));
        } catch { return s; }
      });
      return "\n\n🕐 *Suggested times (Moscow):*\n" + formatted.map(t => `  • ${t}`).join("\n");
    }

    // ── Format suggested event (Task 2) ────────────────────────────────────
    function formatEvent(ev: typeof suggestedEvent): string {
      if (!ev) return "";
      try {
        const dateStr = new Intl.DateTimeFormat("en-GB", {
          weekday: "short", day: "numeric", month: "short",
          hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow",
        }).format(new Date(ev.date));
        return `\n\n📅 *Suggested event:*\n[${ev.title}](${ev.url})\n${dateStr}${ev.city ? ` · ${ev.city}` : ""}`;
      } catch { return ""; }
    }

    const timesStr    = formatTimes(availableTimes);
    const eventStr    = formatEvent(suggestedEvent);
    const senderProfile  = profileSummary(s);
    const botUsername = process.env.BOT_USERNAME ?? "expatevents_bot";

    // ── Message to recipient ───────────────────────────────────────────────
    const recipientMsg = [
      `⚡ *Language Exchange Match!*`,
      ``,
      `*${s.displayName ?? "Someone"}* wants to practice languages with you!`,
      ``,
      senderProfile,
      timesStr,
      eventStr,           // Task 2 — suggested event block
      ``,
      `${s.telegramUsername ? `💬 Reply to them: @${s.telegramUsername}` : `📲 [Open the app to connect](https://expatevents.org/language-exchange)`}`,
      ``,
      `_Tap to reply, or visit the Language Exchange directory._`,
    ].filter(l => l !== undefined).join("\n");

    // ── Message to sender (confirmation) ──────────────────────────────────
    const senderConfirmMsg = [
      `✅ *Spark sent to ${r.displayName ?? "your match"}!*`,
      ``,
      profileSummary(r),
      timesStr,
      eventStr,           // Task 2
      ``,
      r.telegramUsername
        ? `💬 You can also message them directly: @${r.telegramUsername}`
        : `_They haven't connected Telegram yet — we've notified them via the app._`,
      ``,
      `_Good luck with your language exchange! 🌍_`,
    ].filter(l => l !== undefined).join("\n");

    let senderHasTelegram   = false;
    let recipientHasTelegram = false;

    // ── Send Telegram messages ─────────────────────────────────────────────
    const { sendToUser } = await import("../bot");

    if (r.telegramId) {
      recipientHasTelegram = true;
      await sendToUser(r.telegramId, recipientMsg);
    }

    if (s.telegramId) {
      senderHasTelegram = true;
      await sendToUser(s.telegramId, senderConfirmMsg);
    }

    return res.json({
      ok: true,
      senderHasTelegram,
      recipientHasTelegram,
      recipientName: r.displayName ?? "your match",
    });

  } catch (err) {
    console.error("[language-exchange] POST /spark error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── GET /api/language-exchange/users/:id/availability ─────────────────────────
// Task 3 (Spec Batch 1): Returns public availability slots for a given user so
// the Spark dialog can show a read-only heat-map of "when this person is free."
// Auth required (to prevent public enumeration), but any authenticated user can
// query any other user's slots.

router.get("/users/:id/availability", requireAuth, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (isNaN(targetId)) return res.status(400).json({ error: "Invalid user id" });

    const slots = await db
      .select({ day: availabilitySlots.day, hour: availabilitySlots.hour })
      .from(availabilitySlots)
      .where(eq(availabilitySlots.userId, targetId));

    return res.json({ slots });
  } catch (err) {
    console.error("[language-exchange] GET /users/:id/availability error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
