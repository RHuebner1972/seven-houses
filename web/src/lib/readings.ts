import type { DrawnCard, Position, Spread } from "@/lib/types";

/** "three_card" → "Three Card" when the spread catalogue is unavailable. */
export function humanizeSpreadType(type: string): string {
  return type
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function spreadName(type: string, spreads: Spread[] | undefined): string {
  return spreads?.find((s) => s.type === type)?.name ?? humanizeSpreadType(type);
}

/**
 * Positions to lay a stored reading out with: the catalogue's if we have it, otherwise one slot
 * per drawn card named after its position key (so a reading never renders without its cards).
 */
export function positionsFor(type: string, cards: DrawnCard[], spreads: Spread[] | undefined): Position[] {
  const spread = spreads?.find((s) => s.type === type);
  if (spread && cards.every((c) => spread.positions.some((p) => p.key === c.position))) {
    return spread.positions;
  }
  return cards.map((c) => ({ key: c.position, name: humanizeSpreadType(c.position), meaning: "" }));
}

/** "Nov 1, 2026" in the viewer's time zone. */
export function formatReadingDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(d);
}

export const STATUS_LABEL: Record<string, string> = {
  pending: "Preparing…",
  failed: "Didn't complete — retry",
};

/** Newest first by `created_at`; stable for equal timestamps. */
export function newestFirst<T extends { created_at: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}
