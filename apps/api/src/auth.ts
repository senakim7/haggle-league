import { account, type Db, session, user, verification } from "@haggle/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  github?: { clientId: string; clientSecret: string };
  kakao?: { clientId: string; clientSecret: string };
  // 개발·테스트에서만 켜는 이메일 로그인. OAuth 앱 없이 로그인 흐름을 시험하려고 둔다.
  devLogin: boolean;
}

export function createAuth(db: Db, env: AuthEnv) {
  return betterAuth({
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.webOrigin],
    database: drizzleAdapter(db as Parameters<typeof drizzleAdapter>[0], {
      provider: "pg",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: env.devLogin },
    socialProviders: {
      ...(env.github && { github: { ...env.github, mapProfileToUser: () => ({ image: undefined }) } }),
      ...(env.kakao && {
        kakao: {
          ...env.kakao,
          // 비즈 앱이 아니면 이메일 동의항목을 쓸 수 없다. 닉네임만 받고 이메일 자리에는 실제가 아닌 주소를 넣는다.
          disableDefaultScope: true,
          scope: ["profile_nickname"],
          mapProfileToUser: (profile: { id: number }) => ({
            email: `kakao-${profile.id}@users.haggle.invalid`,
            emailVerified: false,
            image: undefined,
          }),
        },
      }),
    },
    user: {
      additionalFields: { role: { type: "string", defaultValue: "user", input: false } },
    },
    telemetry: { enabled: false },
  });
}

export type Auth = ReturnType<typeof createAuth>;
