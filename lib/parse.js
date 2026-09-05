// 章节识别与段落切分
const CHAPTER_RE =
  /^\s*(第\s*[0-9零〇一二两三四五六七八九十百千万]+\s*[章回节卷部集篇][^\n]{0,40}|Chapter\s+\d+[^\n]{0,40}|(序章|楔子|引子|尾声|后记)(\s\S{0,30})?|番外\S{0,10}(\s\S{0,30})?)\s*$/i;

function parseChapters(fullText) {
  const lines = fullText.replace(/\r\n?/g, "\n").split("\n");
  const chapters = [];
  let title = null;
  let body = [];
  const push = () => {
    if (title !== null && body.join("\n").trim()) chapters.push({ title, body: body.join("\n") });
  };
  for (const line of lines) {
    if (CHAPTER_RE.test(line)) {
      push();
      title = line.trim();
      body = [];
    } else if (title !== null) {
      body.push(line);
    }
  }
  push();

  if (chapters.length === 0) {
    // 无章节标记：按 ~12000 字切段，尽量断在换行处
    const total = fullText.replace(/\r\n?/g, "\n").trim();
    const size = 12000;
    let idx = 0;
    let n = 0;
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

function splitParagraphs(body) {
  return body
    .split(/\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

module.exports = { parseChapters, splitParagraphs, CHAPTER_RE };
