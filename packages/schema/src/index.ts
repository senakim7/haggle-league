import { z } from "zod";

export const MESSAGE_MAX_LENGTH = 150;
export const PRIVATE_NOTE_MAX_LENGTH = 100;

export const Side = z.enum(["seller", "buyer"]);
export type Side = z.infer<typeof Side>;

export const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("offer"), price: z.number().int().positive() }),
  z.object({ type: z.literal("accept") }),
  z.object({ type: z.literal("walk_away") }),
]);
export type Action = z.infer<typeof Action>;

// LLM 출력, API 응답, 편집기 폼이 함께 쓰는 한 턴의 형식
export const TurnOutput = z.object({
  message: z.string().max(MESSAGE_MAX_LENGTH), // 상대에게 보이는 말
  privateNote: z.string().max(PRIVATE_NOTE_MAX_LENGTH), // 경기 후 공개되는 속마음
  action: Action,
});
export type TurnOutput = z.infer<typeof TurnOutput>;

export const STRATEGY_PROMPT_MAX_LENGTH = 1000;

// 편집기의 성향 슬라이더. 0~100 정수로 저장하고, 프롬프트에는 말로 풀어 넣는다.
export const StrategyParams = z.object({
  openingAggression: z.number().int().min(0).max(100), // 첫 제시가를 시세에서 얼마나 멀리 부를지
  concessionSpeed: z.number().int().min(0).max(100), // 얼마나 빨리 양보할지
});
export type StrategyParams = z.infer<typeof StrategyParams>;

export const StrategyCard = z.object({
  prompt: z.string().max(STRATEGY_PROMPT_MAX_LENGTH),
  params: StrategyParams,
});
export type StrategyCard = z.infer<typeof StrategyCard>;

// API가 경기를 큐에 넣고 워커가 꺼낸다. 작업 ID를 경기 ID로 써서 같은 경기가 두 번 들어가지 않게 한다.
export const MATCH_QUEUE = "matches";
export const MatchJob = z.object({ matchId: z.uuid() });
export type MatchJob = z.infer<typeof MatchJob>;

export const HouseBotKind = z.enum(["holdout", "conceder", "mirror"]);
export type HouseBotKind = z.infer<typeof HouseBotKind>;

// 한도는 시세 범위에 대한 비율로 정한다. 0은 시세 하단, 1은 시세 상단이다.
export const LimitRule = z
  .object({
    floorRange: z.tuple([z.number(), z.number()]),
    ceilingRange: z.tuple([z.number(), z.number()]),
    minGapRatio: z.number().positive(), // 판매자 최저가와 구매자 최고 예산 사이 최소 간격
    roundTo: z.number().int().positive(),
  })
  .refine((r) => r.floorRange[0] <= r.floorRange[1] && r.ceilingRange[0] <= r.ceilingRange[1], {
    message: "range must be [min, max]",
  });
export type LimitRule = z.infer<typeof LimitRule>;

export const Scenario = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    itemTitle: z.string().min(1),
    itemFacts: z.array(z.string().min(1)).min(1), // 심판 AI가 물건 거짓말을 판정하는 기준
    marketLow: z.number().int().positive(),
    marketHigh: z.number().int().positive(),
    limitRule: LimitRule,
  })
  .refine((s) => s.marketLow < s.marketHigh, { message: "marketLow must be below marketHigh" });
export type Scenario = z.infer<typeof Scenario>;

// 양쪽 에이전트에게 공개되는 시나리오 정보
export type PublicScenario = Pick<Scenario, "itemTitle" | "itemFacts" | "marketLow" | "marketHigh">;
