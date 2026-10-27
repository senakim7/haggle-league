import type { Agent, AgentView } from "@haggle/engine";
import type { TurnOutput } from "@haggle/schema";

// 하우스 봇은 LLM 없이 정해진 문장으로 말한다. 비용 없이 엔진·부하 테스트와 연습 상대로 쓴다.
// 물건 상태에 대한 말은 하지 않는다(심판 AI가 적발하는 금지 행동이므로).

export type HouseBotKind = "holdout" | "conceder" | "mirror";

export const HOUSE_BOT_NAMES: Record<HouseBotKind, string> = {
  holdout: "버티기형",
  conceder: "양보형",
  mirror: "따라하기형",
};

// 첫 제시가는 시세 범위 바깥으로 이만큼(시세 폭 대비) 벌려서 부른다.
const ANCHOR_RATIO = 0.15;
// 시간 기반 양보 곡선 target(t) = anchor + (limit - anchor) * t^(1/beta)
// beta < 1이면 마감 직전까지 버티고, beta > 1이면 초반에 크게 양보한다.
const BETA: Record<Exclude<HouseBotKind, "mirror">, number> = { holdout: 0.2, conceder: 3 };
// 따라하기형이 상대의 양보를 아직 못 봤을 때 내는 첫 양보(시세 폭 대비)
const MIRROR_OPENING_STEP = 0.1;
const PRICE_UNIT = 1_000;

export function createHouseBot(kind: HouseBotKind): Agent {
  return (view: AgentView): TurnOutput => {
    const opponentOffers = offersBy(view, opponent(view.role));
    const myOffers = offersBy(view, view.role);
    const lastOpponentOffer = opponentOffers.at(-1);

    // 마지막 턴에는 제시해도 받아줄 사람이 없으므로, 한도 안이면 수락하고 아니면 결렬한다.
    if (view.turnNo === view.maxTurns) {
      return lastOpponentOffer !== undefined && withinLimit(view, lastOpponentOffer)
        ? say(view, kind, { type: "accept" }, lastOpponentOffer)
        : say(view, kind, { type: "walk_away" }, null);
    }

    const next =
      kind === "mirror" ? mirrorOffer(view, myOffers, opponentOffers) : timeDependentOffer(view, BETA[kind]);

    // 상대 제시가 내가 다음에 부를 값만큼 좋으면 받는다.
    if (lastOpponentOffer !== undefined && atLeastAsGood(view, lastOpponentOffer, next)) {
      return say(view, kind, { type: "accept" }, lastOpponentOffer);
    }
    return say(view, kind, { type: "offer", price: next }, next);
  };
}

function timeDependentOffer(view: AgentView, beta: number): number {
  // 판매자는 11턴, 구매자는 10턴이 마지막 제시 기회다. 그때 자기 한도에 닿도록 진행률을 잡는다.
  const lastOfferTurn = view.maxTurns - (view.role === "seller" ? 1 : 2);
  const t = Math.min(1, Math.max(0, (view.turnNo - 1) / (lastOfferTurn - 1)));
  const anchor = anchorPrice(view);
  return clampToLimit(view, anchor + (view.myLimit - anchor) * t ** (1 / beta));
}

// 상대가 직전에 양보한 만큼만 양보한다.
function mirrorOffer(view: AgentView, myOffers: number[], opponentOffers: number[]): number {
  const myLast = myOffers.at(-1);
  if (myLast === undefined) return clampToLimit(view, anchorPrice(view));
  const width = view.scenario.marketHigh - view.scenario.marketLow;
  const [prev, last] = opponentOffers.slice(-2);
  const step =
    last !== undefined && prev !== undefined ? Math.max(0, concession(view, prev, last)) : width * MIRROR_OPENING_STEP;
  return clampToLimit(view, view.role === "seller" ? myLast - step : myLast + step);
}

function anchorPrice(view: AgentView): number {
  const { marketLow, marketHigh } = view.scenario;
  const margin = (marketHigh - marketLow) * ANCHOR_RATIO;
  return view.role === "seller" ? marketHigh + margin : marketLow - margin;
}

// 상대 입장에서 본 양보 폭. 판매자는 값을 내리고 구매자는 값을 올리는 것이 양보다.
function concession(view: AgentView, prev: number, last: number): number {
  return view.role === "seller" ? last - prev : prev - last;
}

// 판매자는 올림, 구매자는 내림으로 반올림해 한도를 넘지 않게 한다.
function clampToLimit(view: AgentView, price: number): number {
  if (view.role === "seller") return Math.max(view.myLimit, Math.ceil(price / PRICE_UNIT) * PRICE_UNIT);
  return Math.max(PRICE_UNIT, Math.min(view.myLimit, Math.floor(price / PRICE_UNIT) * PRICE_UNIT));
}

function withinLimit(view: AgentView, price: number): boolean {
  return view.role === "seller" ? price >= view.myLimit : price <= view.myLimit;
}

function atLeastAsGood(view: AgentView, offered: number, mine: number): boolean {
  return withinLimit(view, offered) && (view.role === "seller" ? offered >= mine : offered <= mine);
}

function offersBy(view: AgentView, side: AgentView["role"]): number[] {
  return view.history.flatMap((t) => (t.side === side && t.action.type === "offer" ? [t.action.price] : []));
}

function opponent(side: AgentView["role"]): AgentView["role"] {
  return side === "seller" ? "buyer" : "seller";
}

const won = (price: number) => `${price.toLocaleString("ko-KR")}원`;

const LINES: Record<HouseBotKind, { seller: string[]; buyer: string[] }> = {
  holdout: {
    seller: ["{p} 아래로는 생각 없어요.", "급하게 팔 생각은 없습니다. {p}이요.", "{p}. 더 내리기는 어렵네요."],
    buyer: ["{p}이면 바로 살게요.", "제 예산은 {p}까지예요.", "{p} 이상은 힘들어요."],
  },
  conceder: {
    seller: ["{p} 어떠세요? 맞춰 드릴게요.", "그럼 {p}까지 내려 드릴게요.", "{p}에 거래하시죠."],
    buyer: ["{p} 정도 생각하고 있어요.", "조금 더 올려서 {p} 드릴게요.", "{p}이면 어떨까요?"],
  },
  mirror: {
    seller: ["{p}에 드릴게요.", "양보해 주신 만큼 저도 내려서 {p}요.", "{p}입니다. 그쪽이 움직이면 저도 움직여요."],
    buyer: ["{p}에 사고 싶어요.", "내려 주신 만큼 올려서 {p}요.", "{p}입니다. 그쪽이 움직이면 저도 움직여요."],
  },
};

function say(view: AgentView, kind: HouseBotKind, action: TurnOutput["action"], price: number | null): TurnOutput {
  const lines = LINES[kind][view.role];
  const offerLine = lines[Math.floor((view.turnNo - 1) / 2) % lines.length]!;
  const message =
    action.type === "offer"
      ? offerLine.replace("{p}", won(action.price))
      : action.type === "accept"
        ? `좋아요, ${won(price!)}에 거래하죠.`
        : "이번 거래는 어렵겠네요.";
  const privateNote = `${HOUSE_BOT_NAMES[kind]} ${view.turnNo}/${view.maxTurns}턴: ${
    action.type === "offer" ? `${won(action.price)} 제시` : action.type === "accept" ? "수락" : "결렬"
  }, 내 한도 ${won(view.myLimit)}`;
  return { message, privateNote, action };
}
