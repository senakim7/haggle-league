// LLM 에이전트로 한 경기를 치르고, 호출 수·토큰·지연을 잰다.
// 사용법: pnpm match --seller llm --buyer conceder [--model google/gemini-2.5-flash-lite] [--scenario ipad-air-5-64] [--seed 1]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  apiKeyEnvName,
  createHouseBot,
  createLanguageModel,
  createLlmAgent,
  DEFAULT_FREE_MODEL_KEY,
  HOUSE_BOT_NAMES,
  type HouseBotKind,
  type LlmCallLog,
  QuotaGuard,
  resolveFreeModel,
} from "@haggle/agents";
import { type Agent, drawLimits, type MatchResult, runMatch } from "@haggle/engine";
import { getDevScenario } from "@haggle/scenarios";
import { type Side, type StrategyCard, StrategyCard as StrategyCardSchema } from "@haggle/schema";
import { FileQuotaStore } from "./file-quota-store";

const { values } = parseArgs({
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
  options: {
    seller: { type: "string", default: "llm" },
    buyer: { type: "string", default: "conceder" },
    model: { type: "string", default: DEFAULT_FREE_MODEL_KEY },
    scenario: { type: "string", default: "ipad-air-5-64" },
    seed: { type: "string", default: "1" },
    "seller-strategy": { type: "string" },
    "buyer-strategy": { type: "string" },
    out: { type: "string" },
  },
});

// pnpm은 패키지 폴더에서 실행하므로 경로는 명령을 친 위치 기준으로 푼다.
const root = process.env.INIT_CWD ?? process.cwd();
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const SAMPLE_STRATEGIES: Record<Side, StrategyCard> = {
  seller: {
    prompt:
      "시세 상단보다 조금 높게 시작한다. 상대가 양보한 폭의 절반만 양보한다. 근거는 물건 정보에 적힌 장점만 든다. 마지막 두 턴에는 거래 성사를 우선한다.",
    params: { openingAggression: 70, concessionSpeed: 40 },
  },
  buyer: {
    prompt:
      "시세 하단보다 조금 낮게 시작한다. 상대가 양보한 폭의 절반만 양보한다. 물건 정보의 약점(배터리, 구성품 누락 등)을 근거로 든다. 마지막 두 턴에는 거래 성사를 우선한다.",
    params: { openingAggression: 70, concessionSpeed: 40 },
  },
};

const HOUSE_KINDS = Object.keys(HOUSE_BOT_NAMES) as HouseBotKind[];
const scenario = getDevScenario(values.scenario);
const seed = Number(values.seed) >>> 0;
const limits = drawLimits(scenario, seed);
const freeModel = resolveFreeModel(values.model);
const guard = new QuotaGuard(new FileQuotaStore(resolve(root, ".quota/usage.json")), freeModel);
const calls: LlmCallLog[] = [];

function buildAgent(side: Side, spec: string): Agent {
  if (spec === "llm") {
    const strategyPath = values[`${side}-strategy`];
    const strategy = strategyPath
      ? StrategyCardSchema.parse({ prompt: readFileSync(resolve(root, strategyPath), "utf8"), params: SAMPLE_STRATEGIES[side].params })
      : SAMPLE_STRATEGIES[side];
    return createLlmAgent({
      model: createLanguageModel(freeModel, process.env),
      strategy,
      guard,
      onCall: (call) => {
        calls.push(call);
        const tag = call.result === "ok" ? "" : ` [${call.result}]`;
        console.log(
          `  ${call.turnNo}턴 ${side === "seller" ? "판매자" : "구매자"} LLM ${call.latencyMs}ms, 입력 ${call.inputTokens} / 출력 ${call.outputTokens} 토큰${call.isRetry ? " (재요청)" : ""}${tag}`,
        );
      },
    });
  }
  if ((HOUSE_KINDS as string[]).includes(spec)) return createHouseBot(spec as HouseBotKind);
  throw new Error(`--${side}는 llm 또는 ${HOUSE_KINDS.join(", ")} 중 하나여야 합니다: ${spec}`);
}

