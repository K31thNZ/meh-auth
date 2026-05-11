// server/index.ts
import { registerTelegramLinkRoutes } from "./telegram-link";
import { registerMagicCodeRoutes } from "./magic-code";
import { bot } from "./bot"; // grammy bot instance
import { scheduleMatcher } from "./matcher";
import { registerNotifyRoutes } from "./notify-routes";
import matchProfileRouter from "./routes/match-profile";
import express from "express";
import cors from "cors";
import session from "express-session";
import connectPg from "connect-pg-simple";
import pg from "pg";
import { hashPassword, comparePasswords, setupPassport, registerAuthRoutes } from "./auth";
import { db } from "./db";
import { users } from "@shared/schema";
import { eq } from "drizzle-orm";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const PgSession = connectPg(session);

const dbConString = (process.env.DATABASE_URL ?? "")
  .replace(/[&?]channel_binding=[^&]*/g, "");

app.set("trust proxy", 1);

const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error(`CORS: ${origin} not in allowed origins`));
  },
  credentials: true,
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

const sessionPool = new pg.Pool({
  connectionString: dbConString,
  ssl: { rejectUnauthorized: false },
});

app.use(session({
  store: new PgSession({
    pool: sessionPool,
    tableName: "sessions",
    createTableIfMissing: true,
  }),
  secret:            process.env.SESSION_SECRET!,
  resave:            false,
  saveUninitialized: false,
  name:              "meh.sid",
  cookie: {
    secure:   process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
    maxAge:   30 * 24 * 60 * 60 * 1000,
    domain:   cookieDomain,
  },
}));

setupPassport();
registerAuthRoutes(app);

app.get("/ping", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "meh-auth",
  uptime: Math.floor(process.uptime()),
  env: process.env.NODE_ENV,
}));

// ── Shared brand styles ────────────────────────────────────────────────────
const BRAND_FONT = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">`;

