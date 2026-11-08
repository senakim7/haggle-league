import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type { Db } from "./index";
import * as schema from "./schema";

const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

// Docker 없이 테스트하려고 메모리 안의 실제 Postgres(PGlite)에 같은 마이그레이션을 적용한다.
export async function createTestDb(): Promise<Db & { $close: () => Promise<void> }> {
  const client = new PGlite();
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return Object.assign(db as unknown as Db, { $close: () => client.close() });
}
