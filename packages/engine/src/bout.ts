import type { Scenario } from "@haggle/schema";
import { drawLimits, type Limits } from "./limits";
import { type Agent, type MatchConfig, type MatchResult, runMatch } from "./match";

export type BoutWinner = "a" | "b" | "draw";

export interface BoutResult {
  limits: Limits;
  first: MatchResult; // a가 판매자, b가 구매자
  second: MatchResult; // b가 판매자, a가 구매자
  aTotal: number;
  bTotal: number;
  winner: BoutWinner;
}

export interface BoutInput {
  scenario: Scenario;
  seed: number;
  a: Agent;
  b: Agent;
  config?: Partial<MatchConfig>;
}

const EPSILON = 1e-9;

// 같은 시나리오·같은 한도에서 역할을 바꿔 두 경기를 치르고 점수 합으로 승패를 정한다.
export async function runBout(input: BoutInput): Promise<BoutResult> {
  const { scenario, seed, a, b, config } = input;
  const limits = drawLimits(scenario, seed);
  const first = await runMatch({ scenario, limits, seller: a, buyer: b, ...(config && { config }) });
  const second = await runMatch({ scenario, limits, seller: b, buyer: a, ...(config && { config }) });
  const aTotal = first.sellerScore + second.buyerScore;
  const bTotal = first.buyerScore + second.sellerScore;
  const winner: BoutWinner = Math.abs(aTotal - bTotal) < EPSILON ? "draw" : aTotal > bTotal ? "a" : "b";
  return { limits, first, second, aTotal, bTotal, winner };
}
