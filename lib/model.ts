// Launch Radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// The question the board answers: if a protocol that records no token issued one today, at the
// scale its own record supports, what would that token be worth — and what should a reader do
// about it before the launch? Nothing here is read from outside the snapshot: no hand-kept list
// of names, no live prices, no clock. The same snapshot always produces the same board.
//
// How a value is derived (every factor is computed from the snapshot's own figures):
//
//   1. A comparables multiple. Protocols whose token already trades reveal what the market pays
//      per dollar of TVL. For each category with at least three such protocols, the multiple is
//      the median market-cap / TVL ratio of that category, held inside [0.05, 3.0]; a category
//      with too few traded peers falls back to the median over the whole traded universe.
//   2. base = tvl_usd x multiple(category)
//   3. A momentum factor from the seven-day TVL change, clamped to [-40%, +80%] and weighted
//      one half: 1 + 0.5 x change / 100, so a hot week lifts a value by at most 40% and a bad
//      one cuts it by at most 20%.
//   4. A seasoning factor from how long the protocol has run with no token: 0.75 for a protocol
//      listed today, rising linearly to 1.00 at four years. An unreported listing date counts
//      as one year. A long tokenless track record is evidence a launch would be believed.
//   5. A breadth factor of 3% per extra chain beyond the first, capped at four extra chains:
//      a protocol holding TVL on several chains has more holders to distribute a launch to.
//
//   implied_value_usd = max(1, round(base x momentum x seasoning x breadth))
//
// The board ranks every protocol that passes the radar's screen by that value. The screen is
// the watchlist's own product rule run over the whole universe, not just above its TVL floor:
// a candidate records no token (no market cap, no CoinGecko id, no symbol) and is not a wrapped,
// staked, bridged or versioned product of something else, not an exchange, and does not wear an
// exchange's name. Every watchlist slug is ranked whether or not it passes the screen, because
// coverage of the watchlist is the board's first duty; the screen only governs the early rows
// the radar adds below the floor. Protocols whose token already trades are never ranked: they
// are reported separately, at the market's own values, as the comparables the model stands on.
//
// A launch-readiness score (0-100) rides beside the value for the reader's eye only; it never
// moves a rank. It blends size (log TVL), momentum, track record and chain breadth.

// ------------------------------------------------------------------ snapshot types

/** One protocol of the sealed snapshot: exactly the ten fields the input carries. */
export interface ProtocolRecord {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface SnapshotDoc {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: ProtocolRecord[];
  watchlist: string[];
}

/** Why a snapshot cannot be scored by this model. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ------------------------------------------------------------------ the model's constants

/** Every constant the valuation uses, stated here once and repeated on the dashboard. */
export const MODEL = {
  /** A category needs this many traded protocols before its own median is trusted. */
  multiple_min_samples: 3,
  /** No category multiple, however hot its peers, is read outside this band. */
  multiple_floor: 0.05,
  multiple_cap: 3,
  /** The seven-day change is clamped to this band before it moves a value. */
  growth_floor_pct: -40,
  growth_cap_pct: 80,
  /** How much of the clamped change reaches the value. */
  growth_weight: 0.5,
  /** Seasoning: the factor for a protocol listed today, and the age at which it tops out. */
  seasoning_floor: 0.75,
  seasoning_full_days: 1460,
  /** The age an unreported listing date counts as, in days. */
  unknown_age_days: 365,
  /** Breadth: the factor added per chain beyond the first, and how many count. */
  breadth_per_chain: 0.03,
  breadth_max_extra: 4,
} as const;

/** The model's name and version, printed on the board and the dashboard. */
export const MODEL_NAME = 'comparables radar';
export const MODEL_VERSION = 'launch-radar-2';

const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ small helpers

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list, computed on a sorted copy so input order never matters. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from the day a protocol was listed to the snapshot's day; null when unreported. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

// ------------------------------------------------------------------ the screen

/** Categories that are products of another protocol's asset, never a launch of their own. */
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** A name ending in a release marker is one protocol's newer pool, not a new protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whole words that mark a wrapped or staked product of a token that already trades. */
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;

/** Names that open with an exchange's name are that exchange's product, not a candidate. */
const EXCHANGE_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/** True when the record shows a token already trading: any of the three token fields set. */
export function recordsToken(p: ProtocolRecord): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/**
 * The radar's screen for the early rows below the watchlist floor: no token recorded, and not
 * a wrapped, staked, bridged or versioned product, an exchange, or an exchange's namesake.
 */
export function passesScreen(p: ProtocolRecord): boolean {
  if (recordsToken(p)) return false;
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (PRODUCT_WORD.test(p.name)) return false;
  if (EXCHANGE_PREFIX.test(p.name)) return false;
  return true;
}

// ------------------------------------------------------------------ comparables

/** One category's traded multiple: the median market cap per TVL dollar, and its sample size. */
export interface CategoryMultiple {
  multiple: number;
  samples: number;
  /** 'category' when the median is the category's own, 'global' when it is the fallback. */
  basis: 'category' | 'global';
}

/** The multiples the traded universe supports: one per category, plus the global fallback. */
export interface MultipleTable {
  global: number;
  global_samples: number;
  by_category: Map<string, CategoryMultiple>;
}

/** Build the multiples from the protocols whose token already trades. */
export function buildMultiples(protocols: ProtocolRecord[]): MultipleTable {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    if (p.category !== null) {
      const list = ratiosByCategory.get(p.category) ?? [];
      list.push(ratio);
      ratiosByCategory.set(p.category, list);
    }
  }
  const global = all.length > 0 ? clamp(median(all), MODEL.multiple_floor, MODEL.multiple_cap) : 1;
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [category, ratios] of ratiosByCategory) {
    if (ratios.length >= MODEL.multiple_min_samples) {
      byCategory.set(category, {
        multiple: round4(clamp(median(ratios), MODEL.multiple_floor, MODEL.multiple_cap)),
        samples: ratios.length,
        basis: 'category',
      });
    } else {
      byCategory.set(category, { multiple: round4(global), samples: ratios.length, basis: 'global' });
    }
  }
  return { global: round4(global), global_samples: all.length, by_category: byCategory };
}

