import { resolveTickerUniverse } from "../../../src/domains/financial/cliHelpers";
import type { Db } from "../../../src/core/db";

function makeDb(positions: Array<{ ticker: string }>, watchlist: Array<{ ticker: string }>): Db {
  return {
    getAllPositions: () => positions,
    getWatchlist: () => watchlist,
  } as unknown as Db;
}

describe("resolveTickerUniverse", () => {
  it("unions positions and watchlist tickers, deduped", () => {
    const db = makeDb([{ ticker: "NVDA" }, { ticker: "AAPL" }], [{ ticker: "AAPL" }, { ticker: "TSLA" }]);
    expect(resolveTickerUniverse(db).sort()).toEqual(["AAPL", "NVDA", "TSLA"]);
  });

  it("returns an empty array when both are empty", () => {
    const db = makeDb([], []);
    expect(resolveTickerUniverse(db)).toEqual([]);
  });

  it("an explicit --tickers flag overrides positions/watchlist entirely", () => {
    const db = makeDb([{ ticker: "NVDA" }], [{ ticker: "AAPL" }]);
    expect(resolveTickerUniverse(db, "msft,goog").sort()).toEqual(["GOOG", "MSFT"]);
  });

  it("uppercases, trims, and dedupes an explicit --tickers flag", () => {
    const db = makeDb([], []);
    expect(resolveTickerUniverse(db, " nvda, NVDA ,aapl,").sort()).toEqual(["AAPL", "NVDA"]);
  });
});
