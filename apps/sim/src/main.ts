// 하우스 봇끼리 리그를 돌리고 점수 계산을 독립적으로 다시 검증한다.
// 사용법: pnpm sim -- --matches 100 --seed 1 [--out out/sim.jsonl]

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createHouseBot, HOUSE_BOT_NAMES, type HouseBotKind } from "@haggle/agents";
import { type BoutResult, deriveSeed, type Limits, type MatchResult, runBout } from "@haggle/engine";
import { devScenarios } from "@haggle/scenarios";

const { values } = parseArgs({
  // `pnpm sim -- --matches 100`처럼 구분자를 붙여도 동작하게 한다.
  args: process.argv.slice(2).filter((arg, i) => !(i === 0 && arg === "--")),
  options: {
    matches: { type: "string", default: "100" },
    seed: { type: "string", default: "1" },
    out: { type: "string" },
  },
});

const totalMatches = Number(values.matches);
const baseSeed = Number(values.seed) >>> 0;
if (!Number.isInteger(totalMatches) || totalMatches <= 0 || totalMatches % 2 !== 0) {
  console.error("--matches는 2의 배수인 양의 정수여야 합니다(한 대결이 2경기).");
  process.exit(2);
}

const KINDS: HouseBotKind[] = ["holdout", "conceder", "mirror"];
// 같은 봇끼리 붙는 경우도 넣어 역할 교대의 대칭성을 함께 본다.
const PAIRS: [HouseBotKind, HouseBotKind][] = KINDS.flatMap((a, i) => KINDS.slice(i).map((b) => [a, b] as [HouseBotKind, HouseBotKind]));

interface BoutLog {
  index: number;
  scenarioId: string;
  seed: number;
  a: HouseBotKind;
  b: HouseBotKind;
  result: BoutResult;
}

const bouts: BoutLog[] = [];
for (let index = 0; index < totalMatches / 2; index++) {
  const scenario = devScenarios[index % devScenarios.length]!;
  const [a, b] = PAIRS[index % PAIRS.length]!;
  const seed = deriveSeed(baseSeed, index);
  const result = await runBout({ scenario, seed, a: createHouseBot(a), b: createHouseBot(b) });
  bouts.push({ index, scenarioId: scenario.id, seed, a, b, result });
}

// ── 검증: 엔진의 점수 함수를 쓰지 않고 정의에서 다시 계산한다 ──
const EPS = 1e-9;
const violations: string[] = [];

function verifyMatch(where: string, m: MatchResult, { sellerFloor: s, buyerCeiling: b }: Limits) {
  const fail = (msg: string) => violations.push(`${where}: ${msg}`);
  if (m.turns.length > 12) fail(`턴 수 ${m.turns.length} > 12`);
  m.turns.forEach((t, i) => {
    if (t.turnNo !== i + 1) fail(`턴 번호 ${t.turnNo} (기대 ${i + 1})`);
    if (t.valid && t.action?.type === "offer") {
      if (t.side === "seller" && t.action.price < s) fail(`판매자가 최저가 아래 ${t.action.price} 제시`);
      if (t.side === "buyer" && t.action.price > b) fail(`구매자가 예산 위 ${t.action.price} 제시`);
    }
  });
  if (m.outcome === "deal") {
    const p = m.finalPrice;
    if (p === null) return fail("성사인데 거래가 없음");
    if (p < s || p > b) fail(`한도 밖 거래 ${p} (한도 ${s}~${b})`);
    if (Math.abs(m.sellerScore - (p - s) / (b - s)) > EPS) fail(`판매자 점수 불일치 ${m.sellerScore}`);
    if (Math.abs(m.buyerScore - (b - p) / (b - s)) > EPS) fail(`구매자 점수 불일치 ${m.buyerScore}`);
    if (Math.abs(m.sellerScore + m.buyerScore - 1) > EPS) fail("점수 합이 1이 아님");
  } else if (m.outcome === "forfeit") {
    // 하우스 봇은 규칙을 어기지 않게 만들었으므로 기권 자체가 버그다.
    fail(`${m.forfeitedBy} 기권: ${m.turns.at(-1)?.error}`);
  } else if (m.sellerScore !== 0 || m.buyerScore !== 0 || m.finalPrice !== null) {
    fail(`결렬인데 점수 ${m.sellerScore}/${m.buyerScore}`);
  }
}

for (const { index, a, b, result } of bouts) {
  verifyMatch(`대결 ${index} 1경기`, result.first, result.limits);
  verifyMatch(`대결 ${index} 2경기`, result.second, result.limits);
  const aTotal = result.first.sellerScore + result.second.buyerScore;
  const bTotal = result.first.buyerScore + result.second.sellerScore;
  const expected = Math.abs(aTotal - bTotal) < EPS ? "draw" : aTotal > bTotal ? "a" : "b";
  if (result.winner !== expected) violations.push(`대결 ${index} (${a} vs ${b}): 승자 ${result.winner}, 기대 ${expected}`);
}

