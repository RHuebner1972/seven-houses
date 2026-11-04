import { expect, test } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChartWheel, lonToAngle, wheelRotation } from "@/components/chart-wheel";
import { Placements } from "@/components/placements";
import { fixtureChart } from "./helpers/chart";

const angle = (el: Element) => Number(el.getAttribute("data-angle"));

test("lonToAngle follows angle = 180 - (lon - rotation), normalised to [0, 360)", () => {
  expect(lonToAngle(0, 0)).toBe(180);
  expect(lonToAngle(90, 0)).toBe(90);
  expect(lonToAngle(300, 0)).toBe(240);
  expect(lonToAngle(54.3, 90)).toBeCloseTo(215.7, 5);
});

test("rotation is 0 without an Ascendant, else the start of the Ascendant's sign", () => {
  expect(wheelRotation(fixtureChart({ ascendant: null }))).toBe(0);
  expect(wheelRotation(fixtureChart({ ascendant: 110 }))).toBe(90);
  expect(wheelRotation(fixtureChart({ ascendant: 359.9 }))).toBe(330);
});

test("places the Sun glyph at its longitude and rotates for the Ascendant", () => {
  const chart = fixtureChart({ sun: 54.3 /* Taurus */, ascendant: 110 /* Cancer */ });
  const { container } = render(<ChartWheel chart={chart} size={400} />);
  const sun = container.querySelector('[data-body="sun"]')!;
  // expected angle = 180 - (54.3 - 90) where rotation = start of Cancer (90°)
  expect(angle(sun)).toBeCloseTo(215.7, 1);
  const houses = container.querySelectorAll("[data-house]");
  expect(houses).toHaveLength(12);
  // 1st house is the Ascendant's sign (Cancer, index 3); numbered counter-clockwise
  const first = container.querySelector('[data-house="1"]')!;
  expect(first.getAttribute("data-sign")).toBe("Cancer");
  const second = container.querySelector('[data-house="2"]')!;
  expect(second.getAttribute("data-sign")).toBe("Leo");
  // AC and MC ticks present when the chart has them
  expect(container.querySelector('[data-point="ac"]')).not.toBeNull();
  expect(container.querySelector('[data-point="mc"]')).not.toBeNull();
  // Ascendant sits at 9 o'clock minus its offset within Cancer: 180 - (110 - 90) = 160
  expect(angle(container.querySelector('[data-point="ac"]')!)).toBeCloseTo(160, 5);
});

test("no ascendant → no house numbers, no AC/MC, Aries at 9 o'clock", () => {
  const chart = fixtureChart({ ascendant: null });
  const { container } = render(<ChartWheel chart={chart} size={400} />);
  expect(container.querySelectorAll("[data-house]")).toHaveLength(0);
  expect(container.querySelector('[data-point="ac"]')).toBeNull();
  expect(container.querySelector('[data-point="mc"]')).toBeNull();
  const aries = container.querySelector('[data-sign="Aries"]')!;
  // the Aries segment starts at 0° longitude → angle 180 (9 o'clock)
  expect(Number(aries.getAttribute("data-start-angle"))).toBe(180);
  expect(container.querySelectorAll("[data-sign]")).toHaveLength(12);
  // all eleven bodies are drawn
  expect(container.querySelectorAll("[data-body]")).toHaveLength(11);
});

test("draws one aspect line per aspect, coloured by kind", () => {
  const chart = fixtureChart({
    ascendant: null,
    aspects: [
      { a: "sun", b: "moon", kind: "conjunction", orb: 1.2 },
      { a: "mars", b: "saturn", kind: "square", orb: 3.1 },
      { a: "venus", b: "jupiter", kind: "trine", orb: 0.4 },
    ],
  });
  const { container } = render(<ChartWheel chart={chart} size={400} />);
  const lines = container.querySelectorAll("line[data-aspect]");
  expect(lines).toHaveLength(3);
  const kinds = Array.from(lines).map((l) => l.getAttribute("data-aspect"));
  expect(kinds).toEqual(["conjunction", "square", "trine"]);
  const strokes = Array.from(lines).map((l) => l.getAttribute("stroke"));
  expect(new Set(strokes).size).toBe(3);
});