/** The multiple one protocol is valued at, and where it came from. */
function multipleFor(p: ProtocolRecord, table: MultipleTable): CategoryMultiple {
  if (p.category !== null) {
    const found = table.by_category.get(p.category);
    if (found !== undefined) return found;
  }
  return { multiple: table.global, samples: table.global_samples, basis: 'global' };
}

// ------------------------------------------------------------------ valuation

/** The four factors of one protocol's implied value, kept so the dashboard can show the working. */
export interface Valuation {
  multiple: number;
  multiple_basis: 'category' | 'global';
  multiple_samples: number;
  momentum_factor: number;
  seasoning_factor: number;
  breadth_factor: number;
  implied_value_usd: number;
}

/** Value one pre-token protocol from its own record and the comparables table. */
export function valueProtocol(p: ProtocolRecord, asOf: string, table: MultipleTable): Valuation {
  const m = multipleFor(p, table);
  const change = clamp(p.change_7d ?? 0, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const momentum = 1 + (change / 100) * MODEL.growth_weight;
  const age = ageInDays(asOf, p.listed_at) ?? MODEL.unknown_age_days;
  const seasoning = MODEL.seasoning_floor + (1 - MODEL.seasoning_floor) * (Math.min(age, MODEL.seasoning_full_days) / MODEL.seasoning_full_days);
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_max_extra);
  const breadth = 1 + MODEL.breadth_per_chain * extraChains;
  const implied = Math.max(1, Math.round(p.tvl_usd * m.multiple * momentum * seasoning * breadth));
  return {
    multiple: m.multiple,
    multiple_basis: m.basis,
    multiple_samples: m.samples,
    momentum_factor: round4(momentum),
    seasoning_factor: round4(seasoning),
    breadth_factor: round4(breadth),
    implied_value_usd: implied,
  };
}

/**
 * A launch-readiness score from 0 to 100, for the reader's eye: size on a log scale, momentum,
 * track record and breadth. Display only — ranks come from implied value alone.
 */
