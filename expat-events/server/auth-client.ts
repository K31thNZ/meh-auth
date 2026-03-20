// shared/auth-client.ts
// Drop this file into BOTH repos: Event-Hub and MRDC.
// It replaces direct auth calls — everything goes through the auth service.
//
// Usage in your Express server:
//   import { requireAuth, getUser } from "./auth-client";
//   app.get("/api/events", requireAuth, handler);

import type { Request, Response, NextFunction } from "express";

const AUTH_URL = process.env.AUTH_SERVICE_URL ?? "https://meh-auth.up.railway.app";

// ── Validate session by calling the auth service ─────────────────────────
// Call this on any protected route to get the current user.
export async function getUser(req: Request): Promise<any | null> {
  try {
    const res = await fetch(`${AUTH_URL}/api/user`, {
      headers: {
        // Forward the session cookie from the incoming request
        cookie: req.headers.cookie ?? "",
      },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ── Express middleware — attach user to req, reject if not logged in ──────
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  (req as any).user = user;
  next();
}

// ── Optional auth — attach user if logged in, continue either way ─────────
export async function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  (req as any).user = await getUser(req);
  next();
}
