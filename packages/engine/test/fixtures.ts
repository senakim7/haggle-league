import type { Action, Scenario } from "@haggle/schema";
import type { Agent } from "../src/index";

export const ipad: Scenario = {
  id: "test-ipad",
  itemTitle: "아이패드 에어 5세대 64GB",
  itemFacts: ["A급, 생활 기스 없음"],
  marketLow: 550_000,
  marketHigh: 650_000,
  limitRule: { floorRange: [-0.1, 0.7], ceilingRange: [0.3, 1.1], minGapRatio: 0.1, roundTo: 1_000 },
};

export function turn(action: Action, message = "", privateNote = "") {
  return { message, privateNote, action };
}

// 정해진 출력을 순서대로 내는 에이전트. 다 쓰면 결렬을 선언한다.
export function scripted(outputs: unknown[]): Agent {
  let i = 0;
  return () => (i < outputs.length ? outputs[i++] : turn({ type: "walk_away" }));
}
