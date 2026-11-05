# Tarot deck generator

Offline script that renders the Seventh House deck (78 cards + 1 back) with
OpenAI image generation (`gpt-image-2.5-sunburst` by default). One editable
style prompt sets the deck-wide look; a loop renders every card.

Images land in `output/` as 1024×1536 PNG. Copy approved art into the app's
`deck/` folder yourself — this directory does not write there.

## Setup

```bash
cd card-generator
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS / Linux
pip install -r requirements.txt
copy .env.example .env          # Windows
# cp .env.example .env          # macOS / Linux
```

Put your OpenAI API key in `.env`:

```
OPENAI_API_KEY=sk-...
```

## Style prompt

Edit `style.md`. That file is prepended verbatim to every card request, so it
controls art style, palette, mood, motifs, and composition for the whole deck.

`cards.json` is the bundled card list (id, name, arcana, suit, number,
keywords). You can add a `visual` string on any card to override the default
theme line built from keywords.

## Usage

```bash
# cheap smoke test — one card, medium quality
python generate_deck.py --only major-00-fool --quality medium

# first 3 cards (still skips files that already exist)
python generate_deck.py --limit 3

# full deck (79 images: 78 cards + back). Expensive.
python generate_deck.py

# regenerate a card even if output/<id>.png already exists
python generate_deck.py --only major-00-fool --force
```

Flags:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--style` | `style.md` | Deck-wide style prompt |
| `--cards` | `cards.json` | Card catalogue |
| `--out` | `output/` | Destination directory |
| `--only <id>` | — | Generate a single card id |
| `--limit N` | — | Generate only the first N selected cards |
| `--force` | off | Overwrite existing PNG files |
| `--quality` | `high` | `low`, `medium`, or `high` |
| `--model` | `gpt-image-2.5-sunburst` | OpenAI image model (`gpt-image-2.5-flare`, `gpt-image-2.6-sunburst`, …) |

Runs are resumable: existing `output/<id>.png` files are skipped unless
`--force` is set. Failures do not abort the rest of the deck. `output/manifest.json`
records the exact prompt and status for every card processed.

A full 79-image high-quality run is costly. Start with `--only` or `--limit`.
