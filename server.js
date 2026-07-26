const path = require("path");
const os = require("os");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const XLSX = require("xlsx");
const db = require("./src/db");
const { parseFile } = require("./src/parse");

// ---------- configuration ----------
const BRAND = "MediVerse BCS Question Bank";
const FREE_QUOTA = 50;           // guest (no account)
const REG_QUOTA = 100;           // after free sign-up (50 + 50)
// The payment / registration form link students are sent to.
const PAYMENT_URL = process.env.PAYMENT_URL ||
  "https://docs.google.com/forms/d/1avDCTQBsNAKXKII1gvTIJoNFnasdXA3TR8xB1Ydzoa4/edit";
const SECURE_COOKIES = process.env.HTTPS === "1" || process.env.VERCEL === "1";

const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
// On serverless the only writable directory is the OS temp dir.
const upload = multer({ dest: os.tmpdir(), limits: { fileSize: 15 * 1024 * 1024 } });

// Make sure the database schema exists (and is seeded) before any route runs.
app.use(async (req, res, next) => {
  try { await db.ensureReady(); next(); }
  catch (e) {
    console.error("Database initialisation failed:", e);
    res.status(500).json({ error: "Database not reachable. Check the DATABASE_URL configuration." });
  }
});

// ---------- request helpers (IP + device tracking) ----------
function clientIp(req) {
  const xf = req.headers["x-forwarded-for"];
  if (xf) return String(xf).split(",")[0].trim();
  return req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "";
}
function parseDevice(ua) {
  ua = ua || "";
  let os = "Unknown OS";
  if (/Windows NT 10/.test(ua)) os = "Windows 10/11";
  else if (/Windows/.test(ua)) os = "Windows";
  else if (/iPhone/.test(ua)) os = "iPhone";
  else if (/iPad/.test(ua)) os = "iPad";
  else if (/Android/.test(ua)) { const m = ua.match(/Android [\d.]+; ?([^;)]+)/); os = "Android" + (m ? " (" + m[1].trim() + ")" : ""); }
  else if (/Mac OS X/.test(ua)) os = "Mac";
  else if (/Linux/.test(ua)) os = "Linux";
  let br = "Unknown browser";
  if (/Edg\//.test(ua)) br = "Edge";
  else if (/OPR\/|Opera/.test(ua)) br = "Opera";
  else if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) br = "Chrome";
  else if (/Firefox\//.test(ua)) br = "Firefox";
  else if (/Safari\//.test(ua) && /Version\//.test(ua)) br = "Safari";
  return br + " on " + os;
}

// ---------- auth (paid users / admin) ----------
function setSession(res, token) {
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIES, maxAge: 1000 * 60 * 60 * 24 * 30 });
}
async function currentUser(req) {
  const t = req.cookies.sid;
  if (!t) return null;
  return (await db.get(
    `SELECT u.id,u.username,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id
     WHERE s.token=$1 AND u.active=1`, [t])) || null;
}
async function requireAuth(req, res, next) {
  try {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: "This area is for full-access members. Please log in." });
    req.user = u; next();
  } catch (e) { next(e); }
}
async function requireAdmin(req, res, next) {
  try {
    const u = await currentUser(req);
    if (!u || u.role !== "admin") return res.status(403).json({ error: "Admin access required." });
    req.user = u; next();
  } catch (e) { next(e); }
}

