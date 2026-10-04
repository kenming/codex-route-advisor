#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { MODEL_CACHE_STALE_MS, MODEL_CACHE_TTL_MS } from "./model-catalog.mjs";
import {
  EFFORTS,
  ROUTING_TIERS,
  RoutingError,
  isPlainObject,
} from "./routing.mjs";

export const MODEL_INVENTORY_CACHE_SCHEMA_VERSION = 2;
const LEGACY_MODEL_INVENTORY_CACHE_SCHEMA_VERSION = 1;

// Exact-id registry only. Do not infer capability from model naming.
export const BUILTIN_MODEL_CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "gpt-5.6-luna",
    family: "luna",
    tiers: Object.freeze(["fast"]),
  }),
  Object.freeze({
    id: "gpt-5.6-sol",
    family: "sol",
    tiers: Object.freeze(["balanced", "strong"]),
  }),
  Object.freeze({
    id: "gpt-6-astra",
    family: "astra",
    tiers: Object.freeze(["long"]),
  }),
]);

function fail(code, message, details = {}) {
  throw new RoutingError(code, message, details);
}

export function modelInventoryCachePath({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    const root = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(root, "codex-route-advisor", "model-inventory-cache.json");
  }
  if (platform === "darwin") {
    return join(
      home,
      "Library",
      "Caches",
      "codex-route-advisor",
      "model-inventory-cache.json",
    );
  }
  return join(
    env.XDG_CACHE_HOME || join(home, ".cache"),
    "codex-route-advisor",
    "model-inventory-cache.json",
  );
}

export function normalizeModelInventory(inventory = []) {
  if (!Array.isArray(inventory)) {
    fail("invalid_schema", "modelInventory must be an array", {
      field: "modelInventory",
    });
  }

  const ids = new Set();
  return inventory.map((entry) => {
    if (!isPlainObject(entry)) {
      fail("invalid_schema", "Each modelInventory entry must be an object");
    }
    const allowed = new Set(["id", "available", "supportedEfforts"]);
    const unknown = Object.keys(entry).find((key) => !allowed.has(key));
    if (unknown) {
      fail("invalid_schema", `Unexpected modelInventory field: ${unknown}`, {
        field: `modelInventory.${unknown}`,
        model: entry.id,
      });
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      fail("invalid_schema", "modelInventory entry id must be a non-empty string");
    }
    const modelId = entry.id.trim();
    if (modelId !== entry.id || ids.has(modelId)) {
      fail(
        "invalid_schema",
        `modelInventory entry id must be canonical and unique: ${entry.id}`,
        { field: "modelInventory.id", model: entry.id },
      );
    }
    ids.add(modelId);
    if (typeof entry.available !== "boolean") {
      fail(
        "invalid_schema",
        `modelInventory entry ${modelId} requires boolean available`,
        { field: "modelInventory.available", model: modelId },
      );
    }

    let supportedEfforts;
    if (entry.supportedEfforts !== undefined) {
      if (!Array.isArray(entry.supportedEfforts)) {
        fail(
          "invalid_schema",
          `modelInventory entry ${modelId} supportedEfforts must be an array`,
          { field: "modelInventory.supportedEfforts", model: modelId },
        );
      }
      const seenEfforts = new Set();
      supportedEfforts = entry.supportedEfforts.map((effort) => {
        if (
          typeof effort !== "string"
          || !effort
          || effort !== effort.trim().toLowerCase()
          || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(effort)
          || seenEfforts.has(effort)
        ) {
          fail(
            "invalid_schema",
            `modelInventory entry ${modelId} supportedEfforts must be canonical and unique`,
            { field: "modelInventory.supportedEfforts", model: modelId },
          );
        }
        seenEfforts.add(effort);
        return effort;
      });
    }

    return {
      id: modelId,
      available: entry.available,
      ...(supportedEfforts !== undefined ? { supportedEfforts } : {}),
    };
  });
}

export function normalizeModelCapabilities(capabilities = []) {
  if (!Array.isArray(capabilities)) {
    fail("invalid_schema", "modelCapabilities must be an array", {
      field: "modelCapabilities",
    });
  }

  const ids = new Set();
  return capabilities.map((entry) => {
    if (!isPlainObject(entry)) {
      fail("invalid_schema", "Each modelCapabilities entry must be an object");
    }
    const allowed = new Set(["id", "family", "tiers"]);
    const unknown = Object.keys(entry).find((key) => !allowed.has(key));
    if (unknown) {
      fail("invalid_schema", `Unexpected modelCapabilities field: ${unknown}`, {
        field: `modelCapabilities.${unknown}`,
        model: entry.id,
      });
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      fail("invalid_schema", "modelCapabilities entry id must be a non-empty string");
    }
    const modelId = entry.id.trim();
    if (modelId !== entry.id || ids.has(modelId)) {
      fail(
        "invalid_schema",
        `modelCapabilities entry id must be canonical and unique: ${entry.id}`,
        { field: "modelCapabilities.id", model: entry.id },
      );
    }
    ids.add(modelId);

    if (
      typeof entry.family !== "string"
      || !entry.family.trim()
      || entry.family !== entry.family.trim().toLowerCase()
      || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(entry.family)
    ) {
      fail(
        "invalid_schema",
        `modelCapabilities entry ${modelId} requires canonical lowercase family`,
        { field: "modelCapabilities.family", model: modelId },
      );
    }
    if (
      !Array.isArray(entry.tiers)
      || entry.tiers.length === 0
      || entry.tiers.some((tier) => !ROUTING_TIERS.includes(tier))
      || new Set(entry.tiers).size !== entry.tiers.length
    ) {
      fail(
        "invalid_schema",
        `modelCapabilities entry ${modelId} requires unique valid tiers`,
        { field: "modelCapabilities.tiers", model: modelId },
      );
    }
    return {
      id: modelId,
      family: entry.family,
      tiers: [...entry.tiers],
    };
  });
}

