import { BODIES, type Body, type Chart, type Placement } from "@/lib/types";
import { BODY_GLYPHS, BODY_NAMES, degreeInSign, ordinal, signOf } from "@/components/chart-wheel";

const HOUSE_NOTES: Record<NonNullable<Chart["houses_unavailable_reason"]>, string> = {
  unknown_time: "Houses need a birth time. Add one to see which house each planet falls in.",
  polar_latitude: "Houses aren't computed this far north/south, where the Ascendant is undefined.",
};

export function describePlacement(name: string, p: Placement): string {
  const base = `${name} in ${signOf(p.longitude)} ${degreeInSign(p.longitude)}°`;
  const house = p.house ? `, ${ordinal(p.house)} house` : "";
  const retro = p.retrograde ? " (retrograde)" : "";
  return `${base}${house}${retro}`;
}

const bodyName = (key: string) => BODY_NAMES[key as Body] ?? key;

export function Placements({ chart }: { chart: Chart }) {
  const note = chart.houses_unavailable_reason ? HOUSE_NOTES[chart.houses_unavailable_reason] : null;
  return (
    <div className="space-y-6">
      <section aria-labelledby="placements-heading">
        <h2 id="placements-heading" className="text-2xl text-gold-hi">
          Placements
        </h2>
        {note ? <p className="mt-1 text-sm text-muted">{note}</p> : null}
        <ul className="mt-3 space-y-1.5">
          {BODIES.filter((b) => chart.planets[b]).map((b) => (
            <li key={b} className="flex items-baseline gap-3">
              <span aria-hidden="true" className="w-6 text-center text-xl text-gold">
                {BODY_GLYPHS[b]}
              </span>
              <span>{describePlacement(BODY_NAMES[b], chart.planets[b])}</span>
            </li>
          ))}
          {chart.ascendant ? (
            <li className="flex items-baseline gap-3">
              <span aria-hidden="true" className="w-6 text-center text-sm font-semibold text-gold">
                AC
              </span>
              <span>{describePlacement("Ascendant", { ...chart.ascendant, house: null })}</span>
            </li>
          ) : null}
          {chart.mc ? (
            <li className="flex items-baseline gap-3">
              <span aria-hidden="true" className="w-6 text-center text-sm font-semibold text-gold">
                MC
              </span>
              <span>{describePlacement("Midheaven", { ...chart.mc, house: null })}</span>
            </li>
          ) : null}
        </ul>
      </section>

      <section aria-labelledby="aspects-heading">
        <h2 id="aspects-heading" className="text-2xl text-gold-hi">
          Aspects
        </h2>
        {chart.aspects.length === 0 ? (
          <p className="mt-1 text-sm text-muted">No major aspects within orb.</p>
        ) : (
          <ul className="mt-3 space-y-1.5">
            {chart.aspects.map((a, i) => (
              <li key={`${a.a}-${a.b}-${a.kind}-${i}`} className="flex items-baseline gap-3">
                <span aria-hidden="true" className="w-6 text-center text-xl text-gold">
                  {BODY_GLYPHS[a.a as Body] ?? "·"}
                </span>
                <span>
                  {bodyName(a.a)} {a.kind} {bodyName(a.b)}
                  <span className="text-muted"> · {a.orb.toFixed(1)}° orb</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