export function readinessScore(p: ProtocolRecord, asOf: string): number {
  const size = 40 * clamp(Math.log10(Math.max(p.tvl_usd, 1) / 5_000_000) / Math.log10(5_000_000_000 / 5_000_000), 0, 1);
  const change = clamp(p.change_7d ?? 0, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const momentum = 25 * clamp((change + 20) / 60, 0, 1);
  const age = ageInDays(asOf, p.listed_at) ?? MODEL.unknown_age_days;
  const track = 25 * (Math.min(age, MODEL.seasoning_full_days) / MODEL.seasoning_full_days);
  const breadth = 10 * (Math.min(p.chains.length, 5) / 5);
  return Math.round(size + momentum + track + breadth);
}

// ------------------------------------------------------------------ farm plans

/** What one transaction costs on the chain a protocol mainly lives on, in plain words. */
function gasProfile(chain: string): string {
  if (chain === 'Ethereum') return 'about $8 in ETH gas per transaction';
  if (chain === 'Solana') return 'about $0.10 in SOL fees per transaction';
  if (chain === 'Bitcoin') return 'about $2 in BTC fees per transaction';
  const l2 = ['Arbitrum', 'Base', 'Optimism', 'Polygon', 'zkSync Era', 'Linea', 'Scroll', 'Mantle', 'Blast', 'Mode', 'Taiko', 'Bera', 'Monad', 'Hyperliquid L1'];
  if (l2.includes(chain)) return 'about $0.60 in gas per transaction';
  return 'about $0.40 in gas per transaction';
}

/** The capital a sensible first farm position carries, scaled to the protocol's own size. */
function capitalTier(tvl: number): number {
  if (tvl >= 2_000_000_000) return 500;
  if (tvl >= 500_000_000) return 250;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 50;
}

/** How long a position should be held to count, from the protocol's age: younger, longer. */
function holdWindow(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** The core farming action for a category, in words a reader can follow in the protocol's app. */
function coreAction(category: string | null, name: string, chain: string, capital: number): string {
  const c = (category ?? '').toLowerCase();
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC as collateral in ${name} on ${chain}, then borrow about 40% against it and supply the borrowed amount back once`;
  }
  if (c.includes('dex') || c.includes('derivative') || c.includes('perpetual')) {
    return `Trade $${capital} of volume through ${name} on ${chain} across the week and park $${Math.round(capital / 2)} in its main liquidity pool meanwhile`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, use the bridged funds in one app on the far side, and bridge a smaller amount back a week later`;
  }
  if (c.includes('restak') || c.includes('staking')) {
    return `Stake $${capital} of the base asset through ${name} on ${chain} and keep the receipt token in the same wallet`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into one ${name} curated vault on ${chain} and hold the vault shares in the same wallet`;
  }
  if (c.includes('launchpad')) {
    return `Register the wallet with ${name} on ${chain} and take part in one live sale or staking round with up to $${capital}`;
  }
  if (c.includes('prediction')) {
    return `Fund the wallet with $${capital} on ${chain} and hold one position in an active ${name} market until it settles`;
  }
  if (c.includes('option') || c.includes('interest rate')) {
    return `Deposit $${capital} into one ${name} vault on ${chain} and let a full options cycle run before withdrawing anything`;
  }
  if (c.includes('rwa')) {
    return `Subscribe $${capital} to the tokenised asset ${name} offers on ${chain} and hold the position through one full yield period`;
  }
  if (c.includes('insurance')) {
    return `Underwrite $${capital} in one ${name} cover pool on ${chain}, or buy cover for a position you already hold`;
  }
  if (c.includes('payment') || c.includes('card')) {
    return `Activate ${name} on ${chain}, load $${capital}, and route your ordinary spending or transfers through it for the month`;
  }
  if (c.includes('stable') || c.includes('basis') || c.includes('synthetic') || c.includes('reserve')) {
    return `Mint or deposit $${capital} of the protocol's stable asset in ${name} on ${chain} and hold it in the wallet`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of the ${name} index on ${chain} and hold it rather than trading in and out`;
  }
  if (c.includes('chain')) {
    return `Bridge $${capital} to ${chain}, then make real transactions there weekly: swaps, a name or NFT mint, and one contract interaction beyond ${name} itself`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open and untouched`;
}

/**
 * One protocol's farm plan: six steps, each a concrete action with what it costs and how long
 * it takes. Everything in the plan is derived from the protocol's own record — its category
 * picks the action, its first chain the gas, its TVL the capital, its age the holding window.
 */
export function farmPlan(p: ProtocolRecord, age: number | null): string[] {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const gas = gasProfile(chain);
  const capital = capitalTier(p.tvl_usd);
  const hold = holdWindow(age);
  const steps = [
    `Set up one fresh wallet for ${p.name} alone, fund it from an exchange withdrawal, and keep its recovery phrase offline on paper. Cost: ${gas} to fund. Time: 10 minutes, once.`,
    `${coreAction(p.category, p.name, chain, capital)}. Cost: $${capital} of working capital plus ${gas}. Time: 20 minutes to set up.`,
    `Repeat one small qualifying action every week — a deposit, a swap, a vote or a claim — so the wallet shows a history, not a single visit. Cost: ${gas} a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days and do not withdraw before then; most snapshots that count activity span several weeks. Cost: the $${capital} stays committed. Time: ${hold} days.`,
    `Once a month, open the protocol's own points, rewards or governance page from its official site and check the wallet's standing; never follow a claim link from a message or a search ad. Cost: nothing to check, and never pay anyone to claim. Time: 10 minutes a month.`,
    `Keep a farm log — wallet, dates, amounts, transaction hashes — and review it monthly; when a token launches, claim only from the protocol's official page and decide your exit before the claim opens. Cost: nothing. Time: 15 minutes a month.`,
  ];
  return steps.map((s) => {
    const t = s.trim();
    if (t.length > 600) return `${t.slice(0, 596)}...`;
    if (t.length < 20) return `${t} Keep the position open and check back weekly.`;
    return t;
  });
}

// ------------------------------------------------------------------ the board

/** One ranked row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  on_watchlist: boolean;
  implied_value_usd: number;
  valuation: Valuation;
  readiness: number;
  farm_steps: string[];
}

/** A protocol whose token already trades, shown at the market's own value as a comparable. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** Everything the dashboard renders, written beside the page as data.js. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_name: string;
  model_version: string;
  constants: typeof MODEL;
  multiples: { global: number; global_samples: number; categories: Record<string, CategoryMultiple> };
  stats: {
    protocols_scanned: number;
    pretoken_found: number;
    board_rows: number;
    watchlist_rows: number;
    early_rows: number;
    live_rows: number;
  };
  rows: BoardRow[];
  live: LiveRow[];
}

/** How many traded protocols the comparables table shows. */
export const LIVE_ROWS = 36;

/** Build the ranked board and the dashboard's data from one snapshot. */
export function buildRadar(snapshot: SnapshotDoc): RadarData {
  const table = buildMultiples(snapshot.protocols);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const watchlist = new Set(snapshot.watchlist);

  const chosen = new Map<string, ProtocolRecord>();
  for (const slug of snapshot.watchlist) {
    const p = bySlug.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  let pretokenFound = 0;
  for (const p of snapshot.protocols) {
    if (recordsToken(p)) continue;
    pretokenFound++;
    if (!chosen.has(p.slug) && passesScreen(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const valuation = valueProtocol(p, snapshot.as_of, table);
    return { p, valuation, age: ageInDays(snapshot.as_of, p.listed_at), readiness: readinessScore(p, snapshot.as_of) };
  });
  scored.sort(
    (a, b) =>
      b.valuation.implied_value_usd - a.valuation.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );

  const rows: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    on_watchlist: watchlist.has(s.p.slug),
    implied_value_usd: s.valuation.implied_value_usd,
    valuation: s.valuation,
    readiness: s.readiness,
    farm_steps: farmPlan(s.p, s.age),
  }));

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd! || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
      change_7d: p.change_7d,
    }));

  const categories: Record<string, CategoryMultiple> = {};
  for (const key of [...table.by_category.keys()].sort()) categories[key] = table.by_category.get(key)!;

  return {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_name: MODEL_NAME,
    model_version: MODEL_VERSION,
    constants: MODEL,
    multiples: { global: table.global, global_samples: table.global_samples, categories },
    stats: {
      protocols_scanned: snapshot.protocols.length,
      pretoken_found: pretokenFound,
      board_rows: rows.length,
      watchlist_rows: rows.filter((r) => r.on_watchlist).length,
      early_rows: rows.filter((r) => !r.on_watchlist).length,
      live_rows: live.length,
    },
    rows,
    live,
  };
}

