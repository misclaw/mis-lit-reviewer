// BYO-key LLM provider layer. All calls go straight from the browser to the
// provider (Anthropic supports CORS via the dangerous-direct-browser-access
// header; OpenAI and Gemini allow browser calls natively). Keys come from the
// user's local preferences and are sent only to the matching provider.
//
// Three operations, uniform across providers:
//   verifyKey(provider, key)               → cheap authenticated GET
//   chatJSON(provider, key, opts)          → one completion, parsed as JSON
//   webSearchJSON(provider, key, opts)     → same, with the provider's
//                                            web-search tool enabled

// Per-provider model catalogs (curated; ids verified against the live APIs).
// The entry flagged `def` is the default — the balanced tier, NOT the most
// expensive one: these are metered calls on the user's own key, so opting UP
// to the premium model should be a choice, never the silent default.
export const PROVIDERS = {
  anthropic: {
    label: "Claude", ph: "sk-ant-…",
    models: [
      { id: "claude-opus-4-8",  label: "Opus 4.8 — most capable" },
      { id: "claude-sonnet-5",  label: "Sonnet 5 — fast, near-Opus", def: true },
      { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest, cheapest" },
    ],
  },
  openai: {
    label: "GPT", ph: "sk-…",
    models: [
      { id: "gpt-5.6-sol",   label: "GPT-5.6 Sol — most capable" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra — balanced", def: true },
      { id: "gpt-5.6-luna",  label: "GPT-5.6 Luna — light" },
      { id: "gpt-5.5",       label: "GPT-5.5" },
      { id: "gpt-5.4-mini",  label: "GPT-5.4 mini — cheapest" },
    ],
  },
  gemini: {
    label: "Gemini", ph: "AIza…",
    models: [
      { id: "gemini-3.5-flash",      label: "Gemini 3.5 Flash — default", def: true },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (preview)" },
      { id: "gemini-2.5-pro",        label: "Gemini 2.5 Pro" },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite — cheapest" },
    ],
  },
};

export function defaultModel(provider) {
  const list = PROVIDERS[provider]?.models || [];
  return (list.find((m) => m.def) || list[0])?.id;
}
export function modelLabel(provider, id) {
  const m = PROVIDERS[provider]?.models.find((m) => m.id === id);
  return m ? m.label.split(" — ")[0] : id;
}
export function resolveModel(provider, model) {
  const list = PROVIDERS[provider]?.models || [];
  return list.some((m) => m.id === model) ? model : defaultModel(provider);
}

export class LLMError extends Error {
  constructor(provider, message, status = null) {
    super(`${PROVIDERS[provider]?.label || provider}: ${message}`);
    this.provider = provider;
    this.status = status; // HTTP status when the provider rejected the request
  }
}
// 401/403 = the key itself is bad — callers fail fast with a pointed message
// instead of letting the pipeline limp on to a later, more confusing failure.
export const isAuthError = (e) => e?.status === 401 || e?.status === 403;

// Pull the first JSON object/array out of a completion that may wrap it in
// prose or a ```json fence. Throws if nothing parses.
export function extractJSON(text) {
  if (!text) throw new Error("empty completion");
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  for (const open of ["{", "["]) {
    const start = body.indexOf(open);
    if (start < 0) continue;
    const close = open === "{" ? "}" : "]";
    const end = body.lastIndexOf(close);
    if (end > start) {
      try { return JSON.parse(body.slice(start, end + 1)); } catch { /* next */ }
    }
  }
  throw new Error("completion contained no parseable JSON");
}

async function req(provider, url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    throw new LLMError(provider, "network error — " + e.message);
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      detail = j.error?.message || j.error?.status || JSON.stringify(j).slice(0, 200);
    } catch { /* keep status only */ }
    throw new LLMError(provider, `HTTP ${res.status}${detail ? " — " + detail : ""}`, res.status);
  }
  return res.json();
}

// ---- key verification (cheap authenticated GETs; no tokens billed) ----
export async function verifyKey(provider, key) {
  key = key.trim();
  if (!key) throw new LLMError(provider, "no key entered");
  if (provider === "anthropic") {
    await req(provider, "https://api.anthropic.com/v1/models?limit=1", {
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
    });
  } else if (provider === "openai") {
    await req(provider, "https://api.openai.com/v1/models", {
      headers: { Authorization: "Bearer " + key },
    });
  } else if (provider === "gemini") {
    await req(provider, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1", {
      headers: { "x-goog-api-key": key },
    });
  } else throw new LLMError(provider, "unknown provider");
  return true;
}

// ---- completions ----
// opts: { system, user, maxTokens=8192, webSearch=false, model }
async function complete(provider, key, opts) {
  const { system, user, maxTokens = 8192, webSearch = false } = opts;
  const model = resolveModel(provider, opts.model);
  key = key.trim();
  if (!key) throw new LLMError(provider, "no API key configured");

  if (provider === "anthropic") {
    const body = {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    };
    if (webSearch) {
      // Haiku-tier models only support the basic web-search tool variant
      const type = model.includes("haiku") ? "web_search_20250305" : "web_search_20260209";
      body.tools = [{ type, name: "web_search", max_uses: 6 }];
    }
    const j = await req(provider, "https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (j.stop_reason === "refusal") throw new LLMError(provider, "request was declined by safety classifiers");
    return (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  }

  if (provider === "openai") {
    const body = {
      model,
      instructions: system,
      input: user,
      max_output_tokens: maxTokens,
    };
    if (webSearch) body.tools = [{ type: "web_search" }];
    const j = await req(provider, "https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const parts = [];
    for (const item of j.output || []) {
      if (item.type === "message") {
        for (const c of item.content || []) if (c.type === "output_text") parts.push(c.text);
      }
    }
    return parts.join("\n");
  }

  if (provider === "gemini") {
    const body = {
      system_instruction: { parts: [{ text: system }] },
      contents: [{ role: "user", parts: [{ text: user }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    };
    if (webSearch) body.tools = [{ google_search: {} }];
    const j = await req(provider,
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "x-goog-api-key": key, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const cand = j.candidates?.[0];
    return (cand?.content?.parts || []).map((p) => p.text || "").join("");
  }

  throw new LLMError(provider, "unknown provider");
}

export async function chatJSON(provider, key, opts) {
  return extractJSON(await complete(provider, key, { ...opts, webSearch: false }));
}
export async function webSearchJSON(provider, key, opts) {
  return extractJSON(await complete(provider, key, { ...opts, webSearch: true }));
}
