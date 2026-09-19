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
  mode: null,          // 本次听书使用的音色链路：builtin / online / system
  page: 0,
  pages: 1,
  loading: false,
  menuOpen: false,
  follow: true,        // 听书时高亮是否自动翻页（手动翻页后置 false，点高亮句恢复）
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
  // 音色来源：builtin=内置离线语音（随 APK 打包，免费可商用）/ online=电脑 Edge / system=系统TTS；空=自动选
  get voiceMode() { return localStorage.getItem("sz_voice_mode") || ""; },
  set voiceMode(v) { localStorage.setItem("sz_voice_mode", v); },
  // 内置语音音色编号（子集化后 sid：0-3 中文女声，4-6 中文男声，7-9 英文女声）
  get builtinVoice() {
    const v = +localStorage.getItem("sz_builtin_voice");
    if (!Number.isFinite(v) || v < 0) return 0;
    if (v <= 9) return v;
    // 旧版 103 音色编号迁移：英文 0-2 → 7-9；中文女声 → 0；中文男声 → 4
    if (v <= 2) return v + 7;
    if (v <= 57) return 0;
    return 4;
  },
  set builtinVoice(v) { localStorage.setItem("sz_builtin_voice", v); },
  // 阅读界面亮度（20~100，100=不调暗）
  get dim() { const v = +localStorage.getItem("sz_dim"); return Number.isFinite(v) && v >= 20 && v <= 100 ? v : 100; },
  set dim(v) { localStorage.setItem("sz_dim", v); },
  // 翻页方式：cover 覆盖 / slide 平移 / none 无动画 / scroll 上下滚动（番茄式）
  get flip() { return ["cover", "slide", "none", "scroll"].includes(localStorage.getItem("sz_flip")) ? localStorage.getItem("sz_flip") : "slide"; },
  set flip(v) { localStorage.setItem("sz_flip", v); },
  // 正文字体：sans 默认 / song 宋体 / kai 楷体
  get ff() { return ["sans", "song", "kai"].includes(localStorage.getItem("sz_ff")) ? localStorage.getItem("sz_ff") : "sans"; },
  set ff(v) { localStorage.setItem("sz_ff", v); },
  // 字间距（px，0~4）
  get letter() { const v = +localStorage.getItem("sz_letter"); return Number.isFinite(v) && v >= 0 && v <= 4 ? v : 0; },
  set letter(v) { localStorage.setItem("sz_letter", v); },
  // 自动阅读速度档（1~10，越大越快；开关是会话态，不持久化）
  get autoSpeed() { const v = +localStorage.getItem("sz_auto"); return v >= 1 && v <= 10 ? v : 5; },
  set autoSpeed(v) { localStorage.setItem("sz_auto", v); },
  // 目录排序：false 正序 / true 倒序
  get tocDesc() { return localStorage.getItem("sz_toc_desc") === "1"; },
  set tocDesc(v) { localStorage.setItem("sz_toc_desc", v ? "1" : "0"); },
  // 豆包同源音色（火山引擎 TTS）：用户在火山引擎控制台开通后填入，免费额度可用
  get volcanoAppId() { return localStorage.getItem("sz_vt_appid") || ""; },
  set volcanoAppId(v) { localStorage.setItem("sz_vt_appid", (v || "").trim()); },
  get volcanoToken() { return localStorage.getItem("sz_vt_token") || ""; },
  set volcanoToken(v) { localStorage.setItem("sz_vt_token", (v || "").trim()); },
  get volcanoVoice() { return localStorage.getItem("sz_vt_voice") || "BV700_streaming"; },
  set volcanoVoice(v) { localStorage.setItem("sz_vt_voice", v || "BV700_streaming"); },
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
/* 内置离线语音桥（Android 原生 SherpaTts，Kokoro 模型随 APK 打包，免费可商用） */
const androidTts = () => window.AndroidTts || null;

/* ---------------- 内置语音引擎状态与事件 ----------------
   原生桥接口：init() / isReady() / speak(text,sid,speed) / stop() / setVolumePage(bool)
   事件统一回调 __szNativeTtsEvent(type, msg)：ready / done / error / focusloss */
let builtinState = "none"; // none → init → ready | failed
let builtinErr = "";
let builtinWaiters = [];
let builtinSpeakPend = null; // 当前句子 speak 的等待者（done/error 时结算）

function startBuiltinInit() {
  const bt = androidTts();
  if (!bt || builtinState === "ready" || builtinState === "init") return;
  builtinState = "init";
  try { bt.init(); }
  catch (e) { builtinState = "failed"; builtinErr = (e && e.message) || String(e); }
}

/* 等引擎就绪（最多 ms 毫秒）。ready→true；failed/超时→false */
function waitBuiltinReady(ms = 8000) {
  if (builtinState === "ready") return Promise.resolve(true);
  if (builtinState === "failed") return Promise.resolve(false);
  startBuiltinInit();
  return new Promise((res) => {
    const t = setTimeout(() => res(builtinState === "ready"), ms);
    builtinWaiters.push(() => { clearTimeout(t); res(builtinState === "ready"); });
  });
}

/* 结算正在等待的句子朗读（done=播完 / error=出错 / stop=被打断） */
function settleBuiltin(kind, msg) {
  const p = builtinSpeakPend; builtinSpeakPend = null;
  if (!p) return;
  if (kind === "done") p.res();
  else p.rej(Object.assign(new Error(msg || "朗读已中断"), { stopped: kind === "stop" }));
}

/* 用内置语音读一句，返回 Promise（播完才 resolve，出错 reject） */
function builtinSpeak(text, sid, speed) {
  return new Promise((res, rej) => {
    builtinSpeakPend = { res, rej };
    try { androidTts().speak(text, sid, speed); }
    catch (e) { builtinSpeakPend = null; rej(e); }
  });
}

window.__szNativeTtsEvent = (type, msg) => {
  if (type === "ready") {
    builtinState = "ready"; builtinErr = "";
    const ws = builtinWaiters; builtinWaiters = [];
    ws.forEach((fn) => fn());
    if (voiceSheetOpen() && voiceTab === "builtin") renderBuiltinVoices();
  } else if (type === "error") {
    if (String(msg || "").indexOf("初始化失败") === 0) {
      builtinState = "failed"; builtinErr = msg;
      const ws = builtinWaiters; builtinWaiters = [];
      ws.forEach((fn) => fn());
      if (voiceSheetOpen() && voiceTab === "builtin") renderBuiltinVoices();
    } else settleBuiltin("error", msg);
  } else if (type === "done") settleBuiltin("done");
  else if (type === "focusloss") pauseListening(); // 来电话/其他应用抢焦点：自动暂停
};

/* 三条链路的停止开关（互不影响：切链路前把别的链路停干净） */
function haltAudioEl() { try { audio.pause(); audio.removeAttribute("src"); audio.load(); } catch {} }
function haltBuiltin() { try { androidTts()?.stop?.(); } catch {} settleBuiltin("stop"); }
function haltSystem() { try { nativeTTS()?.stop?.(); } catch {} }

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const coverHue = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
const SEG_SPLIT = /[^。！？；…]+[。！？；…]*/g;
const splitSegs = (text) => (text.match(SEG_SPLIT) || [text]).filter(Boolean);
const showLoading = (v) => $("#flipLoading").classList.toggle("hidden", !v);

/* ---------------- 书架 ---------------- */
/* 继续阅读卡（番茄式：最近在读置顶，一键回到上次位置） */
function renderHero(books) {
  const hero = $("#heroCard");
  if (!books.length) { hero.classList.add("hidden"); return; }
  const b = books.find((x) => x.progress) || books[0];
  const hue = coverHue(b.id);
  const pct = b.progress ? Math.min(99, Math.round(((b.progress.chapter + 1) / b.chapterCount) * 100)) : 0;
  $("#heroName").textContent = b.name;
  $("#heroMeta").textContent = `${b.chapterCount} 章` +
    (b.progress ? ` · 第 ${Math.min(b.progress.chapter + 1, b.chapterCount)} 章 · 已读 ${pct}%` : " · 从头开始");
  $("#heroProgress").style.width = pct + "%";
  const cov = $("#heroCover");
  cov.style.background = `linear-gradient(160deg,hsl(${hue},58%,52%),hsl(${(hue + 45) % 360},58%,40%))`;
  cov.textContent = b.name.slice(0, 4);
  hero.classList.remove("hidden");
  hero.onclick = () => openBook(b.id);
}

