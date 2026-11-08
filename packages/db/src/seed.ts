import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { devScenarios } from "@haggle/scenarios";
import { createDb, scenarios } from "./index";

// 개발 DB에만 쓴다. 운영 DB의 시즌 시나리오는 레포 밖에서 넣는다(AGENTS.md 불변식 6).
const root = process.env.INIT_CWD ?? process.cwd();
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);
if (process.env.NODE_ENV === "production") throw new Error("운영 환경에는 개발용 시나리오를 넣지 않습니다.");

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다.");

const db = createDb(url);
await db.insert(scenarios).values(devScenarios).onConflictDoNothing();
await db.$close();
console.log(`개발용 시나리오 ${devScenarios.length}개 확인`);
