# 本轮云端演示访问控制源码

`access.mjs` 直接复制现有 MVP 云端演示版本：密码登录、scrypt 校验、HMAC Cookie、HttpOnly/SameSite、可选 Secure、请求体上限和简单频率限制。没有携带访问密码、会话签名秘密、服务器地址或员工登录脚本。

这是**独立的原有云端模块**，并未在本次 GitHub 同步中接进新店铺双窗或执行部署。文件存在并不证明公网、安卓或生产鉴权已验；其进程内限流也不是多实例防护方案。不要直接把公开本地示例暴露到公网。

调用前以秘密管理工具注入 `MVP_AUTH_REQUIRED=1`、至少16字符的 `MVP_ACCESS_PASSWORD`，HTTPS环境设置 `MVP_COOKIE_SECURE=1`；可另设 `MVP_SESSION_SECRET` 以维持重启会话。不要把这些值提交到 Git。业务服务先 `await allowRequest(req,res)`；返回 false 时响应已处理，不继续业务路由。`readBody` 默认限制16KB。

无密钥、无模型、只监听本机的模块测试：

```powershell
node services/mvp-cloud-access/test-access.mjs
```

测试合成的随机密码，不读取任何商家数据。检查未登录拒绝、登录 Cookie、篡改/过期会话、错误密码、开放重定向限制和请求体大小；不等于完整云端发布或浏览器双窗验收。自有代码沿用根 MIT。
