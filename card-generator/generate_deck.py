#!/usr/bin/env python3
"""Generate a 78-card tarot deck (+ back) with OpenAI image generation."""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from openai import (
    APIConnectionError,
    APIStatusError,
    OpenAI,
    RateLimitError,
)

HERE = Path(__file__).resolve().parent
DEFAULT_MODEL = "gpt-image-2.5-sunburst"
SIZE = "1024x1536"
MAX_RETRIES = 5
RETRYABLE = (RateLimitError, APIConnectionError, APIStatusError)
COURT_RANKS = {11: "Page", 12: "Knight", 13: "Queen", 14: "King"}
FRAMING = (
    "Full-bleed portrait illustration, 2:3 aspect, no border, no card frame. "
    "The card name must appear on the image in gold lettering at the bottom."
)
BACK_FRAMING = (
    "A reversible, non-directional design with no upright orientation, "
    "no figure, no text. Full-bleed portrait illustration, 2:3 aspect, "
    "no title, no name, no border, no card frame."
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate the Seventh House tarot deck with OpenAI image generation."
    )
    parser.add_argument("--style", type=Path, default=HERE / "style.md")
    parser.add_argument("--cards", type=Path, default=HERE / "cards.json")
    parser.add_argument("--out", type=Path, default=HERE / "output")
    parser.add_argument("--only", metavar="ID", help="Generate a single card id.")
    parser.add_argument("--limit", type=int, metavar="N", help="Generate only the first N cards.")
    parser.add_argument("--force", action="store_true", help="Overwrite existing PNG files.")
    parser.add_argument(
        "--quality",
        choices=("low", "medium", "high"),
        default="high",
        help="Image quality (default: high).",
    )
    parser.add_argument(
        "--model",
        default=DEFAULT_MODEL,
        help=f"OpenAI image model (default: {DEFAULT_MODEL}).",
    )
    return parser.parse_args()


def load_style(path: Path) -> str:
    if not path.is_file():
        raise SystemExit(f"Style prompt not found: {path}")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise SystemExit(f"Style prompt is empty: {path}")
    return text


def load_cards(path: Path) -> list[dict]:
    if not path.is_file():
        raise SystemExit(f"Card list not found: {path}")
    cards = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(cards, list) or not cards:
        raise SystemExit(f"Card list must be a non-empty JSON array: {path}")
    seen: set[str] = set()
    for card in cards:
        card_id = card.get("id")
        if not card_id or card_id in seen:
            raise SystemExit(f"Each card needs a unique id: {card_id!r}")
        seen.add(card_id)
    return cards


def select_cards(cards: list[dict], only: str | None, limit: int | None) -> list[dict]:
    if only:
        chosen = [card for card in cards if card["id"] == only]
        if not chosen:
            known = ", ".join(card["id"] for card in cards)
            raise SystemExit(f"Unknown card id {only!r}. Known ids: {known}")
        return chosen
    if limit is not None:
        if limit < 1:
            raise SystemExit("--limit must be at least 1")
        return cards[:limit]
    return cards


def themes(card: dict) -> str:
    if card.get("visual"):
        return str(card["visual"]).strip()
    keywords = card.get("upright") or card.get("keywords") or []
    return ", ".join(str(item) for item in keywords if item)


def card_line(card: dict) -> str:
    if card.get("id") == "back":
        theme = themes(card)
        prefix = "Card back"
        if theme:
            prefix = f"{prefix}. Visual themes: {theme}"
        return f"{prefix}. {BACK_FRAMING}"

    name = card.get("name") or card["id"]
    arcana = (card.get("arcana") or "").lower()
    number = card.get("number")
    if arcana == "major":
        label = f'Card: "{name}" (Major Arcana, {number})'
    else:
        suit = (card.get("suit") or "").title()
        if number == 1:
            rank = "Ace"
        else:
            rank = COURT_RANKS.get(number, str(number) if number is not None else "unnumbered")
        label = f'Card: "{name}" (Minor Arcana, {suit}, {rank})'
    theme = themes(card)
    if theme:
        label = f"{label}. Visual themes: {theme}"
    return (
        f'{label}. Write the exact title "{name}" in gold lettering at the bottom '
        f"of the card. {FRAMING}"
    )


