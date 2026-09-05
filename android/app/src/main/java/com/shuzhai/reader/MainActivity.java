package com.shuzhai.reader;

import android.graphics.Color;
import android.os.Bundle;
import android.view.Window;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
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
                        WindowInsetsControllerCompat c = new WindowInsetsControllerCompat(w);
                        c.setAppearanceLightStatusBars(!dark);
                        c.setAppearanceLightNavigationBars(!dark);
                    } catch (Exception ignored) {
                    }
                });
            }
        }, "AndroidBars");
    }
}