const BRAND_DOC_CSS = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: "Plus Jakarta Sans", sans-serif;
    background: #FCFAF8; color: #251D18;
    max-width: 680px; margin: 0 auto; padding: 48px 24px 80px; line-height: 1.75;
  }
  h1 { font-family: "Playfair Display", serif; font-size: 32px; font-weight: 700;
       color: #251D18; margin-bottom: 6px; }
  .meta { font-size: 13px; color: #9CA3AF; margin-bottom: 36px; }
  h2 { font-size: 15px; font-weight: 600; color: #251D18; margin: 28px 0 8px; }
  p  { font-size: 15px; color: #4B4340; margin-bottom: 12px; }
  ul { font-size: 15px; color: #4B4340; padding-left: 20px; margin-bottom: 12px; }
  li { margin-bottom: 6px; }
  a  { color: #E72350; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .brand { font-family: "Playfair Display", serif; font-size: 15px;
           font-weight: 600; margin-bottom: 32px; display: block; }
  .brand .red { color: #E72350; }
  .brand .dark { color: #251D18; }
  .back { display: inline-flex; align-items: center; gap: 6px; font-size: 14px;
          color: #7E6F67; margin-bottom: 32px; cursor: pointer;
          background: none; border: none; font-family: "Plus Jakarta Sans", sans-serif; }
  .back:hover { color: #251D18; }
`;

// ── Terms of Use ──────────────────────────────────────────────────────────
app.get("/terms", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Use — ExpatEvents</title>
  ${BRAND_FONT}
  <style>${BRAND_DOC_CSS}</style>
</head>
<body>
  <h1>Terms of Use</h1>
  <p class="meta">Last updated: March 2026</p>
  <h2>1. Acceptance of Terms</h2>
  <p>By accessing or using ExpatEvents, you agree to be bound by these Terms of Use. If you do not agree, please do not use the platform.</p>
  <h2>2. Use of the Platform</h2>
  <p>ExpatEvents is a community platform for discovering and hosting events in Moscow. You may use the platform for lawful purposes only. You are responsible for all content you submit, including event listings.</p>
  <h2>3. Account Responsibility</h2>
  <p>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. Notify us immediately of any unauthorised use.</p>
  <h2>4. Event Listings</h2>
  <p>Event organisers are solely responsible for the accuracy of their listings, including dates, venues, ticket prices, and descriptions. ExpatEvents is not responsible for cancelled or modified events.</p>
  <h2>5. Payments</h2>
  <p>ExpatEvents does not process payments. Ticket purchases and payments are handled directly by event organisers through their chosen payment providers. ExpatEvents is not a party to any transaction between attendees and organisers.</p>
  <h2>6. Prohibited Conduct</h2>
  <p>You agree not to: post false or misleading event information; harass other users; attempt to access accounts that are not yours; use the platform to distribute spam or malware.</p>
  <h2>7. Intellectual Property</h2>
  <p>The ExpatEvents name, logo, and platform design are owned by ExpatEvents. Event content submitted by users remains the property of the submitting user.</p>
  <h2>8. Limitation of Liability</h2>
  <p>ExpatEvents is provided "as is" without warranties of any kind. We are not liable for any indirect, incidental, or consequential damages arising from your use of the platform.</p>
  <h2>9. Changes to Terms</h2>
  <p>We may update these terms from time to time. Continued use of the platform after changes are posted constitutes acceptance of the updated terms.</p>
  <h2>10. Contact</h2>
  <p>For questions about these terms, contact us at <a href="mailto:hello@expatevents.org">hello@expatevents.org</a>.</p>
</body>
</html>`);
});

// ── Privacy Policy ────────────────────────────────────────────────────────
app.get("/privacy", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Privacy Policy — ExpatEvents</title>
  ${BRAND_FONT}
  <style>${BRAND_DOC_CSS}</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="meta">Last updated: March 2026</p>
  <h2>1. Information We Collect</h2>
  <p>When you use ExpatEvents, we may collect:</p>
  <ul>
    <li>Account information: name, email address, profile photo (from OAuth providers)</li>
    <li>Profile preferences: event interests, weekly availability</li>
    <li>Telegram ID (if you connect your Telegram account)</li>
    <li>Event data: events you create or register interest in</li>
    <li>Session data: login sessions stored securely in our database</li>
  </ul>
  <h2>2. How We Use Your Information</h2>
  <ul>
    <li>To authenticate you and maintain your session</li>
    <li>To send Telegram notifications about events matching your interests</li>
    <li>To analyse availability patterns and help organisers plan events</li>
    <li>To improve the platform and community experience</li>
  </ul>
  <h2>3. Data Sharing</h2>
  <p>We do not sell your personal data. We share data only with OAuth providers (Google, Yandex) when you sign in through them, Telegram when you connect your account, and infrastructure providers (Render, Neon) under strict data protection agreements.</p>
  <h2>4. Data Storage</h2>
  <p>Your data is stored in PostgreSQL databases hosted by Neon, located in Frankfurt, Germany (EU Central region). Session data is retained for 30 days after your last login.</p>
  <h2>5. Your Rights</h2>
  <p>You have the right to access, correct, or delete your personal data. Contact us at <a href="mailto:hello@expatevents.org">hello@expatevents.org</a>. We will respond within 30 days.</p>
  <h2>6. Cookies</h2>
  <p>We use a single session cookie ("meh.sid") to maintain your login state. This cookie is essential for the platform to function.</p>
  <h2>7. Telegram Notifications</h2>
  <p>If you connect your Telegram account, we will send notifications about events matching your interests. You can disconnect at any time from your profile page or by sending /stop to our bot.</p>
  <h2>8. Contact</h2>
  <p>For privacy enquiries: <a href="mailto:hello@expatevents.org">hello@expatevents.org</a></p>
</body>
</html>`);
});

// ── Login page ─────────────────────────────────────────────────────────────
app.get("/login", (req, res) => {
  const returnTo = encodeURIComponent((req.query.returnTo as string) ?? "/");
  const authUrl = process.env.AUTH_SERVICE_URL ?? "";
  const tgBotName = process.env.TELEGRAM_BOT_NAME ?? "";
  const hasTelegram = !!tgBotName;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in — ExpatEvents</title>
  <link rel="icon" href="https://expatevents.org/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@600;700&family=Plus+Jakarta+Sans:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: "Plus Jakarta Sans", sans-serif;
      background: #FCFAF8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px 16px;
      color: #251D18;
    }
    .card {
      background: #fff;
      border-radius: 16px;
      padding: 36px 32px 28px;
      width: 100%;
      max-width: 400px;
      box-shadow: 0 2px 24px rgba(37,29,24,0.08), 0 1px 4px rgba(37,29,24,0.04);
    }
    .card-title {
      font-family: "Playfair Display", serif;
      font-size: 26px;
      font-weight: 700;
      color: #251D18;
      text-align: center;
      margin-bottom: 6px;
    }
    .card-subtitle {
      font-size: 14px;
      color: #9CA3AF;
      text-align: center;
      margin-bottom: 28px;
    }
    .field-label {
      font-size: 12px;
      font-weight: 600;
      color: #7E6F67;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 7px;
    }
    input {
      width: 100%;
      padding: 13px 18px;
      background: #FCFAF8;
      border: 1.5px solid #E5E0DC;
      border-radius: 9999px;
      color: #251D18;
      font-size: 15px;
      font-family: "Plus Jakarta Sans", sans-serif;
      outline: none;
      transition: border-color 0.15s, box-shadow 0.15s;
      margin-bottom: 16px;
    }
    input::placeholder { color: #B8AFA9; }
    input:focus {
      border-color: #E72350;
      box-shadow: 0 0 0 3px rgba(231,35,80,0.1);
    }
    input[type=number] {
      letter-spacing: 0.25em;
      font-size: 22px;
      text-align: center;
    }
    .btn-primary {
      width: 100%;
      padding: 13px;
      background: #E72350;
      border: none;
      border-radius: 9999px;
      font-size: 15px;
      font-weight: 600;
      font-family: "Plus Jakarta Sans", sans-serif;
      color: #fff;
      cursor: pointer;
      margin-bottom: 10px;
      transition: background 0.15s, transform 0.1s;
    }
    .btn-primary:hover  { background: #cf1f48; }
    .btn-primary:active { transform: scale(0.98); }
    .btn-ghost {
      width: 100%;
      padding: 11px;
      background: transparent;
      border: none;
      font-size: 14px;
      font-weight: 500;
      font-family: "Plus Jakarta Sans", sans-serif;
      color: #7E6F67;
      cursor: pointer;
      transition: color 0.15s;
    }
    .btn-ghost:hover { color: #E72350; }
    .back-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: none;
      border: none;
      color: #7E6F67;
      font-size: 13px;
      font-family: "Plus Jakarta Sans", sans-serif;
      cursor: pointer;
      margin-bottom: 20px;
      padding: 0;
    }
    .back-btn:hover { color: #251D18; }
    .divider {
      display: flex;
      align-items: center;
      gap: 12px;
      margin: 20px 0;
      font-size: 11px;
      font-weight: 500;
      color: #B8AFA9;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    .divider::before, .divider::after {
      content:
