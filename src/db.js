// Database layer: PostgreSQL (Supabase) schema, seeding and helpers.
// Replaces the previous Node built-in SQLite implementation so the app can
// run on Vercel serverless functions (which have no persistent local disk).
const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");

const connectionString = process.env.DATABASE_URL || "";
const isLocal = /localhost|127\.0\.0\.1/.test(connectionString);

const pool = new Pool({
  connectionString,
  // Supabase (and most hosted Postgres) require SSL. Local Postgres does not.
  ssl: connectionString && !isLocal ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 3),
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000,
});

// Supabase's connection pooler recycles idle connections. Without this handler
// an idle-client error would be emitted as an unhandled 'error' event and crash
// the whole process. Log it and let the pool create a fresh connection instead.
pool.on("error", (err) => { console.error("Idle Postgres client error (recovered):", err.message); });

// ---- tiny query helpers ----
async function query(text, params) { return pool.query(text, params); }
async function get(text, params) { const r = await pool.query(text, params); return r.rows[0]; }
async function all(text, params) { const r = await pool.query(text, params); return r.rows; }
async function run(text, params) { return pool.query(text, params); }

// ---- schema ----
const SCHEMA = `
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  heading TEXT NOT NULL,
  concept TEXT,
  difficulty TEXT,
  style TEXT,
  stem TEXT NOT NULL,
  opta TEXT NOT NULL, optb TEXT NOT NULL, optc TEXT NOT NULL, optd TEXT NOT NULL,
  answer INTEGER NOT NULL,        -- 0..3
  explanation TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_q_subject ON questions(subject);
CREATE INDEX IF NOT EXISTS idx_q_heading ON questions(subject, heading);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',    -- 'user' | 'admin'
  device_id TEXT,                       -- bound single device
  session_token TEXT,                   -- current active session
  active INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS flags (
  id SERIAL PRIMARY KEY,
  question_id INTEGER NOT NULL,
  user_id INTEGER,
  reason TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS attempts (
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  chosen INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS guests (
  gid TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'guest',   -- 'guest' | 'registered'
  name TEXT, medical TEXT, session TEXT, whatsapp TEXT,
  converted_user_id INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  signup_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS guest_playlist (
  gid TEXT NOT NULL,
  ord INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  PRIMARY KEY (gid, ord)
);

-- extra sign-up fields (added after initial launch)
ALTER TABLE guests ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS bought_book TEXT;
`;

// ---- seeding ----
async function bulkInsertQuestions(items) {
  const CHUNK = 500;
  let inserted = 0;
  for (let s = 0; s < items.length; s += CHUNK) {
    const chunk = items.slice(s, s + CHUNK);
    const vals = [];
    const params = [];
    let p = 1;
    for (const q of chunk) {
      vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(q.id, q.subject, q.heading, q.concept || "", q.difficulty || "", q.style || "",
        q.stem, q.opta, q.optb, q.optc, q.optd, q.answer, q.explanation || "");
    }
    const r = await pool.query(
      `INSERT INTO questions (id,subject,heading,concept,difficulty,style,stem,opta,optb,optc,optd,answer,explanation)
       VALUES ${vals.join(",")} ON CONFLICT (id) DO NOTHING`, params);
    inserted += r.rowCount;
  }
  return inserted;
}

async function seedQuestionsIfEmpty() {
  const c = (await pool.query("SELECT COUNT(*)::int c FROM questions")).rows[0].c;
  if (c > 0) return c;
  const file = path.join(__dirname, "..", "data", "questions.json");
  if (!fs.existsSync(file)) return 0;
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = rows.map((q) => ({
    id: q.id, subject: q.subject, heading: q.heading, concept: q.concept || "",
    difficulty: q.difficulty || "", style: q.style || "", stem: q.stem,
    opta: q.options[0], optb: q.options[1], optc: q.options[2], optd: q.options[3],
    answer: q.answer, explanation: q.explanation || "",
  }));
  return bulkInsertQuestions(items);
}

async function ensureAdmin() {
  const admin = (await pool.query("SELECT id FROM users WHERE role='admin' LIMIT 1")).rows[0];
  if (admin) return;
  const username = process.env.ADMIN_USER || "admin";
  const password = process.env.ADMIN_PASS || "admin123";
  const hash = bcrypt.hashSync(password, 10);
  await pool.query("INSERT INTO users (username,name,password_hash,role) VALUES ($1,$2,$3,'admin')",
    [username, "Administrator", hash]);
  console.log(`  Default admin created -> username: ${username}  password: ${password}`);
}

// ---- one-time initialisation (memoised for serverless cold starts) ----
let readyPromise = null;
async function init() {
  await pool.query(SCHEMA);
  await ensureAdmin();
  await seedQuestionsIfEmpty();
}
function ensureReady() {
  if (!readyPromise) {
    readyPromise = init().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

module.exports = { pool, query, get, all, run, bcrypt, init, ensureReady, bulkInsertQuestions };

// Allow `node src/db.js` to initialise/seed manually.
if (require.main === module) {
  init()
    .then(async () => {
      const n = (await pool.query("SELECT COUNT(*)::int c FROM questions")).rows[0].c;
      console.log("Seed complete. Questions in DB:", n);
      await pool.end();
      process.exit(0);
    })
    .catch((e) => { console.error("Init failed:", e.message); process.exit(1); });
}
