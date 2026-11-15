# Launch Radar

A token launch radar for make.fun's token-radar-01 bounty. It reads a sealed snapshot of the
protocol universe (DefiLlama data, frozen) and ranks the protocols that record no token yet by
the value their token would carry if they launched at the scale their own record supports —
each with a concrete plan for farming it before the launch.

## The model

Implied value is derived only from the snapshot's own figures, in `lib/model.ts`:

- **Comparables multiple.** Protocols whose token already trades reveal what the market pays
  per dollar of TVL. Each category with at least three traded peers is valued at that
  category's median market-cap/TVL ratio (held inside 0.05x–3.0x); the rest fall back to the
  global median.
- **Momentum.** The seven-day TVL change, clamped to −40%…+80% and weighted one half.
- **Seasoning.** 0.75 for a protocol listed today, rising linearly to 1.00 at four years of
  running with no token.
- **Breadth.** +3% per chain beyond the first, up to four extra chains.

`implied = TVL × multiple × momentum × seasoning × breadth`. The board covers the whole
snapshot watchlist and adds every further pre-token protocol that passes the same product
screen below the watchlist's TVL floor. Protocols that already trade are never ranked; they
are shown separately, at the market's own values, as the comparables the model stands on.

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22.18 or later, standard library only. The run is deterministic and writes `board.json`,
`data.js`, `dashboard/`, `screenshots/` and `dossier.json` into the output directory. Open
`out/dashboard/index.html` in a browser — the page renders entirely from `data.js`, with no
network.

## Layout

- `main.ts` — the entrypoint: snapshot in, board and dashboard out, dossier last.
- `lib/model.ts` — the screen, the comparables multiples, the valuation, the farm plans.
- `dashboard/` — the static page (board, traded comparables, filters, per-protocol detail).
- `screenshots/` — the board, a detail view and a filtered view, rendered from this page.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored byte for byte.
