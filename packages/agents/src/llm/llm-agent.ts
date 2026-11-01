import type { Agent, AgentView } from "@haggle/engine";
import { type StrategyCard, TurnOutput } from "@haggle/schema";
import { APICallError, generateText, type LanguageModel, NoObjectGeneratedError, Output } from "ai";
import { buildPrompt } from "./prompt";
import type { QuotaGuard } from "./quota";

// LLM 호출 한 번의 기록. 턴 로그의 tokens_in, tokens_out, latency_ms가 여기서 나온다.
export interface LlmCallLog {
  turnNo: number;
  role: AgentView["role"];
  isRetry: boolean; // 엔진이 형식·규칙 오류로 다시 시킨 호출인지
  attempt: number; // 같은 요청을 공급사 오류로 다시 보낸 횟수(0부터)
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  result: "ok" | "invalid_output" | "provider_error";
  error?: string;
}

export interface LlmAgentOptions {
  model: LanguageModel;
  strategy: StrategyCard;
  guard?: QuotaGuard;
  temperature?: number;
  // 공급사 오류(429, 5xx)에 대한 재시도. 시도마다 쿼터를 따로 센다.
  providerRetries?: number;
  backoffMs?: number;
  onCall?: (log: LlmCallLog) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function createLlmAgent(options: LlmAgentOptions): Agent {
  const {
    model,
    strategy,
    guard,
    temperature = 0.7,
    providerRetries = 2,
    backoffMs = 2_000,
    onCall,
    now = Date.now,
    sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  return async (view: AgentView): Promise<unknown> => {
    const { system, prompt } = buildPrompt(view, strategy);
    const base = { turnNo: view.turnNo, role: view.role, isRetry: view.retryError !== undefined };

    for (let attempt = 0; ; attempt++) {
      await guard?.reserve();
      const started = now();
      try {
        // SDK의 자체 재시도는 끈다. 재시도도 쿼터를 쓰므로 우리가 세면서 직접 한다.
        const result = await generateText({
          model,
          system,
          prompt,
          temperature,
          maxRetries: 0,
          output: Output.object({ schema: TurnOutput, name: "turn" }),
        });
        onCall?.({ ...base, attempt, ...tokens(result.usage), latencyMs: now() - started, result: "ok" });
        return result.output;
      } catch (error) {
        const latencyMs = now() - started;
        // 형식이 틀린 출력은 엔진에 그대로 넘긴다. 엔진이 오류 내용을 붙여 한 번 다시 시킨다.
        if (NoObjectGeneratedError.isInstance(error)) {
          onCall?.({ ...base, attempt, ...tokens(error.usage), latencyMs, result: "invalid_output", error: error.message });
          return parseLoosely(error.text);
        }
        onCall?.({ ...base, attempt, inputTokens: 0, outputTokens: 0, latencyMs, result: "provider_error", error: String(error) });
        // 공급사 장애가 계속되면 던진다. 엔진은 그대로 전달하고, 경기 무효 처리는 호출한 쪽이 한다.
        if (!isRetryable(error) || attempt >= providerRetries) throw error;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
  };
}

function tokens(usage: { inputTokens: number | undefined; outputTokens: number | undefined } | undefined) {
  return { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 };
}

function isRetryable(error: unknown): boolean {
  return APICallError.isInstance(error) && error.isRetryable;
}

function parseLoosely(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
