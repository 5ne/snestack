import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { DatabaseSync } from "node:sqlite";
import { migrateSqliteToPostgres, formatMigrationReport } from "../../src/core/dbMigrate";
import { openTestDb } from "../helpers/testDb";
import type { Db } from "../../src/core/db";

// pg-mem has no setval(); the sequence reset is asserted separately below.
const NO_SEQ = { resetSequences: false };

describe("migrateSqliteToPostgres", () => {
  let tmp: string;
  let sqlitePath: string;
  let db: Db;

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "snestack-migrate-"));
    sqlitePath = path.join(tmp, "snestack.db");
    const s = new DatabaseSync(sqlitePath);
    s.exec(`
      CREATE TABLE tickers (symbol TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, sector TEXT, added_date TEXT NOT NULL, notes TEXT);
      CREATE TABLE positions (ticker TEXT PRIMARY KEY, shares REAL NOT NULL, cost_basis REAL NOT NULL, entry_date TEXT NOT NULL, notes TEXT, strategy TEXT NOT NULL DEFAULT 'long-term');
      CREATE TABLE quotes (ticker TEXT NOT NULL, date TEXT NOT NULL, open REAL, high REAL, low REAL, close REAL, volume INTEGER, rsi REAL, ma_50 REAL, ma_200 REAL, fetched_at TEXT, PRIMARY KEY (ticker, date));
      CREATE TABLE signals (id INTEGER PRIMARY KEY AUTOINCREMENT, ticker TEXT NOT NULL, date TEXT NOT NULL, recommendation TEXT NOT NULL, confidence REAL NOT NULL, reasoning TEXT NOT NULL, from_watchlist INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
      INSERT INTO tickers VALUES ('NVDA','NVIDIA','PUBLIC',NULL,'2026-01-01',NULL);
      INSERT INTO positions VALUES ('NVDA',10,100,'2026-01-01',NULL,'swing');
      INSERT INTO quotes VALUES ('NVDA','2026-10-01',1,2,0.5,1.5,1000,55,1,1,'2026-10-01T00:00:00Z');
      INSERT INTO signals VALUES (7,'NVDA','2026-10-01','BUY',0.8,'[Swing] x',0,'2026-10-01T00:00:00Z');
    `);
    s.close();
    db = await openTestDb();
  });

  afterEach(async () => {
    await db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("copies every table, preserves ids, and verifies row counts", async () => {
    const reports = await migrateSqliteToPostgres(sqlitePath, db, NO_SEQ);
    expect(reports.every((r) => r.ok)).toBe(true);
    expect(reports.find((r) => r.table === "signals")).toMatchObject({ sqliteRows: 1, inserted: 1, postgresRowsAfter: 1 });
    expect((await db.getPosition("NVDA"))?.strategy).toBe("swing");
    expect((await db.getSignalById(7))?.reasoning).toBe("[Swing] x");
    expect(formatMigrationReport(reports, false)).toContain("Row counts verified.");
  });

  it("is safe to re-run — existing rows are skipped, not duplicated", async () => {
    await migrateSqliteToPostgres(sqlitePath, db, NO_SEQ);
    const again = await migrateSqliteToPostgres(sqlitePath, db, NO_SEQ);
    expect(again.every((r) => r.ok && r.inserted === 0)).toBe(true);
  });

  it("dry run writes nothing", async () => {
    const reports = await migrateSqliteToPostgres(sqlitePath, db, { ...NO_SEQ, dryRun: true });
    expect(reports.find((r) => r.table === "tickers")).toMatchObject({ sqliteRows: 1, postgresRowsAfter: 0 });
    expect(await db.getAllPositions()).toEqual([]);
  });

  it("never modifies the SQLite file", async () => {
    const before = fs.readFileSync(sqlitePath);
    await migrateSqliteToPostgres(sqlitePath, db, NO_SEQ);
    expect(fs.readFileSync(sqlitePath).equals(before)).toBe(true);
  });

  it("moves the signals id sequence past the imported ids so new signals don't collide", async () => {
    const spy = jest.spyOn(db, "query");
    // pg-mem can't run setval; let every other statement through and record the setval call.
    spy.mockImplementation(async (text: string, values?: unknown[]) => {
      if (text.includes("setval")) return [];
      return jest.requireActual("../../src/core/db").Db.prototype.query.call(db, text, values);
    });
    await migrateSqliteToPostgres(sqlitePath, db);
    expect(spy.mock.calls.some(([t]) => /setval\('signals_id_seq'/.test(t as string))).toBe(true);
  });
});