// ── 집계 ──
const matches = bouts.flatMap((x) => [
  { seller: x.a, buyer: x.b, m: x.result.first },
  { seller: x.b, buyer: x.a, m: x.result.second },
]);
const outcomes = countBy(matches.map((x) => x.m.outcome));
const deals = matches.filter((x) => x.m.outcome === "deal");

interface BotStats {
  wins: number;
  draws: number;
  losses: number;
  sellerScores: number[];
  buyerScores: number[];
  deals: number;
  matches: number;
}
const stats = new Map<HouseBotKind, BotStats>(
  KINDS.map((k) => [k, { wins: 0, draws: 0, losses: 0, sellerScores: [], buyerScores: [], deals: 0, matches: 0 }]),
);
for (const { a, b, result } of bouts) {
  if (a === b) continue; // 같은 봇끼리의 승패는 순위에 넣지 않는다
  const sa = stats.get(a)!;
  const sb = stats.get(b)!;
  if (result.winner === "draw") (sa.draws++, sb.draws++);
  else if (result.winner === "a") (sa.wins++, sb.losses++);
  else (sb.wins++, sa.losses++);
}
for (const { seller, buyer, m } of matches) {
  const ss = stats.get(seller)!;
  const sb = stats.get(buyer)!;
  ss.sellerScores.push(m.sellerScore);
  sb.buyerScores.push(m.buyerScore);
  for (const s of [ss, sb]) {
    s.matches++;
    if (m.outcome === "deal") s.deals++;
  }
}

console.log(`\n흥정 리그 시뮬레이션: ${bouts.length}대결 / ${matches.length}경기 (seed ${baseSeed})\n`);
console.log(
  `결과: 성사 ${outcomes.deal ?? 0} · 12턴 소진 ${outcomes.timeout ?? 0} · 결렬 선언 ${outcomes.walk_away ?? 0} · 기권 ${outcomes.forfeit ?? 0}`,
);
console.log(
  `성사 경기 평균 턴 ${avg(deals.map((x) => x.m.turns.length)).toFixed(1)}, 평균 판매자 점수 ${avg(deals.map((x) => x.m.sellerScore)).toFixed(3)}\n`,
);
console.table(
  Object.fromEntries(
    KINDS.map((k) => {
      const s = stats.get(k)!;
      return [
        HOUSE_BOT_NAMES[k],
        {
          "승-무-패": `${s.wins}-${s.draws}-${s.losses}`,
          "성사율": pct(s.deals / s.matches),
          "판매자 평균": avg(s.sellerScores).toFixed(3),
          "구매자 평균": avg(s.buyerScores).toFixed(3),
          "경기": s.matches,
        },
      ];
    }),
  ),
);

const pairTable: Record<string, Record<string, string>> = {};
for (const [a, b] of PAIRS) {
  const rows = matches.filter((x) => (x.seller === a && x.buyer === b) || (x.seller === b && x.buyer === a));
  const key = `${HOUSE_BOT_NAMES[a]} vs ${HOUSE_BOT_NAMES[b]}`;
  const asSeller = (kind: HouseBotKind) => avg(rows.filter((x) => x.seller === kind).map((x) => x.m.sellerScore));
  pairTable[key] = {
    "경기": String(rows.length),
    "성사율": pct(rows.filter((x) => x.m.outcome === "deal").length / rows.length),
    [`판매자일 때 점수`]: a === b ? asSeller(a).toFixed(3) : `${asSeller(a).toFixed(3)} / ${asSeller(b).toFixed(3)}`,
  };
}
console.table(pairTable);

if (values.out) {
  // pnpm은 패키지 폴더에서 스크립트를 실행하므로, 명령을 친 위치(INIT_CWD) 기준으로 경로를 푼다.
  const outPath = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, bouts.map((x) => JSON.stringify(x)).join("\n") + "\n");
  console.log(`경기 기록: ${outPath}`);
}

if (violations.length > 0) {
  console.error(`\n검증 실패 ${violations.length}건:`);
  for (const v of violations.slice(0, 20)) console.error(`  - ${v}`);
  process.exit(1);
}
console.log(`\n검증 통과: 한도 밖 거래 0건, 점수 재계산 불일치 0건, 기권 0건 (${matches.length}경기)`);

function countBy<T extends string>(items: T[]): Partial<Record<T, number>> {
  const out: Partial<Record<T, number>> = {};
  for (const item of items) out[item] = (out[item] ?? 0) + 1;
  return out;
}

function avg(xs: number[]): number {
  return xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function pct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}
