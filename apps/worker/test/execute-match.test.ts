import { createHouseBot, type LlmCallLog } from "@haggle/agents";
import { agents, agentVersions, matches, scenarios, turns, user } from "@haggle/db";
import { createTestDb } from "@haggle/db/testing";
import type { AgentView } from "@haggle/engine";
import { devScenarios } from "@haggle/scenarios";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ExecuteDeps, executeMatch } from "../src/execute-match";

let db: Awaited<ReturnType<typeof createTestDb>>;
let versionId: string;

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(scenarios).values(devScenarios);
  await db.insert(user).values({ id: "u1", name: "테스터", email: "u1@users.haggle.invalid" });
  const [agent] = await db.insert(agents).values({ ownerId: "u1", name: "1호" }).returning();
  const [version] = await db
    .insert(agentVersions)
    .values({ agentId: agent!.id, version: 1, strategyPrompt: "천천히 양보", params: { openingAggression: 50, concessionSpeed: 50 }, contentHash: "h" })
    .returning();
  versionId = version!.id;
});
afterAll(() => db.$close());

// LLM 대신 하우스 봇처럼 움직이면서 호출 기록을 남기는 가짜 에이전트
const fakeLlm: ExecuteDeps = {
  modelKey: "test/fake",
  createVersionAgent: (_strategy, onCall) => {
    const bot = createHouseBot("mirror");
    return (view: AgentView) => {
      onCall({ turnNo: view.turnNo, role: view.role, isRetry: false, attempt: 0, inputTokens: 1000, outputTokens: 50, latencyMs: 300, result: "ok" } satisfies LlmCallLog);
      return bot(view);
    };
  },
};

async function queuedMatch() {
  const [m] = await db
    .insert(matches)
    .values({
      kind: "practice",
      requestedBy: "u1",
      scenarioId: "ipad-air-5-64",
      seed: 7,
      sellerVersionId: versionId,
      buyerHouseBot: "conceder",
      sellerFloor: 560_000,
      buyerCeiling: 630_000,
    })
    .returning();
  return m!;
}

describe("executeMatch", () => {
  it("runs a queued match and stores turns, scores and token usage", async () => {
    const m = await queuedMatch();
    const outcome = await executeMatch(db, m.id, fakeLlm);
    expect(outcome.status).toBe("done");

    const [row] = await db.select().from(matches).where(eq(matches.id, m.id));
    const stored = await db.select().from(turns).where(eq(turns.matchId, m.id));
    const sellerTurns = stored.filter((t) => t.side === "seller").length;
    expect(row).toMatchObject({ status: "done", modelKey: "test/fake", llmCalls: sellerTurns, tokensIn: sellerTurns * 1000 });
    expect(stored.length).toBeGreaterThan(0);
    if (row!.outcome === "deal") {
      expect(row!.finalPrice!).toBeGreaterThanOrEqual(560_000);
      expect(row!.finalPrice!).toBeLessThanOrEqual(630_000);
      expect(row!.sellerScore! + row!.buyerScore!).toBeCloseTo(1);
    }
    expect(stored.find((t) => t.side === "buyer")?.tokensIn).toBe(0); // 하우스 봇은 토큰을 쓰지 않는다
  });

  it("applies a match only once when the same job runs again", async () => {
    const m = await queuedMatch();
    await executeMatch(db, m.id, fakeLlm);
    const before = await db.select().from(turns).where(eq(turns.matchId, m.id));
    const again = await executeMatch(db, m.id, fakeLlm);
    expect(again).toEqual({ status: "skipped", current: "done" });
    expect(await db.select().from(turns).where(eq(turns.matchId, m.id))).toHaveLength(before.length);
  });

  it("voids a match left running by a crashed worker instead of resuming it", async () => {
    const m = await queuedMatch();
    await db.update(matches).set({ status: "running" }).where(eq(matches.id, m.id));
    const outcome = await executeMatch(db, m.id, fakeLlm);
    expect(outcome.status).toBe("void");
    const [row] = await db.select().from(matches).where(eq(matches.id, m.id));
    expect(row).toMatchObject({ status: "void", outcome: null });
  });

  it("voids the match without storing turns when the LLM provider fails", async () => {
    const m = await queuedMatch();
    const broken: ExecuteDeps = {
      modelKey: "test/broken",
      createVersionAgent: () => () => {
        throw new Error("429 Too Many Requests");
      },
    };
    expect(await executeMatch(db, m.id, broken)).toEqual({ status: "void", reason: "429 Too Many Requests" });
    expect(await db.select().from(turns).where(eq(turns.matchId, m.id))).toHaveLength(0);
    const [row] = await db.select().from(matches).where(eq(matches.id, m.id));
    expect(row).toMatchObject({ status: "void", voidReason: "429 Too Many Requests", sellerScore: null });
  });
});
