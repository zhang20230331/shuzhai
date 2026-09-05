/* 本地模式适配器：书库存 IndexedDB，解析在前端完成。
   启用条件：Capacitor 原生 App 内，或地址栏带 ?local=1（用于浏览器调试） */
"use strict";

(function () {
  const enabled = !!window.Capacitor || location.search.includes("local=1");
  const LN = { books: "b", meta: "m" }; // store 名：正文/进度

  let dbPromise = null;
  function db() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open("shuzhai", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains(LN.books)) d.createObjectStore(LN.books, { keyPath: "id" });
        if (!d.objectStoreNames.contains(LN.meta)) d.createObjectStore(LN.meta);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }
  function tx(store, mode, fn) {
    return db().then((d) => new Promise((resolve, reject) => {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out);
      t.onerror = () => reject(t.error);
    }));
  }
  const idbPut = (store, val, key) => tx(store, "readwrite", (s) => (key !== undefined ? s.put(val, key) : s.put(val)));
  const idbGet = (store, key) => tx(store, "readonly", (s) => s.get(key));
  const idbGetAll = (store) => tx(store, "readonly", (s) => s.getAll());
  const idbDelete = (store, key) => tx(store, "readwrite", (s) => s.delete(key));

  /* ---- 章节/段落解析（与后端 lib/parse.js 逻辑一致） ---- */
  const CHAPTER_RE =
    /^\s*(第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章回节卷部集篇][^\n]{0,40}|Chapter\s+\d+[^\n]{0,40}|(序章|楔子|引子|尾声|后记)(\s\S{0,30})?|番外\S{0,10}(\s\S{0,30})?)\s*$/i;

  function parseChapters(fullText) {
    const lines = fullText.replace(/\r\n?/g, "\n").split("\n");
    const chapters = [];
    let title = null, body = [];
    const push = () => { if (title !== null && body.join("\n").trim()) chapters.push({ title, body: body.join("\n") }); };
    for (const line of lines) {
      if (CHAPTER_RE.test(line)) { push(); title = line.trim(); body = []; }
      else if (title !== null) body.push(line);
    }
    push();
    if (chapters.length === 0) {
      const total = fullText.replace(/\r\n?/g, "\n").trim();
      const size = 12000;
      let idx = 0, n = 0;
      while (idx < total.length) {
        let end = Math.min(idx + size, total.length);
        if (end < total.length) {
          const nl = total.lastIndexOf("\n", end);
          if (nl > idx + size * 0.5) end = nl + 1;
        }
        chapters.push({ title: `第${++n}部分`, body: total.slice(idx, end) });
        idx = end;
      }
    }
    return chapters;
  }

  const splitParagraphs = (body) =>
    body.split(/\n+/).map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

  function decodeText(buf) {
    if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf)
      return { text: new TextDecoder("utf-8").decode(buf.slice(3)), encoding: "utf-8" };
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe)
      return { text: new TextDecoder("utf-16le").decode(buf.slice(2)), encoding: "utf-16le" };
    try { return { text: new TextDecoder("utf-8", { fatal: true }).decode(buf), encoding: "utf-8" }; }
    catch { return { text: new TextDecoder("gb18030").decode(buf), encoding: "gb18030" }; }
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
    const book = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name, addedAt: Date.now(), chapters: chapterIndex, paras,
    };
    return idbPut(LN.books, book).then(() => ({ id: book.id, name, chapterCount: chapterIndex.length, paraCount: paras.length, progress: null }));
  }

  async function listBooks() {
    const books = await idbGetAll(LN.books);
    const out = [];
    for (const b of books) {
      const p = await idbGet(LN.meta, "p_" + b.id);
      out.push({ id: b.id, name: b.name, chapterCount: b.chapters.length, paraCount: b.paras.length, progress: p || null });
    }
    return out.sort((a, b) => (b.progress?.updatedAt || 0) - (a.progress?.updatedAt || 0));
  }

  const getBook = async (id) => {
    const b = await idbGet(LN.books, id);
    if (!b) throw new Error("书籍不存在");
    return { id: b.id, name: b.name, chapters: b.chapters, paraCount: b.paras.length, progress: (await idbGet(LN.meta, "p_" + id)) || null };
  };
  const getChapter = async (id, n) => {
    const b = await idbGet(LN.books, id);
    const ch = b.chapters[n];
    if (!ch) throw new Error("章节不存在");
    return { index: n, title: ch.title, paras: b.paras.slice(ch.start, ch.start + ch.count) };
  };
  const saveProgress = (id, chapter, para) =>
    idbPut(LN.meta, { chapter, para, updatedAt: Date.now() }, "p_" + id);
  const deleteBook = (id) => idbDelete(LN.books, id).then(() => idbDelete(LN.meta, "p_" + id));

  window.LocalAdapter = { enabled, importBook, listBooks, getBook, getChapter, saveProgress, deleteBook, decodeText };
})();
