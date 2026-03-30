/**
 * seed-neon.mjs — creates all tables and populates the Neon database with test data
 *
 * Usage from the project root:
 *   node seed-neon.mjs
 *
 * Edit NEON_URL below to point at your database if needed.
 */

import pg from "pg";
import { scrypt, randomBytes } from "crypto";
import { promisify } from "util";

const scryptAsync = promisify(scrypt);

// ── Connection ──────────────────────────────────────────────────────────────
// Edit this to your Neon connection string (paste it exactly as given by Neon)
const NEON_URL =
  "postgresql://neondb_owner:npg_knRWGAu3oft0@ep-cold-bird-agauwq3h-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require";

// channel_binding=require is not supported by the pg driver — strip it
// sslmode is handled via the pool's ssl option below instead
const connectionString = NEON_URL
  .replace(/[&?]channel_binding=[^&]*/g, "")
  .replace(/[?&]sslmode=[^&]*/g, "");

const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const buf = await scryptAsync(password, salt, 64);
  return `${buf.toString("hex")}.${salt}`;
}

async function run() {
  const client = await pool.connect();
  try {
    console.log("Connected to Neon ✓");

    // ── Schema ─────────────────────────────────────────────────────────────
    console.log("\nCreating tables...");

    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id              SERIAL PRIMARY KEY,
        username        TEXT NOT NULL UNIQUE,
        password        TEXT,
        role            TEXT NOT NULL DEFAULT 'member',
        display_name    TEXT,
        avatar_url      TEXT,
        email           TEXT UNIQUE,
        google_id       TEXT UNIQUE,
        yandex_id       TEXT UNIQUE,
        telegram_id     TEXT UNIQUE,
        apple_id        TEXT UNIQUE,
        interests       TEXT[] DEFAULT '{}',
        is_expat_member BOOLEAN NOT NULL DEFAULT true,
        is_games_member BOOLEAN NOT NULL DEFAULT false,
        dice            INTEGER NOT NULL DEFAULT 0,
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid    VARCHAR NOT NULL PRIMARY KEY,
        sess   JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions (expire)`
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS availability_slots (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day        INTEGER NOT NULL,
        hour       INTEGER NOT NULL,
        app_scope  TEXT NOT NULL DEFAULT 'both',
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS availability_matches (
        id         SERIAL PRIMARY KEY,
        day        INTEGER NOT NULL,
        hour       INTEGER NOT NULL,
        category   TEXT NOT NULL,
        user_ids   INTEGER[] NOT NULL,
        app_scope  TEXT NOT NULL DEFAULT 'expat',
        notified   BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS notifications (
        id         SERIAL PRIMARY KEY,
        user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type       TEXT NOT NULL,
        title      TEXT NOT NULL,
        body       TEXT NOT NULL,
        app_scope  TEXT NOT NULL DEFAULT 'expat',
        event_id   INTEGER,
        link       TEXT,
        read       BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS hosts (
        id              SERIAL PRIMARY KEY,
        slug            TEXT NOT NULL UNIQUE,
        name            TEXT NOT NULL,
        description     TEXT NOT NULL DEFAULT '',
        category        TEXT NOT NULL,
        owner_user_id   INTEGER REFERENCES users(id),
        logo_url        TEXT,
        primary_color   TEXT DEFAULT '#D85A30',
        payment_url     TEXT,
        website_url     TEXT,
        telegram_handle TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        approved_at     TIMESTAMP,
        approved_by     INTEGER REFERENCES users(id),
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS host_applications (
        id              SERIAL PRIMARY KEY,
        applicant_id    INTEGER REFERENCES users(id),
        name            TEXT NOT NULL,
        slug            TEXT NOT NULL,
        description     TEXT NOT NULL,
        category        TEXT NOT NULL,
        payment_url     TEXT,
        website_url     TEXT,
        telegram_handle TEXT,
        notes           TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        created_at      TIMESTAMP DEFAULT NOW()
      )
    `);

    console.log("Tables ready ✓");

    // ── Users ───────────────────────────────────────────────────────────────
    console.log("\nInserting users...");
    const adminPwd  = await hashPassword("admin123");
    const memberPwd = await hashPassword("test1234");

    await client.query(
      `INSERT INTO users (username, password, role, display_name, email, interests, is_expat_member, is_games_member, dice)
       VALUES ($1,$2,'admin','Admin User','admin@expatevents.org','{}',true,false,0)
       ON CONFLICT (username) DO NOTHING`,
      ["admin", adminPwd]
    );
    await client.query(
      `INSERT INTO users (username, password, role, display_name, email, interests, is_expat_member, is_games_member, dice)
       VALUES ($1,$2,'member','Alice Miller','alice@example.com',ARRAY['networking','food','culture'],true,false,3)
       ON CONFLICT (username) DO NOTHING`,
      ["alice_m", memberPwd]
    );
    await client.query(
      `INSERT INTO users (username, password, role, display_name, email, interests, is_expat_member, is_games_member, dice)
       VALUES ($1,$2,'member','Ben Kowalski','ben@example.com',ARRAY['tech','games','outdoor'],true,true,8)
       ON CONFLICT (username) DO NOTHING`,
      ["ben_k", memberPwd]
    );

    await client.query(`
      INSERT INTO users (username, role, display_name, avatar_url, email, google_id, telegram_id, interests, is_expat_member, is_games_member, dice)
      VALUES
        ('sophia_v','member','Sophia Vance',   'https://i.pravatar.cc/150?u=sophia', 'sophia@example.com', 'g_101',NULL,      ARRAY['networking','culture','food'],    true, false,0),
        ('marc_d',  'member','Marc Dupont',    'https://i.pravatar.cc/150?u=marc',   'marc@example.com',   'g_102','9911001', ARRAY['tech','games','language'],        false,true, 12),
        ('yuki_t',  'member','Yuki Tanaka',    'https://i.pravatar.cc/150?u=yuki',   'yuki@example.com',   NULL,   '9911002', ARRAY['food','music','outdoor'],         true, false,0),
        ('olga_b',  'member','Olga Borisova',  'https://i.pravatar.cc/150?u=olga',   'olga@example.com',   'g_103','9911003', ARRAY['wellness','language','social'],   true, false,0),
        ('james_r', 'member','James Robertson','https://i.pravatar.cc/150?u=james',  'james@example.com',  NULL,   NULL,      ARRAY['sports','outdoor','networking'],  true, true, 5),
        ('lena_s',  'member','Lena Schneider', 'https://i.pravatar.cc/150?u=lena',   'lena@example.com',   'g_104','9911004', ARRAY['culture','music','volunteering'], true, false,0),
        ('dmitri_p','member','Dmitri Petrov',  'https://i.pravatar.cc/150?u=dmitri', 'dmitri@example.com', NULL,   '9911005', ARRAY['business','tech','networking'],   false,false,0),
        ('priya_k', 'member','Priya Kapoor',   'https://i.pravatar.cc/150?u=priya',  'priya@example.com',  'g_105',NULL,      ARRAY['food','wellness','family'],       true, false,0)
      ON CONFLICT (username) DO NOTHING
    `);

    const { rows: users } = await client.query("SELECT id, username FROM users ORDER BY id");
    const b = {};
    for (const u of users) b[u.username] = u.id;
    console.log(`${users.length} users ✓  (${users.map(u => `${u.id}:${u.username}`).join(", ")})`);

    // ── Availability slots ──────────────────────────────────────────────────
    console.log("\nInserting availability slots...");
    const slots = [
      [b["alice_m"],  2, 19, "expat"], [b["alice_m"],  2, 20, "expat"],
      [b["alice_m"],  4, 19, "expat"], [b["alice_m"],  4, 20, "expat"],
      [b["alice_m"],  6, 14, "expat"],
      [b["ben_k"],    1, 18, "games"], [b["ben_k"],    1, 19, "games"],
      [b["ben_k"],    3, 18, "games"], [b["ben_k"],    3, 19, "games"],
      [b["ben_k"],    0, 15, "both"],
      [b["sophia_v"], 3, 19, "expat"], [b["sophia_v"], 3, 20, "expat"],
      [b["sophia_v"], 5, 18, "expat"], [b["sophia_v"], 5, 19, "expat"],
      [b["marc_d"],   1, 18, "games"], [b["marc_d"],   1, 19, "games"],
      [b["marc_d"],   3, 19, "games"],
      [b["yuki_t"],   5, 19, "expat"], [b["yuki_t"],   5, 20, "expat"],
      [b["yuki_t"],   6, 18, "expat"],
      [b["james_r"],  6, 10, "both"],  [b["james_r"],  6, 11, "both"],
      [b["james_r"],  0, 10, "expat"],
      [b["olga_b"],   2, 18, "expat"], [b["olga_b"],   4, 18, "expat"],
      [b["priya_k"],  3, 18, "expat"], [b["priya_k"],  5, 18, "expat"],
    ];
    for (const [uid, day, hour, scope] of slots) {
      await client.query(
        "INSERT INTO availability_slots (user_id, day, hour, app_scope) VALUES ($1,$2,$3,$4)",
        [uid, day, hour, scope]
      );
    }
    console.log(`${slots.length} slots ✓`);

    // ── Availability matches ────────────────────────────────────────────────
    console.log("\nInserting availability matches...");
    await client.query(
      `INSERT INTO availability_matches (day, hour, category, user_ids, app_scope, notified) VALUES
        (1, 18, 'games',      $1, 'games', true),
        (3, 19, 'networking', $2, 'expat', false),
        (5, 19, 'food',       $3, 'expat', false),
        (6, 10, 'sports',     $4, 'both',  false)`,
      [
        [b["ben_k"], b["marc_d"]],
        [b["alice_m"], b["sophia_v"], b["dmitri_p"]],
        [b["alice_m"], b["yuki_t"], b["priya_k"]],
        [b["james_r"], b["ben_k"]],
      ]
    );
    console.log("4 availability matches ✓");

    // ── Notifications ───────────────────────────────────────────────────────
    console.log("\nInserting notifications...");
    const notifs = [
      [b["alice_m"],  "new_event",          "New Networking Mixer",              "Join fellow expats at the monthly networking event on Friday evening.",   "expat", 1,    "/events/1",           false],
      [b["alice_m"],  "availability_match", "3 members free Thursday at 19:00", "You share availability with Sophia and Dmitri for Networking.",            "expat", null, "/availability",       true ],
      [b["ben_k"],    "new_event",          "Games Night — Board Games",         "Classic board game evening at Shamrock. RSVP required.",                  "games", 2,    "/events/2",           false],
      [b["ben_k"],    "dice_earned",        "You earned 5 dice!",                "You attended 3 games nights in a row. Bonus dice added.",                 "games", null, "/profile",            true ],
      [b["sophia_v"], "new_event",          "Expat Food Festival",               "Taste dishes from 20 countries at Gorky Park this Saturday.",             "expat", 3,    "/events/3",           false],
      [b["marc_d"],   "new_event",          "Tech Meetup: AI in Moscow",         "Monthly tech meetup — focusing on LLM applications.",                    "expat", 4,    "/events/4",           false],
      [b["marc_d"],   "availability_match", "2 members free Monday at 18:00",   "You and Ben share Monday evening availability for Games.",                "games", null, "/availability",       false],
      [b["yuki_t"],   "new_event",          "Japanese Food Workshop",            "Learn to make ramen and gyoza with Chef Tanaka at Culinary Studio.",      "expat", 5,    "/events/5",           false],
      [b["admin"],    "system",             "New host application received",     "Dmitri Petrov applied to host \"Moscow Tech Talks\". Review now.",        "expat", null, "/admin/applications", false],
      [b["admin"],    "system",             "New host application received",     "James Robertson applied to host \"Expat Runners Club\". Review now.",     "expat", null, "/admin/applications", false],
    ];
    for (const [uid, type, title, body, scope, evId, link, read] of notifs) {
      await client.query(
        "INSERT INTO notifications (user_id, type, title, body, app_scope, event_id, link, read) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [uid, type, title, body, scope, evId, link, read]
      );
    }
    console.log(`${notifs.length} notifications ✓`);

    // ── Hosts (approved) ────────────────────────────────────────────────────
    console.log("\nInserting hosts...");
    await client.query(
      `INSERT INTO hosts (slug, name, description, category, owner_user_id, logo_url, primary_color, payment_url, website_url, telegram_handle, status, approved_at, approved_by)
       VALUES
         ('shamrock-games',    'Shamrock Games Night',
          'Weekly board game nights at the Shamrock pub. All skill levels welcome.',
          'games', $1, 'https://i.pravatar.cc/150?u=shamrock', '#2D6A4F',
          'https://timepad.ru/shamrock', 'https://shamrockgames.ru', 'shamrock_games',
          'approved', NOW() - INTERVAL '30 days', $5),
         ('expat-network-msk', 'ExpatEvents Networking Club',
          'Monthly professional networking mixers for the international community in Moscow.',
          'networking', $2, 'https://i.pravatar.cc/150?u=expatnetwork', '#D85A30',
          NULL, 'https://expatevents.org/networking', 'expat_network_msk',
          'approved', NOW() - INTERVAL '60 days', $5),
         ('moscow-foodies',    'Moscow Foodies',
          'Culinary tours, restaurant openings, and cooking workshops for food lovers.',
          'food', $3, 'https://i.pravatar.cc/150?u=foodies', '#F4A261',
          'https://timepad.ru/foodies', 'https://moscowfoodies.ru', 'moscow_foodies',
          'approved', NOW() - INTERVAL '15 days', $5),
         ('language-lab',      'The Language Lab',
          'Weekly language exchange meetups. Practice Russian, English, French, Spanish.',
          'language', $4, 'https://i.pravatar.cc/150?u=langlab', '#457B9D',
          NULL, NULL, 'lang_lab_msk',
          'approved', NOW() - INTERVAL '45 days', $5)
       ON CONFLICT (slug) DO NOTHING`,
      [b["marc_d"], b["sophia_v"], b["yuki_t"], b["olga_b"], b["admin"]]
    );
    console.log("4 approved hosts ✓");

    // ── Host applications (pending) ─────────────────────────────────────────
    console.log("\nInserting host applications...");
    await client.query(
      `INSERT INTO host_applications (applicant_id, name, slug, description, category, website_url, telegram_handle, status)
       VALUES
         ($1, 'Moscow Tech Talks',     'moscow-tech-talks', 'Monthly technology meetups covering AI, blockchain, and startup culture.', 'tech',   'https://techtalksmsk.ru', 'techtalksmsk',     'pending'),
         ($2, 'Expat Runners Club',    'expat-runners',     'Weekend running group through Moscow parks. All paces welcome.',           'sports', NULL,                      'expat_runners_msk','pending'),
         ($3, 'Moscow Jazz Collective','moscow-jazz',       'Live jazz and classical concerts, intimate venue sessions, meetups.',       'music',  'https://moscowjazz.ru',   'moscow_jazz',      'pending')`,
      [b["dmitri_p"], b["james_r"], b["lena_s"]]
    );
    console.log("3 pending applications ✓");

    // ── Summary ─────────────────────────────────────────────────────────────
    const { rows: [c] } = await client.query(`
      SELECT
        (SELECT COUNT(*) FROM users)                AS users,
        (SELECT COUNT(*) FROM availability_slots)   AS slots,
        (SELECT COUNT(*) FROM availability_matches) AS matches,
        (SELECT COUNT(*) FROM notifications)        AS notifications,
        (SELECT COUNT(*) FROM hosts)                AS hosts,
        (SELECT COUNT(*) FROM host_applications)    AS applications
    `);
    console.log("\n=== Done! Final counts ===");
    console.log(`  users:         ${c.users}`);
    console.log(`  slots:         ${c.slots}`);
    console.log(`  matches:       ${c.matches}`);
    console.log(`  notifications: ${c.notifications}`);
    console.log(`  hosts:         ${c.hosts}`);
    console.log(`  applications:  ${c.applications}`);
    console.log("\nTest credentials:");
    console.log("  admin   / admin123   (role: admin)");
    console.log("  alice_m / test1234   (role: member)");
    console.log("  ben_k   / test1234   (role: member)");

  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
