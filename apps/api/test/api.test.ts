import { matches, scenarios } from "@haggle/db";
import { createTestDb } from "@haggle/db/testing";
import { devScenarios } from "@haggle/scenarios";
import type { StrategyCard } from "@haggle/schema";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app";
import { createAuth } from "../src/auth";

const ORIGIN = "http://localhost:3000";
const strategy: StrategyCard = { prompt: "세게 시작하고 천천히 양보한다.", params: { openingAggression: 70, concessionSpeed: 30 } };

let db: Awaited<ReturnType<typeof createTestDb>>;
let app: ReturnType<typeof createApp>;
const enqueued: string[] = [];
let clock = new Date("2026-11-09T03:00:00Z"); // 한국 시간 낮 12시

beforeAll(async () => {
  db = await createTestDb();
  await db.insert(scenarios).values(devScenarios);
  const auth = createAuth(db, {
    secret: "test-secret-test-secret-test-secret-0123",
    baseURL: "http://localhost:8787",
    webOrigin: ORIGIN,
    devLogin: true,
  });
  app = createApp({
    db,
    auth,
    webOrigin: ORIGIN,
    queue: { enqueue: async (id) => void enqueued.push(id) },
    now: () => clock,
    randomSeed: () => 12345,
  });
});
afterAll(() => db.$close());

async function signUp(name: string): Promise<string> {
  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email: `${name}@test.invalid`, password: "password-1234", name }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie).toContain("session_token");
  return cookie;
}

function call(cookie: string | null, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: {
      origin: ORIGIN,
      ...(cookie && { cookie }),
      ...(body !== undefined && { "content-type": "application/json" }),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

describe("API", () => {
  let alice: string;
  let bob: string;
  let agentId: string;

  beforeAll(async () => {
    alice = await signUp("alice");
    bob = await signUp("bob");
  });

  it("requires login", async () => {
    expect((await call(null, "GET", "/api/agents")).status).toBe(401);
    expect((await call(null, "POST", "/api/agents", { name: "x", strategy })).status).toBe(401);
  });

  it("blocks cross-origin writes", async () => {
    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { origin: "https://evil.example", cookie: alice, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", strategy }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects JSON smuggled as text/plain, which a cross-site form could send", async () => {
    const res = await app.request("/api/agents", {
      method: "POST",
      headers: { cookie: alice, "content-type": "text/plain" },
      body: JSON.stringify({ name: "x", strategy }),
    });
    expect(res.status).toBe(400);
  });

  it("creates an agent with version 1 active", async () => {
    const res = await call(alice, "POST", "/api/agents", { name: "버티기 1호", strategy });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; version: number; activeVersionId: string };
    expect(body.version).toBe(1);
    agentId = body.id;
  });

  it("rejects invalid strategies", async () => {
    const res = await call(alice, "POST", "/api/agents", { name: "긴 전략", strategy: { ...strategy, prompt: "가".repeat(1001) } });
    expect(res.status).toBe(400);
  });

  it("caps agents at 3 per user", async () => {
    await call(alice, "POST", "/api/agents", { name: "2호", strategy });
    await call(alice, "POST", "/api/agents", { name: "3호", strategy });
    expect((await call(alice, "POST", "/api/agents", { name: "4호", strategy })).status).toBe(409);
    expect((await call(bob, "POST", "/api/agents", { name: "밥 1호", strategy })).status).toBe(201);
  });

  it("adds a version only when the strategy changes", async () => {
    const same = await call(alice, "POST", `/api/agents/${agentId}/versions`, { strategy });
    expect(same.status).toBe(200);
    expect(await same.json()).toMatchObject({ version: 1, created: false });

    const changed = await call(alice, "POST", `/api/agents/${agentId}/versions`, {
      strategy: { ...strategy, params: { ...strategy.params, concessionSpeed: 60 } },
    });
    expect(changed.status).toBe(201);
    expect(await changed.json()).toMatchObject({ version: 2, created: true });

    const detail = (await (await call(alice, "GET", `/api/agents/${agentId}`)).json()) as { versions: { version: number }[] };
    expect(detail.versions.map((v) => v.version)).toEqual([2, 1]);
  });

  it("hides other users' agents as not found", async () => {
    expect((await call(bob, "GET", `/api/agents/${agentId}`)).status).toBe(404);
    expect((await call(bob, "POST", `/api/agents/${agentId}/versions`, { strategy })).status).toBe(404);
    expect((await call(bob, "POST", "/api/practice", { agentId, opponent: "mirror" })).status).toBe(404);
    const list = (await (await call(bob, "GET", "/api/agents")).json()) as { id: string }[];
    expect(list.map((a) => a.id)).not.toContain(agentId);
  });

  it("queues practice matches and caps them at 3 per Seoul day", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await call(alice, "POST", "/api/practice", { agentId, opponent: "conceder", role: i === 0 ? "seller" : "buyer" });
      expect(res.status).toBe(202);
      ids.push(((await res.json()) as { matchId: string }).matchId);
    }
    expect(enqueued).toEqual(ids);
    expect((await call(alice, "POST", "/api/practice", { agentId, opponent: "conceder" })).status).toBe(429);

    const [first] = await db.select().from(matches).where(eq(matches.id, ids[0]!));
    expect(first).toMatchObject({ status: "queued", sellerHouseBot: null, buyerHouseBot: "conceder" });

    clock = new Date("2026-11-09T15:00:00Z"); // 한국 시간 다음 날 0시
    expect((await call(alice, "POST", "/api/practice", { agentId, opponent: "conceder" })).status).toBe(202);
  });

  it("does not expose limits or private notes before the match is done", async () => {
    const [m] = await db.select().from(matches).limit(1);
    const res = await call(null, "GET", `/api/matches/${m!.id}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("limits");
    expect(JSON.stringify(body)).not.toContain(String(m!.sellerFloor));
    expect(JSON.stringify(body)).not.toContain(String(m!.buyerCeiling));
  });
});
