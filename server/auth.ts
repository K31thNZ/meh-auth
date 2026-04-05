// server/auth.ts
// All authentication strategies for the MEH platform.
// Google, Yandex, Telegram, local username/password.
// Apple and Passkey are stubbed — uncomment when credentials are ready.

import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import { Strategy as YandexStrategy } from "passport-yandex";
import { scrypt, randomBytes, timingSafeEqual, createHash, createHmac } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import type { Express } from "express";

const scryptAsync = promisify(scrypt);

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

export function setupPassport() {
  // ── Serialization ──────────────────────────────────────────────────────
  passport.serializeUser((user: any, done) => done(null, user.id));
  passport.deserializeUser(async (id: number, done) => {
    try {
      done(null, await storage.getUser(id) ?? false);
    } catch (err) {
      done(err);
    }
  });

  // ── Local ───────────────────────────────────────────────────────────────
  passport.use(new LocalStrategy(async (username, password, done) => {
    try {
      const user = await storage.getUserByUsername(username);
      if (!user || !user.password) return done(null, false);
      if (!(await comparePasswords(password, user.password))) return done(null, false);
      return done(null, user);
    } catch (err) { return done(err); }
  }));

  // ── Google ──────────────────────────────────────────────────────────────
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    passport.use(new GoogleStrategy({
      clientID:     process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL:  `${process.env.AUTH_SERVICE_URL}/api/auth/google/callback`,
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
          username:    await uniqueUsername(slugify(profile.displayName ?? email ?? `g_${profile.id}`)),
          password:    null,
          googleId:    profile.id,
          displayName: profile.displayName,
          avatarUrl:   profile.photos?.[0]?.value,
          email,
        });
        return done(null, user);
      } catch (err) { return done(err as Error); }
    }));
  }

  // ── Yandex ──────────────────────────────────────────────────────────────
  if (process.env.YANDEX_CLIENT_ID && process.env.YANDEX_CLIENT_SECRET) {
    passport.use(new YandexStrategy({
      clientID:     process.env.YANDEX_CLIENT_ID,
      clientSecret: process.env.YANDEX_CLIENT_SECRET,
      callbackURL:  `${process.env.AUTH_SERVICE_URL}/api/auth/yandex/callback`,
    }, async (_at, _rt, profile, done) => {
      try {
        let user = await storage.getUserByYandexId(profile.id);
        if (user) return done(null, user);
        const email = (profile as any).emails?.[0]?.value;
        if (email) {
          user = await storage.getUserByEmail(email);
          if (user) {
            user = await storage.updateUser(user.id, { yandexId: profile.id });
            return done(null, user!);
          }
        }
        user = await storage.createUser({
          username:    await uniqueUsername(slugify(profile.displayName ?? email ?? `y_${profile.id}`)),
          password:    null,
          yandexId:    profile.id,
          displayName: profile.displayName,
          avatarUrl:   (profile as any).photos?.[0]?.value,
          email,
        });
        return done(null, user);
      } catch (err) { return done(err as Error); }
    }));
  }

  // ── Apple (uncomment when credentials are ready) ───────────────────────
  // import AppleStrategy from "passport-apple";
  // passport.use(new AppleStrategy({
  //   clientID:         process.env.APPLE_CLIENT_ID!,
  //   teamID:           process.env.APPLE_TEAM_ID!,
  //   keyID:            process.env.APPLE_KEY_ID!,
  //   privateKeyString: process.env.APPLE_PRIVATE_KEY!,
  //   callbackURL:      `${process.env.AUTH_SERVICE_URL}/api/auth/apple/callback`,
  //   scope:            ["name", "email"],
  // }, async (_at, _rt, _it, profile, done) => { ... }));
}

