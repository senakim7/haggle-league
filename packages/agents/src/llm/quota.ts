import type { FreeModel } from "./models";

// 공급사가 429로 막기 전에 우리가 먼저 멈춘다. 공식 한도의 80%를 넘기지 않는다.
export const QUOTA_SAFETY_RATIO = 0.8;

// 워커에서는 Redis, CLI에서는 파일로 구현한다. 키에 날짜가 들어가므로 하루가 지나면 새로 센다.
export interface QuotaStore {
  get(key: string): Promise<number>;
  increment(key: string): Promise<number>;
}

export class MemoryQuotaStore implements QuotaStore {
  private readonly counts = new Map<string, number>();
  async get(key: string) {
    return this.counts.get(key) ?? 0;
  }
  async increment(key: string) {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
}

export class QuotaExceededError extends Error {
  constructor(
    readonly modelKey: string,
    readonly used: number,
    readonly cap: number,
  ) {
    super(`${modelKey}의 오늘 호출이 자체 한도 ${cap}회에 닿았습니다(공식 한도의 ${QUOTA_SAFETY_RATIO * 100}%).`);
  }
}

export interface QuotaGuardOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class QuotaGuard {
  readonly dailyCap: number;
  private readonly minuteCap: number;
  private readonly recent: number[] = [];
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly store: QuotaStore,
    private readonly model: FreeModel,
    options: QuotaGuardOptions = {},
  ) {
    this.dailyCap = Math.floor(model.limits.requestsPerDay * QUOTA_SAFETY_RATIO);
    this.minuteCap = Math.max(1, Math.floor(model.limits.requestsPerMinute * QUOTA_SAFETY_RATIO));
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  // Gemini의 일일 한도는 태평양 시간 자정에 초기화된다. 다른 공급사도 같은 기준으로 세면 더 보수적이다.
  dayKey(): string {
    const day = new Date(this.now()).toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
    return `${this.model.key}:${day}`;
  }

  async usedToday(): Promise<number> {
    return this.store.get(this.dayKey());
  }

  // 호출 한 번마다 부른다. 일일 상한이면 던지고, 분당 상한이면 자리가 날 때까지 기다린다.
  async reserve(): Promise<void> {
    const used = await this.usedToday();
    if (used >= this.dailyCap) throw new QuotaExceededError(this.model.key, used, this.dailyCap);

    while (true) {
      const windowStart = this.now() - 60_000;
      while (this.recent.length > 0 && this.recent[0]! <= windowStart) this.recent.shift();
      if (this.recent.length < this.minuteCap) break;
      await this.sleep(this.recent[0]! - windowStart);
    }
    this.recent.push(this.now());
    await this.store.increment(this.dayKey());
  }
}
