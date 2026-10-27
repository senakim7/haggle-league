import type { Action, Side } from "@haggle/schema";
import type { Limits } from "./limits";

export interface Offer {
  side: Side;
  price: number;
}

export type RuleCheck = { ok: true } | { ok: false; error: string };

// 형식 검증(zod)을 통과한 행동이 규칙상 가능한지 본다. LLM이 아니라 코드가 판정한다.
export function checkAction(side: Side, action: Action, limits: Limits, lastOffer: Offer | null): RuleCheck {
  switch (action.type) {
    case "offer":
      return withinOwnLimit(side, action.price, limits, "제시");
    case "accept":
      if (lastOffer === null || lastOffer.side === side) {
        return { ok: false, error: "수락할 상대의 제시가가 없습니다." };
      }
      return withinOwnLimit(side, lastOffer.price, limits, "수락");
    case "walk_away":
      return { ok: true };
  }
}

function withinOwnLimit(side: Side, price: number, limits: Limits, verb: string): RuleCheck {
  if (side === "seller" && price < limits.sellerFloor) {
    return { ok: false, error: `최저가보다 낮은 ${price}원은 ${verb}할 수 없습니다.` };
  }
  if (side === "buyer" && price > limits.buyerCeiling) {
    return { ok: false, error: `최고 예산보다 높은 ${price}원은 ${verb}할 수 없습니다.` };
  }
  return { ok: true };
}

export function opponentOf(side: Side): Side {
  return side === "seller" ? "buyer" : "seller";
}

// 판매자가 홀수 턴, 구매자가 짝수 턴을 맡는다.
export function sideForTurn(turnNo: number): Side {
  return turnNo % 2 === 1 ? "seller" : "buyer";
}
