package com.zbbio.jewelryassistant.n14;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** A framework-only, per-request photo scope. Host/permissions aren't supplied by JS. */
final class AlbumPickerPolicy {
    private static final String[] MIME = {"image/jpeg", "image/png", "image/webp"};
    private AlbumPickerPolicy() {}
    static String[] mimeTypes() { return MIME.clone(); }
    static boolean countAllowed(int n, boolean multiple) { return n > 0 && n <= (multiple ? 12 : 1); }
    static boolean imageMime(String s) {
        if (s == null) return false;
        for (String v : MIME) if (v.equals(s.toLowerCase(Locale.ROOT).trim())) return true;
        return false;
    }
    static boolean imageAccept(String[] specs) {
        if (specs == null || specs.length == 0) return false;
        boolean seen = false;
        for (String raw : specs) {
            if (raw == null || raw.trim().isEmpty()) continue;
            for (String s : raw.split(",", -1)) {
                if (!"image/*".equals(s.trim()) && !imageMime(s)) return false;
                seen = true;
            }
        }
        return seen;
    }
    static boolean contentUri(String value, String ownPackage) {
        if (value == null || value.indexOf('\\') >= 0 || value.length() > 8192) return false;
        try {
            URI u = new URI(value);
            String authority = u.getRawAuthority();
            return "content".equals(u.getScheme()) && !u.isOpaque() && u.getRawFragment() == null &&
                authority != null && authority.matches("[A-Za-z0-9._-]{1,250}") &&
                !authority.equals(ownPackage) && !authority.startsWith(ownPackage + ".") &&
                u.getRawPath() != null && u.getRawPath().length() > 1;
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
