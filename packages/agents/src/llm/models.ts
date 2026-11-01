import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createMistral } from "@ai-sdk/mistral";
import type { LanguageModel } from "ai";

// 무료 티어만 쓴다(AGENTS.md 불변식 7). 이 목록에 없는 모델은 어떤 설정으로도 호출할 수 없다.
// 결제가 연결된 키인지는 코드가 알 수 없으므로, 키 관리는 AGENTS.md의 계정 쪽 원칙을 따른다.

export type FreeProvider = "google" | "mistral";

export interface FreeModel {
  key: string;
  provider: FreeProvider;
  modelId: string;
  limits: { requestsPerMinute: number; requestsPerDay: number };
  // 콘솔에서 직접 확인한 한도인지. false면 보수적으로 잡은 추정치다.
  verified: boolean;
}

// 한도 숫자는 2026-10-27 조사에서 자료마다 달라 가장 낮은 값을 썼다. 콘솔 값을 확인하면 고치고 verified를 켠다.
export const FREE_MODELS: readonly FreeModel[] = [
  {
    key: "google/gemini-2.5-flash-lite",
    provider: "google",
    modelId: "gemini-2.5-flash-lite",
    limits: { requestsPerMinute: 15, requestsPerDay: 100 },
    verified: false,
  },
  {
    key: "mistral/mistral-small-latest",
    provider: "mistral",
    modelId: "mistral-small-latest",
    limits: { requestsPerMinute: 2, requestsPerDay: 1_000 },
    verified: false,
  },
];

export const DEFAULT_FREE_MODEL_KEY = "google/gemini-2.5-flash-lite";

const API_KEY_ENV: Record<FreeProvider, string> = {
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

export function resolveFreeModel(key: string): FreeModel {
  const model = FREE_MODELS.find((m) => m.key === key);
  if (!model) {
    throw new Error(`무료 모델 허용 목록에 없는 모델입니다: ${key}. 쓸 수 있는 모델: ${FREE_MODELS.map((m) => m.key).join(", ")}`);
  }
  return model;
}

export function apiKeyEnvName(model: FreeModel): string {
  return API_KEY_ENV[model.provider];
}

export function createLanguageModel(model: FreeModel, env: Record<string, string | undefined>): LanguageModel {
  const envName = apiKeyEnvName(model);
  const apiKey = env[envName];
  if (!apiKey) throw new Error(`${envName}가 없습니다. .env에 무료 티어 키를 넣어 주세요.`);
  switch (model.provider) {
    case "google":
      return createGoogleGenerativeAI({ apiKey })(model.modelId);
    case "mistral":
      return createMistral({ apiKey })(model.modelId);
  }
}