// ------------------------------------------------------------------ input and self-check

/** Read the snapshot out of a file's text, refusing anything that is not its shape. */
export function parseSnapshot(text: string): SnapshotDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json carries no as_of date');
  if (typeof o.source !== 'string' || o.source.length === 0) throw new SnapshotError('snapshot.json carries no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json carries no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json carries no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json carries no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`protocol ${i} lacks a slug, a name or a TVL`);
    }
    const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
    const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
    return {
      slug: p.slug,
      name: p.name,
      category: str(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: num(p.change_7d),
      mcap_usd: num(p.mcap_usd),
      listed_at: str(p.listed_at),
      gecko_id: str(p.gecko_id),
      symbol: str(p.symbol),
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate accepts, or null: the gate's own rows, checked before writing. */
export function boardIssue(rows: BoardRow[], snapshot: SnapshotDoc): string | null {
  if (rows.length < 100 || rows.length > 4000) return `the board holds ${rows.length} rows, outside 100..4000`;
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of rows) {
    if (!known.has(r.slug)) return `${r.slug} is not one of the snapshot's protocols`;
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters`;
    }
  }
  for (const slug of snapshot.watchlist) if (!seen.has(slug)) return `the board misses watchlist slug ${slug}`;
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return `rank ${i + 1} is held by ${byRank[i]!.slug} with rank ${byRank[i]!.rank}`;
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `${byRank[i]!.slug} outranks ${byRank[i - 1]!.slug} on implied value`;
  }
  if (rows.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  return null;
}

/** The dashboard's data as one script: window.RADAR, no fetch, no network. */
export function dataScript(data: RadarData): string {
  return `window.RADAR=${JSON.stringify(data)};\n`;
}
