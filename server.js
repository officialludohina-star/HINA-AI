const express = require("express");
const cors = require("cors");
const multer = require("multer");
const AdmZip = require("adm-zip");
const path = require("path");
const vm = require("vm");
const os = require("os");
const fs = require("fs");
const { execFileSync } = require("child_process");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const TOKEN = process.env.APP_TOKEN;

const SYSTEM = `You are an elite senior software engineer with expert knowledge of every programming
language, framework and platform (Android, iOS, Flutter, web, backend, games, databases, DevOps).

STRICT RULES:
1. Do EXACTLY what the user asked. Nothing extra: no unrequested features, no refactors, no renaming,
   no style changes. When editing existing code, change ONLY what was requested and keep everything else identical.
2. Write complete, working code. Never use placeholders like "rest of code here".
3. Before answering, carefully self-check the code for syntax errors, missing imports, wrong types,
   null/edge cases and logic bugs. Fix what you find.
4. Be honest. You cannot run code or access the user's device. Never claim that anything was run or tested.
   If something is unclear, impossible, or you are unsure, say so clearly instead of guessing.
5. Reply in the language the user writes in (Roman Urdu if they write Roman Urdu).`;

const CHAT_REPORT_RULE = `

At the END of every answer add this report, in the user's language, with short honest bullet points:
📋 REPORT
✅ Kya kiya:
⚠️ Kya NAHI kiya / adhoora / andaza:
🐞 Mumkin galtiyan ya risk:
🧪 Kaise test karein:`;

// ---------- helpers ----------
const arr = x => (Array.isArray(x) ? x.map(String) : []);

function safePath(p) {
  const n = path.posix.normalize(String(p || "").replace(/\\/g, "/")).replace(/^(\.\.\/|\/)+/, "");
  if (!n || n === "." || n.includes("..")) return null;
  return n;
}

function parseJSON(text) {
  let clean = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const a = clean.indexOf("{"), b = clean.lastIndexOf("}");
  if (a > 0 && b > a) clean = clean.slice(a, b + 1);
  try { return JSON.parse(clean); }
  catch { throw new Error("AI ka jawab beech mein kat gaya ya JSON galat tha. Chhota kaam maango ya dobara try karo."); }
}

function pyCheck(code) {
  const f = path.join(os.tmpdir(), `chk_${Date.now()}_${Math.random().toString(36).slice(2)}.py`);
  fs.writeFileSync(f, code);
  try {
    execFileSync("python3", ["-c", "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf8').read())", f], { stdio: "pipe" });
    return "ok";
  } catch (e) {
    if (e.code === "ENOENT") return "skip";
    throw new Error(String(e.stderr || e.message).split("\n").filter(Boolean).slice(-3).join(" | "));
  } finally { try { fs.unlinkSync(f); } catch {} }
}

// Asli (server-side) syntax checking. Sirf JSON, JS, Python.
function checkFiles(files) {
  const checked = [], skipped = [], errors = [];
  for (const f of files) {
    const p = String(f.path), c = String(f.content ?? "");
    const ext = path.extname(p).toLowerCase();
    try {
      if (ext === ".json") { JSON.parse(c); checked.push(p); }
      else if ((ext === ".js" || ext === ".cjs") && !/^\s*(import|export)\s/m.test(c)) {
        new vm.Script(c, { filename: p }); checked.push(p);
      }
      else if (ext === ".py") { (pyCheck(c) === "ok" ? checked : skipped).push(p); }
      else skipped.push(p);
    } catch (e) { errors.push({ path: p, error: String(e.message).slice(0, 300) }); }
  }
  return { checked, skipped, errors };
}

