import type { QuotaStore } from "@haggle/agents";
import type { Redis } from "ioredis";

// 여러 워커 프로세스가 같은 하루 카운터를 보도록 Redis에 둔다. 키에 날짜가 있으니 이틀 뒤 지운다.
const TTL_SECONDS = 2 * 24 * 60 * 60;

export class RedisQuotaStore implements QuotaStore {
  constructor(
    private readonly redis: Redis,
    private readonly prefix = "quota:",
  ) {}

  async get(key: string) {
    return Number((await this.redis.get(this.prefix + key)) ?? 0);
  }

  async increment(key: string) {
    const [[, count]] = (await this.redis
      .multi()
      .incr(this.prefix + key)
      .expire(this.prefix + key, TTL_SECONDS)
      .exec()) as [[Error | null, number], [Error | null, number]];
    return count;
  }
}
