"use client";

import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApi, useAuth } from "@/components/providers";
import type { Reading, ReadingSummary } from "@/lib/types";

/** How often a `pending` reading is re-read, and for how long before we stop. */
export const POLL_INTERVAL_MS = 3000;
export const POLL_MAX_MS = 2 * 60_000;

export const READINGS_KEY = ["readings"] as const;
export const readingKey = (id: string | null | undefined) => ["reading", id] as const;

/** `GET /readings?limit=` — journal entries, as the API orders them (callers sort). */
export function useReadings(limit = 50) {
  const api = useApi();
  const { ready } = useAuth();
  return useQuery({
    queryKey: [...READINGS_KEY, limit],
    queryFn: (): Promise<ReadingSummary[]> => api.readings(limit),
    enabled: ready,
  });
}

/**
 * `GET /readings/{id}`. While the reading is `pending` it is polled every POLL_INTERVAL_MS
 * for up to POLL_MAX_MS; `stalled` is true once that budget is spent without completion.
 */
export function useReading(id: string | null | undefined) {
  const api = useApi();
  const { ready } = useAuth();
  const [stalled, setStalled] = useState(false);
  // when we first saw this reading pending; null while it is not
  const pendingSince = useRef<number | null>(null);

  const q = useQuery({
    queryKey: readingKey(id),
    queryFn: (): Promise<Reading> => api.reading(id as string),
    enabled: ready && !!id,
    // Evaluated by the query observer on subscribe, option changes, and after each fetch —
    // never during render — so it may keep the pending clock and flip `stalled`.
    refetchInterval: (query) => {
      if (query.state.data?.status !== "pending") {
        pendingSince.current = null;
        setStalled(false);
        return false;
      }
      pendingSince.current ??= Date.now();
      if (Date.now() - pendingSince.current < POLL_MAX_MS) return POLL_INTERVAL_MS;
      setStalled(true);
      return false;
    },
  });

  return { ...q, stalled };
}
