import { expect, test } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  BACK_URL,
  CARDS,
  cardAlt,
  cardById,
  imageUrl,
  orientationLabel,
} from "@/lib/cards";

test("catalogue matches the API copy when present", () => {
  const apiPath = path.resolve(__dirname, "../../api/app/tarot/data/cards.json");
  if (!fs.existsSync(apiPath)) return;
  expect(JSON.parse(fs.readFileSync(apiPath, "utf8"))).toEqual(CARDS);
});

test("78 cards, image urls, lookup", () => {
  expect(CARDS).toHaveLength(78);
  expect(imageUrl("cups-11-page")).toBe("/deck/cups-11-page.webp");
  expect(BACK_URL).toBe("/deck/back.webp");
  expect(cardById("major-00-fool").name).toBe("The Fool");
});

test("unknown id throws", () => {
  expect(() => cardById("nope")).toThrow();
});

test("orientation label and alt text", () => {
  expect(orientationLabel(true)).toBe("reversed");
  expect(orientationLabel(false)).toBe("upright");
  expect(cardAlt("major-00-fool", true)).toBe("The Fool, reversed");
  expect(cardAlt("major-00-fool", false)).toBe("The Fool, upright");
});

test("every catalogue image exists in public/deck", () => {
  for (const c of CARDS) expect(fs.existsSync(path.join("public", c.image))).toBe(true);
  expect(fs.existsSync("public/deck/back.webp")).toBe(true);
});