test("nudges planets that sit within 6° of each other apart", () => {
  const chart = fixtureChart({ ascendant: null, sun: 100, moon: 101 });
  const { container } = render(<ChartWheel chart={chart} size={400} />);
  const sun = container.querySelector('[data-body="sun"]')!;
  const moon = container.querySelector('[data-body="moon"]')!;
  // true angles are untouched…
  expect(angle(sun)).toBe(80);
  expect(angle(moon)).toBe(79);
  // …but the glyphs are pushed ≥ 6° apart
  const gap = Math.abs(
    Number(sun.getAttribute("data-glyph-angle")) - Number(moon.getAttribute("data-glyph-angle")),
  );
  expect(gap).toBeGreaterThanOrEqual(6 - 1e-9);
});

test("is an accessible image sized by the size prop", () => {
  const chart = fixtureChart({ sun: 54.3, moon: 200, ascendant: 110 });
  render(<ChartWheel chart={chart} size={320} />);
  const img = screen.getByRole("img");
  expect(img).toHaveAttribute("width", "320");
  expect(img).toHaveAttribute("height", "320");
  expect(img).toHaveAttribute("viewBox", "0 0 1000 1000");
  expect(img.getAttribute("aria-label")).toMatch(/Sun in Taurus/);
  expect(img.getAttribute("aria-label")).toMatch(/Moon in Libra/);
  expect(img.getAttribute("aria-label")).toMatch(/Ascendant in Cancer/);
});

test("placements list reads naturally and flags unknown time", () => {
  render(<Placements chart={fixtureChart({ sun: 54.3, houses_unavailable_reason: "unknown_time" })} />);
  expect(screen.getByText(/Houses need a birth time/)).toBeInTheDocument();
  expect(screen.getByText(/Sun in Taurus 24°/)).toBeInTheDocument();
  expect(screen.queryByText(/house/i, { selector: "li" })).toBeNull();
  expect(screen.queryByText(/Ascendant/)).toBeNull();
});

test("placements include houses, retrograde, angles, aspects, and polar note", () => {
  const chart = fixtureChart({
    sun: 54.3,
    mercury: 70,
    ascendant: 110,
    retrograde: ["mercury"],
    aspects: [{ a: "sun", b: "moon", kind: "opposition", orb: 2.5 }],
  });
  render(<Placements chart={chart} />);
  // Taurus (1) from Cancer (3): ((1 - 3 + 12) % 12) + 1 = 11
  expect(screen.getByText("Sun in Taurus 24°, 11th house")).toBeInTheDocument();
  expect(screen.getByText("Mercury in Gemini 10°, 12th house (retrograde)")).toBeInTheDocument();
  expect(screen.getByText(/Ascendant in Cancer 20°/)).toBeInTheDocument();
  expect(screen.getByText(/Midheaven in Aries 20°/)).toBeInTheDocument();
  expect(screen.getByText(/Sun opposition Moon/)).toBeInTheDocument();
  expect(screen.queryByText(/Houses need a birth time/)).toBeNull();

  render(<Placements chart={fixtureChart({ ascendant: null, houses_unavailable_reason: "polar_latitude" })} />);
  expect(screen.getByText(/Houses aren't computed this far north\/south/)).toBeInTheDocument();
});

test("placements list bodies in BODIES order", () => {
  render(<Placements chart={fixtureChart({ ascendant: null })} />);
  const items = screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
  const re = /(Sun|Moon|Mercury|Venus|Mars|Jupiter|Saturn|Uranus|Neptune|Pluto|North Node) in /;
  const bodies = items.map((t) => re.exec(t)?.[1]).filter((x): x is string => !!x);
  expect(bodies).toEqual([
    "Sun", "Moon", "Mercury", "Venus", "Mars", "Jupiter", "Saturn", "Uranus", "Neptune", "Pluto", "North Node",
  ]);
});
