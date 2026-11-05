// Stamps a build id into the service worker so each deploy gets a fresh cache name
// (and activate() can purge the previous one). Reads scripts/sw.src.js, writes public/sw.js.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const SW_SOURCE = path.resolve(here, "sw.src.js");
export const SW_OUTPUT = path.resolve(here, "../public/sw.js");
const PLACEHOLDER = "__BUILD_ID__";

/**
 * Commit sha on Vercel; otherwise a time-based id so local builds still roll the cache.
 * @param {Partial<Record<string, string>>} [env]
 */
export function buildId(env = process.env) {
  const sha = env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA;
  const id = sha ? sha.slice(0, 8) : Date.now().toString(36);
  return id.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function renderSw(id, source = fs.readFileSync(SW_SOURCE, "utf8")) {
  if (!source.includes(PLACEHOLDER)) throw new Error(`sw.src.js lacks ${PLACEHOLDER}`);
  return source.replaceAll(PLACEHOLDER, id);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const id = buildId();
  fs.mkdirSync(path.dirname(SW_OUTPUT), { recursive: true });
  fs.writeFileSync(SW_OUTPUT, renderSw(id));
  console.log(`wrote ${SW_OUTPUT} (cache sh-${id})`);
}
