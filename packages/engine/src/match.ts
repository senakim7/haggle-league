import { type Action, type PublicScenario, type Scenario, type Side, TurnOutput } from "@haggle/schema";
import { z } from "zod";
import type { Limits } from "./limits";
import { checkAction, type Offer, sideForTurn } from "./rules";
import { NO_DEAL_SCORES, scoreDeal, scoreForfeit } from "./score";

export interface MatchConfig {
  maxTurns: number;
  maxRetriesPerTurn: number;
}

export const DEFAULT_MATCH_CONFIG: MatchConfig = { maxTurns: 12, maxRetriesPerTurn: 1 };

// 상대에게 공개된 턴. 속마음과 상대 한도는 들어가지 않는다.
export interface PublicTurn {
  turnNo: number;
  side: Side;
  message: string;
  action: Action;
}

// 에이전트가 한 턴을 결정할 때 보는 전부. 상대 한도는 어떤 필드에도 없다.
export interface AgentView {
  role: Side;
  scenario: PublicScenario;
  myLimit: number;
  turnNo: number;
  maxTurns: number;
  history: PublicTurn[];
  retryError?: string; // 직전 시도가 거부된 이유. 다시 시킬 때만 채운다.
}

// 반환값은 신뢰하지 않는다. 엔진이 TurnOutput 스키마와 규칙으로 다시 검사한다.
// 에이전트가 예외를 던지면(LLM 장애 등) runMatch도 그대로 던지고, 경기 무효 처리는 워커가 한다.
export type Agent = (view: AgentView) => unknown;

export interface TurnRecord {
  turnNo: number;
  side: Side;
  message: string;
  privateNote: string;
  action: Action | null; // 형식 검증을 통과하지 못하면 null
  valid: boolean;
  retries: number;
  error?: string;
}

export type MatchOutcome = "deal" | "walk_away" | "timeout" | "forfeit";

export interface MatchResult {
  outcome: MatchOutcome;
  finalPrice: number | null;
  sellerScore: number;
  buyerScore: number;
  forfeitedBy: Side | null;
  turns: TurnRecord[];
}

export interface MatchInput {
  scenario: Scenario;
  limits: Limits;
  seller: Agent;
  buyer: Agent;
  config?: Partial<MatchConfig>;
}

export async function runMatch(input: MatchInput): Promise<MatchResult> {
  const { scenario, limits } = input;
  const config = { ...DEFAULT_MATCH_CONFIG, ...input.config };
  const publicScenario: PublicScenario = {
    itemTitle: scenario.itemTitle,
    itemFacts: [...scenario.itemFacts],
    marketLow: scenario.marketLow,
    marketHigh: scenario.marketHigh,
  };
  const turns: TurnRecord[] = [];
  let lastOffer: Offer | null = null;

  for (let turnNo = 1; turnNo <= config.maxTurns; turnNo++) {
    const side = sideForTurn(turnNo);
    const agent = side === "seller" ? input.seller : input.buyer;
    const myLimit = side === "seller" ? limits.sellerFloor : limits.buyerCeiling;

    let record: TurnRecord | null = null;
    let retryError: string | undefined;
    for (let attempt = 0; attempt <= config.maxRetriesPerTurn; attempt++) {
      const view: AgentView = {
        role: side,
        scenario: structuredClone(publicScenario),
        myLimit,
        turnNo,
        maxTurns: config.maxTurns,
        history: publicHistory(turns),
        ...(retryError === undefined ? {} : { retryError }),
      };
      const attemptRecord = evaluate(await agent(view), turnNo, side, attempt, limits, lastOffer);
      record = attemptRecord;
      if (attemptRecord.valid) break;
      retryError = attemptRecord.error;
    }
    if (record === null) throw new Error("unreachable: no attempt was made");
    turns.push(record);

    if (!record.valid) {
      return finish("forfeit", null, scoreForfeit(side), side, turns);
    }
    const action = record.action!;
    if (action.type === "walk_away") {
      return finish("walk_away", null, NO_DEAL_SCORES, null, turns);
    }
    if (action.type === "accept") {
      const price = lastOffer!.price;
      return finish("deal", price, scoreDeal(price, limits), null, turns);
    }
    lastOffer = { side, price: action.price };
  }
  return finish("timeout", null, NO_DEAL_SCORES, null, turns);
}

function evaluate(
  raw: unknown,
  turnNo: number,
  side: Side,
  retries: number,
  limits: Limits,
  lastOffer: Offer | null,
): TurnRecord {
  const parsed = TurnOutput.safeParse(raw);
  if (!parsed.success) {
    return {
      turnNo,
      side,
      message: "",
      privateNote: "",
      action: null,
      valid: false,
      retries,
      error: `출력 형식 오류: ${z.prettifyError(parsed.error)}`,
    };
  }
  const { message, privateNote, action } = parsed.data;
  const check = checkAction(side, action, limits, lastOffer);
  return {
    turnNo,
    side,
    message,
    privateNote,
    action,
    valid: check.ok,
    retries,
    ...(check.ok ? {} : { error: check.error }),
  };
}

// 무효 턴은 경기를 끝내므로 기록에 남은 턴은 모두 유효하다.
function publicHistory(turns: TurnRecord[]): PublicTurn[] {
  return turns.map((t) => ({ turnNo: t.turnNo, side: t.side, message: t.message, action: { ...t.action! } }));
}

function finish(
  outcome: MatchOutcome,
  finalPrice: number | null,
  scores: { seller: number; buyer: number },
  forfeitedBy: Side | null,
  turns: TurnRecord[],
): MatchResult {
  return { outcome, finalPrice, sellerScore: scores.seller, buyerScore: scores.buyer, forfeitedBy, turns };
}
