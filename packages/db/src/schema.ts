import type { LimitRule, StrategyParams } from "@haggle/schema";
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

// ── 인증 (Better Auth 기본 테이블) ──
// 카카오는 비즈 앱이 아니면 이메일을 주지 않는다. Better Auth는 email을 필수로 요구하므로,
// 실제 메일이 아닌 자리표시 주소를 넣는다(auth 설정의 mapProfileToUser). 개인정보는 닉네임과 공급사 계정 ID뿐이다.

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
};

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(), // 닉네임
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  role: text("role").default("user").notNull(),
  ...timestamps,
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    ...timestamps,
  },
  (t) => [index("session_user_idx").on(t.userId)],
);

// 카카오·GitHub 계정 ID는 여기 accountId에 들어간다(설계서의 users.kakao_id, github_id 대신).
export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    ...timestamps,
  },
  (t) => [index("account_user_idx").on(t.userId)],
);

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  ...timestamps,
});

// ── 에이전트 ──

export const MAX_AGENTS_PER_USER = 3;

export const agents = pgTable(
  "agents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    activeVersionId: uuid("active_version_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index("agents_owner_idx").on(t.ownerId)],
);

// 수정하지 않는다. 전략을 바꾸면 새 버전을 쌓아서, 어떤 경기든 당시 전략으로 다시 볼 수 있게 한다.
export const agentVersions = pgTable(
  "agent_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    strategyPrompt: text("strategy_prompt").notNull(),
    params: jsonb("params").$type<StrategyParams>().notNull(),
    contentHash: text("content_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agent_versions_agent_version_uq").on(t.agentId, t.version)],
);

// ── 경기 ──

// 시즌용 비공개 풀은 운영 DB에만 넣는다. 레포의 개발용 시나리오는 seed 스크립트로 개발 DB에만 들어간다.
export const scenarios = pgTable("scenarios", {
  id: text("id").primaryKey(),
  itemTitle: text("item_title").notNull(),
  itemFacts: jsonb("item_facts").$type<string[]>().notNull(),
  marketLow: integer("market_low").notNull(),
  marketHigh: integer("market_high").notNull(),
  limitRule: jsonb("limit_rule").$type<LimitRule>().notNull(),
  active: boolean("active").default(true).notNull(),
});

export const matchStatus = pgEnum("match_status", ["queued", "running", "done", "void"]);
export const matchKind = pgEnum("match_kind", ["practice", "league"]);
export const matchOutcome = pgEnum("match_outcome", ["deal", "walk_away", "timeout", "forfeit"]);
export const side = pgEnum("side", ["seller", "buyer"]);
export const houseBot = pgEnum("house_bot", ["holdout", "conceder", "mirror"]);
export const turnAction = pgEnum("turn_action", ["offer", "accept", "walk_away"]);

// 한쪽은 에이전트 버전, 한쪽은 하우스 봇일 수 있다(연습 경기). 리그 대결(bout)은 5주차에 붙인다.
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    kind: matchKind("kind").notNull(),
    status: matchStatus("status").default("queued").notNull(),
    requestedBy: text("requested_by").references(() => user.id, { onDelete: "set null" }),
    scenarioId: text("scenario_id")
      .notNull()
      .references(() => scenarios.id),
    seed: bigint("seed", { mode: "number" }).notNull(),
    sellerVersionId: uuid("seller_version_id").references(() => agentVersions.id),
    buyerVersionId: uuid("buyer_version_id").references(() => agentVersions.id),
    sellerHouseBot: houseBot("seller_house_bot"),
    buyerHouseBot: houseBot("buyer_house_bot"),
    // 한도는 경기가 끝나기 전에는 어떤 API 응답에도 담지 않는다.
    sellerFloor: integer("seller_floor").notNull(),
    buyerCeiling: integer("buyer_ceiling").notNull(),
    modelKey: text("model_key"),
    outcome: matchOutcome("outcome"),
    finalPrice: integer("final_price"),
    sellerScore: real("seller_score"),
    buyerScore: real("buyer_score"),
    forfeitedBy: side("forfeited_by"),
    voidReason: text("void_reason"),
    // 무료 티어라 비용(원) 대신 호출 수와 토큰을 잰다.
    llmCalls: integer("llm_calls").default(0).notNull(),
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("matches_requested_by_created_idx").on(t.requestedBy, t.createdAt),
    check("matches_seller_one_side", sql`(${t.sellerVersionId} is null) <> (${t.sellerHouseBot} is null)`),
    check("matches_buyer_one_side", sql`(${t.buyerVersionId} is null) <> (${t.buyerHouseBot} is null)`),
    check("matches_limits_ordered", sql`${t.sellerFloor} < ${t.buyerCeiling}`),
  ],
);

// 추가만 하는 로그. (match_id, turn_no) 유니크로 재시도된 턴이 두 번 저장되지 않는다.
export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    matchId: uuid("match_id")
      .notNull()
      .references(() => matches.id, { onDelete: "cascade" }),
    turnNo: integer("turn_no").notNull(),
    side: side("side").notNull(),
    message: text("message").notNull(),
    privateNote: text("private_note").notNull(),
    action: turnAction("action"),
    price: integer("price"),
    valid: boolean("valid").notNull(),
    retries: integer("retries").notNull(),
    error: text("error"),
    tokensIn: integer("tokens_in").default(0).notNull(),
    tokensOut: integer("tokens_out").default(0).notNull(),
    latencyMs: integer("latency_ms").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("turns_match_turn_uq").on(t.matchId, t.turnNo)],
);
