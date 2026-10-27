import { type AgentView, runBout } from "@haggle/engine";
import { devScenarios } from "@haggle/scenarios";
import { TurnOutput } from "@haggle/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createHouseBot, type HouseBotKind } from "../src/index";

const KINDS: HouseBotKind[] = ["holdout", "conceder", "mirror"];

describe("house bots", () => {
  it("never break the output schema or their own limit, so they never forfeit", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...devScenarios),
        fc.constantFrom(...KINDS),
        fc.constantFrom(...KINDS),
        fc.integer({ min: 0, max: 2 ** 32 - 1 }),
        async (scenario, a, b, seed) => {
          const outputs: unknown[] = [];
          const watch = (kind: HouseBotKind) => (view: AgentView) => {
            const out = createHouseBot(kind)(view);
            outputs.push(out);
            return out;
          };
          const bout = await runBout({ scenario, seed, a: watch(a), b: watch(b) });
          for (const out of outputs) expect(TurnOutput.safeParse(out).success).toBe(true);
          for (const match of [bout.first, bout.second]) {
            expect(match.outcome).not.toBe("forfeit");
            expect(match.turns.every((t) => t.valid && t.retries === 0)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("holdout concedes less early than conceder", () => {
    const view: AgentView = {
      role: "seller",
      scenario: devScenarios[0]!,
      myLimit: 560_000,
      turnNo: 5,
      maxTurns: 12,
      history: [],
    };
    const price = (kind: HouseBotKind) => {
      const out = createHouseBot(kind)(view) as TurnOutput;
      return out.action.type === "offer" ? out.action.price : Number.NaN;
    };
    expect(price("holdout")).toBeGreaterThan(price("conceder"));
  });
});
