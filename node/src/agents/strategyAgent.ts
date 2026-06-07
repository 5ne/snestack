import { BaseAgent } from "./base";
import type { StrategySignal, Recommendation } from "../core/models";
import type { Db, QuoteRow } from "../core/db";

export class StrategyAgent extends BaseAgent<StrategySignal> {
  private readonly db: Db;

  constructor(db: Db) {
    super("StrategyAgent");
    this.db = db;
  }

  async analyze(ticker: string): Promise<StrategySignal> {
    try {
      const quote = this.db.getLatestQuote(ticker);
      if (!quote) {
        return this.holdSignal(ticker, "No quote data available");
      }

      const { rsi, ma_50: ma50, ma_200: ma200, close, volume } = quote;
      const signals: Array<{ rec: Recommendation; weight: number }> = [];
      const reasonParts: string[] = [`${ticker} technical analysis:`];

      // RSI signal
      if (rsi != null) {
        const rsiResult = StrategyAgent.rsiSignal(rsi);
        if (rsiResult) signals.push(rsiResult);
        if (rsi < 30) reasonParts.push(`RSI ${rsi.toFixed(0)} (oversold)`);
        else if (rsi > 70) reasonParts.push(`RSI ${rsi.toFixed(0)} (overbought)`);
        else reasonParts.push(`RSI ${rsi.toFixed(0)} (neutral)`);
      }

      // MA crossover signal
      if (ma50 != null && ma200 != null && close != null) {
        const maResult = StrategyAgent.maSignal(close, ma50, ma200);
        if (maResult) signals.push(maResult);
        if (ma50 > ma200) reasonParts.push("Golden cross: 50MA > 200MA");
        else if (ma50 < ma200) reasonParts.push("Death cross: 50MA < 200MA");
        if (close > ma50)
          reasonParts.push(`Price $${close.toFixed(2)} above 50MA $${ma50.toFixed(2)}`);
        else
          reasonParts.push(`Price $${close.toFixed(2)} below 50MA $${ma50.toFixed(2)}`);
      }

      // Volume confirmation
      if (volume != null) {
        const volBoost = this.volumeBoost(ticker, volume);
        if (volBoost) signals.push(volBoost);
      }

      if (signals.length === 0) {
        return this.holdSignal(ticker, "No technical signals detected");
      }

      const recommendation = StrategyAgent.weightedConsensus(signals);
      const confidence =
        signals.reduce((sum, s) => sum + s.weight, 0) / signals.length;

      return {
        ticker,
        recommendation,
        confidence: Math.round(confidence * 100) / 100,
        reasoning: reasonParts.join(" | "),
        timestamp: new Date(),
      };
    } catch (e) {
      this.logger.error(`Strategy analysis failed for ${ticker}: ${e}`);
      return this.holdSignal(ticker, `Analysis error: ${e}`);
    }
  }

  private holdSignal(ticker: string, reason: string): StrategySignal {
    return {
      ticker,
      recommendation: "HOLD",
      confidence: 0,
      reasoning: reason,
      timestamp: new Date(),
    };
  }

  /** RSI-based signal. */
  static rsiSignal(
    rsi: number
  ): { rec: Recommendation; weight: number } | null {
    if (rsi < 30) return { rec: "BUY", weight: 0.8 };
    if (rsi > 70) return { rec: "SELL", weight: 0.6 };
    if (rsi < 40) return { rec: "BUY", weight: 0.4 };
    if (rsi > 60) return { rec: "SELL", weight: 0.3 };
    return null;
  }

  /** Moving-average crossover signal. */
  static maSignal(
    price: number,
    ma50: number,
    ma200: number
  ): { rec: Recommendation; weight: number } | null {
    if (ma50 > ma200) {
      if (price > ma50) return { rec: "BUY", weight: 0.7 };
      if (price > ma200) return { rec: "BUY", weight: 0.5 };
    } else if (ma50 < ma200) {
      if (price < ma50) return { rec: "SELL", weight: 0.7 };
      if (price < ma200) return { rec: "SELL", weight: 0.5 };
    }
    return null;
  }

  /** Volume confirmation: boosts existing signal confidence. */
  private volumeBoost(
    ticker: string,
    currentVolume: number
  ): { rec: Recommendation; weight: number } | null {
    const quotes = this.db.getQuotes(ticker, 20);
    if (quotes.length < 20) return null;
    const avgVolume =
      quotes.reduce((sum, q) => sum + (q.volume ?? 0), 0) / quotes.length;
    if (avgVolume === 0) return null;
    if (currentVolume > avgVolume * 1.5) {
      // High volume — adds small confidence boost (direction neutral)
      return { rec: "BUY", weight: 0.15 };
    }
    return null;
  }

  /** Weighted consensus across collected signals. */
  static weightedConsensus(
    signals: Array<{ rec: Recommendation; weight: number }>
  ): Recommendation {
    if (signals.length === 0) return "HOLD";
    const totalWeight = signals.reduce((s, x) => s + x.weight, 0);
    if (totalWeight === 0) return "HOLD";
    const buyWeight = signals.filter((s) => s.rec === "BUY").reduce((s, x) => s + x.weight, 0);
    const sellWeight = signals.filter((s) => s.rec === "SELL").reduce((s, x) => s + x.weight, 0);
    const buyRatio = buyWeight / totalWeight;
    const sellRatio = sellWeight / totalWeight;
    if (buyRatio > sellRatio && buyRatio > 0.4) return "BUY";
    if (sellRatio > buyRatio && sellRatio > 0.4) return "SELL";
    return "HOLD";
  }

  async batchAnalyze(
    tickers: string[]
  ): Promise<Record<string, StrategySignal | null>> {
    const results = await Promise.all(tickers.map((t) => this.safeAnalyze(t)));
    return Object.fromEntries(tickers.map((t, i) => [t, results[i]]));
  }
}
