import type { Scenario } from "@haggle/schema";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Agent, DEFAULT_MATCH_CONFIG, drawLimits, type Limits, runBout, runMatch } from "../src/index";
import { ipad, turn } from "./fixtures";

// 1주차 완료 기준: 무작위 행동 10만 개 이상에서 한도 밖 거래 0건
const MATCH_RUNS = Number(process.env.FC_MATCH_RUNS ?? 30_000);

const limitsArb: fc.Arbitrary<Limits> = fc
  .record({ sellerFloor: fc.integer({ min: 1_000, max: 2_000_000 }), gap: fc.integer({ min: 1, max: 1_000_000 }) })
  .map(({ sellerFloor, gap }) => ({ sellerFloor, buyerCeiling: sellerFloor + gap }));

// 한도 근처 가격을 자주 만들어 경계값을 집중적으로 찌른다.
function priceArb(limits: Limits) {
  const { sellerFloor: s, buyerCeiling: b } = limits;
  return fc.oneof(
    fc.constantFrom(s - 1, s, s + 1, b - 1, b, b + 1).filter((p) => p > 0),
    fc.integer({ min: 1, max: b * 2 }),
    fc.integer({ min: s, max: b }),
  );
}

// 형식이 맞는 행동과 깨진 출력을 섞은 에이전트 출력
function outputArb(limits: Limits) {
  return fc.oneof(
    { weight: 6, arbitrary: priceArb(limits).map((price) => turn({ type: "offer", price })) },
    { weight: 2, arbitrary: fc.constant(turn({ type: "accept" })) },
    { weight: 1, arbitrary: fc.constant(turn({ type: "walk_away" })) },
    {
      weight: 1,
      arbitrary: fc.oneof(
        fc.anything(),
        fc.constant(turn({ type: "offer", price: 1.5 })),
        fc.constant({ message: "가".repeat(151), privateNote: "", action: { type: "accept" } }),
      ),
    },
  );
}

const MAX_OUTPUTS = DEFAULT_MATCH_CONFIG.maxTurns * 2;

const matchCaseArb = limitsArb.chain((limits) =>
  fc.record({
    limits: fc.constant(limits),
    sellerOutputs: fc.array(outputArb(limits), { minLength: MAX_OUTPUTS, maxLength: MAX_OUTPUTS }),
    buyerOutputs: fc.array(outputArb(limits), { minLength: MAX_OUTPUTS, maxLength: MAX_OUTPUTS }),
  }),
);

