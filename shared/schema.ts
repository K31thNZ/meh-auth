// shared/schema.ts
// The shared user layer — owned by meh-auth.
// All other MEH services (Event-Hub, future hubs) read users from here
// by calling the auth service API, not by connecting to this database directly.
import { sql } from "drizzle-orm";
import {
  pgTable, serial, integer, text, boolean, timestamptz,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Users ─────────────────────────────────────────────────────────────────
export const users = pgTable("users", {
  id:          serial("id").primaryKey(),
  username:    text("username").notNull().unique(),
  password:    text("password"),                        // null for OAuth users
  role:        text("role").notNull().default("free"), // "free" | "admin"
  displayName: text("display_name"),
  avatarUrl:   text("avatar_url"),
  email:       text("email").unique(),

  // OAuth providers — add new ones here, never in other services
  googleId:   text("google_id").unique(),
  yandexId:   text("yandex_id").unique(),
  telegramId: text("telegram_id").unique(),
  appleId:    text("apple_id").unique(),

  // Community preferences
  interests: text("interests").array().default(sql`'{}'`),
  isExpatMember:  boolean("is_expat_member").notNull().default(true),
  isGamesMember:  boolean("is_games_member").notNull().default(false),

  // Games in English loyalty — stored centrally so any app can read it
  dice: integer("dice").notNull().default(0),

  createdAt: timestamptz("created_at").defaultNow(),
});

// ── Telegram link tokens ──────────────────────────────────────────────────
// Single-use tokens for the deep link account linking flow.
// Generated when user clicks "Connect Telegram" on their profile.
// Deleted after use or expiry.
export const telegramLinkTokens = pgTable("telegram_link_tokens", {
  token:     text("token").primaryKey(),           // UUID without dashes (32 chars)
  userId:    integer("user_id")
               .references(() => users.id, { onDelete: "cascade" })
               .notNull(),
  expiresAt: timestamptz("expires_at").notNull(),
  used:      boolean("used").default(false).notNull(),
});

// ── Availability ──────────────────────────────────────────────────────────
export const availabilitySlots = pgTable("availability_slots", {
  id:       serial("id").primaryKey(),
  userId:   integer("user_id")
              .notNull()
              .references(() => users.id, { onDelete: "cascade" }),
  day:      integer("day").notNull(),    // 0=Sun … 6=Sat (CHECK constraint enforced in app)
  hour:     integer("hour").notNull(),   // 0–23 (CHECK constraint enforced in app)
  appScope: text("app_scope").notNull().default("both"), // "expat"|"games"|"both"
  createdAt: timestamptz("created_at").defaultNow(),
});

export const availabilityMatches = pgTable("availability_matches", {
  id:        serial("id").primaryKey(),
  day:       integer("day").notNull(),
  hour:      integer("hour").notNull(),
  category:  text("category").notNull(),
  userIds:   integer("user_ids").array().notNull(), // Note: no FK – use junction table for production
  appScope:  text("app_scope").notNull().default("expat"),
  notified:  boolean("notified").notNull().default(false),
  createdAt: timestamptz("created_at").defaultNow(),
});

// ── Notifications ─────────────────────────────────────────────────────────
export const notifications = pgTable("notifications", {
  id:      serial("id").primaryKey(),
  userId:  integer("user_id")
             .notNull()
             .references(() => users.id, { onDelete: "cascade" }),
  type:    text("type").notNull(),
  title:   text("title").notNull(),
  body:    text("body").notNull(),
  appScope: text("app_scope").notNull().default("expat"),
  eventId:  integer("event_id"),        // external reference to Event-Hub (no FK)
  link:     text("link"),
  read:     boolean("read").notNull().default(false),
  createdAt: timestamptz("created_at").defaultNow(),
});

// ── Host registry ─────────────────────────────────────────────────────────
export const hosts = pgTable("hosts", {
  id:          serial("id").primaryKey(),
  slug:        text("slug").notNull().unique(),
  name:        text("name").notNull(),
  description: text("description").notNull().default(""),
  category:    text("category").notNull(),
  ownerUserId: integer("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  logoUrl:     text("logo_url"),
  primaryColor: text("primary_color").default("#D85A30"),
  paymentUrl:  text("payment_url"),
  websiteUrl:  text("website_url"),
  telegramHandle: text("telegram_handle"),
  status:      text("status").notNull().default("pending"),
  approvedAt:  timestamptz("approved_at"),
  approvedBy:  integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  createdAt:   timestamptz("created_at").defaultNow(),
});

// ── Host applications ─────────────────────────────────────────────────────
export const hostApplications = pgTable("host_applications", {
  id:           serial("id").primaryKey(),
  applicantId:  integer("applicant_id").references(() => users.id, { onDelete: "set null" }),
  name:         text("name").notNull(),
  slug:         text("slug").notNull(),
  description:  text("description").notNull(),
  category:     text("category").notNull(),
  paymentUrl:   text("payment_url"),
  websiteUrl:   text("website_url"),
  telegramHandle: text("telegram_handle"),
  notes:        text("notes"),
  status:       text("status").notNull().default("pending"),
  createdAt:    timestamptz("created_at").defaultNow(),
});

// ── Relations ─────────────────────────────────────────────────────────────
export const usersRelations = relations(users, ({ many }) => ({
  availabilitySlots:   many(availabilitySlots),
  notifications:       many(notifications),
  hosts:               many(hosts),
  telegramLinkTokens:  many(telegramLinkTokens),
}));

export const availabilitySlotsRelations = relations(availabilitySlots, ({ one }) => ({
  user: one(users, { fields: [availabilitySlots.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const hostsRelations = relations(hosts, ({ one }) => ({
  ownerUser: one(users, { fields: [hosts.ownerUserId], references: [users.id] }),
  approver:  one(users, { fields: [hosts.approvedBy], references: [users.id] }),
}));

export const hostApplicationsRelations = relations(hostApplications, ({ one }) => ({
  applicant: one(users, { fields: [hostApplications.applicantId], references: [users.id] }),
}));

export const telegramLinkTokensRelations = relations(telegramLinkTokens, ({ one }) => ({
  user: one(users, { fields: [telegramLinkTokens.userId], references: [users.id] }),
}));

// (Optional) Relations for availabilityMatches – omitted because userIds is an array
// For production, replace userIds with a junction table and add relations here.

// ── Type exports ──────────────────────────────────────────────────────────
export type User               = typeof users.$inferSelect;
export type AvailabilitySlot   = typeof availabilitySlots.$inferSelect;
export type Notification       = typeof notifications.$inferSelect;
export type Host               = typeof hosts.$inferSelect;
export type HostApplication    = typeof hostApplications.$inferSelect;
export type TelegramLinkToken  = typeof telegramLinkTokens.$inferSelect;
