import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const root = process.env.INIT_CWD ?? process.cwd();
const envPath = resolve(root, ".env");
if (existsSync(envPath)) process.loadEnvFile(envPath);

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL이 없습니다.");

const client = postgres(url, { max: 1 });
await migrate(drizzle(client), { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
await client.end();
console.log("마이그레이션 완료");
