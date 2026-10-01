import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  validateBoundedTask,
  validateDispatchPlan,
} from "../scripts/validate-dispatch-plan.mjs";

const fixtureUrl = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const readJson = (url) => JSON.parse(readFileSync(fileURLToPath(url), "utf8"));

function validTask(overrides = {}) {
  return {
    id: "T1",
    goal: "Make one bounded change",
    context: {},
    dependsOn: [],
    deliverable: "Working change",
    acceptance: ["Focused validation passes"],
    conditional: false,
    boundaryReason: "One routing and validation cycle",
    assessment: { source: "agent", confidence: 0.9 },
    recommendation: { tier: "balanced", effort: "medium" },
    tools: ["code-edit"],
    rationale: "Ordinary bounded engineering work",
    ...overrides,
  };
}

function validPlan(overrides = {}) {
  return {
    version: 1,
    taskSummary: "One bounded change",
    executionMode: "confirm",
    assessmentMode: "agent",
    executionOrder: ["T1"],
    parallelGroups: [],
    tasks: [validTask()],
    ...overrides,
  };
}

test("bounded-task contract accepts one edit plus focused validation", () => {
  const errors = validateBoundedTask(validTask());
  assert.deepEqual(errors, []);
});

test("bounded-task contract rejects malformed conditional shape", () => {
  const errors = validateBoundedTask(validTask({
    conditional: { taskId: "T1", outcome: "sometimes" },
  }));
  assert.ok(errors.some((error) => error.code === "invalid_conditional"));
});

test("valid mixed-source Dispatch Plan fixture passes", () => {
  const plan = readJson(fixtureUrl("dispatch-plan.valid.json"));
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("dependency cycles are rejected deterministically", () => {
  const plan = readJson(fixtureUrl("dispatch-plan.invalid-cycle.json"));
  const result = validateDispatchPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "dependency_cycle"));
});

test("unsupported assessment and routing vocabulary are rejected", () => {
  const plan = readJson(fixtureUrl("dispatch-plan.invalid-vocabulary.json"));
  const result = validateDispatchPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "invalid_assessment_source"));
  assert.ok(result.errors.some((error) => error.code === "invalid_tier"));
  assert.ok(result.errors.some((error) => error.code === "invalid_effort"));
});

test("unknown and self dependencies are rejected", () => {
  const result = validateDispatchPlan(validPlan({
    tasks: [validTask({ dependsOn: ["T1", "T9"] })],
  }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "self_dependency"));
  assert.ok(result.errors.some((error) => error.code === "unknown_dependency"));
});

test("conditional reference must be a declared dependency", () => {
  const plan = validPlan({
    executionOrder: ["T1", "T2"],
    tasks: [
      validTask(),
      validTask({
        id: "T2",
        goal: "Fix only when T1 fails",
        conditional: { taskId: "T1", outcome: "failure" },
      }),
    ],
  });
  const result = validateDispatchPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "conditional_dependency_missing"));
});

test("execution order must include all tasks and respect dependencies", () => {
  const plan = validPlan({
    executionOrder: ["T2", "T1"],
    tasks: [
      validTask(),
      validTask({
        id: "T2",
        goal: "Second task",
        dependsOn: ["T1"],
      }),
    ],
  });
  const result = validateDispatchPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "dependency_order_violation"));
});

test("parallel groups reject dependency-related tasks", () => {
  const plan = validPlan({
    executionOrder: ["T1", "T2"],
    parallelGroups: [["T1", "T2"]],
    tasks: [
      validTask(),
      validTask({
        id: "T2",
        goal: "Second task",
        dependsOn: ["T1"],
      }),
    ],
  });
  const result = validateDispatchPlan(plan);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "parallel_dependency_conflict"));
});

test("executionMode must use plan, confirm, or auto", () => {
  const result = validateDispatchPlan(validPlan({ executionMode: "manual" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "invalid_execution_mode"));
});

test("assessmentMode must match task assessment sources", () => {
  const result = validateDispatchPlan(validPlan({ assessmentMode: "jev" }));
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.code === "assessment_mode_mismatch"));
});

test("contract schemas are valid JSON and expose locked vocabularies", () => {
  const boundedSchema = readJson(new URL("../references/bounded-task.schema.json", import.meta.url));
  const dispatchSchema = readJson(new URL("../references/dispatch-plan.schema.json", import.meta.url));

  assert.equal(boundedSchema.properties.id.pattern, "^T[1-9][0-9]*$");
  assert.deepEqual(dispatchSchema.properties.executionMode.enum, ["plan", "confirm", "auto"]);
  assert.deepEqual(
    dispatchSchema.$defs.planTask.properties.recommendation.properties.tier.enum,
    ["fast", "balanced", "strong", "long"],
  );
  assert.deepEqual(
    dispatchSchema.$defs.planTask.properties.assessment.properties.source.enum,
    ["jev", "agent"],
  );
});

test("validator CLI reads a plan from stdin and returns deterministic JSON", async () => {
  const { spawnSync } = await import("node:child_process");
  const script = fileURLToPath(new URL("../scripts/validate-dispatch-plan.mjs", import.meta.url));
  const plan = readJson(fixtureUrl("dispatch-plan.valid.json"));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(plan),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, errors: [] });
});
