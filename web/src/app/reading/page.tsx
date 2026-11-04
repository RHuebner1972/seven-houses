"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CardFan } from "@/components/card-fan";
import { useApi } from "@/components/providers";
import { ReadingStream, paragraphs } from "@/components/reading-stream";
import { READINGS_KEY, readingKey, useReading } from "@/hooks/use-readings";
import { useSpreads } from "@/hooks/use-spreads";
import { isCode } from "@/lib/errors";
import { formatReadingDate, positionsFor, spreadName } from "@/lib/readings";
import type { Reading } from "@/lib/types";

const shell = "mx-auto max-w-3xl px-6 pt-10 pb-28 md:pb-16";
const button =
  "inline-block rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50";
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

function BackToJournal() {
  return (
    <Link href="/journal/" className="text-sm text-muted hover:text-ink">
      ← Your journal
    </Link>
  );
}

export default function ReadingPage() {
  // useSearchParams needs a Suspense boundary so the static export can prerender the shell.
  return (
    <Suspense
      fallback={
        <section className={shell}>
          <Spinner label="Loading…" />
        </section>
      }
    >
      <ReadingRoute />
    </Suspense>
  );
}

function ReadingRoute() {
  const id = useSearchParams().get("id");
  if (!id) {
    return (
      <section className={shell}>
        <h1 className="text-4xl text-gold-hi">A reading</h1>
        <p className="mt-2 text-muted">Choose a reading from your journal to open it here.</p>
        <Link href="/journal/" className={`${button} mt-6`}>
          Open your journal
        </Link>
      </section>
    );
  }
  return <ReadingDetail id={id} />;
}

function ReadingDetail({ id }: { id: string }) {
  const q = useReading(id);
  const spreads = useSpreads({ includeDaily: true });

  if (q.isPending) {
    return (
      <section className={shell}>
        <Spinner label="Opening your reading…" />
      </section>
    );
  }

  if (q.isError) {
    const missing = isCode(q.error, "not_found");
    return (
      <section className={shell}>
        <div role="alert" className="space-y-3">
          <p className="text-gold-hi">
            {missing
              ? "We couldn't find that reading. It may have been removed."
              : "We couldn't load this reading right now."}
          </p>
          {!missing ? (
            <button type="button" onClick={() => q.refetch()} className={smallButton}>
              Retry
            </button>
          ) : null}
        </div>
        <div className="mt-6">
          <BackToJournal />
        </div>
      </section>
    );
  }

  const reading = q.data;
  const name = spreadName(reading.spread_type, spreads.data);
  const positions = positionsFor(reading.spread_type, reading.cards, spreads.data);

  return (
    <section className={shell}>
      <BackToJournal />
      <h1 className="mt-3 text-4xl text-gold-hi">{name}</h1>
      <p className="mt-1 text-muted">
        <time dateTime={reading.created_at}>{formatReadingDate(reading.created_at)}</time>
      </p>
      {reading.question ? <p className="mt-3 italic text-muted">“{reading.question}”</p> : null}

      <CardFan
        spreadType={reading.spread_type}
        cards={reading.cards}
        positions={positions}
        revealIndex={reading.cards.length}
        className="mt-8"
      />

      <div className="mt-10">
        <ReadingBody reading={reading} stalled={q.stalled} onCheckAgain={() => q.refetch()} />
      </div>
    </section>
  );
}

function ReadingBody({
  reading,
  stalled,
  onCheckAgain,
}: {
  reading: Reading;
  stalled: boolean;
  onCheckAgain: () => void;
}) {
  const api = useApi();
  const qc = useQueryClient();
  const [retrying, setRetrying] = useState(false);

  const source = useCallback(
    (signal: AbortSignal) => api.retryReading(reading.id, signal),
    [api, reading.id],
  );
  const onDone = useCallback(() => {
    // the server has the finished text now: re-read it, and refresh the journal's excerpt
    qc.invalidateQueries({ queryKey: readingKey(reading.id) });
    qc.invalidateQueries({ queryKey: READINGS_KEY });
  }, [qc, reading.id]);

  // Keep the live stream on screen until the re-read reading arrives complete, so the text never flickers.
  if (retrying && reading.status !== "complete") {
    return <ReadingStream source={source} onDone={onDone} />;
  }

  if (reading.status === "pending") {
    return (
      <div className="space-y-3">
        {stalled ? (
          <div role="status" className="space-y-3 text-muted">
            <p>Still preparing your reading. It may take a little longer than usual.</p>
            <button type="button" onClick={onCheckAgain} className={smallButton}>
              Check again
            </button>
          </div>
        ) : (
          <Spinner label="Preparing…" />
        )}
      </div>
    );
  }

  const paras = paragraphs(reading.text ?? "");

  return (
    <div className="space-y-4">
      {paras.map((p, i) => (
        <p key={i} className="leading-relaxed">
          {p}
        </p>
      ))}
      {reading.status === "failed" ? (
        <div role="alert" className="space-y-3 rounded-lg border border-gold/40 bg-gold/5 p-4">
          <p className="text-gold-hi">This reading didn&apos;t complete. Your cards are kept; try the reading again.</p>
          <button type="button" onClick={() => setRetrying(true)} className={smallButton}>
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}
