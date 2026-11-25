package com.zbbio.jewelryassistant.n14;
public final class AlbumPickerPolicyTest {
    private static int n;
    private static void check(boolean v) { if(!v)throw new AssertionError("check " + (n+1)); n++; }
    public static void main(String[] args) {
        String pkg="com.zbbio.jewelryassistant.n14";
        check(AlbumPickerPolicy.imageAccept(new String[]{"image/jpeg,image/png,image/webp"}));
        check(AlbumPickerPolicy.imageAccept(new String[]{"image/*"}));
        check(!AlbumPickerPolicy.imageAccept(new String[]{}));
        check(!AlbumPickerPolicy.imageAccept(new String[]{"image/jpeg","*/*"}));
        check(!AlbumPickerPolicy.imageAccept(new String[]{"image/svg+xml"}));
        check(AlbumPickerPolicy.imageMime("IMAGE/PNG"));
        check(!AlbumPickerPolicy.imageMime("application/octet-stream"));
        check(!AlbumPickerPolicy.imageMime("image/heic"));
        check(!AlbumPickerPolicy.countAllowed(0,true));
        check(AlbumPickerPolicy.countAllowed(1,false));
        check(!AlbumPickerPolicy.countAllowed(2,false));
        check(AlbumPickerPolicy.countAllowed(12,true));
        check(!AlbumPickerPolicy.countAllowed(13,true));
        check(AlbumPickerPolicy.contentUri("content://com.android.providers.media.documents/document/image%3A2281",pkg));
        check(!AlbumPickerPolicy.contentUri("file:///sdcard/Download/test.jpg",pkg));
        check(!AlbumPickerPolicy.contentUri("content://0@com.android.providers.media.documents/document/image%3A1",pkg));
        check(!AlbumPickerPolicy.contentUri("content://"+pkg+".internal/whatever.jpg",pkg));
        check(!AlbumPickerPolicy.contentUri("content://some.provider/a.jpg#fragment",pkg));
        check(!AlbumPickerPolicy.contentUri("https://example.invalid/a.jpg",pkg));
        check(!AlbumPickerPolicy.contentUri("content://some.provider/",pkg));
        System.out.println("AlbumPickerPolicy: " + n + " checks passed");
    }
}
