import fs from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";

const PUBLIC = path.resolve(__dirname, "../public");

interface Icon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: Icon[];
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(PUBLIC, "manifest.webmanifest"), "utf8"),
) as Manifest;

test("manifest identity and display", () => {
  expect(manifest.name).toBe("Seventh House");
  expect(manifest.short_name).toBe("Seventh House");
  expect(manifest.id).toBe("/");
  expect(manifest.start_url).toBe("/");
  expect(manifest.scope).toBe("/");
  expect(manifest.display).toBe("standalone");
  expect(manifest.background_color).toBe("#0B0B1F");
  expect(manifest.theme_color).toBe("#0B0B1F");
});

test("manifest lists 192, 512 and a maskable 512 icon that exist on disk", () => {
  const sizes = manifest.icons.map((i) => i.sizes);
  expect(sizes).toContain("192x192");
  expect(sizes).toContain("512x512");
  const maskable = manifest.icons.find((i) => i.purpose === "maskable");
  expect(maskable?.sizes).toBe("512x512");
  for (const icon of manifest.icons) {
    expect(icon.type).toBe("image/png");
    expect(icon.src.startsWith("/icons/")).toBe(true);
    expect(fs.existsSync(path.join(PUBLIC, icon.src))).toBe(true);
  }
  expect(fs.existsSync(path.join(PUBLIC, "icons/apple-touch-icon.png"))).toBe(true);
});

test("generated PNGs carry the advertised dimensions", () => {
  // PNG IHDR: width at bytes 16..20, height at 20..24 (big-endian).
  const dims = (file: string) => {
    const b = fs.readFileSync(path.join(PUBLIC, file));
    expect(b.subarray(1, 4).toString("ascii")).toBe("PNG");
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };
  for (const icon of manifest.icons) {
    const [w, h] = icon.sizes.split("x").map(Number);
    expect(dims(icon.src)).toEqual([w, h]);
  }
  expect(dims("icons/apple-touch-icon.png")).toEqual([180, 180]);
});
