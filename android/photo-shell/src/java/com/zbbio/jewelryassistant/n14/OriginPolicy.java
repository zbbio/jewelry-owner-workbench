package com.zbbio.jewelryassistant.n14;

import java.net.URI;
import java.net.URISyntaxException;

/** Fixed local transport. Neither Intent data nor user-entered addresses go here. */
public final class OriginPolicy {
    public static final String HOME = "http://127.0.0.1:17864/";
    private static final String AUTHORITY = "127.0.0.1:17864";

    private OriginPolicy() {}

    public static boolean resource(String value) {
        return local(value) != null;
    }

    public static boolean navigation(String value) {
        final URI url = local(value);
        if (url == null || url.getRawQuery() != null) return false;
        final String path = url.getRawPath();
        return "/".equals(path) || "".equals(path) || "/api/pair".equals(path);
    }

    private static URI local(String value) {
        if (value == null || value.indexOf('\\') >= 0) return null;
        try {
            final URI url = new URI(value);
            if (url.isOpaque() || !"http".equals(url.getScheme()) ||
                !AUTHORITY.equals(url.getRawAuthority()) ||
                !"127.0.0.1".equals(url.getHost()) || url.getPort() != 17864 ||
                url.getRawUserInfo() != null) return null;
            return url;
        } catch (URISyntaxException invalid) {
            return null;
        }
    }
}
