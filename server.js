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
const FREE_QUOTA = 100;          // guest (no account)
const REG_QUOTA = 200;           // after free sign-up (100 + 100)
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

// ---------- auth (paid users / admin) ----------
function setSession(res, token) {
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: SECURE_COOKIES, maxAge: 1000 * 60 * 60 * 24 * 30 });
}
async function currentUser(req) {
  const t = req.cookies.sid;
  if (!t) return null;
  return (await db.get("SELECT id,username,name,role,active FROM users WHERE session_token=$1 AND active=1", [t])) || null;
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
    await buildPlaylist(gid, FREE_QUOTA, 1);
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

// ---------- free / registered feed ----------
app.get("/api/feed", async (req, res, next) => {
  try {
    const g = await getGuest(req, res);
    const quota = quotaFor(g.tier);
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const pageSize = 10;
    const totalRow = await db.get("SELECT COUNT(*)::int c FROM guest_playlist WHERE gid=$1 AND ord<=$2", [g.gid, quota]);
    const total = Math.min(quota, totalRow.c);
    const rows = await db.all(
      `SELECT q.* FROM guest_playlist p JOIN questions q ON q.id=p.question_id
       WHERE p.gid=$1 AND p.ord<=$2 ORDER BY p.ord LIMIT $3 OFFSET $4`,
      [g.gid, quota, pageSize, (page - 1) * pageSize]);
    const questions = rows.map((q) => ({
      id: q.id, subject: q.subject, heading: q.heading, difficulty: q.difficulty, style: q.style,
      stem: q.stem, options: [q.opta, q.optb, q.optc, q.optd], answer: q.answer, explanation: q.explanation, bookmarked: false,
    }));
    res.json({ tier: g.tier, quota, total, page, pageSize, questions, canSignup: g.tier === "guest", atPaymentWall: false });
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
    const whatsapp = String(req.body.whatsapp || "").trim();
    if (!name || !medical || !session || !whatsapp)
      return res.status(400).json({ error: "All fields (Name, Medical College, Session, WhatsApp number) are required." });
    if (!/^[+0-9][0-9\s-]{7,}$/.test(whatsapp))
      return res.status(400).json({ error: "Please enter a valid WhatsApp number." });
    await db.run("UPDATE guests SET tier='registered', name=$1, medical=$2, session=$3, whatsapp=$4, signup_at=now() WHERE gid=$5",
      [name, medical, session, whatsapp, g.gid]);
    await buildPlaylist(g.gid, REG_QUOTA - FREE_QUOTA, FREE_QUOTA + 1); // add the next 100
    res.json({ ok: true, tier: "registered", quota: REG_QUOTA });
  } catch (e) { next(e); }
});

// ---------- full access (paid members only) ----------
app.get("/api/subjects", requireAuth, async (req, res, next) => {
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
    if (u.role !== "admin") {
      if (!u.device_id) await db.run("UPDATE users SET device_id=$1 WHERE id=$2", [device_id, u.id]);
      else if (u.device_id !== device_id) return res.status(403).json({ error: "This account is locked to another device. Contact the administrator to reset it." });
    }
    const token = crypto.randomBytes(24).toString("hex");
    await db.run("UPDATE users SET session_token=$1 WHERE id=$2", [token, u.id]);
    setSession(res, token);
    res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
  } catch (e) { next(e); }
});
app.post("/api/logout", async (req, res, next) => {
  try {
    const t = req.cookies.sid;
    if (t) await db.run("UPDATE users SET session_token=NULL WHERE session_token=$1", [t]);
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
    const users = await db.all(`SELECT id,username,name,active,created_at,(device_id IS NOT NULL) AS bound
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
  try { await db.run("UPDATE users SET device_id=NULL, session_token=NULL WHERE id=$1 AND role='user'", [req.params.id]); res.json({ ok: true }); }
  catch (e) { next(e); }
});
app.post("/api/admin/users/:id/active", requireAdmin, async (req, res, next) => {
  try {
    const a = req.body.active ? 1 : 0;
    await db.run("UPDATE users SET active=$1, session_token=CASE WHEN $2=0 THEN NULL ELSE session_token END WHERE id=$3 AND role='user'", [a, a, req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post("/api/admin/users/:id/password", requireAdmin, async (req, res, next) => {
  try {
    if (!req.body.password) return res.status(400).json({ error: "password required" });
    await db.run("UPDATE users SET password_hash=$1, session_token=NULL WHERE id=$2 AND role='user'", [db.bcrypt.hashSync(req.body.password, 10), req.params.id]);
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
    const leads = await db.all(`SELECT gid,name,medical,session,whatsapp,signup_at,converted_user_id,
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
    const leads = await db.all(`SELECT name,medical,session,whatsapp,signup_at,converted_user_id,
       (SELECT username FROM users u WHERE u.id=guests.converted_user_id) AS username
       FROM guests WHERE tier='registered' ORDER BY signup_at DESC LIMIT 5000`);
    const header = ["Name", "Medical college", "Session", "WhatsApp", "Signed up", "Status", "Member username"];
    const rows = leads.map((l) => [
      l.name || "", l.medical || "", l.session || "", l.whatsapp || "",
      l.signup_at ? new Date(l.signup_at).toISOString().slice(0, 16).replace("T", " ") : "",
      l.converted_user_id ? "Member (paid)" : "Not yet",
      l.username || "",
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    ws["!cols"] = [22, 24, 12, 18, 18, 14, 18].map((w) => ({ wch: w }));
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
