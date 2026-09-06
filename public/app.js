/* 书斋 · 小说听书 前端逻辑（横向分页沉浸式，交互参考番茄小说） */
"use strict";

const $ = (s) => document.querySelector(s);
const audio = $("#audio");
const viewport = $("#viewport");
const track = $("#track");
const PAD = 24; // 页面左右留白（px），与 layout() 中 #track 的 padding 保持一致

const S = {
  book: null,          // {id,name,chapters,paraCount}
  chapter: null,       // {index,title,paras,segs:[[..]]}
  cur: { ch: 0, p: 0 },
  playing: false,
  playToken: 0,
  page: 0,
  pages: 1,
  loading: false,
  menuOpen: false,
  chapterCache: new Map(),
  audioCache: new Map(),
};

const prefs = {
  get font() { return +localStorage.getItem("sz_font") || 19; },
  set font(v) { localStorage.setItem("sz_font", v); },
  get lh() { return +localStorage.getItem("sz_lh") || 1.85; },
  set lh(v) { localStorage.setItem("sz_lh", v); },
  get theme() { return localStorage.getItem("sz_theme") || "white"; },
  set theme(v) { localStorage.setItem("sz_theme", v); },
  get voice() { return localStorage.getItem("sz_voice") || "zh-CN-XiaoxiaoNeural"; },
  set voice(v) { localStorage.setItem("sz_voice", v); },
  // 语速倍数：50~200，100 = 1.0x（旧版存的是 -50~100 的百分比，自动校正）
  get rate() { const v = +localStorage.getItem("sz_rate"); return v >= 50 && v <= 200 ? v : 100; },
  set rate(v) { localStorage.setItem("sz_rate", v); },
  // 离线模式使用的系统音色名（getVoices 列表里的 name）
  get nativeVoice() { return localStorage.getItem("sz_native_voice") || ""; },
  set nativeVoice(v) { localStorage.setItem("sz_native_voice", v); },
};

/* ---------------- 工具 ---------------- */
let toastTimer = null;
function toast(msg, ms = 2000) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), ms);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ---------------- 存储与音源适配层 ----------------
   浏览器直连：书和 TTS 都走本机服务（原模式）。
   Capacitor 原生 App：书存手机本地（IndexedDB）；
   TTS 优先连家里电脑的 Edge 神经语音，连不上自动切系统语音。 */
const Local = window.LocalAdapter;
const LOCAL_MODE = Local.enabled;
const SERVER = localStorage.getItem("sz_server") || (LOCAL_MODE ? "http://192.168.0.205:9324" : location.origin);

const Store = LOCAL_MODE ? Local : {
  listBooks: () => api("/api/books"),
  importBook: (name, text) => api("/api/books", { method: "POST", headers: { "Content-Type": "text/plain", "x-book-name": encodeURIComponent(name) }, body: new TextEncoder().encode(text) }),
  getBook: (id) => api(`/api/books/${id}`),
  getChapter: (id, n) => api(`/api/books/${id}/chapter/${n}`),
  saveProgress: (id, ch, para) => api(`/api/books/${id}/progress`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chapter: ch, para }) }),
  deleteBook: (id) => api(`/api/books/${id}`, { method: "DELETE" }),
};

