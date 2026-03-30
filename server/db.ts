// server/db.ts
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "@shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is not set — add it to your environment variables");
}

// The pg driver doesn't support channel_binding=require (Neon includes it) — strip it
const connectionString = process.env.DATABASE_URL
  .replace(/[&?]channel_binding=[^&]*/g, "");

const pool = new pg.Pool({
  connectionString,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });
