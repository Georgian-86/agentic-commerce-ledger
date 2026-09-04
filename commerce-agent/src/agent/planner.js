// The planner: decide what to do before doing it.
//
// A chatbot reacts one message at a time. An agent commits to an
// approach, states it, and can be held to it. Showing the plan before
// execution is what lets a shopper (or a judge) interrupt at the right
// moment — after the intent is visible, before any money moves.
//
// The plan is also a safety artifact, not just a UI flourish. It is
// classified into an intent, and that classification decides whether
// this turn is even allowed to touch the checkout tools. A turn
// classified "browse" cannot call confirm_checkout no matter what the
// model subsequently decides it wants to do, because the executor
// filters the tool list by intent before the model ever sees it.
//
// If the planning call fails or returns nonsense, a deterministic
// keyword fallback produces a serviceable plan. The agent degrades to
// a simpler agent; it never degrades to a crash.
import { chatJson } from "../llmClient.js";

export const INTENTS = {
  browse: {
    label: "Browse & compare",
    tools: ["search_products", "get_product", "get_policies", "check_merchant_policy"],
  },
  draft: {
    label: "Build a cart",
    tools: ["search_products", "get_product", "check_inventory", "get_policies", "draft_order"],
  },
  purchase: {
    label: "Complete a purchase",
    tools: ["get_product", "check_inventory", "draft_order", "confirm_checkout"],
  },
  support: {
    label: "Order support",
    tools: ["get_policies", "get_order_status", "check_merchant_policy"],
  },
  smalltalk: {
    label: "Conversational",
    tools: [],
  },
};

const PLANNER_SYSTEM = `You are the planning stage of a shopping agent that spends real money under a signed mandate.

Given the shopper's latest message and the conversation so far, output a JSON object:
{
  "intent": one of "browse" | "draft" | "purchase" | "support" | "smalltalk",
  "goal": one short sentence describing what the shopper wants, in their terms,
  "steps": [ { "action": short verb phrase, "why": one clause } ],   // 1 to 4 steps
  "constraints": [ short strings for any limit the shopper stated, e.g. "under 1500", "gifting only" ],
  "needs_human_confirmation": boolean   // true if this turn could result in a payment
}

Rules:
- "purchase" only when the shopper has explicitly agreed to buy something specific that is already in a draft. Wanting to buy "something" is "draft", not "purchase".
- Steps describe what YOU will do, not what the shopper should do.
- Never plan more than 4 steps. Fewer is better.
- Output JSON only.`;

function fallbackPlan(userText) {
  const text = String(userText || "").toLowerCase();
  let intent = "browse";
  if (/\b(yes|confirm|go ahead|buy it|pay|checkout|place the order|do it)\b/.test(text)) intent = "purchase";
  else if (/\b(add|cart|order|buy|get me|i'll take|purchase)\b/.test(text)) intent = "draft";
  else if (/\b(return|refund|warranty|shipping|policy|status|where is)\b/.test(text)) intent = "support";
  else if (/^\s*(hi|hey|hello|thanks|thank you|ok|okay)\b/.test(text)) intent = "smalltalk";

  const ceiling = text.match(/(?:under|below|upto|up to|within)\s*(?:₹|rs\.?)?\s*([\d,]+)/i);

  return {
    intent,
    goal: userText ? String(userText).slice(0, 140) : "Respond to the shopper",
    steps:
      intent === "smalltalk"
        ? [{ action: "Reply directly", why: "No catalog lookup needed" }]
        : [
            { action: "Search the catalog", why: "Ground every option in real inventory" },
            { action: "Check what the mandate allows", why: "Only show what can actually be bought" },
          ],
    constraints: ceiling ? [`under ₹${ceiling[1]}`] : [],
    needs_human_confirmation: intent === "purchase",
    source: "deterministic_fallback",
  };
}

function sanitise(plan, userText) {
  if (!plan || typeof plan !== "object") return fallbackPlan(userText);
  const intent = INTENTS[plan.intent] ? plan.intent : fallbackPlan(userText).intent;
  const steps = Array.isArray(plan.steps)
    ? plan.steps
        .filter((s) => s && typeof s.action === "string")
        .slice(0, 4)
        .map((s) => ({ action: String(s.action).slice(0, 90), why: String(s.why || "").slice(0, 120) }))
    : [];
  return {
    intent,
    goal: String(plan.goal || userText || "").slice(0, 160),
    steps: steps.length ? steps : fallbackPlan(userText).steps,
    constraints: Array.isArray(plan.constraints) ? plan.constraints.slice(0, 5).map((c) => String(c).slice(0, 60)) : [],
    needs_human_confirmation: Boolean(plan.needs_human_confirmation) || intent === "purchase",
    source: "model",
  };
}

/**
 * Produce a plan for this turn.
 * @param {object} p
 * @param {string} p.userText
 * @param {Array}  p.history       recent conversation, for context
 * @param {string} [p.memoryBlock] what the agent already knows about this shopper
 */
export async function makePlan({ userText, history = [], memoryBlock = null }) {
  const context = history
    .filter((m) => m.role === "user" || (m.role === "assistant" && m.content))
    .slice(-6)
    .map((m) => `${m.role}: ${String(m.content).slice(0, 300)}`)
    .join("\n");

  const plan = await chatJson(
    [
      { role: "system", content: PLANNER_SYSTEM },
      {
        role: "user",
        content: [
          memoryBlock ? `What we already know about this shopper:\n${memoryBlock}` : null,
          context ? `Conversation so far:\n${context}` : null,
          `Shopper's latest message:\n${userText}`,
        ]
          .filter(Boolean)
          .join("\n\n"),
      },
    ],
    { temperature: 0 }
  );

  return sanitise(plan, userText);
}

/** The tools a turn with this intent is permitted to call. */
export function toolsForIntent(intent) {
  return INTENTS[intent]?.tools ?? INTENTS.browse.tools;
}
