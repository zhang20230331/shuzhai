package com.shuzhai.reader;

import android.content.Context;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.PowerManager;
import android.os.SystemClock;

import com.k2fsa.sherpa.onnx.GenerationConfig;
import com.k2fsa.sherpa.onnx.GeneratedAudio;
import com.k2fsa.sherpa.onnx.OfflineTts;
import com.k2fsa.sherpa.onnx.OfflineTtsConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKittenModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsKokoroModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsMatchaModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsPocketModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsSupertonicModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsVitsModelConfig;
import com.k2fsa.sherpa.onnx.OfflineTtsZipVoiceModelConfig;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 内置离线语音桥（Kokoro int8 中英模型 · 10 精选音色 · Apache-2.0 可免费商用）。
 *
 * 网页侧通过 window.AndroidTts 调用：
 *   init()                        —— 后台初始化引擎（拷 espeak 数据 + 加载模型），完成后回调 ready
 *   isReady()                     —— 引擎是否就绪
 *   speak(text, sid, speed)       —— 朗读一句（句缓存命中直接播，否则流式合成边合边播），播完回调 done
 *   prefetch(text, sid, speed)    —— 独立引擎后台预合成（与播放完全并行，内存不足时自动停用）
 *   stop()                        —— 立即停止合成与播放
 *   setVolumePage(boolean)        —— 音量键翻页开关
 *
 * 事件统一回调 window.__szNativeTtsEvent(type, msg)：ready / done / error / focusloss。
 */
public final class SherpaTts {
    private static final String TAG = "SherpaTts";
    /** 音量键翻页开关（MainActivity.dispatchKeyEvent 读取） */
    public static volatile boolean volumePage = false;

    private static final String ASSET_DIR = "tts";
    /** 句级缓存上限（文件数）：一本书线性往下读，旧的句子缓存直接淘汰 */
    private static final int CACHE_MAX_FILES = 240;

    private final Context context;
    private final AssetManager assets;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService prefetchWorker = Executors.newSingleThreadExecutor();

    private OfflineTts tts;            // 播放专用引擎（worker 线程独占，无锁）
    private OfflineTts prefetchTts;    // 预合成专用引擎（内存充足时才创建，与播放完全并行）
    private AudioTrack track;
    private int sampleRate = 24000;
    private volatile boolean ready = false;
    private volatile boolean failed = false;
    private volatile boolean initStarted = false;
    private volatile SpeakJob current;
    private AudioManager audio;
    private PowerManager.WakeLock wakeLock;
    private File ttsCache;

    /** 本机合成速度滚动统计（isSlowSynth 依据） */
    private float rtfAvg = 0f;
    private int rtfCount = 0;
    private float rtfPrefetchAvg = 0f;
    private int rtfPrefetchCount = 0;
    private int cacheHits = 0, cacheMisses = 0;

    /** 预合成请求队列（容量 8，满则丢弃；仅预合成引擎消费） */
    private final java.util.concurrent.BlockingQueue<PendingPrefetch> prefetchQueue =
            new java.util.concurrent.LinkedBlockingQueue<>(8);

    private static final class PendingPrefetch {
        final String text;
        final int sid;
        final float speed;

        PendingPrefetch(String t, int s, float sp) { text = t; sid = s; speed = sp; }
    }

    /** 单句朗读任务 */
    private final class SpeakJob {
        volatile boolean stopped;
        long frames;

        /** RTF 滚动统计（合成耗时 / 音频时长），供网页侧判断本机合成是否偏慢 */
        private void trackRtf(long elapsedMs, float audioSec) {
            if (audioSec <= 0.1f) return;
            float rtf = elapsedMs / 1000f / audioSec;
            rtfAvg = rtfCount == 0 ? rtf : (rtfAvg * 0.6f + rtf * 0.4f);
            if (rtfCount < 99) rtfCount++;
            android.util.Log.d(TAG, "rtf=" + String.format("%.2f", rtf)
                    + " avg=" + String.format("%.2f", rtfAvg));
        }

