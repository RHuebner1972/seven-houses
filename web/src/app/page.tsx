"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { Card } from "@/components/card";
import { paragraphs, ReadingStream } from "@/components/reading-stream";
import { useDaily } from "@/hooks/use-daily";
import { cardById, orientationLabel } from "@/lib/cards";

const noopSubscribe = () => () => {};
const longToday = () => new Intl.DateTimeFormat(undefined, { dateStyle: "full" }).format(new Date());

/** Today's date in the browser's locale; empty during prerender so hydration matches. */
function useLongToday(): string {
  return useSyncExternalStore(noopSubscribe, longToday, () => "");
}

export default function TodayPage() {
  const daily = useDaily();
  const { state, card, text, error } = daily;
  const today = useLongToday();
  const settled = state === "cached" || state === "complete";

  return (
    <section className="mx-auto flex max-w-2xl flex-col items-center px-6 pt-10 pb-28 text-center md:pb-16">
      <h1 className="text-4xl text-gold-hi">Your card for today</h1>
      <p className="mt-2 min-h-[1.5em] text-muted">{today}</p>

      <div className="mt-8">
        <Card
          size="lg"
          faceUp={card !== undefined}
          onFlip={state === "idle" ? daily.start : undefined}
          id={card?.card_id ?? "major-00-fool"}
          reversed={card?.reversed}
        />
      </div>

      {card ? (
        <p className="mt-4 font-display text-2xl text-gold-hi">
          {cardById(card.card_id).name}{" "}
          <span className="text-base text-muted">· {orientationLabel(card.reversed)}</span>
        </p>
      ) : state === "idle" ? (
        <p className="mt-4 text-muted">Tap the card to reveal it.</p>
      ) : null}

      <div className="mt-6 w-full text-left">
        {state === "streaming" ? (
          <ReadingStream
            source={daily.source}
            onCards={daily.onCards}
            onDelta={daily.onDelta}
            onDone={daily.onDone}
          />
        ) : null}

        {settled ? (
          <div className="space-y-4">
            {paragraphs(text).map((p, i) => (
              <p key={i} className="leading-relaxed">
                {p}
              </p>
            ))}
          </div>
        ) : null}

        {state === "waiting" ? (
          <div role="status" className="flex items-center justify-center gap-3 text-muted">
            <span
              aria-hidden="true"
              className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gold/30 border-t-gold motion-reduce:animate-none"
            />
            Your card is being prepared…
          </div>
        ) : null}

        {state === "error" && error ? (
          <div role="alert" className="space-y-3 text-center">
            <p className="text-gold-hi">{error.message}</p>
            <button
              type="button"
              onClick={daily.retry}
              className="rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10"
            >
              Retry
            </button>
          </div>
        ) : null}
      </div>

      {settled ? <p className="mt-8 text-sm text-muted">Your card renews at midnight</p> : null}

      <Link
        href="/reading/new/"
        className="mt-8 inline-block rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10"
      >
        Go deeper with a full reading
      </Link>
    </section>
  );
}
