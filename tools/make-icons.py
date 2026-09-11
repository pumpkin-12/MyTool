"""生成个人工具箱的 Tauri 图标集（扁平风格：圆角蓝底 + 2x2 白色圆角方块）。"""
import os
from PIL import Image, ImageDraw

OUT = r"D:\Ai-file\MyTool\src-tauri\icons"
os.makedirs(OUT, exist_ok=True)

ACCENT = (37, 99, 235, 255)      # 与 index.html 的 --accent #2563eb 一致
WHITE = (255, 255, 255, 255)
SS = 4                            # 超采样倍数，用于抗锯齿


def render(size):
    u = size * SS
    img = Image.new("RGBA", (u, u), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, u - 1, u - 1], radius=int(0.22 * u), fill=ACCENT)

    sq = 0.24 * u
    gap = 0.10 * u
    radius = 0.055 * u
    start = (u - (sq * 2 + gap)) / 2
    for i in range(2):
        for j in range(2):
            x = start + i * (sq + gap)
            y = start + j * (sq + gap)
            d.rounded_rectangle([x, y, x + sq, y + sq], radius=int(radius), fill=WHITE)

    return img.resize((size, size), Image.LANCZOS)


src = render(1024)
src.save(os.path.join(OUT, "source-1024.png"))

TARGETS = [
    ("32x32.png", 32),
    ("128x128.png", 128),
    ("128x128@2x.png", 256),
    ("icon.png", 512),
    ("StoreLogo.png", 50),
    ("Square30x30Logo.png", 30),
    ("Square44x44Logo.png", 44),
    ("Square71x71Logo.png", 71),
    ("Square89x89Logo.png", 89),
    ("Square107x107Logo.png", 107),
    ("Square142x142Logo.png", 142),
    ("Square150x150Logo.png", 150),
    ("Square284x284Logo.png", 284),
    ("Square310x310Logo.png", 310),
]
for name, s in TARGETS:
    render(s).save(os.path.join(OUT, name))

src.save(
    os.path.join(OUT, "icon.ico"),
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)

made = sorted(os.listdir(OUT))
print("files=%d" % len(made))
for n in made:
    print("  %-26s %8d" % (n, os.path.getsize(os.path.join(OUT, n))))
