"""Run the MVP's real DeepSeek vision album classification.

The original images stay in place.  Only generated copies and a manifest are
written below the MVP demo directory.
"""
import base64
import json
import mimetypes
import os
import re
import shutil
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from album_publish import publish

try:
    from PIL import Image, ImageOps, ImageDraw
except Exception as exc:  # pragma: no cover - exercised by the runtime check
    raise SystemExit(f"Pillow is required for vision MVP: {exc}")

CATEGORIES = ["手串-手链", "项链", "吊坠-挂件", "待确认"]


def key_from_env() -> str:
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key.startswith("sk-"):
        raise SystemExit("DEEPSEEK_API_KEY is not available to vision runner")
    return key


def data_url(path: Path, thumb_dir: Path) -> str:
    thumb_dir.mkdir(parents=True, exist_ok=True)
    thumb = thumb_dir / f"{path.stem}.jpg"
    if not thumb.exists():
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((512, 512))
            image.save(thumb, "JPEG", quality=72, optimize=True)
    encoded = base64.b64encode(thumb.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{encoded}"


def call_vision(key: str, batch, thumb_dir: Path, batch_no: int):
    taxonomy = json.loads(Path(__file__).with_name("taxonomy.json").read_text("utf8"))
    labels = [item["legacyGroup"] + ": " + "、".join(q["label"] for q in taxonomy["subtypes"] if q["parentId"] == item["id"])
              for item in taxonomy["categories"]]
    lines = [
        "你是珠宝相册分类器。逐张看图，只按珠宝本体外形分类，不按背景分类。",
        "category 只能是：手串-手链、项链、吊坠-挂件、待确认。",
        "对每个文件返回一个对象，必须覆盖下面所有文件。只返回 JSON：{\"items\":[{\"file\":\"原文件名\",\"category\":\"类别\",\"type\":\"细类或空字符串\"}]}",
        "每行附 type：只用下列对应细类中文名，不确定则给空字符串。不要用材质或背景猜身份：",
        *labels,
        "细类不确定只保留已明确的大类；大类也不确定时 category=待确认 且 type 为空。必须有且只有每个文件的一行。",
        "本批文件：",
    ]
    for idx, path in enumerate(batch, 1):
        lines.append(f"{idx}. {path.name}")
    content = [{"type": "text", "text": "\n".join(lines)}]
    for path in batch:
        content.append({"type": "image_url", "image_url": {"url": data_url(path, thumb_dir), "detail": "low"}})
    payload = {
        "model": "deepseek-flash",
        "messages": [{"role": "user", "content": content}],
        "temperature": 0,
        "max_tokens": 6144,
        "response_format": {"type": "json_object"},
    }
    request = urllib.request.Request(
        "https://api.deepseek.com/chat/completions",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
    )
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.loads(response.read())
            message = body.get("choices", [{}])[0].get("message", {})
            text = message.get("content", "")
            parsed = json.loads(text)
            if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
                return parsed, {"batch": batch_no, "model": body.get("model", "deepseek-flash"), "usage": body.get("usage", {}), "providerId": body.get("id")}
            raise ValueError("vision response has no items list")
        except Exception as exc:  # retry transient provider or JSON errors
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"vision batch {batch_no} failed: {last}")


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: vision_classify.py SOURCE_DIR OUTPUT_DIR")
    source,output=map(Path,sys.argv[1:])
    try:
        result=publish(source,output,key_from_env(),call_vision,CATEGORIES)
    except Exception as exc:
        # Do not echo arbitrary external error text.
        print(json.dumps({"publishStatus":"not_published","code":"ALBUM_BATCH_NOT_PUBLISHED",
                          "reasonType":type(exc).__name__}),file=sys.stderr)
        return 1
    print(json.dumps(result,ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
