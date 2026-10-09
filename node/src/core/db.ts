// node:sqlite is built into Node 22+ (--experimental-sqlite flag required below v23)
// It is a synchronous API identical in style to better-sqlite3.
import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
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
  fcf_positive: number | null; // 0/1, sqlite has no boolean
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

export class Db {
  private db: DatabaseSync;

  constructor(dbPath: string = "snestack.db") {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.initSchema();
      this.migrateSchema();
    } catch (e) {
      throw new DatabaseError(`Failed to open database at ${dbPath}: ${e}`);
    }
  }

  private initSchema(): void {
    this.db.exec(`
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
        ticker TEXT PRIMARY KEY,
        shares REAL NOT NULL,
        cost_basis REAL NOT NULL,
        entry_date TEXT NOT NULL,
        notes TEXT,
        strategy TEXT NOT NULL DEFAULT 'long-term' CHECK(strategy IN ('long-term','swing','both')),
        FOREIGN KEY (ticker) REFERENCES tickers(symbol)
      );

      CREATE TABLE IF NOT EXISTS watchlist (
        ticker TEXT PRIMARY KEY,
        thesis TEXT NOT NULL,
        added_date TEXT NOT NULL,
        notes TEXT,
        FOREIGN KEY (ticker) REFERENCES tickers(symbol)
      );

      CREATE TABLE IF NOT EXISTS quotes (
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        open REAL,
        high REAL,
        low REAL,
        close REAL,
        volume INTEGER,
        rsi REAL,
        ma_50 REAL,
        ma_200 REAL,
        PRIMARY KEY (ticker, date),
        FOREIGN KEY (ticker) REFERENCES tickers(symbol)
      );

      CREATE TABLE IF NOT EXISTS fundamentals (
        ticker TEXT NOT NULL,
        as_of_date TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('finnhub','morningstar')),
        pe_ratio REAL,
        pb_ratio REAL,
        debt_to_equity REAL,
        fcf REAL,
        fcf_fiscal_year INTEGER,
        fcf_yield REAL,
        fcf_margin REAL,
        fcf_positive INTEGER,
        dividend_yield REAL,
        earnings_growth REAL,
        revenue_growth REAL,
        fair_value REAL,
        price_to_fair_value REAL,
        economic_moat TEXT,
        morningstar_rating INTEGER,
        uncertainty TEXT,
        capital_allocation TEXT,
        red_flags TEXT,
        fetched_at TEXT NOT NULL,
        PRIMARY KEY (ticker, as_of_date, source),
        FOREIGN KEY (ticker) REFERENCES tickers(symbol)
      );

      CREATE TABLE IF NOT EXISTS signals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        date TEXT NOT NULL,
        recommendation TEXT NOT NULL CHECK(recommendation IN ('BUY','SELL','HOLD')),
        confidence REAL NOT NULL,
        reasoning TEXT NOT NULL,
        from_watchlist INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (ticker) REFERENCES tickers(symbol)
      );

      CREATE INDEX IF NOT EXISTS idx_quotes_date ON quotes(date);
      CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(date);
      CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
      CREATE INDEX IF NOT EXISTS idx_fundamentals_ticker ON fundamentals(ticker, source);
    `);
  }

  /**
   * Idempotent migrations for databases created before a schema change.
   * initSchema()'s CREATE TABLE IF NOT EXISTS only helps fresh databases —
   * existing ones need an explicit ALTER TABLE for new columns.
   */
  private migrateSchema(): void {
    const positionCols = this.db
      .prepare("PRAGMA table_info(positions)")
      .all() as unknown as Array<{ name: string }>;
    const hasStrategy = positionCols.some((c) => c.name === "strategy");
    if (!hasStrategy) {
      this.db.exec(
        `ALTER TABLE positions ADD COLUMN strategy TEXT NOT NULL DEFAULT 'long-term'
         CHECK(strategy IN ('long-term','swing','both'))`
      );
    }

    const quoteCols = this.db
      .prepare("PRAGMA table_info(quotes)")
      .all() as unknown as Array<{ name: string }>;
    const hasFetchedAt = quoteCols.some((c) => c.name === "fetched_at");
    if (!hasFetchedAt) {
      this.db.exec(`ALTER TABLE quotes ADD COLUMN fetched_at TEXT`);
    }
  }

  // ── Tickers ────────────────────────────────────────────────────────────────

  addTicker(
    symbol: string,
    name: string,
    type: "PUBLIC" | "PRIVATE",
    sector?: string | null,
    notes?: string | null
  ): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO tickers (symbol, name, type, sector, added_date, notes)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(symbol, name, type, sector ?? null, new Date().toISOString(), notes ?? null);
      return true;
    } catch {
      return false;
    }
  }

  // ── Positions ──────────────────────────────────────────────────────────────

  addPosition(
    ticker: string,
    shares: number,
    costBasis: number,
    notes?: string | null,
    strategy?: string
  ): boolean {
    try {
      // Preserve existing notes/strategy on an update (INSERT OR REPLACE would
      // otherwise silently wipe them if the caller doesn't re-specify them).
      const existing = this.getPosition(ticker);
      const finalNotes = notes !== undefined ? notes : (existing?.notes ?? null);
      const finalStrategy = strategy !== undefined ? strategy : (existing?.strategy ?? "long-term");
      this.db
        .prepare(
          `INSERT OR REPLACE INTO positions (ticker, shares, cost_basis, entry_date, notes, strategy)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(ticker, shares, costBasis, new Date().toISOString(), finalNotes, finalStrategy);
      return true;
    } catch {
      return false;
    }
  }

  /** Update just the strategy tag for an existing position, without touching shares/cost basis. */
  updatePositionStrategy(ticker: string, strategy: string): boolean {
    if (!["long-term", "swing", "both"].includes(strategy)) return false;
    const result = this.db
      .prepare("UPDATE positions SET strategy = ? WHERE ticker = ?")
      .run(strategy, ticker);
    return (result.changes as number) > 0;
  }

  removePosition(ticker: string): boolean {
    const result = this.db.prepare("DELETE FROM positions WHERE ticker = ?").run(ticker);
    return (result.changes as number) > 0;
  }

  getPosition(ticker: string): PositionRow | undefined {
    return this.db
      .prepare("SELECT * FROM positions WHERE ticker = ?")
      .get(ticker) as unknown as PositionRow | undefined;
  }

  getAllPositions(): PositionRow[] {
    return this.db.prepare("SELECT * FROM positions").all() as unknown as PositionRow[];
  }

  // ── Watchlist ──────────────────────────────────────────────────────────────

  addWatchlist(ticker: string, thesis: string, notes?: string | null): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO watchlist (ticker, thesis, added_date, notes)
           VALUES (?, ?, ?, ?)`
        )
        .run(ticker, thesis, new Date().toISOString(), notes ?? null);
      return true;
    } catch {
      return false;
    }
  }

  removeWatchlist(ticker: string): boolean {
    const result = this.db.prepare("DELETE FROM watchlist WHERE ticker = ?").run(ticker);
    return (result.changes as number) > 0;
  }

  getWatchlist(): WatchlistRow[] {
    return this.db.prepare("SELECT * FROM watchlist").all() as unknown as WatchlistRow[];
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
  ): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO quotes
           (ticker, date, open, high, low, close, volume, rsi, ma_50, ma_200, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          ticker,
          date,
          open,
          high,
          low,
          close,
          volume,
          rsi ?? null,
          ma50 ?? null,
          ma200 ?? null,
          fetchedAt ?? new Date().toISOString()
        );
      return true;
    } catch {
      return false;
    }
  }

  getLatestQuote(ticker: string): QuoteRow | undefined {
    return this.db
      .prepare("SELECT * FROM quotes WHERE ticker = ? ORDER BY date DESC LIMIT 1")
      .get(ticker) as unknown as QuoteRow | undefined;
  }

  getQuotes(ticker: string, limit = 250): QuoteRow[] {
    return this.db
      .prepare("SELECT * FROM quotes WHERE ticker = ? ORDER BY date DESC LIMIT ?")
      .all(ticker, limit) as unknown as QuoteRow[];
  }

  /** Latest quote row, or undefined if missing or older than maxAgeMs (by fetched_at; a row with no fetched_at — pre-migration — is always treated as stale). */
  getQuoteIfFresh(ticker: string, maxAgeMs: number): QuoteRow | undefined {
    const row = this.getLatestQuote(ticker);
    if (!row?.fetched_at) return undefined;
    const age = Date.now() - Date.parse(row.fetched_at);
    return isFinite(age) && age <= maxAgeMs ? row : undefined;
  }

  // ── Fundamentals ───────────────────────────────────────────────────────────

  addFundamentals(row: Omit<FundamentalsRow, "fetched_at"> & { fetched_at?: string }): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO fundamentals
           (ticker, as_of_date, source, pe_ratio, pb_ratio, debt_to_equity, fcf, fcf_fiscal_year,
            fcf_yield, fcf_margin, fcf_positive, dividend_yield, earnings_growth, revenue_growth,
            fair_value, price_to_fair_value, economic_moat, morningstar_rating, uncertainty,
            capital_allocation, red_flags, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.ticker,
          row.as_of_date,
          row.source,
          row.pe_ratio ?? null,
          row.pb_ratio ?? null,
          row.debt_to_equity ?? null,
          row.fcf ?? null,
          row.fcf_fiscal_year ?? null,
          row.fcf_yield ?? null,
          row.fcf_margin ?? null,
          row.fcf_positive ?? null,
          row.dividend_yield ?? null,
          row.earnings_growth ?? null,
          row.revenue_growth ?? null,
          row.fair_value ?? null,
          row.price_to_fair_value ?? null,
          row.economic_moat ?? null,
          row.morningstar_rating ?? null,
          row.uncertainty ?? null,
          row.capital_allocation ?? null,
          row.red_flags ?? null,
          row.fetched_at ?? new Date().toISOString()
        );
      return true;
    } catch {
      return false;
    }
  }

  getLatestFundamentals(
    ticker: string,
    source: "finnhub" | "morningstar"
  ): FundamentalsRow | undefined {
    return this.db
      .prepare(
        "SELECT * FROM fundamentals WHERE ticker = ? AND source = ? ORDER BY as_of_date DESC, fetched_at DESC LIMIT 1"
      )
      .get(ticker, source) as unknown as FundamentalsRow | undefined;
  }

  /** Latest fundamentals row for this source, or undefined if missing or older than maxAgeMs (by fetched_at). */
  getFundamentalsIfFresh(
    ticker: string,
    source: "finnhub" | "morningstar",
    maxAgeMs: number
  ): FundamentalsRow | undefined {
    const row = this.getLatestFundamentals(ticker, source);
    if (!row) return undefined;
    const age = Date.now() - Date.parse(row.fetched_at);
    return isFinite(age) && age <= maxAgeMs ? row : undefined;
  }

  // ── Signals ────────────────────────────────────────────────────────────────

  addSignal(
    ticker: string,
    date: string,
    recommendation: string,
    confidence: number,
    reasoning: string,
    fromWatchlist = false
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO signals
         (ticker, date, recommendation, confidence, reasoning, from_watchlist, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ticker,
        date,
        recommendation,
        confidence,
        reasoning,
        fromWatchlist ? 1 : 0,
        new Date().toISOString()
      );
    return result.lastInsertRowid as number;
  }

  getSignals(ticker: string, days = 30): SignalRow[] {
    return this.db
      .prepare(
        `SELECT * FROM signals
         WHERE ticker = ? AND date >= datetime('now', '-' || ? || ' days')
         ORDER BY date DESC`
      )
      .all(ticker, days) as unknown as SignalRow[];
  }

  /** The most recent signal for a ticker whose reasoning starts with `prefix` (e.g. "[Long-term]"). */
  getLastSignalWithPrefix(ticker: string, prefix: string): SignalRow | undefined {
    return this.db
      .prepare(
        `SELECT * FROM signals
         WHERE ticker = ? AND substr(reasoning, 1, length(?)) = ?
         ORDER BY date DESC LIMIT 1`
      )
      .get(ticker, prefix, prefix) as unknown as SignalRow | undefined;
  }

  getAllSignals(limit = 100): SignalRow[] {
    return this.db
      .prepare("SELECT * FROM signals ORDER BY created_at DESC LIMIT ?")
      .all(limit) as unknown as SignalRow[];
  }

  getSignalById(id: number): SignalRow | undefined {
    return this.db
      .prepare("SELECT * FROM signals WHERE id = ?")
      .get(id) as unknown as SignalRow | undefined;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Expose raw db for testing/advanced use. */
  raw(): DatabaseSync {
    return this.db;
  }
}
