# 当前云端 MVP 源码

来源：线上发布 `20261127-album-catalog`，包括新版移动首页、Node 后端、相册视觉调用与整批发布、颜色/资料材质筛选、按已核货号承接分类、销售草稿和三镜头内容能力。Android IP 预览外壳复用同一网页与服务，见 [构建说明](../../android/ip-preview/README.md)。安然顾客自动接待及 Windows 独立演示仍在原项目入口，不是此云路由的额外功能。

这个公开副本保留业务调用链；本机私有路径改为环境变量，演示 SKU 和销售素材换成合成样例，商家的展示文案表留空。生产账号、原图、真实销售资料、价表、密钥和签名包不在仓库。

## 本地运行

需要 Node 22+、Python 3.10+。在本目录执行：

```sh
python -m pip install -r requirements.txt
python create-demo-data.py
npm start
```

打开 `http://127.0.0.1:33113/`。默认无模型密钥时走离线样例；相册页展示生成的合成图片，回复不意味着重新识图。运行 `npm test` 检查首页、请求路由、相册/筛选/媒体与已有卡继承逻辑。测试不需要 DeepSeek 密钥和任何商店数据。

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | Node 回环端口，默认 33113 |
| `MVP_DATA_DIR` / `MVP_SOURCE_DIR` / `MVP_ALBUM_V2_DIR` | 指定数据、输入图、版本化相册目录；默认均在本目录的 `data/` 下 |
| `MVP_PRICE_SOURCE` / `MVP_PYTHON` | 自备资料表路径、Python 路径（可选） |
| `MVP_FIXTURE=1` | 显式运行离线样例，不请求模型 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_VISION_MODEL` | 服务端接入时按模型服务配置；请勿提交密钥 |
| `MVP_AUTH_REQUIRED` / `MVP_ACCESS_PASSWORD` / `MVP_SESSION_SECRET` / `MVP_COOKIE_SECURE` | 对外部署时由部署环境提供；使用 HTTPS 反向代理与安全 cookie |

离线可用来验入口和数据呈现。真实模型测试应使用允许传给模型服务的独立测试数据；正式的图片、商户索引与原签名交由部署环境管理。
