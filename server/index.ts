// server/index.ts
import { initBot } from "./bot";
import { scheduleMatcher } from "./matcher";
import { registerNotifyRoutes } from "./notify-routes";
import express from "express";
import cors from "cors";
import session from "express-session";
import connectPg from "connect-pg-simple";
import pg from "pg";
import { setupPassport, registerAuthRoutes } from "./auth";

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const PgSession = connectPg(session);

// ── Trust Render's reverse proxy ──────────────────────────────────────────
// Required for secure cookies to work behind Render's load balancer
app.set("trust proxy", 1);

// ── CORS ──────────────────────────────────────────────────────────────────
// ALLOWED_ORIGINS = comma-separated list of your frontend URLs
// e.g. "https://events.meh-moscow.com,https://games.meh-moscow.com"
// During development: "http://localhost:5173,http://localhost:5174"
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, server-to-server)
    if (!origin) return callback(null, true);
    if (allowedOrigins.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error(`CORS: ${origin} not in allowed origins`));
  },
  credentials: true, // required for session cookies
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Session ───────────────────────────────────────────────────────────────
// Session cookies use the COOKIE_DOMAIN env var so they work across all
// subdomains of meh-moscow.com (or whatever domain you use).
// Without a custom domain set COOKIE_DOMAIN to blank — cookies work per-service.
const cookieDomain = process.env.COOKIE_DOMAIN || undefined;

app.use(session({
  store: new PgSession({
    conString: process.env.DATABASE_URL,
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
    maxAge:   30 * 24 * 60 * 60 * 1000, // 30 days
    domain:   cookieDomain,              // ".meh-moscow.com" covers all subdomains
  },
}));

// ── Passport + all auth routes ────────────────────────────────────────────
setupPassport();
registerAuthRoutes(app);

// ── Health + keep-alive ───────────────────────────────────────────────────
app.get("/ping", (_req, res) => res.send("OK"));
app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "meh-auth",
  uptime: Math.floor(process.uptime()),
  env: process.env.NODE_ENV,
}));

// ── Login page (served by auth service itself) ────────────────────────────
// Simple HTML redirect page — when a frontend sends users to /login,
// this page presents the OAuth buttons and then redirects back.
// Replace with a proper React app later if you want a custom design.
app.get("/login", (req, res) => {
  const returnTo = encodeURIComponent((req.query.returnTo as string) ?? "/");
  const authUrl = process.env.AUTH_SERVICE_URL ?? "";

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sign in</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #FFFCF7; min-height: 100vh;
           display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: white; border-radius: 16px; padding: 32px; width: 100%;
            max-width: 360px; box-shadow: 0 2px 16px rgba(0,0,0,0.08); }
    h1 { font-size: 22px; font-weight: 600; color: #2C2C2A; margin-bottom: 4px; text-align: center; }
    p { font-size: 14px; color: #888780; text-align: center; margin-bottom: 24px; }
    .btn { display: flex; align-items: center; justify-content: center; gap: 10px;
           width: 100%; padding: 11px 16px; border-radius: 10px; border: 1.5px solid #D3D1C7;
           background: white; font-size: 14px; font-weight: 500; color: #2C2C2A;
           cursor: pointer; text-decoration: none; margin-bottom: 10px; transition: border-color 0.15s; }
    .btn:hover { border-color: #888780; }
    .btn svg { width: 18px; height: 18px; flex-shrink: 0; }
    .divider { display: flex; align-items: center; gap: 10px; margin: 16px 0;
               font-size: 12px; color: #B4B2A9; }
    .divider::before, .divider::after { content: ""; flex: 1; height: 0.5px; background: #D3D1C7; }
    input { width: 100%; padding: 10px 12px; border-radius: 8px; border: 1.5px solid #D3D1C7;
            font-size: 14px; color: #2C2C2A; outline: none; margin-bottom: 10px; }
    input:focus { border-color: #D85A30; }
    .btn-primary { background: #D85A30; border-color: #D85A30; color: white; }
    .btn-primary:hover { background: #c04e28; border-color: #c04e28; }
    .error { color: #A32D2D; font-size: 13px; text-align: center; margin-top: 8px; }
  </style>
</head>
<body>
<div class="card">
  <h1>Welcome</h1>
  <p>Sign in to continue</p>

  <a href="${authUrl}/api/auth/google?returnTo=${returnTo}" class="btn">
    <svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
    Continue with Google
  </a>

  <a href="${authUrl}/api/auth/yandex?returnTo=${returnTo}" class="btn">
    <svg viewBox="0 0 24 24"><path fill="#FC3F1D" d="M2 0h20a2 2 0 0 1 2 2v20a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2V2a2 2 0 0 1 2-2z"/><path fill="#fff" d="M13.32 4H10.9C8.1 4 6.5 5.46 6.5 7.93c0 2.18 1.06 3.4 3.08 4.73L7 20h2.7l2.78-7.05-.6-.37C10.1 11.4 9.2 10.5 9.2 7.93c0-1.55.92-2.46 2.72-2.46h1.4V20H16V4h-2.68z"/></svg>
    Continue with Yandex
  </a>

  <div id="tg-container"></div>

  <div class="divider">or sign in with username</div>

  <form id="login-form">
    <input type="text" id="username" placeholder="Username" autocomplete="username" required>
    <input type="password" id="password" placeholder="Password" autocomplete="current-password" required>
    <button type="submit" class="btn btn-primary">Sign in</button>
    <div id="error" class="error" style="display:none"></div>
  </form>
</div>

<script>
const returnTo = decodeURIComponent("${returnTo}");
const authUrl = "${authUrl}";

// Telegram widget
if (${JSON.stringify(!!process.env.TELEGRAM_BOT_NAME)}) {
  const s = document.createElement("script");
  s.src = "https://telegram.org/js/telegram-widget.js?22";
  s.setAttribute("data-telegram-login", "${process.env.TELEGRAM_BOT_NAME ?? ""}");
  s.setAttribute("data-size", "large");
  s.setAttribute("data-auth-url", authUrl + "/api/auth/telegram");
  s.setAttribute("data-request-access", "write");
  s.async = true;
  document.getElementById("tg-container").appendChild(s);
}

// Local login form
document.getElementById("login-form").addEventListener("submit", async e => {
  e.preventDefault();
  const err = document.getElementById("error");
  err.style.display = "none";
  const res = await fetch(authUrl + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
    }),
  });
  if (res.ok) {
    window.location.href = returnTo;
  } else {
    err.textContent = "Incorrect username or password";
    err.style.display = "block";
  }
});
</script>
</body>
</html>`);
});

// ── Notify routes (must come after app is fully defined) ──────────────────
registerNotifyRoutes(app);

// ── Global error handler ──────────────────────────────────────────────────
app.use((err: any, _req: any, res: any, _next: any) => {
  console.error("[meh-auth] Error:", err.message);
  const status = err.status ?? err.statusCode ?? 500;
  res.status(status).json({ error: err.message ?? "Internal server error" });
});

// ── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[meh-auth] Running on port ${PORT} (${process.env.NODE_ENV ?? "development"})`);
  console.log(`[meh-auth] Cookie domain: ${process.env.COOKIE_DOMAIN ?? "not set (single-domain mode)"}`);
  console.log(`[meh-auth] Allowed origins: ${process.env.ALLOWED_ORIGINS ?? "none set"}`);
  initBot();
  scheduleMatcher();
});
