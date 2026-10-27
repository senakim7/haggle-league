import { drawLimits } from "@haggle/engine";
import { describe, expect, it } from "vitest";
import { devScenarios } from "../src/index";

describe("devScenarios", () => {
  it("has 10 scenarios with unique ids", () => {
    expect(devScenarios).toHaveLength(10);
    expect(new Set(devScenarios.map((s) => s.id)).size).toBe(devScenarios.length);
  });

  it.each(devScenarios.map((s) => [s.id, s] as const))("%s draws usable limits", (_id, scenario) => {
    const width = scenario.marketHigh - scenario.marketLow;
    for (let seed = 0; seed < 500; seed++) {
      const { sellerFloor, buyerCeiling } = drawLimits(scenario, seed);
      expect(buyerCeiling - sellerFloor).toBeGreaterThanOrEqual(scenario.limitRule.minGapRatio * width);
      expect(sellerFloor % scenario.limitRule.roundTo).toBe(0);
      expect(buyerCeiling % scenario.limitRule.roundTo).toBe(0);
    }
  });
});
