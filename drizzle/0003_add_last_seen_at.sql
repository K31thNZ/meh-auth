-- Migration: 0003_add_last_seen_at
-- Adds a last_seen_at timestamp to users so the Language Exchange directory
-- can sort by recency and badge stale profiles.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Backfill: use created_at as a safe starting value for existing users
UPDATE users
  SET last_seen_at = created_at
  WHERE last_seen_at IS NULL;
