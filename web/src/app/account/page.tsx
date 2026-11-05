"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useApi, useAuth } from "@/components/providers";
import { SignInSheet } from "@/components/sign-in-sheet";
import { useToast } from "@/components/toast";
import { useMe } from "@/hooks/use-me";
import { useDeleteProfile, useProfiles } from "@/hooks/use-profiles";

const shell = "mx-auto max-w-3xl px-6 pt-10 pb-28 md:pb-16";
const button =
  "rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent";
const smallButton =
  "rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50";
const quietButton = "rounded-full px-4 py-1.5 text-sm text-muted hover:text-ink";
const panel = "mt-10 rounded-lg border border-gold/30 bg-bg-deep/60 p-6";

const ANON_COPY = "Anonymous — sign in to keep your readings across devices";

function Spinner({ label }: { label: string }) {
  return (
    <div role="status" className="flex items-center gap-3 text-muted">
      <span
        aria-hidden="true"
        className="inline-block h-5 w-5 animate-spin rounded-full border-2 border-gold/30 border-t-gold motion-reduce:animate-none"
      />
      {label}
    </div>
  );
}

/** Small in-page confirmation; focus lands on the first button so keyboard users are not stranded. */
function InlineConfirm({
  id,
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
}: {
  id: string;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.focus();
  }, []);
  return (
    <div
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={children ? `${id}-desc` : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onCancel();
        }
      }}
      className="mt-3 rounded-lg border border-gold/60 bg-bg p-4"
    >
      <p id={`${id}-title`} className="text-ink">
        {title}
      </p>
      {children ? (
        <p id={`${id}-desc`} className="mt-1 text-sm leading-relaxed text-muted">
          {children}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <button ref={first} type="button" onClick={onConfirm} disabled={busy} className={smallButton}>
          {confirmLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className={quietButton}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function AccountPage() {
  const { signOut } = useAuth();
  const api = useApi();
  const router = useRouter();
  const toast = useToast();
  const me = useMe();
  const profiles = useProfiles();
  const deleteProfile = useDeleteProfile();

  const [askSignIn, setAskSignIn] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleteText, setDeleteText] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const isAnon = me.data?.anon ?? true;

  async function doSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      toast("Signed out");
    } catch {
      toast("We couldn't start a new session. Check your connection and try again.");
    } finally {
      setSigningOut(false);
      setConfirmSignOut(false);
    }
  }

  function onSignOut() {
    if (isAnon) setConfirmSignOut(true);
    else void doSignOut();
  }

  function onDeleteProfile(id: string) {
    deleteProfile.mutate(id, {
      onSuccess: () => toast("Chart deleted"),
      onError: () => toast("We couldn't delete that chart. Please try again."),
      onSettled: () => setConfirmDeleteId(null),
    });
  }

  async function onDeleteAccount() {
    if (deleteText !== "DELETE" || deleting) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteAccount();
    } catch {
      setDeleting(false);
      setDeleteError("We couldn't delete your account. Please try again.");
      return;
    }
    // The old token is dead; drop everything cached under it and start anonymous.
    try {
      await signOut();
    } catch {
      /* offline: the next request mints a session */
    }
    toast("Account deleted");
    router.replace("/");
  }

  return (
    <section className={shell}>
      <h1 className="text-4xl text-gold-hi">Account</h1>

      <div className={panel}>
        {me.isPending ? <Spinner label="Loading your account…" /> : null}
        {me.isError ? (
          <div role="alert" className="space-y-3">
            <p className="text-gold-hi">We couldn&apos;t load your account right now.</p>
            <button type="button" onClick={() => me.refetch()} className={smallButton}>
              Retry
            </button>
          </div>
        ) : null}
        {me.isSuccess ? (
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              {me.data.email ? (
                <>
                  <p className="text-sm text-muted">Signed in as</p>
                  <p className="font-display text-2xl text-gold-hi">{me.data.email}</p>
                </>
              ) : (
                <p className="leading-relaxed text-ink">{ANON_COPY}</p>
              )}
              <p className="mt-2 text-sm text-muted">
                Balance: <span className="text-ink">{me.data.balance}</span> credits
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {me.data.anon ? (
                <button type="button" onClick={() => setAskSignIn(true)} className={button}>
                  Sign in
                </button>
              ) : null}
              <button
                type="button"
                onClick={onSignOut}
                disabled={signingOut}
                className={me.data.anon ? `${quietButton} py-2.5` : button}
              >
                {signingOut ? "Signing out…" : "Sign out"}
              </button>
            </div>
          </div>
        ) : null}

        {confirmSignOut ? (
          <InlineConfirm
            id="sign-out"
            title="Sign out of this anonymous session?"
            confirmLabel="Sign out anyway"
            busy={signingOut}
            onConfirm={() => void doSignOut()}
            onCancel={() => setConfirmSignOut(false)}
          >
            You will lose the readings and charts made here — there is no account to come back to.
            Sign in first to keep them.
          </InlineConfirm>
        ) : null}
      </div>

      <div className={panel}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-2xl text-gold-hi">Charts</h2>
            <p className="mt-1 text-sm text-muted">Birth profiles your readings can be cast through.</p>
          </div>
          <Link href="/chart/new/" className={smallButton}>
            New chart
          </Link>
        </div>
        <div className="mt-4">
          {profiles.isPending ? <Spinner label="Loading your charts…" /> : null}
          {profiles.isError ? (
            <div role="alert" className="space-y-3">
              <p className="text-gold-hi">We couldn&apos;t load your charts right now.</p>
              <button type="button" onClick={() => profiles.refetch()} className={smallButton}>
                Retry
              </button>
            </div>
          ) : null}
          {profiles.isSuccess && profiles.data.length === 0 ? (
            <p className="text-muted">No charts yet.</p>
          ) : null}
          {profiles.isSuccess && profiles.data.length > 0 ? (
            <ul className="divide-y divide-gold/20">
              {profiles.data.map((p) => (
                <li key={p.id} className="py-3">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <Link
                      href={`/chart/?id=${encodeURIComponent(p.id)}`}
                      className="flex flex-col gap-0.5 hover:text-gold-hi"
                    >
                      <span className="font-display text-xl text-gold-hi">{p.name}</span>
                      <span className="text-sm text-muted">{p.place_label}</span>
                    </Link>
                    <button
                      type="button"
                      aria-label={`Delete ${p.name}`}
                      onClick={() => setConfirmDeleteId(p.id)}
                      disabled={confirmDeleteId === p.id}
                      className={smallButton}
                    >
                      Delete
                    </button>
                  </div>
                  {confirmDeleteId === p.id ? (
                    <InlineConfirm
                      id={`delete-${p.id}`}
                      title={`Delete ${p.name}?`}
                      confirmLabel="Confirm"
                      busy={deleteProfile.isPending}
                      onConfirm={() => onDeleteProfile(p.id)}
                      onCancel={() => setConfirmDeleteId(null)}
                    >
                      Readings cast through this chart stay in your journal.
                    </InlineConfirm>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      <div className={`${panel} border-gold/60`}>
        <h2 className="text-2xl text-gold-hi">Delete account</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          Removes your account, charts, journal, and any remaining credits. This cannot be undone.
        </p>
        <label htmlFor="delete-confirm" className="mt-4 block text-sm text-muted">
          Type DELETE to confirm
        </label>
        <input
          id="delete-confirm"
          type="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          value={deleteText}
          disabled={deleting}
          onChange={(e) => setDeleteText(e.target.value)}
          className="mt-1 w-full max-w-xs rounded-lg border border-gold/30 bg-bg-deep/60 px-4 py-3 text-ink disabled:opacity-50"
        />
        {deleteError ? (
          <p role="alert" className="mt-3 text-sm text-gold-hi">
            {deleteError}
          </p>
        ) : null}
        <button
          type="button"
          onClick={() => void onDeleteAccount()}
          disabled={deleteText !== "DELETE" || deleting || !me.isSuccess}
          className={`${button} mt-4`}
        >
          {deleting ? "Deleting…" : "Delete account"}
        </button>
      </div>

      <SignInSheet open={askSignIn} onClose={() => setAskSignIn(false)} title="Sign in" />
    </section>
  );
}
