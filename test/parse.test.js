const { test } = require("node:test");
const assert = require("node:assert");
const { parseChapters, splitParagraphs } = require("../lib/parse");
const { decodeText } = require("../lib/encoding");

test("识别「第X章」章节并正确分段", () => {
  const txt = [
    "第一章 初入都市",
    "夜色像一块浸了水的绒布。",
    "李默拖着行李箱走出火车站。",
    "",
    "第二章 故人重逢",
    "第二天清晨，李默被楼下的早点摊香味叫醒。",
  ].join("\n");
  const chapters = parseChapters(txt);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "第一章 初入都市");
  assert.equal(chapters[1].title, "第二章 故人重逢");
  assert.deepEqual(splitParagraphs(chapters[0].body), ["夜色像一块浸了水的绒布。", "李默拖着行李箱走出火车站。"]);
});

test("识别序章/楔子/番外等特殊标题", () => {
  const txt = "序章\n一切的开始。\n第一章 正篇\n正文内容。\n番外一 彩蛋\n彩蛋内容。";
  const chapters = parseChapters(txt);
  assert.deepEqual(chapters.map((c) => c.title), ["序章", "第一章 正篇", "番外一 彩蛋"]);
});

test("无章节标记时按长度切段", () => {
  const txt = Array.from({ length: 600 }, (_, i) => `段落${i}，` + "内容".repeat(10)).join("\n");
  const chapters = parseChapters(txt);
  assert.ok(chapters.length > 1, "应切为多段");
  assert.equal(chapters[0].title, "第1部分");
  const total = chapters.reduce((s, c) => s + c.body.length, 0);
  assert.ok(Math.abs(total - txt.length) < 50, "切段不应丢失文本");
});

test("CRLF 与全角空格标题不影响解析", () => {
  const txt = "第一章　测试\r\n内容一。\r\n\r\n第二章 测试\r\n内容二。";
  const chapters = parseChapters(txt);
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].title, "第一章　测试");
});

test("GBK 编码文本自动识别并转 UTF-8", () => {
  const iconv = require("iconv-lite");
  const gbk = iconv.encode("第一章 试炼\n风起于青萍之末。", "gbk");
  const { text, encoding } = decodeText(gbk);
  assert.equal(encoding, "gb18030");
  assert.ok(text.includes("风起于青萍之末"));
});

test("UTF-8 文本原样通过", () => {
  const { text, encoding } = decodeText(Buffer.from("第二章 平静\n你好", "utf8"));
  assert.equal(encoding, "utf-8");
  assert.ok(text.includes("平静"));
});

test("splitParagraphs 过滤空段与多余空白", () => {
  assert.deepEqual(splitParagraphs("  a \n\n\n b\n\n   \n c "), ["a", "b", "c"]);
});
