"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApi } from "@/components/providers";
import type { CardsEvent, StreamError } from "@/components/reading-stream";
import { ApiError, isCode } from "@/lib/errors";
import { localDate, localTimeZone } from "@/lib/tz";
import type { DrawnCard, Reading } from "@/lib/types";

export const DAILY_CACHE_KEY = "sh.lastDaily";
export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_ATTEMPTS = 30;
const STILL_PREPARING: StreamError = { code: "still_preparing", message: "Still preparing your card…" };

export type DailyState = "idle" | "cached" | "streaming" | "complete" | "waiting" | "error";

type Cached = { localDate: string; reading: Reading };

function parseCache(raw: string | null): Reading | null {
  try {
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    return c?.localDate === localDate() && c.reading?.cards?.length ? c.reading : null;
  } catch {
    return null;
  }
}

function writeCache(reading: Reading) {
  try {
    const c: Cached = { localDate: localDate(), reading };
    localStorage.setItem(DAILY_CACHE_KEY, JSON.stringify(c));
  } catch {
    /* storage full or unavailable */
  }
}

// The cache is an external store: read it with useSyncExternalStore so the prerendered HTML
// (server snapshot: nothing cached) hydrates cleanly and other tabs' writes are picked up.
const subscribeStorage = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};
const rawCache = () => {
  try {
    return localStorage.getItem(DAILY_CACHE_KEY);
  } catch {
    return null;
  }
};

const abortError = () => new DOMException("Handled by useDaily", "AbortError");

export function useDaily() {
  const api = useApi();
  const [phase, setState] = useState<Exclude<DailyState, "cached">>("idle");
  const [reading, setReading] = useState<Reading>();
  const [card, setCard] = useState<DrawnCard>();
  const [text, setText] = useState("");
  const [error, setError] = useState<StreamError>();

  const alive = useRef(false);
  const cardRef = useRef<DrawnCard | undefined>(undefined);
  const textRef = useRef("");
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollCtl = useRef<AbortController | null>(null);

  const stopPolling = useCallback(() => {
    if (pollTimer.current) clearTimeout(pollTimer.current);
    pollTimer.current = null;
    pollCtl.current?.abort();
    pollCtl.current = null;
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      stopPolling();
    };
  }, [stopPolling]);

  const complete = useCallback((r: Reading) => {
    if (!alive.current) return;
    writeCache(r);
    cardRef.current = r.cards[0];
    textRef.current = r.text;
    setReading(r);
    setCard(r.cards[0]);
    setText(r.text);
    setError(undefined);
    setState("complete");
  }, []);

  const fail = useCallback((err: StreamError) => {
    if (!alive.current) return;
    setError(err);
    setState("error");
  }, []);

  const poll = useCallback(() => {
    stopPolling();
    setState("waiting");
    let attempts = 0;
    const today = localDate();
    const tz = localTimeZone();
    const tick = async () => {
      pollTimer.current = null;
      const ctl = new AbortController();
      pollCtl.current = ctl;
      attempts++;
      try {
        const [latest] = await api.readings(1);
        if (!alive.current || ctl.signal.aborted) return;
        if (
          latest &&
          latest.spread_type === "daily" &&
          latest.status === "complete" &&
          localDate(tz, new Date(latest.created_at)) === today
        ) {
          const r = await api.reading(latest.id);
          if (!alive.current || ctl.signal.aborted) return;
          pollCtl.current = null;
          complete(r);
          return;
        }
      } catch {
        if (!alive.current || ctl.signal.aborted) return;
        /* transient failure: keep polling until attempts run out */
      }
      pollCtl.current = null;
      if (attempts >= POLL_MAX_ATTEMPTS) fail(STILL_PREPARING);
      else pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
    };
    pollTimer.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [api, complete, fail, stopPolling]);

  /**
   * Fed to <ReadingStream>: issues POST /daily under the stream's AbortSignal, so unmounting
   * mid-request aborts the fetch too. Non-stream outcomes are handled here and the stream is
   * told to step aside with an AbortError.
   */
  const source = useCallback(
    async (signal: AbortSignal): Promise<ReadableStream<Uint8Array>> => {
      let res;
      try {
        res = await api.daily(localTimeZone(), signal);
      } catch (e) {
        if (signal.aborted) throw e;
        if (isCode(e, "generation_in_progress")) {
          if (alive.current) poll();
        } else if (e instanceof ApiError) {
          fail({ code: e.code, message: e.message });
        } else {
          fail({ code: "network", message: (e as Error | null)?.message || "Something went wrong." });
        }
        throw abortError();
      }
      if (res.kind === "reading") {
        complete(res.reading);
        throw abortError();
      }
      cardRef.current = undefined;
      textRef.current = "";
      if (alive.current) {
        setCard(undefined);
        setText("");
      }
      return res.body;
    },
    [api, complete, fail, poll],
  );

  const onCards = useCallback((e: CardsEvent) => {
    cardRef.current = e.cards[0];
    if (alive.current) setCard(e.cards[0]);
  }, []);

  const onDelta = useCallback((t: string) => {
    textRef.current += t;
    if (alive.current) setText(textRef.current);
  }, []);

  const onDone = useCallback(
    (readingId: string) => {
      const c = cardRef.current;
      if (!c) {
        fail({ code: "bad_response", message: "The reading arrived without a card." });
        return;
      }
      complete({
        id: readingId,
        spread_type: "daily",
        cards: [c],
        question: null,
        chart_id: null,
        text: textRef.current,
        status: "complete",
        created_at: new Date().toISOString(),
      });
    },
    [complete, fail],
  );

  const start = useCallback(() => {
    if (!alive.current) return;
    stopPolling();
    setError(undefined);
    setState((s) => (s === "idle" || s === "error" ? "streaming" : s));
  }, [stopPolling]);

  const retry = start;

  const raw = useSyncExternalStore(subscribeStorage, rawCache, () => null);
  const cached = useMemo(() => parseCache(raw), [raw]);

  if (phase === "idle" && cached) {
    return {
      state: "cached" as DailyState,
      reading: cached,
      card: cached.cards[0],
      text: cached.text,
      error: undefined,
      start,
      retry,
      source,
      onCards,
      onDelta,
      onDone,
    };
  }
  const state: DailyState = phase;
  return { state, reading, card, text, error, start, retry, source, onCards, onDelta, onDone };
}
