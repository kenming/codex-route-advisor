#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";

const TIERS = new Set(["fast", "balanced", "strong", "long"]);
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SOURCES = new Set(["jev", "agent"]);
const MODES = new Set(["jev", "agent", "mixed"]);
const EXECUTION_MODES = new Set(["plan", "confirm", "auto"]);
const TASK_ID = /^T[1-9][0-9]*$/;

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function push(errors, code, path, message) {
  errors.push({ code, path, message });
}

function validateString(value, path, errors) {
  if (typeof value !== "string" || !value.trim()) {
    push(errors, "invalid_field", path, "Expected a non-empty string");
  }
}

function validateStringArray(value, path, errors, { min = 0, unique = false } = {}) {
  if (!Array.isArray(value)) {
    push(errors, "invalid_field", path, "Expected an array");
    return;
  }
  if (value.length < min) {
    push(errors, "invalid_field", path, `Expected at least ${min} item(s)`);
  }
  const seen = new Set();
  value.forEach((item, index) => {
    validateString(item, `${path}[${index}]`, errors);
    if (unique && typeof item === "string") {
      if (seen.has(item)) {
        push(errors, "duplicate_value", path, `Duplicate value: ${item}`);
      }
      seen.add(item);
    }
  });
}

export function validateBoundedTask(task, path = "task") {
  const errors = [];
  if (!isObject(task)) {
    push(errors, "invalid_task", path, "Expected an object");
    return errors;
  }

  validateString(task.id, `${path}.id`, errors);
  if (typeof task.id === "string" && !TASK_ID.test(task.id)) {
    push(errors, "invalid_task_id", `${path}.id`, "Expected task id like T1");
  }
  validateString(task.goal, `${path}.goal`, errors);
  if (!isObject(task.context)) {
    push(errors, "invalid_field", `${path}.context`, "Expected an object");
  }
  validateStringArray(task.dependsOn, `${path}.dependsOn`, errors, { unique: true });
  validateString(task.deliverable, `${path}.deliverable`, errors);
  validateStringArray(task.acceptance, `${path}.acceptance`, errors, { min: 1 });
  validateString(task.boundaryReason, `${path}.boundaryReason`, errors);

  if (task.conditional !== false) {
    if (!isObject(task.conditional)) {
      push(errors, "invalid_conditional", `${path}.conditional`, "Expected false or a conditional object");
    } else {
      validateString(task.conditional.taskId, `${path}.conditional.taskId`, errors);
      if (!["success", "failure"].includes(task.conditional.outcome)) {
        push(errors, "invalid_conditional", `${path}.conditional.outcome`, "Expected success or failure");
      }
      const keys = Object.keys(task.conditional);
      if (keys.some((key) => !["taskId", "outcome"].includes(key))) {
        push(errors, "invalid_conditional", `${path}.conditional`, "Unexpected conditional field");
      }
    }
  }

  return errors;
}

function hasPath(start, target, dependencies) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependency of dependencies.get(current) ?? []) {
      stack.push(dependency);
    }
  }
  return false;
}