const label = (spec: string) => (spec === "llm" ? `LLM(${freeModel.key})` : HOUSE_BOT_NAMES[spec as HouseBotKind]);
const won = (price: number) => `${price.toLocaleString("ko-KR")}원`;

console.log(`\n${scenario.itemTitle} · 시세 ${won(scenario.marketLow)}~${won(scenario.marketHigh)} · seed ${seed}`);
console.log(`판매자 ${label(values.seller)} vs 구매자 ${label(values.buyer)}`);
if (!freeModel.verified) {
  console.log(`※ ${freeModel.key}의 무료 한도는 추정치입니다. 콘솔에서 확인한 뒤 models.ts를 고쳐 주세요.`);
}
console.log(`오늘 사용: ${await guard.usedToday()} / 자체 상한 ${guard.dailyCap}회 (${apiKeyEnvName(freeModel)})\n`);

let result: MatchResult | null = null;
let voidReason: string | null = null;
try {
  result = await runMatch({ scenario, limits, seller: buildAgent("seller", values.seller), buyer: buildAgent("buyer", values.buyer) });
} catch (error) {
  // 공급사 장애나 쿼터 소진이면 경기는 무효다. 점수와 레이팅에 반영하지 않는다.
  voidReason = error instanceof Error ? error.message : String(error);
}

if (result) {
  console.log("\n── 대화 ──");
  for (const t of result.turns) {
    const who = t.side === "seller" ? "판매자" : "구매자";
    const act =
      t.action === null
        ? "형식 오류"
        : t.action.type === "offer"
          ? `제시 ${won(t.action.price)}`
          : t.action.type === "accept"
            ? "수락"
            : "결렬";
    console.log(`${String(t.turnNo).padStart(2)}턴 ${who}: ${t.message || "(없음)"}  → ${act}${t.valid ? "" : " ✗"}`);
    if (t.privateNote) console.log(`      속마음: ${t.privateNote}`);
  }
  console.log(`\n한도 공개: 판매자 최저가 ${won(limits.sellerFloor)}, 구매자 최고 예산 ${won(limits.buyerCeiling)}`);
  const price = result.finalPrice === null ? "" : ` ${won(result.finalPrice)}`;
  console.log(`결과: ${result.outcome}${price} · 점수 판매자 ${result.sellerScore.toFixed(3)} / 구매자 ${result.buyerScore.toFixed(3)}`);
} else {
  console.log(`\n경기 무효: ${voidReason}`);
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const latencies = calls.map((c) => c.latencyMs).sort((a, b) => a - b);
const p95 = latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * 0.95) - 1)] ?? 0;
const tokensIn = sum(calls.map((c) => c.inputTokens));
const tokensOut = sum(calls.map((c) => c.outputTokens));
console.log("\n── 사용량 ──");
console.log(
  `LLM 호출 ${calls.length}회 (정상 ${calls.filter((c) => c.result === "ok").length}, 형식 실패 ${calls.filter((c) => c.result === "invalid_output").length}, 공급사 오류 ${calls.filter((c) => c.result === "provider_error").length}, 엔진 재요청 ${calls.filter((c) => c.isRetry).length})`,
);
if (calls.length > 0) {
  console.log(
    `토큰: 입력 ${tokensIn.toLocaleString()} + 출력 ${tokensOut.toLocaleString()} = ${(tokensIn + tokensOut).toLocaleString()} (호출당 평균 입력 ${Math.round(tokensIn / calls.length)}, 출력 ${Math.round(tokensOut / calls.length)})`,
  );
  console.log(`지연: 평균 ${Math.round(sum(latencies) / latencies.length)}ms, p95 ${p95}ms`);
}
console.log(`오늘 사용: ${await guard.usedToday()} / 자체 상한 ${guard.dailyCap}회 · 과금 0원(무료 티어)`);

if (values.out) {
  const outPath = resolve(root, values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  const record = { scenarioId: scenario.id, seed, model: freeModel.key, seller: values.seller, buyer: values.buyer, limits, result, voidReason, calls };
  writeFileSync(outPath, JSON.stringify(record, null, 2));
  console.log(`기록: ${outPath}`);
}

if (!result) process.exit(1);
