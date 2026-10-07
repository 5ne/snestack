import { z } from "zod";

// ── Enums ────────────────────────────────────────────────────────────────────

export const TickerType = z.enum(["PUBLIC", "PRIVATE"]);
export type TickerType = z.infer<typeof TickerType>;

export const Recommendation = z.enum(["BUY", "SELL", "HOLD"]);
export type Recommendation = z.infer<typeof Recommendation>;

// "both" means this ticker carries a long-term core position AND separate
// tactical swing trades on top of it — see domains/financial/skills/long-term-quality.md
// and domains/financial/skills/swing-trading-large-cap.md for what each means.
export const PositionStrategy = z.enum(["long-term", "swing", "both"]);
export type PositionStrategy = z.infer<typeof PositionStrategy>;


// ── Domain models ────────────────────────────────────────────────────────────

export const TickerSchema = z.object({
  symbol: z.string().min(1),
  name: z.string().min(1),
  type: TickerType,
  sector: z.string().nullable().optional(),
  addedDate: z.date().default(() => new Date()),
  notes: z.string().nullable().optional(),
});
export type Ticker = z.infer<typeof TickerSchema>;

export const PositionSchema = z.object({
  ticker: z.string().min(1),
  shares: z.number().positive(),
  costBasis: z.number().positive(),
  entryDate: z.date(),
  notes: z.string().nullable().optional(),
  strategy: PositionStrategy.default("long-term"),
});
export type Position = z.infer<typeof PositionSchema>;

export const WatchlistSchema = z.object({
  ticker: z.string().min(1),
  thesis: z.string().min(1),
  addedDate: z.date().default(() => new Date()),
  notes: z.string().nullable().optional(),
});
export type Watchlist = z.infer<typeof WatchlistSchema>;

export const QuoteSchema = z.object({
  ticker: z.string().min(1),
  date: z.date(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number().int().nonnegative(),
  rsi: z.number().min(0).max(100).nullable().optional(),
  ma50: z.number().nullable().optional(),
  ma200: z.number().nullable().optional(),
});
export type Quote = z.infer<typeof QuoteSchema>;

export const SignalSchema = z.object({
  id: z.number().int().optional(),
  ticker: z.string().min(1),
  date: z.date().default(() => new Date()),
  recommendation: Recommendation,
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  fromWatchlist: z.boolean().default(false),
  createdAt: z.date().default(() => new Date()),
});
export type Signal = z.infer<typeof SignalSchema>;

// ── Agent data models ─────────────────────────────────────────────────────────

export interface QuoteData {
  ticker: string;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  // Live fundamentals from Finnhub's Basic Financials endpoint (/stock/metric),
  // fetched alongside the price quote. run-skill supplies these (QUOTE) and the
  // Morningstar PDF snapshot (FUNDAMENTALS, which can be weeks/months stale) as
  // separate context sections — nothing merges them, so a skill sees both and
  // can flag disagreements. Morningstar's own analyst judgments (fair value,
  // moat, star rating, uncertainty, capital allocation) have no real-time
  // equivalent.
  //
  // fcf (absolute free cash flow in dollars) is deliberately NOT sourced from
  // Finnhub here — Finnhub's raw freeCashFlowTTM figure's unit scale wasn't
  // verified against a live response in the session that wrote this (no
  // network access to finnhub.io from that sandbox), and guessing wrong would
  // silently show a wildly incorrect dollar figure. fcfYield (a self-normalizing
  // ratio, safe regardless of unit scale) is included; the raw fcf dollar
  // amount still comes from Morningstar only.
  peRatio?: number | null;
  pbRatio?: number | null;
  debtToEquity?: number | null;
  fcfYield?: number | null;
  fcfMargin?: number | null;
  fcfPositive?: boolean | null;
  dividendYield?: number | null;
  earningsGrowth?: number | null;
  revenueGrowth?: number | null;
  // Computed from historical closes (see providers/*QuoteProvider.getHistoricalCloses).
  // Always populated here regardless of whether a Db was passed to QuoteAgent —
  // db persistence (for data-dump's own read-back) is a separate side effect.
  rsi?: number | null;
  ma50?: number | null;
  ma200?: number | null;
  timestamp: Date;
}

export interface EquityData {
  ticker: string;
  peRatio?: number | null;
  pbRatio?: number | null;
  debtToEquity?: number | null;
  fcf?: number | null;
  /** Fiscal year `fcf` belongs to (Morningstar's latest actual year). */
  fcfFiscalYear?: number | null;
  fcfYield?: number | null;
  dividendYield?: number | null;
  earningsGrowth?: number | null;
  revenueGrowth?: number | null;
  redFlags: string[];
  // Morningstar-specific
  fairValue?: number | null;
  priceToFairValue?: number | null;
  economicMoat?: string | null;
  morningstarRating?: number | null;
  uncertainty?: string | null;
  capitalAllocation?: string | null;
  timestamp: Date;
}
