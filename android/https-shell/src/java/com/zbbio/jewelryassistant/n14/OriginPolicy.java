package com.zbbio.jewelryassistant.n14;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Immutable exact-origin policy. Only BuildOrigin, generated during release, supplies the origin. */
public final class OriginPolicy {
    private static final Pattern ROOT = Pattern.compile("^https://([a-z0-9.-]+)(?::([1-9][0-9]{0,4}))?/?$");
    private static final Pattern LABEL = Pattern.compile("^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$");
    private static final Pattern TLD = Pattern.compile("^[a-z]{2,63}$");
    private static final Set<String> PLACEHOLDERS = new HashSet<>(Arrays.asList(
        "example", "examples", "sample", "samples", "demo", "placeholder", "your-domain",
        "yourdomain", "your-site", "yoursite", "replace-me", "replaceme", "changeme", "tbd", "todo", "dummy"
    ));
    private static final Set<String> RESERVED_TLDS = new HashSet<>(Arrays.asList(
        "local", "localhost", "test", "invalid", "example", "internal", "lan", "home",
        "corp", "onion", "arpa", "alt", "private"
    ));

    private final String host;
    private final int port;

    private OriginPolicy(String host, int port) {
        this.host = host;
        this.port = port;
    }

    public static OriginPolicy fromBuildOrigin(String value) {
        if (value == null || !value.equals(value.trim())) throw new IllegalArgumentException("origin missing or padded");
        Matcher m = ROOT.matcher(value);
        if (!m.matches()) throw new IllegalArgumentException("one HTTPS DNS origin required");
        String host = m.group(1);
        String[] labels = host.split("\\.", -1);
        if (labels.length < 2 || host.length() > 253) throw new IllegalArgumentException("DNS hostname required");
        for (String label : labels) {
            if (!LABEL.matcher(label).matches() || PLACEHOLDERS.contains(label) || label.equals("localhost"))
                throw new IllegalArgumentException("invalid or reserved DNS label");
        }
        String tld = labels[labels.length - 1];
        if (!TLD.matcher(tld).matches() || RESERVED_TLDS.contains(tld))
            throw new IllegalArgumentException("public DNS hostname required");
        int port = m.group(2) == null ? 443 : Integer.parseInt(m.group(2));
        if (port > 65535) throw new IllegalArgumentException("invalid HTTPS port");
        return new OriginPolicy(host, port);
    }

    public String home() {
        return "https://" + host + (port == 443 ? "" : ":" + port) + "/";
    }

    public boolean navigation(String value) {
        URI url = normalized(value);
        if (url == null || url.getRawQuery() != null) return false;
        String path = url.getRawPath();
        return "/".equals(path) || "".equals(path) || "/api/pair".equals(path);
    }

    public boolean resource(String value) {
        return normalized(value) != null;
    }

    private URI normalized(String value) {
        if (value == null || value.indexOf('\\') >= 0 || !value.equals(value.trim())) return null;
        try {
            URI u = new URI(value);
            if (u.isOpaque() || !"https".equals(u.getScheme()) || u.getRawUserInfo() != null ||
                u.getHost() == null || !host.equals(u.getHost().toLowerCase(Locale.ROOT))) return null;
            final String auth = u.getRawAuthority();
            if (auth == null) return null;
            int requested = u.getPort() == -1 ? 443 : u.getPort();
            // Precise ASCII spelling; no aliases, escaped authority, trailing dot, or ambiguous zero-padded ports.
            if (requested != port || !auth.equals(host + (u.getPort() < 0 ? "" : ":" + u.getPort()))) return null;
            return u;
        } catch (URISyntaxException unsafe) {
            return null;
        }
    }
}
