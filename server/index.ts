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

// ── Terms of Use ──────────────────────────────────────────────────────────
app.get("/terms", (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Use — ExpatEvents</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0;
           max-width: 680px; margin: 0 auto; padding: 40px 24px 80px; line-height: 1.7; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 8px; }
    .meta { font-size: 13px; color: #888; margin-bottom: 36px; }
    h2 { font-size: 16px; font-weight: 600; color: #fff; margin: 28px 0 8px; }
    p { font-size: 14px; color: #aaa; margin-bottom: 12px; }
    a { color: #a3e635; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { display: inline-block; font-size: 13px; color: #888; margin-bottom: 32px;
            cursor: pointer; background: none; border: none; }
  </style>
</head>
<body>
  <button class="back" onclick="history.back()">← Back</button>
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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e0e0e0;
           max-width: 680px; margin: 0 auto; padding: 40px 24px 80px; line-height: 1.7; }
    h1 { font-size: 28px; font-weight: 700; color: #fff; margin-bottom: 8px; }
    .meta { font-size: 13px; color: #888; margin-bottom: 36px; }
    h2 { font-size: 16px; font-weight: 600; color: #fff; margin: 28px 0 8px; }
    p { font-size: 14px; color: #aaa; margin-bottom: 12px; }
    ul { font-size: 14px; color: #aaa; padding-left: 20px; margin-bottom: 12px; }
    li { margin-bottom: 6px; }
    a { color: #a3e635; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .back { display: inline-block; font-size: 13px; color: #888; margin-bottom: 32px;
            cursor: pointer; background: none; border: none; }
  </style>
</head>
<body>
  <button class="back" onclick="history.back()">← Back</button>
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

// ── Login page ────────────────────────────────────────────────────────────
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
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #FFFCF7; min-height: 100vh;
      display: flex; align-items: center; justify-content: center; padding: 16px;
    }
    .card {
      background: white; border-radius: 24px;
      padding: 36px 28px 28px; width: 100%; max-width: 400px;
      box-shadow: 0 24px 64px rgba(0,0,0,0.6);
    }
    .logo {
      width: 56px; height: 56px;
      background: #D85A30; border-radius: 16px;
      display: flex; align-items: center; justify-content: center;
      margin: 0 auto 20px; font-size: 26px;
    }
    h1 { font-size: 22px; font-weight: 600; color: #2C2C2A; margin-bottom: 4px; text-align: center; }
    .subtitle { font-size: 14px; color: #888; text-align: center; margin-bottom: 28px; }
    .field-label {
      font-size: 11px; font-weight: 500; color: #666;
      text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 6px;
    }
    input {
      width: 100%; padding: 13px 14px;
      background: #262626; border: 1.5px solid #333;
      border-radius: 12px; color: #fff; font-size: 15px;
      outline: none; transition: border-color 0.15s; margin-bottom: 12px;
    }
    input::placeholder { color: #555; }
    input:focus { border-color: #D85A30; }
    input[type=number] { letter-spacing: 0.2em; font-size: 22px; text-align: center; }
    .btn-primary {
      width: 100%; padding: 13px; background: #a3e635;
      border: none; border-radius: 12px;
      font-size: 15px; font-weight: 600; color: #0f0f0f;
      cursor: pointer; margin-bottom: 10px; transition: background 0.15s;
    }
    .btn-primary:hover { background: #bef264; }
    .btn-ghost {
      width: 100%; padding: 11px; background: transparent; border: none;
      font-size: 14px; font-weight: 500; color: #a3e635;
      cursor: pointer; transition: color 0.15s;
    }
    .btn-ghost:hover { color: #bef264; }
    .divider {
      display: flex; align-items: center; gap: 10px;
      margin: 20px 0; font-size: 12px; color: #555;
      text-transform: uppercase; letter-spacing: 0.06em;
    }
    .divider::before, .divider::after { content: ""; flex: 1; height: 0.5px; background: #333; }
    .oauth-btn {
      display: flex; align-items: center; justify-content: center; gap: 10px;
      width: 100%; padding: 12px 16px; background: #fff;
      border: none; border-radius: 12px;
      font-size: 14px; font-weight: 500; color: #1a1a1a;
      cursor: pointer; text-decoration: none; margin-bottom: 10px;
      transition: background 0.15s;
    }
    .oauth-btn:hover { background: #f0f0f0; }
    .oauth-btn.yandex { background: #FC3F1D; color: #fff; }
    .oauth-btn.yandex:hover { background: #e03618; }
    #tg-container { display: flex; justify-content: center; margin-bottom: 4px; }
    .back-btn {
      background: none; border: none; color: #666;
      font-size: 13px; cursor: pointer; margin-bottom: 16px;
      padding: 0; display: block;
    }
    .back-btn:hover { color: #aaa; }
    .error { color: #f87171; font-size: 13px; text-align: center; margin-top: 8px; display: none; }
    .hint { font-size: 13px; color: #666; margin-bottom: 14px; }
    .footer { font-size: 12px; color: #555; text-align: center; margin-top: 24px; line-height: 1.7; }
    .footer a { color: #777; text-decoration: underline; }
    .footer a:hover { color: #aaa; }
    #code-step, #password-step { display: none; }
  </style>
</head>
<body>
<div class="card">
  <a href="/" class="flex items-center gap-2 group"><div class="w-10 h-10 rounded-xl bg-gradient-to-tr from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20 group-hover:scale-105 transition-transform"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-ticket w-5 h-5 text-white"><path d="M2 9a3 3 0 0 1 0 6v2a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2Z"></path><path d="M13 5v2"></path><path d="M13 17v2"></path><path d="M13 11v2"></path></svg></div><span class="font-display font-bold text-2xl tracking-tight text-foreground">Expat<span class="text-primary">Events</span></span></a>
  <p class="subtitle">Sign in to continue</p>

  <!-- Step 1: Email -->
  <div id="email-step">
    <div class="field-label">Email</div>
    <input type="email" id="email-input" placeholder="yours@example.com" autocomplete="email" />
    <button class="btn-primary" onclick="handleGetCode()">Get Code</button>
    <button class="btn-ghost" onclick="showPasswordStep()">Use Password</button>
    <div class="divider">or</div>
    <a href="${authUrl}/api/auth/google?returnTo=${returnTo}" class="oauth-btn">
      <svg viewBox="0 0 48 48" width="18" height="18">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
      </svg>
      Continue with Google
    </a>
    <a href="${authUrl}/api/auth/yandex?returnTo=${returnTo}" class="oauth-btn yandex">
      <svg viewBox="0 0 24 24" width="18" height="18">
        <path fill="#fff" d="M13.32 4H10.9C8.1 4 6.5 5.46 6.5 7.93c0 2.18 1.06 3.4 3.08 4.73L7 20h2.7l2.78-7.05-.6-.37C10.1 11.4 9.2 10.5 9.2 7.93c0-1.55.92-2.46 2.72-2.46h1.4V20H16V4h-2.68z"/>
      </svg>
      Continue with Yandex
    </a>
    <div id="tg-container"></div>
    <div id="email-error" class="error"></div>
  </div>

  <!-- Step 2: Code -->
  <div id="code-step">
    <button class="back-btn" onclick="showEmailStep()">← Back</button>
    <div class="field-label">Verification code</div>
    <p class="hint" id="code-hint">We've sent a 6-digit code to your email.</p>
    <input type="number" id="code-input" placeholder="000000" autocomplete="one-time-code" maxlength="6" />
    <button class="btn-primary" onclick="handleVerifyCode()">Verify</button>
    <button class="btn-ghost" onclick="handleGetCode()">Resend code</button>
    <div id="code-error" class="error"></div>
  </div>

  <!-- Step 3: Password -->
  <div id="password-step">
    <button class="back-btn" onclick="showEmailStep()">← Back</button>
    <div class="field-label">Username</div>
    <input type="text" id="username" placeholder="Username" autocomplete="username" />
    <div class="field-label">Password</div>
    <input type="password" id="password" placeholder="Password" autocomplete="current-password" />
    <button class="btn-primary" onclick="handlePasswordLogin()">Sign in</button>
    <div id="pwd-error" class="error"></div>
  </div>

  <div class="footer">
    By continuing, you agree to our
    <a href="${authUrl}/terms" target="_blank">Terms of Use</a>
    and
    <a href="${authUrl}/privacy" target="_blank">Privacy Policy</a>.
  </div>
</div>

<script>
const authUrl = "${authUrl}";
const returnTo = decodeURIComponent("${returnTo}");

${hasTelegram ? `
(function() {
  const s = document.createElement("script");
  s.src = "https://telegram.org/js/telegram-widget.js?22";
  s.setAttribute("data-telegram-login", "${tgBotName}");
  s.setAttribute("data-size", "large");
  s.setAttribute("data-auth-url", authUrl + "/api/auth/telegram");
  s.setAttribute("data-request-access", "write");
  s.async = true;
  document.getElementById("tg-container").appendChild(s);
})();
` : ""}

function showEmailStep() {
  document.getElementById("email-step").style.display = "block";
  document.getElementById("code-step").style.display = "none";
  document.getElementById("password-step").style.display = "none";
}
function showPasswordStep() {
  document.getElementById("email-step").style.display = "none";
  document.getElementById("code-step").style.display = "none";
  document.getElementById("password-step").style.display = "block";
}
function showCodeStep(email) {
  document.getElementById("email-step").style.display = "none";
  document.getElementById("code-step").style.display = "block";
  document.getElementById("password-step").style.display = "none";
  document.getElementById("code-hint").textContent = "We've sent a 6-digit code to " + email + ".";
}

async function handleGetCode() {
  const email = document.getElementById("email-input").value.trim();
  const errEl = document.getElementById("email-error");
  errEl.style.display = "none";
  if (!email || !email.includes("@")) {
    errEl.textContent = "Please enter a valid email address.";
    errEl.style.display = "block";
    return;
  }
  try {
    const res = await fetch(authUrl + "/api/auth/magic-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email }),
    });
    if (res.ok) {
      showCodeStep(email);
    } else if (res.status === 501) {
      errEl.textContent = "Email sign-in coming soon. Please use Google, Yandex, or password.";
      errEl.style.display = "block";
    } else {
      errEl.textContent = "Could not send code. Please try Google or Yandex sign-in.";
      errEl.style.display = "block";
    }
  } catch {
    errEl.textContent = "Network error. Please try again.";
    errEl.style.display = "block";
  }
}

async function handleVerifyCode() {
  const email = document.getElementById("email-input").value.trim();
  const code = document.getElementById("code-input").value.trim();
  const errEl = document.getElementById("code-error");
  errEl.style.display = "none";
  if (code.length < 6) {
    errEl.textContent = "Please enter the 6-digit code.";
    errEl.style.display = "block";
    return;
  }
  try {
    const res = await fetch(authUrl + "/api/auth/verify-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, code }),
    });
    if (res.ok) { window.location.href = returnTo; }
    else {
      errEl.textContent = "Incorrect or expired code. Please try again.";
      errEl.style.display = "block";
    }
  } catch {
    errEl.textContent = "Network error. Please try again.";
    errEl.style.display = "block";
  }
}

async function handlePasswordLogin() {
  const errEl = document.getElementById("pwd-error");
  errEl.style.display = "none";
  const res = await fetch(authUrl + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({
      username: document.getElementById("username").value,
      password: document.getElementById("password").value,
    }),
  });
  if (res.ok) { window.location.href = returnTo; }
  else {
    errEl.textContent = "Incorrect username or password.";
    errEl.style.display = "block";
  }
}

document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (document.getElementById("code-step").style.display === "block") handleVerifyCode();
  else if (document.getElementById("password-step").style.display === "block") handlePasswordLogin();
  else handleGetCode();
});
</script>
</body>
</html>`);
});

// ── Magic code stub (returns 501 until email provider is added) ───────────
app.post("/api/auth/magic-code", (_req, res) => {
  res.status(501).json({ error: "Email sign-in not yet configured" });
});

// ── Notify routes ─────────────────────────────────────────────────────────
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
  console.log(`[meh-auth] Cookie domain: ${process.env.COOKIE_DOMAIN ?? "not set"}`);
  console.log(`[meh-auth] Allowed origins: ${process.env.ALLOWED_ORIGINS ?? "none set"}`);
  initBot();
  scheduleMatcher();
});
