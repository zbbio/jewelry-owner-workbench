# Android 当前 IP 预览壳

这是现有云端 MVP APK 的 Android 原生源文件（不是重新实现网页）：包名 `com.zbbio.jewelryassistant.n14`，版本 `1.2.0-ip-preview`（versionCode 3）。WebView 仅允许既定的 **HTTP 8083 公网预览**来源。此版本不是正式 HTTPS 版本；不要通过预览发送密码或敏感数据。网页与后端见 [当前云端 MVP](../../services/mvp-current/README.md)。

## 构建未签名 APK（Windows）

用 Python 3、JDK 17、Android SDK 34 和 Build Tools 34.0.0。工具链目录布局为 `jdk/` 与 `sdk/` 两个子目录。在本目录运行：

```powershell
python build_unsigned.py --toolchain-root 'C:/path/to/AndroidN14'
```

脚本会运行 JVM 来源策略单测并编译、校验 APK；产物为 `build/jewelry-owner-ip-preview-unsigned.apk`。如需安装，自行使用测试签名；使用不同签名的 APK 不可覆盖安装已有的同包名正式签名包。原签名私钥和云端 APK 二进制没有提交。
