"""Format generated marketing posters for NSIS; no creative image editing.

Pillow and ffmpeg are maintainer-only regeneration dependencies. Windows
packaging consumes the checked-in BMP/AVI files without either dependency.
"""

from pathlib import Path
import subprocess

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "resources" / "installer"
POSTERS = OUT / "posters"
OUT.mkdir(parents=True, exist_ok=True)


def place_artwork(image, source, box):
    art = Image.open(source).convert("RGB")
    x, y, width, height = box
    art.thumbnail((width, height), Image.Resampling.LANCZOS)
    image.paste(art, (x + (width - art.width) // 2, y + (height - art.height) // 2))


def save(image, name):
    image.convert("RGB").save(OUT / name, "BMP")


for index, name in enumerate(("apps", "space", "box"), 1):
    card = Image.new("RGB", (720, 400), "#F2EBE2")
    place_artwork(card, POSTERS / f"{name}-v1.png", (12, 12, 696, 376))
    save(card, f"feature-{index}.bmp")

overview = Image.new("RGB", (720, 190), "#FCF9F5")
for n, name in enumerate(("apps", "space", "box")):
    place_artwork(overview, POSTERS / f"{name}-v1.png", (n * 240 + 6, 8, 228, 174))
save(overview, "overview.bmp")

sidebar = Image.new("RGB", (164, 314), "#F2EBE2")
logo = Image.open(ROOT / "resources" / "icon.png").convert("RGBA")
logo.thumbnail((102, 102), Image.Resampling.LANCZOS)
sidebar.paste(logo, ((164 - logo.width) // 2, 22), logo)
for n, name in enumerate(("apps", "space", "box")):
    place_artwork(sidebar, POSTERS / f"{name}-v1.png", (12, 138 + n * 55, 140, 49))
save(sidebar, "sidebar.bmp")

header = Image.new("RGB", (150, 57), "#FCF9F5")
logo.thumbnail((48, 48), Image.Resampling.LANCZOS)
header.paste(logo, (96, 3), logo)
save(header, "header.bmp")

# SysAnimate32 supports silent, uncompressed AVI without codecs/plugins.
# Three keyframes, 5.5 seconds per poster. Provide native pixel sizes for
# ordinary / 150% / 200% DPI; the installer chooses the largest that fits.
for density, width, height in [(1, 280, 156), (2, 420, 234), (3, 560, 312)]:
    subprocess.run([
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-framerate", "2/11", "-start_number", "1",
        "-i", str(OUT / "feature-%d.bmp"), "-frames:v", "3",
        "-vf", f"scale={width}:{height},vflip", "-an",
        "-c:v", "rawvideo", "-pix_fmt", "bgr24",
        "-flipped_raw_rgb", "1",
        str(OUT / f"poster-loop-{density}x.avi"),
    ], check=True)
