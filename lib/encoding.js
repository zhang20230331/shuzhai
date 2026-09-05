// TXT 编码识别：UTF-8 严格解码失败则按 GB18030（兼容 GBK/GB2312）
const iconv = require("iconv-lite");

function decodeText(buf) {
  if (!(buf instanceof Buffer)) buf = Buffer.from(buf);
  // BOM 处理
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.slice(3).toString("utf8"), encoding: "utf-8" };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: iconv.decode(buf.slice(2), "utf-16le"), encoding: "utf-16le" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return { text, encoding: "utf-8" };
  } catch {
    return { text: iconv.decode(buf, "gb18030"), encoding: "gb18030" };
  }
}

module.exports = { decodeText };
