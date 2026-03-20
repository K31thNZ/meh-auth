# Deployment Guide — Three-Service Architecture

## Overview: what you're deploying

```
3 Railway services:   meh-auth · expat-events · games-in-english
2 Vercel frontends:   expatevents.vercel.app · games-in-english.vercel.app
3 Neon databases:     meh-shared · expat-events-db · games-db
2 Telegram bots:      @ExpatEventsMoscowBot · @GamesInEnglishMoscowBot
```

---

## Step 1 — Create three Neon databases

Go to neon.tech, create three projects:

1. `meh-shared` — users, sessions, notifications, availability
2. `expat-events-db` — events, reservations, categories
3. `games-db` — games library, nominations, votes, dice

Copy each connection string. You'll need all three later.

---

## Step 2 — Create the meh-auth repo

This is a NEW GitHub repo. Create it at github.com/new → name: `meh-auth`

Copy the contents of `auth-service/` from this package into the new repo:
```
meh-auth/
├── server/
│   ├── index.ts
│   ├── auth.ts
│   └── storage.ts      ← create this (see note below)
├── shared/
│   └── schema.ts       ← users, sessions, notifications, availability tables
├── package.json
├── railway.toml        ← copy from mrdc-deploy package
└── tsconfig.json
```

For storage.ts — copy it from your MRDC repo's server/storage.ts and keep only the
user-related methods: getUser, getUserByUsername, getUserByEmail, getUserByGoogleId,
getUserByYandexId, getUserByTelegramId, createUser, updateUser, getUserSlots,
setUserSlots, getUserNotifications, markNotificationsRead, createNotification.

For schema.ts — keep only: users, sessions, availability_slots,
availability_matches, notifications tables.

Push to GitHub, then deploy to Railway (same process as mrdc-deploy guide):
- New Railway project → Deploy from GitHub → select meh-auth repo
- Set all variables from env-variables.md section 1
- Note your Railway URL: `https://meh-auth.up.railway.app`

Run migrations against the shared database:
```bash
DATABASE_URL="postgresql://..." npm run db:push
```

---

## Step 3 — Update Event-Hub repo (K31thNZ/Event-Hub)

Three files to add/update:

**Add** `server/auth-client.ts` from this package — replaces direct auth calls.

**Replace** `client/src/pages/login.tsx` with the one from this package.

**Replace** `vercel.json` with `expat-events/vercel.json` from this package.
Update the Railway URLs once you know them.

**Update** your Express routes — anywhere you have `requireAuth` middleware,
replace with the one from auth-client.ts:
```typescript
// BEFORE (in routes.ts):
import { requireAuth } from "./auth";

// AFTER:
import { requireAuth } from "./auth-client";
```

Push to GitHub. Vercel auto-deploys.

---

## Step 4 — Update MRDC repo (K31thNZ/MRDC)

Same three changes as Event-Hub:

**Add** `server/auth-client.ts` from this package.

**Replace** `client/src/pages/login.tsx` with the one from this package.

**Replace** `vercel.json` with `games-in-english/vercel.json` from this package.

**Update** requireAuth imports to use auth-client.ts.

Push to GitHub. Vercel auto-deploys.

---

## Step 5 — Deploy Event-Hub and MRDC to Railway

Each gets its OWN Railway service (not the same one as meh-auth):

**Event-Hub Railway service:**
- New Railway project → Deploy from GitHub → K31thNZ/Event-Hub
- Set variables from env-variables.md section 2
- railway.toml is already in that repo from the mrdc-deploy package

**MRDC Railway service:**
- New Railway project → Deploy from GitHub → K31thNZ/MRDC
- Set variables from env-variables.md section 3
- railway.toml is already in that repo

---

## Step 6 — Set Vercel environment variables

**expatevents.vercel.app:**
Vercel dashboard → Event-Hub project → Settings → Environment Variables:
- VITE_AUTH_URL = https://meh-auth.up.railway.app
- VITE_APP_NAME = ExpatEvents
- VITE_TELEGRAM_BOT_NAME = ExpatEventsMoscowBot

**games-in-english.vercel.app:**
Vercel dashboard → MRDC project → Settings → Environment Variables:
- VITE_AUTH_URL = https://meh-auth.up.railway.app
- VITE_APP_NAME = Games in English
- VITE_TELEGRAM_BOT_NAME = GamesInEnglishMoscowBot

Trigger redeploys on both after setting variables.

---

## Step 7 — Update OAuth redirect URIs

**Google Cloud Console** — add to your OAuth client:
```
https://meh-auth.up.railway.app/api/auth/google/callback
```

**Yandex OAuth** — set callback URL to:
```
https://meh-auth.up.railway.app/api/auth/yandex/callback
```

**Telegram @BotFather** — set domain for EACH bot:
```
/setdomain → expatevents.vercel.app      (for ExpatEvents bot)
/setdomain → games-in-english.vercel.app (for Games bot)
```

---

## Step 8 — Verify

Test this sequence for each app:

1. Visit the frontend → should load
2. Click "Continue with Google" → should complete OAuth and return logged in
3. Click "Continue with Yandex" → same
4. Click Telegram button → same
5. Check /api/user on the auth service → should return user object
6. Check app-specific routes → /api/events or /api/games → should work

---

## Adding Apple Sign In (when ready)

1. Apple Developer account → Certificates, Identifiers & Profiles → Services IDs
2. Create a Services ID (this is your APPLE_CLIENT_ID)
3. Enable "Sign in with Apple", add domain: meh-auth.up.railway.app
4. Add return URL: https://meh-auth.up.railway.app/api/auth/apple/callback
5. Create a key, download the .p8 file
6. Set the four APPLE_ env vars on meh-auth Railway
7. Uncomment the Apple strategy in auth-service/server/auth.ts
8. The Apple button on the login page is already there — it just works

---

## Adding Passkeys / iPhone passkey (when ready)

1. npm install @simplewebauthn/server @simplewebauthn/browser in meh-auth
2. Add a passkey_credentials table to the shared schema
3. Uncomment the passkey routes in auth.ts
4. Add the passkey registration UI to the profile page
5. The login page gets a "Use passkey" button alongside the OAuth options

No changes needed to Event-Hub or MRDC — auth is centralised.
