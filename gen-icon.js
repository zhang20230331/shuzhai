// 生成应用图标 PNG（渐变圆角底 + 白色播放三角），纯 Node 无依赖
const zlib = require("zlib");
const fs = require("fs");

function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function inRoundRect(x, y, s, r) {
  if (x < 0 || y < 0 || x >= s || y >= s) return false;
  const cx = Math.max(r, Math.min(s - 1 - r, x));
  const cy = Math.max(r, Math.min(s - 1 - r, y));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= r && x < s - r) || (y >= r && y < s - r);
}

function inTriangle(px, py, a, b, c) {
  const sign = (o, d1, d2) => (d1[0] - o[0]) * (d2[1] - o[1]) - (d2[0] - o[0]) * (d1[1] - o[1]);
  const d1 = sign([px, py], a, b), d2 = sign([px, py], b, c), d3 = sign([px, py], c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

function makeIcon(size) {
  const r = Math.round(size * 0.22);
  const A = [0.40 * size, 0.30 * size], B = [0.40 * size, 0.70 * size], C = [0.74 * size, 0.50 * size];
  const top = [91, 84, 230], bottom = [138, 76, 210]; // 靛->紫 渐变
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let off = 0;
  for (let y = 0; y < size; y++) {
    raw[off++] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const t = y / size;
      let R = top[0] + (bottom[0] - top[0]) * t;
      let G = top[1] + (bottom[1] - top[1]) * t;
      let Bc = top[2] + (bottom[2] - top[2]) * t;
      let a = inRoundRect(x, y, size, r) ? 255 : 0;
      if (a && inTriangle(x, y, A, B, C)) { R = G = Bc = 255; }
      raw[off++] = R; raw[off++] = G; raw[off++] = Bc; raw[off++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.writeFileSync(__dirname + "/public/icon-180.png", makeIcon(180));
fs.writeFileSync(__dirname + "/public/icon-512.png", makeIcon(512));
fs.mkdirSync(__dirname + "/assets", { recursive: true });
fs.writeFileSync(__dirname + "/assets/icon-only.png", makeIcon(1024));
console.log("icons generated");
