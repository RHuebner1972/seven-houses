"use client";

import { Card } from "@/components/card";
import type { DrawnCard, Position } from "@/lib/types";

export type CardFanProps = {
  /** Spread type; `celtic_cross` gets the cross-and-staff layout, everything else a row. */
  spreadType: string;
  cards: DrawnCard[];
  positions: Position[];
  /** Cards at index < revealIndex are face-up. */
  revealIndex: number;
  className?: string;
};

/** Grid cells for the classic Celtic Cross: cross on the left (12 rows, 4 per card), staff on the right (3 per card). */
const CELTIC_CELLS: Record<string, { col: number; row: string }> = {
  above: { col: 2, row: "1 / span 4" },
  past: { col: 1, row: "5 / span 4" },
  present: { col: 2, row: "5 / span 4" },
  future: { col: 3, row: "5 / span 4" },
  below: { col: 2, row: "9 / span 4" },
  outcome: { col: 4, row: "1 / span 3" },
  hopes_fears: { col: 4, row: "4 / span 3" },
  external: { col: 4, row: "7 / span 3" },
  advice: { col: 4, row: "10 / span 3" },
};

const PLACEHOLDER = "major-00-fool";

type Size = "sm" | "md";

function Slot({
  position,
  card,
  faceUp,
  size,
  crossing = false,
  captionHidden = false,
}: {
  position: Position;
  card: DrawnCard | undefined;
  faceUp: boolean;
  size: Size;
  crossing?: boolean;
  captionHidden?: boolean;
}) {
  const img = (
    <Card id={card?.card_id ?? PLACEHOLDER} reversed={card?.reversed ?? false} faceUp={card !== undefined && faceUp} size={size} />
  );
  return (
    <figure
      role="group"
      aria-label={position.name}
      title={position.meaning}
      data-crossing={crossing ? "true" : undefined}
      className={
        crossing
          ? "absolute inset-0 grid place-items-center"
          : "flex flex-col items-center gap-1.5"
      }
    >
      {/* The wrapper rotates so the card's own alt/orientation stay honest. */}
      {crossing ? <div className="rotate-90 motion-reduce:transition-none">{img}</div> : img}
      <figcaption className={captionHidden ? "sr-only" : "text-center text-xs text-muted"}>
        {position.name}
      </figcaption>
    </figure>
  );
}

export function CardFan({ spreadType, cards, positions, revealIndex, className = "" }: CardFanProps) {
  const byKey = new Map(cards.map((c, i) => [c.position, { card: c, index: i }]));
  const at = (p: Position) => byKey.get(p.key);
  const isUp = (p: Position) => {
    const hit = at(p);
    return hit !== undefined && hit.index < revealIndex;
  };

  if (spreadType === "celtic_cross" && positions.some((p) => p.key === "present")) {
    const present = positions.find((p) => p.key === "present")!;
    const challenge = positions.find((p) => p.key === "challenge");
    const rest = positions.filter((p) => p.key !== "present" && p.key !== "challenge");
    return (
      <div
        aria-label="Celtic Cross spread"
        role="list"
        className={`grid justify-center gap-x-6 gap-y-3 ${className}`}
        style={{
          gridTemplateColumns: "repeat(4, max-content)",
          gridTemplateRows: "repeat(12, minmax(0, 1fr))",
          alignItems: "center",
        }}
      >
        <div
          role="listitem"
          className="flex flex-col items-center gap-1.5"
          style={{ gridColumn: CELTIC_CELLS.present.col, gridRow: CELTIC_CELLS.present.row }}
        >
          <div className="relative">
            <Slot position={present} card={at(present)?.card} faceUp={isUp(present)} size="sm" captionHidden />
            {challenge ? (
              <Slot
                position={challenge}
                card={at(challenge)?.card}
                faceUp={isUp(challenge)}
                size="sm"
                crossing
                captionHidden
              />
            ) : null}
          </div>
          <p aria-hidden="true" className="text-center text-xs text-muted">
            {present.name}
            {challenge ? ` · ${challenge.name}` : ""}
          </p>
        </div>
        {rest.map((p) => {
          const cell = CELTIC_CELLS[p.key];
          return (
            <div
              key={p.key}
              role="listitem"
              style={cell ? { gridColumn: cell.col, gridRow: cell.row } : undefined}
            >
              <Slot position={p} card={at(p)?.card} faceUp={isUp(p)} size="sm" />
            </div>
          );
        })}
      </div>
    );
  }

  return (
    <div role="list" aria-label="Spread" className={`flex flex-wrap justify-center gap-6 ${className}`}>
      {positions.map((p) => (
        <div key={p.key} role="listitem">
          <Slot position={p} card={at(p)?.card} faceUp={isUp(p)} size="md" />
        </div>
      ))}
    </div>
  );
}
