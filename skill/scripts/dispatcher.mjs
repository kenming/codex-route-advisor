import { classifyMainUserTurn } from "./request-classifier.mjs";

function invalidDecision(message) {
  const error = new Error(message);
  error.code = "invalid_effective_routing_decision";
  throw error;
}

function validateDecision(decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) {
    invalidDecision("EffectiveRoutingDecision must be an object");
  }
  if (typeof decision.model !== "string" || !decision.model.trim()) {
    invalidDecision("EffectiveRoutingDecision.model must be a non-empty string");
  }
  if (typeof decision.reasoningEffort !== "string" || !decision.reasoningEffort.trim()) {
    invalidDecision("EffectiveRoutingDecision.reasoningEffort must be a non-empty string");
  }
  if (decision.dispatchStatus !== "not_dispatched") {
    invalidDecision("EffectiveRoutingDecision.dispatchStatus must be not_dispatched before dispatch");
  }

  return {
    model: decision.model.trim(),
    reasoningEffort: decision.reasoningEffort.trim(),
  };
}

function isResponsesRequest(method, url) {
  return method === "POST" && /\/responses(?:\?|$)/u.test(url ?? "");
}

function rewriteBody(body, target) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Responses request body must be a JSON object");
    error.code = "invalid_dispatch_request";
    throw error;
  }

  return {
    ...body,
    model: target.model,
    reasoning: {
      ...(body.reasoning ?? {}),
      effort: target.reasoningEffort,
    },
  };
}

export function dispatchResponsesRequest({
  decision,
  method,
  url,
  headers,
  body,
} = {}) {
  if (!isResponsesRequest(method, url)) {
    return {
      action: "forward_unchanged",
      rewriteApplied: false,
      classification: null,
      target: null,
      decision,
      body,
    };
  }

  const classification = classifyMainUserTurn(headers);
  if (!classification.isMainUserTurn) {
    return {
      action: "forward_unchanged",
      rewriteApplied: false,
      classification,
      target: null,
      decision,
      body,
    };
  }

  const target = validateDecision(decision);
  return {
    action: "rewrite_main_user_turn",
    rewriteApplied: true,
    classification,
    target,
    decision: { ...decision, dispatchStatus: "dispatched" },
    body: rewriteBody(body, target),
  };
}
