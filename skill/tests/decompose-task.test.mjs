import test from "node:test";
import assert from "node:assert/strict";

import {
  decomposeTask,
  DecompositionError,
} from "../scripts/decompose-task.mjs";

function task(overrides = {}) {
  return {
    goal: "Implement one bounded change",
    context: {},
    deliverable: "Working change",
    acceptance: ["Focused validation passes"],
    boundaryReason: "One routing and validation cycle",
    ...overrides,
  };
}

test("plain request remains one bounded task when no semantic split is supplied", () => {
  const result = decomposeTask({
    task: "Rename one config field and update its focused test",
    context: { file: "config.mjs" },
    constraints: { preserveBehavior: true },
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].id, "T1");
  assert.equal(result.tasks[0].conditional, false);
  assert.deepEqual(result.executionOrder, ["T1"]);
  assert.deepEqual(result.parallelGroups, []);
});
test("top-level authoring shorthand normalizes string context and constraints", () => {
  const result = decomposeTask({
    task: "Implement one bounded change",
    context: "Repository-local implementation task",
    constraints: "Preserve public behavior",
  });

  assert.deepEqual(result.tasks[0].context, {
    request: { summary: "Repository-local implementation task" },
    constraints: { summary: "Preserve public behavior" },
  });
});

test("bounded-task authoring shorthand normalizes string context and acceptance", () => {
  const result = decomposeTask({
    task: "Implement one bounded change",
    boundedTasks: [
      {
        id: "T1",
        goal: "Implement one bounded change",
        context: "Edit src/example.mjs only",
        dependsOn: [],
        deliverable: "Working implementation",
        acceptance: "Focused node:test passes",
        conditional: false,
        boundaryReason: "One routing and validation cycle",
      },
    ],
  });

  assert.deepEqual(result.tasks[0].context, { summary: "Edit src/example.mjs only" });
  assert.deepEqual(result.tasks[0].acceptance, ["Focused node:test passes"]);
});

test("agent-supplied implementation plus focused test can remain one bounded task", () => {
  const result = decomposeTask({
    task: "Update config parsing and its unit test",
    boundedTasks: [
      task({
        goal: "Update config parsing and focused unit test",
        boundaryReason: "Implementation and focused test share one context and validation cycle",
      }),
    ],
  });

  assert.equal(result.tasks.length, 1);
  assert.equal(result.tasks[0].goal, "Update config parsing and focused unit test");
});

test("sequential and conditional tasks produce a stable topological order", () => {
  const result = decomposeTask({
    task: "Implement UI, validate it, then diagnose failures if needed",
    boundedTasks: [
      task({ id: "T1", goal: "Implement UI" }),
      task({
        id: "T2",
        goal: "Validate UI with Playwright",
        dependsOn: ["T1"],
        boundaryReason: "Browser validation uses a distinct tool and acceptance gate",
      }),
      task({
        id: "T3",
        goal: "Diagnose validation failure",
        dependsOn: ["T2"],
        conditional: { taskId: "T2", outcome: "failure" },
        boundaryReason: "Unknown failure diagnosis needs stronger reasoning only on failure",
      }),
    ],
  });

  assert.deepEqual(result.executionOrder, ["T1", "T2", "T3"]);
  assert.deepEqual(result.tasks[2].conditional, { taskId: "T2", outcome: "failure" });
});
test("independent tasks may be represented as one conservative parallel group", () => {
  const result = decomposeTask({
    task: "Implement frontend and backend against a fixed interface",
    boundedTasks: [
      task({ id: "T1", goal: "Implement frontend against fixed API" }),
      task({ id: "T2", goal: "Implement backend behind fixed API" }),
    ],
    parallelGroups: [["T1", "T2"]],
  });

  assert.deepEqual(result.parallelGroups, [["T1", "T2"]]);
  assert.deepEqual(result.executionOrder, ["T1", "T2"]);
});

test("unknown dependencies fail before routing assessment", () => {
  assert.throws(
    () => decomposeTask({
      task: "Invalid graph",
      boundedTasks: [
        task({ id: "T1", dependsOn: ["T9"] }),
      ],
    }),
    (error) => error instanceof DecompositionError
      && error.code === "unknown_dependency"
      && error.dependency === "T9",
  );
});

test("dependency-related tasks cannot be declared parallel", () => {
  assert.throws(
    () => decomposeTask({
      task: "Invalid parallel graph",
      boundedTasks: [
        task({ id: "T1" }),
        task({ id: "T2", dependsOn: ["T1"] }),
      ],
      parallelGroups: [["T1", "T2"]],
    }),
    (error) => error instanceof DecompositionError
      && error.code === "parallel_dependency_conflict",
  );
});
