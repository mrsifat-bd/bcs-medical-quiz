# MediVerse BCS Question Bank

A self-contained quiz website for the 2,100-question BCS Medical Science bank, with a tiered
free→register→pay access flow, single-device member accounts, an admin panel, and doc upload.

## Access tiers (how it works)
1. **Free (no account)** — anyone gets **100 random questions** spanning all subjects.
2. **Register (free)** — after the first 100, a sign-up form appears asking for
   **Name, Medical college, Session, WhatsApp number** (all required). On submit they get
   **100 more** questions (200 total).
3. **Pay for full access** — after 200 they see a payment wall with your **registration/payment
   form link**. They pay via the form; you then create their **member login** (works on **one
   device**) from the admin panel and send it to them (e.g. via WhatsApp). Members get **all
   2,100 questions**, the subject browser, bookmarks and progress.

Every question shows options, reveals the correct answer on click, and gives a bold explanation.
Anyone can **report/flag** a question; members can **bookmark** (★).

Built with Node.js (built-in SQLite) + Express + plain HTML/CSS/JS — **no database server and no
native build step**.

---

## 1. Requirements
- **Node.js 22.5 or newer** (uses Node's built-in SQLite). https://nodejs.org — check with `node -v`.

## 2. Run it
```bash
cd quizapp
npm install
npm start
```
- Site:  **http://localhost:3000**
- Admin: **http://localhost:3000/admin**

First run prints a default admin in the terminal:
`username: admin   password: admin123` — **log in and change it** (Settings tab).
Custom port: `PORT=8080 npm start`.

## 3. The payment / registration link
The payment wall opens the Google Form you provided. It is set in `server.js`:
```js
const PAYMENT_URL = "https://docs.google.com/forms/d/1avDCTQBsNAKXKII1gvTIJoNFnasdXA3TR8xB1Ydzoa4/edit";
```
> ⚠️ The link you gave ends in **`/edit`** — that opens the form **editor** (only you can use it).
> Give students the **public** link instead: in Google Forms click **Send → link (🔗)** and copy the
> `.../viewform` URL. Then either edit `PAYMENT_URL` in `server.js`, or start the app with:
> `PAYMENT_URL="https://forms.gle/your-public-link" npm start`

## 4. Turning a paid student into a member
Admin panel → **Sign-ups (leads)** tab. You'll see everyone who registered (name, medical college,
session, WhatsApp, date). When their payment is confirmed:
1. Click **Create login** on their row.
2. Enter a username + password (the app shows them so you can copy).
3. Send the credentials to the student on WhatsApp.
The account binds to the **first device** they log in from; a second device is refused until you
click **Reset device** for them (Members tab). You can also disable/delete members.

## 5. Adding more questions later (upload)
Admin panel → **Add questions** tab → **Download .xlsx template**. One question per row, columns:
`Subject · Heading · Question · Option A–D · Answer (A/B/C/D) · Difficulty · Style · Explanation`.
Use `**double asterisks**` in explanations for **bold**. Supported: **.xlsx, .csv, .docx** (a table
with the same header row). Valid rows import instantly; invalid rows are skipped and listed.

## 6. Adjusting the free quotas
In `server.js`: `FREE_QUOTA = 100;` (guest) and `REG_QUOTA = 200;` (after sign-up). Change and restart.

## 7. Deploy online (optional)
Any host running Node 22+ (Render, Railway, Fly.io, VPS). Start command `npm start`; set `PORT` if
required; persist the `data/` folder (holds `app.db`); serve over HTTPS and start with `HTTPS=1` so
the login cookie is Secure. Set your own admin at first run: `ADMIN_USER=you ADMIN_PASS=strong npm start`.

## 8. Backup / reset
- **Backup:** copy `data/app.db` (holds questions, users, leads, bookmarks, flags).
- **Reset questions to the original 2,100:** stop app, delete `data/app.db`, start again (re-seeds
  from `data/questions.json`). This also clears members/leads.

## 9. Security notes
- Change the default admin password immediately.
- Passwords are hashed (bcrypt); sessions use an http-only cookie.
- Single-device + single active session for members; a new login replaces the old session.
- Use HTTPS + a strong admin password for public deployment.