let shelfKw = "";
async function loadShelf() {
  const all = await Store.listBooks();
  renderHero(all);
  const books = shelfKw
    ? all.filter((b) => String(b.name).toLowerCase().includes(shelfKw))
    : all;
  const grid = $("#bookGrid");
  grid.innerHTML = "";
  $("#shelfEmpty").classList.toggle("hidden", all.length > 0);
  $("#shelfSearchRow").classList.toggle("hidden", all.length === 0);
  renderReadStat();
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
      <div class="book-meta">${b.chapterCount} 章${b.progress ? " · 读到 " + pct + "%" : ""}</div>`;
    card.querySelector(".book-cover").addEventListener("click", () => openBook(b.id));
    let pressTimer = null;
    card.addEventListener("contextmenu", (e) => { e.preventDefault(); deleteBook(b); });
    card.addEventListener("touchstart", () => { pressTimer = setTimeout(() => deleteBook(b), 600); }, { passive: true });
    card.addEventListener("touchend", () => clearTimeout(pressTimer));
    card.addEventListener("touchmove", () => clearTimeout(pressTimer));
    grid.appendChild(card);
  }
}
$("#shelfSearch").addEventListener("input", (e) => {
  shelfKw = e.target.value.trim().toLowerCase();
  loadShelf();
});

/* ---------------- 阅读时长统计（番茄式今日阅读） ---------------- */
const todayKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };
function readMinutes() {
  try {
    const r = JSON.parse(localStorage.getItem("sz_readtime") || "{}");
    return r.day === todayKey() ? Math.floor((r.secs || 0) / 60) : 0;
  } catch { return 0; }
}
function addReadTime(secs) {
  let r = {};
  try { r = JSON.parse(localStorage.getItem("sz_readtime") || "{}"); } catch {}
  if (r.day !== todayKey()) { r = { day: todayKey(), secs: 0 }; }
  r.secs = (r.secs || 0) + secs;
  localStorage.setItem("sz_readtime", JSON.stringify(r));
}
function renderReadStat() {
  const m = readMinutes();
  $("#readStat").textContent = m > 0 ? `今日 ${m} 分钟` : "";
}
/* 阅读页打开且前台可见时每 30 秒累计一次 */
setInterval(() => { if (S.book && !document.hidden) { addReadTime(30); renderReadStat(); } }, 30000);
document.addEventListener("visibilitychange", () => { if (document.hidden && S.book) { addReadTime(30); saveProgressNow(); } });

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

/* ---------------- 分页核心 ----------------
   横向模式：CSS 多列分页 + transform 平移（slide）/ 覆盖浮层（cover）/ 直接跳（none）
   纵向模式（scroll）：整章块状排版，viewport 原生滚动（番茄式上下滑动） */
const isScroll = () => prefs.flip === "scroll";

function layout() {
  const pw = viewport.clientWidth;
  if (!pw) return;
  track.style.padding = `0 ${PAD}px`;
  if (isScroll()) {
    track.style.columnWidth = "auto";
    track.style.columnGap = "normal";
    S.pages = 1; S.page = 0;
    updateIndicator();
    return;
  }
  track.style.columnWidth = (pw - PAD * 2) + "px";
  track.style.columnGap = (PAD * 2) + "px";
  // 末页常是窄列，scrollWidth 略小于 N*pw，必须向上取整否则末页翻不到
  S.pages = Math.max(1, Math.ceil((track.scrollWidth - 1) / pw));
  updateIndicator();
}

function goToPage(i, smooth = true) {
  if (isScroll()) {
    // 纵向模式：参数即目标 scrollTop（0=章首，scrollHeight=章尾）
    S.page = 0; S.pages = 1;
    viewport.scrollTop = Math.max(0, i);
    updateIndicator();
    saveProgressSoon();
    return;
  }
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

/* 定位到当前段落对应的页面/滚动位置（字号行距变化、窗口尺寸变化后保持阅读位置） */
function scrollToCurrentPara() {
  const el = track.querySelector(`.seg[data-p="${S.cur.p}"]`);
  if (!el) return;
  if (isScroll()) viewport.scrollTop = Math.max(0, el.offsetTop - 48);
  else goToPage(pageOf(el), false);
}

function firstVisiblePara() {
  if (isScroll()) {
    const top = viewport.getBoundingClientRect().top + 40;
    for (const el of segEls()) if (el.getBoundingClientRect().bottom >= top) return +el.dataset.p;
    return S.cur.p;
  }
  for (const el of segEls()) if (pageOf(el) === S.page) return +el.dataset.p;
  return S.cur.p;
}

function flipToElement(el) {
  if (isScroll()) { el.scrollIntoView({ behavior: "smooth", block: "center" }); return; }
  const target = pageOf(el);
  if (target !== S.page) goToPage(target);
}

/* 全书进度（章 + 章内页/滚动占比 → 百分比，番茄式右下角常显） */
function inChapterFrac() {
  if (isScroll()) {
    const max = viewport.scrollHeight - viewport.clientHeight;
    return max > 0 ? Math.max(0, Math.min(1, viewport.scrollTop / max)) : 0;
  }
  return S.pages > 1 ? S.page / S.pages : 0;
}
function bookProgress() {
  if (!S.book || !S.chapter) return 0;
  const total = S.book.chapters.length || 1;
  return Math.max(0, Math.min(1, (S.cur.ch + inChapterFrac()) / total));
}

function updateIndicator() {
  // 底部菜单只保留上一章/下一章 + 纯文字页码（全书进度在右下角常显小标识）
  $("#pageText").textContent = isScroll()
    ? Math.round(inChapterFrac() * 100) + "%"
    : `${S.page + 1}/${S.pages}`;
  $("#miniPage").textContent = Math.round(bookProgress() * 100) + "%";
}

/* ---------- 覆盖翻页（cover）：下一页从右盖上来 / 当前页滑出露出上一页 ---------- */
let coverBusy = false;
function coverFlip(dir) {
  if (coverBusy) return;
  const pw = viewport.clientWidth;
  if (!pw) return;
  coverBusy = true;
  const clone = track.cloneNode(true);
  clone.removeAttribute("id");
  clone.className = "track-clone";
  const overlay = document.createElement("div");
  overlay.className = "flip-overlay";
  overlay.appendChild(clone);
  viewport.appendChild(overlay);
  const finish = (nextPage) => {
    overlay.remove();
    track.style.background = "";
    track.style.zIndex = "";
    goToPage(nextPage, false);
    coverBusy = false;
  };
  if (dir > 0) {
    clone.style.transform = `translateX(${-(S.page + 1) * pw}px)`;
    overlay.style.transform = `translateX(${pw}px)`;
    requestAnimationFrame(() => requestAnimationFrame(() => { overlay.style.transform = "translateX(0)"; }));
    setTimeout(() => finish(S.page + 1), 330);
  } else {
    clone.style.transform = `translateX(${-(S.page - 1) * pw}px)`;
    overlay.style.zIndex = "0"; // 上一页垫底
    track.style.background = getComputedStyle(viewport).backgroundColor;
    track.style.zIndex = "1";
    requestAnimationFrame(() => requestAnimationFrame(() => {
      track.style.transform = `translateX(${-(S.page - 1) * pw}px)`; // 当前页滑出
    }));
    setTimeout(() => finish(S.page - 1), 330);
  }
}

/* ---------- 纵向滚动翻页 ---------- */
function scrollFlip(dir) {
  const max = viewport.scrollHeight - viewport.clientHeight;
  if (dir > 0) {
    if (viewport.scrollTop < max - 4) viewport.scrollBy({ top: viewport.clientHeight * 0.86, behavior: "smooth" });
    else if (S.cur.ch + 1 < S.book.chapters.length) gotoChapter(S.cur.ch + 1, {});
    else toast("已经是最后一章了");
  } else {
    if (viewport.scrollTop > 4) viewport.scrollBy({ top: -viewport.clientHeight * 0.86, behavior: "smooth" });
    else if (S.cur.ch > 0) gotoChapter(S.cur.ch - 1, { lastPage: true });
    else toast("已经是第一章了");
  }
}

/* 无缝跨章翻页：末页继续向后 → 下一章；首页向前 → 上一章末页 */
async function flipNext() {
  if (S.loading) return;
  if (isScroll()) return scrollFlip(1);
  if (S.page < S.pages - 1) {
    if (prefs.flip === "cover") return coverFlip(1);
    return goToPage(S.page + 1, prefs.flip !== "none");
  }
  if (S.cur.ch + 1 < S.book.chapters.length) return gotoChapter(S.cur.ch + 1, {});
  toast("已经是最后一章了");
}
async function flipPrev() {
  if (S.loading) return;
  if (isScroll()) return scrollFlip(-1);
  if (S.page > 0) {
    if (prefs.flip === "cover") return coverFlip(-1);
    return goToPage(S.page - 1, prefs.flip !== "none");
  }
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
    if (opts.lastPage) {
      if (isScroll()) goToPage(viewport.scrollHeight, false);
      else goToPage(S.pages - 1, false);
    }
    prefetchAdj(n);
  } finally {
    S.loading = false;
    showLoading(false);
    if (pendingNav && S.book) { const d = pendingNav; pendingNav = 0; setTimeout(() => chapterNav(d), 30); }
  }
}
/* 相邻章节预取 */
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

/* 手势：横向拖动翻页。听书时手动翻页 = 暂停自动跟随（播放继续，高亮留在播放句）。
   纵向滚动模式交给原生滚动；覆盖模式只识别方向（浮层动画不跟手） */
let drag = null;
viewport.addEventListener("touchstart", (e) => {
  if (isScroll()) { drag = null; return; }
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
  if (prefs.flip === "cover") return; // 覆盖动画阶段再动，拖动中不跟手
  let over = dx;
  if ((S.page === 0 && dx > 0) || (S.page === S.pages - 1 && dx < 0)) over = dx * 0.3;
  track.style.transform = `translateX(${-S.page * viewport.clientWidth + over}px)`;
}, { passive: true });
viewport.addEventListener("touchend", () => {
  if (!drag) return;
  track.classList.remove("dragging");
  if (drag.axis !== "h") { drag = null; return; }
  const d = drag.dx;
  const moved = drag.moved;
  drag = null;
  if (moved && S.playing) S.follow = false; // 用户手动翻了页：跟随让位
  if (moved) autoStop(true); // 手动翻页停止自动阅读
  if (d < -50) flipNext();
  else if (d > 50) flipPrev();
  else goToPage(isScroll() ? 0 : S.page, false);
});
viewport.addEventListener("touchcancel", () => { if (drag) { track.classList.remove("dragging"); goToPage(isScroll() ? 0 : S.page, false); drag = null; } });

/* 点击：菜单开→关闭；点正在读的高亮句=跳回播放位置；否则左1/3上一页、右1/3下一页、中间呼出菜单 */
viewport.addEventListener("click", (e) => {
  if (drag && drag.moved) return;
  if (S.menuOpen) { toggleMenu(false); return; }
  const onSeg = e.target.closest && e.target.closest(".seg.on");
  if (onSeg && (S.playing || S.pausedPos)) {
    S.follow = true; // 点击正在读的句子：跳回播放位置并恢复跟随
    flipToElement(onSeg);
    return;
  }
  autoStop(true); // 任意正文点击停止自动阅读
  if (S.playing) S.follow = false;
  const x = e.clientX / window.innerWidth;
  if (x < 0.3) flipPrev();
  else if (x > 0.7) flipNext();
  else toggleMenu(true);
});

function toggleMenu(open) {
  S.menuOpen = open ?? !S.menuOpen;
  $("#reader").classList.toggle("menu-open", S.menuOpen);
  updateBall();
  if (S.menuOpen) autoStop(true); // 呼出菜单即停自动阅读
  if (!S.menuOpen) {
    $("#settingsSheet").classList.add("hidden");
    closeToc();
    closeVoice();
    closeRateSheet();
    closeTimerSheet();
    closeVolcanoSheet();
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
    keepAwake(true); // 阅读期间屏幕常亮
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
  autoStop(true);
  keepAwake(false);
  saveProgressNow();
  toggleMenu(false);
  $("#reader").classList.add("hidden");
  $("#playerSheet").classList.add("hidden");
  $("#voiceSheet").classList.add("hidden");
  $("#voiceMask").classList.add("hidden");
  $("#shelf").classList.remove("hidden");
  syncSystemBars(); // 回到书架，状态栏颜色跟回底色
  updateBall();
  try { window.AndroidMedia?.hide?.(); } catch {} // 通知栏媒体卡片一并收起
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
    if (el) target = isScroll() ? Math.max(0, el.offsetTop - 48) : pageOf(el);
  }
  goToPage(target, false);
  prefetchAdj(n);
}

function renderToc() {
  if (!S.book) return;
  const list = $("#tocList");
  list.innerHTML = "";
  $("#tocCount").textContent = `共 ${S.book.chapters.length} 章`;
  const kw = ($("#tocSearch").value || "").trim().toLowerCase();
  let shown = 0;
  const idxs = S.book.chapters.map((c, i) => i);
  if (prefs.tocDesc) idxs.reverse(); // 倒序（番茄式：追更场景先看最新）
  for (const i of idxs) {
    const c = S.book.chapters[i];
    if (kw && !String(c.title).toLowerCase().includes(kw)) continue;
    const b = document.createElement("button");
    b.className = "toc-item" + (i === S.cur.ch ? " current" : "");
    b.textContent = c.title;
    b.addEventListener("click", () => {
      closeToc();
      stopPlay();
      autoStop(true);
      gotoChapter(i, {});
    });
    list.appendChild(b);
    shown++;
  }
  if (!shown) {
    const d = document.createElement("div");
    d.className = "toc-empty";
    d.textContent = "没有匹配的章节";
    list.appendChild(d);
  }
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
/* 章节切换：听书中切章继续播新章节；暂停/未播放时只移动视图（暂停位置保留，恢复时回原章）；
   加载中连点会排队补跳 */
let pendingNav = 0;
function chapterNav(dir) {
  if (!S.book) return;
  if (S.loading) { pendingNav = dir; return; } // 加载中先记下，加载完补跳
  const target = S.cur.ch + dir;
  if (target < 0) { toast("已经是第一章了"); return; }
  if (target >= S.book.chapters.length) { toast("已经是最后一章了"); return; }
  if (S.playing) {
    playFrom(target, 0); // 播放无缝切到新章节开头
  } else {
    gotoChapter(target, {}); // 未播放时上一章/下一章都落到章节开头
  }
}
$("#btnPrevChapter").addEventListener("click", () => chapterNav(-1));
$("#btnNextChapter").addEventListener("click", () => chapterNav(1));
/* 播放面板：拖动跳句（松手生效，避免与播放推进打架） */
$("#paraSlider").addEventListener("change", (e) => {
  if (!S.chapter) return;
  const target = +e.target.value - 1;
  let acc = 0;
  for (let pi = 0; pi < S.chapter.segs.length; pi++) {
    const segs = S.chapter.segs[pi];
    if (target < acc + segs.length) {
      if (!S.playing) resumeListeningElsewhere(pi, target - acc);
      else playFrom(S.cur.ch, pi, target - acc);
      return;
    }
    acc += segs.length;
  }
});
function resumeListeningElsewhere(p, s) {
  S.pausedPos = null;
  playFrom(S.cur.ch, p, s);
}

/* 目录 / 设置 / 音色弹窗 */
function closeToc() { $("#toc").classList.add("hidden"); $("#tocMask").classList.add("hidden"); }
$("#btnToc").addEventListener("click", () => {
  $("#toc").classList.remove("hidden");
  $("#tocMask").classList.remove("hidden");
  syncVolumePage(); // 目录打开时音量键还原为调音量
  $("#tocOrder").textContent = prefs.tocDesc ? "正序" : "倒序";
  renderToc();
  const cur = $("#tocList .toc-item.current");
  if (cur) cur.scrollIntoView({ block: "center" });
});
/* 目录正序/倒序切换 */
$("#tocOrder").addEventListener("click", () => {
  prefs.tocDesc = !prefs.tocDesc;
  $("#tocOrder").textContent = prefs.tocDesc ? "正序" : "倒序";
  renderToc();
  const cur = $("#tocList .toc-item.current");
  if (cur) cur.scrollIntoView({ block: "center" });
});
$("#tocMask").addEventListener("click", () => { closeToc(); syncVolumePage(); });
/* 章节名搜索：输入即过滤 */
$("#tocSearch").addEventListener("input", () => {
  renderToc();
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

/* 正文字体栈：跟随系统可达字体，Windows/安卓/iOS 各取所长 */
const FF_STACKS = {
  sans: '-apple-system,"PingFang SC","HarmonyOS Sans SC","MiSans","Microsoft YaHei",sans-serif',
  song: 'Georgia,"Songti SC","Noto Serif CJK SC","Source Han Serif SC","SimSun",serif',
  kai: '"Kaiti SC","STKaiti","KaiTi","Noto Serif CJK SC","SimSun",serif',
};

function applyReaderPrefs(relayout = true) {
  viewport.classList.toggle("scroll", prefs.flip === "scroll");
  track.style.setProperty("--fs", prefs.font + "px");
  track.style.setProperty("--lh", prefs.lh);
  track.style.setProperty("--ls", prefs.letter + "px");
  track.style.fontFamily = FF_STACKS[prefs.ff] || "";
  $("#fontLabel").textContent = prefs.font;
  $("#lhLabel").textContent = prefs.lh.toFixed(1);
  $("#lsLabel").textContent = prefs.letter + "px";
  $("#autoLabel").textContent = prefs.autoSpeed + " 档";
  document.querySelectorAll("#fontChips button").forEach((b) => b.classList.toggle("active", b.dataset.ff === prefs.ff));
  document.querySelectorAll("#flipChips button").forEach((b) => b.classList.toggle("active", b.dataset.flip === prefs.flip));
  // 亮度：20~100，越低越暗（黑色遮罩，不动系统亮度，省电且不影响其他应用）
  $("#dimLayer").style.opacity = ((100 - prefs.dim) / 100 * 0.75).toFixed(3);
  $("#dimRange").value = prefs.dim;
  $("#dimLabel").textContent = prefs.dim + "%";
  document.body.dataset.theme = prefs.theme === "dark" ? "dark" : "";
  $("#reader").dataset.theme = prefs.theme; // 阅读主题变量挂在 #reader 上：操作栏/悬浮标识/正文全部继承
  viewport.dataset.theme = prefs.theme;
  document.querySelectorAll(".theme-card").forEach((d) => d.classList.toggle("active", d.dataset.theme === prefs.theme));
  $("#btnNight span:last-child").textContent = prefs.theme === "dark" ? "白天" : "夜间";
  syncSystemBars();
  if (relayout && S.chapter) {
    layout();
    scrollToCurrentPara();
  }
}
$("#dimRange").addEventListener("input", (e) => {
  prefs.dim = Math.max(20, Math.min(100, +e.target.value));
  $("#dimLayer").style.opacity = ((100 - prefs.dim) / 100 * 0.75).toFixed(3);
  $("#dimLabel").textContent = prefs.dim + "%";
});
$("#fontPlus").addEventListener("click", () => { prefs.font = Math.min(28, prefs.font + 1); applyReaderPrefs(); });
$("#fontMinus").addEventListener("click", () => { prefs.font = Math.max(14, prefs.font - 1); applyReaderPrefs(); });
$("#lhPlus").addEventListener("click", () => { prefs.lh = Math.min(2.4, +(prefs.lh + 0.1).toFixed(1)); applyReaderPrefs(); });
$("#lhMinus").addEventListener("click", () => { prefs.lh = Math.max(1.5, +(prefs.lh - 0.1).toFixed(1)); applyReaderPrefs(); });
$("#lsPlus").addEventListener("click", () => { prefs.letter = Math.min(4, +(prefs.letter + 0.5).toFixed(1)); applyReaderPrefs(); });
$("#lsMinus").addEventListener("click", () => { prefs.letter = Math.max(0, +(prefs.letter - 0.5).toFixed(1)); applyReaderPrefs(); });
$("#fontChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-ff]");
  if (!b) return;
  prefs.ff = b.dataset.ff;
  applyReaderPrefs(false);
});
$("#flipChips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-flip]");
  if (!b || b.dataset.flip === prefs.flip) return;
  prefs.flip = b.dataset.flip;
  autoStop(true);
  applyReaderPrefs();
});
document.querySelectorAll(".theme-card").forEach((d) => d.addEventListener("click", () => { prefs.theme = d.dataset.theme; applyReaderPrefs(false); }));

/* ---------------- 自动阅读（番茄式）：定时翻页 / 滚动模式匀速下滑 ---------------- */
let autoTimer = null;
function renderAutoUI() {
  const t = $("#autoToggle");
  t.textContent = S.auto ? "开" : "关";
  t.classList.toggle("active", !!S.auto);
}
function autoStop(silent = false) {
  if (!S.auto) return;
  S.auto = false;
  clearInterval(autoTimer); autoTimer = null;
  renderAutoUI();
  if (!silent) toast("自动阅读已停止");
}
function autoStart() {
  autoStop(true);
  if (!S.book) return;
  S.auto = true;
  const speed = prefs.autoSpeed;
  if (isScroll()) {
    autoTimer = setInterval(() => {
      if (S.loading) return;
      const max = viewport.scrollHeight - viewport.clientHeight;
      if (viewport.scrollTop >= max - 2) flipNext(); // 章尾自动续下一章
      else viewport.scrollBy({ top: speed * 1.4 });
    }, 140);
  } else {
    autoTimer = setInterval(() => { if (!S.loading && !coverBusy) flipNext(); }, (11 - speed) * 900);
  }
  renderAutoUI();
  toast(`自动阅读已开启（${speed} 档）`);
}
$("#autoToggle").addEventListener("click", () => {
  if (S.auto) autoStop();
  else if (!S.book) toast("先打开一本书");
  else autoStart();
});
$("#autoMinus").addEventListener("click", () => {
  prefs.autoSpeed = Math.max(1, prefs.autoSpeed - 1);
  renderAutoUI();
  if (S.auto) autoStart();
});
$("#autoPlus").addEventListener("click", () => {
  prefs.autoSpeed = Math.min(10, prefs.autoSpeed + 1);
  renderAutoUI();
  if (S.auto) autoStart();
});

/* ---------------- 屏幕常亮（阅读/听书期间） ----------------
   安卓走原生桥（FLAG_KEEP_SCREEN_ON），iOS/浏览器用 Screen Wake Lock API */
let wakeLockObj = null;
async function keepAwake(on) {
  try {
    if (window.AndroidScreen?.keep) { window.AndroidScreen.keep(!!on); return; }
    if (on) {
      if (!wakeLockObj && navigator.wakeLock?.request)
        wakeLockObj = await navigator.wakeLock.request("screen").catch(() => null);
    } else if (wakeLockObj) {
      try { await wakeLockObj.release(); } catch {}
      wakeLockObj = null;
    }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && S.book) keepAwake(true); // 切回前台重新持有（系统可能已释放）
});

window.addEventListener("resize", () => {
  if (!S.chapter) return;
  layout();
  scrollToCurrentPara();
});
/* 纵向滚动模式：滚动时刷新进度百分比 */
viewport.addEventListener("scroll", () => {
  if (!S.chapter || !isScroll()) return;
  updateIndicator();
  saveProgressSoon();
}, { passive: true });

/* ---------------- 豆包同源音色（火山引擎 TTS） ----------------
   App 内经 CapacitorHttp 直连官方接口（无 CORS 限制）；
   浏览器模式经本机服务 /api/vtts 代理转发。需用户在火山引擎控制台开通（有免费额度）。 */
const VOLC_VOICES = [
  { id: "BV700_streaming", name: "灿灿 · 活泼女声" },
  { id: "BV701_streaming", name: "擎苍 · 磁性男声" },
  { id: "BV001_streaming", name: "通用女声" },
  { id: "BV002_streaming", name: "通用男声" },
];

function b64ToBytes(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function volcanoSynthesize(text) {
  const body = {
    app: { appid: prefs.volcanoAppId, token: prefs.volcanoToken, cluster: "volcano_tts" },
    user: { uid: "shuzhai-reader" },
    audio: { voice_type: prefs.volcanoVoice, encoding: "mp3", speed_ratio: Math.max(0.2, Math.min(3, prefs.rate / 100)) },
    request: { reqid: crypto.randomUUID ? crypto.randomUUID() : "sz" + Date.now() + Math.random().toString(36).slice(2), text: String(text).slice(0, 1024), operation: "query" },
  };
  const url = LOCAL_MODE ? "https://openspeech.bytedance.com/api/v1/tts" : `${SERVER}/api/vtts`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer;" + prefs.volcanoToken },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.data) throw new Error(data.message || `HTTP ${res.status}`);
  return URL.createObjectURL(new Blob([b64ToBytes(data.data)], { type: "audio/mpeg" }));
}

async function getVolcanoAudio(ch, p) {
  const key = `v:${ch}:${p}:${prefs.rate}:${prefs.volcanoVoice}`;
  if (S.audioCache.has(key)) return S.audioCache.get(key);
  const text = S.chapter && ch === S.cur.ch ? S.chapter.paras[p] : (S.chapterCache.get(ch) || await Store.getChapter(S.book.id, ch)).paras[p];
  if (!text) throw new Error("no text");
  const url = await volcanoSynthesize(text);
  if (S.audioCache.size > 24) {
    const first = S.audioCache.keys().next().value;
    URL.revokeObjectURL(S.audioCache.get(first));
    S.audioCache.delete(first);
  }
  S.audioCache.set(key, url);
  return url;
}

/* ---------------- 听书播放器 ---------------- */
const VOICE_SHORT = { "zh-CN-XiaoxiaoNeural": "晓晓", "zh-CN-XiaoyiNeural": "晓伊", "zh-CN-YunxiNeural": "云希", "zh-CN-YunjianNeural": "云健", "zh-CN-YunxiaNeural": "云夏", "zh-CN-YunyangNeural": "云扬", "zh-CN-YunyeNeural": "云野", "zh-CN-XiaoyouNeural": "晓童", "zh-CN-liaoning-XiaobeiNeural": "晓北", "zh-CN-shaanxi-XiaoniNeural": "晓妮", "zh-HK-HiuMaanNeural": "曉曼", "zh-HK-HiuGaaiNeural": "曉佳", "zh-TW-HsiaoChenNeural": "筱臣", "zh-TW-YunJheNeural": "雲哲" };

/* 系统音色（离线可用）。注意：安卓插件的方法名是 getSupportedVoices（iOS/web 为 getVoices），
   部分手机首次调用返回空/挂起：带重试 + 超时，绝不卡住弹窗 */
let nativeVoiceList = null;
async function nativeVoices() {
  const tts = nativeTTS();
  if (!tts) return null;
  if (nativeVoiceList) return nativeVoiceList;
  const fn = tts.getSupportedVoices || tts.getVoices; // 安卓/iOS 方法名不同
  if (!fn) return null;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await Promise.race([
        fn.call(tts),
        new Promise((res) => setTimeout(() => res(null), 1500)),
      ]);
      const list = (r && (r.voices || r)) || [];
      if (list.length) { nativeVoiceList = list; return list; }
    } catch { break; }
    await new Promise((res) => setTimeout(res, 400));
  }
  nativeVoiceList = [];
  return [];
}
const voiceLabel = (v) => {
  const n = String(v.name || "系统音色");
  return n.length <= 16 ? n : (n.split(/[.:]/).filter(Boolean).pop() || n).slice(0, 16);
};
const CHECK_SVG = '<svg class="v-check" viewBox="0 0 24 24"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';

/* ---------------- 音色弹窗：三个来源（内置离线 / 电脑在线 / 系统TTS） ---------------- */
let voiceTab = "";
const voiceSheetOpen = () => !$("#voiceSheet").classList.contains("hidden");

function voiceTabs() {
  const tabs = [];
  if (androidTts()) tabs.push("builtin");   // 内置 Kokoro（随 APK 打包，离线可用）
  if (volcanoConfigured()) tabs.push("volcano"); // 豆包同源（火山引擎，需已配置 key）
  if (!LOCAL_MODE || serverAlive) tabs.push("online");
  if (nativeTTS()) tabs.push("system");
  return tabs;
}

async function loadVoices() {
  const grid = $("#voiceGrid");
  if (LOCAL_MODE) await checkServer();
  const tabs = voiceTabs();
  if (!tabs.length) {
    renderVoiceError("没有可用音色：在手机上安装本 App 即可使用内置离线音色", false);
    return;
  }
  if (!voiceTab || !tabs.includes(voiceTab)) voiceTab = tabs[0];
  const bar = $("#voiceTabs");
  bar.innerHTML = "";
  bar.style.display = tabs.length > 1 ? "" : "none"; // 单一来源时不显示分组标签
  tabs.forEach((t) => {
    const b = document.createElement("button");
    b.dataset.g = t;
    b.className = t === voiceTab ? "active" : "";
    b.textContent = t === "builtin" ? "内置 · 离线" : t === "volcano" ? "豆包" : t === "online" ? "在线" : "系统";
    b.addEventListener("click", () => { if (voiceTab !== t) { voiceTab = t; loadVoices(); } });
    bar.appendChild(b);
  });
  grid.dataset.loaded = "";
  renderVoiceTab();
}

function renderVoiceTab() {
  if (voiceTab === "builtin") return renderBuiltinVoices();
  if (voiceTab === "volcano") return renderVolcanoVoices();
  if (voiceTab === "system") return renderSystemVoices();
  return renderOnlineVoices();
}

/* 选定某个音色：统一写偏好 + 立即从当前句重播（马上听到新音色） */
function selectVoice(mode, id, btnEl) {
  if (mode === "online") prefs.voice = id;
  else if (mode === "system") prefs.nativeVoice = id;
  else if (mode === "builtin") prefs.builtinVoice = id;
  else if (mode === "volcano") prefs.volcanoVoice = id;
  prefs.voiceMode = mode; // 显式选择后不再自动切换来源
  S.mode = mode;
  S.audioCache.forEach((u) => URL.revokeObjectURL(u));
  S.audioCache.clear();
  if (S.pausedPos && mode === "online") {
    // 暂停中换在线音色：丢弃旧音色已缓冲的音频，恢复时重新合成
    S.pausedPos = null;
    haltAudioEl();
  }
  const grid = $("#voiceGrid");
  grid.querySelectorAll(".voice-item").forEach((x) => {
    x.classList.toggle("active", x === btnEl);
    x.querySelector(".v-check")?.remove();
  });
  btnEl?.insertAdjacentHTML("beforeend", CHECK_SVG);
  if (S.playing) playFrom(S.cur.ch, S.cur.p, S.cur.s || 0);
}

/* --- 内置音色清单：Kokoro 模型已子集化为 10 个精选音色（voices.bin 随 APK 打包，离线可用） --- */
const BUILTIN_GROUPS = [
  { label: "中文女声", list: [["晚晴", 0], ["知夏", 1], ["念安", 2], ["疏影", 3]] },
  { label: "中文男声", list: [["青山", 4], ["沉舟", 5], ["远山", 6]] },
  { label: "英文口音", list: [["美音女声 · 枫", 7], ["美音女声 · 阳", 8], ["英音女声 · 薇", 9]] },
];

function renderBuiltinVoices() {
  const grid = $("#voiceGrid");
  $("#voiceHint").textContent = "内置音色 · 离线可用 · 免费可商用";
  if (builtinState === "failed") {
    renderVoiceError("内置语音初始化失败：" + builtinErr + "。可点重试，或改用在线/系统音色", true);
    return;
  }
  if (builtinState !== "ready") {
    grid.innerHTML = '<div class="voice-loading">内置语音启动中…（首次需加载语音模型，稍等几秒）</div>';
    startBuiltinInit();
    waitBuiltinReady(30000).then((ok) => {
      if (ok && voiceSheetOpen() && voiceTab === "builtin") renderBuiltinVoices();
    });
    return;
  }
  grid.innerHTML = "";
  BUILTIN_GROUPS.forEach((g) => {
    const h = document.createElement("div");
    h.className = "voice-group";
    h.textContent = g.label;
    grid.appendChild(h);
    const items = g.list ? g.list : [];
    const n = g.list ? items.length : g.to - g.from + 1;
    for (let i = 0; i < n; i++) {
      const name = g.list ? items[i][0] : g.name(i);
      const sid = g.list ? items[i][1] : g.from + i;
      const b = document.createElement("button");
      const on = sid === prefs.builtinVoice;
      b.className = "voice-item" + (on ? " active" : "");
      b.innerHTML = `<span class="v-name">${esc(name)}</span><i class="v-try">试听</i>` + (on ? CHECK_SVG : "");
      b.addEventListener("click", (e) => {
        if (e.target.closest(".v-try")) { previewBuiltin(sid); return; }
        selectVoice("builtin", sid, b);
      });
      grid.appendChild(b);
    }
  });
  grid.dataset.loaded = "1";
}

/* --- 豆包同源音色清单（火山引擎 voice_type）+ 接入入口 --- */
function renderVolcanoVoices() {
  const grid = $("#voiceGrid");
  $("#voiceHint").textContent = "豆包同源音色 · 火山引擎 TTS · 在线可用";
  grid.innerHTML = "";
  VOLC_VOICES.forEach((v) => {
    const b = document.createElement("button");
    const on = v.id === prefs.volcanoVoice;
    b.className = "voice-item" + (on ? " active" : "");
    b.innerHTML = `<span class="v-name">${esc(v.name)}</span><i class="v-try">试听</i>` + (on ? CHECK_SVG : "");
    b.addEventListener("click", (e) => {
      if (e.target.closest(".v-try")) { previewVolcano(v.id); return; }
      prefs.volcanoVoice = v.id;
      selectVoice("volcano", v.id, b);
    });
    grid.appendChild(b);
  });
  const custom = document.createElement("div");
  custom.className = "volcano-custom";
  custom.innerHTML = `<input id="volcCustomId" placeholder="填入音色 ID（音色管理里复制）">
    <button id="volcCustomApply">应用</button>
    <button id="volcConfigBtn" class="volc-config-link">接入配置</button>`;
  grid.appendChild(custom);
  $("#volcCustomApply").addEventListener("click", () => {
    const id = $("#volcCustomId").value.trim();
    if (!id) { toast("先填入音色 ID"); return; }
    prefs.volcanoVoice = id;
    selectVoice("volcano", id, null);
    renderVolcanoVoices();
  });
  $("#volcConfigBtn").addEventListener("click", openVolcanoSheet);
  grid.dataset.loaded = "1";
}

async function previewVolcano(voiceId) {
  if (S.playing) pauseListening();
  try {
    const saveVoice = prefs.volcanoVoice;
    prefs.volcanoVoice = voiceId;
    const url = await volcanoSynthesize("你好，这是豆包同源音色试听。");
    prefs.volcanoVoice = saveVoice;
    haltAudioEl();
    audio.src = url;
    await audio.play();
  } catch (e) { toast("试听失败：" + (e.message || e), 3200); }
}

function openVolcanoSheet() {
  $("#volcAppIdInput").value = prefs.volcanoAppId;
  $("#volcTokenInput").value = prefs.volcanoToken;
  $("#volcanoSheet").classList.remove("hidden");
  $("#volcanoMask").classList.remove("hidden");
}
function closeVolcanoSheet() {
  $("#volcanoSheet").classList.add("hidden");
  $("#volcanoMask").classList.add("hidden");
}
$("#volcanoMask").addEventListener("click", closeVolcanoSheet);
$("#volcClose").addEventListener("click", closeVolcanoSheet);
$("#volcSave").addEventListener("click", () => {
  const appid = $("#volcAppIdInput").value.trim();
  const token = $("#volcTokenInput").value.trim();
  if (!appid || !token) { toast("AppID 和 Token 都要填写"); return; }
  prefs.volcanoAppId = appid;
  prefs.volcanoToken = token;
  toast("豆包音色已启用");
  closeVolcanoSheet();
  voiceTab = "volcano";
  loadVoices();
});

/* --- 豆包音色清单结束 --- */

async function previewBuiltin(sid) {
  if (S.playing) pauseListening(); // 试听不与朗读混流
  const ok = await waitBuiltinReady(4000);
  if (!ok) {
    toast(builtinState === "failed" ? "内置语音不可用：" + builtinErr : "内置语音还在启动中，请稍候再试", 3000);
    return;
  }
  try {
    await builtinSpeak("你好，这是音色试听，愿好书常伴你身边。", sid, Math.max(0.5, Math.min(2, prefs.rate / 100)));
  } catch (e) { if (!e.stopped) toast("试听失败：" + (e.message || e), 3000); }
}

async function renderOnlineVoices() {
  const grid = $("#voiceGrid");
  $("#voiceHint").textContent = "电脑在线音色（微软 Edge 神经语音，需连接听书服务）";
  grid.innerHTML = '<div class="voice-loading">正在获取音色…</div>';
  try {
    const voices = await api(`${SERVER}/api/voices`);
    grid.innerHTML = "";
    if (!voices.length) { grid.innerHTML = '<div class="voice-loading">在线音色列表为空</div>'; return; }
    voices.forEach((v) => {
      const b = document.createElement("button");
      b.className = "voice-item" + (v.id === prefs.voice ? " active" : "");
      b.dataset.id = v.id;
      b.innerHTML = `<span class="v-name">${esc(VOICE_SHORT[v.id] || v.name)}</span>` + (v.id === prefs.voice ? CHECK_SVG : "");
      b.addEventListener("click", () => selectVoice("online", v.id, b));
      grid.appendChild(b);
    });
    grid.dataset.loaded = "1";
  } catch (e) { renderVoiceError("获取失败：" + (e.message || e), true); }
}

async function renderSystemVoices() {
  const grid = $("#voiceGrid");
  const list = await nativeVoices();
  if (!list) { renderVoiceError("未检测到语音插件（仅原生 App 内可用）", true); return; }
  const zh = list.filter((v) => String(v.lang || "").toLowerCase().startsWith("zh"));
  const pool = zh.length ? zh : list;
  if (!pool.length) {
    renderVoiceError("手机系统没有返回可用音色（TTS 引擎未就绪或未安装中文语音）。建议直接使用上方「内置 · 离线」音色", true);
    return;
  }
  $("#voiceHint").textContent = `系统音色 · ${pool.length} 个（离线）`;
  grid.innerHTML = "";
  pool.forEach((v) => {
    const b = document.createElement("button");
    b.className = "voice-item" + (v.name === prefs.nativeVoice ? " active" : "");
    b.innerHTML = `<span class="v-name">${esc(voiceLabel(v))}</span><i class="v-try">试听</i>` + (v.name === prefs.nativeVoice ? CHECK_SVG : "");
    b.title = `${v.name} (${v.lang})`;
    const vidx = list.indexOf(v);
    b.addEventListener("click", (e) => {
      if (e.target.closest(".v-try")) { previewSystem(v, vidx); return; }
      selectVoice("system", v.name, b);
    });
    grid.appendChild(b);
  });
  grid.dataset.loaded = "1";
}

async function previewSystem(v, vidx) {
  if (S.playing) pauseListening();
  try {
    await nativeTTS().speak({
      text: "你好，这是音色试听。",
      lang: v.lang || "zh-CN",
      rate: Math.max(0.5, Math.min(2, prefs.rate / 100)),
      pitch: 1,
      ...(vidx >= 0 ? { voice: vidx } : {}),
    });
  } catch (e) { toast("试听失败：" + (e.message || e), 3000); }
}

function renderVoiceError(reason, withRetry) {
  const grid = $("#voiceGrid");
  grid.dataset.loaded = "";
  $("#voiceHint").textContent = "";
  grid.innerHTML = `<div class="voice-loading">${esc(reason)}</div>` +
    (withRetry ? '<button class="voice-retry" id="voiceRetryBtn">重新获取</button>' : "");
  $("#voiceRetryBtn")?.addEventListener("click", () => {
    nativeVoiceList = null;
    serverCheckedAt = 0;
    builtinState = "none"; builtinErr = "";
    loadVoices();
  });
}
function closeVoice() { $("#voiceSheet").classList.add("hidden"); $("#voiceMask").classList.add("hidden"); }
$("#voiceMask").addEventListener("click", closeVoice);

$("#btnListen").addEventListener("click", async () => {
  toggleMenu(false);
  // 从当前页第一个段落开始读（番茄式体验），而不是上次播放位置
  playFrom(S.cur.ch, firstVisiblePara());
  togglePlayerSheet(true);
});
$("#rateRange").addEventListener("input", (e) => { $("#rateLabel").textContent = (+e.target.value / 100).toFixed(1) + "x"; });
$("#rateRange").addEventListener("change", (e) => {
  prefs.rate = +e.target.value;
  // 清掉旧语速的预取音频，并从当前句立即按新语速重播
  S.audioCache.forEach((u) => URL.revokeObjectURL(u));
  S.audioCache.clear();
  if (S.playing) playFrom(S.cur.ch, S.cur.p, S.cur.s || 0);
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

/* 自定义分钟定时 */
$("#timerCustomBtn").addEventListener("click", () => {
  const mins = Math.round(+$("#timerCustomMin").value);
  if (!mins || mins < 1 || mins > 720) { toast("请输入 1~720 分钟"); return; }
  document.querySelectorAll("#timerChips button").forEach((x) => x.classList.toggle("active", x.dataset.min === "0"));
  document.querySelectorAll("#chapterChips button").forEach((x) => x.classList.toggle("active", x.dataset.ch === "0"));
  clearInterval(timerTick); timerTick = null;
  S.timerChapters = 0; S.chaptersDone = 0;
  S.timerEnd = Date.now() + mins * 60000;
  const tick = () => {
    const left = S.timerEnd - Date.now();
    if (left <= 0) { stopPlay(); toast("定时时间到，已停止听书"); return; }
    if (S.playing) $("#playerSub").textContent = timerStatusText();
  };
  tick();
  timerTick = setInterval(tick, 1000);
  toast(`将在 ${mins} 分钟后停止听书`);
  closeTimerSheet();
});

/* 逐句高亮：音频流按字符占比映射；手动翻页后暂停自动跟随（点高亮句跳回） */
function updateSegHighlight(p, ratio) {
  const segs = S.chapter.segs[p] || [];
  const total = segs.reduce((s, x) => s + x.length, 0) || 1;
  let acc = 0, idx = 0;
  for (let i = 0; i < segs.length; i++) {
    acc += segs[i].length;
    if (ratio <= acc / total) { idx = i; break; }
    idx = i;
  }
  highlightSeg(p, idx);
  return idx;
}
/* 直接高亮指定句（按句朗读用），跟随模式才翻页 */
function highlightSeg(p, s) {
  track.querySelectorAll(".seg.on").forEach((el) => el.classList.remove("on"));
  const el = track.querySelector(`.seg[data-p="${p}"][data-s="${s}"]`);
  updateParaSlider();
  if (!el) return;
  if (S.follow !== false) flipToElement(el);
  el.classList.add("on");
}

/* 播放面板：本章句进度 */
function updateParaSlider() {
  if (!S.chapter) return;
  const slider = $("#paraSlider");
  if (!slider) return;
  let idx = 0, total = 0;
  S.chapter.segs.forEach((segs, pi) => {
    segs.forEach((t, si) => {
      if (pi < S.cur.p || (pi === S.cur.p && si < (S.cur.s || 0))) idx++;
      total++;
    });
  });
  const pos = Math.min(total, idx + 1);
  slider.max = total;
  slider.value = pos;
  $("#paraPos").textContent = `本章 ${pos}/${total} 句`;
  $("#paraMode").textContent = { builtin: "内置离线", volcano: "豆包", online: "在线", system: "系统" }[S.mode] || "";
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
  updateMediaState();
  if ("mediaSession" in navigator) navigator.mediaSession.playbackState = v ? "playing" : "paused";
}

/* 听书悬浮球：听书时 / 阅读菜单呼出时显示（面板打开时隐藏，避免重叠） */
function updateBall() {
  const sheetOpen = !$("#playerSheet").classList.contains("hidden");
  // 悬浮球只在呼出菜单时显示（听书时收起面板后也不常驻，避免遮挡正文）
  const show = !!S.book && !sheetOpen && S.menuOpen;
  $("#listenBall").classList.toggle("hidden", !show);
  $("#listenBall").classList.toggle("live", !!S.playing);
  syncVolumePage();
}

/* 音量键翻页（番茄式）：纯阅读（未听书、无弹层）时音量键=翻页，其余情况还原为调音量。
   开关同步给原生侧（MainActivity.dispatchKeyEvent 消费按键） */
function syncVolumePage() {
  const quiet = !!S.book && !S.playing && !S.pausedPos && !S.menuOpen
    && $("#toc").classList.contains("hidden");
  try { androidTts()?.setVolumePage?.(quiet); } catch {}
}
window.__szVolumeKey = (dir) => {
  if (!S.book || S.playing) return;
  if (dir > 0) flipNext(); else flipPrev();
};
function togglePlayerSheet(force) {
  const sheet = $("#playerSheet");
  const open = force !== undefined ? force : sheet.classList.contains("hidden");
  sheet.classList.toggle("hidden", !open);
  updateBall();
}

async function getAudio(ch, p) {
  const key = `${ch}:${p}:${prefs.rate}:${prefs.voice}`; // 缓存键含语速+音色：切换设置后不再命中旧音频
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

/* ---------------- 音色链路选择 ----------------
   显式选择优先；不可用时按 内置离线 → 豆包(已配置) → 电脑在线 → 系统TTS 自动降级 */
const volcanoConfigured = () => !!(prefs.volcanoAppId && prefs.volcanoToken);

async function resolveVoiceMode() {
  let m = prefs.voiceMode;
  if (m === "builtin" && !androidTts()) m = "";
  if (m === "system" && !nativeTTS()) m = "";
  if (m === "volcano" && !volcanoConfigured()) m = "";
  if (m === "online" && LOCAL_MODE) {
    await checkServer();
    if (!serverAlive) m = "";
  }
  if (m) return m;
  // 自动：优先内置离线语音（随 App 打包，任何手机可用，不依赖网络）
  if (androidTts()) {
    if (builtinState === "ready") return "builtin";
    if (builtinState === "none") startBuiltinInit();
    if (builtinState !== "failed") {
      toast("内置语音启动中…");
      if (await waitBuiltinReady(8000)) return "builtin";
    }
  }
  if (volcanoConfigured()) return "volcano";
  if (!LOCAL_MODE) return "online";
  await checkServer();
  if (serverAlive) return "online";
  if (nativeTTS()) return "system";
  return "online"; // 无可用离线链路时仍走在线，让播放链给出明确报错
}

async function playFrom(ch, p, s = 0) {
  if (!S.book) return;
  autoStop(true); // 听书接管节奏，停止自动阅读
  const token = ++S.playToken;
  const mode = await resolveVoiceMode();
  if (token !== S.playToken) return;
  S.mode = mode;
  if (ch !== S.cur.ch) await loadChapter(ch, p);
  S.cur = { ch, p, s };
  S.pausedPos = null;
  S.follow = true; // 新一次播放默认跟随高亮翻页
  saveProgressNow();
  setPlayingUI(true);
  if (mode === "builtin" || mode === "system") {
    haltAudioEl(); // 切到离线链路：停掉可能在播的在线音频流
    const speakSeg = mode === "builtin"
      ? (text) => builtinSpeak(text, +prefs.builtinVoice, Math.max(0.5, Math.min(2, prefs.rate / 100)))
      : speakSystemSeg;
    const failTip = mode === "builtin"
      ? "内置语音连续朗读失败。可重进应用重试，或在「音色」里改用在线/系统音色。"
      : "手机语音引擎连续朗读失败。可能未安装中文语音数据：请到 系统设置 → 更多设置 → 语言与输入 → 文字转语音(TTS) 检查；或改用「内置 · 离线」音色。";
    return sentenceChain(ch, p, s, token, speakSeg, failTip);
  }
  haltBuiltin(); haltSystem(); // 切到在线链路：停掉离线朗读
  const getUrl = mode === "volcano" ? getVolcanoAudio : getAudio;
  try {
    const url = await getUrl(ch, p);
    if (token !== S.playToken) return;
    audio.src = url;
    await audio.play();
    S.synthFails = 0;
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
    S.synthFails = (S.synthFails || 0) + 1;
    if (S.synthFails >= 3) {
      // 在线合成连续失败：自动降级到可用的离线语音继续读（每轮播放只降级一次，防循环）
      if (!S.onlineFallbackDone && (androidTts() || nativeTTS())) {
        S.onlineFallbackDone = true;
        serverCheckedAt = 0; // 强制重探服务器，让自动选择避开在线
        if (prefs.voiceMode === "online" || prefs.voiceMode === "volcano") prefs.voiceMode = "";
        toast("在线语音不可用，已自动切换离线语音");
        return playFrom(S.cur.ch, S.cur.p, S.cur.s || 0);
      }
      stopPlay();
      showBookError(mode === "volcano"
        ? "豆包音色（火山引擎）连续合成失败。请检查：AppID/Token 是否填写正确、账户是否有免费额度、网络是否可用。"
        : "在线语音合成连续失败。请确认：家里电脑已开机并运行听书服务、手机与电脑连同一网络；或在「音色」里改用内置离线音色（无需网络）。");
      return;
    }
    toast("合成失败，2 秒后跳到下一段");
    setTimeout(() => { if (token === S.playToken) nextPara(); }, 2000);
  }
}

/* 系统 TTS 读一句（所选音色失败时弃用音色重试一句） */
async function speakSystemSeg(text) {
  const opts = { text, lang: "zh-CN", rate: Math.max(0.5, Math.min(2, prefs.rate / 100)), pitch: 1 };
  const list = await nativeVoices();
  let vidx = -1;
  if (list && prefs.nativeVoice) {
    vidx = list.findIndex((v) => v.name === prefs.nativeVoice);
    if (vidx >= 0) opts.voice = vidx;
  }
  try {
    await nativeTTS().speak(opts);
  } catch (e) {
    if (vidx < 0) throw e;
    // 所选音色导致朗读失败：清除选择，用系统默认音色重试这句
    prefs.nativeVoice = "";
    delete opts.voice;
    await nativeTTS().speak(opts);
  }
}

/* 计算下一句文本（供原生层预合成：播当前句时后台生成下一句，消除句间停顿） */
function nextSentenceText(ch, p, s) {
  const segs = S.chapter && ch === S.cur.ch ? S.chapter.segs[p] : null;
  if (segs && s + 1 < segs.length) return segs[s + 1];
  if (S.chapter && ch === S.cur.ch && p + 1 < S.chapter.paras.length) return S.chapter.segs[p + 1]?.[0] || "";
  const nxt = S.chapterCache.get(ch + 1);
  return nxt ? (nxt.paras[0] ? splitSegs(nxt.paras[0])[0] : "") : "";
}

/* 离线链路（内置语音/系统TTS 共用）：按句朗读，句子短，暂停/关闭立即生效。
   连续失败 3 次停止并给出原因——绝不无限跳句 */
async function sentenceChain(ch, p, s, token, speakSeg, failTip) {
  let fails = 0, lastErr = "";
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
    if (!text) { s++; continue; }
    S.cur = { ch, p, s };
    highlightSeg(p, s);
    // 内置语音：把下一句丢给原生层预合成（在播当前句的间隙完成，句间零等待）
    if (S.mode === "builtin") {
      const nx = nextSentenceText(ch, p, s);
      if (nx) try { androidTts().prefetch(nx, +prefs.builtinVoice, Math.max(0.5, Math.min(2, prefs.rate / 100))); } catch {}
    }
    let spoke = false;
    try {
      await speakSeg(text);
      spoke = true;
    } catch (e) {
      if (e && e.stopped) return; // 被 stop()/pause() 打断：安静退出
      lastErr = (e && e.message) || String(e);
    }
    if (token !== S.playToken) return;
    if (!spoke) {
      fails++;
      if (fails >= 3) {
        stopPlay();
        showBookError(failTip + (lastErr ? "（" + lastErr + "）" : ""));
        return;
      }
      await new Promise((r) => setTimeout(r, 300));
      s++; // 跳过失败句继续，连续失败达上限即停止
      if (s >= (S.chapter?.segs[p]?.length || 0)) { p++; s = 0; }
      continue;
    }
    fails = 0;
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
    const getUrl = S.mode === "volcano" ? getVolcanoAudio : getAudio;
    const tasks = [];
    if (p + 1 < (S.chapter?.paras.length || 0)) tasks.push(getUrl(ch, p + 1));
    if (p + 2 < (S.chapter?.paras.length || 0)) tasks.push(getUrl(ch, p + 2));
    if (p + 2 >= (S.chapter?.paras.length || 0) && ch + 1 < S.book.chapters.length) {
      await getUrl(ch + 1, 0).catch(() => {});
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

/* 暂停：离线链路立即停当前句并记住位置；在线链路暂停音频流 */
function pauseListening() {
  S.pausedPos = { ...S.cur };
  S.playToken++;
  if (S.mode === "builtin") haltBuiltin();
  else if (S.mode === "system") haltSystem();
  else { try { audio.pause(); } catch {} }
  setPlayingUI(false);
}
function resumeListening() {
  const token = ++S.playToken;
  if (S.mode === "builtin" || S.mode === "system") {
    const pos = S.pausedPos || S.cur;
    S.pausedPos = null;
    setPlayingUI(true);
    const speakSeg = S.mode === "builtin"
      ? (text) => builtinSpeak(text, +prefs.builtinVoice, Math.max(0.5, Math.min(2, prefs.rate / 100)))
      : speakSystemSeg;
    const failTip = S.mode === "builtin"
      ? "内置语音连续朗读失败。可重进应用重试，或在「音色」里改用在线/系统音色。"
      : "手机语音引擎连续朗读失败。可能未安装中文语音数据：请到 系统设置 → 更多设置 → 语言与输入 → 文字转语音(TTS) 检查；或改用「内置 · 离线」音色。";
    return sentenceChain(pos.ch, pos.p, pos.s || 0, token, speakSeg, failTip);
  }
  if (audio.src && audio.paused) { setPlayingUI(true); audio.play().catch(() => {}); return; }
  playFrom(S.cur.ch, S.cur.p || 0);
}

function stopPlay() {
  S.playToken++; // 作废所有 pending 的播放链（含 AbortError 重试）
  setPlayingUI(false);
  haltAudioEl();
  haltBuiltin();   // 关键：停掉内置语音引擎，否则手机上声音关不掉
  haltSystem();    // 关键：停掉系统语音引擎，否则手机上声音关不掉
  track.querySelectorAll(".seg.on").forEach((el) => el.classList.remove("on")); // 关闭听书后取消正文高亮
  clearInterval(timerTick); timerTick = null;
  S.timerEnd = 0; S.timerChapters = 0; S.chaptersDone = 0; S.pausedPos = null; // 手动停止同时取消定时
  S.onlineFallbackDone = false; // 下一轮播放允许再次自动降级
  S.mode = null;
  document.querySelectorAll("#timerChips button").forEach((x) => x.classList.toggle("active", x.dataset.min === "0"));
  document.querySelectorAll("#chapterChips button").forEach((x) => x.classList.toggle("active", x.dataset.ch === "0"));
  $("#playerSub").textContent = "听书中";
  syncVolumePage(); // pausedPos 已清空：纯阅读状态音量键恢复为翻页
}

$("#btnPlayToggle").addEventListener("click", () => {
  if (S.playing) pauseListening(); else resumeListening();
});
// ✕ = 只收起面板：听书不受影响，开关只由播放键控制（悬浮球可随时唤回）
$("#btnClosePlayer").addEventListener("click", () => {
  togglePlayerSheet(false);
});
// 点面板外空白 = 同样只收起面板
$("#playerMask").addEventListener("click", () => {
  togglePlayerSheet(false);
});
$("#btnNextPara").addEventListener("click", () => nextPara());
$("#btnPrevPara").addEventListener("click", () => prevPara());

/* 听书悬浮球：未播放时点击=从当前页开始听；播放中点击=展开/收起操作面板 */
$("#listenBall").addEventListener("click", () => {
  if (!S.playing && !S.pausedPos) {
    playFrom(S.cur.ch, firstVisiblePara());
    togglePlayerSheet(true);
  } else {
    togglePlayerSheet();
  }
});
function openPlayerSheet() { togglePlayerSheet(true); }
function openVoiceSheet() { loadVoices().catch(() => {}); $("#voiceSheet").classList.remove("hidden"); $("#voiceMask").classList.remove("hidden"); }
function openRateSheet() { $("#rateSheet").classList.remove("hidden"); $("#rateMask").classList.remove("hidden"); }
function openTimerSheet() { $("#timerSheet").classList.remove("hidden"); $("#timerMask").classList.remove("hidden"); }
function closeRateSheet() { $("#rateSheet").classList.add("hidden"); $("#rateMask").classList.add("hidden"); }
function closeTimerSheet() { $("#timerSheet").classList.add("hidden"); $("#timerMask").classList.add("hidden"); }
$("#btnVoice").addEventListener("click", openVoiceSheet);
$("#psRate").addEventListener("click", openRateSheet);
$("#psTimer").addEventListener("click", openTimerSheet);
$("#rateMask").addEventListener("click", closeRateSheet);
$("#timerMask").addEventListener("click", closeTimerSheet);

/* 锁屏/通知栏媒体卡片：元数据 + 原生通知桥 */
function updateMediaState() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: S.chapter?.title || "听书中",
      artist: S.book?.name || "书斋",
      album: "书斋",
    });
  } catch {}
  try { window.AndroidMedia?.set?.(S.book?.name || "书斋", S.chapter?.title || "", S.playing); } catch {}
}
window.__szMedia = (action) => {
  if (!S.book) return;
  if (action === "play") resumeListening();
  else if (action === "pause") pauseListening();
  else if (action === "next") nextPara();
  else if (action === "prev") prevPara();
};
try { window.AndroidMedia?.hide?.(); } catch {}

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
  if (!$("#volcanoSheet").classList.contains("hidden")) { closeVolcanoSheet(); return true; }
  if (!$("#voiceSheet").classList.contains("hidden")) { closeVoice(); return true; }
  if (!$("#rateSheet").classList.contains("hidden")) { closeRateSheet(); return true; }
  if (!$("#timerSheet").classList.contains("hidden")) { closeTimerSheet(); return true; }
  if (!$("#playerSheet").classList.contains("hidden")) { togglePlayerSheet(false); return true; }
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
renderAutoUI();
renderReadStat();
$("#rateRange").value = prefs.rate;
$("#rateLabel").textContent = (prefs.rate / 100).toFixed(1) + "x";
if (LOCAL_MODE) checkServer();      // 后台预探测家里电脑，不阻塞首次听书
if (androidTts()) startBuiltinInit(); // 预热内置离线语音引擎，首次点听书几乎秒开
if (nativeTTS()?.getVoices) nativeVoices(); // 预热系统 TTS 引擎，首次开播更快
loadShelf();

// 诊断模式：连点 5 下版本号，弹出设备真实状态（用于远程排查）
let verTaps = 0, verTimer = null;
document.querySelector(".topbar h1 .ver").addEventListener("click", () => {
  verTaps++;
  clearTimeout(verTimer);
  verTimer = setTimeout(() => { verTaps = 0; }, 1600);
  if (verTaps >= 5) { verTaps = 0; showDiagnostics(); }
});
async function showDiagnostics() {
  const nv = await nativeVoices();
  const rt = document.querySelector(".reader-top");
  const cs = rt ? getComputedStyle(rt) : null;
  const info = [
    "版本: " + (document.querySelector(".topbar h1 .ver")?.textContent || "?"),
    "WebView: " + navigator.userAgent.slice(-70),
    "阅读主题: " + (document.getElementById("reader").dataset.theme || "未设置"),
    "顶栏背景: " + (cs ? cs.backgroundColor : "元素缺失"),
    "顶栏层叠: z=" + (cs ? cs.zIndex : "?"),
    "本地模式: " + LOCAL_MODE + " · 在线: " + serverAlive,
    "内置语音: " + (androidTts() ? builtinState + (builtinState === "failed" ? "（" + builtinErr + "）" : "") + " · 音色sid: " + prefs.builtinVoice : "桥不存在（非本APK或老版本）"),
    "音色来源: " + (prefs.voiceMode || "自动") + " · 当前链路: " + (S.mode || "-"),
    "TTS插件: " + (nativeTTS() ? "有" : "无") +
      (nativeTTS() ? " · 方法: " + (nativeTTS().getSupportedVoices ? "getSupportedVoices" : (nativeTTS().getVoices ? "getVoices" : "无音色方法")) : ""),
    "系统音色数: " + (nv ? nv.length : "未获取"),
    "音色列表: " + (nv && nv.length ? nv.slice(0, 3).map(voiceLabel).join(", ") + "…" : (nv ? "空" : "-")),
    "通知权限提示: 锁屏卡片需在系统设置允许本应用通知",
    "悬浮球位置: " + (document.getElementById("listenBall") ? getComputedStyle(document.getElementById("listenBall")).bottom + " z" + getComputedStyle(document.getElementById("listenBall")).zIndex : "-"),
  ].join("\n");
  $("#errMsg").textContent = info;
  $("#errPanel").classList.remove("hidden");
}

// 调试/自动化测试钩子
window.__sz = { playFrom, goToPage, flipNext, flipPrev, toggleMenu, gotoChapter, pauseListening, resumeListening, autoStart, autoStop, coverFlip, scrollFlip, prefs, state: S, audio };