def build_prompt(style: str, card: dict) -> str:
    return f"{style.rstrip()}\n\n{card_line(card)}"


def output_path(out_dir: Path, card: dict) -> Path:
    return out_dir / f"{card['id']}.png"


def load_manifest(path: Path) -> dict:
    if not path.is_file():
        return {"cards": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {"cards": []}
    if not isinstance(data, dict):
        return {"cards": []}
    data.setdefault("cards", [])
    return data


def upsert_manifest_entry(manifest: dict, entry: dict) -> None:
    cards = manifest.setdefault("cards", [])
    for index, existing in enumerate(cards):
        if existing.get("id") == entry["id"]:
            cards[index] = entry
            return
    cards.append(entry)


def write_manifest(path: Path, manifest: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def generate_image(client: OpenAI, prompt: str, quality: str, model: str) -> bytes:
    last_error: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            response = client.images.generate(
                model=model,
                prompt=prompt,
                size=SIZE,
                quality=quality,
                output_format="png",
                n=1,
            )
            encoded = response.data[0].b64_json
            if not encoded:
                raise RuntimeError("OpenAI returned an empty image payload")
            return base64.b64decode(encoded)
        except RETRYABLE as exc:
            last_error = exc
            status = getattr(exc, "status_code", None)
            if isinstance(exc, APIStatusError) and status is not None and status < 500 and status != 429:
                raise
            if attempt == MAX_RETRIES:
                break
            delay = 2 ** (attempt - 1)
            print(f"  retry {attempt}/{MAX_RETRIES} after {delay}s ({exc})", file=sys.stderr)
            time.sleep(delay)
    raise RuntimeError(f"gave up after {MAX_RETRIES} retries: {last_error}")


def main() -> int:
    args = parse_args()
    load_dotenv(HERE / ".env")
    if not os.environ.get("OPENAI_API_KEY"):
        raise SystemExit(
            "OPENAI_API_KEY is missing. Copy .env.example to .env and add your key."
        )

    style = load_style(args.style)
    cards = select_cards(load_cards(args.cards), args.only, args.limit)
    out_dir: Path = args.out
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / "manifest.json"
    manifest = load_manifest(manifest_path)
    manifest.update(
        {
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "model": args.model,
            "size": SIZE,
            "quality": args.quality,
            "style_file": str(args.style),
        }
    )

    print(
        f"Requesting up to {len(cards)} image(s) from {args.model} "
        f"at {SIZE} quality={args.quality}."
    )
    print("A full 79-card high-quality run is expensive; use --only or --limit to test.")

    client = OpenAI()
    ok = skipped = failed = 0

    for index, card in enumerate(cards, start=1):
        card_id = card["id"]
        dest = output_path(out_dir, card)
        prompt = build_prompt(style, card)
        print(f"[{index}/{len(cards)}] {card_id}")

        if dest.exists() and not args.force:
            print(f"  skip (exists): {dest}")
            upsert_manifest_entry(
                manifest,
                {
                    "id": card_id,
                    "path": str(dest),
                    "prompt": prompt,
                    "status": "skipped",
                    "error": None,
                },
            )
            write_manifest(manifest_path, manifest)
            skipped += 1
            continue

        try:
            image = generate_image(client, prompt, args.quality, args.model)
            dest.write_bytes(image)
            upsert_manifest_entry(
                manifest,
                {
                    "id": card_id,
                    "path": str(dest),
                    "prompt": prompt,
                    "status": "ok",
                    "error": None,
                },
            )
            write_manifest(manifest_path, manifest)
            print(f"  wrote {dest} ({len(image)} bytes)")
            ok += 1
        except Exception as exc:  # noqa: BLE001 — one failure must not abort the deck
            upsert_manifest_entry(
                manifest,
                {
                    "id": card_id,
                    "path": str(dest),
                    "prompt": prompt,
                    "status": "failed",
                    "error": str(exc),
                },
            )
            write_manifest(manifest_path, manifest)
            print(f"  failed: {exc}", file=sys.stderr)
            failed += 1

    print(f"Done. ok={ok} skipped={skipped} failed={failed} manifest={manifest_path}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
