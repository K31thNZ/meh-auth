// auth-service/server/auth.ts
// Shared authentication service for all MEH Moscow apps.
// Handles: Google, Yandex, Telegram, Apple OAuth + Passkey (WebAuthn) foundation.
// Extensible: add new providers here — all apps get them immediately.
//
// Install:
//   npm install passport passport-google-oauth20 passport-yandex passport-apple
//   npm install @simplewebauthn/server express-session connect-pg-simple cors
//   npm install -D @types/passport @types/passport-google-oauth20 @types/express

import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as YandexStrategy } from "passport-yandex";
import { scrypt, randomBytes, timingSafeEqual, createHash, createHmac } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import type { Express } from "express";
import cors from "cors";
import session from "express-session";
import connectPg from "connect-pg-simple";

const scryptAsync = promisify(scrypt);
const PgSession = connectPg(session);

// ── Allowed origins — add each new frontend here ─────────────────────────
const ALLOWED_ORIGINS = [
  process.env.EXPAT_EVENTS_URL ?? "https://expatevents.vercel.app",
  process.env.GAMES_URL ?? "https://games-in-english.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
];

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express) {
  // ── Trust proxy (required for Railway) ──────────────────────────────────
  app.set("trust proxy", 1);

  // ── CORS — allow all registered frontends with credentials ───────────────
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || ALLOWED_ORIGINS.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error(`CORS: origin ${origin} not allowed`));
      }
    },
    credentials: true,
  }));

  // ── Session ──────────────────────────────────────────────────────────────
  app.use(session({
    store: new PgSession({ conString: process.env.DATABASE_URL }),
    secret: process.env.SESSION_SECRET!,
    resave: false,
    saveUninitialized: false,
    name: "meh.sid",
    cookie: {
      secure: process.env.NODE_ENV === "production",
      sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      domain: process.env.NODE_ENV === "production"
        ? ".railway.app"  // shared across all .railway.app subdomains
        : undefined,
    },
  }));

  // ── Passport serialization ───────────────────────────────────────────────
  passport.serializeUser((user: any, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      done(null, await storage.getUser(id));
    } catch (err) {
      done(err);
    }
  });

  // ── LOCAL strategy ───────────────────────────────────────────────────────
  passport.use(new LocalStrategy(async (username, password, done) => {
    try {
      const user = await storage.getUserByUsername(username);
      if (!user || !user.password) return done(null, false);
      if (!(await comparePasswords(password, user.password))) return done(null, false);
      return done(null, user);
    } catch (err) { return done(err); }
  }));

  // ── GOOGLE strategy ──────────────────────────────────────────────────────
  passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID!,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    callbackURL: `${process.env.AUTH_SERVICE_URL}/api/auth/google/callback`,
  }, async (_at, _rt, profile, done) => {
    try {
      let user = await storage.getUserByGoogleId(profile.id);
      if (user) return done(null, user);

      const email = profile.emails?.[0]?.value;
      if (email) {
        user = await storage.getUserByEmail(email);
        if (user) {
          user = await storage.updateUser(user.id, { googleId: profile.id });
          return done(null, user!);
        }
      }
      user = await storage.createUser({
        username: await uniqueUsername(slugify(profile.displayName ?? email ?? `g_${profile.id}`)),
        password: null,
        googleId: profile.id,
        displayName: profile.displayName,
        avatarUrl: profile.photos?.[0]?.value,
        email,
      });
      return done(null, user);
    } catch (err) { return done(err as Error); }
  }));

  // ── YANDEX strategy ──────────────────────────────────────────────────────
  // Yandex is heavily used in Russia — important for Moscow expats whose
  // Russian colleagues and landlords use Yandex accounts.
  passport.use(new YandexStrategy({
    clientID: process.env.YANDEX_CLIENT_ID!,
    clientSecret: process.env.YANDEX_CLIENT_SECRET!,
    callbackURL: `${process.env.AUTH_SERVICE_URL}/api/auth/yandex/callback`,
  }, async (_at, _rt, profile, done) => {
    try {
      let user = await storage.getUserByYandexId(profile.id);
      if (user) return done(null, user);

      const email = profile.emails?.[0]?.value;
      if (email) {
        user = await storage.getUserByEmail(email);
        if (user) {
          user = await storage.updateUser(user.id, { yandexId: profile.id });
          return done(null, user!);
        }
      }
      user = await storage.createUser({
        username: await uniqueUsername(slugify(profile.displayName ?? email ?? `y_${profile.id}`)),
        password: null,
        yandexId: profile.id,
        displayName: profile.displayName,
        avatarUrl: profile.photos?.[0]?.value,
        email,
      });
      return done(null, user);
    } catch (err) { return done(err as Error); }
  }));

  app.use(passport.initialize());
  app.use(passport.session());

  // ────────────────────────────────────────────────────────────────────────
  // AUTH ROUTES
  // ────────────────────────────────────────────────────────────────────────

  // ── Current user ─────────────────────────────────────────────────────────
  app.get("/api/user", (req, res) => {
    res.json(req.isAuthenticated() ? sanitizeUser(req.user as any) : null);
  });

  // ── Local register ────────────────────────────────────────────────────────
  app.post("/api/auth/register", async (req, res, next) => {
    try {
      if (await storage.getUserByUsername(req.body.username)) {
        return res.status(400).json({ error: "Username taken" });
      }
      const user = await storage.createUser({
        ...req.body,
        password: await hashPassword(req.body.password),
      });
      req.login(user, (err) => err ? next(err) : res.json(sanitizeUser(user)));
    } catch (err) { next(err); }
  });

  // ── Local login ───────────────────────────────────────────────────────────
  app.post("/api/auth/login",
    passport.authenticate("local"),
    (req, res) => res.json(sanitizeUser(req.user as any))
  );

  // ── Logout ────────────────────────────────────────────────────────────────
  app.post("/api/auth/logout", (req, res, next) => {
    req.logout((err) => err ? next(err) : res.json({ ok: true }));
  });

  // ── Google ────────────────────────────────────────────────────────────────
  app.get("/api/auth/google",
    (req, res, next) => {
      // Store which app to redirect back to after auth
      (req.session as any).returnTo = req.query.returnTo ?? process.env.EXPAT_EVENTS_URL;
      next();
    },
    passport.authenticate("google", { scope: ["profile", "email"] })
  );

  app.get("/api/auth/google/callback",
    passport.authenticate("google", { failureRedirect: "/login?error=google" }),
    (req, res) => {
      const returnTo = (req.session as any).returnTo ?? process.env.EXPAT_EVENTS_URL;
      res.redirect(returnTo as string);
    }
  );

  // ── Yandex ────────────────────────────────────────────────────────────────
  app.get("/api/auth/yandex",
    (req, res, next) => {
      (req.session as any).returnTo = req.query.returnTo ?? process.env.EXPAT_EVENTS_URL;
      next();
    },
    passport.authenticate("yandex")
  );

  app.get("/api/auth/yandex/callback",
    passport.authenticate("yandex", { failureRedirect: "/login?error=yandex" }),
    (req, res) => {
      const returnTo = (req.session as any).returnTo ?? process.env.EXPAT_EVENTS_URL;
      res.redirect(returnTo as string);
    }
  );

  // ── Telegram Login Widget ─────────────────────────────────────────────────
  app.get("/api/auth/telegram", async (req, res, next) => {
    try {
      const data = req.query as Record<string, string>;
      if (!verifyTelegramLogin(data, process.env.TELEGRAM_BOT_TOKEN!)) {
        return res.status(401).json({ error: "Invalid Telegram auth" });
      }

      let user = await storage.getUserByTelegramId(data.id);
      if (!user) {
        user = await storage.createUser({
          username: await uniqueUsername(data.username ?? `tg_${data.id}`),
          password: null,
          telegramId: data.id,
          displayName: [data.first_name, data.last_name].filter(Boolean).join(" "),
          avatarUrl: data.photo_url ?? null,
        });
      }

      req.login(user, (err) => {
        if (err) return next(err);
        const returnTo = (req.session as any).returnTo ?? process.env.EXPAT_EVENTS_URL;
        res.redirect(returnTo as string);
      });
    } catch (err) { next(err); }
  });

  // ── Apple Sign In ─────────────────────────────────────────────────────────
  // Requires: npm install passport-apple
  // Requires: Apple Developer account + Services ID + private key (.p8 file)
  // Uncomment when you have Apple credentials:
  //
  // import AppleStrategy from "passport-apple";
  // passport.use(new AppleStrategy({
  //   clientID: process.env.APPLE_CLIENT_ID!,          // your Services ID
  //   teamID: process.env.APPLE_TEAM_ID!,
  //   keyID: process.env.APPLE_KEY_ID!,
  //   privateKeyString: process.env.APPLE_PRIVATE_KEY!, // contents of .p8 file
  //   callbackURL: `${process.env.AUTH_SERVICE_URL}/api/auth/apple/callback`,
  //   scope: ["name", "email"],
  // }, async (_at, _rt, _it, profile, done) => {
  //   // Apple only sends name on FIRST login — must persist it
  //   try {
  //     let user = await storage.getUserByAppleId(profile.id);
  //     if (!user) user = await storage.createUser({ appleId: profile.id, ... });
  //     return done(null, user);
  //   } catch (err) { return done(err as Error); }
  // }));
  //
  // app.get("/api/auth/apple", passport.authenticate("apple"));
  // app.post("/api/auth/apple/callback",   // NOTE: Apple uses POST not GET
  //   passport.authenticate("apple", { failureRedirect: "/login?error=apple" }),
  //   (req, res) => res.redirect(process.env.EXPAT_EVENTS_URL!)
  // );

  // ── Passkey / WebAuthn ────────────────────────────────────────────────────
  // Requires: npm install @simplewebauthn/server @simplewebauthn/browser
  // This is the foundation — full implementation requires storing credentials
  // per user in a passkey_credentials table.
  //
  // app.get("/api/auth/passkey/register/options", requireAuth, async (req, res) => {
  //   const { generateRegistrationOptions } = await import("@simplewebauthn/server");
  //   const options = await generateRegistrationOptions({
  //     rpName: "MEH Moscow",
  //     rpID: new URL(process.env.AUTH_SERVICE_URL!).hostname,
  //     userID: String((req.user as any).id),
  //     userName: (req.user as any).username,
  //   });
  //   (req.session as any).passkeyChallenge = options.challenge;
  //   res.json(options);
  // });
  //
  // app.post("/api/auth/passkey/register/verify", requireAuth, async (req, res) => {
  //   const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
  //   const verification = await verifyRegistrationResponse({ ... });
  //   if (verification.verified) {
  //     await storage.savePasskeyCredential((req.user as any).id, verification.registrationInfo);
  //   }
  //   res.json({ verified: verification.verified });
  // });

  // ── User preferences ──────────────────────────────────────────────────────
  app.patch("/api/user/interests", requireAuth, async (req, res, next) => {
    try {
      const user = await storage.updateUser((req.user as any).id, { interests: req.body.interests });
      res.json(sanitizeUser(user!));
    } catch (err) { next(err); }
  });

  app.put("/api/user/availability", requireAuth, async (req, res, next) => {
    try {
      await storage.setUserSlots((req.user as any).id, req.body.slots);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/api/user/availability", requireAuth, async (req, res) => {
    res.json(await storage.getUserSlots((req.user as any).id));
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  app.get("/api/notifications", requireAuth, async (req, res) => {
    res.json(await storage.getUserNotifications((req.user as any).id));
  });

  app.post("/api/notifications/read", requireAuth, async (req, res, next) => {
    try {
      await storage.markNotificationsRead((req.user as any).id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

// ── Middleware ────────────────────────────────────────────────────────────
export function requireAuth(req: any, res: any, next: any) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Not authenticated" });
}

// ── Helpers ───────────────────────────────────────────────────────────────
function sanitizeUser(user: any) {
  const { password, ...safe } = user;
  return safe;
}

function slugify(str: string) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 32);
}

async function uniqueUsername(base: string): Promise<string> {
  let name = base || "user";
  let i = 1;
  while (await storage.getUserByUsername(name)) name = `${base}_${i++}`;
  return name;
}

function verifyTelegramLogin(data: Record<string, string>, botToken: string): boolean {
  const { hash, ...rest } = data;
  if (!hash) return false;
  if (Date.now() / 1000 - parseInt(rest.auth_date ?? "0") > 86400) return false;
  const checkString = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secretKey).update(checkString).digest("hex") === hash;
}
