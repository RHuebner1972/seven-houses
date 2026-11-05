"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CardFan } from "@/components/card-fan";
import { useApi } from "@/components/providers";
import { ReadingStream, type CardsEvent } from "@/components/reading-stream";
import { useToast } from "@/components/toast";
import { useMe } from "@/hooks/use-me";
import { useProfiles } from "@/hooks/use-profiles";
import { useSpreads } from "@/hooks/use-spreads";
import { isCode } from "@/lib/errors";
import type { DrawnCard, ReadingRequest, Spread } from "@/lib/types";

export const QUESTION_MAX = 500;
export const REVEAL_MS = 600;

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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const abortError = () => new DOMException("Handled by the reading page", "AbortError");

export default function ReadingNewPage() {
  // useSearchParams needs a Suspense boundary so the static export can prerender the shell.
  return (
    <Suspense
      fallback={
        <section className={shell}>
          <Spinner label="Loading…" />
        </section>
      }
    >
      <ReadingNew />
    </Suspense>
  );
}

type FormError = { kind: "credits"; needed: number } | { kind: "rate" };

type Session = {
  request: ReadingRequest;
  spread: Spread;
};

function ReadingNew() {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const requestedProfile = useSearchParams().get("profile");
  const spreads = useSpreads();
  const profiles = useProfiles();
  const me = useMe();

  const [spreadType, setSpreadType] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [useChart, setUseChart] = useState(true);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);

  const [session, setSession] = useState<Session | null>(null);
  const [cards, setCards] = useState<DrawnCard[]>([]);
  const [revealIndex, setRevealIndex] = useState(0);
  const [done, setDone] = useState(false);
  const readingIdRef = useRef<string | null>(null);
  const cardsRef = useRef<DrawnCard[]>([]);
  const deltasRef = useRef(0);

  const spreadList = useMemo(() => spreads.data ?? [], [spreads.data]);
  const spread = useMemo(
    () => spreadList.find((s) => s.type === spreadType) ?? spreadList[0] ?? null,
    [spreadList, spreadType],
  );
  const profileList = useMemo(() => profiles.data ?? [], [profiles.data]);
  const selectedProfile = useMemo(() => {
    if (profileList.length === 0) return null;
    return (
      profileList.find((p) => p.id === profileId) ??
      profileList.find((p) => p.id === requestedProfile) ??
      profileList[0]
    );
  }, [profileList, profileId, requestedProfile]);

  // Sequential reveal: one card per REVEAL_MS after `cards` arrives; all at once under reduced motion.
  useEffect(() => {
    if (cards.length === 0) return;
    const reduced = prefersReducedMotion();
    let shown = 0;
    // first card as soon as the cards land, then one per REVEAL_MS (or all at once)
    const first = setTimeout(() => {
      shown = reduced ? cards.length : 1;
      setRevealIndex(shown);
    }, 0);
    const every = reduced
      ? null
      : setInterval(() => {
          shown = Math.min(shown + 1, cards.length);
          setRevealIndex(shown);
          if (shown >= cards.length && every) clearInterval(every);
        }, REVEAL_MS);
    return () => {
      clearTimeout(first);
      if (every) clearInterval(every);
    };
  }, [cards]);

  const begin = () => {
    if (!spread) return;
    const request: ReadingRequest = { spread_type: spread.type };
    const q = question.trim();
    if (q) request.question = q;
    if (useChart && selectedProfile) request.profile_id = selectedProfile.id;
    readingIdRef.current = null;
    cardsRef.current = [];
    deltasRef.current = 0;
    setCards([]);
    setRevealIndex(0);
    setDone(false);
    setFormError(null);
    setSession({ request, spread });
  };

  /**
   * Fed to <ReadingStream>. A reading that already has an id (an `error` event arrived after
   * `cards`) is retried in place; before that, Retry simply starts again. Credit and rate
   * refusals return the user to the form and tell the stream to step aside.
   */
  const source = useCallback(
    async (signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
      const s = session;
      if (!s) throw abortError();
      try {
        return readingIdRef.current
          ? await api.retryReading(readingIdRef.current, signal)
          : await api.startReading(s.request, signal);
      } catch (e) {
        if (signal.aborted) throw e;
        if (isCode(e, "insufficient_credits")) {
          setFormError({ kind: "credits", needed: s.spread.credits });
        } else if (isCode(e, "rate_limited")) {
          setFormError({ kind: "rate" });
        } else {
          throw e;
        }
        setSession(null);
        qc.invalidateQueries({ queryKey: ["me"] });
        throw abortError();
      }
    },
    [api, qc, session],
  );

  const onCards = useCallback(
    (e: CardsEvent) => {
      readingIdRef.current = e.reading_id;
      const same =
        cardsRef.current.length === e.cards.length &&
        cardsRef.current.every(
          (c, i) => c.card_id === e.cards[i].card_id && c.position === e.cards[i].position && c.reversed === e.cards[i].reversed,
        );
      if (!same) {
        cardsRef.current = e.cards;
        setCards(e.cards);
        setRevealIndex(0);
      }
      // the server has debited the spread: re-read the balance rather than computing it
      qc.invalidateQueries({ queryKey: ["me"] });
    },
    [qc],
  );

  const onDelta = useCallback(() => {
    deltasRef.current += 1;
  }, []);

  const onDone = useCallback(() => {
    setDone(true);
    qc.invalidateQueries({ queryKey: ["readings"] });
  }, [qc]);

  const onAbort = useCallback(() => {
    if (deltasRef.current > 0) toast("Your reading is being saved to your journal");
  }, [toast]);

  // Done, error or abandoned: the balance may have moved either way (debit, refund), so re-read it.
  const onSettled = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["me"] });
  }, [qc]);

  const reset = () => {
    setSession(null);
    setDone(false);
    setCards([]);
    setRevealIndex(0);
    readingIdRef.current = null;
    cardsRef.current = [];
    deltasRef.current = 0;
  };

  if (session) {
    return (
      <section className={shell}>
        <h1 className="text-4xl text-gold-hi">{session.spread.name}</h1>
        {session.request.question ? (
          <p className="mt-2 italic text-muted">“{session.request.question}”</p>
        ) : null}
        <CardFan
          spreadType={session.spread.type}
          cards={cards}
          positions={session.spread.positions}
          revealIndex={revealIndex}
          className="mt-8"
        />
        <div className="mt-10">
          <ReadingStream
            source={source}
            onCards={onCards}
            onDelta={onDelta}
            onDone={onDone}
            onAbort={onAbort}
            onSettled={onSettled}
          />
        </div>
        {done ? (
          <div className="mt-10 flex flex-wrap items-center gap-4">
            <p className="text-muted">
              Saved to your journal.{" "}
              <Link href="/journal/" className="text-gold-hi underline-offset-4 hover:underline">
                Open journal
              </Link>
            </p>
            <button type="button" onClick={reset} className={smallButton}>
              Another reading
            </button>
          </div>
        ) : null}
      </section>
    );
  }

  const balance = me.data?.balance;

  return (
    <section className={shell}>
      <h1 className="text-4xl text-gold-hi">A new reading</h1>
      <p className="mt-2 text-muted">Choose a spread, ask what you will, and let the cards speak.</p>

      {spreads.isPending ? (
        <div className="mt-8">
          <Spinner label="Loading spreads…" />
        </div>
      ) : null}

      {spreads.isError ? (
        <div role="alert" className="mt-8 space-y-3">
          <p className="text-gold-hi">We couldn&apos;t load the spreads right now.</p>
          <button type="button" onClick={() => spreads.refetch()} className={smallButton}>
            Retry
          </button>
        </div>
      ) : null}

      {spreads.isSuccess && spread ? (
        <form
          className="mt-8 space-y-8"
          onSubmit={(e) => {
            e.preventDefault();
            begin();
          }}
        >
          <fieldset>
            <legend className="font-display text-2xl text-gold-hi">Spread</legend>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {spreadList.map((s) => {
                const checked = s.type === spread.type;
                return (
                  <label
                    key={s.type}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-4 ${
                      checked ? "border-gold bg-gold/5" : "border-gold/30 bg-bg-deep/60 hover:border-gold/60"
                    }`}
                  >
                    <input
                      type="radio"
                      name="spread"
                      value={s.type}
                      checked={checked}
                      onChange={() => {
                        setSpreadType(s.type);
                        setFormError(null);
                      }}
                      className="mt-1 accent-[var(--gold)]"
                    />
                    <span className="flex flex-col">
                      <span className="font-display text-xl text-gold-hi">{s.name}</span>
                      <span className="text-sm text-muted">
                        {plural(s.credits, "credit")} · {plural(s.positions.length, "card")}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div>
            <label htmlFor="question" className="font-display text-2xl text-gold-hi">
              Your question <span className="text-base text-muted">(optional)</span>
            </label>
            <textarea
              id="question"
              name="question"
              value={question}
              maxLength={QUESTION_MAX}
              rows={3}
              placeholder="What would you like the cards to speak to?"
              onChange={(e) => setQuestion(e.target.value.slice(0, QUESTION_MAX))}
              className="mt-3 w-full rounded-lg border border-gold/30 bg-bg-deep/60 px-4 py-3 text-ink placeholder:text-muted/70 focus:border-gold focus:outline-none"
            />
            <p className="mt-1 text-right text-xs text-muted" aria-live="polite">
              {question.length} / {QUESTION_MAX}
            </p>
          </div>

          {profileList.length > 0 ? (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-gold/30 bg-bg-deep/60 p-4">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  role="switch"
                  checked={useChart}
                  aria-checked={useChart}
                  onChange={(e) => setUseChart(e.target.checked)}
                  className="h-5 w-5 accent-[var(--gold)]"
                />
                <span className="text-ink">Read through my chart</span>
              </label>
              {profileList.length > 1 ? (
                <select
                  aria-label="Chart"
                  value={selectedProfile?.id ?? ""}
                  disabled={!useChart}
                  onChange={(e) => setProfileId(e.target.value)}
                  className="rounded-md border border-gold/30 bg-bg px-3 py-1.5 text-sm text-ink disabled:opacity-50"
                >
                  {profileList.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              ) : (
                <span className={`text-sm ${useChart ? "text-gold-hi" : "text-muted"}`}>{selectedProfile?.name}</span>
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-4">
            <button type="submit" className={button}>
              Begin the reading
            </button>
            <p className="text-sm text-muted">
              Costs {plural(spread.credits, "credit")}
              {balance !== undefined ? ` · you have ${balance}` : ""}
            </p>
          </div>

          {formError ? (
            <div role="alert" className="rounded-lg border border-gold/40 bg-gold/5 p-4 text-gold-hi">
              {formError.kind === "credits" ? (
                <p>
                  You need {plural(formError.needed, "credit")} for this spread.{" "}
                  <Link href="/store/" className="underline underline-offset-4">
                    Visit the Store
                  </Link>
                </p>
              ) : (
                <p>Please wait a little before another reading.</p>
              )}
            </div>
          ) : null}
        </form>
      ) : null}
    </section>
  );
}
