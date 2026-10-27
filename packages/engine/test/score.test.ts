import { describe, expect, it } from "vitest";
import { scoreDeal, scoreForfeit } from "../src/index";

const limits = { sellerFloor: 500_000, buyerCeiling: 600_000 };

describe("scoreDeal", () => {
  it("splits the surplus between the two limits", () => {
    expect(scoreDeal(575_000, limits)).toEqual({ seller: 0.75, buyer: 0.25 });
    expect(scoreDeal(500_000, limits)).toEqual({ seller: 0, buyer: 1 });
    expect(scoreDeal(600_000, limits)).toEqual({ seller: 1, buyer: 0 });
  });

  it("refuses prices outside the limits", () => {
    expect(() => scoreDeal(499_999, limits)).toThrow(RangeError);
    expect(() => scoreDeal(600_001, limits)).toThrow(RangeError);
  });

  it("refuses limits without a bargaining zone", () => {
    expect(() => scoreDeal(500_000, { sellerFloor: 500_000, buyerCeiling: 500_000 })).toThrow(RangeError);
  });
});

describe("scoreForfeit", () => {
  it("gives 0 to the side that forfeited and 0.5 to the opponent", () => {
    expect(scoreForfeit("seller")).toEqual({ seller: 0, buyer: 0.5 });
    expect(scoreForfeit("buyer")).toEqual({ seller: 0.5, buyer: 0 });
  });
});