function resolveCapabilityPolicy(capabilityRegistry = []) {
  const builtIn = normalizeModelCapabilities(BUILTIN_MODEL_CAPABILITIES);
  const runtime = normalizeModelCapabilities(capabilityRegistry);
  const capabilityById = new Map();

  for (const capability of builtIn) capabilityById.set(capability.id, capability);
  for (const capability of runtime) capabilityById.set(capability.id, capability);

  return {
    capabilities: [...capabilityById.values()],
    capabilityById,
  };
}

function compatibilityReportFromNormalized(
  normalizedInventory,
  capabilities,
  capabilityById,
) {
  const inventoryById = new Map(normalizedInventory.map((model) => [model.id, model]));
  const classified = [];
  const unclassified = [];
  const unavailable = [];

  for (const model of normalizedInventory) {
    const capability = capabilityById.get(model.id);

    if (model.available && capability) {
      classified.push({
        id: model.id,
        family: capability.family,
        tiers: [...capability.tiers],
        available: true,
        capabilityStatus: "classified",
        ...(model.supportedEfforts !== undefined
          ? { supportedEfforts: [...model.supportedEfforts] }
          : {}),
      });
      continue;
    }

    if (model.available && !capability) {
      unclassified.push({
        id: model.id,
        available: true,
        capabilityStatus: "unclassified",
        routable: false,
        ...(model.supportedEfforts !== undefined
          ? { supportedEfforts: [...model.supportedEfforts] }
          : {}),
      });
      continue;
    }

    if (!model.available && capability) {
      unavailable.push({
        id: model.id,
        family: capability.family,
        tiers: [...capability.tiers],
        available: false,
        capabilityStatus: "unavailable",
        routable: false,
        hostObserved: true,
        ...(model.supportedEfforts !== undefined
          ? { supportedEfforts: [...model.supportedEfforts] }
          : {}),
      });
    }
  }

  for (const capability of capabilities) {
    if (inventoryById.has(capability.id)) continue;
    unavailable.push({
      id: capability.id,
      family: capability.family,
      tiers: [...capability.tiers],
      available: false,
      capabilityStatus: "unavailable",
      routable: false,
      hostObserved: false,
    });
  }

  const byId = (left, right) => left.id.localeCompare(right.id);
  classified.sort(byId);
  unclassified.sort(byId);
  unavailable.sort(byId);

  return { classified, unclassified, unavailable };
}

export function buildModelCompatibilityReport(
  inventory,
  { capabilityRegistry = [] } = {},
) {
  const normalizedInventory = normalizeModelInventory(inventory);
  const { capabilities, capabilityById } = resolveCapabilityPolicy(capabilityRegistry);
  return compatibilityReportFromNormalized(
    normalizedInventory,
    capabilities,
    capabilityById,
  );
}

export function evaluateModelCompatibilityVerification(
  inventory,
  { capabilityRegistry = [] } = {},
) {
  const compatibility = buildModelCompatibilityReport(inventory, {
    capabilityRegistry,
  });
  const warnings = compatibility.unclassified.map((model) => ({
    code: "model_unclassified",
    model: model.id,
    message: `Model ${model.id} is available but has no exact Advisor capability policy; it remains non-routable.`,
  }));

  return {
    ok: true,
    warnings,
    compatibility,
  };
}

export function resolveInventoryCatalog(
  inventory,
  { capabilityRegistry = [] } = {},
) {
  const normalizedInventory = normalizeModelInventory(inventory);
  const { capabilities, capabilityById } = resolveCapabilityPolicy(capabilityRegistry);
  const compatibility = compatibilityReportFromNormalized(
    normalizedInventory,
    capabilities,
    capabilityById,
  );
  const catalog = [];

  for (const model of normalizedInventory) {
    const capability = capabilityById.get(model.id);
    if (!capability) continue;

    const supportedEfforts = (model.supportedEfforts ?? [])
      .filter((effort) => EFFORTS.includes(effort));

    if (supportedEfforts.length === 0) {
      continue;
    }

    catalog.push({
      id: model.id,
      family: capability.family,
      tiers: [...capability.tiers],
      supportedEfforts,
      available: model.available,
    });
  }

  return {
    inventory: normalizedInventory,
    catalog,
    unclassified: compatibility.unclassified.map((model) => ({
      id: model.id,
      available: model.available,
      capabilityStatus: model.capabilityStatus,
      routable: model.routable,
    })),
    compatibility,
  };
}

