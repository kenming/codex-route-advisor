#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { validateBoundedTask } from "./validate-dispatch-plan.mjs";

export class DecompositionError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "DecompositionError";
    this.code = code;
    Object.assign(this, details);
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeObjectInput(value, field) {
  if (value === undefined) return {};
  if (isObject(value)) return value;
  if (typeof value === "string" && value.trim()) {
    return { summary: value.trim() };
  }
  throw new DecompositionError(
    "invalid_schema",
    `${field} must be an object or non-empty string`,
    { field },
  );
}

function normalizeAcceptanceInput(value) {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return value;
}

function taskId(index, candidate) {
  return candidate.id ?? `T${index + 1}`;
}
function normalizeCandidate(candidate, index) {
  if (!isObject(candidate)) {
    throw new DecompositionError("invalid_bounded_task", "Bounded task must be an object", {
      field: `boundedTasks[${index}]`,
    });
  }

  const task = {
    id: taskId(index, candidate),
    goal: candidate.goal,
    context: normalizeObjectInput(candidate.context, `boundedTasks[${index}].context`),
    dependsOn: candidate.dependsOn ?? [],
    deliverable: candidate.deliverable,
    acceptance: normalizeAcceptanceInput(candidate.acceptance),
    conditional: candidate.conditional ?? false,
    boundaryReason: candidate.boundaryReason,
  };

  const errors = validateBoundedTask(task, `boundedTasks[${index}]`);
  if (errors.length) {
    throw new DecompositionError("invalid_bounded_task", "Bounded task contract validation failed", {
      field: `boundedTasks[${index}]`,
      errors,
    });
  }
  return task;
}

function hasPath(start, target, dependencies) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependency of dependencies.get(current) ?? []) stack.push(dependency);
  }
  return false;
}

function validateGraph(tasks) {
  const ids = new Set();
  const dependencies = new Map();

  for (const task of tasks) {
    if (ids.has(task.id)) {
      throw new DecompositionError("duplicate_task_id", `Duplicate task id: ${task.id}`, {
        taskId: task.id,
      });
    }
    ids.add(task.id);
    dependencies.set(task.id, task.dependsOn);
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.id) {
        throw new DecompositionError("self_dependency", `${task.id} cannot depend on itself`, {
          taskId: task.id,
        });
      }
      if (!ids.has(dependency)) {
        throw new DecompositionError("unknown_dependency", `Unknown dependency: ${dependency}`, {
          taskId: task.id,
          dependency,
        });
      }
    }
    if (task.conditional) {
      const reference = task.conditional.taskId;
      if (!ids.has(reference)) {
        throw new DecompositionError("unknown_conditional_task", `Unknown conditional task: ${reference}`, {
          taskId: task.id,
          dependency: reference,
        });
      }
      if (!task.dependsOn.includes(reference)) {
        throw new DecompositionError(
          "conditional_dependency_missing",
          "Conditional taskId must also be a dependency",
          { taskId: task.id, dependency: reference },
        );
      }
    }
  }

  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (hasPath(dependency, task.id, dependencies)) {
        throw new DecompositionError("dependency_cycle", "Bounded-task dependency graph contains a cycle", {
          taskId: task.id,
          dependency,
        });
      }
    }
  }

  return dependencies;
}

function topologicalOrder(tasks) {
  const remaining = new Map(tasks.map((task) => [task.id, new Set(task.dependsOn)]));
  const order = [];
  while (remaining.size) {
    const ready = tasks
      .map((task) => task.id)
      .filter((id) => remaining.has(id) && remaining.get(id).size === 0);

    if (!ready.length) {
      throw new DecompositionError("dependency_cycle", "Unable to produce a topological execution order");
    }

    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
      for (const dependencies of remaining.values()) dependencies.delete(id);
    }
  }
  return order;
}

function normalizeParallelGroups(groups, tasks, dependencies) {
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new DecompositionError("invalid_parallel_groups", "parallelGroups must be an array");
  }

  const ids = new Set(tasks.map((task) => task.id));
  return groups.map((group, index) => {
    if (!Array.isArray(group) || group.length < 2 || new Set(group).size !== group.length) {
      throw new DecompositionError("invalid_parallel_group", "Parallel group requires at least two unique task IDs", {
        field: `parallelGroups[${index}]`,
      });
    }
    for (const id of group) {
      if (!ids.has(id)) {
        throw new DecompositionError("unknown_parallel_task", `Unknown parallel task: ${id}`, {
          field: `parallelGroups[${index}]`,
        });
      }
    }
    for (let left = 0; left < group.length; left += 1) {
      for (let right = left + 1; right < group.length; right += 1) {
        if (hasPath(group[left], group[right], dependencies)
          || hasPath(group[right], group[left], dependencies)) {
          throw new DecompositionError(
            "parallel_dependency_conflict",
            "Dependency-related tasks cannot be declared parallel",
            { field: `parallelGroups[${index}]` },
          );
        }
      }
    }
    return [...group];
  });
}

export function decomposeTask(input = {}) {
  if (!isObject(input)) {
    throw new DecompositionError("invalid_schema", "Advisor request must be an object");
  }
  if (typeof input.task !== "string" || !input.task.trim()) {
    throw new DecompositionError("invalid_schema", "task must be a non-empty string", { field: "task" });
  }

  const context = normalizeObjectInput(input.context, "context");
  const constraints = normalizeObjectInput(input.constraints, "constraints");

  const supplied = input.boundedTasks;
  if (supplied !== undefined && (!Array.isArray(supplied) || supplied.length === 0)) {
    throw new DecompositionError("invalid_schema", "boundedTasks must contain at least one task", {
      field: "boundedTasks",
    });
  }
  const candidates = supplied ?? [{
    goal: input.task.trim(),
    context: { request: context, constraints },
    deliverable: "Complete the requested task.",
    acceptance: ["Requested outcome is completed and relevant validation passes."],
    boundaryReason: "No independent routing boundary was supplied; keep the request as one bounded task.",
  }];

  const tasks = candidates.map(normalizeCandidate);
  const dependencies = validateGraph(tasks);
  const executionOrder = topologicalOrder(tasks);
  const parallelGroups = normalizeParallelGroups(input.parallelGroups, tasks, dependencies);

  return {
    taskSummary: input.task.trim(),
    tasks,
    executionOrder,
    parallelGroups,
  };
}

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new DecompositionError("invalid_schema", "Expected JSON request on stdin");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new DecompositionError("invalid_json", error.message);
  }
}

async function main() {
  const result = decomposeTask(await readInput());
  process.stdout.write(`${JSON.stringify({ state: "decomposed", ...result }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    process.stdout.write(`${JSON.stringify({
      state: "error",
      error: error.code ?? "service_error",
      message: error.message,
      ...(error.field ? { field: error.field } : {}),
      ...(error.errors ? { errors: error.errors } : {}),
    })}\n`);
    process.exitCode = 1;
  });
}
