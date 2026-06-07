"""
SQLite database management for fstack.

Handles schema initialization, connection pooling, and transaction management.
Single source of truth for all data: positions, watchlist, quotes, signals, tickers.
"""

import sqlite3
from pathlib import Path
from contextlib import contextmanager
from typing import Optional, List, Tuple
from datetime import datetime


class Database:
    """SQLite database connection and schema management."""

    def __init__(self, db_path: str = "fstack.db"):
        """Initialize database connection.

        Args:
            db_path: Path to SQLite database file
        """
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    def _init_schema(self):
        """Create tables if they don't exist."""
        with self.get_connection() as conn:
            cursor = conn.cursor()

            # Tickers master table: all possible investments (public + private)
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS tickers (
                    symbol TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    type TEXT NOT NULL CHECK(type IN ('PUBLIC', 'PRIVATE')),
                    sector TEXT,
                    added_date TEXT NOT NULL,
                    notes TEXT,
                    UNIQUE(name, type)
                )
            """)

            # Positions: current portfolio holdings
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS positions (
                    ticker TEXT PRIMARY KEY,
                    shares REAL NOT NULL,
                    cost_basis REAL NOT NULL,
                    entry_date TEXT NOT NULL,
                    notes TEXT,
                    FOREIGN KEY (ticker) REFERENCES tickers(symbol)
                )
            """)

            # Watchlist: investments we're monitoring but don't own
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS watchlist (
                    ticker TEXT PRIMARY KEY,
                    thesis TEXT NOT NULL,
                    added_date TEXT NOT NULL,
                    notes TEXT,
                    FOREIGN KEY (ticker) REFERENCES tickers(symbol)
                )
            """)

            # Quotes: historical price data and technical indicators
            cursor.execute("""
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
                )
            """)

            # Signals: analysis recommendations from agents
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker TEXT NOT NULL,
                    date TEXT NOT NULL,
                    recommendation TEXT NOT NULL CHECK(recommendation IN ('BUY', 'SELL', 'HOLD')),
                    confidence REAL NOT NULL,
                    reasoning TEXT NOT NULL,
                    from_watchlist INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY (ticker) REFERENCES tickers(symbol)
                )
            """)

            # Pending notifications: failed emails/SMS for retry
            cursor.execute("""
                CREATE TABLE IF NOT EXISTS pending_notifications (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticker TEXT NOT NULL,
                    email TEXT,
                    phone TEXT,
                    notification_type TEXT NOT NULL CHECK(notification_type IN ('email', 'sms')),
                    signal_id INTEGER,
                    created_at TEXT NOT NULL,
                    retry_count INTEGER NOT NULL DEFAULT 0,
                    last_retry_at TEXT,
                    FOREIGN KEY (ticker) REFERENCES tickers(symbol),
                    FOREIGN KEY (signal_id) REFERENCES signals(id)
                )
            """)

            # Create indexes for common queries
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_quotes_date ON quotes(date)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_signals_date ON signals(date)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker)
            """)
            cursor.execute("""
                CREATE INDEX IF NOT EXISTS idx_pending_created ON pending_notifications(created_at)
            """)

            conn.commit()

    @contextmanager
    def get_connection(self):
        """Get database connection context manager.

        Yields:
            sqlite3.Connection: Database connection
        """
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        try:
            yield conn
        finally:
            conn.close()

    def query(self, sql: str, params: Tuple = ()) -> List[sqlite3.Row]:
        """Execute SELECT query and return results.

        Args:
            sql: SQL query
            params: Query parameters

        Returns:
            List of row results
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(sql, params)
            return cursor.fetchall()

    def execute(self, sql: str, params: Tuple = ()) -> int:
        """Execute INSERT/UPDATE/DELETE query.

        Args:
            sql: SQL query
            params: Query parameters

        Returns:
            Number of affected rows
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute(sql, params)
            conn.commit()
            return cursor.rowcount

    def execute_many(self, sql: str, params_list: List[Tuple]) -> int:
        """Execute INSERT/UPDATE/DELETE for multiple rows.

        Args:
            sql: SQL query
            params_list: List of parameter tuples

        Returns:
            Number of affected rows
        """
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.executemany(sql, params_list)
            conn.commit()
            return cursor.rowcount

    def add_ticker(self, symbol: str, name: str, type_: str, sector: Optional[str] = None, notes: Optional[str] = None) -> bool:
        """Add ticker to master table.

        Args:
            symbol: Ticker symbol (e.g., 'NVDA' or 'anthropic')
            name: Company name
            type_: 'PUBLIC' or 'PRIVATE'
            sector: Industry sector (optional)
            notes: Additional notes (optional)

        Returns:
            True if successful, False if already exists
        """
        try:
            self.execute("""
                INSERT INTO tickers (symbol, name, type, sector, added_date, notes)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (symbol, name, type_, sector, datetime.now().isoformat(), notes))
            return True
        except sqlite3.IntegrityError:
            return False

    def add_position(self, ticker: str, shares: float, cost_basis: float, notes: Optional[str] = None) -> bool:
        """Add or update position.

        Args:
            ticker: Ticker symbol
            shares: Number of shares
            cost_basis: Average cost per share
            notes: Notes about position

        Returns:
            True if successful
        """
        try:
            self.execute("""
                INSERT OR REPLACE INTO positions (ticker, shares, cost_basis, entry_date, notes)
                VALUES (?, ?, ?, ?, ?)
            """, (ticker, shares, cost_basis, datetime.now().isoformat(), notes))
            return True
        except Exception:
            return False

    def add_watchlist(self, ticker: str, thesis: str, notes: Optional[str] = None) -> bool:
        """Add ticker to watchlist.

        Args:
            ticker: Ticker symbol
            thesis: Investment thesis
            notes: Additional notes

        Returns:
            True if successful
        """
        try:
            self.execute("""
                INSERT OR REPLACE INTO watchlist (ticker, thesis, added_date, notes)
                VALUES (?, ?, ?, ?)
            """, (ticker, thesis, datetime.now().isoformat(), notes))
            return True
        except Exception:
            return False

    def add_quote(self, ticker: str, date: str, open_: float, high: float, low: float, close: float,
                  volume: int, rsi: Optional[float] = None, ma_50: Optional[float] = None,
                  ma_200: Optional[float] = None) -> bool:
        """Add quote data.

        Args:
            ticker: Ticker symbol
            date: Date in ISO format
            open_, high, low, close: OHLC prices
            volume: Trading volume
            rsi, ma_50, ma_200: Technical indicators (optional)

        Returns:
            True if successful
        """
        try:
            self.execute("""
                INSERT OR REPLACE INTO quotes
                (ticker, date, open, high, low, close, volume, rsi, ma_50, ma_200)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (ticker, date, open_, high, low, close, volume, rsi, ma_50, ma_200))
            return True
        except Exception:
            return False

    def add_signal(self, ticker: str, date: str, recommendation: str, confidence: float,
                   reasoning: str, from_watchlist: bool = False) -> int:
        """Add signal recommendation.

        Args:
            ticker: Ticker symbol
            date: Date in ISO format
            recommendation: 'BUY', 'SELL', or 'HOLD'
            confidence: Confidence 0-1
            reasoning: Explanation
            from_watchlist: Whether signal is from watchlist

        Returns:
            Signal ID
        """
        cursor = self.query("""
            INSERT INTO signals
            (ticker, date, recommendation, confidence, reasoning, from_watchlist, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            RETURNING id
        """, (ticker, date, recommendation, confidence, reasoning, int(from_watchlist), datetime.now().isoformat()))

        # query() returns list, so need to use execute and lastrowid
        with self.get_connection() as conn:
            cursor = conn.cursor()
            cursor.execute("""
                INSERT INTO signals
                (ticker, date, recommendation, confidence, reasoning, from_watchlist, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (ticker, date, recommendation, confidence, reasoning, int(from_watchlist), datetime.now().isoformat()))
            conn.commit()
            return cursor.lastrowid

    def add_pending_notification(self, ticker: str, signal_id: int, email: Optional[str] = None,
                                 phone: Optional[str] = None, notification_type: str = "email") -> bool:
        """Add notification to pending queue for retry.

        Args:
            ticker: Ticker symbol
            signal_id: Associated signal ID
            email: Email address
            phone: Phone number
            notification_type: 'email' or 'sms'

        Returns:
            True if successful
        """
        try:
            self.execute("""
                INSERT INTO pending_notifications
                (ticker, email, phone, notification_type, signal_id, created_at)
                VALUES (?, ?, ?, ?, ?, ?)
            """, (ticker, email, phone, notification_type, signal_id, datetime.now().isoformat()))
            return True
        except Exception:
            return False

    def get_position(self, ticker: str) -> Optional[sqlite3.Row]:
        """Get position by ticker."""
        rows = self.query("SELECT * FROM positions WHERE ticker = ?", (ticker,))
        return rows[0] if rows else None

    def get_all_positions(self) -> List[sqlite3.Row]:
        """Get all positions."""
        return self.query("SELECT * FROM positions")

    def get_watchlist(self) -> List[sqlite3.Row]:
        """Get all watchlist items."""
        return self.query("SELECT * FROM watchlist")

    def get_quotes(self, ticker: str) -> List[sqlite3.Row]:
        """Get all quotes for ticker."""
        return self.query("SELECT * FROM quotes WHERE ticker = ? ORDER BY date DESC", (ticker,))

    def get_latest_quote(self, ticker: str) -> Optional[sqlite3.Row]:
        """Get most recent quote for ticker."""
        rows = self.query(
            "SELECT * FROM quotes WHERE ticker = ? ORDER BY date DESC LIMIT 1",
            (ticker,)
        )
        return rows[0] if rows else None

    def get_signals(self, ticker: str, days: int = 30) -> List[sqlite3.Row]:
        """Get recent signals for ticker."""
        return self.query("""
            SELECT * FROM signals
            WHERE ticker = ? AND date >= datetime('now', '-' || ? || ' days')
            ORDER BY date DESC
        """, (ticker, days))

    def get_pending_notifications(self) -> List[sqlite3.Row]:
        """Get all pending notifications."""
        return self.query("""
            SELECT * FROM pending_notifications
            ORDER BY created_at ASC
        """)

    def remove_pending_notification(self, notification_id: int) -> bool:
        """Mark notification as sent by removing from queue."""
        return self.execute(
            "DELETE FROM pending_notifications WHERE id = ?",
            (notification_id,)
        ) > 0

    def update_pending_notification_retry(self, notification_id: int) -> bool:
        """Update retry count and timestamp."""
        return self.execute("""
            UPDATE pending_notifications
            SET retry_count = retry_count + 1, last_retry_at = ?
            WHERE id = ?
        """, (datetime.now().isoformat(), notification_id)) > 0
