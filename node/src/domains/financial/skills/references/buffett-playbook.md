---
name: buffett-playbook
domain: financial
type: reference
---

# Warren Buffett Long-Term Playbook

Distilled from the two foundational texts on Warren Buffett's investment framework:
1. ***The Essays of Warren Buffett: Lessons for Corporate America*** (compiled by Lawrence A. Cunningham) — Buffett's own Berkshire Hathaway shareholder letters organized by investment, governance, accounting, and valuation tenets.
2. ***The Warren Buffett Way*** (by Robert G. Hagstrom) — the twelve business, management, financial, and market tenets blending Benjamin Graham's *margin of safety* and *Mr. Market* (*The Intelligent Investor*, Ch. 8 & 20) with Philip Fisher's focus on durable compounders.

All numeric thresholds live in `references/quality-bar.md` under `## Buffett value bar (buffett-value.md)` (never hardcode cutoffs in prose reasoning — read `quality-bar` fresh on every run). Referenced by the standalone third strategy `buffett-value.md` (`[Buffett]`), which runs independently alongside `long-term-quality.md` (`[Long-term]`) and `swing-trading-large-cap.md` (`[Swing]`).

---

## 1. Business Tenets — Circle of Competence & Economic Moat

- **Stock as fractional business ownership:** Evaluate every position and watchlist name as if buying the whole business to hold for 5–10+ years, never as a short-term trading sardine.
- **Circle of Competence (`BRAIN` thesis):** The owner's recorded thesis in `brain/investing/public/companies/{TICKER}.md` defines *why* this business is understandable and worth owning. If no thesis is recorded (missing file or placeholder section), state that explicitly and temper conviction — you cannot confirm an intact thesis when none is on file.
- **The Castle and the Moat (`economicMoat`, `fcfMargin`, `revenueGrowth`):** A truly great business has an enduring competitive advantage — network effects, high switching costs, intangible brand/ecosystem assets, or structural cost scale — that protects returns on capital and pricing power. Care less about static size and more about *moat direction*: is competitive advantage widening, holding steady, or being eroded by a structural shift?

## 2. Financial Tenets — Owner Earnings & Fortress Balance Sheet

- **Owner Earnings over GAAP Optics (`fcf`, `fcfMargin`, `fcfYield` vs. `earningsGrowth`, `peRatio`):** In the 1986 Berkshire letter (*Essays*), Buffett defines *owner earnings* as operating cash left after the capital expenditures needed to maintain the business's long-term competitive position and unit volume. Use `fcf`, `fcfMargin`, and `fcfYield` as the primary check on whether accounting `earningsGrowth` is turning into real, distributable cash rather than being consumed by heavy capex or dilution.
- **Cross-Source Honesty (`QUOTE` Finnhub vs. `FUNDAMENTALS` Morningstar):** Finnhub and Morningstar remain intentionally separate sources. When shared metrics (`peRatio`, `revenueGrowth`, `earningsGrowth`, `fcfYield`) diverge sharply, note the discrepancy (often trailing-twelve-month vs. prior fiscal-year PDF snapshot) rather than silently averaging them.
- **Conservative Leverage (`debtToEquity`):** Wonderful businesses produce strong cash returns on equity *without* heavy debt. Check `debtToEquity` against `quality-bar` — high leverage turns an ordinary industry slump into permanent impairment of owner capital.

## 3. Management Tenets — Capital Allocation

- **The 10-Year Retained-Earnings Test (`capitalAllocation`):** Over a decade, a CEO who retains 10% of net worth annually deploys over 60% of all capital at work in the company. Weigh Morningstar's `capitalAllocation` rating (`Exemplary`, `Standard`, `Poor`) heavily:
  - `Exemplary`: compounds retained cash in high-return organic opportunities or opportunistic buybacks; reinforces long-term `HOLD` / `BUY` conviction.
  - `Poor`: value-destructive M&A, empire-building, or buying back overvalued shares; treat as a serious structural headwind even if near-term revenue looks fine.

## 4. Market Tenets — Intrinsic Value, Margin of Safety & Mr. Market

- **Wonderful Business at a Fair Price (`priceToFairValue`, `fairValue`, `morningstarRating`, `uncertainty`):**
  - *Price is what you pay; intrinsic value is what you get.*
  - Scale your required **margin of safety** on new `BUY` (add) calls to business predictability (`uncertainty` and `economicMoat`), using the guideposts in `quality-bar`: a predictable `Wide`-moat compounder at a fair price is far superior to a no-moat business at a steep statistical discount, whereas `High` or `Very High` uncertainty demands a meaningful discount to `fairValue` to cushion estimation error.
- **Mr. Market is Your Servant, Never Your Master (`rsi`, `ma50`, `ma200`):**
  - Daily quotes and RSI reflect Mr. Market's mood swings, not business value.
  - An oversold `rsi` (below `quality-bar`'s long-term add threshold) is an invitation to `BUY` *only after* thesis, moat, owner-earnings, balance-sheet, and valuation/margin-of-safety checks pass. Falling prices on a broken thesis or a 2x-fair-value bubble are not margin of safety.
  - An overbought `rsi` or modest premium to `fairValue` on an intact compounder is a reason to `HOLD` patiently (pause new buys), **not** to `SELL`.
- **Inactivity & Exit Discipline ("Lethargy Bordering on Sloth"):**
  - Interrupt long-term compounding (`TRIM` / `SELL`) only when:
    1. **Thesis or moat break:** durable competitive advantage is eroding, multi-quarter owner-earnings/revenue decline is structural rather than cyclical, or `capitalAllocation` has turned destructive.
    2. **Extreme valuation detachment:** market price discounts so many years of flawless execution (well past `quality-bar`'s extreme-premium guardrail) that prospective long-term owner returns are compressed even if the business performs well.
