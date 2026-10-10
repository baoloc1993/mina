"""Sinh icon app Mina (vòng 7, dogfood L1: bản release đang dùng icon Expo mặc định).
Màu lấy từ token `--color-primary` (#0A5BD3) và `--color-on-primary` (#FFFFFF) của DESIGN-SYSTEM §2.1; chữ M vẽ bằng đa giác
(không phụ thuộc font). Chạy lại: python scripts/make-icons.py  (cần Pillow). Đổi nhận diện thật = thay file trong assets/.
"""
from pathlib import Path
from PIL import Image, ImageDraw

PRIMARY = (0x0A, 0x5B, 0xD3, 255)
WHITE = (255, 255, 255, 255)
ASSETS = Path(__file__).resolve().parent.parent / "assets"
M = [(0, 0), (.2, 0), (.5, .45), (.8, 0), (1, 0), (1, 1), (.8, 1), (.8, .3), (.5, .75), (.2, .3), (.2, 1), (0, 1)]


def draw_m(size: int, fill, box: float, bg=None) -> Image.Image:
    ss = 4  # siêu lấy mẫu cho mép mịn
    im = Image.new("RGBA", (size * ss, size * ss), bg or (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    w = size * ss * box
    x0 = (size * ss - w) / 2
    y0 = (size * ss - w * 0.9) / 2
    d.polygon([(x0 + px * w, y0 + py * w * 0.9) for px, py in M], fill=fill)
    return im.resize((size, size), Image.LANCZOS)


# Ô vuông chính (iOS/web) — nền primary, M trắng
draw_m(1024, WHITE, 0.50, PRIMARY).convert("RGB").save(ASSETS / "icon.png")
# Android adaptive: nền đặc + lớp chữ nằm trong vùng an toàn (66%)
Image.new("RGBA", (512, 512), PRIMARY).save(ASSETS / "android-icon-background.png")
draw_m(512, WHITE, 0.40).save(ASSETS / "android-icon-foreground.png")
draw_m(432, WHITE, 0.40).save(ASSETS / "android-icon-monochrome.png")
draw_m(1024, PRIMARY, 0.30, WHITE).convert("RGB").save(ASSETS / "splash-icon.png")
draw_m(48, WHITE, 0.55, PRIMARY).convert("RGB").save(ASSETS / "favicon.png")
print("đã sinh 6 icon vào", ASSETS)
