#!/usr/bin/env node

import process from "node:process";
import { pathToFileURL } from "node:url";
import { loadPreferences } from "./config.mjs";
import { discoverCodexModels } from "./codex-model-source.mjs";
import { decomposeTask, DecompositionError } from "./decompose-task.mjs";
import { assessBoundedTaskWithJev } from "./jev-assessor.mjs";
import { resolveModelCatalogWithDiscovery } from "./model-discovery.mjs";
import { applyModelEscalationPolicy, resolveRoutingDecision } from "./resolver.mjs";
import { isPlainObject, routeTask, RoutingError } from "./routing.mjs";
import { validateDispatchPlan } from "./validate-dispatch-plan.mjs";
import { createTraceRun } from "./trace.mjs";

export class AdvisorError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "AdvisorError";
    this.code = code;
    Object.assign(this, details);
  }
}

function assessmentSpec(input, taskId) {
  const spec = input.assessments?.[taskId];
  if (!isPlainObject(spec)) {
    throw new AdvisorError(
      "agent_assessment_required",
      `assessments.${taskId} is required for executable Advisor routing`,
      { field: `assessments.${taskId}` },
    );
  }
  if (!isPlainObject(spec.agent)) {
    throw new AdvisorError(
      "agent_assessment_required",
      `assessments.${taskId}.agent is required as the deterministic fallback`,
      { field: `assessments.${taskId}.agent` },
    );
  }
  return spec;
}
function decisionAdapter(decision, errorSpec) {
  if (errorSpec !== undefined) {
    return async () => {
      const error = new Error(errorSpec.message ?? errorSpec.code ?? "routing backend failure");
      error.code = errorSpec.code ?? "backend_failure";
      throw error;
    };
  }
  if (decision === undefined) return undefined;
  return async () => decision;
}

function copySignals(source) {
  const result = {};
  for (const key of ["taskComplexity", "reasoningRequired", "toolComplexity"]) {
    if (source?.[key] !== undefined) result[key] = source[key];
  }
  return result;
}

function assessmentSource(decision) {
  return decision.backend === "jev" ? "jev" : "agent";
}

function modeForTasks(tasks) {
  const sources = new Set(tasks.map((task) => task.assessment.source));
  return sources.size > 1 ? "mixed" : [...sources][0];
}

