import { createHouseBot, type LlmCallLog } from "@haggle/agents";
import { agentVersions, type Db, matches, scenarios, turns } from "@haggle/db";
import { type Agent, type MatchResult, runMatch } from "@haggle/engine";
import { type HouseBotKind, Scenario, type Side, type StrategyCard } from "@haggle/schema";
import { and, eq } from "drizzle-orm";

export interface ExecuteDeps {
  // 에이전트 버전의 전략으로 LLM 에이전트를 만든다. 테스트에서는 목 모델로 바꾼다.
  createVersionAgent(strategy: StrategyCard, onCall: (call: LlmCallLog) => void): Agent;
  modelKey: string;
}

export type ExecuteOutcome =
  | { status: "done"; result: MatchResult }
  | { status: "void"; reason: string }
  | { status: "skipped"; current: string };

// 같은 작업이 두 번 실행돼도(워커 재시작, 중복 전달) 결과가 한 번만 반영되게 한다.
// 상태는 조건부 UPDATE로만 queued → running → done(또는 void) 순서로 바뀐다.
export async function executeMatch(db: Db, matchId: string, deps: ExecuteDeps): Promise<ExecuteOutcome> {
  const [claimed] = await db
    .update(matches)
    .set({ status: "running", startedAt: new Date(), modelKey: deps.modelKey })
    .where(and(eq(matches.id, matchId), eq(matches.status, "queued")))
    .returning();

  if (!claimed) {
    const [current] = await db.select({ status: matches.status }).from(matches).where(eq(matches.id, matchId));
    if (current?.status === "running") {
      // 이전 워커가 경기 도중 죽었다. 반쯤 돈 경기를 이어 붙이지 않고 무효로 끝낸다.
      const reason = "워커가 경기 도중 중단됨";
      await markVoid(db, matchId, reason);
      return { status: "void", reason };
    }
    return { status: "skipped", current: current?.status ?? "missing" };
  }

  const calls: LlmCallLog[] = [];
  let result: MatchResult;
  try {
    const [scenarioRow] = await db.select().from(scenarios).where(eq(scenarios.id, claimed.scenarioId));
    const scenario = Scenario.parse(scenarioRow);
    const agentFor = async (side: Side): Promise<Agent> => {
      const versionId = side === "seller" ? claimed.sellerVersionId : claimed.buyerVersionId;
      const bot = side === "seller" ? claimed.sellerHouseBot : claimed.buyerHouseBot;
      if (bot) return createHouseBot(bot as HouseBotKind);
      const [version] = await db.select().from(agentVersions).where(eq(agentVersions.id, versionId!));
      if (!version) throw new Error(`에이전트 버전이 없습니다: ${versionId}`);
      return deps.createVersionAgent({ prompt: version.strategyPrompt, params: version.params }, (call) => calls.push(call));
    };
    result = await runMatch({
      scenario,
      // 한도는 경기를 만들 때 정해 DB에 저장한 값을 쓴다. 다시 뽑지 않는다.
      limits: { sellerFloor: claimed.sellerFloor, buyerCeiling: claimed.buyerCeiling },
      seller: await agentFor("seller"),
      buyer: await agentFor("buyer"),
    });
  } catch (error) {
    // LLM 장애·쿼터 소진이면 경기를 무효로 하고 점수에 반영하지 않는다.
    const reason = error instanceof Error ? error.message : String(error);
    await markVoid(db, matchId, reason);
    return { status: "void", reason };
  }

  const usage = (side: Side, turnNo: number) => {
    const mine = calls.filter((c) => c.role === side && c.turnNo === turnNo);
    return {
      tokensIn: sum(mine.map((c) => c.inputTokens)),
      tokensOut: sum(mine.map((c) => c.outputTokens)),
      latencyMs: sum(mine.map((c) => c.latencyMs)),
    };
  };

  await db.transaction(async (tx) => {
    if (result.turns.length > 0) {
      await tx
        .insert(turns)
        .values(
          result.turns.map((t) => ({
            matchId,
            turnNo: t.turnNo,
            side: t.side,
            message: t.message,
            privateNote: t.privateNote,
            action: t.action?.type ?? null,
            price: t.action?.type === "offer" ? t.action.price : null,
            valid: t.valid,
            retries: t.retries,
            error: t.error ?? null,
            ...usage(t.side, t.turnNo),
          })),
        )
        .onConflictDoNothing();
    }
    const updated = await tx
      .update(matches)
      .set({
        status: "done",
        outcome: result.outcome,
        finalPrice: result.finalPrice,
        sellerScore: result.sellerScore,
        buyerScore: result.buyerScore,
        forfeitedBy: result.forfeitedBy,
        llmCalls: calls.length,
        tokensIn: sum(calls.map((c) => c.inputTokens)),
        tokensOut: sum(calls.map((c) => c.outputTokens)),
        finishedAt: new Date(),
      })
      .where(and(eq(matches.id, matchId), eq(matches.status, "running")))
      .returning({ id: matches.id });
    // 그사이 다른 쪽이 상태를 바꿨다면 턴 저장까지 되돌린다.
    if (updated.length === 0) throw new Error(`경기 상태가 바뀌어 결과를 반영하지 않았습니다: ${matchId}`);
  });
  return { status: "done", result };
}

async function markVoid(db: Db, matchId: string, reason: string) {
  await db
    .update(matches)
    .set({ status: "void", voidReason: reason.slice(0, 500), finishedAt: new Date() })
    .where(and(eq(matches.id, matchId), eq(matches.status, "running")));
}

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
