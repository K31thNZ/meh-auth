-- Add le_hidden flag to users table for admin moderation of Language Exchange cards
ALTER TABLE users ADD COLUMN IF NOT EXISTS le_hidden boolean NOT NULL DEFAULT false;
