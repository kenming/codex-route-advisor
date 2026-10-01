import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { adviseTask } from "../scripts/advise-task.mjs";
import { validateDispatchPlan } from "../scripts/validate-dispatch-plan.mjs";

async function isolated(input) {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-mvp-"));
  return {
    ...input,
    session: { allowModelEscalation: true, ...(input.session ?? {}) },
    workspaceRoot: dir,
    globalConfigPath: join(dir, "global.json"),
    workspaceConfigPath: join(dir, "workspace.json"),
  };
}

function bounded(overrides = {}) {
  return {
    goal: "Implement bounded change",
    context: {},
    deliverable: "Working change",
    acceptance: ["Focused validation passes"],
    boundaryReason: "Independent routing boundary",
    ...overrides,
  };
}

function agent(tier, reason, confidence = 0.9, signals = {}) {
  return { tier, reason, confidence, ...signals };
}
test("enabled=false bypasses Advisor before decomposition or assessment", async () => {
  const input = await isolated({
    session: { enabled: false },
  });

  const plan = await adviseTask(input);
  assert.equal(plan, null);
});

test("enabled=false CLI returns disabled state and creates no trace", async () => {
  const input = await isolated({
    session: { enabled: false },
  });
  const script = fileURLToPath(new URL("../scripts/advise-task.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    state: "disabled",
    advisorEnabled: false,
  });
});

