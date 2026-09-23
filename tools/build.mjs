/**
 * masters/<id>.png  +  catalog.source.json   ->   wallpapers/{thumb,preview,full}/<id>.webp
 *                                            ->   catalog.json
 *
 * Authored data (id, title, categories, keywords, topPick, addedAt, the category list, the CDN
 * tag) lives in catalog.source.json and is never touched here. Everything this script writes into
 * catalog.json is derived from the image itself: paths, dimensions, byte size, dominant colour,
 * accent colour. Re-running it is always safe and always idempotent.
 *
 *   npm run build              rebuild everything
 *   npm run build -- <id> ...  rebuild only these ids (images), still rewrites catalog.json
 */

import sharp from "sharp";
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MASTERS = path.join(ROOT, "masters");
const OUT = path.join(ROOT, "wallpapers");

/** Source masters are 9:20 at 1440x3200. Every tier keeps that ratio exactly, so the grid never
 *  reflows and the preview never letterboxes. See docs/other/wallpapers.md section 5. */
const MASTER = { width: 1440, height: 3200 };
const TIERS = [
  { name: "thumb", width: 360, height: 800, quality: 75 },
  { name: "preview", width: 720, height: 1600, quality: 82 },
  { name: "full", width: 1440, height: 3200, quality: 90 },
];

/** Categories whose images are smooth enough to band under lossy encoding. WebP at q90 smooths
 *  away the +/-1 LSB dither the generator applies, which on a long dark ramp turns into flat bands
 *  hundreds of pixels tall. The generator answers with a little real grain; this answers with more
 *  bits to carry it. Measured on gradient_black_teal: q90 leaves a 1224 px flat run, q95 with
 *  grain leaves 56 px, for ~200 KB instead of ~18 KB. Well worth it against a 1.5 MB cap. */
const SMOOTH_CATEGORIES = new Set(["gradient"]);
const SMOOTH_QUALITY_BOOST = 5;

/** A `full` over this gets re-encoded a step down rather than shipped. */
const FULL_MAX_BYTES = 1.5 * 1024 * 1024;
const FULL_FALLBACK_QUALITY = 86;

const onlyIds = process.argv.slice(2);

async function main() {
  const source = JSON.parse(await readFile(path.join(ROOT, "catalog.source.json"), "utf8"));
  const knownCategories = new Set(source.categories.map((c) => c.id));

  for (const tier of TIERS) await mkdir(path.join(OUT, tier.name), { recursive: true });

  const wallpapers = [];
  for (const entry of source.wallpapers) {
    for (const c of entry.categories) {
      if (!knownCategories.has(c)) throw new Error(`${entry.id}: unknown category "${c}"`);
    }

    const master = path.join(MASTERS, `${entry.id}.png`);
    if (!(await exists(master))) throw new Error(`${entry.id}: missing masters/${entry.id}.png`);

    const meta = await sharp(master).metadata();
    if (meta.width !== MASTER.width || meta.height !== MASTER.height) {
      throw new Error(
        `${entry.id}: master is ${meta.width}x${meta.height}, must be ${MASTER.width}x${MASTER.height} (9:20)`,
      );
    }

    // Masters arrive already dithered and grained by tools/generate.py, at full float precision
    // before quantisation. Nothing here may touch the pixels beyond resizing and encoding: an
    // extra noise pass on top re-quantises an already-quantised image and adds colour specks.
    const prepared = await sharp(master).toBuffer();

    // A thumb is downscaled far enough that averaging removes the banding on its own.
    const boost = entry.categories.some((c) => SMOOTH_CATEGORIES.has(c)) ? SMOOTH_QUALITY_BOOST : 0;

    const paths = {};
    for (const tier of TIERS) {
      const rel = `${tier.name}/${entry.id}.webp`;
      const dest = path.join(OUT, rel);
      paths[tier.name] = rel;
      if (onlyIds.length && !onlyIds.includes(entry.id) && (await exists(dest))) continue;

      const quality = tier.name === "thumb" ? tier.quality : tier.quality + boost;
      await encode(prepared, dest, tier, quality);
      if (tier.name === "full" && (await stat(dest)).size > FULL_MAX_BYTES) {
        await encode(prepared, dest, tier, FULL_FALLBACK_QUALITY);
        console.warn(`  ${entry.id}: full re-encoded at q${FULL_FALLBACK_QUALITY} to stay under 1.5 MB`);
      }
    }

    const colors = await extractColors(prepared);
    wallpapers.push({
      id: entry.id,
      title: entry.title,
      categories: entry.categories,
      keywords: entry.keywords ?? [],
      thumb: paths.thumb,
      preview: paths.preview,
      full: paths.full,
      width: MASTER.width,
      height: MASTER.height,
      bytes: (await stat(path.join(OUT, paths.full))).size,
      dominant: colors.dominant,
      accent: entry.accent ?? colors.accent,
      topPick: entry.topPick === true,
      addedAt: entry.addedAt,
    });
    console.log(`  ${entry.id}  ${(wallpapers.at(-1).bytes / 1024).toFixed(0)} KB full`);
  }

  const catalog = {
    schema: source.schema,
    version: source.version,
    updatedAt: new Date().toISOString().slice(0, 10),
    cdnBase: source.cdnBase,
    categories: [...source.categories].sort((a, b) => a.order - b.order),
    wallpapers,
  };
  await writeFile(path.join(ROOT, "catalog.json"), `${JSON.stringify(catalog, null, 2)}\n`, "utf8");

  const orphans = await findOrphans(new Set(wallpapers.map((w) => w.id)));
  for (const o of orphans) console.warn(`  orphan (not in catalog, left in place): ${o}`);

  console.log(
    `\ncatalog.json: ${wallpapers.length} wallpapers, ${catalog.categories.length} categories, v${catalog.version}`,
  );
  console.log(`cdnBase: ${catalog.cdnBase}`);
  console.log("Next: commit, `git tag v<version> && git push --tags`, then bump cdnBase to that tag.");
}

