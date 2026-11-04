"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const TOAST_MS = 4000;

type Toast = { id: number; message: string };

const ToastContext = createContext<((message: string) => void) | null>(null);

/** Shows a short, auto-dismissing status message above whatever page is mounted. */
export function useToast(): (message: string) => void {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used within <ToastProvider>");
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const show = useCallback((message: string) => {
    const id = next.current++;
    setToasts((t) => [...t, { id, message }]);
    timers.current.set(
      id,
      setTimeout(() => {
        timers.current.delete(id);
        setToasts((t) => t.filter((x) => x.id !== id));
      }, TOAST_MS),
    );
  }, []);

  useEffect(() => {
    const t = timers.current;
    return () => t.forEach(clearTimeout);
  }, []);

  const value = useMemo(() => show, [show]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-20 z-50 flex flex-col items-center gap-2 px-4 md:bottom-6"
      >
        {toasts.map((t) => (
          <p
            key={t.id}
            className="rounded-full border border-gold/40 bg-bg-deep/95 px-5 py-2 text-sm text-gold-hi shadow-lg"
          >
            {t.message}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
