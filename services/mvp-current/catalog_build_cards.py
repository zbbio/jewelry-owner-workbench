"""Build one JSON product-card draft per classified image."""
import base64
import json
import os
import shutil
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps
from openpyxl import load_workbook

CATEGORIES = {"手串-手链", "项链", "吊坠-挂件", "待确认"}
_default_price = str(Path(os.environ.get("MVP_DATA_DIR") or Path(__file__).resolve().parent / "data") / "price.xlsx")
PRICE_SOURCE = Path(os.environ.get("MVP_PRICE_SOURCE", _default_price))


def key_from_env():
    key = os.environ.get("DEEPSEEK_API_KEY", "")
    if not key.startswith("sk-"):
        raise SystemExit("DEEPSEEK_API_KEY is not available to catalog runner")
    return key


def load_prices(source):
    if not source.exists():
        raise SystemExit(f"price workbook not found: {source}")
    workbook = load_workbook(source, read_only=True, data_only=True)
    sheet = workbook.active
    prices = {}
    for row in sheet.iter_rows(min_row=2, values_only=True):
        filename = str(row[0]).strip() if row and row[0] else ""
        if filename:
            prices[filename] = row[6] if len(row) > 6 else None
    if not prices:
        raise SystemExit("price workbook has no filename/price rows")
    return prices


def image_data(path, cache):
    cache.mkdir(parents=True, exist_ok=True)
    thumb = cache / f"{path.stem}.jpg"
    if not thumb.exists():
        with Image.open(path) as image:
            image = ImageOps.exif_transpose(image).convert("RGB")
            image.thumbnail((512, 512))
            image.save(thumb, "JPEG", quality=72, optimize=True)
    return "data:image/jpeg;base64," + base64.b64encode(thumb.read_bytes()).decode("ascii")


def classify_batch(key, batch, cache, batch_no):
    names = "\n".join(f"{i}. {p.name}" for i, p in enumerate(batch, 1))
    prompt = (
        "你是珠宝商品资料整理器。逐张看图，为每个文件生成一个结构化商品卡草稿。"
        "只返回JSON，不要解释。不要猜价格、尺寸、证书；看不清就写待核实。"
        "category只能是手串-手链、项链、吊坠-挂件、待确认。"
        "JSON格式：{\"items\":[{\"file\":\"原文件名\",\"name\":\"简短名称\","
        "\"category\":\"类别\",\"type\":\"具体类型\",\"color\":\"颜色\","
        "\"material\":\"材质\",\"shape\":\"形态\",\"size\":\"待核实\","
        "\"price\":\"待核实\",\"certificate\":\"待核实\","
        "\"description\":\"基于图片的客观描述\",\"needsConfirmation\":[\"需要确认的字段\"]}]}"
        "\n本批文件：\n" + names
    )
    content = [{"type": "text", "text": prompt}]
    for path in batch:
        content.append({"type": "image_url", "image_url": {"url": image_data(path, cache), "detail": "low"}})
    payload = {"model": "deepseek-flash", "messages": [{"role": "user", "content": content}], "temperature": 0, "max_tokens": 6000, "response_format": {"type": "json_object"}}
    req = urllib.request.Request("https://api.deepseek.com/chat/completions", data=json.dumps(payload, ensure_ascii=False).encode("utf-8"), headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=120) as response:
                body = json.loads(response.read())
            text = body.get("choices", [{}])[0].get("message", {}).get("content", "")
            parsed = json.loads(text)
            if isinstance(parsed, dict) and isinstance(parsed.get("items"), list):
                return parsed["items"], {"batch": batch_no, "model": body.get("model", "deepseek-flash"), "usage": body.get("usage", {})}
            raise ValueError("response has no items")
        except Exception as exc:
            last = exc
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"catalog batch {batch_no} failed: {last}")


