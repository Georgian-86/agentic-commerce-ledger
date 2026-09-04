// Provider-agnostic OpenAI-compatible chat client.
//
// Zero-cost by default: LLM_BASE_URL points at Groq's free API unless
// you switch it to a local Ollama endpoint in .env. The code is the
// same either way.
//
// Everything beyond the bare fetch exists because this runs live in
// front of people:
//   - a hard timeout, so a stalled provider fails in 30s instead of
//     hanging the turn until the browser gives up
//   - retry with backoff on 429 and 5xx, because free tiers rate-limit
//     and a demo shouldn't die on one throttled request
//   - a model fallback chain, because hosted model catalogues change
//     underneath you (the model this project was first built against
//     was retired mid-build)
//   - usage accounting, so the dashboard can show what the agent
//     actually cost to run
const BASE_URL = (process.env.LLM_BASE_URL || "https://api.groq.com/openai/v1").replace(/\/$/, "");
const API_KEY = process.env.LLM_API_KEY || "";
const PRIMARY_MODEL = process.env.LLM_MODEL || "openai/gpt-oss-120b";
const FALLBACK_MODELS = (process.env.LLM_FALLBACK_MODELS || "llama-3.3-70b-versatile,llama-3.1-8b-instant")
  .split(",")
  .map((m) => m.trim())
  .filter(Boolean);

const REQUEST_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 30000);
const MAX_ATTEMPTS = 3;

const usage = { calls: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, retries: 0, fallbacks: 0, failures: 0 };
let activeModel = PRIMARY_MODEL;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callOnce({ model, messages, tools, response_format, temperature, signal }) {
  const body = { model, messages, temperature };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = "auto";
  }
  if (response_format) body.response_format = response_format;

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`LLM request failed (${res.status}): ${text.slice(0, 400)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return res.json();
}

/**
 * @param {Array<object>} messages          OpenAI-style chat messages
 * @param {Array<object>} [tools]           OpenAI-style tool definitions
 * @param {object}        [opts]
 * @param {boolean}       [opts.json]       ask for a JSON object response
 * @param {number}        [opts.temperature]
 * @returns {Promise<object>} the assistant message
 */
export async function chat(messages, tools = [], opts = {}) {
  const { json = false, temperature = 0.3 } = opts;
  const candidates = [activeModel, ...FALLBACK_MODELS.filter((m) => m !== activeModel)];
  let lastError = null;

  for (const model of candidates) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const result = await callOnce({
          model,
          messages,
          tools,
          temperature,
          response_format: json ? { type: "json_object" } : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);

        usage.calls += 1;
        if (result.usage) {
          usage.prompt_tokens += result.usage.prompt_tokens || 0;
          usage.completion_tokens += result.usage.completion_tokens || 0;
          usage.total_tokens += result.usage.total_tokens || 0;
        }
        if (model !== activeModel) {
          usage.fallbacks += 1;
          console.warn(`[llm] falling back to ${model} — ${activeModel} was unavailable`);
          activeModel = model;
        }

        const choice = result.choices?.[0];
        if (!choice) throw new Error("LLM response contained no choices");
        return choice.message;
      } catch (err) {
        clearTimeout(timer);
        lastError = err;

        // A missing model is permanent for this model — move to the
        // next candidate immediately rather than retrying into the void.
        const modelGone = err.status === 404 || /model_not_found|does not exist|decommissioned/i.test(err.body || err.message || "");
        if (modelGone) break;

        const retriable = err.name === "AbortError" || err.status === 429 || (err.status >= 500 && err.status < 600);
        if (!retriable || attempt === MAX_ATTEMPTS) break;

        usage.retries += 1;
        await sleep(Math.min(4000, 400 * 2 ** (attempt - 1)));
      }
    }
  }

  usage.failures += 1;
  throw lastError || new Error("LLM request failed for every candidate model");
}

/** Chat that must return JSON. Falls back to `null` rather than throwing,
 *  so a caller can degrade to a deterministic path instead of failing. */
export async function chatJson(messages, opts = {}) {
  try {
    const message = await chat(messages, [], { ...opts, json: true });
    return JSON.parse(message.content || "null");
  } catch {
    return null;
  }
}

export function llmUsage() {
  return { ...usage, model: activeModel, base_url: BASE_URL };
}

export const llmConfig = { baseUrl: BASE_URL, get model() { return activeModel; } };
