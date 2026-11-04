"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Card } from "@/components/card";
import { useReadings } from "@/hooks/use-readings";
import { useSpreads } from "@/hooks/use-spreads";
import { STATUS_LABEL, formatReadingDate, newestFirst, spreadName } from "@/lib/readings";
import type { ReadingSummary } from "@/lib/types";

export const JOURNAL_LIMIT = 50;
/** How many cards a journal row shows. */
export const ROW_CARDS = 3;

const shell = "mx-auto max-w-3xl px-6 pt-10 pb-28 md:pb-16";
const button =
  "inline-block rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10";
const smallButton =
  "rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10";

function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-muted">
      <span
        aria-hidden="true"
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gold/30 border-t-gold motion-reduce:animate-none"
      />
      {label}
    </div>
  );
}

function matches(r: ReadingSummary, needle: string): boolean {
  if (!needle) return true;
  const hay = `${r.excerpt ?? ""}\n${r.question ?? ""}`.toLowerCase();
  return hay.includes(needle);
}

export default function JournalPage() {
  const readings = useReadings(JOURNAL_LIMIT);
  const spreads = useSpreads({ includeDaily: true });
  const [query, setQuery] = useState("");

  const sorted = useMemo(() => newestFirst(readings.data ?? []), [readings.data]);
  const needle = query.trim().toLowerCase();
  const shown = useMemo(() => sorted.filter((r) => matches(r, needle)), [sorted, needle]);

  return (
    <section className={shell}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl text-gold-hi">Your journal</h1>
          <p className="mt-2 text-muted">Every reading, kept.</p>
        </div>
        <Link href="/reading/new/" className={button}>
          New reading
        </Link>
      </div>

      {readings.isPending ? (
        <div className="mt-8">
          <Spinner label="Opening your journal…" />
        </div>
      ) : null}

      {readings.isError ? (
        <div role="alert" className="mt-8 space-y-3">
          <p className="text-gold-hi">We couldn&apos;t load your journal right now.</p>
          <button type="button" onClick={() => readings.refetch()} className={smallButton}>
            Retry
          </button>
        </div>
      ) : null}

      {readings.isSuccess && sorted.length === 0 ? (
        <div className="mt-8 rounded-lg border border-gold/30 bg-bg-deep/60 p-6">
          <h2 className="text-2xl text-gold-hi">No readings yet</h2>
          <p className="mt-2 leading-relaxed text-muted">
            Your daily cards and full readings gather here, so you can return to what the cards said and
            see how it unfolded.
          </p>
          <Link href="/reading/new/" className={`${button} mt-5`}>
            Begin your first reading
          </Link>
        </div>
      ) : null}

      {readings.isSuccess && sorted.length > 0 ? (
        <>
          <div className="mt-8">
            <label htmlFor="journal-search" className="sr-only">
              Search your journal
            </label>
            <input
              id="journal-search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your readings…"
              className="w-full rounded-lg border border-gold/30 bg-bg-deep/60 px-4 py-3 text-ink placeholder:text-muted/70 focus:border-gold focus:outline-none"
            />
          </div>

          {shown.length === 0 ? (
            <p className="mt-6 text-muted" role="status">
              Nothing in your journal matches “{query.trim()}”.
            </p>
          ) : (
            <ul className="mt-6 divide-y divide-gold/20 rounded-lg border border-gold/30 bg-bg-deep/60">
              {shown.map((r) => (
                <li key={r.id}>
                  <JournalRow reading={r} spread={spreadName(r.spread_type, spreads.data)} />
                </li>
              ))}
            </ul>
          )}
        </>
      ) : null}
    </section>
  );
}

function JournalRow({ reading: r, spread }: { reading: ReadingSummary; spread: string }) {
  const badge = STATUS_LABEL[r.status];
  return (
    <Link
      href={`/reading/?id=${encodeURIComponent(r.id)}`}
      className="flex gap-4 px-5 py-4 hover:bg-gold/5 focus:bg-gold/5 focus:outline-none"
    >
      <div className="flex shrink-0 -space-x-6">
        {r.cards.slice(0, ROW_CARDS).map((c, i) => (
          <div key={`${c.position}-${i}`} style={{ zIndex: ROW_CARDS - i }} className="drop-shadow-md">
            <Card id={c.card_id} reversed={c.reversed} faceUp size="sm" />
          </div>
        ))}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-display text-xl text-gold-hi">{spread}</span>
          <time dateTime={r.created_at} className="text-sm text-muted">
            {formatReadingDate(r.created_at)}
          </time>
          {badge ? (
            <span
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                r.status === "failed" ? "border-gold/60 text-gold-hi" : "border-muted/40 text-muted"
              }`}
            >
              {badge}
            </span>
          ) : null}
        </div>
        {r.question ? <p className="mt-1 truncate italic text-muted">“{r.question}”</p> : null}
        {r.excerpt ? <p className="mt-1 line-clamp-2 text-ink/90">{r.excerpt}</p> : null}
      </div>
    </Link>
  );
}
