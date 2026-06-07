import * as os from "os";
import * as path from "path";
import { Db } from "../src/core/db";
import { makeBatchResult } from "../src/core/models";

function tmpDb(): Db {
  return new Db(
    path.join(os.tmpdir(), `fstack-orch-${Date.now()}-${Math.random()}.db`)
  );
}

// We test the orchestrator logic by testing makeBatchResult and the DB/agent
// integration points. Full orchestrator tests would require mocked API keys.

describe("makeBatchResult", () => {
  it("returns empty result for no signals", () => {
    const start = new Date();
    const result = makeBatchResult([], {}, start, new Date());
    expect(result.successCount).toBe(0);
    expect(result.errorCount).toBe(0);
    expect(result.signals).toHaveLength(0);
  });

  it("counts errors correctly", () => {
    const start = new Date();
    const result = makeBatchResult(
      [],
      { NVDA: "Quote failed", AAPL: "Equity failed" },
      start,
      new Date()
    );
    expect(result.errorCount).toBe(2);
  });

  it("includes duration in seconds", () => {
    const start = new Date(0);
    const end = new Date(3000);
    const result = makeBatchResult([], {}, start, end);
    expect(result.durationSeconds).toBe(3);
  });
});

describe("Orchestrator DB integration", () => {
  let db: Db;

  beforeEach(() => {
    db = tmpDb();
  });

  afterEach(() => {
    db.close();
  });

  it("getAllPositions + getWatchlist return empty arrays on fresh DB", () => {
    expect(db.getAllPositions()).toHaveLength(0);
    expect(db.getWatchlist()).toHaveLength(0);
  });

  it("full position+watchlist+signal flow", () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    db.addTicker("TSLA", "Tesla", "PUBLIC");
    db.addPosition("NVDA", 100, 850);
    db.addWatchlist("TSLA", "Waiting for entry");

    const positions = db.getAllPositions();
    const watchlist = db.getWatchlist();
    expect(positions).toHaveLength(1);
    expect(watchlist).toHaveLength(1);

    const positionTickers = positions.map((p) => p.ticker);
    const watchlistTickers = watchlist.map((w) => w.ticker);
    const allTickers = [...positionTickers, ...watchlistTickers];
    expect(allTickers).toContain("NVDA");
    expect(allTickers).toContain("TSLA");
  });

  it("signals are stored and retrievable", () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    const id = db.addSignal(
      "NVDA",
      new Date().toISOString(),
      "BUY",
      0.85,
      "Strong fundamentals",
      false
    );
    const sig = db.getSignalById(id);
    expect(sig?.recommendation).toBe("BUY");
    expect(sig?.confidence).toBe(0.85);
  });

  it("pending notifications flow", () => {
    db.addTicker("NVDA", "NVIDIA", "PUBLIC");
    const signalId = db.addSignal(
      "NVDA",
      new Date().toISOString(),
      "HOLD",
      0.5,
      "Neutral",
      false
    );
    db.addPendingNotification("NVDA", signalId, "user@test.com", null, "email");

    const pending = db.getPendingNotifications();
    expect(pending).toHaveLength(1);

    db.updatePendingNotificationRetry(pending[0].id);
    const updated = db.getPendingNotifications();
    expect(updated[0].retry_count).toBe(1);

    db.removePendingNotification(pending[0].id);
    expect(db.getPendingNotifications()).toHaveLength(0);
  });
});
