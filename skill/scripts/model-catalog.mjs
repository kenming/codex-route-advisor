#!/usr/bin/env node

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import {
  EFFORTS,
  MODEL_FAMILIES,
  ROUTING_TIERS,
  RoutingError,
  isPlainObject,
} from "./routing.mjs";

export const MODEL_CACHE_SCHEMA_VERSION = 1;
export const MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
export const MODEL_CACHE_STALE_MS = 7 * 24 * 60 * 60 * 1000;

function fail(code, message, details = {}) {
  throw new RoutingError(code, message, details);
}

export function modelCachePath({
  platform = process.platform,
  env = process.env,
  home = homedir(),
} = {}) {
  if (platform === "win32") {
    const root = env.LOCALAPPDATA || join(home, "AppData", "Local");
    return join(root, "codex-route-advisor", "model-cache.json");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Caches", "codex-route-advisor", "model-cache.json");
  }
  return join(
    env.XDG_CACHE_HOME || join(home, ".cache"),
    "codex-route-advisor",
    "model-cache.json",
  );
}

export function normalizeModelCatalog(modelCatalog = []) {
  if (!Array.isArray(modelCatalog)) {
    fail("invalid_schema", "modelCatalog must be an array", { field: "modelCatalog" });
  }

  const ids = new Set();
  return modelCatalog.map((entry) => {
    if (!isPlainObject(entry)) {
      fail("invalid_schema", "Each modelCatalog entry must be an object");
    }
    const allowedEntryFields = new Set([
      "id",
      "family",
      "tiers",
      "supportedEfforts",
      "available",
    ]);
    const unknownEntryField = Object.keys(entry).find((key) => !allowedEntryFields.has(key));
    if (unknownEntryField) {
      fail("invalid_schema", `Unexpected modelCatalog field: ${unknownEntryField}`, {
        field: `modelCatalog.${unknownEntryField}`,
        model: entry.id,
      });
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      fail("invalid_schema", "modelCatalog entry id must be a non-empty string");
    }

    const id = entry.id.trim();
    if (id !== entry.id || ids.has(id)) {
      fail("invalid_schema", `modelCatalog entry id must be canonical and unique: ${entry.id}`, {
        field: "modelCatalog.id",
        model: entry.id,
      });
    }
    ids.add(id);
    if (typeof entry.family !== "string" || !entry.family.trim()) {
      fail("invalid_schema", `modelCatalog entry ${id} requires family`);
    }
    const family = entry.family.trim();
    if (
      family !== entry.family
      || family !== family.toLowerCase()
      || !/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(family)
    ) {
      fail(
        "invalid_schema",
        `modelCatalog entry ${id} requires a canonical lowercase family token`,
        { field: "modelCatalog.family", model: id },
      );
    }

    if (
      !Array.isArray(entry.tiers)
      || entry.tiers.length === 0
      || entry.tiers.some((tier) => !ROUTING_TIERS.includes(tier))
    ) {
      fail(
        "invalid_schema",
        `modelCatalog entry ${id} requires non-empty valid tiers`,
        { field: "modelCatalog.tiers", model: id },
      );
    }
    if (new Set(entry.tiers).size !== entry.tiers.length) {
      fail("invalid_schema", `modelCatalog entry ${id} has duplicate tiers`, {
        field: "modelCatalog.tiers",
        model: id,
      });
    }
    if (
      !Array.isArray(entry.supportedEfforts)
      || entry.supportedEfforts.length === 0
      || entry.supportedEfforts.some((effort) => !EFFORTS.includes(effort))
    ) {
      fail(
        "invalid_schema",
        `modelCatalog entry ${id} requires non-empty valid supportedEfforts`,
        { field: "modelCatalog.supportedEfforts", model: id },
      );
    }
    if (new Set(entry.supportedEfforts).size !== entry.supportedEfforts.length) {
      fail("invalid_schema", `modelCatalog entry ${id} has duplicate supportedEfforts`, {
        field: "modelCatalog.supportedEfforts",
        model: id,
      });
    }
    if (typeof entry.available !== "boolean") {
      fail(
        "invalid_schema",
        `modelCatalog entry ${id} requires boolean available`,
        { field: "modelCatalog.available", model: id },
      );
    }

    return {
      id,
      family,
      tiers: [...entry.tiers],
      supportedEfforts: [...entry.supportedEfforts],
      available: entry.available,
    };
  });
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

export function validateModelCache(cache) {
  if (!isPlainObject(cache) || cache.schemaVersion !== MODEL_CACHE_SCHEMA_VERSION) {
    fail("invalid_cache_schema", "Unsupported model cache schema", {
      field: "schemaVersion",
      schemaVersion: cache?.schemaVersion,
    });
  }

  const allowedCacheFields = new Set(["schemaVersion", "fetchedAt", "catalog"]);
  const unknownCacheField = Object.keys(cache).find((key) => !allowedCacheFields.has(key));
  if (unknownCacheField) {
    fail("invalid_cache_schema", `Unexpected model cache field: ${unknownCacheField}`, {
      field: unknownCacheField,
    });
  }

  const fetchedAtMs = parseFetchedAt(cache.fetchedAt);
  if (fetchedAtMs === null) {
    fail("invalid_cache_schema", "model cache fetchedAt must use canonical UTC ISO format", {
      field: "fetchedAt",
    });
  }
  if (!Object.hasOwn(cache, "catalog") || !Array.isArray(cache.catalog)) {
    fail("invalid_cache_schema", "model cache catalog is required and must be an array", {
      field: "catalog",
    });
  }
  return {
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
    catalog: normalizeModelCatalog(cache.catalog),
  };
}

export async function readModelCache(file = modelCachePath()) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", file };
    throw error;
  }
  try {
    const cache = validateModelCache(JSON.parse(text));
    return { state: "valid", file, cache };
  } catch (error) {
    if (error instanceof SyntaxError || error?.code === "invalid_cache_schema" || error?.code === "invalid_schema") {
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

export async function writeModelCacheAtomic(
  catalog,
  { file = modelCachePath(), now = Date.now() } = {},
) {
  const normalized = normalizeModelCatalog(catalog);
  const cache = {
    schemaVersion: MODEL_CACHE_SCHEMA_VERSION,
    fetchedAt: new Date(now).toISOString(),
    catalog: normalized,
  };

  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    validateModelCache(JSON.parse(await readFile(temp, "utf8")));
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { cache, file };
}
export async function clearModelCache(file = modelCachePath()) {
  await rm(file, { force: true });
  return { state: "cleared", file };
}

export function diagnoseCatalogDiscrepancies(catalog) {
  const diagnostics = [];
  for (const entry of normalizeModelCatalog(catalog)) {
    const builtIn = MODEL_FAMILIES[entry.family];
    if (!builtIn) {
      diagnostics.push({
        code: "runtime_family_not_builtin",
        model: entry.id,
        family: entry.family,
      });
      continue;
    }

    const runtimeOnly = entry.tiers.filter((tier) => !builtIn.tiers.includes(tier));
    const builtinOnly = builtIn.tiers.filter((tier) => !entry.tiers.includes(tier));
    if (runtimeOnly.length > 0 || builtinOnly.length > 0) {
      diagnostics.push({
        code: "runtime_builtin_tier_discrepancy",
        model: entry.id,
        family: entry.family,
        runtimeOnly,
        builtinOnly,
      });
    }
  }
  return diagnostics;
}

function cacheAgeMs(cache, now) {
  return Math.max(0, now - Date.parse(cache.fetchedAt));
}

export async function inspectModelCache({
  file = modelCachePath(),
  now = Date.now(),
} = {}) {
  if (!Number.isFinite(now)) {
    fail("invalid_schema", "now must be a finite epoch millisecond value", { field: "now" });
  }

  const cached = await readModelCache(file);
  if (cached.state !== "valid") return cached;

  const ageMs = cacheAgeMs(cached.cache, now);
  const freshness = ageMs <= MODEL_CACHE_TTL_MS
    ? "fresh"
    : ageMs <= MODEL_CACHE_STALE_MS
      ? "stale"
      : "expired";

  return {
    ...cached,
    ageMs,
    freshness,
  };
}

export async function resolveModelCatalog({
  runtimeCatalog,
  runtimeError = null,
  cacheFile = modelCachePath(),
  now = Date.now(),
  forceRefresh = false,
  clearCache = false,
} = {}) {
  if (!Number.isFinite(now)) {
    fail("invalid_schema", "now must be a finite epoch millisecond value", { field: "now" });
  }

  if (clearCache) await clearModelCache(cacheFile);

  if (runtimeCatalog !== undefined) {
    const catalog = normalizeModelCatalog(runtimeCatalog);
    await writeModelCacheAtomic(catalog, { file: cacheFile, now });
    return {
      catalog,
      source: "runtime",
      freshness: "live",
      cacheFile,
      diagnostics: diagnoseCatalogDiscrepancies(catalog),
      fallback: { used: false },
    };
  }

  const cached = await inspectModelCache({ file: cacheFile, now });
  if (cached.state !== "valid") {
    return {
      catalog: [],
      source: "builtin",
      freshness: null,
      cacheFile,
      cacheState: cached.state,
      diagnostics: [],
      fallback: runtimeError ? { used: true, reason: "runtime_unavailable" } : { used: false },
    };
  }

  if (!forceRefresh && cached.freshness === "fresh") {
    return {
      catalog: cached.cache.catalog,
      source: "cache",
      freshness: "fresh",
      ageMs: cached.ageMs,
      cacheFile,
      diagnostics: diagnoseCatalogDiscrepancies(cached.cache.catalog),
      fallback: { used: false },
    };
  }

  if (cached.freshness !== "expired") {
    return {
      catalog: cached.cache.catalog,
      source: "cache",
      freshness: "stale",
      ageMs: cached.ageMs,
      cacheFile,
      diagnostics: diagnoseCatalogDiscrepancies(cached.cache.catalog),
      fallback: {
        used: true,
        reason: runtimeError ? "runtime_unavailable" : "runtime_not_supplied",
      },
    };
  }

  return {
    catalog: [],
    source: "builtin",
    freshness: null,
    ageMs: cached.ageMs,
    cacheFile,
    cacheState: "expired",
    diagnostics: [],
    fallback: {
      used: true,
      reason: runtimeError ? "runtime_unavailable_cache_expired" : "cache_expired",
    },
  };
}
