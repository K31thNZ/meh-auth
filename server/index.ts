import { registerMagicCodeRoutes } from "./magic-code";
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

// The pg driver doesn't support channel_binding=require (Neon includes it) — strip it
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
  <span class="brand"><span class="dark">Expat</span><span class="red">Events</span></span>
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
  ${BRAND_FONT}
  <style>${BRAND_DOC_CSS}</style>
</head>
<body>
  <span class="brand"><span class="dark">Expat</span><span class="red">Events</span></span>
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

    /* ── Brand wordmark ── */
    .wordmark {
      font-family: "Playfair Display", serif;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: -0.01em;
      margin-bottom: 32px;
    }
    .wordmark .dark { color: #251D18; }
    .wordmark .red  { color: #E72350; }

    /* ── Card ── */
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

    /* ── Field label ── */
    .field-label {
      font-size: 12px;
      font-weight: 600;
      color: #7E6F67;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 7px;
    }

    /* ── Inputs — pill shape per brand spec ── */
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

    /* ── Primary button ── */
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

    /* ── Ghost / text button ── */
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

    /* ── Back button ── */
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

    /* ── Divider ── */
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
      content: "";
      flex: 1;
      height: 1px;
      background: #EDE9E5;
    }

    /* ── OAuth buttons ── */
    .oauth-btn {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      width: 100%;
      padding: 12px 16px;
      background: #FCFAF8;
      border: 1.5px solid #E5E0DC;
      border-radius: 9999px;
      font-size: 14px;
      font-weight: 500;
      font-family: "Plus Jakarta Sans", sans-serif;
      color: #251D18;
      cursor: pointer;
      text-decoration: none;
      margin-bottom: 10px;
      transition: border-color 0.15s, background 0.15s;
    }
    .oauth-btn:hover {
      border-color: #C5BDB8;
      background: #F5F1EE;
    }
    .oauth-btn.yandex {
      background: #FC3F1D;
      border-color: #FC3F1D;
      color: #fff;
    }
    .oauth-btn.yandex:hover {
      background: #e03618;
      border-color: #e03618;
    }

    /* ── Telegram widget centering ── */
    #tg-container {
      display: flex;
      justify-content: center;
      margin-top: 4px;
      margin-bottom: 4px;
    }

    /* ── Error message ── */
    .error {
      font-size: 13px;
      color: #E72350;
      text-align: center;
      margin-top: 4px;
      display: none;
      min-height: 20px;
    }

    /* ── Code hint ── */
    .hint {
      font-size: 14px;
      color: #7E6F67;
      margin-bottom: 16px;
      line-height: 1.5;
    }

    /* ── Footer ── */
    .footer {
      font-size: 12px;
      color: #B8AFA9;
      text-align: center;
      margin-top: 24px;
      line-height: 1.75;
    }
    .footer a {
      color: #7E6F67;
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    .footer a:hover { color: #E72350; }

    /* ── Step visibility ── */
    #code-step, #password-step { display: none; }
  </style>
</head>
<body>

  <div class="wordmark"><span class="dark">Expat</span><span class="red">Events</span></div>

  <div class="card">
    <h1 class="card-title">Welcome back</h1>
    <p class="card-subtitle">Sign in to your account to continue</p>

    <!-- Step 1: Email -->
    <div id="email-step">
      <div class="field-label">Email address</div>
      <input type="email" id="email-input" placeholder="yours@example.com" autocomplete="email" />
      <button class="btn-primary" onclick="handleGetCode()">Send me a code</button>
      <button class="btn-ghost" onclick="showPasswordStep()">Sign in with username &amp; password</button>

      <div class="divider">or</div>

      <a href="${authUrl}/api/auth/google?returnTo=${returnTo}" class="oauth-btn">
        <svg viewBox="0 0 48 48" width="18" height="18" aria-hidden="true">
          <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
          <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
          <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>
          <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.18 1.48-4.97 2.31-8.16 2.31-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
        </svg>
        Continue with Google
      </a>

      <a href="${authUrl}/api/auth/yandex?returnTo=${returnTo}" class="oauth-btn yandex">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="#fff" d="M13.32 4H10.9C8.1 4 6.5 5.46 6.5 7.93c0 2.18 1.06 3.4 3.08 4.73L7 20h2.7l2.78-7.05-.6-.37C10.1 11.4 9.2 10.5 9.2 7.93c0-1.55.92-2.46 2.72-2.46h1.4V20H16V4h-2.68z"/>
        </svg>
        Continue with Yandex
      </a>

      <div id="tg-container"></div>
      <div id="email-error" class="error"></div>
    </div>

    <!-- Step 2: Verification code -->
    <div id="code-step">
      <button class="back-btn" onclick="showEmailStep()">← Back</button>
      <div class="field-label">Verification code</div>
      <p class="hint" id="code-hint">We sent a 6-digit code to your email. It expires in 10 minutes.</p>
      <input type="number" id="code-input" placeholder="000000" autocomplete="one-time-code" maxlength="6" />
      <button class="btn-primary" onclick="handleVerifyCode()">Verify code</button>
      <button class="btn-ghost" onclick="handleGetCode()">Resend code</button>
      <div id="code-error" class="error"></div>
    </div>

    <!-- Step 3: Username + password -->
    <div id="password-step">
      <button class="back-btn" onclick="showEmailStep()">← Back</button>
      <div class="field-label">Username</div>
      <input type="text" id="username" placeholder="Your username" autocomplete="username" />
      <div class="field-label">Password</div>
      <input type="password" id="password" placeholder="Your password" autocomplete="current-password" />
      <button class="btn-primary" onclick="handlePasswordLogin()">Sign in</button>
      <div id="pwd-error" class="error"></div>
    </div>

    <div class="footer">
      By continuing you agree to our
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
  document.getElementById("email-input").focus();
}
function showPasswordStep() {
  document.getElementById("email-step").style.display = "none";
  document.getElementById("code-step").style.display = "none";
  document.getElementById("password-step").style.display = "block";
  document.getElementById("username").focus();
}
function showCodeStep(email) {
  document.getElementById("email-step").style.display = "none";
  document.getElementById("code-step").style.display = "block";
  document.getElementById("password-step").style.display = "none";
  document.getElementById("code-hint").textContent =
    "We sent a 6-digit code to " + email + ". It expires in 10 minutes.";
  document.getElementById("code-input").focus();
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
      errEl.textContent = "Email sign-in coming soon — please use Google, Yandex, or password.";
      errEl.style.display = "block";
    } else {
      errEl.textContent = "Could not send code. Please try Google or Yandex instead.";
      errEl.style.display = "block";
    }
  } catch {
    errEl.textContent = "Network error — please try again.";
    errEl.style.display = "block";
  }
}

async function handleVerifyCode() {
  const email = document.getElementById("email-input").value.trim();
  const code  = document.getElementById("code-input").value.trim();
  const errEl = document.getElementById("code-error");
  errEl.style.display = "none";
  if (code.length < 6) {
    errEl.textContent = "Please enter the full 6-digit code.";
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
    if (res.ok) {
      window.location.href = returnTo;
    } else {
      errEl.textContent = "Incorrect or expired code — please try again.";
      errEl.style.display = "block";
    }
  } catch {
    errEl.textContent = "Network error — please try again.";
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
  if (res.ok) {
    window.location.href = returnTo;
  } else {
    errEl.textContent = "Incorrect username or password.";
    errEl.style.display = "block";
  }
}

document.addEventListener("keydown", e => {
  if (e.key !== "Enter") return;
  if (document.getElementById("code-step").style.display === "block")     handleVerifyCode();
  else if (document.getElementById("password-step").style.display === "block") handlePasswordLogin();
  else handleGetCode();
});
</script>
</body>
</html>`);
});
// ...
registerMagicCodeRoutes(app);
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