function cleanError(error) {
  return {
    state: "error",
    error: error?.code ?? "service_error",
    message: error?.message ?? "Unknown Advisor error",
    ...(error?.field ? { field: error.field } : {}),
    ...(error?.taskId ? { taskId: error.taskId } : {}),
    ...(error?.errors ? { errors: error.errors } : {}),
  };
}
export async function adviseTask(input = {}, {
  discoverModels,
  assessWithJev = assessBoundedTaskWithJev,
} = {}) {
  if (!isPlainObject(input)) {
    throw new AdvisorError("invalid_schema", "Advisor input must be an object");
  }

  const preferences = await loadPreferences({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    sessionOverride: input.session ?? {},
    ...(input.globalConfigPath ? { globalPath: input.globalConfigPath } : {}),
    ...(input.workspaceConfigPath ? { workspacePath: input.workspaceConfigPath } : {}),
  });

  if (!preferences.enabled) {
    return null;
  }

  let effectiveCatalog;
  if (
    input.modelCatalog !== undefined
    || input.modelInventory !== undefined
    || typeof discoverModels === "function"
  ) {
    const catalog = await resolveModelCatalogWithDiscovery({
      discoverModels,
      ...(input.modelInventory !== undefined
        ? { runtimeInventory: input.modelInventory }
        : {}),
      ...(input.modelCapabilities !== undefined
        ? { capabilityRegistry: input.modelCapabilities }
        : {}),
      ...(input.modelCatalog !== undefined
        ? { runtimeCatalog: input.modelCatalog }
        : {}),
      ...(input.modelCachePath ? { cacheFile: input.modelCachePath } : {}),
      ...(input.modelInventoryCachePath
        ? { inventoryCacheFile: input.modelInventoryCachePath }
        : {}),
      ...(input.catalog?.forceRefresh !== undefined
        ? { forceRefresh: Boolean(input.catalog.forceRefresh) }
        : {}),
      ...(input.catalog?.clearCache !== undefined
        ? { clearCache: Boolean(input.catalog.clearCache) }
        : {}),
      ...(input.catalog?.liveRefresh !== undefined
        ? { liveRefresh: Boolean(input.catalog.liveRefresh) }
        : {}),
    });
    effectiveCatalog = catalog.source === "builtin"
      ? undefined
      : catalog.catalog;
  }

  const decomposition = decomposeTask(input);
  const plannedTasks = [];
  for (const task of decomposition.tasks) {
    const spec = assessmentSpec(input, task.id);
    const injectedJevRouter = decisionAdapter(spec.jev, spec.jevError);
    const jevRouter = injectedJevRouter
      ?? (typeof assessWithJev === "function" ? (boundedTask) => assessWithJev(boundedTask) : undefined);
    const modelRouter = decisionAdapter(spec.agent);

    let routingDecision;
    try {
      routingDecision = await routeTask({
        task,
        routerPreference: input.routerPreference ?? preferences.router,
        jevRouter,
        modelRouter,
        ...(input.confidenceThreshold !== undefined
          ? { confidenceThreshold: input.confidenceThreshold }
          : {}),
      });
    } catch (error) {
      if (error instanceof RoutingError) {
        error.taskId = task.id;
      }
      throw error;
    }

    const preferred = resolveRoutingDecision({
      decision: routingDecision,
      preferences: preferences.routing,
      sources: preferences.sources,
      ...(effectiveCatalog === undefined ? {} : { modelCatalog: effectiveCatalog }),
    });
    const effective = applyModelEscalationPolicy({
      recommendation: preferred,
      coordinatorProfile: input.coordinatorProfile,
      allowModelEscalation: preferences.allowModelEscalation,
      ...(effectiveCatalog === undefined ? {} : { modelCatalog: effectiveCatalog }),
    });
    const source = assessmentSource(routingDecision);
    const selectedAssessment = source === "jev" ? spec.jev : spec.agent;
    const tools = spec.tools ?? [];
    const fallbackRationale = routingDecision.fallback
      ? `Agent fallback after Jev ${routingDecision.fallback.reason}: ${routingDecision.reason}`
      : routingDecision.reason;
    const rationale = typeof spec.rationale === "string" && spec.rationale.trim()
      ? spec.rationale.trim()
      : fallbackRationale;

    plannedTasks.push({
      ...task,
      assessment: {
        source,
        confidence: routingDecision.confidence,
        ...copySignals(selectedAssessment),
        ...(routingDecision.fallback ? {
          fallback: { ...routingDecision.fallback },
        } : {}),
      },
      recommendation: {
        tier: effective.tier,
        effort: effective.reasoningEffort,
        model: effective.model,
        ...(effective.escalationConstrained ? {
          preferredModel: effective.preferredModel,
          preferredEffort: effective.preferredReasoningEffort,
          constraint: effective.escalationConstraint,
        } : {}),
      },
      tools,
      rationale,
    });
  }

  const plan = {
    version: 1,
    taskSummary: decomposition.taskSummary,
    executionMode: preferences.executionMode,
    assessmentMode: modeForTasks(plannedTasks),
    executionOrder: decomposition.executionOrder,
    parallelGroups: decomposition.parallelGroups,
    tasks: plannedTasks,
  };

  const validation = validateDispatchPlan(plan);
  if (!validation.valid) {
    throw new AdvisorError(
      "invalid_dispatch_plan",
      "Generated Dispatch Plan failed deterministic validation",
      { errors: validation.errors },
    );
  }

  return plan;
}

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new AdvisorError("invalid_schema", "Expected JSON request on stdin");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new AdvisorError("invalid_json", error.message);
  }
}
async function main() {
  const input = await readInput();
  const plan = await adviseTask(input, { discoverModels: discoverCodexModels });
  if (plan === null) {
    process.stdout.write(`${JSON.stringify({
      state: "disabled",
      advisorEnabled: false,
    }, null, 2)}\n`);
    return;
  }

  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const trace = await createTraceRun({ workspaceRoot, plan });
  process.stdout.write(`${JSON.stringify({
    state: "advised",
    plan,
    trace: trace ? {
      runId: trace.runId,
      dir: trace.dir,
      runFile: trace.runFile,
      planFile: trace.planFile,
      eventsFile: trace.eventsFile,
      traceStatus: trace.state.traceStatus,
    } : null,
  }, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    const normalized = error instanceof AdvisorError
      || error instanceof RoutingError
      || error instanceof DecompositionError
      ? error
      : new AdvisorError("service_error", error?.message ?? "Unexpected Advisor failure");

    process.stdout.write(`${JSON.stringify(cleanError(normalized))}\n`);
    process.exitCode = 1;
  });
}
