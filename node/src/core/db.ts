import { DatabaseError } from "./errors";

export interface PositionRow {
  ticker: string;
  shares: number;
  cost_basis: number;
  entry_date: string;
  notes: string | null;
  strategy: string;
}

export interface WatchlistRow {
  ticker: string;
  thesis: string;
  added_date: string;
  notes: string | null;
}

export interface QuoteRow {
  ticker: string;
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  rsi: number | null;
  ma_50: number | null;
  ma_200: number | null;
  fetched_at: string | null;
}

/**
 * A cached fundamentals snapshot for a ticker, from one of two independent
 * sources (never merged — see domains/financial's data pipeline catalog on
 * why Finnhub-live and Morningstar figures are kept distinct). Two rows can
 * exist for the same (ticker, as_of_date): one per source.
 */
export interface FundamentalsRow {
  ticker: string;
  as_of_date: string;
  source: "finnhub" | "morningstar";
  pe_ratio: number | null;
  pb_ratio: number | null;
  debt_to_equity: number | null;
  fcf: number | null;
  fcf_fiscal_year: number | null;
  fcf_yield: number | null;
  fcf_margin: number | null;
  fcf_positive: number | null; // 0/1
  dividend_yield: number | null;
  earnings_growth: number | null;
  revenue_growth: number | null;
  fair_value: number | null;
  price_to_fair_value: number | null;
  economic_moat: string | null;
  morningstar_rating: number | null;
  uncertainty: string | null;
  capital_allocation: string | null;
  red_flags: string | null; // JSON array, Morningstar-source rows only
  fetched_at: string;
}

export interface SignalRow {
  id: number;
  ticker: string;
  date: string;
  recommendation: string;
  confidence: number;
  reasoning: string;
  from_watchlist: number;
  created_at: string;
}

export interface GateRunRow {
  id: number;
  ticker: string;
  skill: string;
  run_at: string;
  verdict: string;
  rsi: number | null;
  price: number | null;
  created_at: string;
}

/** Anything with pg's `query` shape — a real `pg.Pool` or a test double (pg-mem). */
export interface PgPoolLike {
  query(text: string, values?: unknown[]): Promise<{ rows: any[]; rowCount: number | null }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  end(): Promise<void>;
}

export interface DbOpenOptions {
  /** Inject a pool (tests). When omitted a pg.Pool is created from `connectionString`. */
  pool?: PgPoolLike;
  /** Enable row level security on every table (Supabase exposes `public` via PostgREST). Default true; pg-mem can't run it. */
  enableRls?: boolean;
  /** Backoff delays (ms) when retrying transient EMAXCONNSESSION errors on open. */
  retryDelaysMs?: number[];
}

const DEFAULT_OPEN_RETRY_DELAYS_MS = [250, 500, 1000];

function isMaxSessionError(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  if (code === "EMAXCONNSESSION") return true;
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("EMAXCONNSESSION") || msg.includes("max clients reached in session mode");
}

