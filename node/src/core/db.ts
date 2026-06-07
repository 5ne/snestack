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

export interface PendingNotificationRow {
  id: number;
  ticker: string;
  email: string | null;
  phone: string | null;
  notification_type: string;
  signal_id: number | null;
  created_at: string;
  retry_count: number;
  last_retry_at: string | null;
}

export class Db {
  private db: DatabaseSync;

  constructor(dbPath: string = "fstack.db") {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      this.db = new DatabaseSync(dbPath);
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.initSchema();
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

      CREATE TABLE IF NOT EXISTS pending_notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticker TEXT NOT NULL,
        email TEXT,
        phone TEXT,
        notification_type TEXT NOT NULL CHECK(notification_type IN ('email','sms')),
        signal_id INTEGER,
        created_at TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_retry_at TEXT,
        FOREIGN KEY (ticker) REFERENCES tickers(symbol),
        FOREIGN KEY (signal_id) REFERENCES signals(id)
      );

      CREATE INDEX IF NOT EXISTS idx_quotes_date ON quotes(date);
      CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(date);
      CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
      CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_notifications(created_at);
    `);
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

  addPosition(ticker: string, shares: number, costBasis: number, notes?: string | null): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO positions (ticker, shares, cost_basis, entry_date, notes)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run(ticker, shares, costBasis, new Date().toISOString(), notes ?? null);
      return true;
    } catch {
      return false;
    }
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
    ma200?: number | null
  ): boolean {
    try {
      this.db
        .prepare(
          `INSERT OR REPLACE INTO quotes
           (ticker, date, open, high, low, close, volume, rsi, ma_50, ma_200)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ticker, date, open, high, low, close, volume, rsi ?? null, ma50 ?? null, ma200 ?? null);
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

  // ── Pending notifications ──────────────────────────────────────────────────

  addPendingNotification(
    ticker: string,
    signalId: number,
    email?: string | null,
    phone?: string | null,
    notificationType = "email"
  ): boolean {
    try {
      this.db
        .prepare(
          `INSERT INTO pending_notifications
           (ticker, email, phone, notification_type, signal_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(ticker, email ?? null, phone ?? null, notificationType, signalId, new Date().toISOString());
      return true;
    } catch {
      return false;
    }
  }

  getPendingNotifications(): PendingNotificationRow[] {
    return this.db
      .prepare("SELECT * FROM pending_notifications ORDER BY created_at ASC")
      .all() as unknown as PendingNotificationRow[];
  }

  removePendingNotification(id: number): boolean {
    return (this.db.prepare("DELETE FROM pending_notifications WHERE id = ?").run(id).changes as number) > 0;
  }

  updatePendingNotificationRetry(id: number): boolean {
    return (
      this.db
        .prepare(
          `UPDATE pending_notifications
           SET retry_count = retry_count + 1, last_retry_at = ?
           WHERE id = ?`
        )
        .run(new Date().toISOString(), id).changes as number
    ) > 0;
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
