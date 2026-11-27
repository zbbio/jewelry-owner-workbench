"""Create synthetic workflow data only; never copy a merchant's photos or prices."""
import hashlib
import json
import os
from pathlib import Path
import shutil

from PIL import Image, ImageDraw
from openpyxl import Workbook

ROOT = Path(__file__).resolve().parent
DATA = Path(os.environ.get("MVP_DATA_DIR") or ROOT / "data").resolve()


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def main():
    if DATA.exists() and any(DATA.iterdir()):
        raise SystemExit("Data directory is not empty; use a separate copy instead of overwriting existing data.")
    source, demo = DATA / "source", DATA / "demo"
    source.mkdir(parents=True)
    rows, cards = [], []
    names = ["手串-手链", "项链", "吊坠-挂件"]
    book = Workbook()
    sheet = book.active
    sheet.append(["filename", "name", "category", "material", "size", "certificate", "price"])
    for i in range(130):
        sku = f"DEMO{i + 103}"
        filename = sku + ".jpg"
        category = names[i % 3]
        picture = Image.new("RGB", (320, 320), "#f5f7f2")
        draw = ImageDraw.Draw(picture)
        draw.ellipse((65, 65, 255, 255), outline="#b88b40", width=16)
        draw.text((12, 12), "SYNTHETIC " + sku, fill="#174b3c")
        picture.save(source / filename, quality=80)
        target = demo / "分类结果" / category / filename
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / filename, target)
        price = 240 if sku == "DEMO103" else 260 if sku == "DEMO105" else 100 + i
        sheet.append([filename, "合成示意商品", category, "待核实", "待核实", "待核实", price])
        rows.append({"file": filename, "source": str(source / filename), "group": category, "classified_copy": str(target), "sha256": hashlib.sha256(target.read_bytes()).hexdigest(), "bytes": target.stat().st_size})
        card = {"schemaVersion": "jewelry.product-card.v1", "cardId": sku, "status": "draft", "sourceImage": str(source / filename), "classifiedImage": str(target), "albumGroup": category, "name": "合成示意商品 " + sku, "category": category, "type": "合成示意", "color": "金色示意线", "material": "待核实", "shape": "合成圆形示意图", "size": "待核实", "price": price, "priceType": "合成示例价", "priceSource": str(DATA / "price.xlsx"), "certificate": "待核实", "description": "只测试流程的程序绘图，不是真实珠宝。", "needsConfirmation": ["材质", "尺寸", "证书"], "evidence": [filename], "model": "synthetic-fixture"}
        cards.append(card)
        save(demo / "商品卡" / (sku + ".json"), card)
    book.save(DATA / "price.xlsx")
    book.close()
    album = {"title": "公开合成演示相册", "sourceRoot": str(source), "fileCount": len(rows), "groups": {name: sum(r["group"] == name for r in rows) for name in names}, "classificationMode": "fixture", "model": "synthetic-fixture", "providerCalls": 0, "errors": [], "originalsModified": False, "items": rows}
    index = {"schemaVersion": "jewelry.product-card-index.v1", "classificationSource": str(demo / "分类结果.json"), "priceSource": str(DATA / "price.xlsx"), "priceSourceOriginal": str(DATA / "price.xlsx"), "cardsDirectory": str(demo / "商品卡"), "fileCount": len(cards), "priceMatched": len(cards), "providerCalls": 0, "errors": [], "model": "synthetic-fixture", "cards": cards}
    for name, value in [("分类结果.json", album), ("商品卡索引.json", index)]:
        save(demo / name, value)
        save(DATA / "seed/demo" / name, value)
    (DATA / "videos").mkdir()
    album_v2 = Path(os.environ.get("MVP_ALBUM_V2_DIR") or DATA / "demo-20261127-ac").resolve()
    if album_v2 != demo:
        shutil.copytree(demo, album_v2, ignore=shutil.ignore_patterns("商品卡", "商品卡索引.json"))
    print("Created 130 synthetic images and draft cards; 0 model calls; no merchant data.")


if __name__ == "__main__":
    main()
