import type { Config } from "../../../src/core/config";
import type { Db } from "../../../src/core/db";

const quoteBatchAnalyze = jest.fn().mockResolvedValue({});
const equityBatchAnalyze = jest.fn().mockResolvedValue({});

jest.mock("../../../src/domains/financial/agents/quoteAgent", () => ({
  QuoteAgent: jest.fn().mockImplementation(() => ({ batchAnalyze: quoteBatchAnalyze })),
}));
jest.mock("../../../src/domains/financial/agents/equityAgent", () => ({
  EquityAgent: jest.fn().mockImplementation(() => ({ batchAnalyze: equityBatchAnalyze })),
}));

// Imported after the mocks above so dataRefresh.ts picks up the mocked classes.
import { runDataRefresh } from "../../../src/domains/financial/dataRefresh";
import { QuoteAgent } from "../../../src/domains/financial/agents/quoteAgent";
import { EquityAgent } from "../../../src/domains/financial/agents/equityAgent";

function makeConfig(): Config {
  return { getFinnhubApiKey: () => "fake-key" } as unknown as Config;
}

function makeDb(positions: Array<{ ticker: string }> = [], watchlist: Array<{ ticker: string }> = []): Db {
  return {
    getAllPositions: () => positions,
    getWatchlist: () => watchlist,
  } as unknown as Db;
}

describe("runDataRefresh", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    quoteBatchAnalyze.mockResolvedValue({});
    equityBatchAnalyze.mockResolvedValue({});
  });

  it("intraday tier calls QuoteAgent.batchAnalyze with skipFundamentals: true, never touches EquityAgent", async () => {
    const db = makeDb([{ ticker: "NVDA" }]);
    await runDataRefresh("intraday", undefined, { config: makeConfig(), db });

    expect(QuoteAgent).toHaveBeenCalledTimes(1);
    expect(quoteBatchAnalyze).toHaveBeenCalledWith(["NVDA"], { skipFundamentals: true });
    expect(EquityAgent).not.toHaveBeenCalled();
  });

  it("daily tier calls QuoteAgent.batchAnalyze with skipFundamentals: false, never touches EquityAgent", async () => {
    const db = makeDb([{ ticker: "NVDA" }]);
    await runDataRefresh("daily", undefined, { config: makeConfig(), db });

    expect(QuoteAgent).toHaveBeenCalledTimes(1);
    expect(quoteBatchAnalyze).toHaveBeenCalledWith(["NVDA"], { skipFundamentals: false });
    expect(EquityAgent).not.toHaveBeenCalled();
  });

  it("weekly tier calls EquityAgent.batchAnalyze, never touches QuoteAgent", async () => {
    const db = makeDb([{ ticker: "NVDA" }]);
    await runDataRefresh("weekly", undefined, { config: makeConfig(), db });

    expect(EquityAgent).toHaveBeenCalledTimes(1);
    expect(equityBatchAnalyze).toHaveBeenCalledWith(["NVDA"]);
    expect(QuoteAgent).not.toHaveBeenCalled();
  });

  it("respects an explicit --tickers list over positions/watchlist", async () => {
    const db = makeDb([{ ticker: "NVDA" }]);
    await runDataRefresh("intraday", "aapl,msft", { config: makeConfig(), db });

    expect(quoteBatchAnalyze).toHaveBeenCalledWith(["AAPL", "MSFT"], { skipFundamentals: true });
  });

  it("calls no agent and returns an empty ticker list when there's nothing to refresh", async () => {
    const db = makeDb([], []);
    const result = await runDataRefresh("daily", undefined, { config: makeConfig(), db });

    expect(result.tickers).toEqual([]);
    expect(QuoteAgent).not.toHaveBeenCalled();
    expect(EquityAgent).not.toHaveBeenCalled();
  });
});
