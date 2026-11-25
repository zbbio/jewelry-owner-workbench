package com.zbbio.jewelryassistant.n14;

public final class HttpsOriginPolicyTest {
    private static int n;
    private static void eq(boolean actual, boolean target, String description) {
        n++;
        if (actual != target) throw new AssertionError(description);
    }
    private static void rejectedBuild(String text) {
        boolean failed = false;
        try {
            OriginPolicy.fromBuildOrigin(text);
        } catch (IllegalArgumentException expected) {
            failed = true;
        }
        eq(failed, true, "invalid build origin " + n);
    }
    public static void main(String[] args) {
        // A syntactic string for this JVM only. No name resolution, request or release config.
        final String host = "n15-opaque-jvm-assertion-9216" + ".com";
        final String root = "https://" + host;
        String[] badBuild = {null, "", " ", "https://example.com", "https://s.example.net",
            "https://demo.example.org", "https://my-service.invalid", "https://placeholder.net",
            "https://localhost", "https://server.local", "https://127.0.0.1", "https://[::1]",
            "https://192.168.1.12", "https://0x7f000001", "https://abc.123",
            "http://" + host, "https://" + host + "/extra", root + "?next=x", root + "#x",
            root + " " + root, root + "," + root, "https://owner@" + host, root + ":0443",
            root + ":65536", root + ":0", root + "/\n", "https://a..com", "https://a.com.",
            "https://-t.com", "https://xn--e1afmkfd.xn--p1ai"};
        for (String x : badBuild) rejectedBuild(x);
        OriginPolicy p = OriginPolicy.fromBuildOrigin(root);
        eq((root + "/").equals(p.home()), true, "fixed home");
        eq(OriginPolicy.fromBuildOrigin(root + ":443/").home().equals(p.home()), true, "canonical port");
        eq(p.navigation(p.home()), true, "root");
        eq(p.navigation(p.home() + "#view"), true, "document fragment");
        eq(p.navigation(p.home() + "api/pair"), true, "same-origin controlled pairing path");
        eq(p.navigation(p.home() + "api/pair?token=x"), false, "no link token on pairing");
        eq(p.navigation(p.home() + "open/used-code"), false, "no N14 link");
        eq(p.navigation(p.home() + "api/agent/turn"), false, "no arbitrary top-level API URL");
        eq(p.resource(root + "/api/agent/turn"), true, "same-origin assistant API");
        eq(p.resource(root + "/assets/app.js?v=1"), true, "same-origin asset");
        eq(p.resource(root + ":443/assets/app.js"), true, "equivalent implicit port");
        OriginPolicy custom = OriginPolicy.fromBuildOrigin(root + ":8443");
        eq(custom.resource(root + ":8443/api/session"), true, "exact approved custom port");
        eq(custom.resource(root + "/api/session"), false, "unapproved port on same host");
        String[] external = {null, "", "//" + host + "/", "http://" + host + "/", "https://localhost/",
            "https://127.0.0.1/", "https://[::1]/", "https://user@" + host,
            root + "@elsewhere.invalid/", root + ".elsewhere.invalid/", "https://x." + host + "/",
            root + ":80/", root + ":0443/", root + "./", root + "\\@elsewhere.invalid/",
            "https://%6e15-opaque-jvm-assertion-9216.com/", " " + root, root + "/\n",
            root + "/%GG", "intent://elsewhere.invalid", "file:///data/other", "content://other.app/x",
            "data:text/plain,no", "javascript:void(0)", "about:blank", "blob:" + root + "/x",
            "https://another-name.invalid/", "wss://" + host + "/"};
        for (String x : external) {
            eq(p.resource(x), false, "external resource " + n);
            eq(p.navigation(x), false, "external navigation " + n);
        }
        System.out.println("HTTPS origin JVM assertions: " + n + " passed; no requests");
    }
}
