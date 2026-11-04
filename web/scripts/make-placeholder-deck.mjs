// Generates the placeholder deck (79 WebP files) from SVG. Deterministic: no Math.random().
// Text is rendered with system fonts, so byte-determinism holds per machine, not across machines.
// Real artwork replaces public/deck/<id>.webp 1:1.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const cards = JSON.parse(
  fs.readFileSync(path.resolve(here, "../src/data/cards.json"), "utf8"),
);
const outDir = path.resolve(here, "../public/deck");
fs.mkdirSync(outDir, { recursive: true });

const W = 1024;
const H = 1536;
const GOLD = "#C9A84C";
const GOLD_HI = "#E8D5A3";
const INK = "#F2EBDD";
const SERIF = `Georgia, 'Cormorant Garamond', serif`;
const f = (n) => Math.round(n * 100) / 100;

const ROMAN = [
  "0", "I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XII",
  "XIII", "XIV", "XV", "XVI", "XVII", "XVIII", "XIX", "XX", "XXI",
];
const COURT = { 11: "PAGE", 12: "KNIGHT", 13: "QUEEN", 14: "KING" };

// Star polygon points around (cx, cy); `points` tips, inner radius ratio `ratio`.
function starPoints(cx, cy, r, points, ratio) {
  const pts = [];
  for (let i = 0; i < points * 2; i++) {
    const rad = i % 2 === 0 ? r : r * ratio;
    const a = (Math.PI * i) / points - Math.PI / 2;
    pts.push(`${f(cx + rad * Math.cos(a))},${f(cy + rad * Math.sin(a))}`);
  }
  return pts.join(" ");
}

function star(cx, cy, r, points, ratio, fill) {
  return `<polygon points="${starPoints(cx, cy, r, points, ratio)}" fill="${fill}"/>`;
}

function frame() {
  const corners = [
    [76, 76], [W - 76, 76], [76, H - 76], [W - 76, H - 76],
  ];
  return `
  <rect x="40" y="40" width="${W - 80}" height="${H - 80}" rx="28" fill="none" stroke="${GOLD}" stroke-width="6"/>
  <rect x="56" y="56" width="${W - 112}" height="${H - 112}" rx="18" fill="none" stroke="${GOLD_HI}" stroke-width="2"/>
  ${corners.map(([x, y]) => star(x, y, 22, 4, 0.28, GOLD_HI)).join("\n  ")}`;
}

function base(inner) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <radialGradient id="bg" cx="50%" cy="45%" r="75%">
      <stop offset="0%" stop-color="#0B0B1F"/>
      <stop offset="100%" stop-color="#05050C"/>
    </radialGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${frame()}
  ${inner}
</svg>`;
}

// Suit emblems, drawn in a ~100-unit box centred on the origin.
const EMBLEMS = {
  wands: () => `
    <rect x="-5" y="-14" width="10" height="64" rx="3" fill="${GOLD}"/>
    <path d="M0,-52 C16,-36 14,-24 0,-16 C-14,-24 -16,-36 0,-52 Z" fill="${GOLD_HI}"/>
    <rect x="-9" y="2" width="18" height="4" fill="${GOLD_HI}"/>`,
  cups: () => `
    <path d="M-30,-34 L30,-34 C30,0 14,12 5,15 L5,34 L22,42 L22,50 L-22,50 L-22,42 L-5,34 L-5,15 C-14,12 -30,0 -30,-34 Z" fill="${GOLD}"/>
    <rect x="-30" y="-38" width="60" height="6" rx="3" fill="${GOLD_HI}"/>`,
  swords: () => `
    <polygon points="0,-54 7,-42 7,24 -7,24 -7,-42" fill="${GOLD_HI}"/>
    <rect x="-1.5" y="-40" width="3" height="60" fill="${GOLD}"/>
    <rect x="-26" y="24" width="52" height="8" rx="3" fill="${GOLD}"/>
    <rect x="-4" y="32" width="8" height="18" fill="${GOLD}"/>
    <circle cx="0" cy="54" r="6" fill="${GOLD_HI}"/>`,
  pentacles: () => {
    const r = 34;
    const pts = [0, 2, 4, 1, 3]
      .map((i) => {
        const a = (Math.PI * 2 * i) / 5 - Math.PI / 2;
        return `${f(r * Math.cos(a))},${f(r * Math.sin(a))}`;
      })
      .join(" ");
    return `
    <circle r="46" fill="none" stroke="${GOLD}" stroke-width="5"/>
    <circle r="40" fill="none" stroke="${GOLD_HI}" stroke-width="1.5"/>
    <polygon points="${pts}" fill="none" stroke="${GOLD_HI}" stroke-width="4" stroke-linejoin="round"/>`;
  },
};

function emblemAt(suit, x, y, s) {
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${s})">${EMBLEMS[suit]()}</g>`;
}

