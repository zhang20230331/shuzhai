package com.shuzhai.reader;

import android.content.Context;
import android.content.res.AssetManager;
import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioManager;
import android.media.AudioTrack;
import android.os.PowerManager;

import com.k2fsa.sherpa.onnx.GenerationConfig;
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
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 内置离线语音桥（Kokoro int8 中英模型 · 103 音色 · Apache-2.0 可免费商用）。
 *
 * 网页侧通过 window.AndroidTts 调用：
 *   init()                        —— 后台初始化引擎（拷 espeak 数据 + 加载模型），完成后回调 ready
 *   isReady()                     —— 引擎是否就绪
 *   speak(text, sid, speed)       —— 朗读一句话（流式边合成边播），播完回调 done，出错回调 error
 *   stop()                        —— 立即停止合成与播放（暂停也走这里，恢复由网页重发当前句）
 *   setVolumePage(boolean)        —— 音量键翻页开关（阅读未听书时音量键=翻页）
 *
 * 事件统一回调 window.__szNativeTtsEvent(type, msg)：ready / done / error / focusloss。
 */
public final class SherpaTts {
    private static final String TAG = "SherpaTts";
    /** 音量键翻页开关（MainActivity.dispatchKeyEvent 读取） */
    public static volatile boolean volumePage = false;

    private static final String ASSET_DIR = "tts";

    private final Context context;
    private final AssetManager assets;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();

    private OfflineTts tts;
    private AudioTrack track;
    private int sampleRate = 24000;
    private volatile boolean ready = false;
    private volatile boolean failed = false;
    private volatile boolean initStarted = false;
    private volatile SpeakJob current;
    private AudioManager audio;
    private PowerManager.WakeLock wakeLock;

    /** 单句朗读任务：合成（流式写 AudioTrack）→ 等待缓冲播完 */
    private final class SpeakJob {
        volatile boolean stopped;
        long frames;

        void run(String text, int sid, float speed) {
            frames = 0;
            track.play();
            GenerationConfig g = new GenerationConfig();
            g.setSid(sid);
            g.setSpeed(speed);
            // 显式匿名类实现回调：JNI 侧按 "invoke([F)Ljava/lang/Integer;" 查找方法，
            // Java lambda 经 D8 脱糖后返回原始 int 签名不匹配，会触发 NoSuchMethodError 崩溃
            tts.generateWithConfigAndCallback(text, g,
                    new kotlin.jvm.functions.Function1<float[], Integer>() {
                        private long stallStart = 0; // 写入连续停滞计时（音频 HAL 异常保护）

                        @Override
                        public Integer invoke(float[] samples) {
                            int off = 0;
                            while (off < samples.length) {
                                if (stopped) return 0;
                                int n = track.write(samples, off, samples.length - off,
                                        AudioTrack.WRITE_NON_BLOCKING);
                                if (n < 0) return 0;
                                if (n == 0) {
                                    // 音频系统不消费时缓冲长期满：超过 15s 放弃本句，绝不无限阻塞
                                    if (stallStart == 0) stallStart = android.os.SystemClock.elapsedRealtime();
                                    else if (android.os.SystemClock.elapsedRealtime() - stallStart > 15000) {
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
            // 合成结束后缓冲里可能还有没播完的声音，等它排空。
            // 排空上限 = 时长×1.5 + 3s：正常路径照常等完，音频系统异常时绝不无限等待
            long maxWaitMs = (long) (frames / (float) sampleRate * 1500) + 3000;
            long start = android.os.SystemClock.elapsedRealtime();
            long head = 0;
            while (!stopped && (head = (long) track.getPlaybackHeadPosition()) < frames) {
                if (android.os.SystemClock.elapsedRealtime() - start > maxWaitMs) {
                    android.util.Log.w(TAG, "drain timeout, head=" + head + " frames=" + frames);
                    break;
                }
                try { Thread.sleep(25); } catch (InterruptedException e) { return; }
            }
            if (stopped) {
                try { track.pause(); track.flush(); } catch (Throwable ignored) {}
            }
            android.util.Log.d(TAG,
                    "speak done: text=" + text.length() + "ch frames=" + frames + " head=" + head);
        }
    }

    public SherpaTts(Context context) {
        this.context = context.getApplicationContext();
        this.assets = this.context.getAssets();
    }

    /* ---------------- 网页可调用接口 ---------------- */

    @android.webkit.JavascriptInterface
    public void init() {
        synchronized (this) {
            if (initStarted && !failed) return; // 已启动（成功或进行中）
            initStarted = true;
            failed = false; // 失败后允许网页端重试
        }
        worker.execute(() -> {
            try {
                File espeakDir = copyEspeakData();
                tts = new OfflineTts(assets, buildConfig(espeakDir));
                initAudioTrack(tts.sampleRate());
                ready = true;
                fire("ready", null);
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
                job.run(text, sid, speed);
                if (!job.stopped) fire("done", null);
            } catch (Throwable t) {
                if (!job.stopped) fire("error", safeMsg(t));
            }
        });
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
                4, false, "cpu");
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
                .setBufferSizeInBytes(Math.max(buf, 64 * 1024))
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
            fire("focusloss", null); // 网页侧执行暂停
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
