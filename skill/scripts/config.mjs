#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  DEFAULT_ROUTING_PREFERENCES,
  EFFORTS,
  ROUTING_TIERS,
  RoutingError,
  isPlainObject,
} from "./routing.mjs";

export const CONFIG_SCHEMA_VERSION = 1;
export const EXECUTION_MODES = Object.freeze(["plan", "confirm", "auto"]);
export const DEFAULT_ENABLED = true;
export const DEFAULT_EXECUTION_MODE = "confirm";
export const DEFAULT_ALLOW_MODEL_ESCALATION = false;

export function globalConfigPath({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "codex-route-advisor", "config.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "codex-route-advisor", "config.json");
  }
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "codex-route-advisor", "config.json");
}

export function workspaceConfigPath(workspaceRoot = process.cwd()) {
  return join(workspaceRoot, ".codex", "codex-route-advisor", "config.json");
}

function fail(code, message, details = {}) {
  throw new RoutingError(code, message, details);
}

function validateRouterPreference(router, source) {
  if (router === undefined) return;
  if (!isPlainObject(router)) {
    fail("invalid_schema", "router must be an object", { source, field: "router" });
  }

  if (
    router.backend !== undefined
    && !new Set(["auto", "jev", "model"]).has(router.backend)
  ) {
    fail("invalid_schema", "router.backend must be auto, jev, or model", {
      source,
      field: "router.backend",
    });
  }

  if (
    router.prefer !== undefined
    && !new Set(["jev", "model"]).has(router.prefer)
  ) {
    fail("invalid_schema", "router.prefer must be jev or model", {
      source,
      field: "router.prefer",
    });
  }
}

function validateEnabled(enabled, source) {
  if (enabled === undefined) return;
  if (typeof enabled !== "boolean") {
    fail("invalid_schema", "enabled must be a boolean", {
      source,
      field: "enabled",
    });
  }
}

function validateExecutionMode(executionMode, source) {
  if (executionMode === undefined) return;
  if (!EXECUTION_MODES.includes(executionMode)) {
    fail("invalid_schema", "executionMode must be plan, confirm, or auto", {
      source,
      field: "executionMode",
      executionMode,
    });
  }
}

function validateAllowModelEscalation(value, source) {
  if (value === undefined) return;
  if (typeof value !== "boolean") {
    fail("invalid_schema", "allowModelEscalation must be a boolean", {
      source,
      field: "allowModelEscalation",
    });
  }
}

function validateRoutingOverrides(routing, source) {
  if (routing === undefined) return;
  if (!isPlainObject(routing)) {
    fail("invalid_schema", "routing must be an object", { source, field: "routing" });
  }

  for (const [tier, override] of Object.entries(routing)) {
    if (!ROUTING_TIERS.includes(tier)) {
      fail("unknown_tier", `Unknown routing tier: ${tier}`, { source, tier });
    }
    if (!isPlainObject(override)) {
      fail("invalid_schema", `routing.${tier} must be an object`, {
        source,
        tier,
        field: `routing.${tier}`,
      });
    }

    if (
      override.model !== undefined
      && (typeof override.model !== "string" || !override.model.trim())
    ) {
      fail("unknown_model", `routing.${tier}.model must be a non-empty string`, {
        source,
        tier,
        field: "model",
      });
    }

    if (override.effort !== undefined && !EFFORTS.includes(override.effort)) {
      fail("unsupported_effort", `Unsupported reasoning effort: ${override.effort}`, {
        source,
        tier,
        field: "effort",
        effort: override.effort,
      });
    }
  }
}

export function validateConfig(config, source = "config") {
  if (!isPlainObject(config)) {
    fail("invalid_schema", "config must be a JSON object", { source });
  }
  if (config.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    fail("invalid_schema", `Unsupported schemaVersion: ${config.schemaVersion}`, {
      source,
      field: "schemaVersion",
      schemaVersion: config.schemaVersion,
    });
  }

  validateEnabled(config.enabled, source);
  validateRouterPreference(config.router, source);
  validateExecutionMode(config.executionMode, source);
  validateAllowModelEscalation(config.allowModelEscalation, source);
  validateRoutingOverrides(config.routing, source);
  return config;
}

