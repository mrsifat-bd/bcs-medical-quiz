const major = parseInt(process.versions.node.split(".")[0], 10);
const minor = parseInt(process.versions.node.split(".")[1], 10);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error("\n  This app needs Node.js 22.5 or newer (it uses the built-in SQLite).\n  Your version: " + process.version + "\n  Please install Node 22 LTS from https://nodejs.org and run again.\n");
  process.exit(1);
}
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const cookieParser = require("cookie-parser");
const multer = require("multer");
const XLSX = require("xlsx");
const { db, init, bcrypt } = require("./src/db");
const { parseFile } = require("./src/parse");

// ---------- configuration ----------
const BRAND = "MediVerse BCS Question Bank";
const FREE_QUOTA = 100;          // guest (no account)
const REG_QUOTA = 200;           // after free sign-up (100 + 100)
// The payment / registration form link students are sent to.
const PAYMENT_URL = process.env.PAYMENT_URL ||
  "https://docs.google.com/forms/d/1avDCTQBsNAKXKII1gvTIJoNFnasdXA3TR8xB1Ydzoa4/edit";

init();
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());
const upload = multer({ dest: path.join(__dirname, "uploads"), limits: { fileSize: 15 * 1024 * 1024 } });

// ---------- auth (paid users / admin) ----------
function setSession(res, token) {
  res.cookie("sid", token, { httpOnly: true, sameSite: "lax", secure: !!process.env.HTTPS, maxAge: 1000 * 60 * 60 * 24 * 30 });
}
function currentUser(req) {
  const t = req.cookies.sid;
  if (!t) return null;
  return db.prepare("SELECT id,username,name,role,active FROM users WHERE session_token=? AND active=1").get(t) || null;
}
function requireAuth(req, res, next) {
  const u = currentUser(req); if (!u) return res.status(401).json({ error: "This area is for full-access members. Please log in." });
  req.user = u; next();
}
function requireAdmin(req, res, next) {
  const u = currentUser(req); if (!u || u.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  req.user = u; next();
}

// ---------- guests (free / registered tiers) ----------
function pickStratified(count) {
  const subs = db.prepare("SELECT subject, COUNT(*) c FROM questions WHERE active=1 GROUP BY subject").all();
  if (!subs.length) return [];
  const per = Math.max(1, Math.ceil(count / subs.length));
  let ids = [];
  const q = db.prepare("SELECT id FROM questions WHERE active=1 AND subject=? ORDER BY RANDOM() LIMIT ?");
  for (const s of subs) ids.push(...q.all(s.subject, per).map(r => r.id));
  // shuffle then trim/pad to exactly `count`
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
  if (ids.length > count) ids = ids.slice(0, count);
  if (ids.length < count) {
    const have = new Set(ids);
    const extra = db.prepare("SELECT id FROM questions WHERE active=1 ORDER BY RANDOM() LIMIT ?").all(count * 2).map(r => r.id);
    for (const id of extra) { if (ids.length >= count) break; if (!have.has(id)) { ids.push(id); have.add(id); } }
  }
  return ids;
}
function buildPlaylist(gid, count, startOrd) {
  const existing = new Set(db.prepare("SELECT question_id FROM guest_playlist WHERE gid=?").all(gid).map(r => r.question_id));
  let chosen = pickStratified(count + existing.size).filter(id => !existing.has(id)).slice(0, count);
  const ins = db.prepare("INSERT OR IGNORE INTO guest_playlist (gid,ord,question_id) VALUES (?,?,?)");
  db.transaction(() => { chosen.forEach((id, i) => ins.run(gid, startOrd + i, id)); })();
}
function getGuest(req, res) {
  let gid = req.cookies.gid;
  let g = gid ? db.prepare("SELECT * FROM guests WHERE gid=?").get(gid) : null;
  if (!g) {
    gid = "g-" + crypto.randomBytes(16).toString("hex");
    db.prepare("INSERT INTO guests (gid,tier) VALUES (?, 'guest')").run(gid);
    buildPlaylist(gid, FREE_QUOTA, 1);
    res.cookie("gid", gid, { httpOnly: true, sameSite: "lax", secure: !!process.env.HTTPS, maxAge: 1000 * 60 * 60 * 24 * 365 });
    g = db.prepare("SELECT * FROM guests WHERE gid=?").get(gid);
  }
  return g;
}
function quotaFor(tier) { return tier === "registered" ? REG_QUOTA : FREE_QUOTA; }

// ---------- public config ----------
app.get("/api/config", (req, res) => {
  res.json({ brand: BRAND, freeQuota: FREE_QUOTA, regQuota: REG_QUOTA, paymentUrl: PAYMENT_URL });
});
app.get("/api/me", (req, res) => res.json({ user: currentUser(req) }));

// ---------- free / registered feed ----------
app.get("/api/feed", (req, res) => {
  const g = getGuest(req, res);
  const quota = quotaFor(g.tier);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = 10;
  const total = Math.min(quota, db.prepare("SELECT COUNT(*) c FROM guest_playlist WHERE gid=? AND ord<=?").get(g.gid, quota).c);
  const rows = db.prepare(`SELECT q.* FROM guest_playlist p JOIN questions q ON q.id=p.question_id
     WHERE p.gid=? AND p.ord<=? ORDER BY p.ord LIMIT ? OFFSET ?`)
    .all(g.gid, quota, pageSize, (page - 1) * pageSize);
  const questions = rows.map(q => ({
    id: q.id, subject: q.subject, heading: q.heading, difficulty: q.difficulty, style: q.style,
    stem: q.stem, options: [q.optA, q.optB, q.optC, q.optD], answer: q.answer, explanation: q.explanation, bookmarked: false,
  }));
  res.json({ tier: g.tier, quota, total, page, pageSize, questions,
    canSignup: g.tier === "guest", atPaymentWall: false });
});

// ---------- sign-up (free -> registered, +100) ----------
app.post("/api/signup", (req, res) => {
  const g = getGuest(req, res);
  if (g.tier !== "guest") return res.status(400).json({ error: "You have already registered." });
  const name = String((req.body.name || "")).trim();
  const medical = String((req.body.medical || "")).trim();
  const session = String((req.body.session || "")).trim();
  const whatsapp = String((req.body.whatsapp || "")).trim();
  if (!name || !medical || !session || !whatsapp)
    return res.status(400).json({ error: "All fields (Name, Medical College, Session, WhatsApp number) are required." });
  if (!/^[+0-9][0-9\s-]{7,}$/.test(whatsapp))
    return res.status(400).json({ error: "Please enter a valid WhatsApp number." });
  db.prepare("UPDATE guests SET tier='registered', name=?, medical=?, session=?, whatsapp=?, signup_at=datetime('now') WHERE gid=?")
    .run(name, medical, session, whatsapp, g.gid);
  buildPlaylist(g.gid, REG_QUOTA - FREE_QUOTA, FREE_QUOTA + 1); // add the next 100
  res.json({ ok: true, tier: "registered", quota: REG_QUOTA });
});

// ---------- full access (paid members only) ----------
app.get("/api/subjects", requireAuth, (req, res) => {
  const subs = db.prepare("SELECT subject, COUNT(*) c FROM questions WHERE active=1 GROUP BY subject ORDER BY MIN(id)").all();
  const headStmt = db.prepare("SELECT heading, COUNT(*) c FROM questions WHERE active=1 AND subject=? GROUP BY heading ORDER BY MIN(id)");
  const tree = subs.map(s => ({ subject: s.subject, count: s.c, headings: headStmt.all(s.subject) }));
  res.json({ total: db.prepare("SELECT COUNT(*) c FROM questions WHERE active=1").get().c, subjects: tree });
});
app.get("/api/questions", requireAuth, (req, res) => {
  const user = req.user;
  const { subject, heading, search, difficulty } = req.query;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const pageSize = Math.min(50, Math.max(1, parseInt(req.query.pageSize) || 10));
  const where = ["active=1"], params = {};
  if (subject) { where.push("subject=@subject"); params.subject = subject; }
  if (heading) { where.push("heading=@heading"); params.heading = heading; }
  if (difficulty) { where.push("difficulty=@difficulty"); params.difficulty = difficulty; }
  if (search) { where.push("(stem LIKE @s OR explanation LIKE @s OR concept LIKE @s)"); params.s = "%" + search + "%"; }
  let idClause = "";
  if (req.query.bookmarked === "1") {
    const ids = db.prepare("SELECT question_id FROM bookmarks WHERE user_id=?").all(user.id).map(r => r.question_id);
    if (!ids.length) return res.json({ total: 0, page, pageSize, questions: [] });
    idClause = " AND id IN (" + ids.join(",") + ")";
  }
  const w = where.join(" AND ") + idClause;
  const total = db.prepare(`SELECT COUNT(*) c FROM questions WHERE ${w}`).get(params).c;
  const rows = db.prepare(`SELECT * FROM questions WHERE ${w} ORDER BY id LIMIT @lim OFFSET @off`)
    .all({ ...params, lim: pageSize, off: (page - 1) * pageSize });
  const bmset = new Set(db.prepare("SELECT question_id FROM bookmarks WHERE user_id=?").all(user.id).map(r => r.question_id));
  res.json({ total, page, pageSize, questions: rows.map(q => ({
    id: q.id, subject: q.subject, heading: q.heading, difficulty: q.difficulty, style: q.style,
    stem: q.stem, options: [q.optA, q.optB, q.optC, q.optD], answer: q.answer, explanation: q.explanation,
    bookmarked: bmset.has(q.id) })) });
});

// ---------- login / logout ----------
app.post("/api/login", (req, res) => {
  const { username, password, device_id } = req.body || {};
  if (!username || !password || !device_id) return res.status(400).json({ error: "Username, password and device id required." });
  const u = db.prepare("SELECT * FROM users WHERE username=?").get(String(username).trim());
  if (!u || !bcrypt.compareSync(password, u.password_hash)) return res.status(401).json({ error: "Invalid username or password." });
  if (!u.active) return res.status(403).json({ error: "This account is disabled. Contact the administrator." });
  if (u.role !== "admin") {
    if (!u.device_id) db.prepare("UPDATE users SET device_id=? WHERE id=?").run(device_id, u.id);
    else if (u.device_id !== device_id) return res.status(403).json({ error: "This account is locked to another device. Contact the administrator to reset it." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  db.prepare("UPDATE users SET session_token=? WHERE id=?").run(token, u.id);
  setSession(res, token);
  res.json({ id: u.id, username: u.username, name: u.name, role: u.role });
});
app.post("/api/logout", (req, res) => {
  const t = req.cookies.sid; if (t) db.prepare("UPDATE users SET session_token=NULL WHERE session_token=?").run(t);
  res.clearCookie("sid"); res.json({ ok: true });
});

// ---------- flags (anyone) ----------
app.post("/api/flag", (req, res) => {
  const user = currentUser(req);
  const { question_id, reason } = req.body || {};
  if (!question_id) return res.status(400).json({ error: "question_id required" });
  if (!db.prepare("SELECT id FROM questions WHERE id=?").get(question_id)) return res.status(404).json({ error: "Question not found" });
  db.prepare("INSERT INTO flags (question_id,user_id,reason) VALUES (?,?,?)").run(question_id, user ? user.id : null, String(reason || "").slice(0, 500));
  res.json({ ok: true });
});

// ---------- bookmarks / attempts (paid members) ----------
app.get("/api/bookmarks", requireAuth, (req, res) => res.json({ ids: db.prepare("SELECT question_id FROM bookmarks WHERE user_id=?").all(req.user.id).map(r => r.question_id) }));
app.post("/api/bookmarks", requireAuth, (req, res) => {
  const { question_id, on } = req.body || {};
  if (on) db.prepare("INSERT OR IGNORE INTO bookmarks (user_id,question_id) VALUES (?,?)").run(req.user.id, question_id);
  else db.prepare("DELETE FROM bookmarks WHERE user_id=? AND question_id=?").run(req.user.id, question_id);
  res.json({ ok: true });
});
app.post("/api/attempt", requireAuth, (req, res) => {
  const { question_id, chosen } = req.body || {};
  const q = db.prepare("SELECT answer FROM questions WHERE id=?").get(question_id);
  if (!q) return res.status(404).json({ error: "not found" });
  const correct = q.answer === chosen ? 1 : 0;
  db.prepare(`INSERT INTO attempts (user_id,question_id,chosen,correct) VALUES (?,?,?,?)
    ON CONFLICT(user_id,question_id) DO UPDATE SET chosen=excluded.chosen, correct=excluded.correct, created_at=datetime('now')`)
    .run(req.user.id, question_id, chosen, correct);
  res.json({ ok: true, correct: !!correct });
});

// ---------- admin ----------
app.get("/api/admin/stats", requireAdmin, (req, res) => res.json({
  questions: db.prepare("SELECT COUNT(*) c FROM questions WHERE active=1").get().c,
  users: db.prepare("SELECT COUNT(*) c FROM users WHERE role='user'").get().c,
  leads: db.prepare("SELECT COUNT(*) c FROM guests WHERE tier='registered'").get().c,
  openFlags: db.prepare("SELECT COUNT(*) c FROM flags WHERE resolved=0").get().c,
}));
app.get("/api/admin/users", requireAdmin, (req, res) => res.json({ users: db.prepare(`SELECT id,username,name,active,created_at,
   (device_id IS NOT NULL) AS bound FROM users WHERE role='user' ORDER BY id DESC`).all() }));
app.post("/api/admin/users", requireAdmin, (req, res) => {
  const { username, name, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  if (db.prepare("SELECT id FROM users WHERE username=?").get(String(username).trim())) return res.status(409).json({ error: "Username already exists." });
  db.prepare("INSERT INTO users (username,name,password_hash,role) VALUES (?,?,?, 'user')").run(String(username).trim(), name || "", bcrypt.hashSync(password, 10));
  res.json({ ok: true });
});
app.post("/api/admin/users/:id/reset-device", requireAdmin, (req, res) => { db.prepare("UPDATE users SET device_id=NULL, session_token=NULL WHERE id=? AND role='user'").run(req.params.id); res.json({ ok: true }); });
app.post("/api/admin/users/:id/active", requireAdmin, (req, res) => { const a = req.body.active ? 1 : 0; db.prepare("UPDATE users SET active=?, session_token=CASE WHEN ?=0 THEN NULL ELSE session_token END WHERE id=? AND role='user'").run(a, a, req.params.id); res.json({ ok: true }); });
app.post("/api/admin/users/:id/password", requireAdmin, (req, res) => { if (!req.body.password) return res.status(400).json({ error: "password required" }); db.prepare("UPDATE users SET password_hash=?, session_token=NULL WHERE id=? AND role='user'").run(bcrypt.hashSync(req.body.password, 10), req.params.id); res.json({ ok: true }); });
app.delete("/api/admin/users/:id", requireAdmin, (req, res) => { db.prepare("DELETE FROM users WHERE id=? AND role='user'").run(req.params.id); res.json({ ok: true }); });
app.post("/api/admin/change-password", requireAdmin, (req, res) => { const p = req.body.password || ""; if (p.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." }); db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(bcrypt.hashSync(p, 10), req.user.id); res.json({ ok: true }); });

// leads (sign-ups)
app.get("/api/admin/leads", requireAdmin, (req, res) => res.json({ leads: db.prepare(`SELECT gid,name,medical,session,whatsapp,signup_at,converted_user_id,
   (SELECT username FROM users u WHERE u.id=guests.converted_user_id) AS username
   FROM guests WHERE tier='registered' ORDER BY signup_at DESC LIMIT 1000`).all() }));
app.post("/api/admin/leads/:gid/convert", requireAdmin, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "username and password required" });
  const g = db.prepare("SELECT * FROM guests WHERE gid=? AND tier='registered'").get(req.params.gid);
  if (!g) return res.status(404).json({ error: "Lead not found." });
  if (db.prepare("SELECT id FROM users WHERE username=?").get(String(username).trim())) return res.status(409).json({ error: "Username already exists." });
  const info = db.prepare("INSERT INTO users (username,name,password_hash,role) VALUES (?,?,?, 'user')").run(String(username).trim(), g.name || "", bcrypt.hashSync(password, 10));
  db.prepare("UPDATE guests SET converted_user_id=? WHERE gid=?").run(info.lastInsertRowid, g.gid);
  res.json({ ok: true, username: String(username).trim() });
});

// flags admin
app.get("/api/admin/flags", requireAdmin, (req, res) => res.json({ flags: db.prepare(`SELECT f.id,f.question_id,f.reason,f.resolved,f.created_at,q.subject,q.heading,q.stem
   FROM flags f JOIN questions q ON q.id=f.question_id ORDER BY f.resolved, f.id DESC LIMIT 500`).all() }));
app.post("/api/admin/flags/:id/resolve", requireAdmin, (req, res) => { db.prepare("UPDATE flags SET resolved=1 WHERE id=?").run(req.params.id); res.json({ ok: true }); });
app.post("/api/admin/questions/:id/delete", requireAdmin, (req, res) => { db.prepare("UPDATE questions SET active=0 WHERE id=?").run(req.params.id); res.json({ ok: true }); });

// upload questions
app.post("/api/admin/upload", requireAdmin, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const { questions, errors } = await parseFile(req.file.path, req.file.originalname);
    let inserted = 0;
    if (questions.length) {
      const maxId = db.prepare("SELECT COALESCE(MAX(id),0) m FROM questions").get().m;
      const ins = db.prepare(`INSERT INTO questions (id,subject,heading,concept,difficulty,style,stem,optA,optB,optC,optD,answer,explanation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      db.transaction(() => { let id = maxId; for (const q of questions) { id++; ins.run(id, q.subject, q.heading, "", q.difficulty, q.style, q.stem, q.options[0], q.options[1], q.options[2], q.options[3], q.answer, q.explanation); inserted++; } })();
    }
    res.json({ inserted, skipped: errors.length, errors: errors.slice(0, 25), message: `${inserted} question(s) added.` + (errors.length ? ` ${errors.length} row(s) skipped.` : "") });
  } catch (e) { res.status(500).json({ error: "Failed to parse file: " + e.message }); }
  finally { fs.unlink(req.file.path, () => {}); }
});
app.get("/api/admin/template", requireAdmin, (req, res) => {
  const header = ["Subject", "Heading", "Question", "Option A", "Option B", "Option C", "Option D", "Answer", "Difficulty", "Style", "Explanation"];
  const sample = ["Cardiology", "Heart Failure", "First-line drug improving survival in HFrEF?", "Digoxin", "ACE inhibitor", "Furosemide", "Amlodipine", "B", "Moderate", "Drug of Choice", "**ACE inhibitors** improve survival in HFrEF."];
  const ws = XLSX.utils.aoa_to_sheet([header, sample]);
  ws["!cols"] = [16, 18, 46, 18, 18, 18, 18, 8, 12, 16, 50].map(w => ({ wch: w }));
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

app.listen(PORT, () => console.log(`\n  ${BRAND} running at  http://localhost:${PORT}\n  Admin panel:  http://localhost:${PORT}/admin\n`));