function buildReport({ title, ai = {}, check, rounds, extra = [] }) {
  const L = a => (a.length ? a.map(x => "- " + x) : ["- (kuch nahi bataya)"]);
  return [
    `# REPORT: ${title}`,
    "",
    "## ✅ Kya kiya (AI ka daawa)", ...L(arr(ai.done)),
    "",
    "## ⚠️ Kya NAHI kiya / adhoora", ...L(arr(ai.not_done)),
    "",
    "## 🐞 Mumkin galtiyan / risk (AI ka andaza)", ...L(arr(ai.risks)),
    "",
    "## 🔍 Server ki asli checking",
    `- Syntax check hui: ${check.checked.length ? check.checked.join(", ") : "koi nahi"}`,
    `- Syntax errors ab bhi baqi: ${check.errors.length ? check.errors.map(e => `${e.path} (${e.error})`).join("; ") : "koi nahi"}`,
    `- Auto-fix rounds: ${rounds}`,
    `- Check NAHI hui (sirf JSON/JS/Python check hote hain): ${check.skipped.length ? check.skipped.join(", ") : "koi nahi"}`,
    "- Code chalaya nahi gaya, isliye logic/runtime bugs ho sakte hain. Khud test zaroor karo.",
    ...extra,
  ].join("\n");
}

// Naam purana hai (gemini) taake baqi code na badle, lekin ab andar Anthropic (Claude) API chalti hai.
// "contents" Gemini-style hai: [{role:"user"|"model", parts:[{text}]}] -> Claude format mein badal diya jata hai.
async function gemini(contents, { json = false, system = SYSTEM, temperature = 0.2 } = {}) {
  const messages = contents.map(m => ({
    role: m.role === "model" ? "assistant" : "user",
    content: (m.parts || []).map(p => p.text || "").join(""),
  }));
  const body = {
    model: MODEL,
    max_tokens: 16000,
    temperature,
    system: json ? system + "\n\nReply with ONLY valid JSON, no text before or after, no code fences." : system,
    messages,
  };
  for (let i = 0; i < 3; i++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if ((r.status === 429 || r.status >= 500) && i < 2) { await new Promise(s => setTimeout(s, 2500 * (i + 1))); continue; }
    const text = (d?.content || []).map(p => p.text || "").join("");
    if (!text) throw new Error(d?.error?.message || JSON.stringify(d).slice(0, 500));
    if (d.stop_reason === "max_tokens" && json) throw new Error("AI ka jawab beech mein kat gaya (bohot lamba tha). Chhota kaam maango ya hisson mein banwao.");
    return text;
  }
}

// Generate -> server syntax check -> galti ho to AI ko wapis bhej kar fix (max 2 baar)
async function runWithChecks(contents, key) {
  let out = await gemini(contents, { json: true });
  let data = parseJSON(out), rounds = 0, check;
  for (;;) {
    check = checkFiles(Array.isArray(data[key]) ? data[key] : []);
    if (!check.errors.length || rounds >= 2) break;
    rounds++;
    contents = [
      ...contents,
      { role: "model", parts: [{ text: out }] },
      { role: "user", parts: [{ text:
        "Server ne in files mein syntax errors pakde:\n" +
        check.errors.map(e => `${e.path}: ${e.error}`).join("\n") +
        "\nSirf inhe theek karo, baqi kuch mat badlo. Poora JSON dobara do, bilkul same shape mein." }] },
    ];
    out = await gemini(contents, { json: true });
    data = parseJSON(out);
  }
  return { data, check, rounds };
}

function zipToText(zip, limit = 600000) {
  let text = "", skipped = [];
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    if (e.header.size > 200000) { skipped.push(e.entryName + " (bari)"); continue; }
    const s = e.getData().toString("utf8");
    if (s.includes("\u0000")) { skipped.push(e.entryName + " (binary)"); continue; }
    if (text.length + s.length > limit) { skipped.push(e.entryName + " (limit)"); continue; }
    text += `\n=== ${e.entryName} ===\n${s}`;
  }
  return { text, skipped };
}

// ---------- routes ----------
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "index.html")));

app.use((req, res, next) => {
  if (TOKEN && req.headers["x-app-token"] !== TOKEN)
    return res.status(401).json({ error: "token galat hai" });
  next();
});

