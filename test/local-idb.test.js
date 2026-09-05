/* local.js IndexedDB 适配层回归测试
   复现 v1.0 App 内白屏根因：tx() 对缺失键把 IDBRequest 对象当结果 resolve，
   导致 openBook 读到垃圾 progress → 章节号变 NaN → 白屏。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createLocalAdapter } = require("../public/local.js");

/* 极简 IndexedDB 形状模拟：只实现适配层用到的子集。
   语义与真机一致：请求结果异步填充，事务在全部请求完成后 complete。
   用微任务计数保证「先请求成功、后事务完成」的确定性顺序（定时器在负载下会合并失序）。 */
function makeIndexedDB() {
  class Request {
    constructor(tx) { this.tx = tx; this.result = undefined; this.onsuccess = null; this.onerror = null; }
    _finish(value) {
      queueMicrotask(() => {
        this.result = value;
        if (this.onsuccess) this.onsuccess();
        this.tx._requestDone();
      });
    }
  }

  class Store {
    constructor(records, tx) { this.records = records; this.tx = tx; }
    get(key) {
      const req = this.tx.track(new Request(this.tx));
      req._finish(this.records.has(key) ? structuredClone(this.records.get(key)) : undefined);
      return req;
    }
    getAll() {
      const req = this.tx.track(new Request(this.tx));
      req._finish([...this.records.values()].map((v) => structuredClone(v)));
      return req;
    }
    put(value, key) {
      const req = this.tx.track(new Request(this.tx));
      const k = key !== undefined ? key : value.id;
      this.records.set(k, structuredClone(value));
      req._finish(k);
      return req;
    }
    delete(key) {
      const req = this.tx.track(new Request(this.tx));
      req._finish(this.records.delete(key));
      return req;
    }
  }

  class Transaction {
    constructor(store) { this.store = new Store(store, this); this.pending = 0; this.completeQueued = false; }
    track(req) { this.pending++; return req; }
    _requestDone() {
      this.pending--;
      if (this.pending === 0 && !this.completeQueued) {
        this.completeQueued = true;
        queueMicrotask(() => { if (this.oncomplete) this.oncomplete(); });
      }
    }
    objectStore() { return this.store; }
  }

  class DB {
    constructor(name) { this.name = name; this.stores = new Map(); }
    createObjectStore(name, opts) {
      this.stores.set(name, new Map());
      if (opts && opts.keyPath) this.stores.get(name).keyPath = opts.keyPath;
    }
    get objectStoreNames() {
      const self = this;
      return { contains: (n) => self.stores.has(n) };
    }
    transaction(name) {
      return new Transaction(this.stores.get(name));
    }
    close() {}
  }

  return {
    open(name) {
      const req = new Request({ pending: 0, _requestDone() {} });
      setTimeout(() => {
        if (db.stores.size === 0) { db.createObjectStore("b"); db.createObjectStore("m"); }
        if (req.onsuccess) req.onsuccess();
      }, 0);
      const db = new DB(name);
      req.result = db;
      return req;
    },
  };
}

const SAMPLE = "第一章 开端\n少年出门远行。\n\n第二章 遇师\n山中遇一老者。\n";

test("未保存进度的书，progress 必须是 null 而不是垃圾对象", async () => {
  const L = createLocalAdapter(makeIndexedDB());
  await L.importBook("回归书", SAMPLE);
  const books = await L.listBooks();
  assert.strictEqual(books.length, 1);
  assert.strictEqual(books[0].progress, null);
});

test("getBook 对未保存进度的书返回 progress=null（白屏回归）", async () => {
  const L = createLocalAdapter(makeIndexedDB());
  const { id } = await L.importBook("回归书", SAMPLE);
  const meta = await L.getBook(id);
  assert.strictEqual(meta.progress, null);
});

test("导入后能立即读到第一章内容（App 白屏回归）", async () => {
  const L = createLocalAdapter(makeIndexedDB());
  const { id } = await L.importBook("回归书", SAMPLE);
  const ch = await L.getChapter(id, 0);
  assert.strictEqual(ch.title, "第一章 开端");
  assert.ok(ch.paras.length >= 1, "第一章应有段落");
});

test("保存进度后再读取，progress 为真实值", async () => {
  const L = createLocalAdapter(makeIndexedDB());
  const { id } = await L.importBook("回归书", SAMPLE);
  await L.saveProgress(id, 1, 0);
  const meta = await L.getBook(id);
  assert.deepStrictEqual(
    { chapter: meta.progress.chapter, para: meta.progress.para },
    { chapter: 1, para: 0 },
  );
});

test("getChapter 对不存在书籍抛出明确错误", async () => {
  const L = createLocalAdapter(makeIndexedDB());
  await assert.rejects(() => L.getChapter("no-such-id", 0), /书籍不存在|章节不存在/);
});
