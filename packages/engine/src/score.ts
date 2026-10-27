import type { Side } from "@haggle/schema";
import type { Limits } from "./limits";

export interface Scores {
  seller: number;
  buyer: number;
}

export const NO_DEAL_SCORES: Scores = { seller: 0, buyer: 0 };

// 기권한 쪽은 0점, 상대는 0.5점
export const FORFEIT_OPPONENT_SCORE = 0.5;

// S_seller = (p - s) / (b - s), S_buyer = (b - p) / (b - s)
export function scoreDeal(price: number, limits: Limits): Scores {
  const { sellerFloor: s, buyerCeiling: b } = limits;
  if (!(s < b)) throw new RangeError(`invalid limits: floor ${s} must be below ceiling ${b}`);
  if (price < s || price > b) throw new RangeError(`price ${price} is outside [${s}, ${b}]`);
  const seller = (price - s) / (b - s);
  return { seller, buyer: 1 - seller };
}

export function scoreForfeit(forfeitedBy: Side): Scores {
  return forfeitedBy === "seller"
    ? { seller: 0, buyer: FORFEIT_OPPONENT_SCORE }
    : { seller: FORFEIT_OPPONENT_SCORE, buyer: 0 };
}
