import test from "node:test";
import assert from "node:assert/strict";

import {
  assessBoundedTaskWithJev,
  buildJevRoutingRequest,
} from "../scripts/jev-assessor.mjs";

function boundedTask() {
  return {
    id: "T1",
    goal: "Diagnose a cross-subsystem failure",
    context: { summary: "Failure spans API and persistence" },
    dependsOn: [],
    deliverable: "Root cause and verified fix",
    acceptance: ["Regression test passes"],
    conditional: false,
    boundaryReason: "Independent diagnosis boundary",
  };
}

test("Jev routing request asks a Choice over the four canonical tiers", () => {
  const request = buildJevRoutingRequest(boundedTask());
  assert.equal(request.model, "jev-latest");
  assert.deepEqual(
    Object.keys(request.questions.routing_tier.criteria),
    ["fast", "balanced", "strong", "long"],
  );
  assert.equal(request.questions.routing_tier.type, "choice");
  assert.equal(request.state.goal, "Diagnose a cross-subsystem failure");
});
test("production Jev assessor converts Choice response to routing decision", async () => {
  let observed;
  const decision = await assessBoundedTaskWithJev(boundedTask(), {
    apiKey: "test-key",
    fetchImpl: async (url, options) => {
      observed = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          model: "jev-1.13.0",
          answers: {
            routing_tier: {
              type: "choice",
              choice: "strong",
              confidence: 0.88,
              probabilities: {
                fast: 0.01,
                balanced: 0.1,
                strong: 0.85,
                long: 0.04,
              },
            },
          },
        }),
      };
    },
  });

  assert.equal(observed.url, "https://api.typesafe.ai/v1/systemone");
  assert.match(observed.options.headers.authorization, /^Bearer /);
  assert.equal(JSON.parse(observed.options.body).questions.routing_tier.type, "choice");
  assert.deepEqual(decision, {
    tier: "strong",
    confidence: 0.88,
    reason: "Jev selected strong as the minimum sufficient routing tier",
  });
});

test("production Jev assessor reports missing credential as fallback-compatible unavailable", async () => {
  await assert.rejects(
    () => assessBoundedTaskWithJev(boundedTask(), { apiKey: "" }),
    (error) => error.code === "missing_api_key",
  );
});

test("production Jev assessor rejects malformed routing answers", async () => {
  await assert.rejects(
    () => assessBoundedTaskWithJev(boundedTask(), {
      apiKey: "test-key",
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          answers: {
            routing_tier: {
              type: "choice",
              choice: "unknown",
              confidence: 0.9,
            },
          },
        }),
      }),
    }),
    (error) => error.code === "invalid_response",
  );
});
