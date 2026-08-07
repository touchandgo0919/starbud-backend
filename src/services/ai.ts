import type { Env } from "../types";

const DEFAULT_BASE_URL = "https://api.openai.com";
const DEFAULT_MODEL = "gpt-5.5";
const DEFAULT_PROVIDER = "OpenAI";
const DEFAULT_REASONING_EFFORT = "xhigh";
const DEFAULT_RESPONSES_PATH = "/v1/responses";
const REASONING_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh"]);

export interface AiConfig {
  provider: string;
  baseUrl: string;
  responsesPath: string;
  model: string;
  reasoningEffort: string;
  responseStorageEnabled: false;
}

export interface CreateAiResponseOptions {
  input: unknown;
  instructions?: string;
  maxOutputTokens?: number;
  text?: Record<string, unknown>;
}

function withoutTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
}

function normalizePath(value: string) {
  return value.startsWith("/") ? value : `/${value}`;
}

export function getAiConfig(env: Env): AiConfig {
  const reasoningEffort = (env.AI_REASONING_EFFORT || DEFAULT_REASONING_EFFORT).toLowerCase();
  if (!REASONING_EFFORTS.has(reasoningEffort)) {
    throw new Error(`Unsupported AI_REASONING_EFFORT: ${reasoningEffort}`);
  }

  return {
    provider: env.AI_PROVIDER?.trim() || DEFAULT_PROVIDER,
    baseUrl: withoutTrailingSlash(env.AI_BASE_URL?.trim() || DEFAULT_BASE_URL),
    responsesPath: normalizePath(env.AI_RESPONSES_PATH?.trim() || DEFAULT_RESPONSES_PATH),
    model: env.AI_MODEL?.trim() || DEFAULT_MODEL,
    reasoningEffort,
    responseStorageEnabled: false
  };
}

export function isAiConfigured(env: Env) {
  return Boolean(env.OPENAI_API_KEY?.trim());
}

export async function createAiResponse(env: Env, options: CreateAiResponseOptions) {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured.");

  const config = getAiConfig(env);
  const response = await fetch(`${config.baseUrl}${config.responsesPath}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: config.model,
      input: options.input,
      ...(options.instructions ? { instructions: options.instructions } : {}),
      ...(options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {}),
      ...(options.text ? { text: options.text } : {}),
      reasoning: { effort: config.reasoningEffort },
      store: false
    })
  });

  if (!response.ok) {
    const requestId = response.headers.get("x-request-id");
    throw new Error(`AI provider request failed (${response.status})${requestId ? ` [${requestId}]` : ""}.`);
  }

  return response.json<unknown>();
}
