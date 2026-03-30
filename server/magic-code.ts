// server/magic-code.ts
// Magic code (OTP) authentication via email using Resend.
// Flow:
//   1. POST /api/auth/magic-code   { email } → generates 6-digit code, emails it, stores in DB
//   2. POST /api/auth/verify-code  { email, code } → verifies, creates/finds user, logs in

import type { Express } from "express";
import { Resend } from "resend";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";
import { storage } from "./storage";

let resend: Resend | null = null;
function getResend(): Resend | null {
  if (!process.env.RESEND_API_KEY) return null;
  if (!resend) resend = new Resend(process.env.RESEND_API_KEY);
  return resend;
}
const FROM_EMAIL = "noreply@expatevents.org";
const CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

// In-memory store for codes — good enough for free tier single instance.
// Replace with a DB table if you scale to multiple instances.
const codeStore = new Map<string, { code: string; expires: number; attempts: number }>();

function generateCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function slugify(str: string): string {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 32) || "user";
}

async function uniqueUsername(base: string): Promise<string> {
  let name = base;
  let i = 1;
  while (await storage.getUserByUsername(name)) name = `${base}_${i++}`;
  return name;
}

export function registerMagicCodeRoutes(app: Express) {

  // ── POST /api/auth/magic-code ─────────────────────────────────────────
  // Sends a 6-digit OTP to the provided email address.
  app.post("/api/auth/magic-code", async (req, res) => {
    const { email } = req.body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "Valid email address required" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Rate limit — max 3 codes per email per 10 minutes
    const existing = codeStore.get(normalizedEmail);
    if (existing && existing.expires > Date.now() && existing.attempts >= 3) {
      return res.status(429).json({ error: "Too many attempts. Please wait 10 minutes." });
    }

    const code = generateCode();
    codeStore.set(normalizedEmail, {
      code,
      expires: Date.now() + CODE_EXPIRY_MS,
      attempts: (existing?.attempts ?? 0) + 1,
    });

    // Send email via Resend
    const resendClient = getResend();
    if (!resendClient) {
      codeStore.delete(normalizedEmail);
      return res.status(501).json({ error: "Email sign-in not configured. Please use Google, Yandex, or password." });
    }
    try {
      await resendClient.emails.send({
        from: FROM_EMAIL,
        to: normalizedEmail,
        subject: "Your ExpatEvents sign-in code",
        html: `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background:#111;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#111;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" style="max-width:400px;background:#1a1a1a;border-radius:20px;overflow:hidden;">
          <tr>
            <td style="padding:36px 32px 28px;">
              <!-- Logo -->
              <div style="width:52px;height:52px;background:#D85A30;border-radius:14px;display:flex;align-items:center;justify-content:center;margin:0 auto 20px;font-size:24px;text-align:center;line-height:52px;">
                🗺️
              </div>

              <!-- Heading -->
              <h1 style="margin:0 0 6px;font-size:20px;font-weight:700;color:#fff;text-align:center;">
                ExpatEvents
              </h1>
              <p style="margin:0 0 32px;font-size:14px;color:#888;text-align:center;">
                Your sign-in code
              </p>

              <!-- Code -->
              <div style="background:#262626;border:1.5px solid #333;border-radius:14px;padding:24px;text-align:center;margin-bottom:24px;">
                <div style="font-size:38px;font-weight:700;color:#fff;letter-spacing:0.18em;font-variant-numeric:tabular-nums;">
                  ${code}
                </div>
                <p style="margin:10px 0 0;font-size:12px;color:#666;">
                  Expires in 10 minutes
                </p>
              </div>

              <!-- Instructions -->
              <p style="margin:0 0 24px;font-size:13px;color:#888;text-align:center;line-height:1.6;">
                Enter this code on the ExpatEvents sign-in page.<br>
                If you didn't request this, you can safely ignore this email.
              </p>

              <!-- Footer -->
              <hr style="border:none;border-top:1px solid #2a2a2a;margin:0 0 20px;" />
              <p style="margin:0;font-size:12px;color:#555;text-align:center;">
                ExpatEvents · Moscow expat community<br>
                <a href="https://expatevents.org" style="color:#777;text-decoration:none;">expatevents.org</a>
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
        `.trim(),
      });

      res.json({ ok: true, message: "Code sent" });
    } catch (err: any) {
      console.error("[magic-code] Resend error:", err?.message ?? err);
      codeStore.delete(normalizedEmail); // clean up on failure
      res.status(500).json({ error: "Failed to send email. Please try Google or Yandex sign-in." });
    }
  });

  // ── POST /api/auth/verify-code ────────────────────────────────────────
  // Verifies the OTP, creates or finds the user, logs them in.
  app.post("/api/auth/verify-code", async (req, res, next) => {
    const { email, code } = req.body;

    if (!email || !code) {
      return res.status(400).json({ error: "Email and code required" });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const stored = codeStore.get(normalizedEmail);

    if (!stored) {
      return res.status(400).json({ error: "No code found for this email. Please request a new one." });
    }

    if (Date.now() > stored.expires) {
      codeStore.delete(normalizedEmail);
      return res.status(400).json({ error: "Code has expired. Please request a new one." });
    }

    if (stored.code !== String(code).trim()) {
      return res.status(400).json({ error: "Incorrect code. Please try again." });
    }

    // Code is valid — clean up
    codeStore.delete(normalizedEmail);

    try {
      // Find or create user by email
      let user = await storage.getUserByEmail(normalizedEmail);

      if (!user) {
        // New user — create account from email
        const baseUsername = await uniqueUsername(
          slugify(normalizedEmail.split("@")[0])
        );
        user = await storage.createUser({
          username:    baseUsername,
          password:    null,
          email:       normalizedEmail,
          displayName: null,
          avatarUrl:   null,
        });
      }

      // Log in
      req.login(user, (err) => {
        if (err) return next(err);
        res.json({ ok: true, user: { id: user!.id, username: user!.username, email: user!.email } });
      });
    } catch (err: any) {
      console.error("[magic-code] User creation error:", err?.message ?? err);
      res.status(500).json({ error: "Sign-in failed. Please try again." });
    }
  });
}
