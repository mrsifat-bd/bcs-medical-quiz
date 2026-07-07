// Database layer: SQLite schema, seeding and helpers.
const path = require("path");
const fs = require("fs");
const { DatabaseSync } = require("node:sqlite");   // built-in, no native build (Node 22+)
const bcrypt = require("bcryptjs");

const DATA_DIR = path.join(__dirname, "..", "data");
const DB_PATH = process.env.DB_FILE || path.join(DATA_DIR, "app.db");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
try { db.exec("PRAGMA journal_mode = WAL"); } catch (e) { /* WAL unsupported on some filesystems; default journaling is fine */ }
// better-sqlite3-style transaction helper backed by BEGIN/COMMIT
db.transaction = (fn) => (...args) => {
  db.exec("BEGIN");
  try { const r = fn(...args); db.exec("COMMIT"); return r; }
  catch (e) { db.exec("ROLLBACK"); throw e; }
};

db.exec(`
CREATE TABLE IF NOT EXISTS questions (
  id INTEGER PRIMARY KEY,
  subject TEXT NOT NULL,
  heading TEXT NOT NULL,
  concept TEXT,
  difficulty TEXT,
  style TEXT,
  stem TEXT NOT NULL,
  optA TEXT NOT NULL, optB TEXT NOT NULL, optC TEXT NOT NULL, optD TEXT NOT NULL,
  answer INTEGER NOT NULL,        -- 0..3
  explanation TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_q_subject ON questions(subject);
CREATE INDEX IF NOT EXISTS idx_q_heading ON questions(subject, heading);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',   -- 'user' | 'admin'
  device_id TEXT,                      -- bound single device
  session_token TEXT,                  -- current active session
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS bookmarks (
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id)
);

CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL,
  user_id INTEGER,
  reason TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS attempts (
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  chosen INTEGER NOT NULL,
  correct INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id)
);

-- guest visitors & sign-up leads (free / registered tiers)
CREATE TABLE IF NOT EXISTS guests (
  gid TEXT PRIMARY KEY,
  tier TEXT NOT NULL DEFAULT 'guest',   -- 'guest' | 'registered'
  name TEXT, medical TEXT, session TEXT, whatsapp TEXT,
  converted_user_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  signup_at TEXT
);
CREATE TABLE IF NOT EXISTS guest_playlist (
  gid TEXT NOT NULL,
  ord INTEGER NOT NULL,
  question_id INTEGER NOT NULL,
  PRIMARY KEY (gid, ord)
);
`);

function seedQuestionsIfEmpty() {
  const count = db.prepare("SELECT COUNT(*) c FROM questions").get().c;
  if (count > 0) return count;
  const file = path.join(DATA_DIR, "questions.json");
  if (!fs.existsSync(file)) return 0;
  const rows = JSON.parse(fs.readFileSync(file, "utf8"));
  const ins = db.prepare(`INSERT INTO questions
    (id,subject,heading,concept,difficulty,style,stem,optA,optB,optC,optD,answer,explanation)
    VALUES (@id,@subject,@heading,@concept,@difficulty,@style,@stem,@optA,@optB,@optC,@optD,@answer,@explanation)`);
  const tx = db.transaction((items) => {
    for (const q of items) {
      ins.run({
        id: q.id, subject: q.subject, heading: q.heading, concept: q.concept || "",
        difficulty: q.difficulty || "", style: q.style || "", stem: q.stem,
        optA: q.options[0], optB: q.options[1], optC: q.options[2], optD: q.options[3],
        answer: q.answer, explanation: q.explanation || "",
      });
    }
  });
  tx(rows);
  return rows.length;
}

function ensureAdmin() {
  const admin = db.prepare("SELECT * FROM users WHERE role='admin' LIMIT 1").get();
  if (admin) return;
  const username = process.env.ADMIN_USER || "admin";
  const password = process.env.ADMIN_PASS || "admin123";
  const hash = bcrypt.hashSync(password, 10);
  db.prepare("INSERT INTO users (username,name,password_hash,role) VALUES (?,?,?,?)")
    .run(username, "Administrator", hash, "admin");
  console.log(`\n  Default admin created  ->  username: ${username}   password: ${password}`);
  console.log("  (Change this immediately from the admin panel.)\n");
}

function init() {
  const n = seedQuestionsIfEmpty();
  ensureAdmin();
  return n;
}

module.exports = { db, init, bcrypt };

if (require.main === module) {
  const n = init();
  console.log("Seed complete. Questions in DB:", db.prepare("SELECT COUNT(*) c FROM questions").get().c, "(added", n, "this run)");
}
