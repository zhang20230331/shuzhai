// Edge TTS 合成核心（与 tts-server 同款：每次请求新建连接 + 自动重试）
const { MsEdgeTTS, OUTPUT_FORMAT } = require("msedge-tts");

const SYNTH_TIMEOUT_MS = 60000;

function escapeXml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function normalizeRate(raw) {
  if (raw === undefined || raw === null || raw === "") return "+0%";
  const n = Number(String(raw).replace("%", ""));
  if (!Number.isFinite(n)) return "+0%";
  const clamped = Math.max(-90, Math.min(200, n));
  return (clamped >= 0 ? "+" : "") + clamped + "%";
}

async function synthesizeOnce(voice, text, rateStr) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text, { rate: rateStr });
  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("synthesis timeout")), SYNTH_TIMEOUT_MS);
    audioStream.on("data", (c) => chunks.push(c));
    audioStream.once("end", () => { clearTimeout(timer); resolve(); });
    audioStream.once("error", (e) => { clearTimeout(timer); reject(e); });
  });
  try { tts.close(); } catch {}
  return Buffer.concat(chunks);
}

async function synthesize(voice, text, rateStr) {
  try {
    return await synthesizeOnce(voice, text, rateStr);
  } catch (e) {
    console.warn(`[retry] voice=${voice}: ${e.message}`);
    await new Promise((r) => setTimeout(r, 300));
    return synthesizeOnce(voice, text, rateStr);
  }
}

module.exports = { synthesize, escapeXml, normalizeRate };
