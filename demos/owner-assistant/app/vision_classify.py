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
    lines = [
        "你是珠宝相册分类器。逐张看图，只按珠宝本体外形分类，不按背景分类。",
        "category 只能是：手串-手链、项链、吊坠-挂件、待确认。",
        "对每个文件返回一个对象，必须覆盖下面所有文件。只返回 JSON：{\"items\":[{\"file\":\"原文件名\",\"category\":\"类别\"}]}",
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
        "max_tokens": 1600,
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
                return parsed, {"batch": batch_no, "model": body.get("model", "deepseek-flash"), "usage": body.get("usage", {})}
            raise ValueError("vision response has no items list")
        except Exception as exc:  # retry transient provider or JSON errors
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"vision batch {batch_no} failed: {last}")


def normalise(items, batch):
    by_name = {p.name: p for p in batch}
    result = {}
    for item in items:
        if not isinstance(item, dict):
            continue
        name = str(item.get("file", "")).strip()
        category = str(item.get("category", "待确认")).strip()
        if name in by_name and category in CATEGORIES:
            result[name] = category
    return result


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: vision_classify.py SOURCE_DIR OUTPUT_DIR")
    source = Path(sys.argv[1])
    output = Path(sys.argv[2])
    key = key_from_env()
    files = sorted([p for p in source.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}], key=lambda p: p.name)
    if not files:
        raise SystemExit("no images in source directory")

    generated = output / "分类结果"
    manifest_path = output / "分类结果.json"
    if generated.exists():
        shutil.rmtree(generated)
    if manifest_path.exists():
        manifest_path.unlink()
    for category in CATEGORIES:
        (generated / category).mkdir(parents=True, exist_ok=True)
    thumbs = output / "_vision_cache"
    thumbs.mkdir(parents=True, exist_ok=True)

    assigned = {}
    calls = []
    errors = []
    for start in range(0, len(files), 10):
        batch = files[start : start + 10]
        try:
            parsed, call_meta = call_vision(key, batch, thumbs, start // 10 + 1)
            assigned.update(normalise(parsed.get("items", []), batch))
            calls.append(call_meta)
        except Exception as exc:
            # Keep the run usable and auditable when one provider batch is unavailable.
            errors.append({"batch": start // 10 + 1, "error": str(exc)[:300]})

    # A missing or malformed model row remains visible instead of being guessed.
    for path in files:
        assigned.setdefault(path.name, "待确认")
    rows = []
    for path in files:
        category = assigned[path.name]
        target = generated / category / path.name
        shutil.copy2(path, target)
        import hashlib
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        rows.append({"file": path.name, "source": str(path), "group": category, "classified_copy": str(target), "sha256": digest, "bytes": path.stat().st_size})
    counts = {category: sum(1 for row in rows if row["group"] == category) for category in CATEGORIES}
    manifest = {
        "title": "MVP 蜜蜡 103-238 DeepSeek 视觉分类",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "sourceRoot": str(source),
        "fileCount": len(rows),
        "groups": counts,
        "classificationMode": "deepseek_vision",
        "model": "deepseek-flash",
        "batchSize": 10,
        "providerCalls": len(calls),
        "errors": errors,
        "originalsModified": False,
        "items": rows,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"total": len(rows), "groups": counts, "resultRoot": str(generated), "manifestPath": str(manifest_path), "model": "deepseek-flash", "providerCalls": len(calls), "failedBatches": len(errors)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
