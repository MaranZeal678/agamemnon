import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load root .env + the local Convex deployment env (for CONVEX_URL).
export function loadEnv() {
  for (const p of ["../../../.env", "../.env.local"]) {
    try {
      for (const line of readFileSync(resolve(__dirname, p), "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
      }
    } catch {
      /* ignore */
    }
  }
}

export interface ChatResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
}

export async function chat(
  model: string,
  messages: { role: string; content: string }[],
  opts: { temperature?: number; maxTokens?: number; timeoutMs?: number } = {},
): Promise<ChatResult> {
  const key = process.env.NEBIUS_API_KEY;
  const base = process.env.NEBIUS_BASE_URL ?? "https://api.studio.nebius.com/v1/";
  if (!key) throw new Error("NEBIUS_API_KEY missing");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 45000);
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(new URL("chat/completions", base), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: opts.temperature ?? 0,
        max_tokens: opts.maxTokens ?? 256,
        messages,
      }),
    });
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) throw new Error(`nebius ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return {
    content: data?.choices?.[0]?.message?.content ?? "",
    promptTokens: data?.usage?.prompt_tokens ?? 0,
    completionTokens: data?.usage?.completion_tokens ?? 0,
    latencyMs,
  };
}

// Approximate Nebius list prices (USD per 1M tokens). Used for cost/call.
export const PRICES: Record<string, { in: number; out: number }> = {
  "Qwen/Qwen3-30B-A3B-Instruct-2507": { in: 0.1, out: 0.3 },
  "google/gemma-3-27b-it": { in: 0.1, out: 0.3 },
  "meta-llama/Llama-3.3-70B-Instruct": { in: 0.13, out: 0.4 },
  "deepseek-ai/DeepSeek-V4-Pro": { in: 0.6, out: 1.8 },
};

export function costUsd(model: string, promptTokens: number, completionTokens: number): number {
  const p = PRICES[model] ?? { in: 0.2, out: 0.6 };
  return (promptTokens * p.in + completionTokens * p.out) / 1_000_000;
}

export function extractJson<T>(raw: string): T {
  const match = raw.match(/[\[{][\s\S]*[\]}]/);
  if (!match) throw new Error("no JSON in output");
  return JSON.parse(match[0]) as T;
}
