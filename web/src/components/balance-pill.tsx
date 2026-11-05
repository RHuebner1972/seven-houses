"use client";

import { useAuth } from "@/components/providers";
import { useMe } from "@/hooks/use-me";

export function BalancePill() {
  const { ready } = useAuth();
  const { data } = useMe();
  const text = ready && data ? String(data.balance) : "—";
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-gold/40 px-3 py-1 text-sm text-gold-hi">
      <span className="sr-only">Credit balance:</span>
      <span aria-hidden="true">◉</span>
      <span>{text}</span>
    </span>
  );
}
