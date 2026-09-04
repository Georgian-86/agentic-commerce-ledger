// The growth layer: what this agent is worth to the merchant.
//
// One soft "uplift %" off two demo orders invites the obvious
// objection — n is tiny, so the number means little. So the numbers
// here are framed as a small P&L for agent traffic, and each one is
// labelled with the sample it came from rather than presented as a
// projection:
//
//   settled GMV       ₹ that actually cleared Razorpay from agent
//                     sessions. Counted on verified payment, never on
//                     an intent to pay.
//   upsell uplift     baseline (cart before any suggestion) vs actual.
//   refused spend     ₹ the Gate declined to move. This is the number
//                     no one else will show, and for a payments company
//                     it is the interesting one: unauthorised spend
//                     that never became a dispute.
//   conversion        sessions that reached a verified payment.
//
// Upsell ranking is plain arithmetic on purpose. If a judge asks "why
// did it suggest that?", the answer is a sentence, not a model.
import { catalog } from "./mcpClient.js";

const state = {
  baseline_paise: 0,
  settled_paise: 0,
  refunded_paise: 0,
  blocked_paise: 0,
  orders_settled: 0,
  upsells_offered: 0,
  upsells_accepted: 0,
  sessions_started: 0,
  blocked_attempts: 0,
};

/**
 * Rank a product's catalogue-linked companions by an explainable score:
 *   score = margin_pct + 10 (flat bonus for being merchant-curated)
 * and return the single best one, with the arithmetic attached so the
 * reasoning can be read off the screen rather than asserted.
 */
export async function bestUpsell(product_id) {
  const related = await catalog.getRelated(product_id);
  if (!related?.related?.length) return null;

  const scored = await Promise.all(
    related.related.map(async (r) => {
      const full = await catalog.getProduct(r.id).catch(() => null);
      const margin = full?.margin_pct || 0;
      const score = margin + 10;
      return {
        ...r,
        price_paise: full?.price_paise ?? r.price_paise,
        margin_pct: margin,
        score,
        rationale: `margin ${margin}% + 10 (merchant-curated companion) = ${score}`,
      };
    })
  );
  scored.sort((a, b) => b.score - a.score);
  const winner = scored[0];
  if (winner) state.upsells_offered += 1;
  return winner;
}

export function recordSessionStarted() {
  state.sessions_started += 1;
}

export function recordCompletedOrder({ baseline_paise, actual_paise, upsell_accepted }) {
  state.baseline_paise += baseline_paise;
  state.settled_paise += actual_paise;
  state.orders_settled += 1;
  if (upsell_accepted) state.upsells_accepted += 1;
}

export function recordBlockedSpend(amount_paise) {
  state.blocked_paise += amount_paise;
  state.blocked_attempts += 1;
}

export function recordRefund(amount_paise) {
  state.refunded_paise += amount_paise;
  state.settled_paise = Math.max(0, state.settled_paise - amount_paise);
  state.orders_settled = Math.max(0, state.orders_settled - 1);
}

export function metrics() {
  const uplift_paise = state.settled_paise - state.baseline_paise;
  const uplift_pct = state.baseline_paise > 0 ? (uplift_paise / state.baseline_paise) * 100 : 0;
  const conversion_pct = state.sessions_started > 0 ? (state.orders_settled / state.sessions_started) * 100 : 0;

  return {
    // Headline: money that actually moved.
    settled_gmv_paise: state.settled_paise,
    orders_settled: state.orders_settled,

    // Upsell contribution, with its own sample size attached so the
    // percentage is never read without knowing what it's over.
    baseline_paise: state.baseline_paise,
    uplift_paise,
    uplift_pct: Number(uplift_pct.toFixed(1)),
    upsells_offered: state.upsells_offered,
    upsells_accepted: state.upsells_accepted,

    // The trust layer's return: spend the Gate refused to move.
    refused_spend_paise: state.blocked_paise,
    blocked_attempts: state.blocked_attempts,

    refunded_paise: state.refunded_paise,
    sessions_started: state.sessions_started,
    conversion_pct: Number(conversion_pct.toFixed(1)),

    sample_note:
      state.orders_settled === 0
        ? "No settled orders yet — every figure here stays at zero until a payment is actually verified."
        : `Computed over ${state.orders_settled} settled order${state.orders_settled === 1 ? "" : "s"} in this session. Small n, stated rather than hidden.`,
  };
}

export function resetGrowth() {
  Object.keys(state).forEach((k) => {
    state[k] = 0;
  });
}
