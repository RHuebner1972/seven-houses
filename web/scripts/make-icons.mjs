// Generates the PWA icons (gold seven-pointed star on indigo) as PNG via sharp.
// Deterministic: pure geometry, no text, no randomness. Outputs to public/icons/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../public/icons");
fs.mkdirSync(outDir, { recursive: true });

const INDIGO = "#0B0B1F";
const GOLD = "#C9A84C";
const GOLD_HI = "#E8D5A3";
const f = (n) => Math.round(n * 100) / 100;

function starPoints(cx, cy, r, points, ratio) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * ratio;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push(`${f(cx + rad * Math.cos(a))},${f(cy + rad * Math.sin(a))}`);
  }
  return pts.join(" ");
}

/**
 * `scale` is the star's outer radius as a fraction of the half-size. Maskable icons must keep
 * everything meaningful inside the central 80% circle (safe zone), so they use a smaller scale.
 */
function iconSvg(size, scale) {
  const c = size / 2;
  const r = c * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${INDIGO}"/>
  <circle cx="${c}" cy="${c}" r="${f(r * 1.18)}" fill="none" stroke="${GOLD}" stroke-width="${f(size / 64)}" opacity="0.7"/>
  <polygon points="${starPoints(c, c, r, 7, 0.45)}" fill="${GOLD}"/>
  <polygon points="${starPoints(c, c, r * 0.4, 7, 0.45)}" fill="${INDIGO}"/>
  <polygon points="${starPoints(c, c, r * 0.26, 7, 0.45)}" fill="${GOLD_HI}"/>
</svg>`;
}

const ICONS = [
  { file: "icon-192.png", size: 192, scale: 0.68 },
  { file: "icon-512.png", size: 512, scale: 0.68 },
  { file: "icon-512-maskable.png", size: 512, scale: 0.5 },
  { file: "apple-touch-icon.png", size: 180, scale: 0.62 },
];

for (const { file, size, scale } of ICONS) {
  await sharp(Buffer.from(iconSvg(size, scale)))
    .png({ compressionLevel: 9, palette: false })
    .toFile(path.join(outDir, file));
}
console.log(`wrote ${ICONS.length} icons to ${outDir}`);
