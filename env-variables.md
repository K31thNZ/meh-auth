# Environment Variables — All Three Services

---

## 1. meh-auth (Railway) — the auth service

| Variable | Value | Where to get it |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` | Neon — use the SHARED database |
| `SESSION_SECRET` | random 64-char string | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `NODE_ENV` | `production` | literal |
| `AUTH_SERVICE_URL` | `https://meh-auth.up.railway.app` | your Railway URL once deployed |
| `EXPAT_EVENTS_URL` | `https://expatevents.vercel.app` | your Vercel URL |
| `GAMES_URL` | `https://games-in-english.vercel.app` | your Vercel URL |
| `GOOGLE_CLIENT_ID` | `...apps.googleusercontent.com` | console.cloud.google.com |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-...` | same |
| `YANDEX_CLIENT_ID` | numeric app ID | oauth.yandex.com |
| `YANDEX_CLIENT_SECRET` | string | same |
| `TELEGRAM_BOT_TOKEN` | `123456:ABC...` | @BotFather |
| `APPLE_CLIENT_ID` | `com.yourcompany.app` | developer.apple.com (when ready) |
| `APPLE_TEAM_ID` | 10-char string | developer.apple.com |
| `APPLE_KEY_ID` | 10-char string | developer.apple.com |
| `APPLE_PRIVATE_KEY` | contents of .p8 file | developer.apple.com |

---

## 2. expat-events (Railway) — Event-Hub backend

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` | Neon — separate events database |
| `NODE_ENV` | `production` | |
| `AUTH_SERVICE_URL` | `https://meh-auth.up.railway.app` | points at auth service |
| `APP_URL` | `https://expatevents.vercel.app` | |
| `TELEGRAM_BOT_TOKEN` | ExpatEvents bot token | separate bot from Games |
| `YANDEX_GEOCODER_KEY` | from developer.tech.yandex.com | for venue lookup |

---

## 3. games-in-english (Railway) — MRDC backend

| Variable | Value | Notes |
|---|---|---|
| `DATABASE_URL` | `postgresql://...` | Neon — separate games database |
| `NODE_ENV` | `production` | |
| `AUTH_SERVICE_URL` | `https://meh-auth.up.railway.app` | same auth service |
| `APP_URL` | `https://games-in-english.vercel.app` | |
| `TELEGRAM_BOT_TOKEN` | Games in English bot token | separate bot from ExpatEvents |
| `YANDEX_GEOCODER_KEY` | from developer.tech.yandex.com | |

---

## 4. expatevents.vercel.app (Vercel) — Event-Hub frontend

| Variable | Value |
|---|---|
| `VITE_AUTH_URL` | `https://meh-auth.up.railway.app` |
| `VITE_APP_NAME` | `ExpatEvents` |
| `VITE_TELEGRAM_BOT_NAME` | ExpatEvents bot username (without @) |

---

## 5. games-in-english.vercel.app (Vercel) — MRDC frontend

| Variable | Value |
|---|---|
| `VITE_AUTH_URL` | `https://meh-auth.up.railway.app` |
| `VITE_APP_NAME` | `Games in English` |
| `VITE_TELEGRAM_BOT_NAME` | Games bot username (without @) |

---

## Databases — how many do you need?

You need ONE shared database for users/auth and TWO app databases for domain data:

| Database | Used by | Contains |
|---|---|---|
| `meh-shared` | meh-auth | users, sessions, notifications, availability, interests |
| `expat-events-db` | expat-events Railway | events, reservations, categories |
| `games-db` | games-in-english Railway | games library, nominations, votes, dice |

All three are free Neon projects. Create them at neon.tech.

---

## Yandex OAuth setup

1. Go to oauth.yandex.com → Create app
2. Callback URL: `https://meh-auth.up.railway.app/api/auth/yandex/callback`
3. Requested permissions: Login, Email address, Profile picture
4. Copy App ID (= YANDEX_CLIENT_ID) and App password (= YANDEX_CLIENT_SECRET)

---

## Google OAuth — update redirect URIs

Add to your existing OAuth client in console.cloud.google.com:
```
https://meh-auth.up.railway.app/api/auth/google/callback
```

Remove the old Replit callback URL if it's still there.

---

## Two Telegram bots

Create two bots with @BotFather — one per app:

Bot 1 — ExpatEvents:
```
/newbot → ExpatEvents Moscow → @ExpatEventsMoscowBot
/setdomain → expatevents.vercel.app
```

Bot 2 — Games in English:
```
/newbot → Games in English Moscow → @GamesInEnglishMoscowBot
/setdomain → games-in-english.vercel.app
```
