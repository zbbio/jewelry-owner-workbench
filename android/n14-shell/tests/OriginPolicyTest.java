package com.zbbio.jewelryassistant.n14;

public final class OriginPolicyTest {
    private static int count;

    private static void check(boolean actual, boolean expected, String purpose) {
        ++count;
        if (actual != expected) throw new AssertionError(purpose);
    }

    public static void main(String[] args) {
        String base = OriginPolicy.HOME;
        check(OriginPolicy.navigation(base), true, "fixed root");
        check(OriginPolicy.navigation(base + "#assistant"), true, "same document anchor");
        check(OriginPolicy.navigation(base + "api/pair"), true, "server form navigation");
        check(OriginPolicy.navigation(base + "api/pair?code=ignored"), false, "no pair code in navigation URL");
        check(OriginPolicy.navigation(base + "open/example"), false, "no old login path");
        check(OriginPolicy.navigation(base + "api/agent/turn"), false, "no navigation into API");
        check(OriginPolicy.resource(base + "api/agent/turn"), true, "same-origin XHR");
        check(OriginPolicy.resource(base + "assets/app.js?v=1"), true, "same-origin versioned asset");
        String[] blocked = {
            null, "", "//127.0.0.1:17864/", "http://localhost:17864/", "http://127.0.0.2:17864/",
            "https://127.0.0.1:17864/", "http://127.0.0.1:17865/", "http://127.0.0.1/",
            "http://127.0.0.1.evil.example:17864/", "http://[::1]:17864/", "http://2130706433:17864/",
            "http://127.0.0.1:017864/", "http://user@127.0.0.1:17864/",
            "http://127.0.0.1:17864@example.org/", "http://%31%32%37.0.0.1:17864/",
            "http://127.0.0.1:17864\\@other.example/", "http://example.org/", "https://example.org/",
            "file:///data/local/tmp/external", "content://other.app/resource", "javascript:void(0)",
            "data:text/plain,example", "intent://example.org", "about:blank", " http://127.0.0.1:17864/",
            "http://127.0.0.1:17864/\n", "http://127.0.0.1:17864/%GG", "blob:http://127.0.0.1:17864/x"
        };
        for (int i = 0; i < blocked.length; i++) {
            check(OriginPolicy.navigation(blocked[i]), false, "blocked navigation " + i);
            check(OriginPolicy.resource(blocked[i]), false, "blocked resource " + i);
        }
        System.out.println("OriginPolicy unit checks: " + count + " passed");
    }
}