// ── Register all auth routes ───────────────────────────────────────────────
export function registerAuthRoutes(app: Express) {
  app.use(passport.initialize());
  app.use(passport.session());

  // ── Current user ─────────────────────────────────────────────────────────
  app.get("/api/user", (req, res) => {
    res.json(req.isAuthenticated() ? sanitize(req.user as any) : null);
  });

  // ── Register ──────────────────────────────────────────────────────────────
  app.post("/api/auth/register", async (req, res, next) => {
    try {
      if (await storage.getUserByUsername(req.body.username)) {
        return res.status(400).json({ error: "Username already taken" });
      }
      const user = await storage.createUser({
        ...req.body,
        password: await hashPassword(req.body.password),
      });
      req.login(user, err => err ? next(err) : res.json(sanitize(user)));
    } catch (err) { next(err); }
  });

  // ── Local login ───────────────────────────────────────────────────────────
  app.post("/api/auth/login",
    passport.authenticate("local", { failWithError: true }),
    (req, res) => res.json(sanitize(req.user as any)),
    (err: any, req: any, res: any, next: any) => {
      res.status(401).json({ error: "Incorrect username or password" });
    }
  );

  // ── Logout ────────────────────────────────────────────────────────────────
  app.post("/api/auth/logout", (req, res, next) => {
    req.logout(err => err ? next(err) : res.json({ ok: true }));
  });

  // ── Google ────────────────────────────────────────────────────────────────
  app.get("/api/auth/google", (req, res, next) => {
    storeReturnTo(req);
    passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
  });

  app.get("/api/auth/google/callback",
    passport.authenticate("google", { failureRedirect: buildFailureUrl("google") }),
    (req, res) => res.redirect(getReturnTo(req))
  );

  // ── Yandex ────────────────────────────────────────────────────────────────
  app.get("/api/auth/yandex", (req, res, next) => {
    storeReturnTo(req);
    passport.authenticate("yandex")(req, res, next);
  });

  app.get("/api/auth/yandex/callback",
    passport.authenticate("yandex", { failureRedirect: buildFailureUrl("yandex") }),
    (req, res) => res.redirect(getReturnTo(req))
  );

  // ── Telegram Login Widget ─────────────────────────────────────────────────
  app.get("/api/auth/telegram", async (req, res, next) => {
    try {
      const data = req.query as Record<string, string>;
      if (!verifyTelegramLogin(data, process.env.TELEGRAM_BOT_TOKEN ?? "")) {
        return res.status(401).json({ error: "Invalid Telegram auth data" });
      }
      let user = await storage.getUserByTelegramId(data.id);
      if (!user) {
        user = await storage.createUser({
          username:    await uniqueUsername(data.username ?? `tg_${data.id}`),
          password:    null,
          telegramId:  data.id,
          displayName: [data.first_name, data.last_name].filter(Boolean).join(" ") || null,
          avatarUrl:   data.photo_url ?? null,
        });
      }
      req.login(user, err => {
        if (err) return next(err);
        let returnTo = (req.session as any).returnTo ?? getAllowedOrigins()[0];
        delete (req.session as any).returnTo;
        // Add justLoggedIn flag for Telegram redirect as well
        const separator = returnTo.includes('?') ? '&' : '?';
        returnTo = `${returnTo}${separator}justLoggedIn=true`;
        res.redirect(returnTo);
      });
    } catch (err) { next(err); }
  });

  // ── Apple (uncomment when credentials are ready) ─────────────────────────
  // app.get("/api/auth/apple", passport.authenticate("apple"));
  // app.post("/api/auth/apple/callback",
  //   passport.authenticate("apple", { failureRedirect: buildFailureUrl("apple") }),
  //   (req, res) => res.redirect(getReturnTo(req))
  // );

  // ── User preferences ──────────────────────────────────────────────────────
  app.patch("/api/user/interests", requireAuth, async (req, res, next) => {
    try {
      const user = await storage.updateUser((req.user as any).id, { interests: req.body.interests });
      res.json(sanitize(user!));
    } catch (err) { next(err); }
  });

  app.patch("/api/user/profile", requireAuth, async (req, res, next) => {
  try {
    const { displayName, avatarUrl, telegramId } = req.body;
    const updates: Record<string, any> = {};
    if (displayName !== undefined) updates.displayName = displayName;
    if (avatarUrl !== undefined) updates.avatarUrl = avatarUrl;
    if (telegramId !== undefined) {
      const tid = String(telegramId).trim();
      if (!/^\d+$/.test(tid)) {
        return res.status(400).json({ error: "telegramId must be a numeric string" });
      }
      updates.telegramId = tid;
    }
    const user = await storage.updateUser((req.user as any).id, updates);
    res.json(sanitize(user!));
  } catch (err) { next(err); }
});
  // ── Availability ──────────────────────────────────────────────────────────
  app.get("/api/availability", requireAuth, async (req, res) => {
    res.json(await storage.getUserSlots((req.user as any).id));
  });

  app.put("/api/availability", requireAuth, async (req, res, next) => {
    try {
      await storage.setUserSlots((req.user as any).id, req.body.slots);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/api/availability/matches", requireAuth, async (req, res) => {
    res.json(await storage.getUserMatches((req.user as any).id));
  });

  // ── Notifications ─────────────────────────────────────────────────────────
  app.get("/api/notifications", requireAuth, async (req, res) => {
    const appScope = req.query.app as string | undefined;
    res.json(await storage.getUserNotifications((req.user as any).id, appScope));
  });

  app.post("/api/notifications/read", requireAuth, async (req, res, next) => {
    try {
      await storage.markNotificationsRead((req.user as any).id);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });

  app.get("/api/notifications/count", requireAuth, async (req, res) => {
    const appScope = req.query.app as string | undefined;
    const count = await storage.getUnreadCount((req.user as any).id, appScope);
    res.json({ count });
  });

  // ── Host registry (public read) ───────────────────────────────────────────
  app.get("/api/hosts", async (_req, res) => {
    res.json(await storage.getApprovedHosts());
  });

  app.get("/api/hosts/:slug", async (req, res) => {
    const host = await storage.getHostBySlug(req.params.slug);
    if (!host || host.status !== "approved") return res.status(404).json({ error: "Not found" });
    res.json(host);
  });

  // ── Host applications ─────────────────────────────────────────────────────
  app.post("/api/host-applications", requireAuth, async (req, res, next) => {
    try {
      const existing = await storage.getHostBySlug(req.body.slug);
      if (existing) return res.status(400).json({ error: "That slug is already taken" });
      const app2 = await storage.createApplication({
        ...req.body,
        applicantId: (req.user as any).id,
        status: "pending",
      });
      res.status(201).json(app2);
    } catch (err) { next(err); }
  });

  // ── Admin routes ──────────────────────────────────────────────────────────
  app.get("/api/admin/applications", requireAdmin, async (_req, res) => {
    res.json(await storage.getPendingApplications());
  });

  app.post("/api/admin/applications/:id/approve", requireAdmin, async (req, res, next) => {
    try {
      const host = await storage.approveApplication(
        parseInt(req.params.id),
        (req.user as any).id
      );
      res.json(host);
    } catch (err) { next(err); }
  });

  app.post("/api/admin/applications/:id/reject", requireAdmin, async (req, res, next) => {
    try {
      await storage.rejectApplication(parseInt(req.params.id), req.body.notes);
      res.json({ ok: true });
    } catch (err) { next(err); }
  });
}

// ── Middleware ─────────────────────────────────────────────────────────────
export function requireAuth(req: any, res: any, next: any) {
  if (req.isAuthenticated()) return next();
  res.status(401).json({ error: "Not authenticated" });
}

export function requireAdmin(req: any, res: any, next: any) {
  if (req.isAuthenticated() && (req.user as any).role === "admin") return next();
  res.status(403).json({ error: "Admins only" });
}

// ── Helpers ────────────────────────────────────────────────────────────────
function sanitize(user: any) {
  const { password, ...safe } = user;
  return safe;
}

function slugify(str: string) {
  return str.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "").slice(0, 32) || "user";
}

async function uniqueUsername(base: string): Promise<string> {
  let name = base;
  let i = 1;
  while (await storage.getUserByUsername(name)) name = `${base}_${i++}`;
  return name;
}

function getAllowedOrigins(): string[] {
  return (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);
}

function storeReturnTo(req: any) {
  const returnTo = req.query.returnTo as string;
  const allowed = getAllowedOrigins();
  if (returnTo && allowed.some(o => returnTo.startsWith(o))) {
    (req.session as any).returnTo = returnTo;
  } else {
    (req.session as any).returnTo = allowed[0] ?? "/";
  }
}

function getReturnTo(req: any): string {
  let r = (req.session as any).returnTo ?? getAllowedOrigins()[0] ?? "/";
  delete (req.session as any).returnTo;
  // Add justLoggedIn flag
  const separator = r.includes('?') ? '&' : '?';
  r = `${r}${separator}justLoggedIn=true`;
  return r;
}

function buildFailureUrl(provider: string): string {
  const origins = getAllowedOrigins();
  const base = origins[0] ?? "/";
  return `${base}/login?error=${provider}`;
}

function verifyTelegramLogin(data: Record<string, string>, botToken: string): boolean {
  if (!botToken) return false;
  const { hash, ...rest } = data;
  if (!hash) return false;
  if (Date.now() / 1000 - parseInt(rest.auth_date ?? "0") > 86400) return false;
  const checkString = Object.keys(rest).sort().map(k => `${k}=${rest[k]}`).join("\n");
  const secretKey = createHash("sha256").update(botToken).digest();
  return createHmac("sha256", secretKey).update(checkString).digest("hex") === hash;
}
