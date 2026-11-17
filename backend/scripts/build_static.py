#!/usr/bin/env python3
"""產生私密區兩個服務用的靜態檔。

1. 把公開網站的樣式（../styles.css）裡私密區也會用到的部分抽出來，接上私密區自己的樣式（styles/room-extra.css），
   產生訪客端的 visitor/public/room.css。私密區是另一個網站（另一個網址），不能直接載入公開網站的 CSS；
   用這個方式讓兩邊的顏色、字級、頁首頁尾保持一致。
2. 把管理頁要用的樣式、腳本與圖示包進一個程式模組 admin/src/static.generated.js。
   管理端不使用「靜態檔案」功能：每個檔案都由 Worker 在確認管理者身分之後才送出。

公開網站的 styles.css、styles/ 或 admin/client/ 改了以後，請重新執行：python3 backend/scripts/build_static.py
（node --test 會檢查有沒有忘記；加上 --check 只檢查、不寫檔）。
"""
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent.parent
SITE_CSS = HERE.parent / "styles.css"

# 要保留的規則：選擇器以這些開頭（元素的基本樣式、頁首、字標、語言切換、頁尾、返回連結、信頁用的頁首調整）
KEEP = (":root", "*", "html", "body", "a", "img", "button", "input", "textarea", "ul", "ol", "main", "h1", "h2", "h3", "p",
        "::selection", ":focus", "[hidden]", "[id]", ".skip-link", ".visually-hidden", ".site-header", ".brand",
        ".lang-switch", ".site-footer", ".link-arrow", ".letter-page", ".noscript")


def split_blocks(css):
    """把 CSS 切成最上層的區塊：[(prelude, body 或 None)]。註解會被去掉。"""
    css = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    blocks, i, n = [], 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j == -1:
            break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            depth += {"{": 1, "}": -1}.get(css[k], 0)
            k += 1
        blocks.append((prelude, css[j + 1:k - 1]))
        i = k
    return blocks


def wanted(prelude):
    selectors = [s.strip() for s in prelude.split(",")]
    def ok(sel):
        for key in KEEP:
            if sel == key or (sel.startswith(key) and (len(sel) == len(key) or not (sel[len(key)].isalnum() or sel[len(key)] in "_-") or key.startswith((".", ":", "[", "*")))):
                # 「a」不可以吃到「article」；「.brand」可以吃到「.brand__name」
                if key.isalpha() and len(sel) > len(key) and (sel[len(key)].isalnum() or sel[len(key)] == "-"):
                    continue
                return True
        return False
    return all(ok(s) for s in selectors)


def filter_css(css):
    out = []
    for prelude, body in split_blocks(css):
        if prelude.startswith("@media") or prelude.startswith("@supports"):
            inner = filter_css(body)
            if inner.strip():
                out.append(f"{prelude} {{\n{indent(inner)}\n}}")
        elif prelude.startswith("@"):
            continue
        elif wanted(prelude):
            out.append(f"{prelude} {{{tidy(body)}}}")
    return "\n".join(out)


def tidy(body):
    lines = [l.strip() for l in body.strip().split("\n") if l.strip()]
    return "\n  " + "\n  ".join(lines) + "\n" if lines else ""


def indent(text):
    return "\n".join("  " + l if l else l for l in text.split("\n"))


def js_string(text):
    """JSON 的字串寫法也是合法的 JavaScript 字串；另外把 </ 與特殊分隔字元轉掉，放進任何地方都安全"""
    return json.dumps(text, ensure_ascii=False).replace("</", "<\\/").replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def build():
    base = filter_css(SITE_CSS.read_text(encoding="utf-8"))
    room = (HERE / "styles" / "room-extra.css").read_text(encoding="utf-8")
    admin = (HERE / "styles" / "admin-extra.css").read_text(encoding="utf-8")
    head = "/* 這個檔案由 backend/scripts/build_static.py 產生，請不要手動修改。\n   前半是公開網站 styles.css 裡共用的部分，後半是 backend/styles/ 裡私密區自己的樣式。 */\n"
    room_css = head + base + "\n\n" + room
    files = [
        ("/room.css", "text/css; charset=utf-8", room_css),
        ("/admin.css", "text/css; charset=utf-8", admin),
        ("/admin.js", "text/javascript; charset=utf-8", (HERE / "admin" / "client" / "admin.js").read_text(encoding="utf-8")),
        ("/favicon.svg", "image/svg+xml", (HERE.parent / "favicon.svg").read_text(encoding="utf-8")),
    ]
    module = "// 這個檔案由 backend/scripts/build_static.py 產生，請不要手動修改。\n" \
        "// 管理頁用的樣式、腳本與圖示（來源：backend/styles/、backend/admin/client/、公開網站的 styles.css 與 favicon.svg）。\n" \
        "export const STATIC_FILES = {\n" + "".join(
            f"  {js_string(path)}: {{ type: {js_string(ctype)}, body: {js_string(body)} }},\n" for path, ctype, body in files) + "};\n"
    return {
        HERE / "visitor" / "public" / "room.css": room_css,
        HERE / "visitor" / "public" / "favicon.svg": (HERE.parent / "favicon.svg").read_text(encoding="utf-8"),
        HERE / "admin" / "src" / "static.generated.js": module,
    }


if __name__ == "__main__":
    outputs = build()
    if "--check" in sys.argv:
        stale = [str(p.relative_to(HERE)) for p, text in outputs.items() if not p.exists() or p.read_text(encoding="utf-8") != text]
        if stale:
            sys.exit("過期的檔案（請重新執行 build_static.py）：" + ", ".join(stale))
        print("static files up to date")
    else:
        for path, text in outputs.items():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8")
            print(f"{path.relative_to(HERE)}  {len(text.encode('utf-8')) // 1024} KB")
