// Copies the API's card catalogue into the web bundle when the API tree is present.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../api/app/tarot/data/cards.json");
const dest = path.resolve(here, "../src/data/cards.json");

if (fs.existsSync(src)) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}
