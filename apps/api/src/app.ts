import { createHash, getRandomValues } from "node:crypto";
import { agents, agentVersions, type Db, matches, scenarios, turns, user } from "@haggle/db";
import { drawLimits } from "@haggle/engine";
import { HouseBotKind, Scenario, Side, StrategyCard } from "@haggle/schema";
import { and, asc, count, desc, eq, gte } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { Auth } from "./auth";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export const MAX_AGENTS_PER_USER = 3;
export const PRACTICE_PER_DAY = 3;

export interface MatchQueue {
  enqueue(matchId: string): Promise<void>;
}

export interface AppDeps {
  db: Db;
  auth: Auth;
  queue: MatchQueue;
  webOrigin: string;
  // 연습 횟수는 한국 시간 하루 단위로 센다. 테스트에서 시계를 바꿀 수 있게 주입한다.
  now?: () => Date;
  randomSeed?: () => number;
}

type Env = { Variables: { userId: string | null } };

const CreateAgentBody = z.object({ name: z.string().trim().min(1).max(30), strategy: StrategyCard });
const NewVersionBody = z.object({ strategy: StrategyCard });
const PracticeBody = z.object({ agentId: z.uuid(), opponent: HouseBotKind, role: Side.default("seller") });

export function createApp(deps: AppDeps) {
  const { db, auth, queue, webOrigin } = deps;
  const now = deps.now ?? (() => new Date());
  const randomSeed = deps.randomSeed ?? (() => getRandomValues(new Uint32Array(1))[0]!);
  const app = new Hono<Env>();

  app.use("/api/*", cors({ origin: webOrigin, credentials: true }));
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));
  // 쿠키 인증을 쓰므로 다른 출처에서 온 쓰기 요청은 막는다. hono/csrf는 폼 형식 요청만 검사해서 직접 확인한다.
  // Origin이 없는 요청(모바일 앱 등 브라우저 밖)은 남의 쿠키를 실어 올 수 없으므로 통과시킨다.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (!SAFE_METHODS.has(c.req.method) && origin !== undefined && origin !== webOrigin) {
      return c.json({ error: "허용되지 않은 출처입니다" }, 403);
    }
    await next();
  });
  app.use("/api/*", async (c, next) => {
    const s = await auth.api.getSession({ headers: c.req.raw.headers });
    c.set("userId", s?.user.id ?? null);
    await next();
  });

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "서버 오류" }, 500);
  });

  app.get("/api/me", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "로그인이 필요합니다" }, 401);
    const [me] = await db.select({ id: user.id, name: user.name, role: user.role }).from(user).where(eq(user.id, userId));
    return c.json(me);
  });

  app.get("/api/agents", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "로그인이 필요합니다" }, 401);
    const rows = await db
      .select({ id: agents.id, name: agents.name, activeVersionId: agents.activeVersionId, version: agentVersions.version })
      .from(agents)
      .leftJoin(agentVersions, eq(agentVersions.id, agents.activeVersionId))
      .where(eq(agents.ownerId, userId))
      .orderBy(asc(agents.createdAt));
    return c.json(rows);
  });

  app.post("/api/agents", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "로그인이 필요합니다" }, 401);
    const body = await parseBody(c, CreateAgentBody);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const created = await db.transaction(async (tx) => {
      // 동시에 두 요청이 와도 3개를 넘지 않도록 사용자 행을 잠근 뒤 센다.
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
      const [{ n }] = (await tx.select({ n: count() }).from(agents).where(eq(agents.ownerId, userId))) as [{ n: number }];
      if (n >= MAX_AGENTS_PER_USER) return null;
      const [agent] = await tx.insert(agents).values({ ownerId: userId, name: body.data.name }).returning();
      const [version] = await tx.insert(agentVersions).values(versionRow(agent!.id, 1, body.data.strategy)).returning();
      await tx.update(agents).set({ activeVersionId: version!.id }).where(eq(agents.id, agent!.id));
      return { ...agent!, activeVersionId: version!.id, version: version!.version };
    });
    if (!created) return c.json({ error: `에이전트는 ${MAX_AGENTS_PER_USER}개까지 만들 수 있습니다` }, 409);
    return c.json(created, 201);
  });

  app.get("/api/agents/:id", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "로그인이 필요합니다" }, 401);
    const agent = await ownAgent(c.req.param("id"), userId);
    if (!agent) return c.json({ error: "에이전트를 찾을 수 없습니다" }, 404);
    // 전략 프롬프트는 주인만 본다. 이 경로는 ownAgent를 통과한 주인에게만 열려 있다.
    const versions = await db
      .select({
        id: agentVersions.id,
        version: agentVersions.version,
        strategyPrompt: agentVersions.strategyPrompt,
        params: agentVersions.params,
        createdAt: agentVersions.createdAt,
      })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, agent.id))
      .orderBy(desc(agentVersions.version));
    return c.json({ ...agent, versions });
  });

  app.post("/api/agents/:id/versions", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "로그인이 필요합니다" }, 401);
    const agent = await ownAgent(c.req.param("id"), userId);
    if (!agent) return c.json({ error: "에이전트를 찾을 수 없습니다" }, 404);
    const body = await parseBody(c, NewVersionBody);
    if (!body.ok) return c.json({ error: body.error }, 400);

    const result = await db.transaction(async (tx) => {
      await tx.select({ id: agents.id }).from(agents).where(eq(agents.id, agent.id)).for("update");
      const [latest] = await tx
        .select()
        .from(agentVersions)
        .where(eq(agentVersions.agentId, agent.id))
        .orderBy(desc(agentVersions.version))
        .limit(1);
      const row = versionRow(agent.id, (latest?.version ?? 0) + 1, body.data.strategy);
      const active = latest && latest.id === agent.activeVersionId ? latest : null;
      // 내용이 같으면 새 버전을 만들지 않는다. 저장 버튼을 여러 번 눌러도 버전이 늘지 않게.
      if (active && active.contentHash === row.contentHash) return { version: active, created: false };
      const [version] = await tx.insert(agentVersions).values(row).returning();
      await tx.update(agents).set({ activeVersionId: version!.id }).where(eq(agents.id, agent.id));
      return { version: version!, created: true };
    });
    return c.json(
      { id: result.version.id, version: result.version.version, created: result.created },
      result.created ? 201 : 200,
    );
  });

  app.post("/api/practice", async (c) => {
    const userId = requireUser(c);
    if (!userId) return c.json({ error: "로그인이 필요합니다" }, 401);
    const body = await parseBody(c, PracticeBody);
    if (!body.ok) return c.json({ error: body.error }, 400);
    const agent = await ownAgent(body.data.agentId, userId);
    if (!agent?.activeVersionId) return c.json({ error: "에이전트를 찾을 수 없습니다" }, 404);

    const pool = await db.select().from(scenarios).where(eq(scenarios.active, true)).orderBy(asc(scenarios.id));
    if (pool.length === 0) return c.json({ error: "시나리오가 없습니다" }, 503);
    const seed = randomSeed();
    const scenario = Scenario.parse(pool[seed % pool.length]);
    const limits = drawLimits(scenario, seed);
    const mine = body.data.role;

    const match = await db.transaction(async (tx) => {
      // 무료 쿼터를 지키려고 연습은 하루 3회로 막는다. 동시 요청이 한도를 넘지 않게 사용자 행을 잠근다.
      await tx.select({ id: user.id }).from(user).where(eq(user.id, userId)).for("update");
      const [{ n }] = (await tx
        .select({ n: count() })
        .from(matches)
        .where(
          and(eq(matches.requestedBy, userId), eq(matches.kind, "practice"), gte(matches.createdAt, startOfSeoulDay(now()))),
        )) as [{ n: number }];
      if (n >= PRACTICE_PER_DAY) return null;
      const [row] = await tx
        .insert(matches)
        .values({
          kind: "practice",
          requestedBy: userId,
          scenarioId: scenario.id,
          seed,
          sellerFloor: limits.sellerFloor,
          buyerCeiling: limits.buyerCeiling,
          sellerVersionId: mine === "seller" ? agent.activeVersionId : null,
          buyerVersionId: mine === "buyer" ? agent.activeVersionId : null,
          sellerHouseBot: mine === "seller" ? null : body.data.opponent,
          buyerHouseBot: mine === "buyer" ? null : body.data.opponent,
        })
        .returning({ id: matches.id });
      return row!;
    });
    if (!match) return c.json({ error: `연습 경기는 하루 ${PRACTICE_PER_DAY}회까지입니다` }, 429);

    try {
      await queue.enqueue(match.id);
    } catch (err) {
      console.error(err);
      await db.update(matches).set({ status: "void", voidReason: "큐에 넣지 못함" }).where(eq(matches.id, match.id));
      return c.json({ error: "경기를 시작하지 못했습니다" }, 503);
    }
    return c.json({ matchId: match.id }, 202);
  });

  // 관전·다시보기용 공개 조회. 한도와 속마음은 경기가 끝난 뒤에만 담는다. 전략 프롬프트는 담지 않는다.
  app.get("/api/matches/:id", async (c) => {
    const id = z.uuid().safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "경기를 찾을 수 없습니다" }, 404);
    const [m] = await db.select().from(matches).where(eq(matches.id, id.data));
    if (!m) return c.json({ error: "경기를 찾을 수 없습니다" }, 404);
    const done = m.status === "done";
    const rows = await db.select().from(turns).where(eq(turns.matchId, m.id)).orderBy(asc(turns.turnNo));
    return c.json({
      id: m.id,
      kind: m.kind,
      status: m.status,
      scenarioId: m.scenarioId,
      sellerHouseBot: m.sellerHouseBot,
      buyerHouseBot: m.buyerHouseBot,
      outcome: m.outcome,
      finalPrice: m.finalPrice,
      sellerScore: m.sellerScore,
      buyerScore: m.buyerScore,
      voidReason: m.voidReason,
      ...(done && { limits: { sellerFloor: m.sellerFloor, buyerCeiling: m.buyerCeiling } }),
      turns: rows.map((t) => ({
        turnNo: t.turnNo,
        side: t.side,
        message: t.message,
        action: t.action,
        price: t.price,
        valid: t.valid,
        ...(done && { privateNote: t.privateNote }),
      })),
    });
  });

  async function ownAgent(id: string, userId: string) {
    if (!z.uuid().safeParse(id).success) return null;
    const [row] = await db
      .select({ id: agents.id, name: agents.name, activeVersionId: agents.activeVersionId })
      .from(agents)
      .where(and(eq(agents.id, id), eq(agents.ownerId, userId)));
    // 남의 에이전트도 "없음"으로 답한다. 존재 여부를 알려 주지 않기 위해서다.
    return row ?? null;
  }

  return app;
}

function requireUser(c: Context<Env>): string | null {
  return c.get("userId");
}

async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  // text/plain 본문은 다른 사이트의 폼이 사전 확인(preflight) 없이 보낼 수 있으므로 JSON 형식만 받는다.
  if (!c.req.header("content-type")?.startsWith("application/json")) {
    return { ok: false, error: "본문은 application/json이어야 합니다" };
  }
  const raw = await c.req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

function versionRow(agentId: string, version: number, strategy: StrategyCard) {
  const contentHash = createHash("sha256").update(JSON.stringify([strategy.prompt, strategy.params])).digest("hex");
  return { agentId, version, strategyPrompt: strategy.prompt, params: strategy.params, contentHash };
}

// 한국은 서머타임이 없어 UTC+9로 고정이다.
export function startOfSeoulDay(at: Date): Date {
  const kst = new Date(at.getTime() + 9 * 3_600_000);
  return new Date(Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3_600_000);
}
