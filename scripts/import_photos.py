#!/usr/bin/env python3
"""把新照片（PNG／JPEG）轉成相簿用的 JPEG：裁成 4:5 直式、去除所有中繼資料。

用法（在 repo 根目錄執行）：
    python3 scripts/import_photos.py 來源資料夾 --prefix call
        來源資料夾裡的圖片會依檔名排序，輸出成 photos/call-01.jpg、call-02.jpg…
    python3 scripts/import_photos.py 來源資料夾 --prefix call --anchor top
        裁切時固定上緣（預設），只裁掉下方多餘的部分；--anchor center / bottom 則固定中間或下緣

轉好之後再執行 python3 scripts/make_images.py 產生 WebP 版本，
並把每張的說明與尺寸寫進 photos/call-photos.json 與 data.js 的 callPhotos。

視訊回憶照片（2026 年 10 月）就是用這個腳本從 1206×1560 的截圖裁成 1200×1500。

需要 Pillow：pip install Pillow
"""
import argparse
import pathlib
import sys

try:
    from PIL import Image, ImageOps
except ImportError:  # pragma: no cover
    sys.exit("需要 Pillow 套件：pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
PHOTOS = ROOT / "photos"
RATIO = (4, 5)          # 相簿統一 4:5 直式
JPEG_QUALITY = 88
EXTS = {".png", ".jpg", ".jpeg", ".webp"}


def crop_4x5(im: Image.Image, anchor: str) -> Image.Image:
    """裁成 4:5；寬與高都取 4 與 5 的倍數，比例才會剛好。"""
    w, h = im.size
    if w * RATIO[1] > h * RATIO[0]:          # 太寬：裁寬度
        new_h = h - h % RATIO[1]
        new_w = new_h * RATIO[0] // RATIO[1]
    else:                                    # 太高：裁高度
        new_w = w - w % RATIO[0]
        new_h = new_w * RATIO[1] // RATIO[0]
    left = (w - new_w) // 2
    if anchor == "top":
        top = 0
    elif anchor == "bottom":
        top = h - new_h
    else:
        top = (h - new_h) // 2
    return im.crop((left, top, left + new_w, top + new_h))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("src", type=pathlib.Path, help="來源資料夾")
    parser.add_argument("--prefix", default="call", help="輸出檔名前綴（預設 call → photos/call-01.jpg）")
    parser.add_argument("--anchor", choices=("top", "center", "bottom"), default="top", help="裁切時固定哪一邊（預設 top）")
    parser.add_argument("--out", type=pathlib.Path, default=PHOTOS, help="輸出資料夾（預設 photos/）")
    args = parser.parse_args()

    sources = sorted(p for p in args.src.iterdir() if p.suffix.lower() in EXTS)
    if not sources:
        sys.exit(f"{args.src} 裡找不到圖片")
    args.out.mkdir(parents=True, exist_ok=True)
    for i, src in enumerate(sources, 1):
        with Image.open(src) as im:
            im = ImageOps.exif_transpose(im).convert("RGB")   # 轉成 RGB、不帶任何 EXIF／ICC
            im = crop_4x5(im, args.anchor)
            target = args.out / f"{args.prefix}-{i:02d}.jpg"
            # 不傳 exif / icc_profile，輸出的 JPEG 就沒有中繼資料
            im.save(target, "JPEG", quality=JPEG_QUALITY, optimize=True, progressive=True)
            print(f"{src.name} → {target.relative_to(ROOT) if target.is_relative_to(ROOT) else target}  {im.width}x{im.height}")
    print("完成。接著執行 python3 scripts/make_images.py 產生 WebP。")


if __name__ == "__main__":
    main()
