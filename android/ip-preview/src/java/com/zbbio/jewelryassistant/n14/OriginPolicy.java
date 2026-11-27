package com.zbbio.jewelryassistant.n14;

import java.net.URI;
import java.net.URISyntaxException;

/** Fixed public IP preview origin. No Intent data or user-entered destinations. */
public final class OriginPolicy {
    public static final String HOME = "http://47.112.195.20:8083/";
    private static final String AUTHORITY = "47.112.195.20:8083";

    private OriginPolicy() {}

    public static boolean resource(String value) {
        return local(value) != null;
    }

    public static boolean navigation(String value) {
        final URI url = local(value);
        if (url == null) return false;
        final String path = url.getRawPath();
        return path != null && !path.startsWith("/api/");
    }

    private static URI local(String value) {
        if (value == null || value.indexOf('\\') >= 0) return null;
        try {
            final URI url = new URI(value);
            if (url.isOpaque() || !"http".equals(url.getScheme()) ||
                !AUTHORITY.equals(url.getRawAuthority()) ||
                !"47.112.195.20".equals(url.getHost()) || url.getPort() != 8083 ||
                url.getRawUserInfo() != null) return null;
            return url;
        } catch (URISyntaxException invalid) {
            return null;
        }
    }
}
