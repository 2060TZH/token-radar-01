// Token Radar: the value model and the farm plans.
//
// The board ranks pre-token protocols by an implied launch value derived only from the sealed
// snapshot's own figures. Nothing here names a protocol: the same arithmetic scores every row, and
// the category multiples come from the snapshot's own live-token protocols, so a fresh snapshot
// with different protocols re-prices itself.
//
//   multiple  = median(mcap_usd / tvl_usd) over the snapshot's live-token protocols in the
//               protocol's category; the global median when the category has fewer than 3 live
//               comps; clamped to [0.05, 2.0]
//   growth    = 1 + clamp(change_7d, -60, 120) / 100 * 0.5        (null change_7d counts as 0)
//   maturity  = 0.6 + min(age_days, 1095) / 1095 * 0.4            (unknown listed_at counts as 365)
//   implied   = max(1, round(tvl_usd * multiple * growth * maturity))
//
// The multiples are rounded to 4 decimals before the implied value is computed, so the detail view
// can show the exact multiplication the board used. A protocol records no token when its market
// cap, CoinGecko id and symbol are all null; the board never claims a protocol has no token, only
// that its record carries none.

/** One protocol entry: exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
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
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, printed in full on the dashboard's "How the model works" section. */
export interface ModelConstants {
  min_live_comps: number;
  multiple_floor: number;
  multiple_cap: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  min_live_comps: 3,
  multiple_floor: 0.05,
  multiple_cap: 2.0,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** The model's version label, shown on the dashboard. */
export const MODEL_VERSION = 'radar-median-1';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the live-token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** One category's multiple: the median mcap/TVL of its live comps, and how many comps set it. */
export interface CategoryMultiple {
  category: string | null;
  multiple: number;
  comps: number;
  fallback: boolean;
}

/** One row of board.json: a ranked pre-token protocol with its farm plan. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  token_status: 'pre-token';
  watchlist: boolean;
  model: {
    category_multiple: number;
    category_comps: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the page shows the market's value, never a model. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** Everything the dashboard renders, from the snapshot. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  multiples: CategoryMultiple[];
  rows: BoardRow[];
  live: LiveRow[];
}

/** Why a snapshot file is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Four-decimal rounding, so the dashboard's shown math reproduces the board's value exactly. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when the date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The category multiples for one snapshot: for each category, the median mcap/TVL across the
 * snapshot's own live-token protocols in that category (a live-token protocol is one whose record
 * carries a market cap above zero). A category with fewer than `min_live_comps` comps falls back
 * to the global median across every live-token protocol. Every multiple is clamped to
 * [multiple_floor, multiple_cap] and rounded to 4 decimals.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple } {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const globalMultiple = round4(Math.min(model.multiple_cap, Math.max(model.multiple_floor, median(live.map((p) => p.mcap_usd! / p.tvl_usd)))));
  const global: CategoryMultiple = { category: null, multiple: globalMultiple, comps: live.length, fallback: false };

  const ratios = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? '';
    const list = ratios.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    ratios.set(key, list);
  }
  const byCategory = new Map<string, CategoryMultiple>();
  for (const [key, values] of ratios) {
    if (values.length >= model.min_live_comps) {
      const m = round4(Math.min(model.multiple_cap, Math.max(model.multiple_floor, median(values))));
      byCategory.set(key, { category: key === '' ? null : key, multiple: m, comps: values.length, fallback: false });
    }
  }
  return { byCategory, global };
}

/** The multiple one protocol's category earns, with its comps count and whether it fell back. */
function multipleFor(category: string | null, multiples: { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple }): CategoryMultiple {
  const hit = multiples.byCategory.get(category ?? '');
  if (hit !== undefined) return hit;
  return { category, multiple: multiples.global.multiple, comps: multiples.global.comps, fallback: true };
}

/** The implied value and its breakdown for one protocol. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: { byCategory: Map<string, CategoryMultiple>; global: CategoryMultiple },
  model: ModelConstants = MODEL,
): { implied: number; multiple: CategoryMultiple; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const multiple = multipleFor(protocol.category, multiples);
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = round4(1 + (growthPct / 100) * model.growth_weight);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = round4(model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * multiple.multiple * growthMult * maturityMult));
  return { implied, multiple, growthPct, growthMult, maturityMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol's record carries no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** How much capital one farm position needs, tiered by the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The category's one opening action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open so it earns interest and counts as usage.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity manager')) {
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open so it earns fees.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside the app it points to.`;
  }
  if (c.includes('stak') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token in your wallet.`;
  }
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position, then close it the same week.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} and place one market position on ${name}, then settle it and withdraw the balance.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares in your wallet.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold the balance in your wallet.`;
  }
  if (c.includes('rwa')) {
    return `Mint $${capital} of the protocol's yield-bearing asset on ${chain} through ${name} and hold it.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the full term.`;
  }
  if (c.includes('index')) {
    return `Buy $${capital} of the index token ${name} issues on ${chain} and hold it in your wallet.`;
  }
  if (c.includes('launchpad')) {
    return `Deposit $${capital} into ${name}'s staking pool on ${chain} and join one sale it opens while you hold.`;
  }
  if (c.includes('farm')) {
    return `Deposit $${capital} of USDC into ${name}'s farm on ${chain} and keep the position open.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open so it counts as usage.`;
}

/**
 * A protocol's farm plan: six steps, each an action with its cost and time stated. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a hand-written
 * list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps = [
    `Set up a fresh wallet that holds only the funds you plan to farm, and write its seed phrase on paper and store it offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${actionFor(p, capital, chain)} Cost: $${capital} of capital and about $${gas} of gas. Time: 15 minutes to set up.`,
    `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, so the wallet stays active. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Before you withdraw anything, open the protocol's own points or rewards page from the link it publishes and check your balance there. Cost: no fee to check, and never pay to claim. Time: 10 minutes.`,
    `Write the wallet address, the dates and every transaction hash in a farm log so you can repeat the position or unwind it later. Cost: nothing but the log. Time: 5 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const multiples = categoryMultiples(snapshot, model);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug it names, even one the snapshot no longer carries.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: the highest-TVL rankable pre-token protocols below the floor, capped.
  // Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const v = impliedValue(p, snapshot.as_of, multiples, model);
    return { p, ...v };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    age_days: s.age,
    implied_value_usd: s.implied,
    token_status: 'pre-token',
    watchlist: snapshot.watchlist.includes(s.p.slug),
    model: {
      category_multiple: s.multiple.multiple,
      category_comps: s.multiple.comps,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
}

/** The live-token protocols, by market cap, for the dashboard's live-token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot, model);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const multiplesList: CategoryMultiple[] = [...multiples.byCategory.values()]
    .sort((a, b) => (a.category ?? '').localeCompare(b.category ?? ''))
    .concat([{ category: null, multiple: multiples.global.multiple, comps: multiples.global.comps, fallback: false }]);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    multiples: multiplesList,
    rows: board,
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** The dashboard's dataset as one script: window.RADAR, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
