"use client";

import { useEffect, useRef, useState } from "react";
import { SESSION_EXPIRED_COPY, useAuth } from "@/components/providers";
import { SignInSheet } from "@/components/sign-in-sheet";
import { useToast } from "@/components/toast";

/**
 * Lives under <ToastProvider>, where <AuthProvider> cannot reach: when a signed-in token
 * is rejected and silently replaced by an anonymous one, say so once and offer the way back.
 */
export function SessionExpiredNotice() {
  const { sessionExpired } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const announced = useRef(false);

  useEffect(() => {
    if (!sessionExpired) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    toast(SESSION_EXPIRED_COPY, { label: "Sign in", onClick: () => setOpen(true) });
  }, [sessionExpired, toast]);

  return <SignInSheet open={open} onClose={() => setOpen(false)} title="Sign in to restore your session" />;
}
