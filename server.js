// 小说书城 + 听书 服务
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { URL } = require("url");
const { parseChapters, splitParagraphs } = require("./lib/parse");
const { decodeText } = require("./lib/encoding");
const { synthesize, escapeXml, normalizeRate } = require("./lib/tts");

const PORT = Number(process.env.PORT) || 9324;
const DATA_DIR = path.join(__dirname, "data");
const BOOKS_DIR = path.join(DATA_DIR, "books");
const PROGRESS_FILE = path.join(DATA_DIR, "progress.json");
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_UPLOAD = 30 * 1024 * 1024;

fs.mkdirSync(BOOKS_DIR, { recursive: true });

const VOICES = [
  { id: "zh-CN-XiaoxiaoNeural", name: "晓晓（温柔女声）" },
  { id: "zh-CN-XiaoyiNeural", name: "晓伊（甜美女声）" },
  { id: "zh-CN-YunxiNeural", name: "云希（年轻男声）" },
  { id: "zh-CN-YunjianNeural", name: "云健（浑厚男声）" },
  { id: "zh-CN-YunxiaNeural", name: "云夏（少年音）" },
  { id: "zh-CN-YunyangNeural", name: "云扬（播音男声）" },
  { id: "zh-CN-liaoning-XiaobeiNeural", name: "晓北（东北女声）" },
  { id: "zh-CN-shaanxi-XiaoniNeural", name: "晓妮（陕西女声）" },
  { id: "zh-HK-HiuMaanNeural", name: "曉曼（粤语女声）" },
  { id: "zh-TW-HsiaoChenNeural", name: "筱臣（台湾女声）" },
];

// ---------- 数据读写 ----------
const bookFile = (id) => path.join(BOOKS_DIR, `${id}.json`);

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf8")); } catch { return {}; }
}
function saveProgress(p) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2));
}
function listBooks() {
  const progress = loadProgress();
  return fs
    .readdirSync(BOOKS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        const b = JSON.parse(fs.readFileSync(path.join(BOOKS_DIR, f), "utf8"));
        return { id: b.id, name: b.name, chapterCount: b.chapters.length, paraCount: b.paras.length, progress: progress[b.id] || null };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0) || (b.id > a.id ? 1 : -1));
}

function importBook(name, text) {
  const chapters = parseChapters(text);
  const paras = [];
  const chapterIndex = [];
  for (const ch of chapters) {
    const start = paras.length;
    const ps = splitParagraphs(ch.body);
    paras.push(...ps);
    chapterIndex.push({ title: ch.title, start, count: ps.length });
  }
  if (paras.length === 0) throw new Error("没有可读内容");
  const id = Date.now().toString(36) + crypto.randomBytes(2).toString("hex");
  const book = { id, name, addedAt: Date.now(), chapters: chapterIndex, paras };
  fs.writeFileSync(bookFile(id), JSON.stringify(book));
  fs.writeFileSync(path.join(BOOKS_DIR, `${id}.txt`), text); // 保留原件，便于日后重新解析
  return { id, name, chapterCount: chapterIndex.length, paraCount: paras.length, progress: null };
}

function readBody(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("文件过大（上限 30MB）")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

// ---------- 静态文件 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "index.html" : pathname.slice(1);
  try { rel = decodeURIComponent(rel); } catch {}
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("404");
  }
  res.writeHead(200, {
    "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
  });
  res.end(fs.readFileSync(file));
}

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

