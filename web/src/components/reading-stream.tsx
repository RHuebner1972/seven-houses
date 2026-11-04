"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/errors";
import { parseSse } from "@/lib/sse";
import type { SseEvent } from "@/lib/types";

export type StreamError = { code: string; message: string };
export type CardsEvent = Extract<SseEvent, { event: "cards" }>["data"];

export type ReadingStreamProps = {
  source: (signal: AbortSignal) => Promise<ReadableStream<Uint8Array>>;
  onCards?(e: CardsEvent): void;
  onDelta?(text: string): void;
  onDone?(readingId: string): void;
  onError?(err: StreamError): void;
  onAbort?(deliveredText: string): void;
  initialText?: string;
};

const INTERRUPTED: StreamError = { code: "stream_ended", message: "The reading was interrupted." };

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === "AbortError";

export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * Generic SSE reading consumer. `source` may throw an AbortError to step aside silently
 * (the caller has taken over, e.g. the reading already existed).
 */
export function ReadingStream(props: ReadingStreamProps) {
  const [text, setText] = useState(props.initialText ?? "");
  const [status, setStatus] = useState<"streaming" | "done" | "error">("streaming");
  const [error, setError] = useState<StreamError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const textRef = useRef(props.initialText ?? "");
  const cbs = useRef(props);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    cbs.current = props;
  });

  useEffect(() => {
    let active = true;
    let finished = false;
    const controller = new AbortController();
    controllerRef.current = controller;

    const fail = (err: StreamError) => {
      finished = true;
      setStatus("error");
      setError(err);
      cbs.current.onError?.(err);
    };

    (async () => {
      try {
        const body = await cbs.current.source(controller.signal);
        if (!active) {
          await body.cancel().catch(() => undefined);
          return;
        }
        for await (const ev of parseSse(body)) {
          if (!active) return;
          switch (ev.event) {
            case "cards":
              cbs.current.onCards?.(ev.data);
              break;
            case "delta":
              textRef.current += ev.data.text;
              setText(textRef.current);
              cbs.current.onDelta?.(ev.data.text);
              break;
            case "done":
              finished = true;
              setStatus("done");
              cbs.current.onDone?.(ev.data.reading_id);
              return;
            case "error":
              fail(ev.data);
              return;
          }
        }
        if (active) fail(INTERRUPTED);
      } catch (e) {
        if (!active || isAbort(e)) {
          finished = true;
          return;
        }
        fail(
          e instanceof ApiError
            ? { code: e.code, message: e.message }
            : { code: "network", message: (e as Error | null)?.message || INTERRUPTED.message },
        );
      }
    })();

    return () => {
      active = false;
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      if (!finished) cbs.current.onAbort?.(textRef.current);
    };
  }, [attempt]);

  const retry = () => {
    textRef.current = "";
    setText("");
    setError(null);
    setStatus("streaming");
    setAttempt((a) => a + 1);
  };

  const paras = paragraphs(text);
  const streaming = status === "streaming";

  return (
    <div data-streaming={streaming ? "true" : "false"} aria-busy={streaming} className="space-y-4">
      {paras.map((p, i) => (
        <p key={i} className="leading-relaxed">
          {p}
          {streaming && i === paras.length - 1 ? <Caret /> : null}
        </p>
      ))}
      {streaming && paras.length === 0 ? (
        <p>
          <Caret />
        </p>
      ) : null}
      {error ? (
        <div role="alert" className="space-y-3">
          <p className="text-gold-hi">{error.message}</p>
          <button
            type="button"
            onClick={retry}
            className="rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10"
          >
            Retry
          </button>
        </div>
      ) : null}
    </div>
  );
}

function Caret() {
  return (
    <span
      aria-hidden="true"
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[2px] animate-pulse bg-gold motion-reduce:animate-none"
    />
  );
}
