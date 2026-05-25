-- Migration: add extended profile fields to users table
-- These fields are set via PATCH /api/user/match-profile and surfaced in
-- the Language Exchange directory.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "bio"                text,
  ADD COLUMN IF NOT EXISTS "city"               text,
  ADD COLUMN IF NOT EXISTS "meeting_types"      text[] DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "my_age_group"       text,
  ADD COLUMN IF NOT EXISTS "preferred_age_min"  integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "preferred_age_max"  integer NOT NULL DEFAULT 3;

-- Index for Language Exchange directory queries
CREATE INDEX IF NOT EXISTS "idx_users_native_language" ON "users" ("native_language");
CREATE INDEX IF NOT EXISTS "idx_users_city"            ON "users" ("city");
CREATE INDEX IF NOT EXISTS "idx_users_my_age_group"    ON "users" ("my_age_group");

-- Migration: add insight tracking fields to events + new insight tables

ALTER TABLE "events"
  ADD COLUMN IF NOT EXISTS "notifications_sent" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "rsvp_momentum_24h"  integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "ignored_demand_slots" (
  "id"          serial PRIMARY KEY,
  "user_id"     integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "category"    text NOT NULL,
  "day"         integer NOT NULL,
  "hour"        integer NOT NULL,
  "expires_at"  timestamptz NOT NULL,
  "created_at"  timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_ignored_demand_user" ON "ignored_demand_slots" ("user_id", "category", "day", "hour");

CREATE TABLE IF NOT EXISTS "rsvp_flush_buffer" (
  "event_id"          integer PRIMARY KEY,
  "pending_count"     integer NOT NULL DEFAULT 0,
  "first_pending_at"  timestamptz NOT NULL,
  "last_pending_at"   timestamptz NOT NULL
);
