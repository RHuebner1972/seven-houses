"use client";

import { useEffect, useRef } from "react";
import { useToast } from "@/components/toast";

export const SW_UPDATED_MESSAGE = "Seventh House updated — reload for the latest";

declare global {
  interface Window {
    /** Present when the page runs inside the Capacitor shell (Android wrapper). */
    Capacitor?: { isNativePlatform?: () => boolean };
  }
}

/** Service workers belong to the hosted web app: not the native shell, not file:/capacitor: origins. */
export function shouldRegisterSw(win: Pick<Window, "Capacitor" | "location">): boolean {
  if (win.Capacitor?.isNativePlatform?.()) return false;
  return /^https?:$/.test(win.location.protocol);
}

/**
 * Registers `/sw.js` in production builds only and announces when a newer worker has
 * taken over (an update, not the first install). Renders nothing.
 */
export function RegisterSw() {
  const toast = useToast();
  const notified = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof window === "undefined" || !shouldRegisterSw(window)) return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    const container = navigator.serviceWorker;
    // A controller at mount means a worker already serves this page; a new one is an update.
    const isUpdate = Boolean(container.controller);

    const announce = () => {
      if (notified.current) return;
      notified.current = true;
      toast(SW_UPDATED_MESSAGE);
    };
    const onControllerChange = () => {
      if (isUpdate) announce();
    };
    container.addEventListener("controllerchange", onControllerChange);

    let cancelled = false;
    container
      .register("/sw.js")
      .then((reg) => {
        if (cancelled) return;
        reg.addEventListener("updatefound", () => {
          const worker = reg.installing;
          if (!worker || !container.controller) return;
          worker.addEventListener("statechange", () => {
            if (worker.state === "installed") announce();
          });
        });
      })
      .catch(() => {
        /* registration is best-effort; the app works without it */
      });

    return () => {
      cancelled = true;
      container.removeEventListener("controllerchange", onControllerChange);
    };
  }, [toast]);

  return null;
}
