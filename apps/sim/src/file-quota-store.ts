import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { QuotaStore } from "@haggle/agents";

// CLI를 여러 번 실행해도 하루 호출 수가 이어서 세어지도록 파일에 남긴다. 워커는 Redis 구현을 쓴다.
export class FileQuotaStore implements QuotaStore {
  constructor(private readonly path: string) {}

  async get(key: string) {
    return this.read()[key] ?? 0;
  }

  async increment(key: string) {
    const counts = this.read();
    counts[key] = (counts[key] ?? 0) + 1;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(counts, null, 2));
    return counts[key];
  }

  private read(): Record<string, number> {
    try {
      return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, number>;
    } catch {
      return {};
    }
  }
}
