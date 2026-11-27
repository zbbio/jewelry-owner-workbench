package com.zbbio.jewelryassistant.n14;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.http.SslError;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup.LayoutParams;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.ServiceWorkerWebSettings;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;

/** The server owns pairing and session lifetime. The app stores no login code or secret. */
public final class MainActivity extends Activity {
    private static final int SURFACE = Color.rgb(242, 246, 239);
    private static final int JADE = Color.rgb(24, 64, 53);
    private FrameLayout root;
    private LinearLayout notice;
    private TextView message;
    private Button retry;
    private WebView web;
    private boolean failed;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        // This is the final APK, not a WebView remote-debug build.
        root = new FrameLayout(this);
        root.setBackgroundColor(SURFACE);
        setContentView(root);
        createNotice();
        try {
            WebView.setWebContentsDebuggingEnabled(false);
            denyServiceWorkers();
            loadHome();
        } catch (RuntimeException unsupported) {
            unavailable("此设备的 Android WebView 暂不可用。请让负责人检查或更新系统 WebView。");
        }
    }

    private int dp(int value) {
        return Math.round(getResources().getDisplayMetrics().density * value);
    }

    private void createNotice() {
        notice = new LinearLayout(this);
        notice.setOrientation(LinearLayout.VERTICAL);
        notice.setGravity(Gravity.CENTER);
        notice.setPadding(dp(28), dp(18), dp(28), dp(18));
        notice.setBackgroundColor(SURFACE);
        notice.setClickable(true);
        TextView title = new TextView(this);
        title.setText("珠宝店主助手");
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        title.setTextSize(25);
        title.setTextColor(JADE);
        notice.addView(title);
        message = new TextView(this);
        message.setTextColor(JADE);
        message.setTextSize(16);
        message.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams msg = new LinearLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT);
        msg.setMargins(0, dp(18), 0, dp(14));
        notice.addView(message, msg);
        retry = new Button(this);
        retry.setText("重新连接");
        retry.setOnClickListener(v -> {
            try {
                loadHome();
            } catch (RuntimeException unsupported) {
                unavailable("此设备的 Android WebView 暂不可用。请让负责人检查或更新系统 WebView。");
            }
        });
        notice.addView(retry);
        root.addView(notice, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
    }

    private static WebResourceResponse denied() {
        return new WebResourceResponse("text/plain", "UTF-8", 403, "Forbidden",
            Collections.singletonMap("Cache-Control", "no-store"),
            new ByteArrayInputStream("Blocked by local-origin policy.".getBytes(StandardCharsets.UTF_8)));
    }

    private static void denyServiceWorkers() {
        ServiceWorkerController control = ServiceWorkerController.getInstance();
        ServiceWorkerWebSettings settings = control.getServiceWorkerWebSettings();
        settings.setBlockNetworkLoads(true);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccess(false);
        control.setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                return denied();
            }
        });
    }

    @SuppressWarnings("deprecation")
    private WebView createBrowser() {
        final WebView w = new WebView(this);
        w.setBackgroundColor(SURFACE);
        final WebSettings s = w.getSettings();
        s.setJavaScriptEnabled(true);       // Fixed same-origin assistant/form, no native bridge.
        s.setDomStorageEnabled(true);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setAllowContentAccess(false);
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSaveFormData(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setSafeBrowsingEnabled(true);

        final CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(w, false);
        w.setDownloadListener((url, ua, disposition, type, length) -> explainBlocked());
        w.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean dialog, boolean gesture, android.os.Message message) {
                explainBlocked();
                return false;
            }
            @Override public void onPermissionRequest(PermissionRequest request) {
                request.deny();
            }
            @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback cb) {
                cb.invoke(origin, false, false);
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<android.net.Uri[]> cb, FileChooserParams p) {
                cb.onReceiveValue(null);
                return true;
            }
        });
        w.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return rejectNavigation(req.getUrl().toString(), req.isForMainFrame());
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return rejectNavigation(url, true);
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                String url = req.getUrl().toString();
                return (req.isForMainFrame() ? OriginPolicy.navigation(url) : OriginPolicy.resource(url)) ? null : denied();
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                return OriginPolicy.resource(url) ? null : denied();
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (!OriginPolicy.navigation(url)) {
                    view.stopLoading();
                    unavailable("此应用仅打开指定的珠宝助手演示页。");
                }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!OriginPolicy.navigation(url)) return;
                cookies.flush();
                if (!failed) notice.setVisibility(View.GONE);
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError ignored) {
                if (req.isForMainFrame()) unavailable("未连上珠宝助手公网预览。请检查手机网络，再点重新连接。");
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest req, WebResourceResponse response) {
                if (req.isForMainFrame() && response.getStatusCode() >= 500)
                    unavailable("珠宝助手公网服务暂不可用。请稍后重新连接。");
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel();
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                root.removeView(view);
                view.destroy();
                if (web == view) web = null;
                unavailable("助手页面意外关闭。请点重新连接。");
                return true;
            }
        });
        return w;
    }

    private boolean rejectNavigation(String url, boolean mainFrame) {
        boolean allowed = mainFrame ? OriginPolicy.navigation(url) : OriginPolicy.resource(url);
        if (!allowed && mainFrame) explainBlocked();
        return !allowed;
    }

    private void explainBlocked() {
        Toast.makeText(this, "本应用仅连接指定的珠宝助手演示入口", Toast.LENGTH_SHORT).show();
    }

    private void loadHome() {
        failed = false;
        // Keep the application-private persistent first-party cookie, including across process exit.
        message.setText("正在连接珠宝助手公网预览…");
        retry.setVisibility(View.GONE);
        notice.setVisibility(View.VISIBLE);
        if (web == null) {
            web = createBrowser();
            root.addView(web, 0, new FrameLayout.LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        }
        web.stopLoading();
        web.loadUrl(OriginPolicy.HOME);
    }

    private void unavailable(String text) {
        failed = true;
        message.setText(text);
        retry.setVisibility(View.VISIBLE);
        notice.setVisibility(View.VISIBLE);
        notice.bringToFront();
    }

    @Override protected void onStop() {
        if (web != null) CookieManager.getInstance().flush();
        super.onStop();
    }

    @Override protected void onDestroy() {
        if (web != null) {
            web.stopLoading();
            root.removeView(web);
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }
}
