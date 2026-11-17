#!/usr/bin/env python3
"""產生測試用的圖片（都是合成的範例圖，沒有任何真實照片或真實的拍攝資料）。

sample-N-full.jpg 是三張寫著 SAMPLE 的漸層圖卡（已經在這個資料夾裡）。這個腳本由它們做出：
  sample-N-thumb.jpg   縮圖（長邊 800）
  with-metadata.jpg    故意塞滿中繼資料的 JPEG：Exif（假的裝置、時間與 GPS 座標）、XMP、ICC、註解、檔尾多餘資料
  phone-like.jpg       模仿手機照片：橫向儲存、Exif 註明「要轉 90 度看」，也帶 GPS
  not-a-jpeg.png       不是 JPEG 的檔案
  gray.jpg             只有一個色版（灰階）的 JPEG
  cmyk.jpg             四個色版（CMYK）的 JPEG：瀏覽器的支援不一致，伺服器不收

GPS 用的是東京鐵塔的座標（公開地標），只是為了確認「上傳後座標會被去掉」。
用法：python3 make_fixtures.py（需要 Pillow）
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageCms

HERE = Path(__file__).resolve().parent
LAT = ((35, 1), (39, 1), (3096, 100))     # 35°39'30.96" N
LON = ((139, 1), (44, 1), (4344, 100))    # 139°44'43.44" E


def segment(marker, payload):
    return bytes([0xFF, marker]) + struct.pack(">H", len(payload) + 2) + payload


def exif_bytes(orientation=1):
    exif = Image.Exif()
    exif[0x010F] = "TestPhone Inc."
    exif[0x0110] = "TestPhone 99"
    exif[0x0112] = orientation
    exif[0x0132] = "2026:11:14 12:34:56"
    exif[0x8825] = {1: "N", 2: tuple(a / b for a, b in LAT), 3: "E", 4: tuple(a / b for a, b in LON)}
    data = exif.tobytes()
    return data if data.startswith(b"Exif\x00\x00") else b"Exif\x00\x00" + data


def with_segments(jpeg, segments, trailer=b""):
    """把區段插在檔頭（SOI 與 JFIF）後面"""
    assert jpeg[:2] == b"\xff\xd8"
    pos = 2
    if jpeg[2:4] == b"\xff\xe0":
        pos = 4 + struct.unpack(">H", jpeg[4:6])[0]
    return jpeg[:pos] + b"".join(segments) + jpeg[pos:] + trailer


def encode(im, **options):
    out = io.BytesIO()
    im.save(out, "JPEG", **options)
    return out.getvalue()


def main():
    for n in (1, 2, 3):
        full = Image.open(HERE / f"sample-{n}-full.jpg").convert("RGB")
        thumb = full.copy()
        thumb.thumbnail((800, 800), Image.LANCZOS)
        (HERE / f"sample-{n}-thumb.jpg").write_bytes(encode(thumb, quality=82, optimize=True))

    base = Image.open(HERE / "sample-3-full.jpg").convert("RGB").resize((600, 400), Image.LANCZOS)
    icc = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    xmp = b"http://ns.adobe.com/xap/1.0/\x00" + (
        b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
        b'<rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" dc:creator="Test Owner" dc:description="private note in XMP"/>'
        b"</rdf:RDF></x:xmpmeta>")
    segments = [
        segment(0xE1, exif_bytes()),
        segment(0xE1, xmp),
        segment(0xE2, b"ICC_PROFILE\x00\x01\x01" + icc),
        segment(0xFE, b"comment: taken at Tokyo Tower"),
    ]
    (HERE / "with-metadata.jpg").write_bytes(with_segments(encode(base, quality=85), segments, trailer=b"TRAILER-DATA-AFTER-END-OF-IMAGE"))

    # 手機常見的情況：感光元件是橫的，直著拿拍的照片以橫向儲存，再用 Exif 的 Orientation=6 註明「順時針轉 90 度看」
    portrait = Image.open(HERE / "sample-1-full.jpg").convert("RGB").resize((1500, 2000), Image.LANCZOS)
    stored = portrait.transpose(Image.ROTATE_90)          # 逆時針轉 90 度後儲存 → 2000×1500
    (HERE / "phone-like.jpg").write_bytes(with_segments(encode(stored, quality=85), [segment(0xE1, exif_bytes(orientation=6))]))

    Image.new("RGB", (64, 64), (243, 185, 201)).save(HERE / "not-a-jpeg.png")
    other_color_modes()

    for path in sorted(HERE.glob("*.jpg")) + sorted(HERE.glob("*.png")):
        im = Image.open(path)
        gps = im.getexif().get_ifd(0x8825) if path.suffix == ".jpg" else {}
        print(f"{path.name:22} {im.size[0]}x{im.size[1]}  {path.stat().st_size // 1024:4d} KB  gps={'yes' if gps else 'no'}  orientation={im.getexif().get(0x0112) if path.suffix == '.jpg' else '-'}")


def other_color_modes():
    small = Image.open(HERE / "sample-3-full.jpg").convert("RGB").resize((96, 64), Image.LANCZOS)
    (HERE / "gray.jpg").write_bytes(encode(small.convert("L"), quality=85))
    (HERE / "cmyk.jpg").write_bytes(encode(small.convert("CMYK"), quality=85))


if __name__ == "__main__":
    main()
