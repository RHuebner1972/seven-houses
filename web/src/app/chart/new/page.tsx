"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { GeocodeSearch } from "@/components/geocode-search";
import { useCreateProfile } from "@/hooks/use-profiles";
import { ApiError } from "@/lib/errors";
import type { Place } from "@/lib/types";

const field =
  "mt-1 w-full rounded-md border border-gold/40 bg-bg px-3 py-2 text-ink focus:border-gold focus:outline-none disabled:opacity-50";

function todayLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function NewChartPage() {
  const router = useRouter();
  const create = useCreateProfile();
  const [name, setName] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [unknown, setUnknown] = useState(false);
  const [place, setPlace] = useState<Place | null>(null);
  const [error, setError] = useState<string | null>(null);

  const ready = name.trim() !== "" && date !== "" && place !== null && (unknown || time !== "");

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !place || create.isPending) return;
    setError(null);
    try {
      const res = await create.mutateAsync({
        name: name.trim(),
        birth_date: date,
        birth_time: unknown ? null : time,
        tz: place.tz,
        lat: place.lat,
        lon: place.lon,
        place_label: place.label,
      });
      router.push(`/chart/?id=${res.profile.id}`);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 422
          ? err.message
          : "Something went wrong casting your chart. Please try again.",
      );
    }
  }

  return (
    <section className="mx-auto max-w-xl px-6 pt-10 pb-28 md:pb-16">
      <h1 className="text-4xl text-gold-hi">Your birth chart</h1>
      <p className="mt-2 text-muted">
        Enter your birth details and we&apos;ll cast your natal chart — planets, houses, and
        aspects — to read your cards through.
      </p>

      <form onSubmit={onSubmit} className="mt-8 space-y-5">
        <div>
          <label htmlFor="name" className="block text-sm text-muted">
            Name
          </label>
          <input
            id="name"
            type="text"
            required
            maxLength={80}
            autoComplete="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={field}
          />
        </div>

        <div>
          <label htmlFor="birth-date" className="block text-sm text-muted">
            Birth date
          </label>
          <input
            id="birth-date"
            type="date"
            required
            min="1850-01-01"
            max={todayLocal()}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className={field}
          />
        </div>

        <div>
          <label htmlFor="birth-time" className="block text-sm text-muted">
            Birth time
          </label>
          <input
            id="birth-time"
            type="time"
            disabled={unknown}
            value={time}
            onChange={(e) => setTime(e.target.value)}
            className={field}
          />
          <label className="mt-2 flex items-center gap-2 text-sm text-muted">
            <input
              type="checkbox"
              checked={unknown}
              onChange={(e) => {
                setUnknown(e.target.checked);
                if (e.target.checked) setTime("");
              }}
            />
            I don&apos;t know my birth time
          </label>
        </div>

        <GeocodeSearch onSelect={setPlace} onClear={() => setPlace(null)} />
        {place ? <p className="text-sm text-muted">Time zone: {place.tz}</p> : null}

        <button
          type="submit"
          disabled={!ready || create.isPending}
          className="rounded-full border border-gold px-6 py-2.5 text-gold-hi hover:bg-gold/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {create.isPending ? "Casting your chart…" : "Cast my chart"}
        </button>

        {error ? (
          <p role="alert" className="text-gold-hi">
            {error}
          </p>
        ) : null}
      </form>
    </section>
  );
}
