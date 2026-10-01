import test from "node:test";
import assert from "node:assert/strict";
import { dispatchResponsesRequest } from "../scripts/dispatcher.mjs";
import { resolveRoutingDecision } from "../scripts/resolver.mjs";

const decision = {
  tier: "strong",
  model: "gpt-5.6-sol",
  modelFamily: "sol",
  reasoningEffort: "xhigh",
  decisionSource: "model",
  confidence: 0.9,
  reason: "test",
  preferenceSource: { model: "workspace", reasoningEffort: "workspace" },
  fallback: null,
  modelFallback: null,
  dispatchStatus: "not_dispatched",
  availability: "validated",
};

const common = {
  request_kind: "turn",
  agent_name: "/root",
  turn_id: "turn-1",
  root_turn_id: "turn-1",
  thread_source: "user",
};

function headers(originator, metadata) {
  return {
    originator,
    "x-codex-turn-metadata": JSON.stringify(metadata),
  };
}

test("rewrites validated CLI main user turn from EffectiveRoutingDecision", () => {
  const body = { model: "gpt-5.6-luna", reasoning: { effort: "medium", summary: "auto" } };
  const result = dispatchResponsesRequest({
    decision,
    method: "POST",
    url: "/responses",
    headers: headers("codex_exec", common),
    body,
  });

  assert.equal(result.action, "rewrite_main_user_turn");
  assert.equal(result.rewriteApplied, true);
  assert.deepEqual(result.target, { model: "gpt-5.6-sol", reasoningEffort: "xhigh" });
  assert.equal(result.body.model, "gpt-5.6-sol");
  assert.deepEqual(result.body.reasoning, { effort: "xhigh", summary: "auto" });
  assert.equal(result.decision.dispatchStatus, "dispatched");
  assert.equal(decision.dispatchStatus, "not_dispatched");
  assert.equal(body.model, "gpt-5.6-luna");
  assert.equal(body.reasoning.effort, "medium");
});

test("rewrites validated App composer turn", () => {
  const result = dispatchResponsesRequest({
    decision,
    method: "POST",
    url: "/responses?stream=true",
    headers: headers("codex_work_desktop", { ...common, turn_trigger: "composer" }),
    body: { model: "source" },
  });

  assert.equal(result.rewriteApplied, true);
  assert.equal(result.classification.reason, "validated_composer_root_user_turn");
  assert.deepEqual(result.body.reasoning, { effort: "xhigh" });
});

test("forwards auxiliary request unchanged", () => {
  const body = { model: "title-model", reasoning: { effort: "low" } };
  const result = dispatchResponsesRequest({
    decision,
    method: "POST",
    url: "/responses",
    headers: headers("codex_vscode", {
      ...common,
      thread_source: "thread_title",
      turn_trigger: "thread_title",
    }),
    body,
  });

  assert.equal(result.action, "forward_unchanged");
  assert.equal(result.rewriteApplied, false);
  assert.equal(result.body, body);
  assert.equal(result.classification.isMainUserTurn, false);
});

test("fails closed for unknown originator", () => {
  const body = { model: "source" };
  const result = dispatchResponsesRequest({
    decision,
    method: "POST",
    url: "/responses",
    headers: headers("future_host", { ...common, turn_trigger: "composer" }),
    body,
  });

  assert.equal(result.rewriteApplied, false);
  assert.equal(result.body, body);
  assert.equal(result.classification.reason, "unsupported_originator");
});

test("forwards non-responses request without classification", () => {
  const body = { model: "source" };
  const result = dispatchResponsesRequest({
    decision,
    method: "GET",
    url: "/models",
    headers: {},
    body,
  });

  assert.equal(result.action, "forward_unchanged");
  assert.equal(result.classification, null);
  assert.equal(result.body, body);
});

test("rejects invalid EffectiveRoutingDecision", () => {
  assert.throws(() => dispatchResponsesRequest({
    decision: { ...decision, dispatchStatus: "dispatched" },
    method: "POST",
    url: "/responses",
    headers: headers("codex_exec", common),
    body: { model: "source" },
  }), (error) => error.code === "invalid_effective_routing_decision");

  assert.throws(() => dispatchResponsesRequest({
    decision: { ...decision, model: "" },
    method: "POST",
    url: "/responses",
    headers: headers("codex_exec", common),
    body: { model: "source" },
  }), (error) => error.code === "invalid_effective_routing_decision");
});

test("rejects invalid main responses JSON body instead of rewriting", () => {
  assert.throws(() => dispatchResponsesRequest({
    decision,
    method: "POST",
    url: "/responses",
    headers: headers("codex_exec", common),
    body: null,
  }), (error) => error.code === "invalid_dispatch_request");
});

test("integrates resolver EffectiveRoutingDecision into dispatcher target", () => {
  const resolved = resolveRoutingDecision({
    decision: {
      tier: "strong",
      confidence: 0.91,
      reason: "cross-subsystem diagnosis",
      backend: "model",
    },
    preferences: {
      strong: { model: "sol", effort: "xhigh" },
    },
    sources: {
      strong: { model: "workspace", effort: "workspace" },
    },
  });

  const result = dispatchResponsesRequest({
    decision: resolved,
    method: "POST",
    url: "/responses",
    headers: headers("codex_vscode", { ...common, turn_trigger: "composer" }),
    body: { model: "source", reasoning: { effort: "medium" } },
  });

  assert.equal(resolved.dispatchStatus, "not_dispatched");
  assert.equal(result.body.model, "sol");
  assert.equal(result.body.reasoning.effort, "xhigh");
  assert.equal(result.decision.dispatchStatus, "dispatched");
});
