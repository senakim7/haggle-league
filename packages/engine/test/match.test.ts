import { describe, expect, it } from "vitest";
import { type AgentView, runBout, runMatch } from "../src/index";
import { ipad, scripted, turn } from "./fixtures";

const limits = { sellerFloor: 560_000, buyerCeiling: 620_000 };

describe("runMatch", () => {
  it("closes a deal at the opponent's last offer", async () => {
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: scripted([turn({ type: "offer", price: 640_000 }), turn({ type: "offer", price: 600_000 })]),
      buyer: scripted([turn({ type: "offer", price: 560_000 }), turn({ type: "accept" })]),
    });
    expect(result.outcome).toBe("deal");
    expect(result.finalPrice).toBe(600_000);
    expect(result.sellerScore).toBeCloseTo(40 / 60);
    expect(result.buyerScore).toBeCloseTo(20 / 60);
    expect(result.turns.map((t) => t.side)).toEqual(["seller", "buyer", "seller", "buyer"]);
  });

  it("times out after 12 turns without agreement", async () => {
    const stubborn = (price: number) => scripted(Array.from({ length: 6 }, () => turn({ type: "offer", price })));
    const result = await runMatch({ scenario: ipad, limits, seller: stubborn(650_000), buyer: stubborn(550_000) });
    expect(result.outcome).toBe("timeout");
    expect(result.turns).toHaveLength(12);
    expect([result.sellerScore, result.buyerScore]).toEqual([0, 0]);
  });

  it("ends with no deal when a side walks away", async () => {
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: scripted([turn({ type: "offer", price: 640_000 })]),
      buyer: scripted([turn({ type: "walk_away" })]),
    });
    expect(result).toMatchObject({ outcome: "walk_away", finalPrice: null, sellerScore: 0, buyerScore: 0 });
  });

  it("retries once with the error and continues when the retry is valid", async () => {
    const seen: AgentView[] = [];
    const seller = scripted([turn({ type: "offer", price: 500_000 }), turn({ type: "offer", price: 600_000 })]);
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: (view) => {
        seen.push(view);
        return seller(view);
      },
      buyer: scripted([turn({ type: "accept" })]),
    });
    expect(seen[1]?.retryError).toContain("500000");
    expect(result.turns[0]).toMatchObject({ valid: true, retries: 1, action: { type: "offer", price: 600_000 } });
    expect(result.outcome).toBe("deal");
  });

  it("forfeits after the retry also breaks the rules", async () => {
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: scripted([turn({ type: "offer", price: 640_000 })]),
      buyer: scripted([turn({ type: "offer", price: 700_000 }), { message: "x".repeat(200) }]),
    });
    expect(result).toMatchObject({ outcome: "forfeit", forfeitedBy: "buyer", sellerScore: 0.5, buyerScore: 0 });
    expect(result.turns.at(-1)).toMatchObject({ valid: false, retries: 1, action: null });
  });

  it("rejects accepting when there is no opponent offer yet", async () => {
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: scripted([turn({ type: "accept" }), turn({ type: "accept" })]),
      buyer: scripted([]),
    });
    expect(result).toMatchObject({ outcome: "forfeit", forfeitedBy: "seller" });
  });

  it("rejects accepting an opponent offer that breaks your own limit", async () => {
    // 구매자가 판매자 최저가보다 낮게 제시했고, 판매자가 그걸 수락하려 한다
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: scripted([turn({ type: "offer", price: 640_000 }), turn({ type: "accept" }), turn({ type: "accept" })]),
      buyer: scripted([turn({ type: "offer", price: 500_000 })]),
    });
    expect(result).toMatchObject({ outcome: "forfeit", forfeitedBy: "seller" });
  });

  it("never shows an agent the opponent's limit or private notes", async () => {
    const views: AgentView[] = [];
    const record = (inner: ReturnType<typeof scripted>) => (view: AgentView) => {
      views.push(structuredClone(view));
      return inner(view);
    };
    await runMatch({
      scenario: ipad,
      limits,
      seller: record(scripted([turn({ type: "offer", price: 640_000 }, "", "비밀 메모")])),
      buyer: record(scripted([turn({ type: "offer", price: 580_000 }), turn({ type: "walk_away" })])),
    });
    for (const view of views) {
      expect(Object.keys(view).sort()).toEqual(["history", "maxTurns", "myLimit", "role", "scenario", "turnNo"]);
      expect(view.myLimit).toBe(view.role === "seller" ? limits.sellerFloor : limits.buyerCeiling);
      expect(JSON.stringify(view)).not.toContain("비밀 메모");
      expect(view.scenario).not.toHaveProperty("limitRule");
    }
  });

  it("is not affected by agents mutating what they were shown", async () => {
    const result = await runMatch({
      scenario: ipad,
      limits,
      seller: scripted([turn({ type: "offer", price: 640_000 }), turn({ type: "offer", price: 600_000 })]),
      buyer: (view: AgentView) => {
        for (const t of view.history) if (t.action.type === "offer") t.action.price = 1;
        return view.turnNo === 2 ? turn({ type: "offer", price: 570_000 }) : turn({ type: "accept" });
      },
    });
    expect(result.finalPrice).toBe(600_000);
  });
});

describe("runBout", () => {
  it("swaps roles on the same limits and sums the scores", async () => {
    // a는 판매자일 때 자기 최저가를 그대로 부른다. b는 상대 제시가 있으면 수락하고, 없으면 결렬한다.
    const giveaway = (view: AgentView) => turn({ type: "offer", price: view.myLimit });
    const passive = (view: AgentView) => turn(view.history.length > 0 ? { type: "accept" } : { type: "walk_away" });
    const result = await runBout({ scenario: ipad, seed: 7, a: giveaway, b: passive });
    expect(result.first).toMatchObject({ outcome: "deal", finalPrice: result.limits.sellerFloor });
    expect(result.second.outcome).toBe("walk_away");
    expect([result.aTotal, result.bTotal]).toEqual([0, 1]);
    expect(result.winner).toBe("b");
  });
});