const PIP_ROWS = {
  1: [1], 2: [1, 1], 3: [1, 1, 1], 4: [2, 2], 5: [2, 1, 2], 6: [2, 2, 2],
  7: [2, 1, 2, 2], 8: [2, 2, 2, 2], 9: [3, 3, 3], 10: [2, 3, 3, 2],
};

function pips(suit, n) {
  const rows = PIP_ROWS[n];
  if (n === 1) return emblemAt(suit, W / 2, 700, 5.2);
  const top = 420;
  const bottom = 980;
  const scale = rows.length <= 3 ? 2.3 : 1.7;
  const out = [];
  rows.forEach((count, r) => {
    const y = rows.length === 1 ? 700 : top + ((bottom - top) * r) / (rows.length - 1);
    const gap = count === 3 ? 250 : 270;
    for (let c = 0; c < count; c++) {
      const x = W / 2 + (c - (count - 1) / 2) * gap;
      out.push(emblemAt(suit, x, y, scale));
    }
  });
  return out.join("\n  ");
}

function title(name) {
  return `<text x="${W / 2}" y="1320" text-anchor="middle" font-family="${SERIF}" font-size="58" letter-spacing="6" fill="${INK}">${name.toUpperCase()}</text>
  <line x1="300" y1="1262" x2="724" y2="1262" stroke="${GOLD}" stroke-width="2"/>
  ${star(W / 2, 1262, 12, 4, 0.3, GOLD_HI)}`;
}

function faceSvg(card) {
  let inner;
  if (card.arcana === "major") {
    inner = `
  <text x="${W / 2}" y="520" text-anchor="middle" font-family="${SERIF}" font-size="170" letter-spacing="8" fill="${GOLD_HI}">${ROMAN[card.number]}</text>
  <circle cx="${W / 2}" cy="840" r="250" fill="none" stroke="${GOLD}" stroke-width="2" opacity="0.6"/>
  ${star(W / 2, 840, 220, 7, 0.45, GOLD)}
  ${star(W / 2, 840, 90, 7, 0.45, "#0B0B1F")}
  ${star(W / 2, 840, 60, 7, 0.45, GOLD_HI)}`;
  } else if (card.number >= 11) {
    inner = `
  <text x="${W / 2}" y="440" text-anchor="middle" font-family="${SERIF}" font-size="110" letter-spacing="14" fill="${GOLD_HI}">${COURT[card.number]}</text>
  ${emblemAt(card.suit, W / 2, 790, 5.2)}`;
  } else {
    inner = pips(card.suit, card.number);
  }
  return base(`${inner}\n  ${title(card.name)}`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function backSvg() {
  const rand = mulberry32(7);
  const stars = [];
  for (let i = 0; i < 150; i++) {
    const x = 100 + rand() * (W - 200);
    const y = 100 + rand() * (H - 200);
    const r = 5 + rand() * 11;
    const dx = x - W / 2;
    const dy = y - H / 2;
    if (Math.hypot(dx, dy) < 290) continue;
    const fill = rand() > 0.5 ? GOLD : GOLD_HI;
    stars.push(
      `<g opacity="${f(0.45 + rand() * 0.5)}">${star(f(x), f(y), f(r), 4, 0.3, fill)}</g>`,
    );
  }
  return base(`
  ${stars.join("\n  ")}
  <circle cx="${W / 2}" cy="${H / 2}" r="260" fill="#0B0B1F" stroke="${GOLD}" stroke-width="4"/>
  <circle cx="${W / 2}" cy="${H / 2}" r="244" fill="none" stroke="${GOLD_HI}" stroke-width="1.5"/>
  ${star(W / 2, H / 2, 210, 7, 0.45, GOLD)}
  ${star(W / 2, H / 2, 80, 7, 0.45, GOLD_HI)}`);
}

async function write(name, svg) {
  await sharp(Buffer.from(svg))
    .webp({ quality: 82 })
    .toFile(path.join(outDir, `${name}.webp`));
}

for (const card of cards) await write(card.id, faceSvg(card));
await write("back", backSvg());
console.log(`wrote ${cards.length + 1} files to ${outDir}`);