        /** 整句合成完再播（双引擎设备的缓存未命中路径）：绝不边合边播出杂音 */
        void synthThenPlay(String text, int sid, float speed) throws Exception {
            fire("synth", null); // 网页侧显示「本机合成中…」
            long t0 = SystemClock.elapsedRealtime();
            GeneratedAudio a = tts.generate(text, sid, speed);
            float[] samples = a.getSamples();
            float audioSec = samples.length / (float) sampleRate;
            trackRtf(SystemClock.elapsedRealtime() - t0, audioSec);
            if (stopped) return;
            frames = 0;
            track.play();
            int off = 0;
            long stallStart = 0;
            while (off < samples.length) {
                if (stopped) return;
                int n = track.write(samples, off, samples.length - off, AudioTrack.WRITE_NON_BLOCKING);
                if (n < 0) return;
                if (n == 0) {
                    if (stallStart == 0) stallStart = SystemClock.elapsedRealtime();
                    else if (SystemClock.elapsedRealtime() - stallStart > 15000) return;
                    try { Thread.sleep(20); } catch (InterruptedException e) { return; }
                } else {
                    stallStart = 0;
                    off += n;
                    frames += n;
                }
            }
            drain();
        }

        /** 流式合成：边合边播（单引擎低内存设备的兜底路径）。tts 引擎仅 worker 线程使用，无需加锁 */
        void run(String text, int sid, float speed) throws Exception {
            fire("synth", null);
            long t0 = SystemClock.elapsedRealtime();
            frames = 0;
            track.play();
            GenerationConfig g = new GenerationConfig();
            g.setSid(sid);
            g.setSpeed(speed);
            // 显式匿名类实现回调：JNI 侧按 "invoke([F)Ljava/lang/Integer;" 查找方法，
            // Java lambda 经 D8 脱糖后返回原始 int 签名不匹配，会触发 NoSuchMethodError 崩溃
            tts.generateWithConfigAndCallback(text, g,
                    new kotlin.jvm.functions.Function1<float[], Integer>() {
                        private long stallStart = 0;

                        @Override
                        public Integer invoke(float[] samples) {
                            int off = 0;
                            while (off < samples.length) {
                                if (stopped) return 0;
                                int n = track.write(samples, off, samples.length - off,
                                        AudioTrack.WRITE_NON_BLOCKING);
                                if (n < 0) return 0;
                                if (n == 0) {
                                    if (stallStart == 0) stallStart = SystemClock.elapsedRealtime();
                                    else if (SystemClock.elapsedRealtime() - stallStart > 15000) {
                                        android.util.Log.w(TAG, "audio sink stalled, abort sentence");
                                        return 0;
                                    }
                                    try { Thread.sleep(20); } catch (InterruptedException e) { return 0; }
                                } else {
                                    stallStart = 0;
                                    off += n;
                                    frames += n;
                                }
                            }
                            return stopped ? 0 : 1;
                        }
                    });
            trackRtf(SystemClock.elapsedRealtime() - t0, frames / (float) sampleRate);
            drain();
        }

        /** 缓存命中：整句音频已在磁盘，直接写 AudioTrack 播放（零合成延迟） */
        void playCached(File f) throws Exception {
            frames = 0;
            byte[] bytes = readFile(f);
            int headerLen = 8; // 4B 保留 + 4B 采样数
            int nFloats = Math.max(0, (bytes.length - headerLen) / 4);
            float[] samples = new float[nFloats];
            ByteBuffer.wrap(bytes, headerLen, nFloats * 4)
                    .order(ByteOrder.LITTLE_ENDIAN).asFloatBuffer().get(samples);
            track.play();
            int off = 0;
            long stallStart = 0;
            while (off < samples.length) {
                if (stopped) return;
                int n = track.write(samples, off, samples.length - off, AudioTrack.WRITE_NON_BLOCKING);
                if (n < 0) return;
                if (n == 0) {
                    if (stallStart == 0) stallStart = SystemClock.elapsedRealtime();
                    else if (SystemClock.elapsedRealtime() - stallStart > 15000) return;
                    try { Thread.sleep(20); } catch (InterruptedException e) { return; }
                } else {
                    stallStart = 0;
                    off += n;
                    frames += n;
                }
            }
            drain();
        }

