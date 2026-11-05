"use client";

import { useEffect, useRef, type KeyboardEvent } from "react";

export interface SignInSheetProps {
  open: boolean;
  onClose: () => void;
  /** Why we are asking; defaults to the store's reason. */
  title?: string;
}

/**
 * Modal sheet asking the user to sign in. Shell only: the Google and magic-link
 * controls are rendered inert here and wired up in the account work (Task 11).
 */
export function SignInSheet({ open, onClose, title = "Sign in to buy credits" }: SignInSheetProps) {
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement;
    heading.current?.focus();
    return () => {
      const el = restoreTo.current;
      if (el instanceof HTMLElement && el.isConnected) el.focus();
    };
  }, [open]);

  if (!open) return null;

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-bg-deep/80 md:items-center">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sign-in-title"
        onKeyDown={onKeyDown}
        className="w-full max-w-md rounded-t-2xl border border-gold/40 bg-bg p-6 shadow-2xl md:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-4">
          <h2 id="sign-in-title" ref={heading} tabIndex={-1} className="text-3xl text-gold-hi focus:outline-none">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-full px-2 text-2xl leading-none text-muted hover:text-gold-hi"
          >
            ×
          </button>
        </div>
        <p className="mt-3 leading-relaxed text-muted">
          Credits belong to an account, so your readings and balance follow you across devices. Sign in
          and everything you have done here comes with you.
        </p>

        <div className="mt-6 space-y-4">
          <button
            type="button"
            disabled
            className="w-full rounded-full border border-gold px-6 py-2.5 text-gold-hi disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue with Google
          </button>
          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted">
            <span className="h-px flex-1 bg-gold/20" aria-hidden="true" />
            or
            <span className="h-px flex-1 bg-gold/20" aria-hidden="true" />
          </div>
          <div>
            <label htmlFor="sign-in-email" className="block text-sm text-muted">
              Email a sign-in link
            </label>
            <input
              id="sign-in-email"
              type="email"
              disabled
              placeholder="you@example.com"
              className="mt-1 w-full rounded-lg border border-gold/30 bg-bg-deep/60 px-4 py-3 text-ink placeholder:text-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>
          <p className="text-sm text-muted">Sign-in is coming in a moment.</p>
        </div>
      </div>
    </div>
  );
}