export function validateDispatchPlan(plan) {
  const errors = [];
  if (!isObject(plan)) {
    push(errors, "invalid_plan", "plan", "Expected an object");
    return { valid: false, errors };
  }

  if (plan.version !== 1) push(errors, "invalid_version", "version", "Expected version 1");
  validateString(plan.taskSummary, "taskSummary", errors);
  if (!EXECUTION_MODES.has(plan.executionMode)) {
    push(errors, "invalid_execution_mode", "executionMode", "Expected plan, confirm, or auto");
  }
  if (!MODES.has(plan.assessmentMode)) {
    push(errors, "invalid_assessment_mode", "assessmentMode", "Expected jev, agent, or mixed");
  }
  validateStringArray(plan.executionOrder, "executionOrder", errors, { min: 1, unique: true });
  if (!Array.isArray(plan.parallelGroups)) {
    push(errors, "invalid_field", "parallelGroups", "Expected an array");
  }
  if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) {
    push(errors, "invalid_field", "tasks", "Expected at least one task");
    return { valid: errors.length === 0, errors };
  }

  const ids = new Set();
  const dependencies = new Map();
  const sources = new Set();

  plan.tasks.forEach((task, index) => {
    const path = `tasks[${index}]`;
    errors.push(...validateBoundedTask(task, path));

    if (typeof task?.id === "string") {
      if (ids.has(task.id)) push(errors, "duplicate_task_id", `${path}.id`, `Duplicate task id: ${task.id}`);
      ids.add(task.id);
      dependencies.set(task.id, Array.isArray(task.dependsOn) ? task.dependsOn : []);
    }

    if (!isObject(task?.assessment)) {
      push(errors, "invalid_assessment", `${path}.assessment`, "Expected an object");
    } else {
      if (!SOURCES.has(task.assessment.source)) {
        push(errors, "invalid_assessment_source", `${path}.assessment.source`, "Expected jev or agent");
      } else {
        sources.add(task.assessment.source);
      }
      if (typeof task.assessment.confidence !== "number"
        || task.assessment.confidence < 0
        || task.assessment.confidence > 1) {
        push(errors, "invalid_confidence", `${path}.assessment.confidence`, "Expected a number from 0 through 1");
      }
      for (const key of ["taskComplexity", "reasoningRequired", "toolComplexity"]) {
        if (task.assessment[key] !== undefined
          && (typeof task.assessment[key] !== "number"
            || task.assessment[key] < 0
            || task.assessment[key] > 1)) {
          push(errors, "invalid_assessment_signal", `${path}.assessment.${key}`, "Expected a number from 0 through 1");
        }
      }
      if (task.assessment.fallback !== undefined) {
        if (!isObject(task.assessment.fallback)
          || task.assessment.fallback.from !== "jev"
          || typeof task.assessment.fallback.reason !== "string"
          || !task.assessment.fallback.reason.trim()) {
          push(errors, "invalid_assessment_fallback", `${path}.assessment.fallback`, "Expected Jev fallback metadata");
        }
      }
    }

    if (!isObject(task?.recommendation)) {
      push(errors, "invalid_recommendation", `${path}.recommendation`, "Expected an object");
    } else {
      if (!TIERS.has(task.recommendation.tier)) {
        push(errors, "invalid_tier", `${path}.recommendation.tier`, "Unsupported routing tier");
      }
      if (!EFFORTS.has(task.recommendation.effort)) {
        push(errors, "invalid_effort", `${path}.recommendation.effort`, "Unsupported reasoning effort");
      }
      if (task.recommendation.model !== undefined) {
        validateString(task.recommendation.model, `${path}.recommendation.model`, errors);
      }
      const constrainedFields = [
        task.recommendation.preferredModel,
        task.recommendation.preferredEffort,
        task.recommendation.constraint,
      ];
      if (constrainedFields.some((value) => value !== undefined)) {
        validateString(
          task.recommendation.preferredModel,
          `${path}.recommendation.preferredModel`,
          errors,
        );
        if (!EFFORTS.has(task.recommendation.preferredEffort)) {
          push(
            errors,
            "invalid_effort",
            `${path}.recommendation.preferredEffort`,
            "Unsupported preferred reasoning effort",
          );
        }
        if (task.recommendation.constraint !== "model_escalation_disabled") {
          push(
            errors,
            "invalid_constraint",
            `${path}.recommendation.constraint`,
            "Expected model_escalation_disabled",
          );
        }
      }
    }

    validateStringArray(task?.tools, `${path}.tools`, errors, { unique: true });
    validateString(task?.rationale, `${path}.rationale`, errors);
  });

  for (const task of plan.tasks) {
    if (!task?.id || !Array.isArray(task.dependsOn)) continue;
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        push(errors, "self_dependency", `tasks.${task.id}.dependsOn`, `${task.id} cannot depend on itself`);
      } else if (!ids.has(dep)) {
        push(errors, "unknown_dependency", `tasks.${task.id}.dependsOn`, `Unknown dependency: ${dep}`);
      }
    }
    if (isObject(task.conditional)) {
      const ref = task.conditional.taskId;
      if (typeof ref === "string" && !ids.has(ref)) {
        push(errors, "unknown_conditional_task", `tasks.${task.id}.conditional.taskId`, `Unknown task: ${ref}`);
      }
      if (typeof ref === "string" && Array.isArray(task.dependsOn) && !task.dependsOn.includes(ref)) {
        push(errors, "conditional_dependency_missing", `tasks.${task.id}.conditional`, "Conditional taskId must also be a dependency");
      }
    }
  }

  for (const id of ids) {
    for (const dep of dependencies.get(id) ?? []) {
      if (ids.has(dep) && hasPath(dep, id, dependencies)) {
        push(errors, "dependency_cycle", "tasks", `Dependency cycle includes ${id} and ${dep}`);
      }
    }
  }

  if (Array.isArray(plan.executionOrder)) {
    const order = plan.executionOrder;
    if (order.length !== ids.size || order.some((id) => !ids.has(id))) {
      push(errors, "invalid_execution_order", "executionOrder", "Must contain every task exactly once");
    } else {
      const position = new Map(order.map((id, index) => [id, index]));
      for (const [id, deps] of dependencies) {
        for (const dep of deps) {
          if (position.has(dep) && position.get(dep) > position.get(id)) {
            push(errors, "dependency_order_violation", "executionOrder", `${dep} must appear before ${id}`);
          }
        }
      }
    }
  }

  if (Array.isArray(plan.parallelGroups)) {
    plan.parallelGroups.forEach((group, groupIndex) => {
      if (!Array.isArray(group) || group.length < 2) {
        push(errors, "invalid_parallel_group", `parallelGroups[${groupIndex}]`, "Expected at least two task IDs");
        return;
      }
      const groupSet = new Set(group);
      if (groupSet.size !== group.length) {
        push(errors, "invalid_parallel_group", `parallelGroups[${groupIndex}]`, "Task IDs must be unique within a group");
      }
      for (const id of group) {
        if (!ids.has(id)) {
          push(errors, "unknown_parallel_task", `parallelGroups[${groupIndex}]`, `Unknown task: ${id}`);
        }
      }
      for (let i = 0; i < group.length; i += 1) {
        for (let j = i + 1; j < group.length; j += 1) {
          const left = group[i];
          const right = group[j];
          if (ids.has(left) && ids.has(right)
            && (hasPath(left, right, dependencies) || hasPath(right, left, dependencies))) {
            push(errors, "parallel_dependency_conflict", `parallelGroups[${groupIndex}]`, `${left} and ${right} are dependency-related`);
          }
        }
      }
    });
  }

  const expectedMode = sources.size > 1 ? "mixed" : [...sources][0];
  if (expectedMode && plan.assessmentMode !== expectedMode) {
    push(errors, "assessment_mode_mismatch", "assessmentMode", `Expected ${expectedMode} for task assessment sources`);
  }

  return { valid: errors.length === 0, errors };
}

async function readStdin() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const text = await readStdin();
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (error) {
    process.stdout.write(JSON.stringify({
      valid: false,
      errors: [{ code: "invalid_json", path: "plan", message: error.message }],
    }));
    process.exitCode = 1;
    return;
  }

  const result = validateDispatchPlan(plan);
  process.stdout.write(JSON.stringify(result, null, 2));
  if (!result.valid) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
