"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useApi, useAuth } from "@/components/providers";
import type { CardsEvent, StreamError } from "@/components/reading-stream";
import { parseDailyCache, readDailyCache, writeDailyCache } from "@/lib/daily-cache";
import { ApiError, isCode } from "@/lib/errors";
import { localDate, localTimeZone } from "@/lib/tz";
import type { DrawnCard, Reading } from "@/lib/types";

export const POLL_INTERVAL_MS = 2000;
export const POLL_MAX_ATTEMPTS = 30;
const GENERATION_FAILED: StreamError = {
  code: "generation_failed",
  message: "We couldn't prepare your card. Please try again.",
};
const STILL_PREPARING: StreamError = { code: "still_preparing", message: "Still preparing your card…" };

export type DailyState = "idle" | "cached" | "streaming" | "complete" | "waiting" | "error";

// The cache is an external store: read it with useSyncExternalStore so the prerendered HTML
// (server snapshot: nothing cached) hydrates cleanly and other tabs' writes are picked up.
const subscribeStorage = (cb: () => void) => {
  window.addEventListener("storage", cb);
  return () => window.removeEventListener("storage", cb);
};

const abortError = () => new DOMException("Handled by useDaily", "AbortError");

export function useDaily() {
  const api = useApi();
  const { userId } = useAuth();
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
  // local date captured when the reveal starts: the day the server assigns the reading to
  const dayRef = useRef<string>("");
  const restartedRef = useRef(false);
  // who the reading is for, read at write time so callbacks need not re-bind on sign-in
  const userIdRef = useRef(userId);
  useEffect(() => {
    userIdRef.current = userId;
  }, [userId]);

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

  // `day` is the local date the reading belongs to, never the (possibly later) write time.
  const complete = useCallback((r: Reading, day: string) => {
    if (!alive.current) return;
    writeDailyCache({ userId: userIdRef.current, localDate: day, reading: r });
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

  /** Re-issue the daily request (internal: does not reset the one-shot restart guard). */
  const begin = useCallback(() => {
    if (!alive.current) return;
    stopPolling();
    dayRef.current = localDate();
    setError(undefined);
    setState("streaming");
  }, [stopPolling]);

  const poll = useCallback(() => {
    stopPolling();
    setState("waiting");
    let attempts = 0;
    const today = dayRef.current || localDate();
    const tz = localTimeZone();
    const tick = async () => {
      pollTimer.current = null;
      const ctl = new AbortController();
      pollCtl.current = ctl;
      attempts++;
      try {
        const [latest] = await api.readings(1);
        if (!alive.current || ctl.signal.aborted) return;
        const todays =
          latest &&
          latest.spread_type === "daily" &&
          localDate(tz, new Date(latest.created_at)) === today;
        if (todays && latest.status === "failed") {
          // generation died server-side: re-request once instead of polling out the minute
          pollCtl.current = null;
          if (restartedRef.current) fail(GENERATION_FAILED);
          else {
            restartedRef.current = true;
            begin();
          }
          return;
        }
        if (todays && latest.status === "complete") {
          const r = await api.reading(latest.id);
          if (!alive.current || ctl.signal.aborted) return;
          pollCtl.current = null;
          complete(r, today);
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
  }, [api, begin, complete, fail, stopPolling]);

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
        complete(res.reading, localDate(localTimeZone(), new Date(res.reading.created_at)));
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
      const r: Reading = {
        id: readingId,
        spread_type: "daily",
        cards: [c],
        question: null,
        chart_id: null,
        text: textRef.current,
        status: "complete",
        created_at: new Date().toISOString(),
      };
      complete(r, dayRef.current || localDate());
    },
    [complete, fail],
  );

  const start = useCallback(() => {
    if (!alive.current) return;
    if (phase !== "idle" && phase !== "error") return;
    restartedRef.current = false;
    begin();
  }, [begin, phase]);

  const retry = start;

  const raw = useSyncExternalStore(subscribeStorage, readDailyCache, () => null);
  const cached = useMemo(() => parseDailyCache(raw, userId, localDate()), [raw, userId]);

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
