import { BODIES, type Aspect, type Body, type Chart, type Placement } from "@/lib/types";

const SIGNS = [
  "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
];

function placement(lon: number, asc: number | null, retrograde = false): Placement {
  const signIdx = Math.floor((lon % 360) / 30);
  return {
    longitude: lon,
    sign: SIGNS[signIdx],
    degree: lon % 30,
    house: asc === null ? null : ((signIdx - Math.floor(asc / 30) + 12) % 12) + 1,
    retrograde,
  };
}

// Spread-out default longitudes so no two bodies collide unless a test asks for it.
const DEFAULTS: Record<Body, number> = {
  sun: 54.3, moon: 200, mercury: 70, venus: 20, mars: 130, jupiter: 250,
  saturn: 300, uranus: 10, neptune: 345, pluto: 275, north_node: 160,
};

export interface FixtureOpts extends Partial<Record<Body, number>> {
  ascendant?: number | null;
  mc?: number | null;
  retrograde?: Body[];
  aspects?: Aspect[];
  houses_unavailable_reason?: Chart["houses_unavailable_reason"];
}

/** Build a Chart the way the API would: sign/degree/house derived from longitude. */
export function fixtureChart(opts: FixtureOpts = {}): Chart {
  const asc = opts.ascendant ?? null;
  const reason = opts.houses_unavailable_reason ?? (asc === null ? "unknown_time" : null);
  const planets = {} as Record<Body, Placement>;
  for (const b of BODIES) {
    planets[b] = placement(opts[b] ?? DEFAULTS[b], asc, opts.retrograde?.includes(b) ?? false);
  }
  const mc = opts.mc === undefined ? (asc === null ? null : (asc + 270) % 360) : opts.mc;
  return {
    engine_version: "test",
    time_known: asc !== null,
    planets,
    ascendant: asc === null ? null : placement(asc, asc),
    mc: mc === null ? null : placement(mc, asc),
    aspects: opts.aspects ?? [],
    houses_unavailable_reason: reason,
  };
}
