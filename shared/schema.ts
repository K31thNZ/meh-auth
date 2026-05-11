// shared/schema.ts
import { sql } from "drizzle-orm";
import {
  pgTable, serial, integer, text, boolean, timestamp, jsonb, uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// ── Types shared with the frontend ───────────────────────────────────────────
// Keep these in sync with Profile.tsx

export type ProficiencyLevel = "A1" | "A2" | "B1" | "B2" | "C1" | "C2";

export interface LanguageEntry {
  code:        string;           // ISO 639-1 e.g. "en"
  proficiency: ProficiencyLevel;
}

// ── Tables ────────────────────────────────────────────────────────────────────

export const users = pgTable("users", {
  id:          serial("id").primaryKey(),
  username:    text("username").notNull().unique(),
  password:    text("password"),
  role:        text("role").notNull().default("free"),
  displayName: text("display_name"),
  avatarUrl:   text("avatar_url"),
  email:       text("email").unique(),
  googleId:    text("google_id").unique(),
  yandexId:    text("yandex_id").unique(),
  telegramId:  text("telegram_id").unique(),
  appleId:     text("apple_id").unique(),
  interests:   text("interests").array().default(sql`'{}'`),
  isExpatMember:  boolean("is_expat_member").notNull().default(true),
  isGamesMember:  boolean("is_games_member").notNull().default(false),
  dice:        integer("dice").notNull().default(0),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow(),

  // ── Phase 1: Smart Match profile ─────────────────────────────────────────
  // ISO 639-1 code for the user's native language (e.g. "en", "ru")
  nativeLanguage:    text("native_language"),
  // Array of { code, proficiency } objects — stored as JSONB
  learningLanguages: jsonb("learning_languages").$type<LanguageEntry[]>().notNull().default(sql`'[]'::jsonb`),
  // Name of the closest Moscow metro station chosen by the user
  metroStation:      text("metro_station"),

  // ── Bot‑related flags ─────────────────────────────────────────────────────
  blocked:         boolean("blocked").notNull().default(false),
  language:        text("language").notNull().default("en"),   // "ru" / "en"
  telegramUsername: text("telegram_username"),                  // e.g. @handle
});

export const telegramLinkTokens = pgTable("telegram_link_tokens", {
  token:     text("token").primaryKey(),
  userId:    integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  used:      boolean("used").default(false).notNull(),
});

export const availabilitySlots = pgTable("availability_slots", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  day:       integer("day").notNull(),
  hour:      integer("hour").notNull(),
  appScope:  text("app_scope").notNull().default("both"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const availabilityMatches = pgTable("availability_matches", {
  id:        serial("id").primaryKey(),
  day:       integer("day").notNull(),
  hour:      integer("hour").notNull(),
  category:  text("category").notNull(),
  userIds:   integer("user_ids").array().notNull(),
  appScope:  text("app_scope").notNull().default("expat"),
  notified:  boolean("notified").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

export const notifications = pgTable("notifications", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  type:      text("type").notNull(),
  title:     text("title").notNull(),
  body:      text("body").notNull(),
  appScope:  text("app_scope").notNull().default("expat"),
  eventId:   integer("event_id"),
  link:      text("link"),
  read:      boolean("read").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

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
  approvedAt:  timestamp("approved_at", { withTimezone: true }),
  approvedBy:  integer("approved_by").references(() => users.id, { onDelete: "set null" }),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow(),
});

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
  createdAt:    timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── New tables for bot persistence ────────────────────────────────────────────

export const rsvps = pgTable("rsvps", {
  id:        serial("id").primaryKey(),
  userId:    integer("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  eventId:   integer("event_id").notNull(),                     // references expatevents.org event
  status:    text("status").notNull(),                          // "going" | "maybe" | "no"
  sourceChatId:    integer("source_chat_id"),                   // Telegram chat id where RSVP was cast
  sourceChatTitle: text("source_chat_title"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (table) => ({
  uniq: uniqueIndex("rsvps_user_event").on(table.userId, table.eventId),
}));

export const pendingApprovals = pgTable("pending_approvals", {
  token:     text("token").primaryKey(),
  eventId:   integer("event_id").notNull(),
  eventData: jsonb("event_data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const events = pgTable("events", {
  id:          integer("id").primaryKey(),                      // mirrors expatevents event id
  title:       text("title").notNull(),
  category:    text("category").notNull(),
  date:        timestamp("date", { withTimezone: true }).notNull(),
  venueCity:   text("venue_city"),
  venueAddress: text("venue_address"),
  description: text("description"),
  organizerId: integer("organizer_id").references(() => users.id, { onDelete: "set null" }),
  imageUrl:    text("image_url"),
  dispatched:  boolean("dispatched").notNull().default(true),
  createdAt:   timestamp("created_at", { withTimezone: true }).defaultNow(),
});

// ── Relations (unchanged, extended) ───────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  availabilitySlots:   many(availabilitySlots),
  notifications:       many(notifications),
  hosts:               many(hosts),
  telegramLinkTokens:  many(telegramLinkTokens),
  rsvps:               many(rsvps),
  organisedEvents:     many(events, { relationName: "organiser" }),
}));

export const availabilitySlotsRelations = relations(availabilitySlots, ({ one }) => ({
  user: one(users, { fields: [availabilitySlots.userId], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const hostsRelations = relations(hosts, ({ one }) => ({
  ownerUser: one(users, { fields: [hosts.ownerUserId], references: [users.id] }),
  approver:  one(users, { fields: [hosts.approvedBy],  references: [users.id] }),
}));

export const hostApplicationsRelations = relations(hostApplications, ({ one }) => ({
  applicant: one(users, { fields: [hostApplications.applicantId], references: [users.id] }),
}));

export const telegramLinkTokensRelations = relations(telegramLinkTokens, ({ one }) => ({
  user: one(users, { fields: [telegramLinkTokens.userId], references: [users.id] }),
}));

export const rsvpsRelations = relations(rsvps, ({ one }) => ({
  user: one(users, { fields: [rsvps.userId], references: [users.id] }),
}));

export const eventsRelations = relations(events, ({ one }) => ({
  organiser: one(users, {
    fields: [events.organizerId],
    references: [users.id],
    relationName: "organiser",
  }),
}));

// ── Inferred types ────────────────────────────────────────────────────────────

export type User              = typeof users.$inferSelect;
export type AvailabilitySlot  = typeof availabilitySlots.$inferSelect;
export type Notification      = typeof notifications.$inferSelect;
export type Host              = typeof hosts.$inferSelect;
export type HostApplication   = typeof hostApplications.$inferSelect;
export type TelegramLinkToken = typeof telegramLinkTokens.$inferSelect;
export type Rsvp              = typeof rsvps.$inferSelect;
export type PendingApproval   = typeof pendingApprovals.$inferSelect;
export type Event             = typeof events.$inferSelect;
