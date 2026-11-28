# 当前云端 MVP 源码

此目录同步自实际运行的云端发布 `20261128-image-selfservice-r1`。保留共用首页、相册整理、商品卡待办与续查、销售接待及同一会话同步，新增对话发图、上传图换背景、已有片查询和参考视频工作流。风格入口只聚焦输入框，保留原文字，不自动发送。

公开版使用合成演示商品和示例店铺，保留已有的可移植路径。配套生产配置、原图/视频、正式商品文案、价表、任务数据库、模型密钥和签名包不在仓库。<strong>这里只更新云端网页和后端代码</strong>；[Android 目录](../../android/ip-preview/README.md) 仍是独立的公开壳，不代表最新安装包。

## 本地运行及验证

需要 Node 22.13+ 和 Python 3.10+。先清空模型密钥和外部生产配置；请选独立的工作目录。

```sh
python -m pip install -r requirements.txt
python create-demo-data.py
npm ci
npm start
```

打开 `http://127.0.0.1:33113/`。`npm test` 验证四个工具的离线路由；`node --test smoke.test.mjs` 使用临时合成资料验证相册、商品卡和销售会话。模型未配置时，生成工作流保留入口和本地逻辑，不会自动变成生产数据或产生模型费用。

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | Node 回环端口，默认 33113 |
| `MVP_DATA_DIR` / `MVP_SOURCE_DIR` / `MVP_ALBUM_V2_DIR` | 数据目录、输入图、版本化相册目录，默认在本目录的 `data/` 下 |
| `MVP_PRICE_SOURCE` / `MVP_PYTHON` | 资料表、Python 路径（可选） |
| `MVP_FIXTURE=1` | 离线样例，不请求模型 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_VISION_MODEL` | 服务端模型配置 |
| `MVP_AUTH_REQUIRED` / `MVP_ACCESS_PASSWORD` / `MVP_SESSION_SECRET` / `MVP_COOKIE_SECURE` | 面向网络部署时环境注入，并使用 HTTPS 和安全 cookie |
| `MVP_MESSAGE_IMAGE_GENERATE` / `MVP_IMAGE_GENERATE` / `MVP_REFERENCE_VIDEO_GENERATE` | 分别控制上传图、批量图片和参考视频的新制作，默认关闭 |

媒体制作还需要独立配置供应商与自有素材。参考视频最终合成另依赖 FFmpeg/ffprobe、OpenCV、NumPy 以及可用字体；这部分环境与素材独立于合成演示，不提交到仓库。不要在公开仓填写生产密钥或上传客户资料。
