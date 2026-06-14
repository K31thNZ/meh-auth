-- Task 5 (Spec Batch 2): Add language_story column to users table
-- Max 140 chars enforced at application layer.
ALTER TABLE users ADD COLUMN IF NOT EXISTS language_story TEXT;