// ---------- guests (free / registered tiers) ----------
async function pickStratified(count) {
  const subs = await db.all("SELECT subject, COUNT(*)::int c FROM questions WHERE active=1 GROUP BY subject");
  if (!subs.length) return [];
  const per = Math.max(1, Math.ceil(count / subs.length));
  let ids = [];
  for (const s of subs) {
    const rows = await db.all("SELECT id FROM questions WHERE active=1 AND subject=$1 ORDER BY random() LIMIT $2", [s.subject, per]);
    ids.push(...rows.map((r) => r.id));
  }
  // shuffle then trim/pad to exactly `count`
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  if (ids.length > count) ids = ids.slice(0, count);
  if (ids.length < count) {
    const have = new Set(ids);
    const extra = (await db.all("SELECT id FROM questions WHERE active=1 ORDER BY random() LIMIT $1", [count * 2])).map((r) => r.id);
    for (const id of extra) { if (ids.length >= count) break; if (!have.has(id)) { ids.push(id); have.add(id); } }
  }
  return ids;
}
async function buildPlaylist(gid, count, startOrd) {
  const existing = new Set((await db.all("SELECT question_id FROM guest_playlist WHERE gid=$1", [gid])).map((r) => r.question_id));
  const chosen = (await pickStratified(count + existing.size)).filter((id) => !existing.has(id)).slice(0, count);
  if (!chosen.length) return;
  const vals = [];
  const params = [];
  let p = 1;
  chosen.forEach((id, i) => { vals.push(`($${p++},$${p++},$${p++})`); params.push(gid, startOrd + i, id); });
  await db.run(`INSERT INTO guest_playlist (gid,ord,question_id) VALUES ${vals.join(",")} ON CONFLICT (gid,ord) DO NOTHING`, params);
}
async function getGuest(req, res) {
  let gid = req.cookies.gid;
  let g = gid ? await db.get("SELECT * FROM guests WHERE gid=$1", [gid]) : null;
  if (!g) {
    gid = "g-" + crypto.randomBytes(16).toString("hex");
    await db.run("INSERT INTO guests (gid,tier) VALUES ($1,'guest')", [gid]);
    res.cookie("gid", gid, { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIES, maxAge: 1000 * 60 * 60 * 24 * 365 });
    g = await db.get("SELECT * FROM guests WHERE gid=$1", [gid]);
  }
  return g;
}
function quotaFor(tier) { return tier === "registered" ? REG_QUOTA : FREE_QUOTA; }

// ---------- public config ----------
app.get("/api/config", (req, res) => {
  res.json({ brand: BRAND, freeQuota: FREE_QUOTA, regQuota: REG_QUOTA, paymentUrl: PAYMENT_URL });
});
app.get("/api/me", async (req, res, next) => {
  try { res.json({ user: await currentUser(req) }); } catch (e) { next(e); }
});

// ---------- time tracking (heartbeat every ~20s from the browser) ----------
app.post("/api/heartbeat", async (req, res) => {
  try {
    const inc = Math.min(60, Math.max(1, parseInt(req.body && req.body.seconds) || 20));
    const u = await currentUser(req);
    if (u) {
      await db.run("UPDATE users SET total_seconds=total_seconds+$1 WHERE id=$2", [inc, u.id]);
    } else if (req.cookies.gid) {
      await db.run("UPDATE guests SET total_seconds=total_seconds+$1 WHERE gid=$2", [inc, req.cookies.gid]);
    }
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false }); }
});

