/*
 * Agamemnon — AI-agent write-path guardian
 * Copyright (c) 2026 Elamaran Elangovan. All rights reserved.
 *
 * Proprietary and confidential. No licence is granted to use, copy, modify,
 * distribute, or run this software beyond local evaluation of this repository
 * as published. See LICENSE at the repository root.
 *
 * ref: AGMN-BOZW-F6BTKX-X3LAO
 */

/**
 * Reasoning narration — a GENUINE Nebius LLM call so the words on screen are
 * really a model talking. The SQL the agent executes is NOT model-generated; it
 * is hardcoded and deterministic (see dispatch-copilot.ts). The model only
 * narrates the reasoning in plain English.
 *
 * If the model is unreachable (offline / no key), we fall back to a fixed line
 * so the demo never stalls — but on the day, with the key set, it is the model.
 */
export async function narrate(userPrompt: string, fallback: string): Promise<string> {
  const key = process.env.NEBIUS_API_KEY;
  const base = process.env.NEBIUS_BASE_URL ?? "https://api.studio.nebius.com/v1/";
  const model = process.env.NEBIUS_NARRATOR_MODEL ?? "meta-llama/Llama-3.3-70B-Instruct";
  if (!key) return fallback;

  try {
    const res = await fetch(new URL("chat/completions", base), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model,
        temperature: 0.4,
        max_tokens: 130,
        messages: [
          {
            role: "system",
            content:
              "You are Dispatch Copilot, an autonomous ops agent for a freight brokerage. " +
              "You think out loud in first person, concise and matter-of-fact, 1-2 sentences. " +
              "You are confident and practical. Never mention you are an AI model.",
          },
          { role: "user", content: userPrompt },
        ],
      }),
    });
    if (!res.ok) return fallback;
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : fallback;
  } catch {
    return fallback;
  }
}
