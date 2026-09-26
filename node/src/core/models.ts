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

export const NotificationType = z.enum(["email", "sms"]);
export type NotificationType = z.infer<typeof NotificationType>;

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

export const PendingNotificationSchema = z.object({
  id: z.number().int().optional(),
  ticker: z.string().min(1),
  signalId: z.number().int().nullable().optional(),
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
  notificationType: NotificationType,
  createdAt: z.date().default(() => new Date()),
  retryCount: z.number().int().nonnegative().default(0),
  lastRetryAt: z.date().nullable().optional(),
});
export type PendingNotification = z.infer<typeof PendingNotificationSchema>;

// ── Agent data models ─────────────────────────────────────────────────────────

export interface QuoteData {
  ticker: string;
  price: number;
  open?: number;
  high?: number;
  low?: number;
  volume?: number;
  // Live fundamentals from Finnhub's Basic Financials endpoint (/stock/metric),
  // fetched alongside the price quote. These take priority over the matching
  // EquityData fields (which come from a Morningstar PDF snapshot that can be
  // weeks/months stale) wherever Finnhub returns a value — see
  // orchestrator.ts's withLiveFundamentals(). Morningstar's own analyst
  // judgments (fair value, moat, star rating, uncertainty, capital allocation)
  // have no real-time equivalent and are never overridden.
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
  dividendYield?: number | null;
  earningsGrowth?: number | null;
  revenueGrowth?: number | null;
  timestamp: Date;
}

export interface EquityData {
  ticker: string;
  peRatio?: number | null;
  pbRatio?: number | null;
  debtToEquity?: number | null;
  fcf?: number | null;
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

export interface StrategySignal {
  ticker: string;
  recommendation: Recommendation;
  confidence: number;
  rsiSignal?: string | null;
  maSignal?: string | null;
  volumeSignal?: string | null;
  reasoning: string;
  timestamp: Date;
}

// ── Batch analysis ────────────────────────────────────────────────────────────

export interface BatchAnalysisInput {
  ticker: string;
  quote?: QuoteData | null;
  strategy?: StrategySignal | null;
  equity?: EquityData | null;
}

export interface BatchAnalysisResult {
  signals: Signal[];
  errors: Record<string, string>;
  startTime: Date;
  endTime: Date;
  durationSeconds: number;
  get successCount(): number;
  get errorCount(): number;
}

export function makeBatchResult(
  signals: Signal[],
  errors: Record<string, string>,
  startTime: Date,
  endTime: Date
): BatchAnalysisResult {
  return {
    signals,
    errors,
    startTime,
    endTime,
    durationSeconds: (endTime.getTime() - startTime.getTime()) / 1000,
    get successCount() {
      return this.signals.length;
    },
    get errorCount() {
      return Object.keys(this.errors).length;
    },
  };
}
