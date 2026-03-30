# meh-auth

Centralized authentication service for the MEH (Moscow Expat Hub) platform. Used by ExpatEvents and Games in English.

## Architecture

- **Runtime**: Node.js 20 with TypeScript (compiled via `tsx` in dev, `esbuild` in prod)
- **Framework**: Express 5
- **Database**: PostgreSQL via Drizzle ORM
- **Session store**: `connect-pg-simple` (sessions in DB)
- **Auth strategies**: Local (username/password), Google OAuth2, Yandex OAuth2, Telegram Login Widget, Magic Code (email OTP via Resend)

## Project Structure

```
server/
  index.ts          # Entry point, Express app setup, port 5000
  auth.ts           # Passport strategies + all auth routes
  storage.ts        # Database access layer
  db.ts             # Drizzle DB instance
  magic-code.ts     # Email OTP routes (requires RESEND_API_KEY)
  bot.ts            # Telegram bot (requires TELEGRAM_BOT_TOKEN)
  matcher.ts        # Scheduled availability matcher
  notify-routes.ts  # Notification API routes
shared/
  schema.ts         # Drizzle schema (users, sessions, availability, notifications, hosts)
  categories.ts     # Event category definitions
```

## Running

- **Dev**: `npm run dev` (uses `tsx` to run TypeScript directly)
- **Build**: `npm run build` (bundles to `dist/index.cjs` via esbuild)
- **Production**: `node dist/index.cjs`
- **DB schema push**: `npm run db:push`

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SESSION_SECRET` | Yes | Express session secret |
| `PORT` | No | Port (default 3000, set to 5000 in Replit) |
| `NODE_ENV` | No | `development` or `production` |
| `AUTH_SERVICE_URL` | No | Public URL of this service (for OAuth callbacks) |
| `ALLOWED_ORIGINS` | No | Comma-separated list of frontend URLs |
| `COOKIE_DOMAIN` | No | Cookie domain (e.g. `.meh-moscow.com`) |
| `GOOGLE_CLIENT_ID` | No | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | No | Google OAuth client secret |
| `YANDEX_CLIENT_ID` | No | Yandex OAuth client ID |
| `YANDEX_CLIENT_SECRET` | No | Yandex OAuth client secret |
| `TELEGRAM_BOT_TOKEN` | No | Telegram bot token |
| `TELEGRAM_BOT_NAME` | No | Telegram bot username (for login widget) |
| `RESEND_API_KEY` | No | Resend API key for magic code emails |
| `ADMIN_TELEGRAM_ID` | No | Admin's Telegram ID for admin bot notifications |

## Key Routes

- `GET /ping` — Health check
- `GET /health` — Detailed health info
- `GET /login` — Login page (HTML)
- `GET /terms` — Terms of Use page
- `GET /privacy` — Privacy Policy page
- `GET /api/user` — Current authenticated user
- `POST /api/auth/login` — Local login
- `POST /api/auth/register` — Register
- `POST /api/auth/logout` — Logout
- `GET /api/auth/google` — Google OAuth
- `GET /api/auth/yandex` — Yandex OAuth
- `GET /api/auth/telegram` — Telegram Login Widget callback
- `POST /api/auth/magic-code` — Send OTP email
- `POST /api/auth/verify-code` — Verify OTP

## Workflow

The app runs on port 5000 in the Replit environment via the "Start application" workflow using `npm run dev`.
