import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDb } from "@haggle/db";
import { MATCH_QUEUE, type MatchJob } from "@haggle/schema";
import { serve } from "@hono/node-server";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createApp } from "./app";
import { createAuth } from "./auth";

const root = process.env.INIT_CWD ?? process.cwd();
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}이(가) 없습니다. .env를 확인하세요.`);
  return value;
}

const devLogin = process.env.AUTH_DEV_LOGIN === "1";
if (devLogin && process.env.NODE_ENV === "production") {
  throw new Error("AUTH_DEV_LOGIN은 운영 환경에서 켤 수 없습니다.");
}
const pair = (id?: string, secret?: string) => (id && secret ? { clientId: id, clientSecret: secret } : undefined);
const github = pair(process.env.GITHUB_CLIENT_ID, process.env.GITHUB_CLIENT_SECRET);
const kakao = pair(process.env.KAKAO_CLIENT_ID, process.env.KAKAO_CLIENT_SECRET);

const db = createDb(required("DATABASE_URL"));
const webOrigin = required("WEB_ORIGIN");
const auth = createAuth(db, {
  secret: required("BETTER_AUTH_SECRET"),
  baseURL: required("BETTER_AUTH_URL"),
  webOrigin,
  devLogin,
  ...(github && { github }),
  ...(kakao && { kakao }),
});

const queue = new Queue<MatchJob>(MATCH_QUEUE, { connection: new Redis(required("REDIS_URL"), { maxRetriesPerRequest: null }) });
const app = createApp({
  db,
  auth,
  webOrigin,
  queue: {
    async enqueue(matchId) {
      // 작업 ID = 경기 ID. 같은 경기를 두 번 넣어도 BullMQ가 하나만 받는다.
      await queue.add("match", { matchId }, { jobId: matchId, attempts: 1, removeOnComplete: 1_000, removeOnFail: 5_000 });
    },
  },
});

const port = Number(process.env.PORT ?? 8787);
serve({ fetch: app.fetch, port });
console.log(`API http://localhost:${port} (로그인: ${[github && "GitHub", kakao && "카카오", devLogin && "개발용 이메일"].filter(Boolean).join(", ") || "없음"})`);
