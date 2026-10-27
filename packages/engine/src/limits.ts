import type { Scenario } from "@haggle/schema";
import { createRng, uniform } from "./rng";

export interface Limits {
  sellerFloor: number; // 판매자 최저가 s
  buyerCeiling: number; // 구매자 최고 예산 b
}

const MAX_DRAWS = 100;

// 두 한도를 서로 독립으로 뽑고, 간격이 minGap보다 좁으면 다시 뽑는다.
// 한쪽 한도에서 다른 쪽을 계산하면 상대 한도를 추론할 수 있으므로 독립 추출을 유지한다.
export function drawLimits(scenario: Scenario, seed: number): Limits {
  const { marketLow, marketHigh, limitRule } = scenario;
  const width = marketHigh - marketLow;
  const minGap = Math.max(limitRule.roundTo, limitRule.minGapRatio * width);
  const at = (ratio: number) => round(marketLow + ratio * width, limitRule.roundTo);
  const rng = createRng(seed);

  for (let i = 0; i < MAX_DRAWS; i++) {
    const sellerFloor = at(uniform(rng, ...limitRule.floorRange));
    const buyerCeiling = at(uniform(rng, ...limitRule.ceilingRange));
    if (sellerFloor > 0 && buyerCeiling - sellerFloor >= minGap) {
      return { sellerFloor, buyerCeiling };
    }
  }
  // 규칙이 거의 불가능한 범위를 주면 시세 범위 그대로 쓴다. 시나리오 테스트가 이 경우를 막는다.
  return { sellerFloor: marketLow, buyerCeiling: marketHigh };
}

function round(value: number, unit: number): number {
  return Math.round(value / unit) * unit;
}
