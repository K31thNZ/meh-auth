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