describe("engine properties", () => {
  it("never closes a deal outside the limits and always scores by the rules", async () => {
    let agentCalls = 0;
    // fast-check가 축소(shrink)할 때 같은 배열을 다시 쓰므로 배열을 바꾸지 않고 순번으로 읽는다.
    const replay = (outputs: unknown[]): Agent => {
      let i = 0;
      return () => {
        agentCalls++;
        return outputs[i++];
      };
    };

    await fc.assert(
      fc.asyncProperty(matchCaseArb, async ({ limits, sellerOutputs, buyerOutputs }) => {
        const { sellerFloor: s, buyerCeiling: b } = limits;
        const r = await runMatch({ scenario: ipad, limits, seller: replay(sellerOutputs), buyer: replay(buyerOutputs) });

        expect(r.turns.length).toBeLessThanOrEqual(DEFAULT_MATCH_CONFIG.maxTurns);
        r.turns.forEach((t, i) => {
          expect(t.turnNo).toBe(i + 1);
          expect(t.side).toBe(i % 2 === 0 ? "seller" : "buyer");
          if (t.valid && t.action?.type === "offer") {
            if (t.side === "seller") expect(t.action.price).toBeGreaterThanOrEqual(s);
            else expect(t.action.price).toBeLessThanOrEqual(b);
          }
        });
        expect(r.turns.slice(0, -1).every((t) => t.valid)).toBe(true);
        expect(r.sellerScore).toBeGreaterThanOrEqual(0);
        expect(r.buyerScore).toBeGreaterThanOrEqual(0);

        const last = r.turns.at(-1)!;
        switch (r.outcome) {
          case "deal":
            expect(r.finalPrice).not.toBeNull();
            expect(r.finalPrice!).toBeGreaterThanOrEqual(s);
            expect(r.finalPrice!).toBeLessThanOrEqual(b);
            expect(r.sellerScore).toBeCloseTo((r.finalPrice! - s) / (b - s), 12);
            expect(r.sellerScore + r.buyerScore).toBeCloseTo(1, 12);
            expect(last).toMatchObject({ valid: true, action: { type: "accept" } });
            break;
          case "forfeit":
            expect(last).toMatchObject({ valid: false, retries: DEFAULT_MATCH_CONFIG.maxRetriesPerTurn });
            expect(r.forfeitedBy).toBe(last.side);
            expect(last.side === "seller" ? [r.sellerScore, r.buyerScore] : [r.buyerScore, r.sellerScore]).toEqual([
              0, 0.5,
            ]);
            break;
          case "walk_away":
          case "timeout":
            expect([r.finalPrice, r.sellerScore, r.buyerScore]).toEqual([null, 0, 0]);
            if (r.outcome === "timeout") expect(r.turns).toHaveLength(DEFAULT_MATCH_CONFIG.maxTurns);
            break;
        }
      }),
      { numRuns: MATCH_RUNS },
    );

    console.info(`engine properties: ${MATCH_RUNS} matches, ${agentCalls} agent actions`);
    if (MATCH_RUNS >= 30_000) expect(agentCalls).toBeGreaterThanOrEqual(100_000);
  }, 120_000);

  it("draws limits with a positive bargaining zone, reproducibly from the seed", () => {
    const scenarioArb: fc.Arbitrary<Scenario> = fc
      .record({
        marketLow: fc.integer({ min: 10_000, max: 3_000_000 }),
        width: fc.integer({ min: 5_000, max: 1_000_000 }),
        floorFrom: fc.double({ min: -0.5, max: 1, noNaN: true }),
        floorSpan: fc.double({ min: 0, max: 1, noNaN: true }),
        ceilingFrom: fc.double({ min: 0, max: 1.5, noNaN: true }),
        ceilingSpan: fc.double({ min: 0, max: 1, noNaN: true }),
        minGapRatio: fc.double({ min: 0.01, max: 0.5, noNaN: true }),
        roundTo: fc.constantFrom(100, 500, 1_000),
      })
      .map((r) => ({
        id: "prop",
        itemTitle: "prop",
        itemFacts: ["prop"],
        marketLow: r.marketLow,
        marketHigh: r.marketLow + r.width,
        limitRule: {
          floorRange: [r.floorFrom, r.floorFrom + r.floorSpan],
          ceilingRange: [r.ceilingFrom, r.ceilingFrom + r.ceilingSpan],
          minGapRatio: r.minGapRatio,
          roundTo: r.roundTo,
        },
      }));

    fc.assert(
      fc.property(scenarioArb, fc.integer({ min: 0, max: 2 ** 32 - 1 }), (scenario, seed) => {
        const limits = drawLimits(scenario, seed);
        expect(limits.sellerFloor).toBeGreaterThan(0);
        expect(limits.buyerCeiling).toBeGreaterThan(limits.sellerFloor);
        expect(Number.isInteger(limits.sellerFloor) && Number.isInteger(limits.buyerCeiling)).toBe(true);
        expect(drawLimits(scenario, seed)).toEqual(limits);
      }),
      { numRuns: 5_000 },
    );
  });

  it("replays a bout identically from the same seed", async () => {
    // 상대 제시에 따라 움직이는 결정적 에이전트
    const halfway: Agent = (view) => {
      const last = view.history.at(-1);
      if (!last || last.action.type !== "offer") {
        return turn({ type: "offer", price: view.role === "seller" ? view.myLimit + 50_000 : view.myLimit - 50_000 });
      }
      const target = Math.round((last.action.price + view.myLimit) / 2);
      const ok = view.role === "seller" ? last.action.price >= view.myLimit : last.action.price <= view.myLimit;
      return ok && view.turnNo > 6 ? turn({ type: "accept" }) : turn({ type: "offer", price: target });
    };
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 32 - 1 }), async (seed) => {
        const once = await runBout({ scenario: ipad, seed, a: halfway, b: halfway });
        const again = await runBout({ scenario: ipad, seed, a: halfway, b: halfway });
        expect(again).toEqual(once);
      }),
      { numRuns: 200 },
    );
  });
});
