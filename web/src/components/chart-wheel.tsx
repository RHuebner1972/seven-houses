import { BODIES, type Body, type Chart } from "@/lib/types";

export const SIGNS = [
  "Aries", "Taurus", "Gemini", "Cancer", "Leo", "Virgo",
  "Libra", "Scorpio", "Sagittarius", "Capricorn", "Aquarius", "Pisces",
] as const;

export const SIGN_GLYPHS = ["♈", "♉", "♊", "♋", "♌", "♍", "♎", "♏", "♐", "♑", "♒", "♓"] as const;

export const BODY_GLYPHS: Record<Body, string> = {
  sun: "☉", moon: "☽", mercury: "☿", venus: "♀", mars: "♂", jupiter: "♃",
  saturn: "♄", uranus: "♅", neptune: "♆", pluto: "♇", north_node: "☊",
};

export const BODY_NAMES: Record<Body, string> = {
  sun: "Sun", moon: "Moon", mercury: "Mercury", venus: "Venus", mars: "Mars", jupiter: "Jupiter",
  saturn: "Saturn", uranus: "Uranus", neptune: "Neptune", pluto: "Pluto", north_node: "North Node",
};

const norm = (deg: number) => ((deg % 360) + 360) % 360;

export const signIndex = (lon: number) => Math.floor(norm(lon) / 30);
export const signOf = (lon: number) => SIGNS[signIndex(lon)];
export const degreeInSign = (lon: number) => Math.floor(norm(lon) % 30);

/** Wheel rotation: 0 without an Ascendant, else the cusp of the Ascendant's sign. */
export function wheelRotation(chart: Pick<Chart, "ascendant">): number {
  return chart.ascendant ? signIndex(chart.ascendant.longitude) * 30 : 0;
}

/**
 * Ecliptic longitude → SVG angle in degrees, normalised to [0, 360).
 * Angles are measured clockwise from 3 o'clock in screen space (SVG y points down),
 * so 180 is 9 o'clock and increasing longitude runs counter-clockwise, as on a chart wheel.
 */
export function lonToAngle(lon: number, rotation: number): number {
  return norm(180 - (lon - rotation));
}

const C = 500;
const R_OUTER = 480;
const R_SIGN_INNER = 400;
const R_HOUSE = 378;
const R_GLYPH = 320;
const R_TICK = 400;
const R_ASPECT = 230;

function pt(angle: number, r: number): [number, number] {
  const a = (angle * Math.PI) / 180;
  return [C + r * Math.cos(a), C + r * Math.sin(a)];
}

const f = (n: number) => n.toFixed(2);

/** Arc-bounded annulus sector from a0 to a1 (going the short way, ≤ 180°). */
function sectorPath(a0: number, a1: number, rIn: number, rOut: number): string {
  const [x0, y0] = pt(a0, rOut);
  const [x1, y1] = pt(a1, rOut);
  const [x2, y2] = pt(a1, rIn);
  const [x3, y3] = pt(a0, rIn);
  // zodiac runs counter-clockwise in screen space → sweep-flag 0 on the outer arc
  return `M ${f(x0)} ${f(y0)} A ${rOut} ${rOut} 0 0 0 ${f(x1)} ${f(y1)} L ${f(x2)} ${f(y2)} A ${rIn} ${rIn} 0 0 1 ${f(x3)} ${f(y3)} Z`;
}

/** Push glyph angles apart so neighbours sit at least `min` degrees from one another. */
export function nudgeAngles(entries: { key: string; angle: number }[], min = 6): Map<string, number> {
  const out = new Map<string, number>();
  if (entries.length === 0) return out;
  // Work in longitude order (decreasing angle) so pushes propagate in one direction.
  const sorted = [...entries].sort((a, b) => b.angle - a.angle);
  let prev: number | null = null;
  for (const e of sorted) {
    let a = e.angle;
    if (prev !== null && prev - a < min) a = prev - min;
    out.set(e.key, a);
    prev = a;
  }
  // Wrap-around: the lowest angle may now sit within `min` of the highest across 0/360;
  // push it further down (away from its own neighbour, which is above it).
  const first = out.get(sorted[0].key)!;
  const lastKey = sorted[sorted.length - 1].key;
  const last = out.get(lastKey)!;
  if (sorted.length > 1 && last + 360 - first < min) out.set(lastKey, first - 360 + min);
  for (const [k, v] of out) out.set(k, norm(v));
  return out;
}