export function validateSessionOverride(sessionOverride = {}) {
  if (!isPlainObject(sessionOverride)) {
    fail("invalid_schema", "session override must be an object", { source: "session" });
  }
  if (
    sessionOverride.schemaVersion !== undefined
    && sessionOverride.schemaVersion !== CONFIG_SCHEMA_VERSION
  ) {
    fail("invalid_schema", `Unsupported session schemaVersion: ${sessionOverride.schemaVersion}`, {
      source: "session",
      field: "schemaVersion",
    });
  }
  validateEnabled(sessionOverride.enabled, "session");
  validateRouterPreference(sessionOverride.router, "session");
  validateExecutionMode(sessionOverride.executionMode, "session");
  validateAllowModelEscalation(sessionOverride.allowModelEscalation, "session");
  validateRoutingOverrides(sessionOverride.routing, "session");
  return sessionOverride;
}

export async function readConfigFile(file, source) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    fail("invalid_schema", `Cannot read config: ${error.message}`, { source, file });
  }

  let config;
  try {
    config = JSON.parse(text);
  } catch (error) {
    fail("invalid_schema", `Invalid JSON: ${error.message}`, { source, file });
  }
  return validateConfig(config, source);
}

function defaultRoutingState() {
  const routing = {};
  const sources = {};
  for (const tier of ROUTING_TIERS) {
    routing[tier] = { ...DEFAULT_ROUTING_PREFERENCES[tier] };
    sources[tier] = { model: "skill_default", effort: "skill_default" };
  }
  return { routing, sources };
}

function applyLayer(state, layer, source) {
  if (!layer) return;

  if (layer.enabled !== undefined) {
    state.enabled = layer.enabled;
    state.enabledSource = source;
  }

  if (layer.router) {
    state.router = { ...state.router, ...layer.router };
    for (const key of Object.keys(layer.router)) {
      state.routerSources[key] = source;
    }
  }

  if (layer.executionMode !== undefined) {
    state.executionMode = layer.executionMode;
    state.executionModeSource = source;
  }

  if (layer.allowModelEscalation !== undefined) {
    state.allowModelEscalation = layer.allowModelEscalation;
    state.allowModelEscalationSource = source;
  }

  for (const [tier, override] of Object.entries(layer.routing ?? {})) {
    for (const field of ["model", "effort"]) {
      if (override[field] !== undefined) {
        state.routing[tier][field] = override[field];
        state.sources[tier][field] = source;
      }
    }
  }
}

export function mergePreferenceLayers({
  globalConfig = null,
  workspaceConfig = null,
  sessionOverride = {},
} = {}) {
  if (globalConfig) validateConfig(globalConfig, "global");
  if (workspaceConfig) validateConfig(workspaceConfig, "workspace");
  validateSessionOverride(sessionOverride);

  const { routing, sources } = defaultRoutingState();
  const state = {
    enabled: DEFAULT_ENABLED,
    enabledSource: "skill_default",
    router: { backend: "model" },
    routerSources: { backend: "skill_default" },
    executionMode: DEFAULT_EXECUTION_MODE,
    executionModeSource: "skill_default",
    allowModelEscalation: DEFAULT_ALLOW_MODEL_ESCALATION,
    allowModelEscalationSource: "skill_default",
    routing,
    sources,
  };

  applyLayer(state, globalConfig, "global");
  applyLayer(state, workspaceConfig, "workspace");
  applyLayer(state, sessionOverride, "session");
  return state;
}

export async function loadPreferences({
  workspaceRoot = process.cwd(),
  sessionOverride = {},
  globalPath = globalConfigPath(),
  workspacePath = workspaceConfigPath(workspaceRoot),
} = {}) {
  const [globalConfig, workspaceConfig] = await Promise.all([
    readConfigFile(globalPath, "global"),
    readConfigFile(workspacePath, "workspace"),
  ]);

  return {
    ...mergePreferenceLayers({ globalConfig, workspaceConfig, sessionOverride }),
    paths: { global: globalPath, workspace: workspacePath },
  };
}

export async function writeConfigAtomic(file, config) {
  validateConfig(config, file);
  await mkdir(dirname(file), { recursive: true });

  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    const reparsed = JSON.parse(await readFile(temp, "utf8"));
    validateConfig(reparsed, temp);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function updateConfig(mutator, file, source) {
  let current = await readConfigFile(file, source);
  if (!current) current = { schemaVersion: CONFIG_SCHEMA_VERSION };

  const next = structuredClone(current);
  await mutator(next);
  validateConfig(next, source);
  await writeConfigAtomic(file, next);
  return { config: next, file };
}

export async function updateGlobalConfig(mutator, {
  file = globalConfigPath(),
} = {}) {
  return updateConfig(mutator, file, "global");
}

export async function updateWorkspaceConfig(mutator, {
  workspaceRoot = process.cwd(),
  file = workspaceConfigPath(workspaceRoot),
} = {}) {
  return updateConfig(mutator, file, "workspace");
}
