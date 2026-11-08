import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createLanguageModel, createLlmAgent, DEFAULT_FREE_MODEL_KEY, QuotaGuard, resolveFreeModel } from "@haggle/agents";
import { createDb } from "@haggle/db";
import { MATCH_QUEUE, MatchJob } from "@haggle/schema";
import { Worker } from "bullmq";
import { Redis } from "ioredis";
import { executeMatch } from "./execute-match";
import { RedisQuotaStore } from "./redis-quota-store";

const root = process.env.INIT_CWD ?? process.cwd();
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이(가) 없습니다. .env를 확인하세요.`);
  return value;
}

const db = createDb(required("DATABASE_URL"));
const redisUrl = required("REDIS_URL");
// 허용 목록 밖의 모델이면 여기서 바로 실패한다(AGENTS.md 불변식 7).
const freeModel = resolveFreeModel(process.env.LEAGUE_MODEL ?? DEFAULT_FREE_MODEL_KEY);
const guard = new QuotaGuard(new RedisQuotaStore(new Redis(redisUrl)), freeModel);
const model = process.env[`${freeModel.provider === "google" ? "GOOGLE_GENERATIVE_AI_API_KEY" : "MISTRAL_API_KEY"}`]
  ? createLanguageModel(freeModel, process.env)
  : null;

// 공급사 요청 한도에 맞춰 동시에 5경기까지만 돌린다.
const CONCURRENCY = 5;

const worker = new Worker<MatchJob>(
  MATCH_QUEUE,
  async (job) => {
    const { matchId } = MatchJob.parse(job.data);
    const outcome = await executeMatch(db, matchId, {
      modelKey: freeModel.key,
      createVersionAgent: (strategy, onCall) => {
        if (!model) throw new Error(`${freeModel.key}의 API 키가 없습니다.`);
        return createLlmAgent({ model, strategy, guard, onCall });
      },
    });
    console.log(`경기 ${matchId}: ${outcome.status}${outcome.status === "void" ? ` (${outcome.reason})` : ""}`);
    return outcome.status;
  },
  { connection: new Redis(redisUrl, { maxRetriesPerRequest: null }), concurrency: CONCURRENCY },
);

worker.on("failed", (job, err) => console.error(`작업 실패 ${job?.id}:`, err));
console.log(`워커 시작: ${MATCH_QUEUE} 큐, 동시 ${CONCURRENCY}경기, 모델 ${freeModel.key}${model ? "" : " (키 없음: 하우스 봇끼리만 가능)"}`);

const shutdown = async () => {
  await worker.close();
  await db.$close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
