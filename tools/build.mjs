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

    // A pure smooth gradient bands at q90. Fix it in the pixels with ~1% noise rather than by
    // shipping a PNG five times the size.
    const needsNoise = entry.categories.includes("gradient");
    const prepared = needsNoise ? await addDither(master) : await sharp(master).toBuffer();

    const paths = {};
    for (const tier of TIERS) {
      const rel = `${tier.name}/${entry.id}.webp`;
      const dest = path.join(OUT, rel);
      paths[tier.name] = rel;
      if (onlyIds.length && !onlyIds.includes(entry.id) && (await exists(dest))) continue;

      await encode(prepared, dest, tier, tier.quality);
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

/** ~1% monochrome gaussian noise, soft-lit over the image, to break up gradient banding. */
async function addDither(master) {
  const noise = await sharp({
    create: {
      width: MASTER.width,
      height: MASTER.height,
      channels: 3,
      background: { r: 128, g: 128, b: 128 },
      noise: { type: "gaussian", mean: 128, sigma: 3 },
    },
  })
    .png()
    .toBuffer();
  return sharp(master).composite([{ input: noise, blend: "soft-light" }]).toBuffer();
}

/** dominant = the grid tile's background while the thumb loads, so it must be the *ground* colour,
 *  not the eye-catching one. accent = the most saturated pixel cluster. */
async function extractColors(buffer) {
  const { dominant } = await sharp(buffer).stats();
  const small = await sharp(buffer).resize(32, 71, { fit: "fill" }).raw().toBuffer();

  let best = { score: -1, r: dominant.r, g: dominant.g, b: dominant.b };
  for (let i = 0; i < small.length; i += 3) {
    const [r, g, b] = [small[i], small[i + 1], small[i + 2]];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    if (max === 0) continue;
    const score = ((max - min) / max) * (max / 255); // saturation, weighted by brightness
    if (score > best.score) best = { score, r, g, b };
  }
  return { dominant: hex(dominant), accent: hex(best) };
}

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
