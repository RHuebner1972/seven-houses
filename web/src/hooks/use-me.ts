"use client";

import { useQuery } from "@tanstack/react-query";
import { useApi, useAuth } from "@/components/providers";

export function useMe() {
  const api = useApi();
  const { ready } = useAuth();
  return useQuery({
    queryKey: ["me"],
    queryFn: () => api.me(),
    enabled: ready,
    staleTime: 10_000,
  });
}
