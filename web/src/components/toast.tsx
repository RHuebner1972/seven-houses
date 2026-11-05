"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

export const TOAST_MS = 4000;
/** Toasts carrying an action stay long enough to be acted on. */
export const TOAST_ACTION_MS = 10_000;

export type ToastAction = { label: string; onClick: () => void };
type Toast = { id: number; message: string; action?: ToastAction };
export type ShowToast = (message: string, action?: ToastAction) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** Shows a short, auto-dismissing status message above whatever page is mounted. */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast must be used within <ToastProvider>");
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(0);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const show = useCallback<ShowToast>(
    (message, action) => {
      const id = next.current++;
      setToasts((t) => [...t, { id, message, action }]);
      timers.current.set(
        id,
        setTimeout(() => dismiss(id), action ? TOAST_ACTION_MS : TOAST_MS),
      );
    },
    [dismiss],
  );

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
            className={`rounded-full border border-gold/40 bg-bg-deep/95 px-5 py-2 text-sm text-gold-hi shadow-lg ${
              t.action ? "pointer-events-auto" : ""
            }`}
          >
            {t.message}
            {t.action ? (
              <button
                type="button"
                onClick={() => {
                  dismiss(t.id);
                  t.action?.onClick();
                }}
                className="ml-3 rounded-full border border-gold/60 px-3 py-0.5 text-sm text-gold-hi hover:bg-gold/10"
              >
                {t.action.label}
              </button>
            ) : null}
          </p>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
