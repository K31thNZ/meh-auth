// server/routes/match-profile.ts
//
// GET  /api/user/match-profile  — returns the current user's match profile
// PATCH /api/user/match-profile  — updates native language, learning languages,
//                                  and/or metro station
//
// Mount in your main router with:
//   import matchProfileRouter from "./routes/match-profile";
//   app.use("/api/user", matchProfileRouter);

import { Router, Request, Response } from "express";
import { db } from "../db";
import { users, type LanguageEntry, type ProficiencyLevel } from "@shared/schema";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";

const router = Router();

// ── Auth guard ────────────────────────────────────────────────────────────────
// Matches the pattern used by your other /api/user/* routes.
// req.user is populated by your session middleware (Passport / express-session).
function requireAuth(req: Request, res: Response, next: Function) {
  if (!req.user) return res.status(401).json({ error: "Not authenticated" });
  next();
}

// ── Validation helpers ────────────────────────────────────────────────────────

const VALID_LANGUAGE_CODES = new Set([
  "en","ru","de","fr","es","it","pt","nl","pl","sv",
  "no","da","fi","cs","sk","hu","ro","uk","ar","zh",
  "ja","ko","hi","fa","tr","he","el","id","th","vi",
]);

const VALID_PROFICIENCY: Set<ProficiencyLevel> = new Set([
  "A1","A2","B1","B2","C1","C2",
]);

function isValidLanguageEntry(entry: unknown): entry is LanguageEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    typeof e.code === "string" &&
    VALID_LANGUAGE_CODES.has(e.code) &&
    typeof e.proficiency === "string" &&
    VALID_PROFICIENCY.has(e.proficiency as ProficiencyLevel)
  );
}

// ── GET /api/user/match-profile ───────────────────────────────────────────────

router.get("/match-profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as { id: number }).id;

    const [row] = await db
      .select({
        nativeLanguage:    users.nativeLanguage,
        learningLanguages: users.learningLanguages,
        metroStation:      users.metroStation,
      })
      .from(users)
      .where(eq(users.id, userId));

    if (!row) return res.status(404).json({ error: "User not found" });

    return res.json({
      nativeLanguage:    row.nativeLanguage    ?? null,
      learningLanguages: row.learningLanguages ?? [],
      metroStation:      row.metroStation      ?? null,
    });
  } catch (err) {
    console.error("[match-profile] GET error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ── PATCH /api/user/match-profile ─────────────────────────────────────────────

router.patch("/match-profile", requireAuth, async (req: Request, res: Response) => {
  try {
    const userId = (req.user as { id: number }).id;
    const { nativeLanguage, learningLanguages, metroStation } = req.body;

    // Build only the fields the client sent — undefined fields are left unchanged
    const patch: Partial<{
      nativeLanguage:    string | null;
      learningLanguages: LanguageEntry[];
      metroStation:      string | null;
    }> = {};

    // --- nativeLanguage ---
    if (nativeLanguage !== undefined) {
      if (nativeLanguage === null || nativeLanguage === "") {
        patch.nativeLanguage = null;
      } else if (typeof nativeLanguage !== "string" || !VALID_LANGUAGE_CODES.has(nativeLanguage)) {
        return res.status(400).json({ error: `Invalid native language code: ${nativeLanguage}` });
      } else {
        patch.nativeLanguage = nativeLanguage;
      }
    }

    // --- learningLanguages ---
    if (learningLanguages !== undefined) {
      if (!Array.isArray(learningLanguages)) {
        return res.status(400).json({ error: "learningLanguages must be an array" });
      }
      if (learningLanguages.length > 3) {
        return res.status(400).json({ error: "Maximum 3 learning languages allowed" });
      }
      for (const entry of learningLanguages) {
        if (!isValidLanguageEntry(entry)) {
          return res.status(400).json({
            error: `Invalid language entry: ${JSON.stringify(entry)}. ` +
                   `Each entry must have a valid ISO 639-1 code and a proficiency of A1–C2.`,
          });
        }
      }
      // Prevent native language appearing in the learning list
      if (
        patch.nativeLanguage &&
        learningLanguages.some((e: LanguageEntry) => e.code === patch.nativeLanguage)
      ) {
        return res.status(400).json({
          error: "Native language cannot also appear in learningLanguages",
        });
      }
      patch.learningLanguages = learningLanguages;
    }

    // --- metroStation ---
    if (metroStation !== undefined) {
      if (metroStation === null || metroStation === "") {
        patch.metroStation = null;
      } else if (typeof metroStation !== "string" || metroStation.length > 120) {
        return res.status(400).json({ error: "Invalid metro station" });
      } else {
        patch.metroStation = metroStation.trim();
      }
    }

    // Nothing to update
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: "No valid fields provided" });
    }

    await db
      .update(users)
      .set(patch)
      .where(eq(users.id, userId));

    return res.json({ ok: true, updated: Object.keys(patch) });
  } catch (err) {
    console.error("[match-profile] PATCH error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

export default router;