test("agent fallback produces an executable one-task Dispatch Plan", async () => {
  const input = await isolated({
    task: "Rename one config field and update its focused test",
    routerPreference: { backend: "auto", prefer: "jev" },
    boundedTasks: [
      bounded({
        goal: "Rename config field and update focused test",
        boundaryReason: "Edit and focused test share one routing and validation cycle",
      }),
    ],
    assessments: {
      T1: {
        agent: agent("balanced", "Ordinary bounded engineering change"),
        tools: ["code-edit", "node:test"],
      },
    },
  });

  const plan = await adviseTask(input, {
    assessWithJev: async () => {
      const error = new Error("Jev unavailable in test");
      error.code = "missing_api_key";
      throw error;
    },
  });
  assert.equal(plan.assessmentMode, "agent");
  assert.equal(plan.tasks[0].assessment.source, "agent");
  assert.deepEqual(plan.tasks[0].assessment.fallback, {
    from: "jev",
    reason: "unavailable",
  });
  assert.equal(plan.tasks[0].recommendation.tier, "balanced");
  assert.equal(plan.tasks[0].recommendation.model, "sol");
  assert.equal(plan.tasks[0].recommendation.effort, "medium");
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("escalation-disabled plan keeps preferred advice but caps effective profile at coordinator", async () => {
  const input = await isolated({
    task: "Route mixed capability tasks without exceeding Sol Medium",
    session: { allowModelEscalation: false },
    coordinatorProfile: { model: "sol", effort: "medium" },
    boundedTasks: [
      bounded({ id: "T1", goal: "Routine bounded work" }),
      bounded({ id: "T2", goal: "Diagnose unknown failure" }),
      bounded({ id: "T3", goal: "Plan long migration" }),
    ],
    assessments: {
      T1: { agent: agent("fast", "Low-risk deterministic task") },
      T2: { agent: agent("strong", "Deep diagnosis") },
      T3: { agent: agent("long", "Broad migration context") },
    },
  });

  const plan = await adviseTask(input);
  assert.deepEqual(plan.tasks[0].recommendation, {
    tier: "fast", effort: "high", model: "luna",
  });
  assert.deepEqual(plan.tasks[1].recommendation, {
    tier: "strong",
    effort: "medium",
    model: "sol",
    preferredModel: "sol",
    preferredEffort: "xhigh",
    constraint: "model_escalation_disabled",
  });
  assert.deepEqual(plan.tasks[2].recommendation, {
    tier: "long",
    effort: "medium",
    model: "sol",
    preferredModel: "astra",
    preferredEffort: "medium",
    constraint: "model_escalation_disabled",
  });
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("escalation-disabled plan requires the current coordinator profile", async () => {
  const input = await isolated({
    task: "Route one task",
    session: { allowModelEscalation: false },
    assessments: {
      T1: { agent: agent("balanced", "Ordinary bounded work") },
    },
  });

  await assert.rejects(
    () => adviseTask(input),
    (error) => error.code === "coordinator_profile_required",
  );
});

test("authoring shorthand is canonicalized before building the Dispatch Plan", async () => {
  const input = await isolated({
    task: "Implement one bounded change",
    context: "Repository-local task",
    constraints: "Keep the change minimal",
    boundedTasks: [
      {
        id: "T1",
        goal: "Implement one bounded change",
        context: "Edit one local module",
        dependsOn: [],
        deliverable: "Working change",
        acceptance: "Focused validation passes",
        conditional: false,
        boundaryReason: "One routing and validation cycle",
      },
    ],
    assessments: {
      T1: {
        agent: agent("fast", "Small deterministic local change", 0.95),
        tools: ["code-edit", "node:test"],
      },
    },
  });

  const plan = await adviseTask(input);
  assert.deepEqual(plan.tasks[0].context, { summary: "Edit one local module" });
  assert.deepEqual(plan.tasks[0].acceptance, ["Focused validation passes"]);
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("preferred Jev path calls the production assessment boundary when no Jev fixture is injected", async () => {
  const input = await isolated({
    task: "Inspect a routine local change",
    routerPreference: { backend: "auto", prefer: "jev" },
    boundedTasks: [bounded({ goal: "Inspect routine local change" })],
    assessments: {
      T1: {
        agent: agent("balanced", "Fallback agent assessment"),
        tools: ["read"],
      },
    },
  });

  let calls = 0;
  const plan = await adviseTask(input, {
    assessWithJev: async (task) => {
      calls += 1;
      assert.equal(task.id, "T1");
      return agent("fast", "Jev production assessment", 0.94);
    },
  });

  assert.equal(calls, 1);
  assert.equal(plan.assessmentMode, "jev");
  assert.equal(plan.tasks[0].assessment.source, "jev");
  assert.equal(plan.tasks[0].recommendation.tier, "fast");
  assert.equal(plan.tasks[0].recommendation.model, "luna");
});

test("high-confidence Jev assessment is used when preferred and available", async () => {
  const input = await isolated({
    task: "Inspect a routine local change",
    routerPreference: { backend: "auto", prefer: "jev" },
    boundedTasks: [bounded({ goal: "Inspect routine local change" })],
    assessments: {
      T1: {
        jev: agent("fast", "Low ambiguity local inspection", 0.94, {
          taskComplexity: 0.2,
          reasoningRequired: 0.2,
          toolComplexity: 0.1,
        }),
        agent: agent("balanced", "Fallback agent assessment"),
        tools: ["read"],
      },
    },
  });

  const plan = await adviseTask(input);
  assert.equal(plan.assessmentMode, "jev");
  assert.equal(plan.tasks[0].assessment.source, "jev");
  assert.equal(plan.tasks[0].recommendation.tier, "fast");
  assert.equal(plan.tasks[0].recommendation.effort, "high");
  assert.equal(plan.tasks[0].assessment.taskComplexity, 0.2);
});
test("low-confidence Jev assessment falls back to the Agent rubric", async () => {
  const input = await isolated({
    task: "Diagnose an ambiguous failure",
    routerPreference: { backend: "auto", prefer: "jev" },
    boundedTasks: [bounded({ goal: "Diagnose ambiguous failure" })],
    assessments: {
      T1: {
        jev: agent("balanced", "Ambiguous signal", 0.3),
        agent: agent("strong", "Unknown root cause requires hypothesis testing", 0.91),
        tools: ["code-read", "test"],
      },
    },
  });

  const plan = await adviseTask(input);
  assert.equal(plan.tasks[0].assessment.source, "agent");
  assert.equal(plan.tasks[0].recommendation.tier, "strong");
  assert.equal(plan.tasks[0].recommendation.effort, "xhigh");
  assert.match(plan.tasks[0].rationale, /Jev low_confidence/);
});

test("one request can produce mixed tiers without escalating siblings", async () => {
  const input = await isolated({
    task: "Implement UI, validate it, diagnose only if validation fails",
    routerPreference: { backend: "model" },
    boundedTasks: [
      bounded({
        id: "T1",
        goal: "Implement product-list UI",
        boundaryReason: "Implementation boundary",
      }),
      bounded({
        id: "T2",
        goal: "Validate UI with Playwright",
        dependsOn: ["T1"],
        boundaryReason: "Distinct browser validation tool and acceptance gate",
      }),
      bounded({
        id: "T3",
        goal: "Diagnose and fix validation failure",
        dependsOn: ["T2"],
        conditional: { taskId: "T2", outcome: "failure" },
        boundaryReason: "Unknown failure diagnosis is conditional and reasoning-heavy",
      }),
    ],
    assessments: {
      T1: { agent: agent("balanced", "Normal UI implementation"), tools: ["code-edit"] },
      T2: { agent: agent("fast", "Deterministic browser validation"), tools: ["playwright"] },
      T3: { agent: agent("strong", "Unknown failure root cause"), tools: ["playwright", "code-edit"] },
    },
  });
  const plan = await adviseTask(input);
  assert.deepEqual(
    plan.tasks.map((item) => item.recommendation.tier),
    ["balanced", "fast", "strong"],
  );
  assert.deepEqual(plan.executionOrder, ["T1", "T2", "T3"]);
  assert.deepEqual(plan.tasks[2].conditional, { taskId: "T2", outcome: "failure" });
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("independent frontend and backend tasks preserve a declared parallel group", async () => {
  const input = await isolated({
    task: "Implement fixed-contract frontend and backend",
    routerPreference: { backend: "model" },
    boundedTasks: [
      bounded({ id: "T1", goal: "Implement frontend against fixed API" }),
      bounded({ id: "T2", goal: "Implement backend behind fixed API" }),
    ],
    parallelGroups: [["T1", "T2"]],
    assessments: {
      T1: { agent: agent("balanced", "Routine frontend implementation"), tools: ["code-edit"] },
      T2: { agent: agent("balanced", "Routine backend implementation"), tools: ["code-edit"] },
    },
  });

  const plan = await adviseTask(input);
  assert.deepEqual(plan.parallelGroups, [["T1", "T2"]]);
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("documented executable example remains a valid mixed-tier plan", async () => {
  const file = fileURLToPath(new URL("../examples/advisor-mvp.request.json", import.meta.url));
  const request = JSON.parse(await readFile(file, "utf8"));
  const input = await isolated(request);
  const plan = await adviseTask(input);

  assert.deepEqual(
    plan.tasks.map((item) => item.recommendation.tier),
    ["balanced", "fast", "strong"],
  );
  assert.deepEqual(plan.tasks[2].conditional, { taskId: "T2", outcome: "failure" });
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("advise-task CLI returns the primary Dispatch Plan", async () => {
  const input = await isolated({
    task: "Make one bounded change",
    routerPreference: { backend: "model" },
    assessments: {
      T1: {
        agent: agent("balanced", "Single bounded engineering task"),
        tools: ["code-edit"],
      },
    },
  });

  const script = fileURLToPath(new URL("../scripts/advise-task.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.state, "advised");
  assert.equal(output.plan.tasks.length, 1);
  assert.equal(output.plan.tasks[0].assessment.source, "agent");
  assert.ok(output.trace?.runId);
  assert.equal(JSON.parse(await readFile(output.trace.runFile, "utf8")).traceStatus, "complete");
  assert.equal(JSON.parse(await readFile(output.trace.planFile, "utf8")).taskSummary, output.plan.taskSummary);
  assert.match(await readFile(output.trace.eventsFile, "utf8"), /"event":"plan_created"/);
  assert.deepEqual(validateDispatchPlan(output.plan), { valid: true, errors: [] });
});

test("executionMode plan is preserved in the Dispatch Plan", async () => {
  const input = await isolated({
    task: "Plan one bounded change",
    session: { executionMode: "plan" },
    assessments: {
      T1: { agent: agent("balanced", "Bounded engineering task") },
    },
  });
  const plan = await adviseTask(input);
  assert.equal(plan.executionMode, "plan");
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("executionMode confirm is the default", async () => {
  const input = await isolated({
    task: "Plan one bounded change",
    assessments: {
      T1: { agent: agent("balanced", "Bounded engineering task") },
    },
  });
  const plan = await adviseTask(input);
  assert.equal(plan.executionMode, "confirm");
});

test("executionMode auto is preserved in the Dispatch Plan", async () => {
  const input = await isolated({
    task: "Plan one bounded change",
    session: { executionMode: "auto" },
    assessments: {
      T1: { agent: agent("balanced", "Bounded engineering task") },
    },
  });
  const plan = await adviseTask(input);
  assert.equal(plan.executionMode, "auto");
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});

test("Advisor resolves a discovered Codex model through the exact-id capability registry", async () => {
  const input = await isolated({
    task: "Implement one bounded change",
    routerPreference: { backend: "model" },
    assessments: {
      T1: {
        agent: agent("balanced", "Ordinary bounded implementation"),
      },
    },
  });

  const plan = await adviseTask(input, {
    discoverModels: async () => ({
      inventory: [
        { id: "gpt-5.6-sol", available: true },
        { id: "gpt-5.6-terra", available: true },
      ],
    }),
  });

  assert.equal(plan.tasks[0].recommendation.model, "gpt-5.6-sol");
  assert.equal(plan.tasks[0].recommendation.effort, "medium");
  assert.deepEqual(validateDispatchPlan(plan), { valid: true, errors: [] });
});
