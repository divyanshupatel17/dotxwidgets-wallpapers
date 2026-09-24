# dotxwidgets-wallpapers

Wallpaper content for **DotX Widgets Pro** (`com.divyanshupatel.dotxwidgets`) — the images plus
`catalog.json`, the manifest the app reads. No backend, no database: the app fetches these static
files straight from GitHub and the jsDelivr CDN.

Adding a wallpaper is a push and a tag here. It never needs an app release.

**Style:** minimal, AMOLED-friendly, portrait. Masters are **1440 x 3200 (9:20)**.

## Contents

Current manifest: **version 3**, tag **`v3`**, 58 wallpapers across 6 categories.

| Category | Id | Wallpapers | Added in | Last changed |
|---|---|---:|---|---|
| Solid | `solid` | 16 | `v1` · 2026-09-23 | `v2` · 2026-09-23 (+8) |
| Gradient | `gradient` | 26 | `v1` · 2026-09-23 | `v2` · 2026-09-23 (+14) |
| Blur Grainy | `blur` | 16 | `v1` · 2026-09-23 | `v2` · 2026-09-23 (+8) |
| Dot Matrix | `dot_matrix` | 0 | `v2` · 2026-09-23 | `v2` · 2026-09-23 |
| Mesh | `mesh` | 0 | `v2` · 2026-09-23 | `v2` · 2026-09-23 |
| Duotone | `duotone` | 0 | `v2` · 2026-09-23 | `v2` · 2026-09-23 |
| **Total** | | **58** | | |

A category with 0 wallpapers is announced on purpose. The app renders it as a **COMING SOON..**
panel rather than hiding it, so the row of chips is stable while a category is being filled.

Keep this table current in the same commit that changes content — it is the only per-category
history there is.

## Release log

| Tag | Date | Manifest version | What changed |
|---|---|---:|---|
| `v3` | 2026-09-24 | 3 | Repo renamed `dotx-wallpapers` → `dotxwidgets-wallpapers`; `cdnBase` re-pointed. No content change. |
| `v2` | 2026-09-23 | 2 | +30 wallpapers (58 total); announced `dot_matrix`, `mesh`, `duotone` as empty. |
| `v1` | 2026-09-23 | 1 | First content drop: 28 wallpapers across `solid`, `gradient`, `blur`. |

## URLs the app uses

```
manifest  https://raw.githubusercontent.com/divyanshupatel17/dotxwidgets-wallpapers/main/catalog.json
images    https://cdn.jsdelivr.net/gh/divyanshupatel17/dotxwidgets-wallpapers@v3/wallpapers/...
```

The manifest comes from `raw.githubusercontent.com` so a change propagates in ~5 minutes. Image
URLs are **tag-pinned** (`@v3`), which makes them immutable, so jsDelivr caches them for a year and
a device never re-downloads a wallpaper it already has. The app never hardcodes the image base — it
reads `cdnBase` out of the manifest, so re-pointing the whole catalog is a one-line change here.

Never `@main` for images: a branch URL is mutable *and* cached ~12 h, which is the worst of both.

## Layout

```
catalog.source.json     authored input - edit this
catalog.json            generated - never hand-edit, the build overwrites it
masters/<id>.png        1440x3200 originals, GITIGNORED, keep them backed up elsewhere
wallpapers/
  thumb/<id>.webp        360 x  800, q75, 20-45 KB   grid tiles
  preview/<id>.webp      720 x 1600, q82, 120-250 KB fullscreen preview
  full/<id>.webp        1440 x 3200, q90, 350-900 KB what actually gets applied
tools/generate.py       deterministic art generator -> masters/
tools/build.mjs         masters + catalog.source.json -> tiers + catalog.json
tools/validate.mjs      strict manifest check, also runs in CI on every push
```

Three tiers exist so the app never downloads a 1440x3200 image to draw a grid thumbnail — that is
the whole difference between a gallery that scrolls and one that stutters. Flat per-tier folders
keyed by id, not per-category folders: a wallpaper belongs to several categories, and category
membership has to be editable without moving files (which would break tag-pinned URLs).

## Adding wallpapers

```bash
npm install                 # once
# 1. drop 1440x3200 PNGs into masters/, named <id>.png
#    (or add a Recipe row to tools/generate.py and run it)
# 2. add an entry per file to catalog.source.json:
#    {
#      "id": "gradient_black_teal",         lowercase snake_case, <category>_<slug>, permanent
#      "title": "Black Teal",
#      "categories": ["gradient"],
#      "keywords": ["gradient", "teal", "dark"],
#      "topPick": true,                      optional
#      "addedAt": "2026-09-24"
#    }
npm run build               # encodes all three tiers, rewrites catalog.json
npm run validate            # same checks CI runs
```

Then bump `version` in `catalog.source.json`, set `cdnBase` to the matching `@vN`, rebuild, update
the two tables above, and:

```bash
git add -A && git commit -m "content: add 12 wallpapers"
git tag v4 && git push && git push --tags
```

Devices pick up the new manifest within ~6 hours of the next app open.

## Removing wallpapers and categories

The manifest is authoritative and the app replaces it wholesale, so a removal is just an edit here:

- **Drop a wallpaper** — delete its entry from `catalog.source.json`, rebuild, bump, tag. It leaves
  the grid on every device at the next refresh. Leave the image files in the repo: they are tiny,
  older tags still point at them, and deleting them would break a device still on a cached manifest.
- **Drop a category** — delete its `categories[]` row. The app drops the id from any wallpaper that
  still lists it, so a stale reference is ignored rather than fatal, and the chip disappears.
- The app keeps **no per-wallpaper state** — no favourites, no local ids — so a removal orphans
  nothing. Downloaded full-size files are wiped on the next app start and cached thumbnails age out
  of a capped LRU.

## Rules

- **Ids are permanent and never reused.** They are the app's cache key and analytics key. A recut of
  an existing wallpaper gets a new id.
- **Never re-encode an image in place.** Git keeps every version of a binary forever, and a
  tag-pinned URL is supposed to be immutable. Replace by adding a new id and dropping the old entry.
- **Keep `full` under 1.5 MB.** The build steps quality down automatically if a master overflows it.
- **Keep the repo under ~1 GB**, and no single file over 20 MB (jsDelivr refuses those). At ~800 KB
  per wallpaper across all three tiers, 500 wallpapers is about 400 MB.
- **Every master is exactly 1440x3200.** The build rejects anything else, so the grid never reflows.
- Only upload art that is yours or licensed for redistribution. Record it in `LICENSE.md`.

## Related

Design, app-side caching policy and the category model live in the app repo:
`docs/other/wallpapers.md`.
