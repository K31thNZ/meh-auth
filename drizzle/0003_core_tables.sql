-- Migration: ensure core bot tables exist
-- Safe to re-run (uses IF NOT EXISTS)

CREATE TABLE IF NOT EXISTS "notifications" (
  "id"         serial PRIMARY KEY,
  "user_id"    integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type"       text NOT NULL,
  "title"      text NOT NULL,
  "body"       text NOT NULL,
  "app_scope"  text NOT NULL DEFAULT 'expat',
  "event_id"   integer,
  "link"       text,
  "read"       boolean NOT NULL DEFAULT false,
  "created_at" timestamp with time zone DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "pending_approvals" (
  "token"      text PRIMARY KEY,
  "event_id"   integer NOT NULL,
  "event_data" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now(),
  "expires_at" timestamp with time zone NOT NULL
);

CREATE TABLE IF NOT EXISTS "events" (
  "id"           integer PRIMARY KEY,
  "title"        text NOT NULL,
  "category"     text NOT NULL,
  "date"         timestamp with time zone NOT NULL,
  "venue_city"   text,
  "venue_address" text,
  "description"  text,
  "organizer_id" integer REFERENCES "users"("id") ON DELETE SET NULL,
  "image_url"    text,
  "notifications_sent" integer DEFAULT 0,
  "created_at"   timestamp with time zone DEFAULT now()
);

-- Sparks tables (for language exchange feature)
CREATE TABLE IF NOT EXISTS "sparks" (
  "id"               serial PRIMARY KEY,
  "sender_id"        integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "receiver_id"      integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "message"          text,
  "proposed_time"    timestamp with time zone,
  "status"           text NOT NULL DEFAULT 'pending',
  "created_at"       timestamp with time zone DEFAULT now()
);