// ---------- model tests (from the PDF): 11 tests, test 1 free, 60-minute timer ----------
app.get("/api/modeltests", async (req, res, next) => {
  try {
    const rows = await db.all("SELECT test_no, COUNT(*)::int c FROM model_tests GROUP BY test_no ORDER BY test_no");
    const isMember = !!(await currentUser(req));
    const tests = [];
    for (const r of rows) {
      const takers = (await db.get("SELECT COUNT(*)::int c FROM model_test_results WHERE test_no=$1", [r.test_no])).c;
      tests.push({ test_no: r.test_no, count: r.c, free: r.test_no === 1, locked: r.test_no !== 1 && !isMember, takers });
    }
    res.json({ isMember, tests });
  } catch (e) { next(e); }
});
app.get("/api/modeltest/:n", async (req, res, next) => {
  try {
    const n = parseInt(req.params.n) || 0;
    if (n !== 1) {
      const u = await currentUser(req);
      if (!u) return res.status(403).json({ error: "Only Model Test 1 is free. Get full access to unlock all 11 model tests.", locked: true });
    }
    const rows = await db.all("SELECT q_no,stem,opta,optb,optc,optd,answer FROM model_tests WHERE test_no=$1 ORDER BY q_no", [n]);
    if (!rows.length) return res.status(404).json({ error: "Model test not found." });
    res.json({
      test_no: n, durationSec: 3600,
      questions: rows.map((q) => ({ id: q.q_no, stem: q.stem, options: [q.opta, q.optb, q.optc, q.optd], answer: q.answer })),
    });
  } catch (e) { next(e); }
});
app.post("/api/modeltest/:n/result", async (req, res, next) => {
  try {
    const n = parseInt(req.params.n) || 0;
    const total = Math.max(1, parseInt(req.body && req.body.total) || 100);
    const score = Math.min(total, Math.max(0, parseInt(req.body && req.body.score) || 0));
    const u = await currentUser(req);
    let ref = "anon", name = "Anonymous";
    if (u) { ref = "u:" + u.id; name = u.name || u.username; }
    else if (req.cookies.gid) {
      ref = "g:" + req.cookies.gid;
      const g = await db.get("SELECT name FROM guests WHERE gid=$1", [req.cookies.gid]);
      name = (g && g.name) || "Guest";
    }
    await db.run("INSERT INTO model_test_results (test_no,ref,name,score,total) VALUES ($1,$2,$3,$4,$5)", [n, ref, name, score, total]);
    const takers = (await db.get("SELECT COUNT(*)::int c FROM model_test_results WHERE test_no=$1", [n])).c;
    const better = (await db.get("SELECT COUNT(*)::int c FROM model_test_results WHERE test_no=$1 AND score>$2", [n, score])).c;
    const rank = better + 1;
    const percentile = takers > 1 ? Math.round((takers - rank) / (takers - 1) * 100) : 100;
    const avg = (await db.get("SELECT COALESCE(AVG(score),0)::float a FROM model_test_results WHERE test_no=$1", [n])).a;
    const pct = Math.round(score / total * 100);
    const category = pct >= 80 ? "Excellent" : pct >= 65 ? "Very good" : pct >= 50 ? "Good" : pct >= 35 ? "Average" : "Needs improvement";
    res.json({ rank, takers, percentile, category, pct, avgScore: Math.round(Number(avg)) });
  } catch (e) { next(e); }
});

