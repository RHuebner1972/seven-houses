"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ChartWheel } from "@/components/chart-wheel";
import { Placements } from "@/components/placements";
import { useProfile, useProfiles } from "@/hooks/use-profiles";
import { isCode } from "@/lib/errors";
import type { Profile } from "@/lib/types";

const button =
  "inline-block rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10";
const shell = "mx-auto max-w-3xl px-6 pt-10 pb-28 md:pb-16";

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

/** "May 15, 1990" from YYYY-MM-DD, without timezone drift. */
function formatBirthDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

function formatBirthTime(p: Profile): string {
  if (!p.birth_time) return "time unknown";
  const [h, m] = p.birth_time.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return p.birth_time;
  const d = new Date(Date.UTC(2000, 0, 1, h, m));
  return new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: "UTC" }).format(d);
}

export default function ChartPage() {
  // useSearchParams needs a Suspense boundary so the static export can prerender the shell.
  return (
    <Suspense
      fallback={
        <section className={shell}>
          <Spinner label="Loading…" />
        </section>
      }
    >
      <ChartRoute />
    </Suspense>
  );
}

function ChartRoute() {
  const id = useSearchParams().get("id");
  return id ? <ChartDetail id={id} /> : <ProfileList />;
}

function ProfileList() {
  const profiles = useProfiles();

  return (
    <section className={shell}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-4xl text-gold-hi">Your charts</h1>
          <p className="mt-2 text-muted">Birth charts your readings can be cast through.</p>
        </div>
        <Link href="/chart/new/" className={button}>
          New chart
        </Link>
      </div>

      <div className="mt-8">
        {profiles.isPending ? <Spinner label="Loading your charts…" /> : null}

        {profiles.isError ? (
          <div role="alert" className="space-y-3">
            <p className="text-gold-hi">We couldn&apos;t load your charts right now.</p>
            <button
              type="button"
              onClick={() => profiles.refetch()}
              className="rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10"
            >
              Retry
            </button>
          </div>
        ) : null}

        {profiles.isSuccess && profiles.data.length === 0 ? (
          <div className="rounded-lg border border-gold/30 bg-bg-deep/60 p-6">
            <h2 className="text-2xl text-gold-hi">No charts yet</h2>
            <p className="mt-2 leading-relaxed text-muted">
              A birth chart lets your readings speak to your own sky. Add a birth date, time, and place
              and every card is interpreted through your Sun, Moon, and rising sign — a reading that is
              yours, not anyone&apos;s.
            </p>
            <Link href="/chart/new/" className={`${button} mt-5`}>
              Cast your first chart
            </Link>
          </div>
        ) : null}

        {profiles.isSuccess && profiles.data.length > 0 ? (
          <ul className="divide-y divide-gold/20 rounded-lg border border-gold/30 bg-bg-deep/60">
            {profiles.data.map((p) => (
              <li key={p.id}>
                <Link
                  href={`/chart/?id=${encodeURIComponent(p.id)}`}
                  className="flex flex-col gap-0.5 px-5 py-4 hover:bg-gold/5 focus:bg-gold/5 focus:outline-none"
                >
                  <span className="font-display text-xl text-gold-hi">{p.name}</span>
                  <span className="text-sm text-muted">
                    {p.place_label} · {formatBirthDate(p.birth_date)}
                    {p.birth_time ? ` at ${formatBirthTime(p)}` : ", time unknown"}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}

function ChartDetail({ id }: { id: string }) {
  const q = useProfile(id);

  if (q.isPending) {
    return (
      <section className={shell}>
        <Spinner label="Loading your chart…" />
      </section>
    );
  }

  if (q.isError) {
    const missing = isCode(q.error, "not_found");
    return (
      <section className={shell}>
        <div role="alert" className="space-y-3">
          <p className="text-gold-hi">
            {missing
              ? "We couldn't find that chart. It may have been deleted."
              : "We couldn't load this chart right now."}
          </p>
          {!missing ? (
            <button
              type="button"
              onClick={() => q.refetch()}
              className="rounded-full border border-gold/60 px-4 py-1.5 text-sm text-gold-hi hover:bg-gold/10"
            >
              Retry
            </button>
          ) : null}
        </div>
        <Link href="/chart/" className="mt-6 inline-block text-sm text-muted hover:text-ink">
          ← All charts
        </Link>
      </section>
    );
  }

  const { profile, chart } = q.data;

  return (
    <section className={shell}>
      <Link href="/chart/" className="text-sm text-muted hover:text-ink">
        ← All charts
      </Link>
      <h1 className="mt-3 text-4xl text-gold-hi">{profile.name}</h1>
      <p className="mt-1 text-muted">
        {profile.place_label} · {formatBirthDate(profile.birth_date)}, {formatBirthTime(profile)}
      </p>

      {chart ? (
        <div className="mt-8 grid gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] md:items-start">
          <div className="mx-auto w-full max-w-[480px]">
            <ChartWheel chart={chart} size={480} className="h-auto w-full" />
          </div>
          <Placements chart={chart} />
        </div>
      ) : (
        <p className="mt-8 text-muted">
          This chart isn&apos;t available yet. You can still use this profile for readings.
        </p>
      )}

      <Link href={`/reading/new/?profile=${encodeURIComponent(profile.id)}`} className={`${button} mt-10`}>
        Use for readings
      </Link>
    </section>
  );
}
