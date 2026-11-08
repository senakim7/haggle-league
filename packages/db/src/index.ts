import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { schema };

export function createDb(url: string) {
  const client = postgres(url, { max: 10 });
  return Object.assign(drizzle(client, { schema }), { $close: () => client.end() });
}

// 운영(postgres.js)과 테스트(PGlite)가 같은 쿼리 코드를 쓰도록 공통 타입만 노출한다.
export type Db = Pick<ReturnType<typeof createDb>, "select" | "insert" | "update" | "delete" | "transaction" | "execute" | "query">;