        /** 等缓冲排空：上限 = 时长×1.5 + 3s；播放头 1.5s 无进展立即放弃（音频 HAL 异常时不白等） */
        private void drain() {
            long maxWaitMs = (long) (frames / (float) sampleRate * 1500) + 3000;
            long start = SystemClock.elapsedRealtime();
            long head = 0, lastProgress = 0, lastHead = -1;
            while (!stopped && (head = (long) track.getPlaybackHeadPosition()) < frames) {
                long now = SystemClock.elapsedRealtime();
                if (now - start > maxWaitMs) {
                    android.util.Log.w(TAG, "drain timeout, head=" + head + " frames=" + frames);
                    break;
                }
                if (head != lastHead) { lastHead = head; lastProgress = now; }
                else if (now - lastProgress > 1500 && lastHead >= 0) {
                    android.util.Log.w(TAG, "drain stalled (head frozen), give up: head=" + head);
                    break;
                }
                try { Thread.sleep(25); } catch (InterruptedException e) { return; }
            }
            if (stopped) {
                try { track.pause(); track.flush(); } catch (Throwable ignored) {}
            }
            android.util.Log.d(TAG, "speak done: frames=" + frames + " head=" + head);
        }
    }

    public SherpaTts(Context context) {
        this.context = context.getApplicationContext();
        this.assets = this.context.getAssets();
        this.ttsCache = new File(this.context.getCacheDir(), "tts-sentences");
        prefetchWorker.execute(this::prefetchLoop); // 常驻：逐条消费预合成队列
    }

    /** 预合成常驻循环：独立引擎 + 独立线程，与播放完全并行 */
    private void prefetchLoop() {
        while (true) {
            PendingPrefetch p;
            try {
                p = prefetchQueue.take();
            } catch (InterruptedException e) {
                return;
            }
            try {
                File f = cacheFile(p.text, p.sid, p.speed);
                if (f.isFile()) continue;
                long t0 = SystemClock.elapsedRealtime();
                GeneratedAudio audio = prefetchTts.generate(p.text, p.sid, p.speed);
                writeFloatFile(f, audio.getSamples());
                trimCache();
                long elapsed = SystemClock.elapsedRealtime() - t0;
                float audioSec = audio.getSamples().length / (float) sampleRate;
                if (audioSec > 0.1f) {
                    float rtf = elapsed / 1000f / audioSec;
                    rtfPrefetchAvg = rtfPrefetchCount == 0 ? rtf : (rtfPrefetchAvg * 0.6f + rtf * 0.4f);
                    if (rtfPrefetchCount < 99) rtfPrefetchCount++;
                }
                android.util.Log.d(TAG, "prefetch done: " + p.text.length() + "ch in "
                        + elapsed + "ms");
            } catch (Throwable t) {
                android.util.Log.w(TAG, "prefetch failed: " + safeMsg(t));
                try { Thread.sleep(300); } catch (InterruptedException ie) { return; }
            }
        }
    }