// ---------- free / registered feed ----------
app.get("/api/feed", async (req, res, next) => {
  try {
    const g = await getGuest(req, res);
    const quota = quotaFor(g.tier);   // 50 for guests, 100 after sign-up
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 10;
    const subject = String(req.query.subject || "").trim();
    const heading = String(req.query.heading || "").trim();
    // Shared free pool: the same ~100 free questions for everyone, ranked by id.
    // Guests see the first 50, registered users all 100; the rest is locked.
    const params = [quota];
    let filterSql = "";
    if (subject) { params.push(subject); filterSql += ` AND subject=$${params.length}`; }
    if (heading) { params.push(heading); filterSql += ` AND heading=$${params.length}`; }
    const cte = `WITH fp AS (SELECT *, row_number() OVER (ORDER BY id) rn FROM questions WHERE active=1 AND is_free=1)`;
    const totalRow = await db.get(`${cte} SELECT COUNT(*)::int c FROM fp WHERE rn<=$1${filterSql}`, params);
    const total = totalRow.c;
    const rows = await db.all(
      `${cte} SELECT * FROM fp WHERE rn<=$1${filterSql} ORDER BY rn LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, (page - 1) * pageSize]);
    const questions = rows.map((q) => ({
      id: q.id, subject: q.subject, heading: q.heading, difficulty: q.difficulty, style: q.style,
      stem: q.stem, options: [q.opta, q.optb, q.optc, q.optd], answer: q.answer, explanation: q.explanation, bookmarked: false,
    }));
    res.json({ tier: g.tier, quota, total, page, pageSize, questions, canSignup: g.tier === "guest", atPaymentWall: false, freeTotal: 100 });
  } catch (e) { next(e); }
});

// ---------- sign-up (free -> registered, +100) ----------
app.post("/api/signup", async (req, res, next) => {
  try {
    const g = await getGuest(req, res);
    if (g.tier !== "guest") return res.status(400).json({ error: "You have already registered." });
    const name = String(req.body.name || "").trim();
    const medical = String(req.body.medical || "").trim();
    const session = String(req.body.session || "").trim();
    const email = String(req.body.email || "").trim();
    const whatsapp = String(req.body.whatsapp || "").trim();
    const bought = String(req.body.bought_book || "").trim();
    if (!name || !medical || !session || !email || !whatsapp || !bought)
      return res.status(400).json({ error: "All fields are required (Name, Medical College, Session, Gmail, WhatsApp, and the book question)." });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.status(400).json({ error: "Please enter a valid email address." });
    if (!/^[+0-9][0-9\s-]{7,}$/.test(whatsapp))
      return res.status(400).json({ error: "Please enter a valid WhatsApp number." });
    await db.run("UPDATE guests SET tier='registered', name=$1, medical=$2, session=$3, whatsapp=$4, email=$5, bought_book=$6, signup_at=now() WHERE gid=$7",
      [name, medical, session, whatsapp, email, bought, g.gid]);
    res.json({ ok: true, tier: "registered", quota: REG_QUOTA });
  } catch (e) { next(e); }
});

// ---------- subject/topic tree (public: powers the browse sidebar for everyone) ----------
app.get("/api/subjects", async (req, res, next) => {
  try {
    const subs = await db.all("SELECT subject, COUNT(*)::int c FROM questions WHERE active=1 GROUP BY subject ORDER BY MIN(id)");
    const tree = [];
    for (const s of subs) {
      const headings = await db.all("SELECT heading, COUNT(*)::int c FROM questions WHERE active=1 AND subject=$1 GROUP BY heading ORDER BY MIN(id)", [s.subject]);
      tree.push({ subject: s.subject, count: s.c, headings });
    }
    const totalRow = await db.get("SELECT COUNT(*)::int c FROM questions WHERE active=1");
    res.json({ total: totalRow.c, subjects: tree });
  } catch (e) { next(e); }
});
app.get("/api/questions", requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const { subject, heading, search, difficulty } = req.query;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 10));
    const where = ["active=1"];
    const params = [];
    if (subject) { params.push(subject); where.push(`subject=$${params.length}`); }
    if (heading) { params.push(heading); where.push(`heading=$${params.length}`); }
    if (difficulty) { params.push(difficulty); where.push(`difficulty=$${params.length}`); }
    if (search) { params.push("%" + search + "%"); const i = params.length; where.push(`(stem ILIKE $${i} OR explanation ILIKE $${i} OR concept ILIKE $${i})`); }
    let idClause = "";
    if (req.query.bookmarked === "1") {
      const ids = (await db.all("SELECT question_id FROM bookmarks WHERE user_id=$1", [user.id]))
        .map((r) => parseInt(r.question_id, 10)).filter(Number.isFinite);
      if (!ids.length) return res.json({ total: 0, page, pageSize, questions: [] });
      idClause = " AND id IN (" + ids.join(",") + ")";
    }
    const w = where.join(" AND ") + idClause;
    const totalRow = await db.get(`SELECT COUNT(*)::int c FROM questions WHERE ${w}`, params);
    const limIdx = params.length + 1, offIdx = params.length + 2;
    const rows = await db.all(`SELECT * FROM questions WHERE ${w} ORDER BY id LIMIT $${limIdx} OFFSET $${offIdx}`,
      [...params, pageSize, (page - 1) * pageSize]);
    const bmset = new Set((await db.all("SELECT question_id FROM bookmarks WHERE user_id=$1", [user.id])).map((r) => r.question_id));
    res.json({
      total: totalRow.c, page, pageSize, questions: rows.map((q) => ({
        id: q.id, subject: q.subject, heading: q.heading, difficulty: q.difficulty, style: q.style,
        stem: q.stem, options: [q.opta, q.optb, q.optc, q.optd], answer: q.answer, explanation: q.explanation,
        bookmarked: bmset.has(q.id),
      })),
    });
  } catch (e) { next(e); }
});

// ---------- login / logout ----------
app.post("/api/login", async (req, res, next) => {
  try {
    const { username, password, device_id } = req.body || {};
    if (!username || !password || !device_id) return res.status(400).json({ error: "Username, password and device id required." });
    const u = await db.get("SELECT * FROM users WHERE username=$1", [String(username).trim()]);
    if (!u || !db.bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: "Invalid username or password." });
    if (!u.active) return res.status(403).json({ error: "This account is disabled. Contact the administrator." });
    const multiAllowed = u.role === "admin" || u.multi_device;
    if (u.role !== "admin" && !u.multi_device) {
      // Single-device members are locked to their first device.
      if (!u.device_id) await db.run("UPDATE users SET device_id=$1 WHERE id=$2", [device_id, u.id]);
      else if (u.device_id !== device_id) return res.status(403).json({ error: "This account is locked to another device. Ask the administrator to allow multi-device or reset your device." });
    }
    // Non-multi-device (and admin) accounts keep only one active session.
    if (!multiAllowed || u.role === "admin") await db.run("DELETE FROM sessions WHERE user_id=$1", [u.id]);
    const token = crypto.randomBytes(24).toString("hex");
    await db.run("INSERT INTO sessions (token,user_id,device_id,ip,device) VALUES ($1,$2,$3,$4,$5)",
      [token, u.id, device_id, clientIp(req), parseDevice(req.headers["user-agent"])]);
    await db.run("UPDATE users SET last_ip=$1, last_device=$2, last_login_at=now() WHERE id=$3",
      [clientIp(req), parseDevice(req.headers["user-agent"]), u.id]);
    setSession(res, token);
    res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
  } catch (e) { next(e); }
});
app.post("/api/logout", async (req, res, next) => {
  try {
    const t = req.cookies.sid;
    if (t) await db.run("DELETE FROM sessions WHERE token=$1", [t]);
    res.clearCookie("sid"); res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- flags (anyone) ----------
app.post("/api/flag", async (req, res, next) => {
  try {
    const user = await currentUser(req);
    const { question_id, reason } = req.body || {};
    if (!question_id) return res.status(400).json({ error: "question_id required" });
    if (!(await db.get("SELECT id FROM questions WHERE id=$1", [question_id]))) return res.status(404).json({ error: "Question not found" });
    await db.run("INSERT INTO flags (question_id,user_id,reason) VALUES ($1,$2,$3)", [question_id, user ? user.id : null, String(reason || "").slice(0, 500)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// ---------- bookmarks / attempts (paid members) ----------
app.get("/api/bookmarks", requireAuth, async (req, res, next) => {
  try {
    const ids = (await db.all("SELECT question_id FROM bookmarks WHERE user_id=$1", [req.user.id])).map((r) => r.question_id);
    res.json({ ids });
  } catch (e) { next(e); }
});
app.post("/api/bookmarks", requireAuth, async (req, res, next) => {
  try {
    const { question_id, on } = req.body || {};
    if (on) await db.run("INSERT INTO bookmarks (user_id,question_id) VALUES ($1,$2) ON CONFLICT (user_id,question_id) DO NOTHING", [req.user.id, question_id]);
    else await db.run("DELETE FROM bookmarks WHERE user_id=$1 AND question_id=$2", [req.user.id, question_id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/attempt", requireAuth, async (req, res, next) => {
  try {
    const { question_id, chosen } = req.body || {};
    const q = await db.get("SELECT answer FROM questions WHERE id=$1", [question_id]);
    if (!q) return res.status(404).json({ error: "not found" });
    const correct = q.answer === chosen ? 1 : 0;
    await db.run(`INSERT INTO attempts (user_id,question_id,chosen,correct) VALUES ($1,$2,$3,$4)
      ON CONFLICT (user_id,question_id) DO UPDATE SET chosen=excluded.chosen, correct=excluded.correct, created_at=now()`,
      [req.user.id, question_id, chosen, correct]);
    res.json({ ok: true, correct: !!correct });
  } catch (e) { next(e); }
});

// ---------- admin ----------
app.get("/api/admin/stats", requireAdmin, async (req, res, next) => {
  try {
    res.json({
      questions: (await db.get("SELECT COUNT(*)::int c FROM questions WHERE active=1")).c,
      users: (await db.get("SELECT COUNT(*)::int c FROM users WHERE role='user'")).c,
      leads: (await db.get("SELECT COUNT(*)::int c FROM guests WHERE tier='registered'")).c,
      openFlags: (await db.get("SELECT COUNT(*)::int c FROM flags WHERE resolved=0")).c,
    });
  } catch (e) { next(e); }
});
app.get("/api/admin/users", requireAdmin, async (req, res, next) => {
  try {
    const users = await db.all(`SELECT id,username,name,active,created_at,last_ip,last_device,last_login_at,total_seconds,multi_device,
       (device_id IS NOT NULL) AS bound,
       (SELECT COUNT(*)::int FROM sessions s WHERE s.user_id=users.id) AS active_sessions
       FROM users WHERE role='user' ORDER BY id DESC`);
    res.json({ users });
  } catch (e) { next(e); }
});
app.post("/api/admin/users", requireAdmin, async (req, res, next) => {
  try {
    const { username, name, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });
    if (await db.get("SELECT id FROM users WHERE username=$1", [String(username).trim()])) return res.status(409).json({ error: "Username already exists." });
    await db.run("INSERT INTO users (username,name,password_hash,role) VALUES ($1,$2,$3,'user')", [String(username).trim(), name || "", db.bcrypt.hashSync(password, 10)]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/users/:id/reset-device", requireAdmin, async (req, res, next) => {
  try {
    await db.run("UPDATE users SET device_id=NULL WHERE id=$1 AND role='user'", [req.params.id]);
    await db.run("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
// Allow / disallow a specific member to log in from multiple devices at once.
app.post("/api/admin/users/:id/multi-device", requireAdmin, async (req, res, next) => {
  try {
    const on = req.body.on ? 1 : 0;
    await db.run("UPDATE users SET multi_device=$1 WHERE id=$2 AND role='user'", [on, req.params.id]);
    if (!on) {
      // Revoke extra devices: clear the device binding and log the member out everywhere.
      await db.run("UPDATE users SET device_id=NULL WHERE id=$1", [req.params.id]);
      await db.run("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
    }
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/users/:id/active", requireAdmin, async (req, res, next) => {
  try {
    const a = req.body.active ? 1 : 0;
    await db.run("UPDATE users SET active=$1 WHERE id=$2 AND role='user'", [a, req.params.id]);
    if (!a) await db.run("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/users/:id/password", requireAdmin, async (req, res, next) => {
  try {
    if (!req.body.password) return res.status(400).json({ error: "password required" });
    await db.run("UPDATE users SET password_hash=$1 WHERE id=$2 AND role='user'", [db.bcrypt.hashSync(req.body.password, 10), req.params.id]);
    await db.run("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete("/api/admin/users/:id", requireAdmin, async (req, res, next) => {
  try { await db.run("DELETE FROM users WHERE id=$1 AND role='user'", [req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
app.post("/api/admin/change-password", requireAdmin, async (req, res, next) => {
  try {
    const p = req.body.password || "";
    if (p.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
    await db.run("UPDATE users SET password_hash=$1 WHERE id=$2", [db.bcrypt.hashSync(p, 10), req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

// leads (sign-ups)
app.get("/api/admin/leads", requireAdmin, async (req, res, next) => {
  try {
    const leads = await db.all(`SELECT gid,name,medical,session,email,whatsapp,bought_book,signup_at,converted_user_id,
       (SELECT username FROM users u WHERE u.id=guests.converted_user_id) AS username
       FROM guests WHERE tier='registered' ORDER BY signup_at DESC LIMIT 1000`);
    res.json({ leads });
  } catch (e) { next(e); }
});
app.post("/api/admin/leads/:gid/convert", requireAdmin, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: "username and password required" });
    const g = await db.get("SELECT * FROM guests WHERE gid=$1 AND tier='registered'", [req.params.gid]);
    if (!g) return res.status(404).json({ error: "Lead not found." });
    if (await db.get("SELECT id FROM users WHERE username=$1", [String(username).trim()])) return res.status(409).json({ error: "Username already exists." });
    const ins = await db.get("INSERT INTO users (username,name,password_hash,role) VALUES ($1,$2,$3,'user') RETURNING id",
      [String(username).trim(), g.name || "", db.bcrypt.hashSync(password, 10)]);
    await db.run("UPDATE guests SET converted_user_id=$1 WHERE gid=$2", [ins.id, g.gid]);
    res.json({ ok: true, username: String(username).trim() });
  } catch (e) { next(e); }
});

// download sign-ups (leads) as an Excel file
app.get("/api/admin/leads.xlsx", requireAdmin, async (req, res, next) => {
  try {
    const leads = await db.all(`SELECT name,medical,session,email,whatsapp,bought_book,signup_at,converted_user_id,
       (SELECT username FROM users u WHERE u.id=guests.converted_user_id) AS username
       FROM guests WHERE tier='registered' ORDER BY signup_at DESC LIMIT 5000`);
    const header = ["Name", "Medical college", "Session", "Gmail", "WhatsApp", "Bought Password BCS & Q-Verse book", "Signed up", "Status", "Member username"];
    const rows = leads.map((l) => [
      l.name || "", l.medical || "", l.session || "", l.email || "", l.whatsapp || "", l.bought_book || "",
      l.signup_at ? new Date(l.signup_at).toISOString().slice(0, 16).replace("T", " ") : "",
      l.converted_user_id ? "Member (paid)" : "Not yet",
      l.username || "",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws["!cols"] = [22, 24, 12, 24, 18, 16, 18, 14, 18].map((w) => ({ wch: w }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Sign-ups");
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader("Content-Disposition", `attachment; filename=signups-${stamp}.xlsx`);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
  } catch (e) { next(e); }
});

// flags admin
app.get("/api/admin/flags", requireAdmin, async (req, res, next) => {
  try {
    const flags = await db.all(`SELECT f.id,f.question_id,f.reason,f.resolved,f.created_at,q.subject,q.heading,q.stem
       FROM flags f JOIN questions q ON q.id=f.question_id ORDER BY f.resolved, f.id DESC LIMIT 500`);
    res.json({ flags });
  } catch (e) { next(e); }
});
app.post("/api/admin/flags/:id/resolve", requireAdmin, async (req, res, next) => {
  try { await db.run("UPDATE flags SET resolved=1 WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
app.post("/api/admin/questions/:id/delete", requireAdmin, async (req, res, next) => {
  try { await db.run("UPDATE questions SET active=0 WHERE id=$1", [req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});

// upload questions
app.post("/api/admin/upload", requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const { questions, errors } = await parseFile(req.file.path, req.file.originalname);
    let inserted = 0;
    if (questions.length) {
      const maxRow = await db.get("SELECT COALESCE(MAX(id),0)::int m FROM questions");
      let id = maxRow.m;
      const items = questions.map((q) => ({
        id: ++id, subject: q.subject, heading: q.heading, concept: "",
        difficulty: q.difficulty, style: q.style, stem: q.stem,
        opta: q.options[0], optb: q.options[1], optc: q.options[2], optd: q.options[3],
        answer: q.answer, explanation: q.explanation || "",
      }));
      inserted = await db.bulkInsertQuestions(items);
    }
    res.json({ inserted, skipped: errors.length, errors: errors.slice(0, 25), message: `${inserted} question(s) added.` + (errors.length ? ` ${errors.length} row(s) skipped.` : "") });
  } catch (e) { res.status(500).json({ error: "Failed to parse file: " + e.message }); }
  finally { fs.unlink(req.file.path, () => {}); }
});
app.get("/api/admin/template", requireAdmin, (req, res) => {
  const header = ["Subject", "Heading", "Question", "Option A", "Option B", "Option C", "Option D", "Answer", "Difficulty", "Style", "Explanation"];
  const sample = ["Cardiology", "Heart Failure", "First-line drug improving survival in HFrEF?", "Digoxin", "ACE inhibitor", "Furosemide", "Amlodipine", "B", "Moderate", "Drug of Choice", "**ACE inhibitors** improve survival in HFrEF."];
  const ws = XLSX.utils.aoa_to_sheet([header, sample]);
  ws["!cols"] = [16, 18, 46, 18, 18, 18, 18, 8, 12, 16, 50].map((w) => ({ wch: w }));
  const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Questions");
  res.setHeader("Content-Disposition", "attachment; filename=question_upload_template.xlsx");
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));
});

// ---------- pages ----------
app.use(express.static(path.join(__dirname, "public")));
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// ---------- error handler ----------
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Server error." });
});

// Only start a listening server when run directly (local dev).
// On Vercel the app is imported by api/index.js as a serverless handler.
if (require.main === module) {
  app.listen(PORT, () => console.log(`\n  ${BRAND} running at  http://localhost:${PORT}\n  Admin panel:  http://localhost:${PORT}/admin\n`));
}

module.exports = app;
