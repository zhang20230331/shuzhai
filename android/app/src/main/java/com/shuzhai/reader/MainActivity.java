package com.shuzhai.reader;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
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
    }
}
