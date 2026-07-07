// Parse an uploaded structured file (.xlsx / .csv / .docx table) into question rows.
// Expected columns (case-insensitive, flexible names):
//   Subject | Heading (or Topic) | Question (or Stem) | Option A | Option B | Option C | Option D
//   | Answer (A/B/C/D or 1-4) | Difficulty | Style | Explanation
const XLSX = require("xlsx");
const mammoth = require("mammoth");
const { parse: parseHtml } = require("node-html-parser");

function norm(s) { return String(s == null ? "" : s).trim(); }
function keyify(s) { return norm(s).toLowerCase().replace(/[^a-z0-9]/g, ""); }

const FIELD_MAP = {
  subject: ["subject", "sub"],
  heading: ["heading", "topic", "subtopic", "subheading", "section"],
  stem: ["question", "stem", "questiontext"],
  a: ["optiona", "a", "opta", "choicea"],
  b: ["optionb", "b", "optb", "choiceb"],
  c: ["optionc", "c", "optc", "choicec"],
  d: ["optiond", "d", "optd", "choiced"],
  answer: ["answer", "correct", "correctanswer", "key", "ans"],
  difficulty: ["difficulty", "level"],
  style: ["style", "type", "questiontype"],
  explanation: ["explanation", "rationale", "reason"],
};

function buildColIndex(headerRow) {
  const idx = {};
  headerRow.forEach((h, i) => {
    const k = keyify(h);
    for (const [field, aliases] of Object.entries(FIELD_MAP)) {
      if (aliases.includes(k)) idx[field] = i;
    }
  });
  return idx;
}

function answerToIndex(v) {
  const s = norm(v).toUpperCase();
  if (["A", "1"].includes(s)) return 0;
  if (["B", "2"].includes(s)) return 1;
  if (["C", "3"].includes(s)) return 2;
  if (["D", "4"].includes(s)) return 3;
  return -1;
}

function rowsToQuestions(rows) {
  // rows: array of arrays; first row = header
  if (!rows || rows.length < 2) return { questions: [], errors: ["No data rows found."] };
  const idx = buildColIndex(rows[0]);
  const required = ["subject", "heading", "stem", "a", "b", "c", "d", "answer"];
  const missing = required.filter((f) => idx[f] === undefined);
  if (missing.length) return { questions: [], errors: ["Missing required columns: " + missing.join(", ")] };

  const questions = [], errors = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => norm(c) === "")) continue;
    const stem = norm(row[idx.stem]);
    if (!stem) continue;
    const ans = answerToIndex(row[idx.answer]);
    const opts = [row[idx.a], row[idx.b], row[idx.c], row[idx.d]].map(norm);
    if (ans < 0) { errors.push(`Row ${r + 1}: invalid answer '${norm(row[idx.answer])}' (use A/B/C/D).`); continue; }
    if (opts.some((o) => !o)) { errors.push(`Row ${r + 1}: all four options A-D are required.`); continue; }
    questions.push({
      subject: norm(row[idx.subject]) || "Uncategorised",
      heading: norm(row[idx.heading]) || "General",
      stem, options: opts, answer: ans,
      difficulty: idx.difficulty !== undefined ? (norm(row[idx.difficulty]) || "Moderate") : "Moderate",
      style: idx.style !== undefined ? (norm(row[idx.style]) || "Recall") : "Recall",
      explanation: idx.explanation !== undefined ? norm(row[idx.explanation]) : "",
    });
  }
  return { questions, errors };
}

async function parseFile(filePath, originalName) {
  const ext = (originalName.split(".").pop() || "").toLowerCase();
  if (ext === "xlsx" || ext === "xls" || ext === "csv") {
    const wb = XLSX.readFile(filePath);
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: "" });
    return rowsToQuestions(rows);
  }
  if (ext === "docx") {
    const { value: html } = await mammoth.convertToHtml({ path: filePath });
    const root = parseHtml(html);
    const table = root.querySelector("table");
    if (!table) return { questions: [], errors: ["No table found in the .docx. Use the provided template (a table with a header row)."] };
    const rows = table.querySelectorAll("tr").map((tr) =>
      tr.querySelectorAll("th,td").map((td) => td.text.trim()));
    return rowsToQuestions(rows);
  }
  return { questions: [], errors: ["Unsupported file type. Upload .xlsx, .csv or .docx (structured template)."] };
}

module.exports = { parseFile };