async function encode(buffer, dest, tier, quality) {
  await sharp(buffer)
    .resize(tier.width, tier.height, { fit: "cover", kernel: "lanczos3" })
    .webp({ quality, effort: 6, smartSubsample: true })
    .toFile(dest);
}

/** dominant = the grid tile's background while the thumb loads, so it wants the image's overall
 *  colour, averaged in linear light (averaging in sRGB biases dark). accent = the most saturated
 *  colour with enough brightness to actually be the one a person would name. */
async function extractColors(buffer) {
  const { data, info } = await sharp(buffer)
    .resize(36, 80, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels;

  const sum = [0, 0, 0];
  let n = 0;
  let best = { score: -1, r: 0, g: 0, b: 0 };

  for (let i = 0; i < data.length; i += ch) {
    const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
    sum[0] += srgbToLinear(r);
    sum[1] += srgbToLinear(g);
    sum[2] += srgbToLinear(b);
    n += 1;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // Ignore near-black pixels: a single dark speck can be fully "saturated" and mean nothing.
    if (max < 40) continue;
    const score = ((max - min) / max) * (max / 255);
    if (score > best.score) best = { score, r, g, b };
  }

  const dominant = {
    r: linearToSrgb(sum[0] / n),
    g: linearToSrgb(sum[1] / n),
    b: linearToSrgb(sum[2] / n),
  };
  // A flat or near-monochrome image has no accent worth the name; its own colour is the honest one.
  return { dominant: hex(dominant), accent: hex(best.score < 0 ? dominant : best) };
}

const srgbToLinear = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const linearToSrgb = (c) => {
  const v = c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, v * 255));
};

const hex = ({ r, g, b }) =>
  `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase()}`;

async function findOrphans(ids) {
  const found = [];
  for (const tier of TIERS) {
    const dir = path.join(OUT, tier.name);
    if (!(await exists(dir))) continue;
    for (const file of await readdir(dir)) {
      if (file.endsWith(".webp") && !ids.has(file.replace(/\.webp$/, ""))) {
        found.push(`${tier.name}/${file}`);
      }
    }
  }
  return found;
}

const exists = (p) => stat(p).then(() => true, () => false);

main().catch((err) => {
  console.error(`\nbuild failed: ${err.message}`);
  process.exit(1);
});
