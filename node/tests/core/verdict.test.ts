import { parseVerdict } from "../../src/core/verdict";

describe("parseVerdict", () => {
  it("parses a well-formed final line", () => {
    expect(parseVerdict("Some write-up.\n\nVERDICT: HOLD | 0.65 | Thesis intact but RSI 54 gives no add trigger.")).toEqual({
      label: "HOLD",
      confidence: 0.65,
      reasoning: "Thesis intact but RSI 54 gives no add trigger.",
    });
  });
  it("takes the last verdict line when several appear", () => {
    expect(parseVerdict("VERDICT: BUY | 0.9 | first\ntext\nVERDICT: SELL | 0.4 | second")?.label).toBe("SELL");
  });
  it("tolerates bold markers and lowercase labels", () => {
    expect(parseVerdict("**VERDICT:** buy | 0.7 | oversold **")?.label).toBe("BUY");
  });
  it("accepts a bare decimal and a trailing newline", () => {
    expect(parseVerdict("VERDICT: NONE | .5 | not eligible\n")?.confidence).toBe(0.5);
  });
  it("returns null when absent or malformed", () => {
    expect(parseVerdict("no verdict here")).toBeNull();
    expect(parseVerdict("VERDICT: HOLD | high | text")).toBeNull();
    expect(parseVerdict("VERDICT: HOLD | 1.5 | confidence out of range")).toBeNull();
    expect(parseVerdict("VERDICT: HOLD")).toBeNull();
  });
});
