-- Task 9 (Batch 3): language_posts table for 48h practice sentence moments
CREATE TABLE IF NOT EXISTS "language_posts" (
  "id"          SERIAL PRIMARY KEY,
  "user_id"     INTEGER NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "text"        TEXT NOT NULL,
  "language"    TEXT NOT NULL,
  "likes"       INTEGER[] NOT NULL DEFAULT '{}',
  "corrections" JSONB NOT NULL DEFAULT '[]',
  "expires_at"  TIMESTAMPTZ NOT NULL,
  "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "language_posts_expires_at_idx" ON "language_posts"("expires_at");
CREATE INDEX IF NOT EXISTS "language_posts_user_id_idx"   ON "language_posts"("user_id");
