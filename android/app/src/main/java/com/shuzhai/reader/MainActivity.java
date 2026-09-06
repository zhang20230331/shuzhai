package com.shuzhai.reader;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static android.webkit.WebView webViewRef;

    /** 供前台服务回调进网页（通知栏播放控制） */
    public static void evalJs(final String js) {
        android.webkit.WebView w = webViewRef;
        if (w != null) w.post(() -> w.evaluateJavascript(js, null));
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        webViewRef = bridge != null ? bridge.getWebView() : null;

        // 通知权限（Android 13+ 需运行时申请，媒体卡片才能显示）
        if (Build.VERSION.SDK_INT >= 33 &&
                ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(this, new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        // 返回键/侧滑手势交给网页钩子消费（关弹层、回书架、提示再按一次退出）；
        // 未消费时才真正退出应用
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                WebView webView = bridge != null ? bridge.getWebView() : null;
                if (webView == null) { finish(); return; }
                webView.evaluateJavascript(
                    "(window.__szBack && window.__szBack()) === true",
                    value -> { if (!"true".equals(value)) finish(); });
            }
        });

        // 网页通过此桥同步系统栏：底色跟随界面背景，图标明暗随主题反转（夜间可见）。
        // Android 15+ 强制 edge-to-edge 时颜色由页面背景自然透出，图标明暗仍然生效。
        bridge.getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void set(final String bgHex, final boolean dark) {
                runOnUiThread(() -> {
                    try {
                        Window w = getWindow();
                        int color = Color.parseColor(bgHex);
                        w.setStatusBarColor(color);
                        w.setNavigationBarColor(color);
                        WindowInsetsControllerCompat c = WindowCompat.getInsetsController(w, w.getDecorView());
                        c.setAppearanceLightStatusBars(!dark);
                        c.setAppearanceLightNavigationBars(!dark);
                    } catch (Exception ignored) {
                    }
                });
            }
        }, "AndroidBars");

        // 网页通过此桥更新通知栏/锁屏媒体卡片（标题、章节、播放状态）
        bridge.getWebView().addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void set(final String book, final String chapter, final boolean playing) {
                Intent i = new Intent(MainActivity.this, PlaybackService.class)
                        .putExtra("title", chapter)
                        .putExtra("artist", book)
                        .putExtra("playing", playing);
                if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
                else startService(i);
            }

            @JavascriptInterface
            public void hide() {
                stopService(new Intent(MainActivity.this, PlaybackService.class));
            }
        }, "AndroidMedia");
    }
}
