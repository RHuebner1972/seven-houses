"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/components/providers";
import type { Spread } from "@/lib/types";

export type UseSpreadsOptions = {
  /** Include the free daily spread (hidden from the spread picker, needed to lay out a daily reading). */
  includeDaily?: boolean;
};

/** Spreads from `GET /spreads`; by default everything but the daily card. */
export function useSpreads({ includeDaily = false }: UseSpreadsOptions = {}) {
  const api = useApi();
  return useQuery({
    queryKey: ["spreads"],
    queryFn: (): Promise<Spread[]> => api.spreads(),
    select: (all) => (includeDaily ? all : all.filter((s) => s.type !== "daily")),
    staleTime: 5 * 60_000,
  });
}