def main():
    if len(sys.argv) != 2:
        raise SystemExit("usage: catalog_build_cards.py MVP_DEMO_DIR")
    base = Path(sys.argv[1])
    manifest_path = base / "分类结果.json"
    if not manifest_path.exists():
        raise SystemExit("分类结果.json not found; run 相册整理 first")
    album = json.loads(manifest_path.read_text(encoding="utf-8"))
    items = album.get("items", [])
    if not items:
        raise SystemExit("分类结果没有图片条目")
    output = base / "商品卡"
    index_path = base / "商品卡索引.json"
    if output.exists():
        shutil.rmtree(output)
    if index_path.exists():
        index_path.unlink()
    output.mkdir(parents=True, exist_ok=True)
    cache = base / "_catalog_cache"
    cache.mkdir(parents=True, exist_ok=True)
    source_paths = [Path(item["classified_copy"]) for item in items]
    key = key_from_env()
    embedded_price_source = base / "分类结果" / PRICE_SOURCE.name
    shutil.copy2(PRICE_SOURCE, embedded_price_source)
    prices = load_prices(embedded_price_source)
    by_name = {p.name: p for p in source_paths}
    model_rows = {}
    calls = []
    errors = []
    for start in range(0, len(source_paths), 10):
        batch = source_paths[start : start + 10]
        try:
            rows, meta = classify_batch(key, batch, cache, start // 10 + 1)
            for row in rows:
                if isinstance(row, dict) and row.get("file") in by_name:
                    model_rows[row["file"]] = row
            calls.append(meta)
        except Exception as exc:
            errors.append({"batch": start // 10 + 1, "error": str(exc)[:300]})

    cards = []
    for item in items:
        filename = Path(item["classified_copy"]).name
        model = model_rows.get(filename, {})
        group = item.get("group", "待确认") if item.get("group") in CATEGORIES else "待确认"
        card_id = Path(filename).stem
        card = {
            "schemaVersion": "jewelry.product-card.v1",
            "cardId": card_id,
            "status": "draft",
            "sourceImage": item.get("source", ""),
            "classifiedImage": item.get("classified_copy", ""),
            "albumGroup": group,
            "name": model.get("name") or f"蜜蜡{group}",
            "category": model.get("category") if model.get("category") in CATEGORIES else group,
            "type": model.get("type", "待核实"),
            "color": model.get("color", "待核实"),
            "material": model.get("material", "蜜蜡（待核实）"),
            "shape": model.get("shape", "待核实"),
            "size": "待核实",
            "price": prices.get(filename, "待核实"),
            "priceType": "建议价（Excel）" if filename in prices else "待核实",
            "priceSource": str(embedded_price_source) if filename in prices else "",
            "certificate": "待核实",
            "description": model.get("description", "待补充图片核验描述"),
            "needsConfirmation": [x for x in (model.get("needsConfirmation") if isinstance(model.get("needsConfirmation"), list) else ["尺寸", "证书"]) if x != "价格"],
            "evidence": [filename],
            "model": "deepseek-flash",
            "generatedAt": datetime.now(timezone.utc).isoformat(),
        }
        (output / f"{card_id}.json").write_text(json.dumps(card, ensure_ascii=False, indent=2), encoding="utf-8")
        cards.append(card)
    index = {"schemaVersion": "jewelry.product-card-index.v1", "classificationSource": str(manifest_path), "priceSource": str(embedded_price_source), "priceSourceOriginal": str(PRICE_SOURCE), "priceMatched": sum(1 for card in cards if card["priceType"] == "建议价（Excel）"), "cardsDirectory": str(output), "fileCount": len(cards), "providerCalls": len(calls), "errors": errors, "model": "deepseek-flash", "generatedAt": datetime.now(timezone.utc).isoformat(), "cards": cards}
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"total": len(cards), "cardsDirectory": str(output), "indexPath": str(index_path), "providerCalls": len(calls), "failedBatches": len(errors), "classificationMode": "deepseek_vision"}, ensure_ascii=False))


if __name__ == "__main__":
    main()
