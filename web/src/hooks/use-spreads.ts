"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi } from "@/components/providers";
import type { Spread } from "@/lib/types";

/** Spreads a user can choose for a full reading: everything but the daily card. */
export function useSpreads() {
  const api = useApi();
  return useQuery({
    queryKey: ["spreads"],
    queryFn: async (): Promise<Spread[]> => (await api.spreads()).filter((s) => s.type !== "daily"),
    staleTime: 5 * 60_000,
  });
}
