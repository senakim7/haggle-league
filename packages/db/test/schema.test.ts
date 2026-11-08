import { devScenarios } from "@haggle/scenarios";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { matches, scenarios, turns, user } from "../src/index";
import { createTestDb } from "../src/testing";

let db: Awaited<ReturnType<typeof createTestDb>>;

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(scenarios).values(devScenarios);
  await db.insert(user).values({ id: "u1", name: "테스터", email: "u1@users.haggle.invalid" });
});
afterAll(() => db.$close());

const baseMatch = {
  kind: "practice" as const,
  scenarioId: "ipad-air-5-64",
  seed: 4_000_000_000, // uint32 시드가 int4 범위를 넘어도 저장되어야 한다
  sellerHouseBot: "holdout" as const,
  buyerHouseBot: "conceder" as const,
  sellerFloor: 560_000,
  buyerCeiling: 620_000,
};

describe("db schema", () => {
  it("stores a match with uint32 seeds and defaults to queued", async () => {
    const [row] = await db.insert(matches).values(baseMatch).returning();
    expect(row).toMatchObject({ status: "queued", seed: 4_000_000_000, llmCalls: 0 });
  });

  it("requires each side to be exactly one of an agent version or a house bot", async () => {
    await expect(db.insert(matches).values({ ...baseMatch, sellerHouseBot: null })).rejects.toThrow();
  });

  it("rejects limits without a bargaining zone", async () => {
    await expect(db.insert(matches).values({ ...baseMatch, sellerFloor: 620_000 })).rejects.toThrow();
  });

  it("refuses to store the same turn twice", async () => {
    const [m] = await db.insert(matches).values(baseMatch).returning();
    const t = { matchId: m!.id, turnNo: 1, side: "seller" as const, message: "", privateNote: "", valid: true, retries: 0 };
    await db.insert(turns).values(t);
    await expect(db.insert(turns).values(t)).rejects.toThrow();
    const inserted = await db.insert(turns).values(t).onConflictDoNothing().returning();
    expect(inserted).toHaveLength(0);
  });
});
