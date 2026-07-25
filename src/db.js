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

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- extra sign-up fields (added after initial launch)
ALTER TABLE guests ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS bought_book TEXT;
ALTER TABLE guests ADD COLUMN IF NOT EXISTS total_seconds INTEGER NOT NULL DEFAULT 0;

-- login/device/time tracking on member accounts
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_device TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_seconds INTEGER NOT NULL DEFAULT 0;

-- free-question pool flag (100 shared free questions across subjects)
ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_free INTEGER NOT NULL DEFAULT 0;

-- model tests (from the PDF) and student results for ranking
CREATE TABLE IF NOT EXISTS model_tests (
  test_no INTEGER NOT NULL,
  q_no INTEGER NOT NULL,
  stem TEXT NOT NULL,
  opta TEXT NOT NULL, optb TEXT NOT NULL, optc TEXT NOT NULL, optd TEXT NOT NULL,
  answer INTEGER NOT NULL,
  PRIMARY KEY (test_no, q_no)
);
CREATE TABLE IF NOT EXISTS model_test_results (
  id SERIAL PRIMARY KEY,
  test_no INTEGER NOT NULL,
  ref TEXT,
  name TEXT,
  score INTEGER NOT NULL,
  total INTEGER NOT NULL,
  taken_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mtr ON model_test_results(test_no, score);
`;

// Bump this whenever data/questions.json changes to force a full re-seed on deploy.
const QUESTIONS_VERSION = "qverse-bcs-2026-07e";

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

async function seedQuestions() {
  // Re-seed only when the question set changes (tracked via meta.questions_version).
  const ver = (await pool.query("SELECT value FROM meta WHERE key='questions_version'")).rows[0];
  const count = (await pool.query("SELECT COUNT(*)::int c FROM questions")).rows[0].c;
  if (ver && ver.value === QUESTIONS_VERSION && count > 0) return count;

  const file = path.join(__dirname, "..", "data", "questions.json");
  if (!fs.existsSync(file)) return count;
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = rows.map((q) => ({
    id: q.id, subject: q.subject, heading: q.heading, concept: q.concept || "",
    difficulty: q.difficulty || "", style: q.style || "", stem: q.stem,
    opta: q.options[0], optb: q.options[1], optc: q.options[2], optd: q.options[3],
    answer: q.answer, explanation: q.explanation || "",
  }));

  // Replace the whole bank: drop old questions and everything that referenced them.
  await pool.query("TRUNCATE questions, guest_playlist, bookmarks, attempts RESTART IDENTITY");
  const n = await bulkInsertQuestions(items);

  // Mark ~100 free questions, stratified across subjects (shared by everyone).
  await pool.query("UPDATE questions SET is_free=0");
  await pool.query(`
    WITH ranked AS (
      SELECT id, row_number() OVER (PARTITION BY subject ORDER BY random()) rn
      FROM questions WHERE active=1
    ), picks AS (
      SELECT id FROM ranked WHERE rn <= 8 ORDER BY random() LIMIT 100
    )
    UPDATE questions SET is_free=1 WHERE id IN (SELECT id FROM picks)`);

  await seedModelTests();

  await pool.query(
    "INSERT INTO meta (key,value) VALUES ('questions_version',$1) ON CONFLICT (key) DO UPDATE SET value=excluded.value",
    [QUESTIONS_VERSION]);
  console.log(`  Questions re-seeded: ${n} (version ${QUESTIONS_VERSION})`);
  return n;
}

async function seedModelTests() {
  const file = path.join(__dirname, "..", "data", "modeltests.json");
  if (!fs.existsSync(file)) return 0;
  const tests = JSON.parse(fs.readFileSync(file, "utf8"));
  await pool.query("TRUNCATE model_tests");
  let total = 0;
  for (const t of tests) {
    const vals = [];
    const params = [];
    let p = 1;
    for (const q of t.questions) {
      vals.push(`($${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++},$${p++})`);
      params.push(t.test_no, q.q_no, q.stem, q.options[0], q.options[1], q.options[2], q.options[3], q.answer);
      total++;
    }
    if (vals.length) {
      await pool.query(
        `INSERT INTO model_tests (test_no,q_no,stem,opta,optb,optc,optd,answer) VALUES ${vals.join(",")}
         ON CONFLICT (test_no,q_no) DO NOTHING`, params);
    }
  }
  console.log(`  Model tests seeded: ${total} questions across ${tests.length} tests`);
  return total;
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
  await seedQuestions();
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
