"use client";

import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useApi, useAuth } from "@/components/providers";
import { useToast } from "@/components/toast";
import { ApiError } from "@/lib/errors";
import { GisNotConfiguredError, googleClientId, loadGis } from "@/lib/gis";

export interface SignInSheetProps {
  open: boolean;
  onClose: () => void;
  /** Why we are asking; defaults to the store's reason. */
  title?: string;
}

export const GOOGLE_UNCONFIGURED_COPY = "Google sign-in isn't configured";
export const GOOGLE_FAILED_COPY = "Google sign-in couldn't load. Use the email link instead.";
export const GOOGLE_REJECTED_COPY = "Google sign-in didn't go through. Please try again.";
export const MAGIC_RATE_LIMITED_COPY = "Please wait a few minutes before requesting another link.";
export const MAGIC_FAILED_COPY = "We couldn't send the link right now. Please try again.";

type GoogleState = "loading" | "ready" | "signing_in" | "unconfigured" | "failed";
type MailState =
  | { kind: "idle" }
  | { kind: "sending" }
  | { kind: "sent"; email: string }
  | { kind: "rate_limited" }
  | { kind: "failed" };

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"])';

/**
 * Modal sheet asking the user to sign in: the official Google button (Identity
 * Services, loaded on first open) and a magic-link email form. Both paths end in
 * `useAuth()` adopting the new token, which refreshes every cached query.
 */
export function SignInSheet({ open, onClose, title = "Sign in to buy credits" }: SignInSheetProps) {
  // Mount the body only while open so every opening starts from a clean state.
  return open ? <SheetBody onClose={onClose} title={title} /> : null;
}

function SheetBody({ onClose, title }: { onClose: () => void; title: string }) {
  const { signInWithGoogle } = useAuth();
  const api = useApi();
  const toast = useToast();

  const dialog = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const googleSlot = useRef<HTMLDivElement>(null);

  const [google, setGoogle] = useState<GoogleState>(() => (googleClientId() ? "loading" : "unconfigured"));
  const [googleError, setGoogleError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [mail, setMail] = useState<MailState>({ kind: "idle" });

  async function onCredential(credential: string) {
    setGoogle("signing_in");
    setGoogleError(null);
    try {
      await signInWithGoogle(credential);
      toast("Signed in");
      onClose();
    } catch {
      setGoogle("ready");
      setGoogleError(GOOGLE_REJECTED_COPY);
    }
  }

  // GIS invokes its callback outside React; route it through a ref so it always sees the latest closure.
  const latest = useRef(onCredential);
  useEffect(() => {
    latest.current = onCredential;
  });

  // Focus management: heading on mount, opener on unmount.
  useEffect(() => {
    const opener = document.activeElement;
    heading.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  // Render the official Google button into its slot once the script is available.
  useEffect(() => {
    if (!googleClientId()) return;
    let cancelled = false;
    loadGis()
      .then((gis) => {
        const slot = googleSlot.current;
        if (cancelled || !slot) return;
        gis.initialize({
          client_id: googleClientId() ?? "",
          callback: (r) => {
            void latest.current(r.credential);
          },
        });
        slot.replaceChildren();
        gis.renderButton(slot, { theme: "filled_black", size: "large", width: 320 });
        setGoogle("ready");
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setGoogle(e instanceof GisNotConfiguredError ? "unconfigured" : "failed");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function onSubmitEmail(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const addr = email.trim();
    if (!addr || mail.kind === "sending") return;
    setMail({ kind: "sending" });
    try {
      await api.magicRequest(addr);
      setMail({ kind: "sent", email: addr });
    } catch (err) {
      if (err instanceof ApiError && (err.status === 429 || err.code === "rate_limited")) {
        setMail({ kind: "rate_limited" });
      } else if (err instanceof ApiError && err.status >= 400 && err.status < 500) {
        // Never reveal whether an account exists: any other client error reads as sent.
        setMail({ kind: "sent", email: addr });
      } else {
        setMail({ kind: "failed" });
      }
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key !== "Tab" || !dialog.current) return;
    const nodes = Array.from(dialog.current.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (nodes.length === 0) {
      e.preventDefault();
      return;
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    const inside = active instanceof HTMLElement && nodes.includes(active);
    if (e.shiftKey) {
      if (!inside || active === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (!inside || active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onBackdropClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const sending = mail.kind === "sending";

  return (
    <div
      onClick={onBackdropClick}
      className="fixed inset-0 z-40 flex items-end justify-center bg-bg-deep/80 md:items-center"
    >
      <div
        ref={dialog}
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
          <div className="flex min-h-11 flex-col items-center gap-2">
            <div
              ref={googleSlot}
              hidden={google === "unconfigured" || google === "failed"}
              aria-busy={google === "loading" || google === "signing_in" || undefined}
              className="flex justify-center"
            />
            {google === "loading" ? <p className="text-sm text-muted">Loading Google sign-in…</p> : null}
            {google === "signing_in" ? (
              <p role="status" className="text-sm text-muted">
                Signing you in…
              </p>
            ) : null}
            {google === "unconfigured" ? <p className="text-sm text-muted">{GOOGLE_UNCONFIGURED_COPY}</p> : null}
            {google === "failed" ? <p className="text-sm text-muted">{GOOGLE_FAILED_COPY}</p> : null}
            {googleError ? (
              <p role="alert" className="text-sm text-gold-hi">
                {googleError}
              </p>
            ) : null}
          </div>

          <div className="flex items-center gap-3 text-xs uppercase tracking-widest text-muted">
            <span className="h-px flex-1 bg-gold/20" aria-hidden="true" />
            or
            <span className="h-px flex-1 bg-gold/20" aria-hidden="true" />
          </div>

          {mail.kind === "sent" ? (
            <div role="status" className="rounded-lg border border-gold/30 bg-bg-deep/60 p-4">
              <p className="font-display text-xl text-gold-hi">Check your email</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">
                If <span className="text-ink">{mail.email}</span> can receive mail, a sign-in link is on its
                way. Open it on this device so your readings come with you.
              </p>
              <button
                type="button"
                onClick={() => setMail({ kind: "idle" })}
                className="mt-3 text-sm text-gold-hi underline-offset-2 hover:underline"
              >
                Use a different email
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmitEmail} className="space-y-3">
              <div>
                <label htmlFor="sign-in-email" className="block text-sm text-muted">
                  Email a sign-in link
                </label>
                <input
                  id="sign-in-email"
                  type="email"
                  required
                  autoComplete="email"
                  inputMode="email"
                  value={email}
                  disabled={sending}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-gold/30 bg-bg-deep/60 px-4 py-3 text-ink placeholder:text-muted/70 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
              {mail.kind === "rate_limited" ? (
                <p role="alert" className="text-sm text-gold-hi">
                  {MAGIC_RATE_LIMITED_COPY}
                </p>
              ) : null}
              {mail.kind === "failed" ? (
                <p role="alert" className="text-sm text-gold-hi">
                  {MAGIC_FAILED_COPY}
                </p>
              ) : null}
              <button
                type="submit"
                disabled={sending}
                className="w-full rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
              >
                {sending ? "Sending…" : "Email me a link"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
