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
import { users } from "@shared/schema";
import { isNotNull, sql } from "drizzle-orm";

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
      telegram_username:u.telegramUsername ?? null,
    }));

    return res.json({ data, total, limit, offset });
  } catch (err) {
    console.error("[language-exchange] GET /users error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
