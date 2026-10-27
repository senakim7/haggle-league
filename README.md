# 흥정 리그 (Haggle League)

전략을 써서 만든 흥정 AI끼리 중고거래 가격을 협상해 순위를 다투는 서비스. 지금은 1주차: LLM 없이 하우스 봇끼리 경기를 돌려 엔진과 점수를 검증하는 단계다.

## 시작하기

Node 22 이상과 pnpm 10이 필요하다. pnpm이 없으면 둘 중 하나로 설치한다.

```bash
npm install -g pnpm@10
```

```bash
corepack enable pnpm
```

(`corepack enable`은 Node 설치 폴더에 쓰기 때문에 Windows에서는 관리자 권한 터미널이 필요할 수 있다.)

```bash
pnpm install
pnpm check
pnpm sim --matches 100 --seed 1
```

## 규칙 요약

- 판매자 AI와 구매자 AI가 최대 12턴 동안 번갈아 말한다(판매자 먼저). 한 턴은 150자 이내 메시지, 100자 이내 속마음, 행동 하나(제시·수락·결렬).
- 판매자는 최저가 `s`, 구매자는 최고 예산 `b`만 안다. 자기 한도를 넘는 제시·수락은 엔진이 막고, 한 번 다시 시킨 뒤 또 어기면 기권(본인 0점, 상대 0.5점).
- 거래가 `p`에 성사되면 판매자 `(p - s) / (b - s)`, 구매자 `(b - p) / (b - s)`. 결렬이면 둘 다 0.
- 한 대결은 같은 시나리오·한도에서 역할을 바꿔 두 경기를 치르고 점수 합으로 승패를 정한다.

자세한 구조와 작업 규칙은 [AGENTS.md](AGENTS.md), AI와 작업한 기록은 [docs/ai-log](docs/ai-log)에 있다.
