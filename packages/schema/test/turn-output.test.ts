import { describe, expect, it } from "vitest";
import { TurnOutput } from "../src/index";

describe("TurnOutput", () => {
  it("accepts a well-formed offer", () => {
    const out = TurnOutput.parse({
      message: "60만 원에 드릴게요.",
      privateNote: "첫 제시는 높게",
      action: { type: "offer", price: 600_000 },
    });
    expect(out.action).toEqual({ type: "offer", price: 600_000 });
  });

  it("rejects messages over 150 characters", () => {
    const result = TurnOutput.safeParse({
      message: "가".repeat(151),
      privateNote: "",
      action: { type: "accept" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer and non-positive prices", () => {
    for (const price of [0, -1000, 1234.5]) {
      const result = TurnOutput.safeParse({ message: "", privateNote: "", action: { type: "offer", price } });
      expect(result.success).toBe(false);
    }
  });

  it("rejects unknown action types", () => {
    const result = TurnOutput.safeParse({ message: "", privateNote: "", action: { type: "counter", price: 1 } });
    expect(result.success).toBe(false);
  });
});
