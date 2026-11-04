"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useApi, useAuth } from "@/components/providers";
import type { ProfileInput } from "@/lib/types";

export function useProfiles() {
  const api = useApi();
  const { ready } = useAuth();
  return useQuery({ queryKey: ["profiles"], queryFn: () => api.profiles(), enabled: ready });
}

export function useProfile(id: string | null | undefined) {
  const api = useApi();
  const { ready } = useAuth();
  return useQuery({
    queryKey: ["profile", id],
    queryFn: () => api.profile(id as string),
    enabled: ready && !!id,
  });
}

export function useCreateProfile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProfileInput) => api.createProfile(body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}

export function useDeleteProfile() {
  const api = useApi();
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteProfile(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["profiles"] }),
  });
}
