"""
Generates the wallpaper masters procedurally: masters/<id>.png at 1440x3200, plus the matching
entries in catalog.source.json. Run `npm run build` afterwards to encode the webp tiers.

    pip install -r tools/requirements.txt
    python tools/generate.py            # everything
    python tools/generate.py solid      # one category, or a list of ids

Every wallpaper here is defined by a RECIPE below, not by randomness at run time: a given id always
produces the same pixels, so re-running this never silently changes a wallpaper a user already has.

Three things make the difference between output that looks generated and output that looks
designed, and all three are easy to get wrong:

  1. Colour is interpolated in Oklab, not sRGB. A straight sRGB ramp between two saturated colours
     dips through a desaturated grey in the middle; Oklab is perceptually uniform, so the midpoint
     looks like the colour a person would expect.
  2. Every result is dithered with TPDF noise before it is quantised to 8 bits. A smooth vertical
     ramp over 3200 px moves through far fewer than 3200 distinct 8-bit values, so without dither
     it bands into visible stripes - worst of all on the dark end, which is most of this catalogue.
  3. Blur fields are built small and scaled up with bicubic resampling rather than blurring a
     full-resolution image. It is both faster and genuinely smoother: there is no blur radius large
     enough to hide the structure of the noise you started from.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MASTERS = ROOT / "masters"
WIDTH, HEIGHT = 1440, 3200
TODAY = date.today().isoformat()


# --------------------------------------------------------------------------------------------
# Colour: sRGB <-> linear <-> Oklab
# --------------------------------------------------------------------------------------------

def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    c = np.clip(c, 0.0, 1.0)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * c ** (1 / 2.4) - 0.055)


_LMS = np.array([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
])
_LAB = np.array([
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
])
_LMS_INV = np.linalg.inv(_LMS)
_LAB_INV = np.linalg.inv(_LAB)


def linear_to_oklab(rgb: np.ndarray) -> np.ndarray:
    lms = rgb @ _LMS.T
    return np.cbrt(np.maximum(lms, 0.0)) @ _LAB.T


def oklab_to_linear(lab: np.ndarray) -> np.ndarray:
    lms = lab @ _LAB_INV.T
    return (lms ** 3) @ _LMS_INV.T


def hex_to_oklab(value: str) -> np.ndarray:
    v = value.lstrip("#")
    rgb = np.array([int(v[i:i + 2], 16) / 255.0 for i in (0, 2, 4)], dtype=np.float64)
    return linear_to_oklab(srgb_to_linear(rgb))


def oklab_to_hex(lab: np.ndarray) -> str:
    rgb = np.clip(linear_to_srgb(oklab_to_linear(lab)), 0.0, 1.0)
    return "#" + "".join(f"{round(c * 255):02X}" for c in rgb)


# --------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------

def finish(linear: np.ndarray, grain: float, rng: np.random.Generator) -> Image.Image:
    """linear-light float RGB -> dithered, grained 8-bit PNG."""
    srgb = linear_to_srgb(linear)

    if grain > 0:
        # Monochrome, so it reads as film grain rather than colour speckle.
        noise = rng.normal(0.0, grain / 255.0, size=srgb.shape[:2])
        srgb = np.clip(srgb + noise[..., None], 0.0, 1.0)

    # TPDF dither: the sum of two uniforms, +/-1 LSB. This decorrelates the quantisation error from
    # the signal, which is what actually removes banding - a flat uniform dither only hides it.
    lsb = 1.0 / 255.0
    tpdf = (rng.random(srgb.shape) - rng.random(srgb.shape)) * lsb
    out = np.clip(srgb + tpdf, 0.0, 1.0)
    return Image.fromarray(np.round(out * 255).astype(np.uint8), mode="RGB")


# --------------------------------------------------------------------------------------------
# Renderers
# --------------------------------------------------------------------------------------------

def render_solid(recipe: "Recipe", rng: np.random.Generator) -> Image.Image:
    lab = hex_to_oklab(recipe.colors[0])
    linear = np.broadcast_to(oklab_to_linear(lab), (HEIGHT, WIDTH, 3)).copy()
    return finish(linear, recipe.grain, rng)


def render_gradient(recipe: "Recipe", rng: np.random.Generator) -> Image.Image:
    """Exactly two colours, top to bottom. `gamma` shifts where the transition sits: 1.0 is a
    straight ramp, higher holds the first colour longer and lands the second near the bottom edge,
    which is the look that reads as deliberate rather than as a default gradient fill."""
    top, bottom = (hex_to_oklab(c) for c in recipe.colors[:2])
    t = np.linspace(0.0, 1.0, HEIGHT, dtype=np.float64) ** recipe.gamma
    if recipe.angle:
        # A gentle diagonal: offset each column's position along the ramp.
        x = np.linspace(-1.0, 1.0, WIDTH, dtype=np.float64) * recipe.angle
        t = np.clip(t[:, None] + x[None, :], 0.0, 1.0)
    else:
        t = np.repeat(t[:, None], WIDTH, axis=1)

    lab = top[None, None, :] + (bottom - top)[None, None, :] * t[..., None]
    return finish(oklab_to_linear(lab), recipe.grain, rng)


def render_blur(recipe: "Recipe", rng: np.random.Generator) -> Image.Image:
    """Soft colour field: a scatter of blobs splatted onto a small canvas, then scaled up. Built at
    1/16 scale, so every edge in the result is an interpolation curve rather than a blurred pixel
    boundary - that is what gives it the depth-of-field look instead of a smudge.

    Blob radius is the whole game. Much above ~0.3 of the canvas height and every blob covers
    everything, they average together, and the result is a flat wash with no structure left."""
    scale = 16
    lw, lh = WIDTH // scale, HEIGHT // scale
    base = hex_to_oklab(recipe.colors[0])
    field = np.broadcast_to(base, (lh, lw, 3)).astype(np.float64).copy()

    ys, xs = np.mgrid[0:lh, 0:lw].astype(np.float64)
    accents = recipe.colors[1:]
    for i in range(recipe.blobs):
        lab = hex_to_oklab(accents[i % len(accents)])
        # Spread the centres over a coarse jittered grid so they never all pile into the middle.
        cx = ((i % 2) + rng.uniform(0.05, 0.95)) / 2.0 * lw
        cy = ((i % 3) + rng.uniform(0.0, 1.0)) / 3.0 * lh
        radius = rng.uniform(0.11, 0.26) * lh
        stretch = rng.uniform(0.65, 1.6)
        d2 = ((xs - cx) * stretch) ** 2 + (ys - cy) ** 2
        weight = np.exp(-d2 / (2 * radius ** 2)) * recipe.blob_strength
        field += (lab - field) * weight[..., None]

    linear = np.clip(oklab_to_linear(field), 0.0, 1.0)
    small = Image.fromarray(np.round(linear_to_srgb(linear) * 255).astype(np.uint8), mode="RGB")
    big = small.resize((WIDTH, HEIGHT), Image.BICUBIC)
    return finish(srgb_to_linear(np.asarray(big, dtype=np.float64) / 255.0), recipe.grain, rng)


RENDERERS = {"solid": render_solid, "gradient": render_gradient, "blur": render_blur}


# --------------------------------------------------------------------------------------------
# Recipes
# --------------------------------------------------------------------------------------------

@dataclass
class Recipe:
    id: str
    title: str
    category: str
    colors: list[str]
    keywords: list[str] = field(default_factory=list)
    gamma: float = 1.0
    angle: float = 0.0
    grain: float = 0.0
    blob_strength: float = 1.0
    blobs: int = 7
    top_pick: bool = False

    @property
    def seed(self) -> int:
        # Deterministic per id: the same wallpaper always renders identically.
        return int.from_bytes(self.id.encode(), "little") % (2 ** 32)


RECIPES: list[Recipe] = [
    # -- Solid -------------------------------------------------------------------------------
    # Flat, undithered-looking single fills. Pure black is the one that genuinely saves power on
    # OLED: the panel does not light those pixels at all.
    Recipe("solid_true_black", "True Black", "solid", ["#000000"],
           ["amoled", "oled", "pure black", "battery"], top_pick=True),
    Recipe("solid_charcoal", "Charcoal", "solid", ["#121212"], ["dark", "grey", "gray", "near black"]),
    Recipe("solid_graphite", "Graphite", "solid", ["#1C1C1E"], ["dark", "grey", "gray", "slate"]),
    Recipe("solid_ink_navy", "Ink Navy", "solid", ["#0A1628"], ["dark", "blue", "midnight"]),
    Recipe("solid_signal_red", "Signal Red", "solid", ["#E0392C"], ["red", "bold", "bright"], top_pick=True),
    Recipe("solid_bone", "Bone", "solid", ["#F2EFE9"], ["white", "light", "cream", "off white"]),
    Recipe("solid_sand", "Sand", "solid", ["#D8C9A8"], ["beige", "tan", "light", "warm"]),
    Recipe("solid_forest", "Forest", "solid", ["#12352B"], ["green", "dark", "deep"]),

    # -- Gradient ----------------------------------------------------------------------------
    # Exactly two colours each, vertical, with the transition weighted low.
    Recipe("gradient_black_teal", "Black Teal", "gradient", ["#000000", "#0E8C7F"],
           ["dark", "teal", "green", "fade"], gamma=2.6, top_pick=True, grain=1.2),
    Recipe("gradient_black_crimson", "Black Crimson", "gradient", ["#000000", "#E0392C"],
           ["dark", "red", "fade"], gamma=2.8, top_pick=True, grain=1.2),
    Recipe("gradient_black_violet", "Black Violet", "gradient", ["#000000", "#6D28D9"],
           ["dark", "purple", "violet", "fade"], gamma=2.6, grain=1.2),
    Recipe("gradient_black_amber", "Black Amber", "gradient", ["#000000", "#F59E0B"],
           ["dark", "orange", "amber", "gold"], gamma=2.9, grain=1.2),
    Recipe("gradient_black_azure", "Black Azure", "gradient", ["#000000", "#1D74F5"],
           ["dark", "blue", "fade"], gamma=2.6, grain=1.2),
    Recipe("gradient_white_citron", "White Citron", "gradient", ["#FFFFFF", "#E8E51A"],
           ["light", "white", "yellow", "bright"], gamma=2.4, top_pick=True, grain=1.2),
    Recipe("gradient_white_rose", "White Rose", "gradient", ["#FFFFFF", "#F472B6"],
           ["light", "pink", "rose", "soft"], gamma=2.3, grain=1.2),
    Recipe("gradient_cream_sand", "Cream Sand", "gradient", ["#F6F1E3", "#C9A96A"],
           ["light", "beige", "tan", "warm", "neutral"], gamma=1.9, grain=1.2),
    Recipe("gradient_slate_mist", "Slate Mist", "gradient", ["#E8EBEF", "#7C8B9E"],
           ["light", "grey", "gray", "cool", "neutral"], gamma=1.8, grain=1.2),
    Recipe("gradient_ink_ocean", "Ink Ocean", "gradient", ["#04121F", "#0EA5C6"],
           ["dark", "blue", "cyan", "deep"], gamma=2.4, grain=1.2),
    Recipe("gradient_ember", "Ember", "gradient", ["#180604", "#FF5C29"],
           ["dark", "orange", "fire", "warm"], gamma=2.5, grain=1.2),
    Recipe("gradient_moss", "Moss", "gradient", ["#07130E", "#5FA96B"],
           ["dark", "green", "nature"], gamma=2.4, grain=1.2),

    # -- Blur --------------------------------------------------------------------------------
    # Grain is deliberate here: it is what stops a big soft field from banding on a phone panel,
    # and it is the texture the look is named for.
    Recipe("blur_ember_drift", "Ember Drift", "blur", ["#08070A", "#E0392C", "#6B1410", "#2B0A08"],
           ["dark", "red", "grain", "soft", "bokeh"], grain=3.5, top_pick=True),
    Recipe("blur_tidal", "Tidal", "blur", ["#05100F", "#14B8A6", "#0F3D44", "#062226"],
           ["dark", "teal", "cyan", "grain", "soft"], grain=3.5, top_pick=True),
    Recipe("blur_nocturne", "Nocturne", "blur", ["#07060C", "#6D28D9", "#2E1065", "#130B2B"],
           ["dark", "purple", "violet", "grain"], grain=3.5),
    Recipe("blur_kiln", "Kiln", "blur", ["#0B0703", "#F59E0B", "#7C3E05", "#2A1503"],
           ["dark", "orange", "amber", "grain", "warm"], grain=3.5),
    Recipe("blur_deep_current", "Deep Current", "blur", ["#04090F", "#1D74F5", "#0B3A72", "#071C33"],
           ["dark", "blue", "grain", "soft"], grain=3.5),
    Recipe("blur_petal", "Petal", "blur", ["#F7EFF2", "#F472B6", "#FBCFE8", "#E9D5FF"],
           ["light", "pink", "pastel", "soft", "grain"], grain=3.0),
    Recipe("blur_haze", "Haze", "blur", ["#EEF1F4", "#94A3B8", "#CBD5E1", "#E2E8F0"],
           ["light", "grey", "gray", "neutral", "soft"], grain=3.0),
    Recipe("blur_verdant", "Verdant", "blur", ["#04100B", "#22C55E", "#14532D", "#052E16"],
           ["dark", "green", "grain", "nature"], grain=3.5),
]


CATEGORIES = [
    {"id": "solid", "label": "Solid", "order": 1,
     "keywords": ["flat", "plain", "single colour", "single color", "amoled", "oled", "pure black", "minimal"]},
    {"id": "gradient", "label": "Gradient", "order": 2,
     "keywords": ["fade", "two tone", "blend", "ramp", "colour", "color"]},
    {"id": "blur", "label": "Blur Grainy", "order": 3,
     "keywords": ["grain", "grainy", "bokeh", "soft", "defocus", "noise", "frosted"]},
]


# --------------------------------------------------------------------------------------------

def main() -> int:
    wanted = set(sys.argv[1:])
    selected = [r for r in RECIPES if not wanted or r.id in wanted or r.category in wanted]
    if not selected:
        print(f"nothing matches {sorted(wanted)}")
        return 1

    MASTERS.mkdir(exist_ok=True)
    ids = {r.id for r in RECIPES}
    if len(ids) != len(RECIPES):
        print("duplicate recipe id")
        return 1

    for recipe in selected:
        rng = np.random.default_rng(recipe.seed)
        image = RENDERERS[recipe.category](recipe, rng)
        assert image.size == (WIDTH, HEIGHT), image.size
        image.save(MASTERS / f"{recipe.id}.png", optimize=True)
        print(f"  {recipe.id:<26} {recipe.category}")

    write_source()
    print(f"\n{len(selected)} rendered, catalog.source.json now lists {len(RECIPES)}.")
    print("Next: npm run build")
    return 0


def write_source() -> None:
    """Rewrites catalog.source.json's generated entries, leaving any hand-added ones alone."""
    path = ROOT / "catalog.source.json"
    source = json.loads(path.read_text(encoding="utf-8"))
    generated = {r.id for r in RECIPES}
    kept = [w for w in source.get("wallpapers", []) if w["id"] not in generated]
    existing = {w["id"]: w for w in source.get("wallpapers", [])}

    source["categories"] = CATEGORIES
    source["wallpapers"] = kept + [
        {
            "id": r.id,
            "title": r.title,
            "categories": [r.category],
            "keywords": r.keywords,
            **({"topPick": True} if r.top_pick else {}),
            # Keep the original date for anything already published: addedAt drives the "New"
            # ribbon, and a regenerate is not a new wallpaper.
            "addedAt": existing.get(r.id, {}).get("addedAt", TODAY),
        }
        for r in RECIPES
    ]
    path.write_text(json.dumps(source, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    raise SystemExit(main())