    /** 内存门控：总内存 ≥ 3.5GB 才建第二引擎（双引擎约 2×110MB 原生内存） */
    private boolean canAffordPrefetchEngine() {
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return false;
            android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            return mi.totalMem >= (long) (3.5 * 1024 * 1024 * 1024);
        } catch (Throwable t) {
            return false;
        }
    }

    /* ---------------- 网页可调用接口 ---------------- */

    @android.webkit.JavascriptInterface
    public void init() {
        synchronized (this) {
            if (initStarted && !failed) return;
            initStarted = true;
            failed = false;
        }
        worker.execute(() -> {
            try {
                File espeakDir = copyEspeakData();
                tts = new OfflineTts(assets, buildConfig(espeakDir));
                sampleRate = tts.sampleRate();
                initAudioTrack(sampleRate);
                ready = true;
                fire("ready", null);
                // 预合成引擎与主引擎完全独立：内存充足才建（双引擎约 2×110MB 原生内存）。
                // 失败静默降级为不预合成（听书仍可用，句间靠流式合成衔接）
                try {
                    if (canAffordPrefetchEngine()) {
                        prefetchTts = new OfflineTts(assets, buildConfig(espeakDir));
                        android.util.Log.i(TAG, "prefetch engine ready");
                    } else {
                        android.util.Log.i(TAG, "low RAM, prefetch engine disabled");
                    }
                } catch (Throwable t) {
                    prefetchTts = null;
                    android.util.Log.w(TAG, "prefetch engine init failed: " + safeMsg(t));
                }
            } catch (Throwable t) {
                failed = true;
                fire("error", "初始化失败: " + safeMsg(t));
            }
        });
    }

    @android.webkit.JavascriptInterface
    public boolean isReady() { return ready; }

    @android.webkit.JavascriptInterface
    public void speak(final String text, final int sid, final float speed) {
        if (!ready) { fire("error", "引擎尚未就绪"); return; }
        SpeakJob job = new SpeakJob();
        SpeakJob prev = current;
        current = job;
        if (prev != null) prev.stopped = true;
        worker.execute(() -> {
            acquireWake();
            requestFocus();
            try {
                android.util.Log.d(TAG, "speak start: len=" + text.length());
                File cached = cacheFile(text, sid, speed);
                if (cached.isFile()) {
                    cacheHits++;
                    job.playCached(cached);
                } else {
                    cacheMisses++;
                    if (prefetchTts != null) {
                        // 双引擎：整句合成完再播（绝不边合边播出杂音）。
                        // 稳态下句子已被预合成引擎备好走缓存，此路径只在冷启动/跳句时出现
                        job.synthThenPlay(text, sid, speed);
                    } else {
                        // 单引擎（低内存设备）：只能流式；RTF 过慢时由网页侧自动降级系统 TTS
                        job.run(text, sid, speed);
                    }
                }
                if (!job.stopped) fire("done", null);
            } catch (Throwable t) {
                if (!job.stopped) fire("error", safeMsg(t));
            }
        });
    }

    /** 预合成：独立引擎后台整句合成入缓存，与播放完全并行（无独立引擎时为 no-op） */
    @android.webkit.JavascriptInterface
    public void prefetch(final String text, final int sid, final float speed) {
        if (!ready || prefetchTts == null || text == null || text.isEmpty()) return;
        prefetchQueue.offer(new PendingPrefetch(text, sid, speed)); // 队列满=预合成跟不上，丢弃
    }

    /** 本机合成是否偏慢：播放路径 RTF>1.25（≥3 句），或双引擎稳态下预合成 RTF>1.5（追不上播放） */
    @android.webkit.JavascriptInterface
    public boolean isSlowSynth() {
        if (rtfCount >= 3 && rtfAvg > 1.25f) return true;
        if (cacheHits > 10 && rtfPrefetchCount >= 3 && rtfPrefetchAvg > 1.5f) return true;
        return false;
    }

    /** 诊断数据（JSON）：设备信息 + 引擎状态 + 合成速度 + 缓存命中，供网页诊断面板展示/复制 */
    @android.webkit.JavascriptInterface
    public String getDiagnostics() {
        android.app.ActivityManager am =
                (android.app.ActivityManager) context.getSystemService(Context.ACTIVITY_SERVICE);
        long ram = 0;
        if (am != null) {
            android.app.ActivityManager.MemoryInfo mi = new android.app.ActivityManager.MemoryInfo();
            am.getMemoryInfo(mi);
            ram = mi.totalMem;
        }
        File[] files = ttsCache.listFiles((d, n) -> n.endsWith(".f32"));
        StringBuilder sb = new StringBuilder();
        sb.append("{\"model\":\"").append(jsonEsc(android.os.Build.MODEL)).append('"');
        sb.append(",\"brand\":\"").append(jsonEsc(android.os.Build.BRAND)).append('"');
        sb.append(",\"release\":\"").append(jsonEsc(android.os.Build.VERSION.RELEASE)).append('"');
        sb.append(",\"ramGB\":").append(String.format(java.util.Locale.US, "%.1f", ram / 1073741824.0));
        sb.append(",\"cores\":").append(Runtime.getRuntime().availableProcessors());
        sb.append(",\"ready\":").append(ready);
        sb.append(",\"prefetchEngine\":").append(prefetchTts != null);
        sb.append(",\"rtfAvg\":").append(rtfCount > 0 ? String.format(java.util.Locale.US, "%.2f", rtfAvg) : "null");
        sb.append(",\"rtfCount\":").append(rtfCount);
        sb.append(",\"rtfPrefetchAvg\":").append(rtfPrefetchCount > 0 ? String.format(java.util.Locale.US, "%.2f", rtfPrefetchAvg) : "null");
        sb.append(",\"rtfPrefetchCount\":").append(rtfPrefetchCount);
        sb.append(",\"cacheHits\":").append(cacheHits);
        sb.append(",\"cacheMisses\":").append(cacheMisses);
        sb.append(",\"cacheFiles\":").append(files == null ? 0 : files.length);
        sb.append("}");
        return sb.toString();
    }

    private static String jsonEsc(String s) {
        return s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"");
    }

    /** 供低内存设备/测试手动启用预合成引擎（正常情况按内存自动决定）。
        必须用独立线程：prefetchWorker 已被 prefetchLoop 常驻占用 */
    @android.webkit.JavascriptInterface
    public void enablePrefetchEngine() {
        if (!ready || prefetchTts != null) return;
        new Thread(() -> {
            try {
                File espeakDir = new File(context.getFilesDir(), "tts/espeak-ng-data");
                OfflineTts engine = new OfflineTts(assets, buildConfig(espeakDir));
                prefetchTts = engine;
                android.util.Log.i(TAG, "prefetch engine ready (manual)");
            } catch (Throwable t) {
                prefetchTts = null;
                android.util.Log.w(TAG, "prefetch engine init failed: " + safeMsg(t));
            }
        }, "prefetch-engine-init").start();
    }

    @android.webkit.JavascriptInterface
    public void stop() {
        SpeakJob job = current;
        if (job != null) job.stopped = true;
        AudioTrack t = track;
        if (t != null) {
            try { t.pause(); t.flush(); } catch (Throwable ignored) {}
        }
        releaseWake();
        abandonFocus();
    }

    @android.webkit.JavascriptInterface
    public void setVolumePage(boolean v) { volumePage = v; }

    /* ---------------- 句级磁盘缓存 ---------------- */

    private File cacheFile(String text, int sid, float speed) throws Exception {
        MessageDigest md = MessageDigest.getInstance("MD5");
        byte[] d = md.digest((sid + "|" + speed + "|" + text).getBytes("UTF-8"));
        StringBuilder sb = new StringBuilder(d.length * 2);
        for (byte b : d) sb.append(Character.forDigit((b >> 4) & 0xf, 16)).append(Character.forDigit(b & 0xf, 16));
        File f = new File(ttsCache, sb + ".f32");
        if (!ttsCache.isDirectory()) ttsCache.mkdirs();
        return f;
    }

    private static void writeFloatFile(File f, float[] samples) throws Exception {
        File tmp = new File(f.getParent(), f.getName() + ".tmp");
        try (OutputStream os = new FileOutputStream(tmp)) {
            os.write(ByteBuffer.allocate(samples.length * 4 + 8)
                    .order(ByteOrder.LITTLE_ENDIAN)
                    .putInt(0)                     // 头：保留
                    .putInt(samples.length)
                    .array(), 0, 8);
            ByteBuffer bb = ByteBuffer.allocate(samples.length * 4).order(ByteOrder.LITTLE_ENDIAN);
            for (float v : samples) bb.putFloat(v);
            os.write(bb.array());
        }
        tmp.renameTo(f);
    }

    private static byte[] readFile(File f) throws Exception {
        byte[] out = new byte[(int) f.length()];
        try (InputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < out.length) {
                int n = in.read(out, off, out.length - off);
                if (n < 0) break;
                off += n;
            }
        }
        return out;
    }

    /** 缓存超限：按最后修改时间淘汰最旧的一半 */
    private void trimCache() {
        File[] files = ttsCache.listFiles((d, n) -> n.endsWith(".f32"));
        if (files == null || files.length <= CACHE_MAX_FILES) return;
        Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
        for (int i = 0; i < files.length - CACHE_MAX_FILES; i++) files[i].delete();
    }

    /* ---------------- 内部实现 ---------------- */

    private OfflineTtsConfig buildConfig(File espeakDir) {
        OfflineTtsKokoroModelConfig kokoro = new OfflineTtsKokoroModelConfig(
                ASSET_DIR + "/model.int8.onnx",
                ASSET_DIR + "/voices.bin",
                ASSET_DIR + "/tokens.txt",
                espeakDir.getAbsolutePath(),
                ASSET_DIR + "/lexicon-zh.txt," + ASSET_DIR + "/lexicon-us-en.txt",
                "", "", 1.0f);
        OfflineTtsModelConfig model = new OfflineTtsModelConfig(
                new OfflineTtsVitsModelConfig(),
                new OfflineTtsMatchaModelConfig(),
                kokoro,
                new OfflineTtsZipVoiceModelConfig(),
                new OfflineTtsKittenModelConfig(),
                new OfflineTtsPocketModelConfig(),
                new OfflineTtsSupertonicModelConfig(),
                Math.min(8, Math.max(4, Runtime.getRuntime().availableProcessors())),
                false, "cpu");
        return new OfflineTtsConfig(
                model,
                ASSET_DIR + "/phone-zh.fst," + ASSET_DIR + "/date-zh.fst,"
                        + ASSET_DIR + "/number-zh.fst",
                "", 1, 0.2f);
    }

    private void initAudioTrack(int sr) {
        sampleRate = sr;
        int buf = AudioTrack.getMinBufferSize(sampleRate,
                AudioFormat.CHANNEL_OUT_MONO, AudioFormat.ENCODING_PCM_FLOAT);
        track = new AudioTrack.Builder()
                .setAudioAttributes(new AudioAttributes.Builder()
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .build())
                .setAudioFormat(new AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_FLOAT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .setSampleRate(sampleRate)
                        .build())
                .setBufferSizeInBytes(Math.max(buf, 256 * 1024))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build();
    }

    /** espeak-ng 数据必须落在真实文件系统（JNI 侧用文件路径读取），首次启动从 assets 拷出 */
    private File copyEspeakData() throws Exception {
        File out = new File(context.getFilesDir(), "tts/espeak-ng-data");
        if (out.isDirectory() && new File(out, "phondata").isFile()) return out;
        copyAssetTree(ASSET_DIR + "/espeak-ng-data", out);
        return out;
    }

    private void copyAssetTree(String path, File out) throws Exception {
        String[] children = assets.list(path);
        if (children == null || children.length == 0) {
            copyAssetFile(path, out);
            return;
        }
        //noinspection ResultOfMethodCallIgnored
        out.mkdirs();
        for (String c : children) copyAssetTree(path + "/" + c, new File(out, c));
    }

    private void copyAssetFile(String path, File out) throws Exception {
        //noinspection ResultOfMethodCallIgnored
        out.getParentFile().mkdirs();
        try (InputStream in = assets.open(path);
             OutputStream os = new FileOutputStream(out)) {
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
        }
    }

    /* 听书期间持 CPU 唤醒锁：句间空隙（合成间隙）CPU 不休眠，锁屏也能连续朗读 */
    private synchronized void acquireWake() {
        try {
            if (wakeLock == null) {
                PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
                if (pm == null) return;
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "shuzhai:tts");
                wakeLock.setReferenceCounted(false);
            }
            wakeLock.acquire(4 * 60 * 60 * 1000L);
        } catch (Throwable ignored) {}
    }

    private synchronized void releaseWake() {
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Throwable ignored) {}
    }

    private final AudioManager.OnAudioFocusChangeListener focusListener = change -> {
        if (change == AudioManager.AUDIOFOCUS_LOSS
                || change == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            fire("focusloss", null);
        }
    };

    private void requestFocus() {
        try {
            if (audio == null)
                audio = (AudioManager) context.getSystemService(Context.AUDIO_SERVICE);
            if (audio != null) audio.requestAudioFocus(focusListener,
                    AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
        } catch (Throwable ignored) {}
    }

    private void abandonFocus() {
        try { if (audio != null) audio.abandonAudioFocus(focusListener); } catch (Throwable ignored) {}
    }

    private static String jsString(String s) {
        StringBuilder b = new StringBuilder("'");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '\'' || c == '\\') b.append('\\');
            b.append(c < ' ' ? ' ' : c);
        }
        return b.append('\'').toString();
    }

    private static void fire(String type, String msg) {
        String arg = msg == null ? "" : (", " + jsString(msg));
        MainActivity.evalJs("window.__szNativeTtsEvent && window.__szNativeTtsEvent('" + type + "'" + arg + ")");
    }

    private static String safeMsg(Throwable t) {
        String m = t.getMessage();
        return (m == null || m.isEmpty()) ? t.getClass().getSimpleName() : m;
    }
}