// 1) Chat (har jawab ke end mein report)
app.post("/chat", async (req, res) => {
  try {
    const { history = [], message = "" } = req.body;
    const contents = [...history, { role: "user", text: message }].map(m => ({ role: m.role, parts: [{ text: m.text }] }));
    res.json({ reply: await gemini(contents, { system: SYSTEM + CHAT_REPORT_RULE }) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 2) Build: prompt -> project ZIP + report
app.post("/build", async (req, res) => {
  try {
    const prompt = `${req.body.prompt}

Return ONLY JSON in exactly this shape:
{"files":[{"path":"relative/path.ext","content":"full file text"}],
 "report":{"done":["..."],"not_done":["anything you skipped, assumed or could not do"],"risks":["possible bugs or things the user must verify"]}}
Create only what was asked. Be honest in the report.`;
    const { data, check, rounds } = await runWithChecks([{ role: "user", parts: [{ text: prompt }] }], "files");
    const reportText = buildReport({ title: "Project build", ai: data.report, check, rounds });
    const zip = new AdmZip();
    for (const f of data.files || []) {
      const p = safePath(f.path);
      if (p) zip.addFile(p, Buffer.from(String(f.content), "utf8"));
    }
    zip.addFile("REPORT.md", Buffer.from(reportText, "utf8"));
    res.json({ report: reportText, zip_base64: zip.toBuffer().toString("base64"), files: (data.files || []).map(f => f.path) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 3) Edit: ZIP + hukam -> sirf zaroori files badal kar naya ZIP + report
app.post("/edit", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ZIP file nahi mili" });
    const instruction = (req.body.message || "").trim();
    if (!instruction) return res.status(400).json({ error: "Hukam (message) likho" });
    const src = new AdmZip(req.file.buffer);
    const { text, skipped } = zipToText(src);
    const prompt = `${instruction}

Neeche project files hain. Sirf wohi badlo jo hukam mein hai, baqi kuch NAHI.
Sirf badli hui files ka POORA naya content do, unchanged files wapis mat bhejo.
Return ONLY JSON:
{"changed":[{"path":"same/path.ext","content":"full new file text"}],"deleted":["path"],
 "report":{"done":["..."],"not_done":["..."],"risks":["..."]}}

Project files:${text}`;
    const { data, check, rounds } = await runWithChecks([{ role: "user", parts: [{ text: prompt }] }], "changed");
    const out = new AdmZip(req.file.buffer);
    const changedPaths = [];
    for (const f of data.changed || []) {
      const p = safePath(f.path); if (!p) continue;
      const buf = Buffer.from(String(f.content), "utf8");
      if (out.getEntry(p)) out.updateFile(p, buf); else out.addFile(p, buf);
      changedPaths.push(p);
    }
    for (const d of arr(data.deleted)) { const p = safePath(d); if (p && out.getEntry(p)) out.deleteFile(p); }
    const extra = [
      `- Badli hui files: ${changedPaths.length ? changedPaths.join(", ") : "koi nahi"}`,
      `- Delete hui files: ${arr(data.deleted).join(", ") || "koi nahi"}`,
      `- AI ne yeh files PARHI hi nahi (bari/binary/limit): ${skipped.length ? skipped.join(", ") : "koi nahi"}`,
    ];
    const reportText = buildReport({ title: "Edit", ai: data.report, check, rounds, extra });
    out.addFile("REPORT.md", Buffer.from(reportText, "utf8"));
    res.json({ report: reportText, zip_base64: out.toBuffer().toString("base64"), changed: changedPaths });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 4) Analyze: ZIP parho, sawal ka jawab (report ke saath)
app.post("/analyze", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "ZIP file nahi mili" });
    const { text, skipped } = zipToText(new AdmZip(req.file.buffer));
    const prompt = `${req.body.message || "Is project ko samjho aur bugs batao"}\n\nProject files:${text}`;
    const reply = await gemini([{ role: "user", parts: [{ text: prompt }] }], { system: SYSTEM + CHAT_REPORT_RULE });
    const note = skipped.length ? `\n\n🔍 Server note: yeh files AI ne parhi hi nahi: ${skipped.join(", ")}` : "";
    res.json({ reply: reply + note });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

if (require.main === module) app.listen(process.env.PORT || 3000);
module.exports = { checkFiles, safePath, buildReport, parseJSON, gemini };
