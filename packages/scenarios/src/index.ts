import { type LimitRule, Scenario } from "@haggle/schema";

// 개발·테스트용 시나리오. 레포가 공개되면 누구나 읽을 수 있으므로 시즌 경기에는 쓰지 않는다.
// 시즌용 비공개 풀은 DB에만 두고 레포에 넣지 않는다.
// 시세는 2026년 10월 중고 시세를 어림한 값이다. 시즌 전에 실제 거래가로 다시 확인한다.

const DEFAULT_LIMIT_RULE: LimitRule = {
  floorRange: [-0.1, 0.7],
  ceilingRange: [0.3, 1.1],
  minGapRatio: 0.1,
  roundTo: 1_000,
};

const raw = [
  {
    id: "ipad-air-5-64",
    itemTitle: "아이패드 에어 5세대 Wi-Fi 64GB 스페이스 그레이",
    itemFacts: [
      "A급: 화면과 본체에 눈에 띄는 흠집 없음",
      "배터리 성능 최대치 89%",
      "구성품: 본체, 정품 충전 케이블. 박스 없음",
      "2023년 3월 구입, 애플케어 없음",
    ],
    marketLow: 550_000,
    marketHigh: 650_000,
  },
  {
    id: "macbook-air-m1",
    itemTitle: "맥북 에어 M1 8GB/256GB 실버",
    itemFacts: [
      "B급: 상판 모서리에 작은 찍힘 1곳",
      "배터리 사이클 412회, 성능 최대치 86%",
      "구성품: 본체, 정품 30W 충전기, 박스",
      "키보드·트랙패드 정상 작동",
    ],
    marketLow: 500_000,
    marketHigh: 600_000,
  },
  {
    id: "switch-oled",
    itemTitle: "닌텐도 스위치 OLED 화이트",
    itemFacts: [
      "A급: 화면 보호필름 부착 상태로 사용",
      "조이콘 쏠림 현상 없음",
      "구성품: 본체, 조이콘 2개, 독, 충전기, HDMI 케이블, 박스",
      "게임 타이틀은 포함하지 않음",
    ],
    marketLow: 220_000,
    marketHigh: 280_000,
  },
  {
    id: "airpods-pro-2-usbc",
    itemTitle: "에어팟 프로 2세대 USB-C",
    itemFacts: [
      "케이스에 생활 기스 있음, 유닛은 깨끗함",
      "배터리 정상, 노이즈 캔슬링 정상",
      "구성품: 유닛, 케이스, 미사용 이어팁 2쌍. 케이블 없음",
      "2024년 11월 구입",
    ],
    marketLow: 130_000,
    marketHigh: 170_000,
  },
  {
    id: "galaxy-s23-256",
    itemTitle: "갤럭시 S23 256GB 자급제 크림",
    itemFacts: [
      "S급: 구입 직후부터 케이스와 필름 사용",
      "잔상 없음, 배터리 효율 양호",
      "구성품: 본체, 박스. 충전기 없음",
      "삼성케어플러스 만료",
    ],
    marketLow: 350_000,
    marketHigh: 450_000,
  },
  {
    id: "sony-wh1000xm5",
    itemTitle: "소니 WH-1000XM5 블랙",
    itemFacts: [
      "이어패드 약간 눌림, 찢어짐 없음",
      "노이즈 캔슬링·블루투스 정상",
      "구성품: 헤드폰, 케이스, 케이블 2종",
      "2023년 8월 구입",
    ],
    marketLow: 220_000,
    marketHigh: 280_000,
  },
  {
    id: "dyson-v11",
    itemTitle: "다이슨 V11 무선청소기",
    itemFacts: [
      "배터리 사용 시간 에코 모드 약 40분",
      "필터 세척 완료, 흡입력 정상",
      "구성품: 본체, 헤드 3종, 거치대, 충전기",
      "본체에 사용감 있음",
    ],
    marketLow: 250_000,
    marketHigh: 350_000,
  },
  {
    id: "mx-master-3s",
    itemTitle: "로지텍 MX Master 3S 그래파이트",
    itemFacts: ["클릭·휠 정상, 더블클릭 현상 없음", "구성품: 마우스, USB 리시버, 케이블, 박스", "6개월 사용"],
    marketLow: 60_000,
    marketHigh: 80_000,
  },
  {
    id: "ps5-disc",
    itemTitle: "플레이스테이션 5 디스크 에디션 (CFI-1200)",
    itemFacts: [
      "디스크 드라이브 정상, 팬 소음 거의 없음",
      "듀얼센스 1개 포함, 스틱 쏠림 없음",
      "구성품: 본체, 패드, 전원·HDMI 케이블, 박스",
      "게임 타이틀은 포함하지 않음",
    ],
    marketLow: 380_000,
    marketHigh: 450_000,
  },
  {
    id: "helinox-chair-one",
    itemTitle: "헬리녹스 체어원 블랙",
    itemFacts: ["캠핑 5회 사용", "프레임 휨 없음, 원단에 얼룩 1곳", "구성품: 의자, 수납 파우치"],
    marketLow: 70_000,
    marketHigh: 100_000,
  },
];

export const devScenarios: Scenario[] = raw.map((s) => Scenario.parse({ ...s, limitRule: DEFAULT_LIMIT_RULE }));

export function getDevScenario(id: string): Scenario {
  const found = devScenarios.find((s) => s.id === id);
  if (!found) throw new Error(`unknown scenario: ${id}`);
  return found;
}
