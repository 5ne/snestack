import Anthropic from "@anthropic-ai/sdk";
import { BaseAgent } from "./base";
import type { Signal, QuoteData, EquityData, StrategySignal, BatchAnalysisInput } from "../../../core/models";

const CFO_SYSTEM_PROMPT = `You are an expert investment analyst synthesizing multiple signals for investment decisions.

You receive:
- Quote data (current price, technical indicators)
- Strategy signals (RSI, moving average analysis)
- Equity data (PE, debt/equity, FCF, growth rates)

For each investment, provide a recommendation (BUY/SELL/HOLD) and confidence (0-1) based on:
1. Technical momentum (RSI, moving averages)
2. Fundamental value (PE, growth, debt levels)
3. Risk factors (red flags, declining metrics)
4. Your overall investment thesis

Be concise but thorough. Consider both upside potential and downside risk.
Default to HOLD if signals are conflicting or data is insufficient.
Never recommend based on a single metric - synthesize the full picture.`;

export class CfoAgent extends BaseAgent<Signal> {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    super("CfoAgent");
    this.client = new Anthropic({ apiKey });
  }

  async analyze(
    ticker: string,
    quote?: QuoteData | null,
    strategy?: StrategySignal | null,
    equity?: EquityData | null
  ): Promise<Signal | null> {
    try {
      const context = CfoAgent.buildContext(ticker, quote, strategy, equity);
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 300,
        system: CFO_SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text : "";
      const { recommendation, confidence, reasoning } = CfoAgent.parseResponse(text);
      return {
        ticker,
        recommendation,
        confidence,
        reasoning,
        date: new Date(),
        fromWatchlist: false,
        createdAt: new Date(),
      };
    } catch (e) {
      this.logger.error(`CFO synthesis failed for ${ticker}: ${e}`);
      return {
        ticker,
        recommendation: "HOLD",
        confidence: 0.5,
        reasoning: `Error in synthesis: ${e}`,
        date: new Date(),
        fromWatchlist: false,
        createdAt: new Date(),
      };
    }
  }

  /**
   * Batch analyze: one Claude call for all tickers. Returns both the signals and a
   * per-ticker `issues` map — every ticker whose recommendation is a HOLD/50% *fallback*
   * rather than an actual Claude judgment ends up here, so callers (the orchestrator,
   * the email) can surface "this number doesn't mean what it looks like" instead of
   * silently presenting a fallback HOLD as if it were a genuine 50%-confidence call.
   */
  async batchAnalyze(
    items: BatchAnalysisInput[]
  ): Promise<{ signals: Signal[]; issues: Record<string, string> }> {
    try {
      this.logger.debug(`Batch synthesis for ${items.length} tickers`);
      const context = CfoAgent.buildBatchContext(items);
      const response = await this.client.messages.create({
        model: "claude-sonnet-4-6",
        max_tokens: 2000,
        system: CFO_SYSTEM_PROMPT,
        messages: [{ role: "user", content: context }],
      });
      const text = response.content[0].type === "text" ? response.content[0].text : "[]";
      const result = CfoAgent.parseBatchResponse(text, items);
      const issueCount = Object.keys(result.issues).length;
      this.logger.info(
        `Batch synthesis complete: ${result.signals.length} signals` +
          (issueCount ? `, ${issueCount} unparsed (fell back to HOLD/50%)` : "")
      );
      return result;
    } catch (e) {
      this.logger.error(`Batch synthesis failed: ${e}`);
      const issues: Record<string, string> = {};
      const signals = items.map((item) => {
        issues[item.ticker] = `CFO synthesis call failed: ${e}`;
        return {
          ticker: item.ticker,
          recommendation: "HOLD" as const,
          confidence: 0.5,
          reasoning: `Error in batch synthesis: ${e}`,
          date: new Date(),
          fromWatchlist: false,
          createdAt: new Date(),
        };
      });
      return { signals, issues };
    }
  }

  static buildContext(
    ticker: string,
    quote?: QuoteData | null,
    strategy?: StrategySignal | null,
    equity?: EquityData | null
  ): string {
    const lines: string[] = [`Analyze ${ticker} for investment recommendation:\n`];
    if (quote) {
      lines.push("QUOTE DATA:");
      lines.push(`  Price: $${quote.price.toFixed(2)}`);
      if (quote.open) lines.push(`  Open: $${quote.open.toFixed(2)}`);
      if (quote.high && quote.low)
        lines.push(`  Range: $${quote.low.toFixed(2)} - $${quote.high.toFixed(2)}`);
      if (quote.volume) lines.push(`  Volume: ${quote.volume.toLocaleString()}`);
      lines.push("");
    }
    if (strategy) {
      lines.push("TECHNICAL ANALYSIS:");
      lines.push(`  Signal: ${strategy.recommendation}`);
      lines.push(`  Confidence: ${(strategy.confidence * 100).toFixed(0)}%`);
      if (strategy.reasoning) lines.push(`  Detail: ${strategy.reasoning}`);
      lines.push("");
    }
    if (equity) {
      lines.push("FUNDAMENTAL DATA:");
      if (equity.peRatio) lines.push(`  P/E Ratio: ${equity.peRatio.toFixed(1)}`);
      if (equity.pbRatio) lines.push(`  P/B Ratio: ${equity.pbRatio.toFixed(1)}`);
      if (equity.debtToEquity) lines.push(`  Debt/Equity: ${equity.debtToEquity.toFixed(2)}`);
      if (equity.fcf) lines.push(`  Free Cash Flow: $${(equity.fcf / 1e9).toFixed(1)}B`);
      if (equity.fcfYield) lines.push(`  FCF Yield: ${(equity.fcfYield * 100).toFixed(1)}%`);
      if (equity.earningsGrowth != null)
        lines.push(`  Earnings Growth: ${(equity.earningsGrowth * 100).toFixed(1)}%`);
      if (equity.revenueGrowth != null)
        lines.push(`  Revenue Growth: ${(equity.revenueGrowth * 100).toFixed(1)}%`);
      if (equity.redFlags.length) {
        lines.push("  RED FLAGS:");
        equity.redFlags.forEach((f) => lines.push(`    - ${f}`));
      }
      lines.push("");
    }
    lines.push("Provide your recommendation in this format:");
    lines.push("RECOMMENDATION: [BUY|SELL|HOLD]");
    lines.push("CONFIDENCE: [0.0-1.0]");
    lines.push("REASONING: [Brief explanation]");
    return lines.join("\n");
  }

  static buildBatchContext(items: BatchAnalysisInput[]): string {
    const lines: string[] = [
      "Analyze these investments and provide recommendations for each.\n",
    ];
    items.forEach((item, idx) => {
      const { ticker, quote, strategy, equity } = item;
      lines.push(`${idx + 1}. ${ticker.toUpperCase()}`);
      if (quote) lines.push(`   Price: $${quote.price.toFixed(2)}`);
      if (strategy && strategy.confidence > 0) {
        lines.push(
          `   Technical: ${strategy.recommendation} (${(strategy.confidence * 100).toFixed(0)}%)`
        );
        if (strategy.reasoning && strategy.reasoning !== "No technical signals detected")
          lines.push(`   Detail: ${strategy.reasoning}`);
      }
      if (equity) {
        if (equity.fairValue)
          lines.push(
            `   Fair Value: $${equity.fairValue.toFixed(2)}  P/FVE: ${equity.priceToFairValue?.toFixed(2)}`
          );
        if (equity.morningstarRating) {
          const stars = "★".repeat(equity.morningstarRating) + "☆".repeat(5 - equity.morningstarRating);
          lines.push(`   Morningstar: ${stars}  Moat: ${equity.economicMoat ?? "Unknown"}`);
        }
        if (equity.peRatio) lines.push(`   P/E: ${equity.peRatio.toFixed(1)}`);
        if (equity.fcf) lines.push(`   FCF: $${(equity.fcf / 1e9).toFixed(1)}B`);
        if (equity.revenueGrowth != null)
          lines.push(`   Revenue Growth: ${(equity.revenueGrowth * 100).toFixed(1)}%`);
        if (equity.earningsGrowth != null)
          lines.push(`   EPS Growth: ${(equity.earningsGrowth * 100).toFixed(1)}%`);
        if (equity.redFlags.length)
          lines.push(`   RED FLAGS: ${equity.redFlags.join("; ")}`);
      }
      lines.push("");
    });
    lines.push(
      'Return a JSON array, one object per ticker, with keys "ticker", "recommendation" (BUY/SELL/HOLD), ' +
        '"confidence" (0.0-1.0), and "reasoning" (1-2 sentences). No markdown, just the JSON array.'
    );
    return lines.join("\n");
  }

  static parseResponse(
    text: string
  ): { recommendation: Signal["recommendation"]; confidence: number; reasoning: string } {
    let recommendation: Signal["recommendation"] = "HOLD";
    let confidence = 0.5;
    let reasoning = text;

    for (const line of text.split("\n")) {
      if (line.includes("RECOMMENDATION:")) {
        const rec = line.split("RECOMMENDATION:")[1].trim().toUpperCase();
        if (rec === "BUY" || rec === "SELL" || rec === "HOLD") recommendation = rec;
      } else if (line.includes("CONFIDENCE:")) {
        const raw = line.split("CONFIDENCE:")[1].trim().replace("%", "");
        const parsed = parseFloat(raw);
        if (!isNaN(parsed)) {
          confidence = parsed > 1 ? parsed / 100 : parsed;
          confidence = Math.max(0, Math.min(1, confidence));
        }
      } else if (line.includes("REASONING:")) {
        reasoning = line.split("REASONING:")[1].trim();
      }
    }
    return { recommendation, confidence: Math.round(confidence * 100) / 100, reasoning };
  }

  static parseBatchResponse(
    text: string,
    items: BatchAnalysisInput[]
  ): { signals: Signal[]; issues: Record<string, string> } {
    const signals: Signal[] = [];
    const issues: Record<string, string> = {};
    const seen = new Set<string>();

    try {
      let cleaned = text.trim();
      if (cleaned.startsWith("```")) cleaned = cleaned.split("\n").slice(1).join("\n");
      if (cleaned.endsWith("```")) cleaned = cleaned.split("\n").slice(0, -1).join("\n");

      const parsed = JSON.parse(cleaned) as Array<{
        ticker: string;
        recommendation: string;
        confidence: number;
        reasoning: string;
      }>;

      for (const item of parsed) {
        const ticker = (item.ticker ?? "").toUpperCase();
        let rec = (item.recommendation ?? "HOLD").toUpperCase();
        if (!["BUY", "SELL", "HOLD"].includes(rec)) rec = "HOLD";
        let conf = parseFloat(String(item.confidence ?? 0.5));
        if (isNaN(conf)) conf = 0.5;
        conf = Math.max(0, Math.min(1, conf));
        const reasoning = String(item.reasoning ?? "");
        if (ticker) {
          signals.push({
            ticker,
            recommendation: rec as Signal["recommendation"],
            confidence: conf,
            reasoning,
            date: new Date(),
            fromWatchlist: false,
            createdAt: new Date(),
          });
          seen.add(ticker);
        }
      }
    } catch {
      // Whole response wasn't valid JSON — every requested ticker falls through to
      // the "fill missing tickers" loop below and gets flagged as an issue there.
    }

    // Fill missing tickers — either the whole response failed to parse (catch above),
    // or Claude's JSON array simply omitted this ticker. Either way this HOLD/50% is
    // a fallback, not a real judgment, so it's recorded in `issues` too.
    for (const item of items) {
      if (!seen.has(item.ticker)) {
        signals.push({
          ticker: item.ticker,
          recommendation: "HOLD",
          confidence: 0.5,
          reasoning: "No signal parsed from response",
          date: new Date(),
          fromWatchlist: false,
          createdAt: new Date(),
        });
        issues[item.ticker] =
          "CFO did not return a parsed recommendation for this ticker — defaulted to HOLD at 50% confidence";
      }
    }

    return { signals, issues };
  }
}