const ASPECT_COLORS: Record<string, string> = {
  conjunction: "var(--color-gold)",
  opposition: "var(--color-aspect-hard, #B5565A)",
  square: "var(--color-aspect-hard, #B5565A)",
  trine: "var(--color-aspect-soft, #5B7FB5)",
  sextile: "var(--color-aspect-soft, #5B7FB5)",
};
const aspectColor = (kind: string) => ASPECT_COLORS[kind] ?? "var(--color-muted)";

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function chartSummary(chart: Chart): string {
  const parts = [
    `Sun in ${signOf(chart.planets.sun.longitude)}`,
    `Moon in ${signOf(chart.planets.moon.longitude)}`,
    chart.ascendant ? `Ascendant in ${signOf(chart.ascendant.longitude)}` : "Ascendant unknown",
  ];
  return `Birth chart wheel: ${parts.join(", ")}.`;
}

export interface ChartWheelProps {
  chart: Chart;
  size?: number;
  className?: string;
}

export function ChartWheel({ chart, size = 400, className }: ChartWheelProps) {
  const rotation = wheelRotation(chart);
  const ascSign = chart.ascendant ? signIndex(chart.ascendant.longitude) : null;

  const bodies = BODIES.filter((b) => chart.planets[b]).map((b) => ({
    key: b,
    lon: chart.planets[b].longitude,
    angle: lonToAngle(chart.planets[b].longitude, rotation),
  }));
  const glyphAngles = nudgeAngles(bodies);
  const bodyAngle = new Map(bodies.map((b) => [b.key, b.angle] as const));

  return (
    <svg
      role="img"
      aria-label={chartSummary(chart)}
      viewBox="0 0 1000 1000"
      width={size}
      height={size}
      className={className}
      style={{ color: "var(--color-ink)" }}
    >
      {/* field */}
      <circle cx={C} cy={C} r={R_OUTER} fill="var(--color-bg-deep)" stroke="var(--color-gold)" strokeWidth={2} />
      <circle cx={C} cy={C} r={R_SIGN_INNER} fill="none" stroke="var(--color-gold)" strokeWidth={1.5} />
      <circle cx={C} cy={C} r={R_HOUSE - 24} fill="none" stroke="var(--color-gold)" strokeOpacity={0.35} strokeWidth={1} />
      <circle cx={C} cy={C} r={R_ASPECT} fill="none" stroke="var(--color-gold)" strokeOpacity={0.25} strokeWidth={1} />

      {/* sign ring */}
      <g data-layer="signs">
        {SIGNS.map((sign, i) => {
          const start = lonToAngle(i * 30, rotation);
          const end = lonToAngle(i * 30 + 30, rotation);
          const mid = lonToAngle(i * 30 + 15, rotation);
          const [gx, gy] = pt(mid, (R_OUTER + R_SIGN_INNER) / 2);
          const house = ascSign === null ? null : ((i - ascSign + 12) % 12) + 1;
          const [hx, hy] = pt(mid, R_HOUSE - 2);
          return (
            <g
              key={sign}
              data-sign={sign}
              data-house={house ?? undefined}
              data-start-angle={start}
              data-end-angle={end}
            >
              <path
                d={sectorPath(start, end, R_SIGN_INNER, R_OUTER)}
                fill={i % 2 === 0 ? "var(--color-gold)" : "none"}
                fillOpacity={0.06}
                stroke="var(--color-gold)"
                strokeOpacity={0.5}
                strokeWidth={1}
              />
              <text
                x={f(gx)}
                y={f(gy)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={38}
                fill="var(--color-gold-hi)"
              >
                {SIGN_GLYPHS[i]}
              </text>
              {house !== null ? (
                <text
                  x={f(hx)}
                  y={f(hy)}
                  textAnchor="middle"
                  dominantBaseline="central"
                  fontSize={22}
                  fill="var(--color-muted)"
                >
                  {house}
                </text>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* aspects */}
      <g data-layer="aspects">
        {chart.aspects.map((asp, i) => {
          const a = bodyAngle.get(asp.a as Body);
          const b = bodyAngle.get(asp.b as Body);
          if (a === undefined || b === undefined) return null;
          const [x1, y1] = pt(a, R_ASPECT);
          const [x2, y2] = pt(b, R_ASPECT);
          return (
            <line
              key={`${asp.a}-${asp.b}-${asp.kind}-${i}`}
              data-aspect={asp.kind}
              data-a={asp.a}
              data-b={asp.b}
              x1={f(x1)}
              y1={f(y1)}
              x2={f(x2)}
              y2={f(y2)}
              stroke={aspectColor(asp.kind)}
              strokeWidth={asp.kind === "conjunction" ? 3 : 1.5}
              strokeOpacity={0.85}
            >
              <title>
                {`${BODY_NAMES[asp.a as Body] ?? asp.a} ${asp.kind} ${BODY_NAMES[asp.b as Body] ?? asp.b}`}
              </title>
            </line>
          );
        })}
      </g>

      {/* planets */}
      <g data-layer="planets">
        {bodies.map((b) => {
          const ga = glyphAngles.get(b.key) ?? b.angle;
          const [tx0, ty0] = pt(b.angle, R_TICK);
          const [tx1, ty1] = pt(b.angle, R_TICK - 14);
          const [px, py] = pt(b.angle, R_ASPECT);
          const [gx, gy] = pt(ga, R_GLYPH);
          const [lx, ly] = pt(ga, R_GLYPH + 30);
          const key = b.key as Body;
          const placement = chart.planets[key];
          const house = placement.house;
          return (
            <g key={b.key} data-body={b.key} data-angle={b.angle} data-glyph-angle={ga}>
              <title>
                {`${BODY_NAMES[key]} in ${signOf(b.lon)} ${degreeInSign(b.lon)}°${
                  house ? `, ${ordinal(house)} house` : ""
                }${placement.retrograde ? " (retrograde)" : ""}`}
              </title>
              <line x1={f(tx0)} y1={f(ty0)} x2={f(tx1)} y2={f(ty1)} stroke="currentColor" strokeWidth={2} />
              <line
                x1={f(tx1)}
                y1={f(ty1)}
                x2={f(lx)}
                y2={f(ly)}
                stroke="currentColor"
                strokeOpacity={0.35}
                strokeWidth={1}
              />
              <circle cx={f(px)} cy={f(py)} r={4} fill="currentColor" />
              <text
                x={f(gx)}
                y={f(gy)}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={40}
                fill="currentColor"
              >
                {BODY_GLYPHS[key]}
              </text>
              {placement.retrograde ? (
                <text
                  x={f(gx + 22)}
                  y={f(gy - 18)}
                  fontSize={16}
                  fill="var(--color-muted)"
                  textAnchor="middle"
                >
                  ℞
                </text>
              ) : null}
            </g>
          );
        })}
      </g>

      {/* angles */}
      <g data-layer="angles">
        {chart.ascendant ? <AngleTick label="AC" point="ac" lon={chart.ascendant.longitude} rotation={rotation} /> : null}
        {chart.mc ? <AngleTick label="MC" point="mc" lon={chart.mc.longitude} rotation={rotation} /> : null}
      </g>
    </svg>
  );
}

function AngleTick({ label, point, lon, rotation }: { label: string; point: string; lon: number; rotation: number }) {
  const angle = lonToAngle(lon, rotation);
  const [x0, y0] = pt(angle, R_ASPECT);
  const [x1, y1] = pt(angle, R_OUTER);
  // label sits between the aspect circle and the planet glyphs, with a dark halo for legibility
  const [lx, ly] = pt(angle, R_ASPECT + 32);
  return (
    <g data-point={point} data-angle={angle}>
      <line x1={f(x0)} y1={f(y0)} x2={f(x1)} y2={f(y1)} stroke="var(--color-gold-hi)" strokeWidth={2.5} />
      <text
        x={f(lx)}
        y={f(ly)}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={22}
        fontWeight={600}
        fill="var(--color-gold-hi)"
        stroke="var(--color-bg-deep)"
        strokeWidth={6}
        paintOrder="stroke"
      >
        {label}
      </text>
    </g>
  );
}