// ---------- 路由 ----------
async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;
  const m = req.method;

  // TTS 兼容接口（与 tts-server 一致，供外部工具复用）
  if (p === "/api/ra" && m === "GET") {
    const text = (url.searchParams.get("text") || "").trim();
    const voice = url.searchParams.get("voiceName") || "zh-CN-XiaoxiaoNeural";
    if (!text) return json(res, 400, { error: "missing text" });
    if (!/^[\w-]+$/.test(voice)) return json(res, 400, { error: "invalid voiceName" });
    try {
      const audio = await synthesize(voice, escapeXml(text.slice(0, 4000)), normalizeRate(url.searchParams.get("rate")));
      res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store" });
      res.end(audio);
    } catch (e) {
      console.error(`[tts] ${voice}:`, e.message);
      json(res, 502, { error: "synthesis failed", detail: e.message });
    }
    return;
  }

  if (p === "/api/voices") return json(res, 200, VOICES);

  if (p === "/api/books" && m === "GET") return json(res, 200, listBooks());

  if (p === "/api/books" && m === "POST") {
    const body = await readBody(req);
    const name = decodeURIComponent(req.headers["x-book-name"] || "").replace(/[\\/:*?"<>|]/g, "").trim().slice(0, 80) || "未命名书籍";
    if (body.length === 0) return json(res, 400, { error: "空文件" });
    let text;
    if (url.searchParams.get("type") === "url") {
      // body 为 UTF-8 的 JSON {url}
      const { url: target } = JSON.parse(body.toString("utf8"));
      if (!/^https?:\/\//.test(target || "")) return json(res, 400, { error: "URL 不合法" });
      const r = await fetch(target, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) return json(res, 502, { error: `下载失败 HTTP ${r.status}` });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > MAX_UPLOAD) return json(res, 400, { error: "文件过大（上限 30MB）" });
      text = decodeText(buf).text;
    } else {
      text = decodeText(body).text;
    }
    try {
      const book = importBook(name, text);
      json(res, 200, book);
    } catch (e) {
      json(res, 400, { error: e.message });
    }
    return;
  }

  const bookMatch = p.match(/^\/api\/books\/([\w-]+)(\/chapter\/(\d+))?$/);
  if (bookMatch) {
    const id = bookMatch[1];
    const file = bookFile(id);
    if (!fs.existsSync(file)) return json(res, 404, { error: "书籍不存在" });
    const book = JSON.parse(fs.readFileSync(file, "utf8"));

    if (m === "DELETE" && !bookMatch[2]) {
      fs.unlinkSync(file);
      const txt = path.join(BOOKS_DIR, `${id}.txt`);
      if (fs.existsSync(txt)) fs.unlinkSync(txt);
      const progress = loadProgress();
      delete progress[id];
      saveProgress(progress);
      return json(res, 200, { ok: true });
    }
    if (m === "GET" && !bookMatch[2]) {
      const progress = loadProgress()[id] || null;
      return json(res, 200, { id, name: book.name, chapters: book.chapters, paraCount: book.paras.length, progress });
    }
    if (m === "GET" && bookMatch[2]) {
      const n = Number(bookMatch[3]);
      const ch = book.chapters[n];
      if (!ch) return json(res, 404, { error: "章节不存在" });
      return json(res, 200, { index: n, title: ch.title, paras: book.paras.slice(ch.start, ch.start + ch.count) });
    }
  }

  const progMatch = p.match(/^\/api\/books\/([\w-]+)\/progress$/);
  if (progMatch && m === "POST") {
    const body = JSON.parse((await readBody(req, 10240)).toString("utf8"));
    const progress = loadProgress();
    progress[progMatch[1]] = { chapter: body.chapter | 0, para: body.para | 0, updatedAt: Date.now() };
    saveProgress(progress);
    return json(res, 200, { ok: true });
  }

  if (p === "/health") return json(res, 200, { ok: true, books: listBooks().length });

  if (m === "GET") return serveStatic(req, res, p);
  json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  // 允许局域网内任意来源（手机 PWA / Capacitor 壳）跨域调用 TTS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-book-name");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  route(req, res).catch((e) => {
    console.error("[server]", e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`小说书城服务: http://localhost:${PORT}`);
  for (const i of Object.values(os.networkInterfaces()).flat()) {
    if (i.family === "IPv4" && !i.internal) console.log(`  局域网: http://${i.address}:${PORT}`);
  }
});
