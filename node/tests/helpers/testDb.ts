import { newDb } from "pg-mem";
import { Db } from "../../src/core/db";

/** A fresh, isolated in-memory Postgres (pg-mem) wrapped in the real Db — no network, no files. */
export async function openTestDb(): Promise<Db> {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  return Db.open(undefined, { pool: new Pool(), enableRls: false });
}

/**
 * Make code under test that calls `Db.open(...)` itself get this already-seeded db.
 * `close()` is a no-op for the duration (the code under test closes what it opens);
 * call the returned `release()` in afterEach to close it for real and restore `Db.open`.
 */
export function shareDb(db: Db): () => Promise<void> {
  const realClose = db.close.bind(db);
  db.close = async () => undefined;
  const spy = jest.spyOn(Db, "open").mockResolvedValue(db);
  return async () => {
    spy.mockRestore();
    await realClose();
  };
}