function parseFetchedAt(value) {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

export function validateModelInventoryCache(cache) {
  const supportedSchemaVersions = new Set([
    LEGACY_MODEL_INVENTORY_CACHE_SCHEMA_VERSION,
    MODEL_INVENTORY_CACHE_SCHEMA_VERSION,
  ]);
  if (
    !isPlainObject(cache)
    || !supportedSchemaVersions.has(cache.schemaVersion)
  ) {
    fail("invalid_inventory_cache_schema", "Unsupported model inventory cache schema", {
      field: "schemaVersion",
      schemaVersion: cache?.schemaVersion,
    });
  }

  const sourceSchemaVersion = cache.schemaVersion;
  const allowed = new Set(["schemaVersion", "fetchedAt", "inventory"]);
  const unknown = Object.keys(cache).find((key) => !allowed.has(key));
  if (unknown) {
    fail(
      "invalid_inventory_cache_schema",
      `Unexpected model inventory cache field: ${unknown}`,
      { field: unknown },
    );
  }

  const fetchedAtMs = parseFetchedAt(cache.fetchedAt);
  if (fetchedAtMs === null) {
    fail(
      "invalid_inventory_cache_schema",
      "model inventory cache fetchedAt must use canonical UTC ISO format",
      { field: "fetchedAt" },
    );
  }
  if (!Array.isArray(cache.inventory)) {
    fail(
      "invalid_inventory_cache_schema",
      "model inventory cache inventory is required and must be an array",
      { field: "inventory" },
    );
  }

  if (sourceSchemaVersion === LEGACY_MODEL_INVENTORY_CACHE_SCHEMA_VERSION) {
    for (const entry of cache.inventory) {
      if (
        !isPlainObject(entry)
        || Object.keys(entry).some((key) => !new Set(["id", "available"]).has(key))
      ) {
        fail(
          "invalid_inventory_cache_schema",
          "Legacy model inventory cache contains unsupported entry fields",
          { field: "inventory" },
        );
      }
    }
  }

  return {
    schemaVersion: MODEL_INVENTORY_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    inventory: normalizeModelInventory(cache.inventory),
  };
}

export async function readModelInventoryCache(file = modelInventoryCachePath()) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", file };
    throw error;
  }

  try {
    const parsed = JSON.parse(text);
    const sourceSchemaVersion = parsed?.schemaVersion;
    return {
      state: "valid",
      file,
      cache: validateModelInventoryCache(parsed),
      ...(sourceSchemaVersion !== MODEL_INVENTORY_CACHE_SCHEMA_VERSION
        ? { sourceSchemaVersion }
        : {}),
    };
  } catch (error) {
    if (
      error instanceof SyntaxError
      || error?.code === "invalid_inventory_cache_schema"
      || error?.code === "invalid_schema"
    ) {
      await rm(file, { force: true }).catch(() => {});
      return {
        state: "invalidated",
        file,
        reason: error?.code ?? "invalid_json",
      };
    }
    throw error;
  }
}
export async function writeModelInventoryCacheAtomic(
  inventory,
  { file = modelInventoryCachePath(), now = Date.now() } = {},
) {
  const normalized = normalizeModelInventory(inventory);
  const cache = {
    schemaVersion: MODEL_INVENTORY_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date(now).toISOString(),
    inventory: normalized,
  };

  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    validateModelInventoryCache(JSON.parse(await readFile(temp, "utf8")));
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }

  return { cache, file };
}

export async function clearModelInventoryCache(file = modelInventoryCachePath()) {
  await rm(file, { force: true });
  return { state: "cleared", file };
}

export async function inspectModelInventoryCache({
  file = modelInventoryCachePath(),
  now = Date.now(),
} = {}) {
  if (!Number.isFinite(now)) {
    fail("invalid_schema", "now must be a finite epoch millisecond value", {
      field: "now",
    });
  }

  const cached = await readModelInventoryCache(file);
  if (cached.state !== "valid") return cached;

  const ageMs = Math.max(0, now - Date.parse(cached.cache.fetchedAt));
  const freshness = ageMs <= MODEL_CACHE_TTL_MS
    ? "fresh"
    : ageMs <= MODEL_CACHE_STALE_MS
      ? "stale"
      : "expired";

  return {
    ...cached,
    ageMs,
    freshness,
    ...(cached.sourceSchemaVersion !== undefined
      ? { schemaUpgradeRequired: true }
      : {}),
  };
}
