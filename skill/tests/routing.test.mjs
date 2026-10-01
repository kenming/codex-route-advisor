import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRoutingDecision,
  routeTask,
} from "../scripts/routing.mjs";

test("router decisions use the locked four-tier taxonomy", () => {
  for (const tier of ["fast", "balanced", "strong", "long"]) {
    const result = normalizeRoutingDecision({
      tier,
      confidence: 0.9,
      reason: "deterministic test reason",
    }, "model");
    assert.equal(result.tier, tier);
  }
});

test("legacy semantic route names are rejected", () => {
  assert.throws(
    () => normalizeRoutingDecision({
      tier: "advisor_deep",
      confidence: 0.9,
      reason: "legacy",
    }, "model"),
    (error) => error.code === "invalid_response",
  );
});

test("Jev success is authoritative above the confidence threshold", async () => {
  let modelCalls = 0;
  const result = await routeTask({
    task: "bounded task",
    routerPreference: { backend: "auto", prefer: "jev" },
    jevRouter: async () => ({
      tier: "fast",
      confidence: 0.91,
      reason: "well-scoped implementation",
    }),
    modelRouter: async () => {
      modelCalls += 1;
      return { tier: "strong", confidence: 0.9, reason: "unused" };
    },
  });

  assert.equal(result.backend, "jev");
  assert.equal(result.tier, "fast");
  assert.equal(result.fallback, null);
  assert.equal(modelCalls, 0);
});

test("Jev unavailable falls back to Model Router", async () => {
  const result = await routeTask({
    task: "task without Jev",
    routerPreference: { backend: "auto", prefer: "jev" },
    modelRouter: async () => ({
      tier: "balanced",
      confidence: 0.9,
      reason: "ordinary engineering judgment",
    }),
  });

  assert.equal(result.backend, "model");
  assert.equal(result.tier, "balanced");
  assert.deepEqual(result.fallback, { from: "jev", reason: "unavailable" });
});

test("Jev low confidence delegates to Model Router once", async () => {
  let modelCalls = 0;
  const result = await routeTask({
    task: "ambiguous task",
    routerPreference: { backend: "auto", prefer: "jev" },
    jevRouter: async () => ({
      tier: "balanced",
      confidence: 0.2,
      reason: "ambiguous signal",
    }),
    modelRouter: async (_task, context) => {
      modelCalls += 1;
      assert.equal(context.reason, "low_confidence");
      return {
        tier: "strong",
        confidence: 0.9,
        reason: "cross-subsystem diagnosis",
      };
    },
  });

  assert.equal(result.backend, "model");
  assert.equal(result.tier, "strong");
  assert.deepEqual(result.fallback, { from: "jev", reason: "low_confidence" });
  assert.equal(modelCalls, 1);
});

test("Jev backend failure preserves the concrete fallback reason", async () => {
  const result = await routeTask({
    task: "task",
    routerPreference: { backend: "auto", prefer: "jev" },
    jevRouter: async () => {
      const error = new Error("network");
      error.code = "network_error";
      throw error;
    },
    modelRouter: async (_task, context) => {
      assert.equal(context.reason, "network_error");
      return {
        tier: "balanced",
        confidence: 0.9,
        reason: "fallback classification",
      };
    },
  });

  assert.deepEqual(result.fallback, { from: "jev", reason: "network_error" });
});

test("explicit model backend bypasses Jev", async () => {
  let jevCalls = 0;
  const result = await routeTask({
    task: "task",
    routerPreference: { backend: "model" },
    jevRouter: async () => {
      jevCalls += 1;
      return { tier: "fast", confidence: 1, reason: "unused" };
    },
    modelRouter: async () => ({
      tier: "balanced",
      confidence: 0.9,
      reason: "selected model router",
    }),
  });

  assert.equal(result.backend, "model");
  assert.equal(result.tier, "balanced");
  assert.equal(jevCalls, 0);
});

test("low-confidence Model Router requests clarification instead of escalating", async () => {
  await assert.rejects(
    () => routeTask({
      task: "underspecified task",
      routerPreference: { backend: "model" },
      modelRouter: async () => ({
        tier: "strong",
        confidence: 0.2,
        reason: "not enough requirements",
      }),
    }),
    (error) => (
      error.code === "clarification_required"
      && error.confidence === 0.2
    ),
  );
});

test("reason and confidence are required by the backend-neutral contract", () => {
  assert.throws(
    () => normalizeRoutingDecision({ tier: "fast", confidence: 0.9 }, "model"),
    (error) => error.code === "invalid_response" && error.field === "reason",
  );
  assert.throws(
    () => normalizeRoutingDecision({ tier: "fast", reason: "ok" }, "model"),
    (error) => error.code === "invalid_response",
  );
});

test("clarification after Jev fallback preserves the fallback source and reason", async () => {
  await assert.rejects(
    () => routeTask({
      task: "still ambiguous after Jev",
      routerPreference: { backend: "auto", prefer: "jev" },
      jevRouter: async () => ({
        tier: "balanced",
        confidence: 0.2,
        reason: "ambiguous Jev signal",
      }),
      modelRouter: async () => ({
        tier: "strong",
        confidence: 0.3,
        reason: "still missing task requirements",
      }),
    }),
    (error) => (
      error.code === "clarification_required"
      && error.confidence === 0.3
      && error.fallback?.from === "jev"
      && error.fallback?.reason === "low_confidence"
    ),
  );
});
