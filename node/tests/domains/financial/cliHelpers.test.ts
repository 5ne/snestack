import { resolveTickerUniverse } from "../../../src/domains/financial/cliHelpers";
import type { Db } from "../../../src/core/db";

function makeDb(positions: Array<{ ticker: string }>, watchlist: Array<{ ticker: string }>): Db {
  return {
    getAllPositions: () => positions,
    getWatchlist: () => watchlist,
  } as unknown as Db;
}

describe("resolveTickerUniverse", () => {
  it("unions positions and watchlist tickers, deduped", async () => {
    const db = makeDb([{ ticker: "NVDA" }, { ticker: "AAPL" }], [{ ticker: "AAPL" }, { ticker: "TSLA" }]);
    expect((await resolveTickerUniverse(db)).sort()).toEqual(["AAPL", "NVDA", "TSLA"]);
  });

  it("returns an empty array when both are empty", async () => {
    const db = makeDb([], []);
    expect(await resolveTickerUniverse(db)).toEqual([]);
  });

  it("an explicit --tickers flag overrides positions/watchlist entirely", async () => {
    const db = makeDb([{ ticker: "NVDA" }], [{ ticker: "AAPL" }]);
    expect((await resolveTickerUniverse(db, "msft,goog")).sort()).toEqual(["GOOG", "MSFT"]);
  });

  it("uppercases, trims, and dedupes an explicit --tickers flag", async () => {
    const db = makeDb([], []);
    expect((await resolveTickerUniverse(db, " nvda, NVDA ,aapl,")).sort()).toEqual(["AAPL", "NVDA"]);
  });
});
