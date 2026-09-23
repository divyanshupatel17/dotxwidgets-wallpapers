/**
 * Checks catalog.json is something the app can actually consume. Runs in CI on every push, and
 * is worth running by hand before tagging.
 *
 *   npm run validate
 *
 * A failure here is a broken catalog for every user on the next refresh, so the checks are strict:
 * the app treats the manifest as trusted input and only degrades gracefully for unknown category
 * ids (section 4 of docs/other/wallpapers.md).
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SUPPORTED_SCHEMA = 1;
const CATEGORY_ID = /^[a-z0-9]+(_[a-z0-9]+)*$/;
// A wallpaper id is <category>_<slug>, so unlike a category id it always has an underscore.
const WALLPAPER_ID = /^[a-z0-9]+(_[a-z0-9]+)+$/;
const HEX = /^#[0-9A-F]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FULL_MAX_BYTES = 1.5 * 1024 * 1024;

const errors = [];
const warnings = [];
const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);

const catalog = JSON.parse(await readFile(path.join(ROOT, "catalog.json"), "utf8"));

if (catalog.schema !== SUPPORTED_SCHEMA) fail(`schema is ${catalog.schema}, expected ${SUPPORTED_SCHEMA}`);
if (!Number.isInteger(catalog.version) || catalog.version < 1) fail("version must be a positive integer");
if (!DATE.test(catalog.updatedAt ?? "")) fail("updatedAt must be YYYY-MM-DD");

// The image base must be tag-pinned. An @main or @latest base is mutable, so jsDelivr caches it for
// ~12 h and devices can end up on a stale mix of catalog and images.
if (!/^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+@v\d+\/.*\/$/.test(catalog.cdnBase ?? "")) {
  fail(`cdnBase must be a tag-pinned jsDelivr URL ending in "/", got: ${catalog.cdnBase}`);
}
if (!catalog.cdnBase?.includes(`@v${catalog.version}/`)) {
  warn(`cdnBase tag does not match version ${catalog.version} — tag v${catalog.version} before publishing`);
}

const categoryIds = new Set();
const orders = new Set();
for (const c of catalog.categories ?? []) {
  if (!CATEGORY_ID.test(c.id)) fail(`category id "${c.id}" must be lowercase snake_case`);
  if (categoryIds.has(c.id)) fail(`duplicate category id "${c.id}"`);
  categoryIds.add(c.id);
  if (!c.label?.trim()) fail(`category "${c.id}" has no label`);
  if (!Number.isInteger(c.order)) fail(`category "${c.id}" has no integer order`);
  if (orders.has(c.order)) fail(`duplicate category order ${c.order}`);
  orders.add(c.order);
  // Search leans on these: typing "oled" has to reach AMOLED Black through its keywords.
  if (!c.keywords?.length) warn(`category "${c.id}" has no keywords — it will only match its label`);
}
for (const reserved of ["all", "top_picks"]) {
  if (categoryIds.has(reserved)) fail(`"${reserved}" is a client-side chip, not a catalog category`);
}

const ids = new Set();
const used = new Set();
let topPicks = 0;

for (const w of catalog.wallpapers ?? []) {
  const at = (msg) => fail(`${w.id ?? "<no id>"}: ${msg}`);
  if (!WALLPAPER_ID.test(w.id ?? "")) at("id must be lowercase snake_case, <category>_<slug>");
  if (ids.has(w.id)) at("duplicate id — ids are permanent and never reused");
  ids.add(w.id);

  if (!w.title?.trim()) at("no title");
  if (!w.categories?.length) at("belongs to no category");
  for (const c of w.categories ?? []) {
    if (!categoryIds.has(c)) at(`unknown category "${c}"`);
    used.add(c);
  }

  for (const tier of ["thumb", "preview", "full"]) {
    const rel = w[tier];
    if (rel !== `${tier}/${w.id}.webp`) at(`${tier} path should be "${tier}/${w.id}.webp", got "${rel}"`);
    const abs = path.join(ROOT, "wallpapers", rel ?? "");
    const size = await stat(abs).then((s) => s.size, () => null);
    if (size === null) at(`${tier} file is missing: wallpapers/${rel}`);
    else if (size === 0) at(`${tier} file is empty`);
    else if (tier === "full" && size > FULL_MAX_BYTES) {
      at(`full is ${(size / 1024 / 1024).toFixed(2)} MB, over the 1.5 MB cap — re-encode a step down`);
    }
  }

  if (w.width !== 1440 || w.height !== 3200) at(`must be 1440x3200 (9:20), got ${w.width}x${w.height}`);
  if (!Number.isInteger(w.bytes) || w.bytes < 1) at("bytes missing — the app needs it for determinate progress");
  if (!HEX.test(w.dominant ?? "")) at(`dominant must be #RRGGBB uppercase, got "${w.dominant}"`);
  if (!HEX.test(w.accent ?? "")) at(`accent must be #RRGGBB uppercase, got "${w.accent}"`);
  if (!DATE.test(w.addedAt ?? "")) at("addedAt must be YYYY-MM-DD");
  if (w.topPick === true) topPicks += 1;
}

// An empty category is intentional: the app renders its chip with a COMING SOON panel, which is
// how the catalogue advertises what is on the way. Only report it, never fail on it.
const empty = [...categoryIds].filter((c) => !used.has(c));
if (empty.length) console.log(`info  coming-soon categories (no wallpapers yet): ${empty.join(", ")}`);
if (topPicks === 0) warn("no wallpaper is marked topPick — the Top Picks chip would be empty");

for (const w of warnings) console.warn(`warn  ${w}`);
for (const e of errors) console.error(`error ${e}`);
console.log(
  `\n${catalog.wallpapers?.length ?? 0} wallpapers, ${categoryIds.size} categories, ${topPicks} top picks` +
    ` — ${errors.length} error(s), ${warnings.length} warning(s)`,
);
process.exit(errors.length ? 1 : 0);