let serverAlive = !LOCAL_MODE;
let serverCheckedAt = 0;
async function checkServer(force = false) {
  if (!LOCAL_MODE) return true;
  // 5 分钟内复用上次结果：避免每次点听书都干等 2.5 秒探测
  if (!force && Date.now() - serverCheckedAt < 5 * 60 * 1000) return serverAlive;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${SERVER}/health`, { signal: ctl.signal });
    clearTimeout(t);
    serverAlive = r.ok;
  } catch { serverAlive = false; }
  serverCheckedAt = Date.now();
  return serverAlive;
}

const nativeTTS = () => window.Capacitor?.Plugins?.TextToSpeech || window.TTS || null;

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const coverHue = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const SEG_SPLIT = /[^。！？；…]+[。！？；…]*/g;
const splitSegs = (text) => (text.match(SEG_SPLIT) || [text]).filter(Boolean);
const showLoading = (v) => $("#flipLoading").classList.toggle("hidden", !v);

/* ---------------- 书架 ---------------- */
async function loadShelf() {
  const books = await Store.listBooks();
  const grid = $("#bookGrid");
  grid.innerHTML = "";
  $("#shelfEmpty").classList.toggle("hidden", books.length > 0);
  for (const b of books) {
    const hue = coverHue(b.id);
    const pct = b.progress ? Math.min(99, Math.round(((b.progress.chapter + 1) / b.chapterCount) * 100)) : 0;
    const card = document.createElement("div");
    card.className = "book-card";
    card.innerHTML = `
      <div class="book-cover" style="background:linear-gradient(160deg,hsl(${hue},58%,52%),hsl(${(hue + 45) % 360},58%,40%))">
        ${esc(b.name.slice(0, 8))}
        ${b.progress ? `<div class="book-progress"><i style="width:${pct}%"></i></div>` : ""}
      </div>
      <div class="book-name">${esc(b.name)}</div>
      <div class="book-meta">${b.chapterCount} 章${b.progress ? " · " + pct + "%" : ""}</div>`;
    card.querySelector(".book-cover").addEventListener("click", () => openBook(b.id));
    let pressTimer = null;
    card.addEventListener("contextmenu", (e) => { e.preventDefault(); deleteBook(b); });
    card.addEventListener("touchstart", () => { pressTimer = setTimeout(() => deleteBook(b), 600); }, { passive: true });
    card.addEventListener("touchend", () => clearTimeout(pressTimer));
    card.addEventListener("touchmove", () => clearTimeout(pressTimer));
    grid.appendChild(card);
  }
}

function deleteBook(b) {
  if (!confirm(`删除《${b.name}》？`)) return;
  Store.deleteBook(b.id).then(loadShelf).catch((e) => toast(e.message));
}

async function uploadFiles(files) {
  for (const f of files) {
    if (!/\.txt$/i.test(f.name) && f.type !== "text/plain") { toast(`跳过非 TXT：${f.name}`); continue; }
    try {
      toast(`正在导入《${f.name.replace(/\.txt$/i, "")}》…`);
      const buf = new Uint8Array(await f.arrayBuffer());
      const name = f.name.replace(/\.txt$/i, "");
      const { text } = LOCAL_MODE ? Local.decodeText(buf) : { text: new TextDecoder("utf-8").decode(buf) };
      const book = await Store.importBook(name, text);
      await loadShelf();
      openBook(book.id);
      return;
    } catch (e) { toast(`导入失败：${e.message}`, 3200); }
  }
}

$("#fileInput").addEventListener("change", (e) => { uploadFiles([...e.target.files]); e.target.value = ""; });
$("#btnUpload").addEventListener("click", () => $("#fileInput").click());
$("#btnImportUrl").addEventListener("click", async () => {
  const url = prompt("输入 TXT 直链（http/https）：");
  if (!url) return;
  const name = decodeURIComponent((url.split("/").pop() || "").replace(/\.txt.*$/i, "")).trim() || "网络书籍";
  try {
    toast("正在下载…");
    let text;
    if (LOCAL_MODE) {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      text = Local.decodeText(new Uint8Array(await r.arrayBuffer())).text;
    } else {
      const book = await api("/api/books?type=url", {
        method: "POST", headers: { "Content-Type": "application/json", "x-book-name": encodeURIComponent(name) },
        body: JSON.stringify({ url }),
      });
      await loadShelf();
      openBook(book.id);
      return;
    }
    const book = await Store.importBook(name, text);
    await loadShelf();
    openBook(book.id);
  } catch (e) { toast(`导入失败：${e.message}`, 3200); }
});
["dragover", "drop"].forEach((ev) => document.addEventListener(ev, (e) => e.preventDefault()));
document.addEventListener("drop", (e) => {
  if (S.book) return;
  const files = [...(e.dataTransfer?.files || [])];
  if (files.length) uploadFiles(files);
});

/* ---------------- 分页核心 ---------------- */
function layout() {
  const pw = viewport.clientWidth;
  if (!pw) return;
  track.style.padding = `0 ${PAD}px`;
  track.style.columnWidth = (pw - PAD * 2) + "px";
  track.style.columnGap = (PAD * 2) + "px";
  // 末页常是窄列，scrollWidth 略小于 N*pw，必须向上取整否则末页翻不到
  S.pages = Math.max(1, Math.ceil((track.scrollWidth - 1) / pw));
  updateIndicator();
}

function goToPage(i, smooth = true) {
  const pw = viewport.clientWidth;
  S.page = Math.max(0, Math.min(S.pages - 1, i));
  if (!smooth) {
    track.style.transition = "none";
    track.style.transform = `translateX(${-S.page * pw}px)`;
    void track.offsetHeight; // 强制同步回流，避免无动画位移被过渡覆盖
    track.style.transition = "";
  } else {
    track.style.transform = `translateX(${-S.page * pw}px)`;
  }
  updateIndicator();
  saveProgressSoon();
}

const pageOf = (el) => Math.max(0, Math.floor((el.offsetLeft + 1) / viewport.clientWidth));
const segEls = () => [...track.querySelectorAll(".seg")];

function firstVisiblePara() {
  for (const el of segEls()) if (pageOf(el) === S.page) return +el.dataset.p;
  return S.cur.p;
}

function flipToElement(el) {
  const target = pageOf(el);
  if (target !== S.page) goToPage(target);
}

function updateIndicator() {
  const slider = $("#pageSlider");
  if (slider) { slider.value = S.page + 1; slider.max = S.pages; }
  const pt = `${S.page + 1}/${S.pages}`;
  $("#pageText").textContent = pt;
  $("#miniPage").textContent = pt;
}
/* 无缝跨章翻页：末页继续向后 → 下一章；首页向前 → 上一章末页 */
async function flipNext() {
  if (S.loading) return;
  if (S.page < S.pages - 1) return goToPage(S.page + 1);
  if (S.cur.ch + 1 < S.book.chapters.length) return gotoChapter(S.cur.ch + 1, {});
  toast("已经是最后一章了");
}
async function flipPrev() {
  if (S.loading) return;
  if (S.page > 0) return goToPage(S.page - 1);
  if (S.cur.ch > 0) return gotoChapter(S.cur.ch - 1, { lastPage: true });
  toast("已经是第一章了");
}
async function gotoChapter(n, opts = {}) {
  if (S.loading || !S.book) return;
  n = Number.isFinite(n) ? Math.max(0, Math.min(n | 0, S.book.chapters.length - 1)) : 0;
  S.loading = true;
  showLoading(true);
  try {
    await loadChapter(n, opts.restorePara ?? null);
    if (opts.lastPage) goToPage(S.pages - 1, false);
    prefetchAdj(n);
  } finally {
    S.loading = false;
    showLoading(false);
  }
}

function prefetchAdj(n) {
  if (!S.book) return;
  [n - 1, n + 1].forEach((i) => {
    if (i >= 0 && i < S.book.chapters.length && !S.chapterCache.has(i)) {
      api(`/api/books/${S.book.id}/chapter/${i}`).then((d) => {
        if (S.chapterCache.size > 8) S.chapterCache.delete([...S.chapterCache.keys()][0]);
        S.chapterCache.set(i, d);
      }).catch(() => {});
    }
  });
}

/* 手势：横向拖动翻页 */
let drag = null;
viewport.addEventListener("touchstart", (e) => {
  drag = { x0: e.touches[0].clientX, y0: e.touches[0].clientY, dx: 0, axis: null, moved: false };
  track.classList.add("dragging");
}, { passive: true });
viewport.addEventListener("touchmove", (e) => {
  if (!drag) return;
  const dx = e.touches[0].clientX - drag.x0;
  const dy = e.touches[0].clientY - drag.y0;
  if (!drag.axis && (Math.abs(dx) > 8 || Math.abs(dy) > 8)) drag.axis = Math.abs(dx) > Math.abs(dy) ? "h" : "v";
  if (drag.axis !== "h") return;
  drag.moved = true;
  drag.dx = dx;
  let over = dx;
  if ((S.page === 0 && dx > 0) || (S.page === S.pages - 1 && dx < 0)) over = dx * 0.3;
  track.style.transform = `translateX(${-S.page * viewport.clientWidth + over}px)`;
}, { passive: true });
viewport.addEventListener("touchend", () => {
  if (!drag) return;
  track.classList.remove("dragging");
  if (drag.axis !== "h") { drag = null; return; }
  const d = drag.dx;
  drag = null;
  if (d < -50) flipNext();
  else if (d > 50) flipPrev();
  else goToPage(S.page);
});
viewport.addEventListener("touchcancel", () => { if (drag) { track.classList.remove("dragging"); goToPage(S.page); drag = null; } });

/* 点击：菜单开→关闭；否则左1/3上一页、右1/3下一页、中间呼出菜单 */
viewport.addEventListener("click", (e) => {
  if (drag && drag.moved) return;
  if (S.menuOpen) { toggleMenu(false); return; }
  const x = e.clientX / window.innerWidth;
  if (x < 0.3) flipPrev();
  else if (x > 0.7) flipNext();
  else toggleMenu(true);
});

function toggleMenu(open) {
  S.menuOpen = open ?? !S.menuOpen;
  $("#reader").classList.toggle("menu-open", S.menuOpen);
  updateBall();
  if (!S.menuOpen) {
    $("#settingsSheet").classList.add("hidden");
    closeToc();
    closeVoice();
  }
}

/* ---------------- 阅读器 ---------------- */
async function openBook(id, jump) {
  try {
    const meta = await Store.getBook(id);
    S.book = meta;
    const p = meta.progress;
    let ch = jump ? jump.ch : (p ? Math.min(p.chapter, meta.chapters.length - 1) : 0);
    let para = jump ? jump.p : (p ? Math.max(0, p.para | 0) : 0);
    // 进度数据异常时回退到第一章，绝不把非法章节号传下去
    if (!Number.isFinite(ch) || ch < 0) ch = 0;
    if (!Number.isFinite(para) || para < 0) para = 0;
    $("#shelf").classList.add("hidden");
    $("#reader").classList.remove("hidden");
    syncSystemBars(); // 阅读页背景与书架不同，状态栏颜色跟着切
    updateBall();
    await gotoChapter(ch, { restorePara: para });
  } catch (e) { showBookError(e.message); }
}

/* 打开失败诊断面板：老内核或异常时给出具体原因，避免 2 秒提示被错过 */
function showBookError(msg) {
  $("#errMsg").textContent = String(msg || "未知错误");
  $("#errPanel").classList.remove("hidden");
}
$("#errClose").addEventListener("click", () => {
  $("#errPanel").classList.add("hidden");
  backToShelf();
});
window.addEventListener("error", (e) => { if (S.book) showBookError(e.message); });
window.addEventListener("unhandledrejection", (e) => {
  if (S.book) showBookError((e.reason && e.reason.message) || String(e.reason));
});

function backToShelf() {
  stopPlay();
  saveProgressNow();
  toggleMenu(false);
  $("#reader").classList.add("hidden");
  $("#playerSheet").classList.add("hidden");
  $("#voiceSheet").classList.add("hidden");
  $("#voiceMask").classList.add("hidden");
  $("#shelf").classList.remove("hidden");
  syncSystemBars(); // 回到书架，状态栏颜色跟回底色
  updateBall();
  S.book = null; S.chapter = null; S.chapterCache.clear();
  track.innerHTML = "";
  loadShelf();
}

async function loadChapter(n, restorePara = null) {
  let data = S.chapterCache.get(n);
  if (!data) {
    data = await Store.getChapter(S.book.id, n);
    if (S.chapterCache.size > 8) S.chapterCache.delete([...S.chapterCache.keys()][0]);
    S.chapterCache.set(n, data);
  }
  S.chapter = { index: n, title: data.title, paras: data.paras, segs: data.paras.map(splitSegs) };
  S.cur = { ch: n, p: restorePara ?? 0 };
  $("#chapterTitle").textContent = data.title;
  $("#playerChapter").textContent = data.title;
  $("#miniChapter").textContent = data.title; // 左上角常显章节名

  const html = [`<h2 class="ch-title">${esc(data.title)}</h2>`];
  S.chapter.segs.forEach((segs, i) => {
    html.push(`<p>${segs.map((s, j) => `<span class="seg" data-p="${i}" data-s="${j}">${esc(s)}</span>`).join("")}</p>`);
  });
  track.innerHTML = html.join("");

  renderToc();
  layout();
  // 布局为同步计算（读 offsetWidth 强制回流），不使用 rAF：后台标签页 rAF 会暂停
  let target = 0;
  if (restorePara) {
    const el = track.querySelector(`.seg[data-p="${restorePara}"]`);
    if (el) target = pageOf(el);
  }
  goToPage(target, false);
  prefetchAdj(n);
}

function renderToc() {
  if (!S.book) return;
  const list = $("#tocList");
  list.innerHTML = "";
  $("#tocCount").textContent = `共 ${S.book.chapters.length} 章`;
  S.book.chapters.forEach((c, i) => {
    const b = document.createElement("button");
    b.className = "toc-item" + (i === S.cur.ch ? " current" : "");
    b.textContent = c.title;
    b.addEventListener("click", () => {
      closeToc();
      stopPlay();
      gotoChapter(i, {});
    });
    list.appendChild(b);
  });
}

/* 进度保存 */
let progressTimer = null;
function saveProgressSoon() { clearTimeout(progressTimer); progressTimer = setTimeout(saveProgressNow, 1200); }
function saveProgressNow() {
  if (!S.book) return;
  const para = S.playing ? S.cur.p : firstVisiblePara();
  Store.saveProgress(S.book.id, S.cur.ch, Number.isFinite(para) ? para : 0).catch(() => {});
}
document.addEventListener("visibilitychange", () => { if (document.hidden && S.book) saveProgressNow(); });
window.addEventListener("pagehide", () => { if (S.book) saveProgressNow(); });

/* 章节按钮 */
$("#btnPrevChapter").addEventListener("click", () => { stopPlay(); gotoChapter(S.cur.ch - 1, { lastPage: true }); });
$("#btnNextChapter").addEventListener("click", () => { stopPlay(); gotoChapter(S.cur.ch + 1, {}); });
$("#pageSlider").addEventListener("input", (e) => goToPage(+e.target.value - 1));

/* 目录 / 设置 / 音色弹窗 */
function closeToc() { $("#toc").classList.add("hidden"); $("#tocMask").classList.add("hidden"); }
$("#btnToc").addEventListener("click", () => {
  $("#toc").classList.remove("hidden");
  $("#tocMask").classList.remove("hidden");
  const cur = $("#tocList .toc-item.current");
  if (cur) cur.scrollIntoView({ block: "center" });
});
$("#tocMask").addEventListener("click", closeToc);

/* 目录正序/倒序 */
let tocDesc = false;
$("#tocOrder").addEventListener("click", () => {
  tocDesc = !tocDesc;
  $("#tocOrder").textContent = tocDesc ? "正序" : "倒序";
  $("#tocList").style.flexDirection = tocDesc ? "column-reverse" : "column";
  const cur = $("#tocList .toc-item.current");
  if (cur) cur.scrollIntoView({ block: "center" });
});

$("#btnSettings").addEventListener("click", () => { $("#settingsSheet").classList.toggle("hidden"); });
document.addEventListener("click", (e) => {
  if (!e.target.closest("#settingsSheet") && !e.target.closest("#btnSettings")) $("#settingsSheet").classList.add("hidden");
  if (!e.target.closest("#voiceSheet") && !e.target.closest("#btnVoice") && !e.target.closest("#voiceMask")) { /* 由 mask 自身关闭 */ }
});
$("#btnBack").addEventListener("click", backToShelf);

$("#btnNight").addEventListener("click", () => {
  prefs.theme = prefs.theme === "dark" ? "white" : "dark";
  applyReaderPrefs(false);
});

function applyReaderPrefs(relayout = true) {
  track.style.setProperty("--fs", prefs.font + "px");
  track.style.setProperty("--lh", prefs.lh);
  $("#fontLabel").textContent = prefs.font;
  $("#lhLabel").textContent = prefs.lh.toFixed(1);
  document.body.dataset.theme = prefs.theme === "dark" ? "dark" : "";
  $("#reader").dataset.theme = prefs.theme; // 阅读主题变量挂在 #reader 上：操作栏/悬浮标识/正文全部继承
  viewport.dataset.theme = prefs.theme;
  document.querySelectorAll(".theme-dot").forEach((d) => d.classList.toggle("active", d.dataset.theme === prefs.theme));
  $("#btnNight span:last-child").textContent = prefs.theme === "dark" ? "白天" : "夜间";
  syncSystemBars();
  if (relayout && S.chapter) {
    layout();
    const el = track.querySelector(`.seg[data-p="${S.cur.p}"]`);
    if (el) goToPage(pageOf(el), false);
  }
}
$("#fontPlus").addEventListener("click", () => { prefs.font = Math.min(28, prefs.font + 1); applyReaderPrefs(); });
$("#fontMinus").addEventListener("click", () => { prefs.font = Math.max(14, prefs.font - 1); applyReaderPrefs(); });
$("#lhPlus").addEventListener("click", () => { prefs.lh = Math.min(2.4, +(prefs.lh + 0.1).toFixed(1)); applyReaderPrefs(); });
$("#lhMinus").addEventListener("click", () => { prefs.lh = Math.max(1.5, +(prefs.lh - 0.1).toFixed(1)); applyReaderPrefs(); });
document.querySelectorAll(".theme-dot").forEach((d) => d.addEventListener("click", () => { prefs.theme = d.dataset.theme; applyReaderPrefs(false); }));
window.addEventListener("resize", () => {
  if (!S.chapter) return;
  layout();
  const el = track.querySelector(`.seg[data-p="${S.cur.p}"]`);
  if (el) goToPage(pageOf(el), false);
});

/* ---------------- 听书播放器 ---------------- */
const VOICE_SHORT = { "zh-CN-XiaoxiaoNeural": "晓晓", "zh-CN-XiaoyiNeural": "晓伊", "zh-CN-YunxiNeural": "云希", "zh-CN-YunjianNeural": "云健", "zh-CN-YunxiaNeural": "云夏", "zh-CN-YunyangNeural": "云扬", "zh-CN-YunyeNeural": "云野", "zh-CN-XiaoyouNeural": "晓童", "zh-CN-liaoning-XiaobeiNeural": "晓北", "zh-CN-shaanxi-XiaoniNeural": "晓妮", "zh-HK-HiuMaanNeural": "曉曼", "zh-HK-HiuGaaiNeural": "曉佳", "zh-TW-HsiaoChenNeural": "筱臣", "zh-TW-YunJheNeural": "雲哲" };

/* 系统音色（离线可用）：列表顺序稳定，speak(voice: 索引) 按此索引选择 */
let nativeVoiceList = null;
async function nativeVoices() {
  const tts = nativeTTS();
  if (!tts?.getVoices) return null;
  if (!nativeVoiceList) {
    try { nativeVoiceList = (await tts.getVoices()).voices || []; } catch { nativeVoiceList = []; }
  }
  return nativeVoiceList;
}
const voiceLabel = (v) => {
  const n = String(v.name || "系统音色");
  return n.length <= 16 ? n : (n.split(/[.:]/).filter(Boolean).pop() || n).slice(0, 16);
};

async function loadVoices() {
  const grid = $("#voiceGrid");
  if (grid.children.length) return;
  if (LOCAL_MODE) await checkServer();
  if (LOCAL_MODE && !serverAlive) {
    // 离线：列出手机系统 TTS 自带的中文音色，可真实切换
    const list = await nativeVoices();
    const zh = (list || []).filter((v) => String(v.lang || "").toLowerCase().startsWith("zh"));
    const pool = zh.length ? zh : (list || []);
    if (!pool.length) {
      const b = document.createElement("button");
      b.className = "voice-item active";
      b.style.gridColumn = "1 / -1";
      b.textContent = "系统音色";
      grid.appendChild(b);
      return;
    }
    pool.forEach((v) => {
      const b = document.createElement("button");
      b.className = "voice-item" + (v.name === prefs.nativeVoice ? " active" : "");
      b.textContent = voiceLabel(v);
      b.title = `${v.name} (${v.lang})`;
      b.addEventListener("click", () => {
        prefs.nativeVoice = v.name;
        grid.querySelectorAll(".voice-item").forEach((x) => x.classList.toggle("active", x === b));
        if (S.playing) playFrom(S.cur.ch, S.cur.p);
      });
      grid.appendChild(b);
    });
    return;
  }
  const voices = await api(`${SERVER}/api/voices`);
  voices.forEach((v) => {
    const b = document.createElement("button");
    b.className = "voice-item" + (v.id === prefs.voice ? " active" : "");
    b.textContent = VOICE_SHORT[v.id] || v.name;
    b.dataset.id = v.id;
    b.addEventListener("click", () => {
      prefs.voice = v.id;
      S.audioCache.forEach((u) => URL.revokeObjectURL(u));
      S.audioCache.clear();
      grid.querySelectorAll(".voice-item").forEach((x) => x.classList.toggle("active", x.dataset.id === v.id));
      if (S.playing) playFrom(S.cur.ch, S.cur.p);
    });
    grid.appendChild(b);
  });
}
$("#btnVoice").addEventListener("click", openVoiceSheet);
function closeVoice() { $("#voiceSheet").classList.add("hidden"); $("#voiceMask").classList.add("hidden"); }
$("#voiceMask").addEventListener("click", closeVoice);

$("#btnListen").addEventListener("click", async () => {
  toggleMenu(false);
  // 从当前页第一个段落开始读（番茄式体验），而不是上次播放位置
  playFrom(S.cur.ch, firstVisiblePara());
});
$("#rateRange").addEventListener("input", (e) => { $("#rateLabel").textContent = (+e.target.value / 100).toFixed(1) + "x"; });
$("#rateRange").addEventListener("change", (e) => {
  prefs.rate = +e.target.value;
  if (S.playing) playFrom(S.cur.ch, S.cur.p);
});

/* 定时关闭听书：按时间 / 按章节（番茄式） */
let timerTick = null;
const fmtLeft = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
function timerStatusText() {
  if (S.timerEnd) return "听书中 · 剩 " + fmtLeft(S.timerEnd - Date.now());
  if (S.timerChapters) return `听书中 · 剩 ${S.timerChapters - (S.chaptersDone || 0)} 章`;
  return "听书中";
}
$("#timerChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-min]");
  if (!b) return;
  const min = +b.dataset.min;
  document.querySelectorAll("#timerChips button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("#chapterChips button").forEach((x) => x.classList.toggle("active", x.dataset.ch === "0"));
  clearInterval(timerTick); timerTick = null;
  S.timerChapters = 0; S.chaptersDone = 0;
  if (!min) { S.timerEnd = 0; $("#playerSub").textContent = "听书中"; return; }
  S.timerEnd = Date.now() + min * 60000;
  const tick = () => {
    const left = S.timerEnd - Date.now();
    if (left <= 0) { stopPlay(); toast("定时时间到，已停止听书"); return; }
    if (S.playing) $("#playerSub").textContent = timerStatusText();
  };
  tick();
  timerTick = setInterval(tick, 1000);
  toast(`将在 ${min} 分钟后停止听书`);
});
$("#chapterChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ch]");
  if (!b) return;
  const ch = +b.dataset.ch;
  document.querySelectorAll("#chapterChips button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll("#timerChips button").forEach((x) => x.classList.toggle("active", x.dataset.min === "0"));
  clearInterval(timerTick); timerTick = null; S.timerEnd = 0;
  S.chaptersDone = 0;
  if (!ch) { S.timerChapters = 0; $("#playerSub").textContent = "听书中"; return; }
  S.timerChapters = ch;
  $("#playerSub").textContent = timerStatusText();
  toast(`读完 ${ch} 章后停止听书`);
});
/* 章节推进时由播放链调用：按章节计时在此结算 */
function chapterDone() {
  if (!S.timerChapters) return;
  S.chaptersDone = (S.chaptersDone || 0) + 1;
  const left = S.timerChapters - S.chaptersDone;
  if (left <= 0) { stopPlay(); toast("定时章节数已到，已停止听书"); return; }
  $("#playerSub").textContent = `听书中 · 剩 ${left} 章`;
}

/* 逐句高亮：按字符占比把播放进度映射到段落内的句子 */
function updateSegHighlight(p, ratio) {
  const segs = S.chapter.segs[p] || [];
  const total = segs.reduce((s, x) => s + x.length, 0) || 1;
  let acc = 0, idx = 0;
  for (let i = 0; i < segs.length; i++) {
    acc += segs[i].length;
    if (ratio <= acc / total) { idx = i; break; }
    idx = i;
  }
  track.querySelectorAll(".seg.on").forEach((el) => el.classList.remove("on"));
  const el = track.querySelector(`.seg[data-p="${p}"][data-s="${idx}"]`);
  if (el) flipToElement(el), el.classList.add("on");
  return idx;
}

audio.addEventListener("timeupdate", () => {
  if (!S.playing || !audio.duration || !Number.isFinite(audio.duration)) return;
  updateSegHighlight(S.cur.p, audio.currentTime / audio.duration);
});

function setPlayingUI(v) {
  $("#icPlay").classList.toggle("hidden", v);
  $("#icPause").classList.toggle("hidden", !v);
  S.playing = v;
  updateBall();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = v ? "playing" : "paused";
}

/* 听书悬浮球：听书时 / 阅读菜单呼出时显示（微信读书式） */
function updateBall() {
  const show = !!S.book && (S.playing || !!S.pausedPos || S.menuOpen);
  $("#listenBall").classList.toggle("hidden", !show);
  $("#listenBall").classList.toggle("live", !!S.playing);
}

async function getAudio(ch, p) {
  const key = `${ch}:${p}`;
  if (S.audioCache.has(key)) return S.audioCache.get(key);
  let text;
  if (ch === S.cur.ch && S.chapter) text = S.chapter.paras[p];
  else {
    const data = S.chapterCache.get(ch)
      || (LOCAL_MODE ? await Store.getChapter(S.book.id, ch) : await api(`/api/books/${S.book.id}/chapter/${ch}`));
    S.chapterCache.set(ch, data);
    text = data.paras[p];
  }
  if (!text) throw new Error("no text");
  const rateOffset = prefs.rate - 100; // 倍数 → Edge 的 ±百分比
  const res = await fetch(`${SERVER}/api/ra?text=${encodeURIComponent(text)}&voiceName=${encodeURIComponent(prefs.voice)}&rate=${rateOffset}`);
  if (!res.ok) throw new Error(`合成失败 HTTP ${res.status}`);
  const url = URL.createObjectURL(await res.blob());
  if (S.audioCache.size > 24) {
    const first = S.audioCache.keys().next().value;
    URL.revokeObjectURL(S.audioCache.get(first));
    S.audioCache.delete(first);
  }
  S.audioCache.set(key, url);
  return url;
}

async function playFrom(ch, p, s = 0) {
  if (!S.book) return;
  const token = ++S.playToken;
  if (LOCAL_MODE) await checkServer();
  if (ch !== S.cur.ch) await loadChapter(ch, p);
  S.cur = { ch, p, s };
  S.pausedPos = null;
  $("#playerSheet").classList.remove("hidden");
  saveProgressNow();
  setPlayingUI(true);
  if (LOCAL_MODE && !serverAlive && nativeTTS()) return nativeChain(ch, p, s, token);
  try {
    const url = await getAudio(ch, p);
    if (token !== S.playToken) return;
    audio.src = url;
    await audio.play();
    updateSegHighlight(p, 0);
    prefetchAround(ch, p, token);
  } catch (e) {
    if (token !== S.playToken) return;
    if (e.name === "NotAllowedError") { setPlayingUI(false); toast("点击播放按钮开始听书"); return; }
    if (e.name === "AbortError") {
      // play 被打断（典型：用户暂停/关闭）。若用户已停止就安静退出，绝不自动复活；
      // 其它情况的打断只轻量重试 play() 本身，不重走整条播放链。
      if (!S.playing) return;
      setTimeout(() => {
        if (token !== S.playToken || !S.playing) return;
        audio.play().then(() => updateSegHighlight(S.cur.p, audio.currentTime / (audio.duration || 1))).catch(() => {});
      }, 400);
      return;
    }
    toast("合成失败，2 秒后跳到下一段");
    setTimeout(() => { if (token === S.playToken) nextPara(); }, 2000);
  }
}

/* 离线链路：系统 TTS 按句朗读（句子短，暂停/关闭立即生效） */
async function nativeChain(ch, p, s, token) {
  while (token === S.playToken && S.book) {
    if (ch !== S.cur.ch || !S.chapter) {
      const data = S.chapterCache.get(ch) || await Store.getChapter(S.book.id, ch).catch(() => null);
      if (!data) break;
      S.chapterCache.set(ch, data);
      await loadChapter(ch, 0);
    }
    const segs = S.chapter?.segs[p] || [];
    if (s >= segs.length) { p++; s = 0; continue; }
    const text = segs[s];
    S.cur = { ch, p, s };
    updateSegHighlight(p, segs.length ? s / segs.length : 0);
    try {
      const opts = { text, lang: "zh-CN", rate: Math.max(0.5, Math.min(2, prefs.rate / 100)), pitch: 1 };
      const list = await nativeVoices();
      if (list && prefs.nativeVoice) {
        const idx = list.findIndex((v) => v.name === prefs.nativeVoice);
        if (idx >= 0) opts.voice = idx;
      }
      await nativeTTS().speak(opts);
    } catch { await new Promise((r) => setTimeout(r, 500)); }
    if (token !== S.playToken) return;
    s++;
    if (s >= (S.chapter?.segs[p]?.length || 0)) {
      p++; s = 0;
      if (p >= (S.chapter?.paras.length || 0)) {
        if (ch + 1 < S.book.chapters.length) { ch++; p = 0; chapterDone(); }
        else { setPlayingUI(false); toast("全书播完 🎉"); return; }
      }
    }
  }
}

function prefetchAround(ch, p, token) {
  (async () => {
    const tasks = [];
    if (p + 1 < (S.chapter?.paras.length || 0)) tasks.push(getAudio(ch, p + 1));
    if (p + 2 < (S.chapter?.paras.length || 0)) tasks.push(getAudio(ch, p + 2));
    if (p + 2 >= (S.chapter?.paras.length || 0) && ch + 1 < S.book.chapters.length) {
      await getAudio(ch + 1, 0).catch(() => {});
    }
    await Promise.allSettled(tasks);
  })();
}

function nextPara() {
  const paras = S.chapter?.paras.length || 0;
  if (S.cur.p + 1 < paras) playFrom(S.cur.ch, S.cur.p + 1);
  else if (S.cur.ch + 1 < S.book.chapters.length) { playFrom(S.cur.ch + 1, 0); chapterDone(); }
  else { setPlayingUI(false); toast("全书播完 🎉"); }
}
function prevPara() {
  if (S.cur.p > 0) playFrom(S.cur.ch, S.cur.p - 1);
  else if (S.cur.ch > 0) playFrom(S.cur.ch - 1, Math.max(0, (S.chapterCache.get(S.cur.ch - 1)?.paras.length || 1) - 1));
  else playFrom(S.cur.ch, 0);
}

/* 暂停：离线立即停当前句并记住位置；在线暂停音频流 */
function pauseListening() {
  if (LOCAL_MODE && !serverAlive && nativeTTS()) {
    S.pausedPos = { ...S.cur };
    S.playToken++;
    try { nativeTTS().stop(); } catch {}
    setPlayingUI(false);
  } else {
    S.playToken++;
    audio.pause();
    setPlayingUI(false);
  }
}
function resumeListening() {
  const token = ++S.playToken;
  if (LOCAL_MODE && !serverAlive && nativeTTS()) {
    if (S.pausedPos) {
      const { ch, p, s } = S.pausedPos;
      S.pausedPos = null;
      setPlayingUI(true);
      return nativeChain(ch, p, s || 0, token);
    }
    return playFrom(S.cur.ch, S.cur.p || 0, S.cur.s || 0);
  }
  if (audio.src && audio.paused) { setPlayingUI(true); audio.play().catch(() => {}); return; }
  playFrom(S.cur.ch, S.cur.p || 0);
}

function stopPlay() {
  S.playToken++; // 作废所有 pending 的播放链（含 AbortError 重试）
  setPlayingUI(false);
  audio.pause();
  audio.removeAttribute("src");
  try { audio.load(); } catch {}
  try { nativeTTS()?.stop?.(); } catch {} // 关键：停掉系统语音引擎，否则手机上声音关不掉
  track.querySelectorAll(".seg.on").forEach((el) => el.classList.remove("on")); // 关闭听书后取消正文高亮
  clearInterval(timerTick); timerTick = null;
  S.timerEnd = 0; S.timerChapters = 0; S.chaptersDone = 0; S.pausedPos = null; // 手动停止同时取消定时
  document.querySelectorAll("#timerChips button").forEach((x) => x.classList.toggle("active", x.dataset.min === "0"));
  document.querySelectorAll("#chapterChips button").forEach((x) => x.classList.toggle("active", x.dataset.ch === "0"));
  $("#playerSub").textContent = "听书中";
}

$("#btnPlayToggle").addEventListener("click", () => {
  if (S.playing) pauseListening(); else resumeListening();
});
$("#btnClosePlayer").addEventListener("click", () => {
  stopPlay();
  $("#playerSheet").classList.add("hidden");
  toast("已关闭听书");
});
$("#btnNextPara").addEventListener("click", () => nextPara());
$("#btnPrevPara").addEventListener("click", () => prevPara());

/* 听书悬浮球：未播放时点击=从当前页开始听；播放中点击=展开/收起操作面板 */
$("#listenBall").addEventListener("click", () => {
  if (!S.playing && !S.pausedPos) {
    playFrom(S.cur.ch, firstVisiblePara());
  } else {
    $("#playerSheet").classList.toggle("hidden");
  }
});
function openPlayerSheet() { $("#playerSheet").classList.remove("hidden"); }
function openVoiceSheet() { loadVoices().catch(() => {}); $("#voiceSheet").classList.remove("hidden"); $("#voiceMask").classList.remove("hidden"); }
$("#psRate").addEventListener("click", openVoiceSheet);
$("#psTimer").addEventListener("click", openVoiceSheet);

audio.addEventListener("ended", () => { if (S.playing) nextPara(); });
audio.addEventListener("error", () => { if (S.playing) { toast("音频加载失败，跳到下一段"); nextPara(); } });

if ("mediaSession" in navigator) {
  navigator.mediaSession.setActionHandler("play", () => resumeListening());
  navigator.mediaSession.setActionHandler("pause", () => pauseListening());
  navigator.mediaSession.setActionHandler("previoustrack", () => prevPara());
  navigator.mediaSession.setActionHandler("nexttrack", () => nextPara());
}
document.addEventListener("keydown", (e) => {
  if (!S.book || e.target.closest("input,select,textarea")) return;
  if (e.code === "Space") { e.preventDefault(); $("#btnPlayToggle").click(); }
  if (e.code === "ArrowLeft") flipPrev();
  if (e.code === "ArrowRight") flipNext();
});

/* ---------------- 名著书城（公版书，内置离线） ---------------- */
function decodeBuf(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.length >= 3 && u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf)
    return new TextDecoder("utf-8").decode(u8.slice(3));
  try { return new TextDecoder("utf-8", { fatal: true }).decode(u8); }
  catch { return new TextDecoder("gb18030").decode(u8); }
}

async function openStore() {
  $("#storeSheet").classList.remove("hidden");
  $("#storeMask").classList.remove("hidden");
  const list = $("#storeList");
  if (list.children.length) return;
  let catalog = [];
  try { catalog = await (await fetch("store/manifest.json")).json(); } catch { catalog = []; }
  if (!catalog.length) {
    list.innerHTML = '<div style="color:var(--muted);font-size:13px;padding:8px 0">书城清单为空：把公版 TXT 放入 public/store/ 并登记 manifest.json</div>';
    return;
  }
  catalog.forEach((b) => {
    const btn = document.createElement("button");
    btn.className = "voice-item";
    btn.style.textAlign = "left";
    btn.innerHTML = `<b>${esc(b.name)}</b><span style="float:right;color:var(--muted);font-size:11px">${esc(b.author || "")}</span>`;
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        toast(`正在加入《${b.name}》…`);
        const buf = await (await fetch(`store/${encodeURIComponent(b.file)}`)).arrayBuffer();
        const text = decodeBuf(buf);
        const book = await Store.importBook(b.name, text);
        closeStore();
        await loadShelf();
        openBook(book.id);
      } catch (e) { toast(`导入失败：${e.message}`, 3000); }
      btn.disabled = false;
    });
    list.appendChild(btn);
  });
}
function closeStore() { $("#storeSheet").classList.add("hidden"); $("#storeMask").classList.add("hidden"); }
$("#btnStore").addEventListener("click", openStore);
$("#storeMask").addEventListener("click", closeStore);

/* ---------------- 原生壳适配（Capacitor App 内生效，浏览器自动跳过） ---------------- */
const Cap = window.Capacitor?.Plugins || null;

const SHELF_BG = { light: "#f7f7f5", dark: "#0d0d0d" };
const READER_BG = { white: "#ffffff", sepia: "#f5efdc", green: "#cde8d2", dark: "#121212" };

/* 状态栏/手势条：颜色跟随当前界面背景，图标明暗随之反转（夜间可见） */
function syncSystemBars() {
  const reading = !!(S.book && S.chapter);
  const dark = prefs.theme === "dark";
  const bg = reading ? (READER_BG[prefs.theme] || "#ffffff") : SHELF_BG[dark ? "dark" : "light"];
  try { Cap?.SystemBars?.setStyle?.({ style: dark ? "DARK" : "LIGHT" }); } catch {}
  try { window.AndroidBars?.set?.(bg, dark); } catch {} // Android 原生桥：染状态栏/手势条底色
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", bg);
}

/* Android 物理返回键 / 侧滑手势：MainActivity 经此钩子询问是否已消费。
   返回 true = 已处理（关弹层/回书架/提示再按一次退出）；false = 交给系统退出应用 */
let lastBackAt = 0;
window.__szBack = () => {
  if (!$("#storeSheet").classList.contains("hidden")) { closeStore(); return true; }
  if (!$("#voiceSheet").classList.contains("hidden")) { closeVoice(); return true; }
  if (!$("#toc").classList.contains("hidden")) { closeToc(); return true; }
  if (!$("#settingsSheet").classList.contains("hidden")) { $("#settingsSheet").classList.add("hidden"); return true; }
  if (S.menuOpen) { toggleMenu(false); return true; }
  if (S.book) { backToShelf(); return true; }
  const now = Date.now();
  if (now - lastBackAt < 2000) return false;
  lastBackAt = now;
  toast("再按一次退出");
  return true;
};

/* ---------------- 启动 ---------------- */
applyReaderPrefs(false);
$("#rateRange").value = prefs.rate;
$("#rateLabel").textContent = (prefs.rate / 100).toFixed(1) + "x";
if (LOCAL_MODE) checkServer();      // 后台预探测家里电脑，不阻塞首次听书
if (nativeTTS()?.getVoices) nativeVoices(); // 预热系统 TTS 引擎，首次开播更快
loadShelf();

// 调试/自动化测试钩子
window.__sz = { playFrom, goToPage, flipNext, flipPrev, toggleMenu, gotoChapter, pauseListening, resumeListening, state: S, audio };
