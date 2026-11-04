"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useApi } from "@/components/providers";
import { isCode } from "@/lib/errors";
import type { Place } from "@/lib/types";

const DEBOUNCE_MS = 300;

export function GeocodeSearch({
  onSelect,
  onClear,
  value = "",
  label = "Birth place",
}: {
  onSelect: (place: Place) => void;
  /** Called when the user edits the text after a place was chosen. */
  onClear?: () => void;
  value?: string;
  label?: string;
}) {
  const api = useApi();
  const uid = useId();
  const listId = `${uid}-list`;
  const [text, setText] = useState(value);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [message, setMessage] = useState<string | null>(null);
  const reqId = useRef(0);

  useEffect(() => {
    const q = query.trim();
    const id = ++reqId.current; // invalidates any older in-flight request
    if (q.length < 2) return;
    const timer = setTimeout(async () => {
      try {
        const found = await api.geocode(q);
        if (id !== reqId.current) return;
        setResults(found);
        setActive(-1);
        setOpen(true);
        setMessage(found.length === 0 ? "No places found" : null);
      } catch (e) {
        if (id !== reqId.current) return;
        setResults([]);
        setOpen(false);
        setMessage(
          isCode(e, "geocode_unavailable")
            ? "Place lookup is temporarily unavailable"
            : "Could not look up that place",
        );
      }
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, api]);

  function choose(place: Place) {
    reqId.current++; // drop anything still in flight
    setText(place.label);
    setQuery("");
    setResults([]);
    setOpen(false);
    setActive(-1);
    setMessage(null);
    onSelect(place);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" && results.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length) {
      e.preventDefault();
      setOpen(true);
      setActive((a) => (a <= 0 ? results.length - 1 : a - 1));
    } else if (e.key === "Enter" && open && active >= 0) {
      e.preventDefault();
      choose(results[active]);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
      setActive(-1);
    }
  }

  const showList = open && results.length > 0;

  return (
    <div className="relative">
      <label htmlFor={`${uid}-input`} className="block text-sm text-muted">
        {label}
      </label>
      <input
        id={`${uid}-input`}
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList && active >= 0 ? `${uid}-opt-${active}` : undefined}
        autoComplete="off"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setQuery(e.target.value);
          setMessage(null);
          if (e.target.value.trim().length < 2) {
            setResults([]);
            setOpen(false);
            setActive(-1);
          }
          onClear?.();
        }}
        onKeyDown={onKeyDown}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
        className="mt-1 w-full rounded-md border border-gold/40 bg-bg px-3 py-2 text-ink focus:border-gold focus:outline-none"
      />
      <ul
        id={listId}
        role="listbox"
        aria-label={label}
        hidden={!showList}
        className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-md border border-gold/40 bg-bg-deep"
      >
        {results.map((p, i) => (
          <li
            key={`${p.label}-${i}`}
            id={`${uid}-opt-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => choose(p)}
            className={`cursor-pointer px-3 py-2 ${i === active ? "bg-gold/20 text-gold-hi" : "text-ink"}`}
          >
            {p.label}
          </li>
        ))}
      </ul>
      {message ? (
        <p className="mt-1 text-sm text-muted" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
