/* local.js IndexedDB 适配层回归测试
   复现 v1.0 App 内白屏根因：tx() 对缺失键把 IDBRequest 对象当结果 resolve，
   导致 openBook 读到垃圾 progress → 章节号变 NaN → 白屏。 */
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { createLocalAdapter } = require("../public/local.js");

/* 极简 IndexedDB 形状模拟：只实现适配层用到的子集。
   语义与真机一致：请求结果异步填充，事务在请求完成后 complete。 */
function makeIndexedDB() {
  const dbs = new Map();

  class Request {
    constructor() { this.result = undefined; this.onsuccess = null; this.onerror = null; }
    _finish(value) {
      setTimeout(() => { this.result = value; if (this.onsuccess) this.onsuccess(); }, 0);
    }
  }

  class Store {
    constructor(records) { this.records = records; }
    get(key) {
      const req = new Request();
      req._finish(this.records.has(key) ? structuredClone(this.records.get(key)) : undefined);
      return req;
    }
    getAll() {
      const req = new Request();
      req._finish([...this.records.values()].map((v) => structuredClone(v)));
      return req;
    }
    put(value, key) {
      const req = new Request();
      const k = key !== undefined ? key : value.id;
      this.records.set(k, structuredClone(value));
      req._finish(k);
      return req;
    }
    delete(key) {
      const req = new Request();
      req._finish(this.records.delete(key));
      return req;
    }
  }

  class Transaction {
    constructor(store) { this.store = new Store(store); }
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
      const t = new Transaction(this.stores.get(name));
      // Node 的 setTimeout(0) 会被钳到 1ms，用 2ms 保证 complete 晚于请求完成，
      // 与真实 IndexedDB「先请求成功、后事务完成」的语义一致。
      setTimeout(() => { if (t.oncomplete) t.oncomplete(); }, 2);
      return t;
    }
    close() {}
  }

  return {
    open(name) {
      const req = new Request();
      setTimeout(() => {
        if (db.stores.size === 0) { db.createObjectStore("b"); db.createObjectStore("m"); }
        if (req.onsuccess) req.onsuccess();
      }, 0);
      const db = new DB(name);
      dbs.set(name, db);
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
