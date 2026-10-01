#!/usr/bin/env node

import process from "node:process";
import {
  CONFIG_SCHEMA_VERSION,
  globalConfigPath,
  loadPreferences,
  readConfigFile,
  updateGlobalConfig,
  updateWorkspaceConfig,
  validateSessionOverride,
  workspaceConfigPath,
} from "./config.mjs";
import { RoutingError, isPlainObject } from "./routing.mjs";

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) {
    throw new RoutingError("invalid_schema", "Expected a JSON configuration request on stdin");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RoutingError("invalid_schema", `Invalid JSON request: ${error.message}`);
  }
}

function routerFor(choice) {
  if (choice === "jev") return { backend: "auto", prefer: "jev" };
  if (choice === "model") return { backend: "model", prefer: "model" };
  if (isPlainObject(choice)) return choice;
  throw new RoutingError("invalid_schema", "router must be jev, model, or a router object", {
    field: "router",
  });
}

function routingFor(input) {
  if (!isPlainObject(input)) {
    throw new RoutingError("invalid_schema", "routing must be an object", { field: "routing" });
  }
  return input;
}

function patchFromInput(input) {
  const patch = {};
  if (Object.hasOwn(input, "enabled")) {
    patch.enabled = input.enabled;
  }
  if (Object.hasOwn(input, "router")) {
    patch.router = routerFor(input.router);
  }
  if (Object.hasOwn(input, "routing")) {
    patch.routing = routingFor(input.routing);
  }
  if (Object.hasOwn(input, "executionMode")) {
    patch.executionMode = input.executionMode;
  }
  if (Object.hasOwn(input, "allowModelEscalation")) {
    patch.allowModelEscalation = input.allowModelEscalation;
  }
  if (Object.keys(patch).length === 0) {
    throw new RoutingError(
      "invalid_schema",
      "Configuration update requires enabled, router, routing, executionMode, and/or allowModelEscalation",
    );
  }
  return patch;
}

async function inspect(input) {
  const workspaceRoot = input.workspaceRoot ?? process.cwd();
  const globalPath = input.globalConfigPath ?? globalConfigPath();
  const workspacePath = input.workspaceConfigPath ?? workspaceConfigPath(workspaceRoot);
  const session = input.session ?? {};

  const [globalConfig, workspaceConfig, effective] = await Promise.all([
    readConfigFile(globalPath, "global"),
    readConfigFile(workspacePath, "workspace"),
    loadPreferences({
      workspaceRoot,
      sessionOverride: session,
      globalPath,
      workspacePath,
    }),
  ]);

  return {
    state: "inspected",
    config: {
      global: { exists: globalConfig !== null, path: globalPath },
      workspace: { exists: workspaceConfig !== null, path: workspacePath },
      session: { active: Object.keys(session).length > 0 },
    },
    effective: {
      enabled: effective.enabled,
      enabledSource: effective.enabledSource,
      router: effective.router,
      routerSources: effective.routerSources,
      executionMode: effective.executionMode,
      executionModeSource: effective.executionModeSource,
      allowModelEscalation: effective.allowModelEscalation,
      allowModelEscalationSource: effective.allowModelEscalationSource,
      routing: effective.routing,
      sources: effective.sources,
    },
  };
}

async function main() {
  const input = await readInput();

  if (input.action === "inspect") {
    process.stdout.write(`${JSON.stringify(await inspect(input))}\n`);
    return;
  }

  const scope = input.scope ?? "workspace";
  if (!["workspace", "global", "session"].includes(scope)) {
    throw new RoutingError("invalid_schema", "scope must be workspace, global, or session", {
      field: "scope",
    });
  }

  const patch = patchFromInput(input);

  if (scope === "session") {
    const session = validateSessionOverride(patch);
    process.stdout.write(`${JSON.stringify({
      saved: false,
      scope,
      session,
    })}\n`);
    return;
  }

  const mutator = (config) => {
    config.schemaVersion = CONFIG_SCHEMA_VERSION;

    if (patch.enabled !== undefined) {
      config.enabled = patch.enabled;
    }

    if (patch.router !== undefined) {
      config.router = {
        ...(config.router ?? {}),
        ...patch.router,
      };
    }

    if (patch.executionMode !== undefined) {
      config.executionMode = patch.executionMode;
    }

    if (patch.allowModelEscalation !== undefined) {
      config.allowModelEscalation = patch.allowModelEscalation;
    }

    if (patch.routing !== undefined) {
      config.routing ??= {};
      for (const [tier, override] of Object.entries(patch.routing)) {
        config.routing[tier] = {
          ...(config.routing[tier] ?? {}),
          ...override,
        };
      }
    }
  };

  const result = scope === "global"
    ? await updateGlobalConfig(mutator, input.file ? { file: input.file } : {})
    : await updateWorkspaceConfig(mutator, {
      ...(input.workspaceRoot ? { workspaceRoot: input.workspaceRoot } : {}),
      ...(input.file ? { file: input.file } : {}),
    });

  process.stdout.write(`${JSON.stringify({
    saved: true,
    scope,
    file: result.file,
    config: result.config,
  })}\n`);
}

await main().catch((error) => {
  const normalized = error instanceof RoutingError
    ? error
    : new RoutingError("service_error", error?.message ?? "Unexpected configuration failure");
  process.stdout.write(`${JSON.stringify({
    saved: false,
    error: normalized.code,
    message: normalized.message,
    ...(normalized.field ? { field: normalized.field } : {}),
  })}\n`);
  process.exitCode = 1;
});
