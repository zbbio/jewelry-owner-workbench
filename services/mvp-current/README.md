# 当前云端 MVP 源码

来源：线上发布 `20261127-catalog-resume`。这份源码覆盖移动首页、相册整理和商品卡批量同步的断线续查、现有相册与商品卡查看、顾客自动接待和店主同步、销售草稿与拍摄清单。同一次批量同步按任务编号续查，只绑定已完成相册，不重新识图。

Android IP 预览外壳使用同一网页和后端，见 [Android 源码和构建说明](../../android/ip-preview/README.md)。这次只有云端改动，Android 外壳不需要修改或重新编译。旧的 Windows 独立演示入口继续保留。

公开副本沿用环境变量、合成商品和示例店铺；生产素材、原图、真实销售资料、价表、任务数据库、模型密钥和签名包不在仓库。

## 本地运行

需要 Node 22.13+、Python 3.10+。在本目录执行：

```sh
python -m pip install -r requirements.txt
python create-demo-data.py
npm start
```

打开 `http://127.0.0.1:33113/`。默认无模型密钥时走离线样例；相册页展示生成的合成图片，回复不意味着重新识图。运行 `npm test` 检查商品卡任务回执与幂等、相册媒体、草稿和客服原会话同步。相册重分类与顾客自动接待需要配置模型；测试使用合成数据与模型替身，不需要密钥。

| 环境变量 | 用途 |
| --- | --- |
| `PORT` | Node 回环端口，默认 33113 |
| `MVP_DATA_DIR` / `MVP_SOURCE_DIR` / `MVP_ALBUM_V2_DIR` | 指定数据、输入图、版本化相册目录；默认均在本目录的 `data/` 下 |
| `MVP_PRICE_SOURCE` / `MVP_PYTHON` | 自备资料表路径、Python 路径（可选） |
| `ALBUM_JOBS_DB_DIR` / `ANRAN_CLOUD_DB_DIR` | 两个本地 SQLite 状态目录，线上用可持久化、仅服务可写的目录 |
| `MVP_FIXTURE=1` | 显式运行离线样例，不请求模型 |
| `DEEPSEEK_API_KEY` / `DEEPSEEK_MODEL` / `DEEPSEEK_VISION_MODEL` | 服务端接入时按模型服务配置；请勿提交密钥 |
| `MVP_AUTH_REQUIRED` / `MVP_ACCESS_PASSWORD` / `MVP_SESSION_SECRET` / `MVP_COOKIE_SECURE` | 对外部署时由部署环境提供；使用 HTTPS 反向代理与安全 cookie |

离线可用来验入口和数据呈现。真实模型测试应使用允许传给模型服务的独立测试数据；正式的图片、商户索引与原签名交由部署环境管理。
