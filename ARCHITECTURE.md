# MEH Moscow — Multi-App Architecture

## Three repositories, three Railway services, two Vercel frontends

```
┌─────────────────────────────────────────────────────────────────┐
│                        USERS                                     │
│                                                                  │
│   expatevents.vercel.app          games-in-english.vercel.app   │
│   (React, Vercel CDN)             (React, Vercel CDN)           │
└────────────┬──────────────────────────────┬─────────────────────┘
             │ /api/auth/*                   │ /api/auth/*
             │ /api/user                     │ /api/user
             ▼                               ▼
┌────────────────────────────────────────────────────────────────┐
│              AUTH SERVICE  (Railway)                            │
│              github.com/K31thNZ/meh-auth                       │
│                                                                  │
│  Strategies:  Google · Yandex · Telegram · Apple · Passkey     │
│  Routes:      /api/auth/* · /api/user · /api/notifications     │
│  Database:    Neon — users, sessions, notifications,           │
│               availability, interests                           │
└──────────────┬─────────────────────────────┬───────────────────┘
               │ /api/events/*               │ /api/games/*
               │ /api/availability/*         │ /api/nominations/*
               ▼                             ▼
┌──────────────────────────┐   ┌──────────────────────────────────┐
│  EXPAT EVENTS (Railway)  │   │  GAMES IN ENGLISH (Railway)      │
│  github.com/K31thNZ/     │   │  github.com/K31thNZ/MRDC         │
│  Event-Hub               │   │                                   │
│                          │   │  Game library · nominations       │
│  Events · RSVP           │   │  Voting · dice points            │
│  Categories · map        │   │  Seat reservations               │
│  Telegram bot            │   │  Telegram bot                    │
│  Neon DB (events only)   │   │  Neon DB (games only)            │
└──────────────────────────┘   └──────────────────────────────────┘
```

## How auth works across independent brands

1. User visits expatevents.vercel.app — clicks "Sign in with Google"
2. Frontend redirects to auth-service.up.railway.app/api/auth/google
3. Auth service handles the OAuth dance with Google
4. On success, auth service sets a session cookie and redirects back to ExpatEvents
5. ExpatEvents frontend calls /api/user on the auth service to get user details
6. ExpatEvents backend receives requests with the session — calls auth service to validate

The key insight: the session cookie is set on the AUTH SERVICE domain, not on each app.
Each app backend validates the session by calling the auth service, not by managing it itself.

## Three GitHub repos

| Repo | Purpose | Railway service | Vercel |
|---|---|---|---|
| K31thNZ/meh-auth (NEW) | Shared auth for all apps | meh-auth.up.railway.app | — |
| K31thNZ/Event-Hub | ExpatEvents backend + frontend | expat-events.up.railway.app | expatevents.vercel.app |
| K31thNZ/MRDC | Games in English backend + frontend | games-ie.up.railway.app | games-in-english.vercel.app |

## Adding new auth providers later

Everything lives in meh-auth/server/auth.ts. To add a new provider:
1. npm install passport-[provider]
2. Add strategy to auth.ts
3. Add /api/auth/[provider] and /api/auth/[provider]/callback routes
4. Add button to the shared login page component
5. Both apps get it immediately — zero changes to Event-Hub or MRDC

Passkey / WebAuthn is already structured for in auth.ts using @simplewebauthn/server.
Apple Sign In uses passport-apple — requires Apple Developer account ($99/yr).