/** SQLSTATE class 22 (data exception) / 23 (integrity constraint) — the write was rejected, the db is fine. */
function isRejectedWrite(e: unknown): boolean {
  const code = (e as { code?: unknown })?.code;
  return typeof code === "string" && (code.startsWith("22") || code.startsWith("23"));
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS tickers (
    symbol TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK(type IN ('PUBLIC','PRIVATE')),
    sector TEXT,
    added_date TEXT NOT NULL,
    notes TEXT,
    UNIQUE(name, type)
  );
  CREATE TABLE IF NOT EXISTS positions (
    ticker TEXT PRIMARY KEY REFERENCES tickers(symbol),
    shares DOUBLE PRECISION NOT NULL,
    cost_basis DOUBLE PRECISION NOT NULL,
    entry_date TEXT NOT NULL,
    notes TEXT,
    strategy TEXT NOT NULL DEFAULT 'long-term' CHECK(strategy IN ('long-term','swing','both'))
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    ticker TEXT PRIMARY KEY REFERENCES tickers(symbol),
    thesis TEXT NOT NULL,
    added_date TEXT NOT NULL,
    notes TEXT
  );
  CREATE TABLE IF NOT EXISTS quotes (
    ticker TEXT NOT NULL REFERENCES tickers(symbol),
    date TEXT NOT NULL,
    open DOUBLE PRECISION,
    high DOUBLE PRECISION,
    low DOUBLE PRECISION,
    close DOUBLE PRECISION,
    volume BIGINT,
    rsi DOUBLE PRECISION,
    ma_50 DOUBLE PRECISION,
    ma_200 DOUBLE PRECISION,
    fetched_at TEXT,
    PRIMARY KEY (ticker, date)
  );
  CREATE TABLE IF NOT EXISTS fundamentals (
    ticker TEXT NOT NULL REFERENCES tickers(symbol),
    as_of_date TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('finnhub','morningstar')),
    pe_ratio DOUBLE PRECISION,
    pb_ratio DOUBLE PRECISION,
    debt_to_equity DOUBLE PRECISION,
    fcf DOUBLE PRECISION,
    fcf_fiscal_year INTEGER,
    fcf_yield DOUBLE PRECISION,
    fcf_margin DOUBLE PRECISION,
    fcf_positive INTEGER,
    dividend_yield DOUBLE PRECISION,
    earnings_growth DOUBLE PRECISION,
    revenue_growth DOUBLE PRECISION,
    fair_value DOUBLE PRECISION,
    price_to_fair_value DOUBLE PRECISION,
    economic_moat TEXT,
    morningstar_rating INTEGER,
    uncertainty TEXT,
    capital_allocation TEXT,
    red_flags TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (ticker, as_of_date, source)
  );
  CREATE TABLE IF NOT EXISTS signals (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL REFERENCES tickers(symbol),
    date TEXT NOT NULL,
    recommendation TEXT NOT NULL CHECK(recommendation IN ('BUY','SELL','HOLD')),
    confidence DOUBLE PRECISION NOT NULL,
    reasoning TEXT NOT NULL,
    from_watchlist INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_quotes_date ON quotes(date);
  CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(date);
  CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
  CREATE INDEX IF NOT EXISTS idx_fundamentals_ticker ON fundamentals(ticker, source);
  CREATE TABLE IF NOT EXISTS gate_runs (
    id SERIAL PRIMARY KEY,
    ticker TEXT NOT NULL REFERENCES tickers(symbol),
    skill TEXT NOT NULL,
    run_at TEXT NOT NULL,
    verdict TEXT NOT NULL,
    rsi DOUBLE PRECISION,
    price DOUBLE PRECISION,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_gate_runs_ticker_skill ON gate_runs(ticker, skill, run_at DESC);
`;

const TABLES = ["tickers", "positions", "watchlist", "quotes", "fundamentals", "signals", "gate_runs"];

/**
 * Postgres-backed store (Supabase in production). Same method surface as the
 * old SQLite class, but every call is async. `Db.open()` connects and creates
 * the schema, so an unreachable database fails fast with a DatabaseError
 * instead of the caller silently reading nothing.
 */
export class Db {
  private constructor(private pool: PgPoolLike) {}

  static async open(connectionString: string | undefined, opts: DbOpenOptions = {}): Promise<Db> {
    let pool = opts.pool;
    if (!pool) {
      if (!connectionString) {
        throw new DatabaseError(
          "No database configured: set SNESTACK_DATABASE_URL in node/.env to the Supabase Postgres connection string"
        );
      }
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Pool, types } = require("pg") as typeof import("pg");
      pool = new Pool({
        connectionString,
        max: 1,
        connectionTimeoutMillis: 10_000,
        // Supabase requires TLS; its pooler certs don't chain to a public CA bundle.
        ssl: { rejectUnauthorized: false },
        // BIGINT (volume) arrives as a string by default — snestack stores volumes well inside 2^53.
        types: { getTypeParser: (oid: number, fmt?: "text" | "binary") =>
          oid === 20 ? (v: string) => Number(v) : types.getTypeParser(oid, fmt as "text") },
      } as import("pg").PoolConfig) as unknown as PgPoolLike;
    }
    const db = new Db(pool);
    const retryDelays = opts.retryDelaysMs ?? DEFAULT_OPEN_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await pool.query("SELECT 1");
        await pool.query(SCHEMA);
        if (opts.enableRls ?? !opts.pool) {
          for (const t of TABLES) await pool.query(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
        }
        return db;
      } catch (e) {
        if (isMaxSessionError(e) && attempt < retryDelays.length) {
          await new Promise((r) => setTimeout(r, retryDelays[attempt]));
          continue;
        }
        await pool.end().catch(() => undefined);
        throw new DatabaseError(`Failed to open database (is Supabase reachable? see node/README.md): ${scrub(e)}`);
      }
    }
  }

  /** Run an arbitrary query (migration, tests). */
  async query<T = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(text, values)).rows as T[];
  }

  private async one<T>(text: string, values: unknown[]): Promise<T | undefined> {
    return (await this.pool.query(text, values)).rows[0] as T | undefined;
  }

  private async many<T>(text: string, values: unknown[] = []): Promise<T[]> {
    return (await this.pool.query(text, values)).rows as T[];
  }

  /** Run a write; a rejected write (constraint/data error) is `false`, anything else (connection lost…) throws. */
  private async write(text: string, values: unknown[]): Promise<boolean> {
    try {
      await this.pool.query(text, values);
      return true;
    } catch (e) {
      if (isRejectedWrite(e)) return false;
      throw new DatabaseError(scrub(e));
    }
  }

  private async affected(text: string, values: unknown[]): Promise<boolean> {
    return ((await this.pool.query(text, values)).rowCount ?? 0) > 0;
  }

  // ── Tickers ────────────────────────────────────────────────────────────────

  addTicker(
    symbol: string,
    name: string,
    type: "PUBLIC" | "PRIVATE",
    sector?: string | null,
    notes?: string | null
  ): Promise<boolean> {
    return this.write(
      `INSERT INTO tickers (symbol, name, type, sector, added_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
      [symbol, name, type, sector ?? null, new Date().toISOString(), notes ?? null]
    );
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  async addPosition(
    ticker: string,
    shares: number,
    costBasis: number,
    notes?: string | null,
    strategy?: string
  ): Promise<boolean> {
    // Preserve existing notes/strategy on an update if the caller doesn't re-specify them.
    const existing = await this.getPosition(ticker);
    const finalNotes = notes !== undefined ? notes : (existing?.notes ?? null);
    const finalStrategy = strategy !== undefined ? strategy : (existing?.strategy ?? "long-term");
    return this.write(
      `INSERT INTO positions (ticker, shares, cost_basis, entry_date, notes, strategy)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (ticker) DO UPDATE SET shares = EXCLUDED.shares, cost_basis = EXCLUDED.cost_basis,
         entry_date = EXCLUDED.entry_date, notes = EXCLUDED.notes, strategy = EXCLUDED.strategy`,
      [ticker, shares, costBasis, new Date().toISOString(), finalNotes, finalStrategy]
    );
  }

  /** Update just the strategy tag for an existing position, without touching shares/cost basis. */
  async updatePositionStrategy(ticker: string, strategy: string): Promise<boolean> {
    if (!["long-term", "swing", "both"].includes(strategy)) return false;
    return this.affected("UPDATE positions SET strategy = $1 WHERE ticker = $2", [strategy, ticker]);
  }

  removePosition(ticker: string): Promise<boolean> {
    return this.affected("DELETE FROM positions WHERE ticker = $1", [ticker]);
  }

  getPosition(ticker: string): Promise<PositionRow | undefined> {
    return this.one("SELECT * FROM positions WHERE ticker = $1", [ticker]);
  }

  getAllPositions(): Promise<PositionRow[]> {
    return this.many("SELECT * FROM positions");
  }

  // ── Watchlist ──────────────────────────────────────────────────────────────

  addWatchlist(ticker: string, thesis: string, notes?: string | null): Promise<boolean> {
    return this.write(
      `INSERT INTO watchlist (ticker, thesis, added_date, notes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (ticker) DO UPDATE SET thesis = EXCLUDED.thesis, added_date = EXCLUDED.added_date, notes = EXCLUDED.notes`,
      [ticker, thesis, new Date().toISOString(), notes ?? null]
    );
  }

  removeWatchlist(ticker: string): Promise<boolean> {
    return this.affected("DELETE FROM watchlist WHERE ticker = $1", [ticker]);
  }

  getWatchlist(): Promise<WatchlistRow[]> {
    return this.many("SELECT * FROM watchlist");
  }

  // ── Quotes ─────────────────────────────────────────────────────────────────

  addQuote(
    ticker: string,
    date: string,
    open: number,
    high: number,
    low: number,
    close: number,
    volume: number,
    rsi?: number | null,
    ma50?: number | null,
    ma200?: number | null,
    fetchedAt?: string
  ): Promise<boolean> {
    return this.write(
      `INSERT INTO quotes (ticker, date, open, high, low, close, volume, rsi, ma_50, ma_200, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (ticker, date) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high, low = EXCLUDED.low,
         close = EXCLUDED.close, volume = EXCLUDED.volume, rsi = EXCLUDED.rsi, ma_50 = EXCLUDED.ma_50,
         ma_200 = EXCLUDED.ma_200, fetched_at = EXCLUDED.fetched_at`,
      [ticker, date, open, high, low, close, volume, rsi ?? null, ma50 ?? null, ma200 ?? null,
        fetchedAt ?? new Date().toISOString()]
    );
  }

  getLatestQuote(ticker: string): Promise<QuoteRow | undefined> {
    return this.one("SELECT * FROM quotes WHERE ticker = $1 ORDER BY date DESC LIMIT 1", [ticker]);
  }

  getQuotes(ticker: string, limit = 250): Promise<QuoteRow[]> {
    return this.many("SELECT * FROM quotes WHERE ticker = $1 ORDER BY date DESC LIMIT $2", [ticker, limit]);
  }

  /** Latest quote row, or undefined if missing or older than maxAgeMs (by fetched_at; a row with no fetched_at is always stale). */
  async getQuoteIfFresh(ticker: string, maxAgeMs: number): Promise<QuoteRow | undefined> {
    const row = await this.getLatestQuote(ticker);
    if (!row?.fetched_at) return undefined;
    const age = Date.now() - Date.parse(row.fetched_at);
    return isFinite(age) && age <= maxAgeMs ? row : undefined;
  }

  // ── Fundamentals ───────────────────────────────────────────────────────────

  addFundamentals(row: Omit<FundamentalsRow, "fetched_at"> & { fetched_at?: string }): Promise<boolean> {
    const cols = [
      "ticker", "as_of_date", "source", "pe_ratio", "pb_ratio", "debt_to_equity", "fcf", "fcf_fiscal_year",
      "fcf_yield", "fcf_margin", "fcf_positive", "dividend_yield", "earnings_growth", "revenue_growth",
      "fair_value", "price_to_fair_value", "economic_moat", "morningstar_rating", "uncertainty",
      "capital_allocation", "red_flags", "fetched_at",
    ] as const;
    const values = cols.map((c) =>
      c === "fetched_at" ? (row.fetched_at ?? new Date().toISOString()) : ((row as unknown as Record<string, unknown>)[c] ?? null)
    );
    const updates = cols
      .filter((c) => !["ticker", "as_of_date", "source"].includes(c))
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    return this.write(
      `INSERT INTO fundamentals (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
       ON CONFLICT (ticker, as_of_date, source) DO UPDATE SET ${updates}`,
      values
    );
  }

  getLatestFundamentals(ticker: string, source: "finnhub" | "morningstar"): Promise<FundamentalsRow | undefined> {
    return this.one(
      "SELECT * FROM fundamentals WHERE ticker = $1 AND source = $2 ORDER BY as_of_date DESC, fetched_at DESC LIMIT 1",
      [ticker, source]
    );
  }

  /** Latest fundamentals row for this source, or undefined if missing or older than maxAgeMs (by fetched_at). */
  async getFundamentalsIfFresh(
    ticker: string,
    source: "finnhub" | "morningstar",
    maxAgeMs: number
  ): Promise<FundamentalsRow | undefined> {
    const row = await this.getLatestFundamentals(ticker, source);
    if (!row) return undefined;
    const age = Date.now() - Date.parse(row.fetched_at);
    return isFinite(age) && age <= maxAgeMs ? row : undefined;
  }

  // ── Signals ────────────────────────────────────────────────────────────────

  async addSignal(
    ticker: string,
    date: string,
    recommendation: string,
    confidence: number,
    reasoning: string,
    fromWatchlist = false
  ): Promise<number> {
    const row = await this.one<{ id: number }>(
      `INSERT INTO signals (ticker, date, recommendation, confidence, reasoning, from_watchlist, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [ticker, date, recommendation, confidence, reasoning, fromWatchlist ? 1 : 0, new Date().toISOString()]
    );
    return Number(row!.id);
  }

  getSignals(ticker: string, days = 30): Promise<SignalRow[]> {
    // `date` is TEXT ("YYYY-MM-DD" or "YYYY-MM-DD HH:MM:SS"); compare against the same shape.
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
    return this.many("SELECT * FROM signals WHERE ticker = $1 AND date >= $2 ORDER BY date DESC", [ticker, cutoff]);
  }

  /** The most recent signal for a ticker whose reasoning starts with `prefix` (e.g. "[Long-term]"). */
  getLastSignalWithPrefix(ticker: string, prefix: string): Promise<SignalRow | undefined> {
    return this.one(
      `SELECT * FROM signals WHERE ticker = $1 AND reasoning LIKE $2
       ORDER BY date DESC LIMIT 1`,
      [ticker, prefix.replace(/[\\%_]/g, "\\$&") + "%"]
    );
  }

  getAllSignals(limit = 100): Promise<SignalRow[]> {
    return this.many("SELECT * FROM signals ORDER BY created_at DESC LIMIT $1", [limit]);
  }

  getSignalById(id: number): Promise<SignalRow | undefined> {
    return this.one("SELECT * FROM signals WHERE id = $1", [id]);
  }

  // ── Gate runs (every evaluated verdict, including NONE) ────────────────────

  recordGateRun(row: {
    ticker: string;
    skill: string;
    runAt: string;
    verdict: string;
    rsi: number | null;
    price: number | null;
  }): Promise<boolean> {
    return this.write(
      `INSERT INTO gate_runs (ticker, skill, run_at, verdict, rsi, price, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.ticker, row.skill, row.runAt, row.verdict, row.rsi, row.price, new Date().toISOString()]
    );
  }

  getLastGateRun(ticker: string, skill: string): Promise<GateRunRow | undefined> {
    return this.one(
      `SELECT * FROM gate_runs WHERE ticker = $1 AND skill = $2
       ORDER BY run_at DESC, id DESC LIMIT 1`,
      [ticker, skill]
    );
  }

  /** Close the connection pool. */
  close(): Promise<void> {
    return this.pool.end();
  }
}

/** Never let a connection string (which embeds the password) reach a log or error message. */
function scrub(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  const raw = e instanceof Error ? e.message : String(e);
  const firstLine = raw.split("\n")[0]?.trim() || raw;
  const msg = typeof code === "string" && code && !firstLine.includes(code) ? `[${code}] ${firstLine}` : firstLine;
  return msg.replace(/postgres(ql)?:\/\/[^\s'"]+/gi, "postgres://<redacted>");
}
