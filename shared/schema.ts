// shared/schema.ts
// The shared user layer — owned by meh-auth.
// All other MEH services (Event-Hub, future hubs) read users from here
// by calling the auth service API, not by connecting to this database directly.

import {
  pgTable, serial, integer, text, boolean, timestamp, real,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { pgTable, text, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { users } from "./models/auth"; // adjust import path if needed

export const telegramLinkTokens = pgTable("telegram_link_tokens", {
  token:     text("token").primaryKey(),        // UUID without dashes (32 chars)
  userId:    integer("user_id")
               .references(() => users.id, { onDelete: "cascade" })
               .notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  used:      boolean("used").default(false).notNull(),
});

// ── Users ─────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id:          serial("id").primaryKey(),
  username:    text("username").notNull().unique(),
  password:    text("password"),                        // null for OAuth users
  role:        text("role").notNull().default("member"), // "member" | "admin"
  displayName: text("display_name"),
  avatarUrl:   text("avatar_url"),
  email:       text("email").unique(),

  // OAuth providers — add new ones here, never in other services
  googleId:   text("google_id").unique(),
  yandexId:   text("yandex_id").unique(),
  telegramId: text("telegram_id").unique(),
  appleId:    text("apple_id").unique(),

  // Community preferences
  interests:      text("interests").array().default([]),
  isExpatMember:  boolean("is_expat_member").notNull().default(true),
  isGamesMember:  boolean("is_games_member").notNull().default(false),

  // Games in English loyalty — stored centrally so any app can read it
  dice: integer("dice").notNull().default(0),

  createdAt: timestamp("created_at").defaultNow(),
});

// ── Availability ──────────────────────────────────────────────────────────
export const availabilitySlots = pgTable("availability_slots", {
  id:       serial("id").primaryKey(),
  userId:   integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  day:      integer("day").notNull(),    // 0=Sun … 6=Sat
  hour:     integer("hour").notNull(),   // 0–23
  appScope: text("app_scope").notNull().default("both"), // "expat"|"games"|"both"
  createdAt: timestamp("created_at").defaultNow(),
});

export const availabilityMatches = pgTable("availability_matches", {
  id:        serial("id").primaryKey(),
  day:       integer("day").notNull(),
  hour:      integer("hour").notNull(),
  category:  text("category").notNull(),
  userIds:   integer("user_ids").array().notNull(),
  appScope:  text("app_scope").notNull().default("expat"),
  notified:  boolean("notified").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Notifications ─────────────────────────────────────────────────────────
export const notifications = pgTable("notifications", {
  id:      serial("id").primaryKey(),
  userId:  integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type:    text("type").notNull(),
  title:   text("title").notNull(),
  body:    text("body").notNull(),
  appScope: text("app_scope").notNull().default("expat"),
  eventId:  integer("event_id"),
  link:     text("link"),
  read:     boolean("read").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

// ── Host registry ─────────────────────────────────────────────────────────
// Controls the multi-tenant platform. One row = one approved event host.
export const hosts = pgTable("hosts", {
  id:          serial("id").primaryKey(),
  slug:        text("slug").notNull().unique(),       // subdomain slug e.g. "pub-quiz"
  name:        text("name").notNull(),                // display name e.g. "The Shamrock Quiz Night"
  description: text("description").notNull().default(""),
  category:    text("category").notNull(),            // "games"|"networking"|"cultural" etc.
  ownerUserId: integer("owner_user_id").references(() => users.id),
  logoUrl:     text("logo_url"),
  primaryColor: text("primary_color").default("#D85A30"),
  paymentUrl:  text("payment_url"),                   // external link — Timepad, Stripe, etc.
  websiteUrl:  text("website_url"),
  telegramHandle: text("telegram_handle"),
  status:      text("status").notNull().default("pending"), // "pending"|"approved"|"suspended"
  approvedAt:  timestamp("approved_at"),
  approvedBy:  integer("approved_by").references(() => users.id),
  createdAt:   timestamp("created_at").defaultNow(),
});

// ── Host applications ─────────────────────────────────────────────────────
export const hostApplications = pgTable("host_applications", {
  id:           serial("id").primaryKey(),
  applicantId:  integer("applicant_id").references(() => users.id),
  name:         text("name").notNull(),
  slug:         text("slug").notNull(),
  description:  text("description").notNull(),
  category:     text("category").notNull(),
  paymentUrl:   text("payment_url"),
  websiteUrl:   text("website_url"),
  telegramHandle: text("telegram_handle"),
  notes:        text("notes"),             // admin review notes
  status:       text("status").notNull().default("pending"),
  createdAt:    timestamp("created_at").defaultNow(),
});

// ── Relations ─────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many }) => ({
  availabilitySlots: many(availabilitySlots),
  notifications:     many(notifications),
  hosts:             many(hosts),
}));

// ── Type exports ──────────────────────────────────────────────────────────
export type User             = typeof users.$inferSelect;
export type AvailabilitySlot = typeof availabilitySlots.$inferSelect;
export type Notification     = typeof notifications.$inferSelect;
export type Host             = typeof hosts.$inferSelect;
export type HostApplication  = typeof hostApplications.$inferSelect;
