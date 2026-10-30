// One-time import of the legacy SQLite file (node:sqlite is built into Node 22+) into the Postgres Db.
// The SQLite file is only ever opened read-only and is left untouched as the backup.
import { DatabaseSync } from "node:sqlite";
import * as fs from "fs";
import { Db } from "./db";
import { DatabaseError } from "./errors";

// Parents before children (foreign keys).
const TABLES = ["tickers", "positions", "watchlist", "quotes", "fundamentals", "signals"] as const;
type Table = (typeof TABLES)[number];

export interface MigrationReport {
  table: Table;
  sqliteRows: number;
  postgresRowsBefore: number;
  inserted: number;
  postgresRowsAfter: number;
  /** True when every SQLite row is now present in Postgres. */
  ok: boolean;
}

export async function migrateSqliteToPostgres(
  sqlitePath: string,
  db: Db,
  opts: { dryRun?: boolean; resetSequences?: boolean } = {}
): Promise<MigrationReport[]> {
  if (!fs.existsSync(sqlitePath)) throw new DatabaseError(`No SQLite file at ${sqlitePath}`);
  const src = new DatabaseSync(sqlitePath, { readOnly: true });
  const reports: MigrationReport[] = [];
  try {
    for (const table of TABLES) {
      const exists = src.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
      const rows = (exists ? src.prepare(`SELECT * FROM ${table}`).all() : []) as unknown as Record<string, unknown>[];
      const before = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0].n);
      let inserted = 0;
      if (!opts.dryRun) {
        for (const row of rows) {
          const cols = Object.keys(row);
          const res = await db.query(
            `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})
             ON CONFLICT DO NOTHING RETURNING 1`,
            cols.map((c) => row[c] ?? null)
          );
          inserted += res.length;
        }
        if (table === "signals" && rows.length > 0 && (opts.resetSequences ?? true)) {
          // Rows were inserted with their original ids; move the sequence past them.
          await db.query("SELECT setval('signals_id_seq', (SELECT max(id) FROM signals))");
        }
      }
      const after = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0].n);
      reports.push({
        table,
        sqliteRows: rows.length,
        postgresRowsBefore: before,
        inserted,
        postgresRowsAfter: after,
        ok: opts.dryRun ? true : after >= rows.length,
      });
    }
  } finally {
    src.close();
  }
  return reports;
}

export function formatMigrationReport(reports: MigrationReport[], dryRun: boolean): string {
  const lines = reports.map(
    (r) =>
      `${r.ok ? "ok  " : "FAIL"} ${r.table.padEnd(13)} sqlite=${r.sqliteRows} postgres: ${r.postgresRowsBefore} -> ${r.postgresRowsAfter} (+${r.inserted})`
  );
  lines.push(dryRun ? "Dry run: nothing was written." : reports.every((r) => r.ok) ? "Row counts verified." : "ROW COUNTS DO NOT MATCH — do not cut over.");
  return lines.join("\n");
}
