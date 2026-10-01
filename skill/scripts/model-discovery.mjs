#!/usr/bin/env node

import {
  clearModelCache,
  diagnoseCatalogDiscrepancies,
  inspectModelCache,
  modelCachePath,
  normalizeModelCatalog,
  resolveModelCatalog,
} from "./model-catalog.mjs";
import {
  clearModelInventoryCache,
  inspectModelInventoryCache,
  modelInventoryCachePath,
  normalizeModelInventory,
  resolveInventoryCatalog,
  writeModelInventoryCacheAtomic,
} from "./model-inventory.mjs";
import { RoutingError, isPlainObject } from "./routing.mjs";

export const MODEL_DISCOVERY_ERROR_CODES = Object.freeze([
  "provider_unavailable",
  "authentication_required",
  "permission_denied",
  "rate_limited",
  "network_error",
  "invalid_provider_response",
  "unsupported",
]);

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
]);

export class ModelDiscoveryError extends Error {
  constructor(code, message, details = {}) {
    if (!MODEL_DISCOVERY_ERROR_CODES.includes(code)) {
      throw new TypeError(`Unsupported model discovery error code: ${code}`);
    }
    super(message ?? code);
    this.name = "ModelDiscoveryError";
    this.code = code;
    Object.assign(this, details);
  }
}

function discoveryFailure(code, message, details = {}) {
  return new ModelDiscoveryError(code, message, details);
}

export function normalizeDiscoveryError(error) {
  if (MODEL_DISCOVERY_ERROR_CODES.includes(error?.code)) {
    return {
      code: error.code,
      message: error?.message ?? error.code,
    };
  }

  if (
    error?.name === "AbortError"
    || NETWORK_ERROR_CODES.has(error?.code)
    || NETWORK_ERROR_CODES.has(error?.cause?.code)
  ) {
    return {
      code: "network_error",
      message: error?.message ?? "Model discovery network request failed",
    };
  }

  if (
    error instanceof RoutingError
    && new Set(["invalid_schema", "invalid_response"]).has(error.code)
  ) {
    return {
      code: "invalid_provider_response",
      message: error.message,
    };
  }

  return {
    code: "provider_unavailable",
    message: error?.message ?? "Model discovery failed",
  };
}

export function normalizeDiscoveryResult(result) {
  if (!isPlainObject(result)) {
    throw discoveryFailure(
      "invalid_provider_response",
      "Model discovery adapter must return an object",
    );
  }

  const allowed = new Set(["inventory", "catalog"]);
  const unknownField = Object.keys(result).find((key) => !allowed.has(key));
  if (unknownField) {
    throw discoveryFailure(
      "invalid_provider_response",
      `Unexpected model discovery result field: ${unknownField}`,
      { field: unknownField },
    );
  }

  const hasInventory = Object.hasOwn(result, "inventory");
  const hasCatalog = Object.hasOwn(result, "catalog");
  if (hasInventory === hasCatalog) {
    throw discoveryFailure(
      "invalid_provider_response",
      "Model discovery adapter must return exactly one of inventory or catalog",
    );
  }

  try {
    if (hasInventory) {
      if (!Array.isArray(result.inventory)) {
        throw new RoutingError(
          "invalid_schema",
          "Model discovery inventory must be an array",
          { field: "inventory" },
        );
      }
      return {
        kind: "inventory",
        inventory: normalizeModelInventory(result.inventory),
      };
    }
    if (!Array.isArray(result.catalog)) {
      throw new RoutingError(
        "invalid_schema",
        "Model discovery catalog must be an array",
        { field: "catalog" },
      );
    }
    return {
      kind: "catalog",
      catalog: normalizeModelCatalog(result.catalog),
    };
  } catch (error) {
    if (error instanceof RoutingError) {
      throw discoveryFailure(
        "invalid_provider_response",
        error.message,
        { causeCode: error.code },
      );
    }
    throw error;
  }
}

function resolvedInventoryCacheFile(cacheFile, inventoryCacheFile) {
  if (inventoryCacheFile) return inventoryCacheFile;
  return cacheFile === modelCachePath()
    ? modelInventoryCachePath()
    : `${cacheFile}.inventory`;
}

function cachePlan(cached, cacheKind) {
  if (cached.state !== "valid") return null;
  if (cached.freshness === "fresh") {
    return {
      required: false,
      reason: "cache_fresh",
      cacheKind,
      cacheState: "valid",
      ageMs: cached.ageMs,
    };
  }
  if (cached.freshness === "stale") {
    return {
      required: false,
      reason: "cache_stale",
      cacheKind,
      cacheState: "valid",
      ageMs: cached.ageMs,
    };
  }
  return {
    required: true,
    reason: "cache_expired",
    cacheKind,
    cacheState: "expired",
    ageMs: cached.ageMs,
  };
}

export async function planModelDiscovery({
  cacheFile = modelCachePath(),
  inventoryCacheFile,
  now = Date.now(),
  forceRefresh = false,
  clearCache = false,
  liveRefresh = false,
} = {}) {
  if (!Number.isFinite(now)) {
    throw new RoutingError(
      "invalid_schema",
      "now must be a finite epoch millisecond value",
      { field: "now" },
    );
  }

  inventoryCacheFile = resolvedInventoryCacheFile(cacheFile, inventoryCacheFile);

  if (forceRefresh) return { required: true, reason: "force_refresh" };
  if (liveRefresh) return { required: true, reason: "live_refresh" };
  if (clearCache) return { required: false, reason: "cache_cleared" };

  const inventoryCached = await inspectModelInventoryCache({
    file: inventoryCacheFile,
    now,
  });
  const inventoryPlan = cachePlan(inventoryCached, "inventory");
  if (inventoryPlan) return inventoryPlan;
  const legacyCached = await inspectModelCache({ file: cacheFile, now });
  const legacyPlan = cachePlan(legacyCached, "catalog");
  if (legacyPlan) return legacyPlan;

  const invalidated = inventoryCached.state === "invalidated"
    || legacyCached.state === "invalidated";
  return {
    required: true,
    reason: invalidated ? "cache_invalidated" : "cache_missing",
    cacheState: invalidated ? "invalidated" : "missing",
  };
}

function discoveryStatus(plan, extra = {}) {
  return {
    attempted: false,
    reason: plan.reason,
    ...(plan.cacheKind !== undefined ? { cacheKind: plan.cacheKind } : {}),
    ...(plan.cacheState !== undefined ? { cacheState: plan.cacheState } : {}),
    ...(plan.ageMs !== undefined ? { ageMs: plan.ageMs } : {}),
    ...extra,
  };
}

function legacyInventory(catalog) {
  return catalog.map(({ id, available }) => ({ id, available }));
}

function withLegacyInventory(result) {
  return {
    ...result,
    inventory: legacyInventory(result.catalog),
    unclassified: [],
  };
}

async function resolveLiveInventory({
  inventory,
  capabilityRegistry,
  inventoryCacheFile,
  now,
}) {
  const resolved = resolveInventoryCatalog(inventory, { capabilityRegistry });
  await writeModelInventoryCacheAtomic(resolved.inventory, {
    file: inventoryCacheFile,
    now,
  });
  return {
    ...resolved,
    source: "runtime",
    freshness: "live",
    cacheFile: inventoryCacheFile,
    inventoryCacheFile,
    diagnostics: diagnoseCatalogDiscrepancies(resolved.catalog),
    fallback: { used: false },
  };
}

async function resolveCachedInventory({
  capabilityRegistry,
  inventoryCacheFile,
  now,
  refreshFailed = false,
}) {
  const cached = await inspectModelInventoryCache({
    file: inventoryCacheFile,
    now,
  });
  if (cached.state !== "valid" || cached.freshness === "expired") return null;

  const resolved = resolveInventoryCatalog(cached.cache.inventory, {
    capabilityRegistry,
  });
  return {
    ...resolved,
    source: "cache",
    freshness: refreshFailed ? "stale" : cached.freshness,
    ageMs: cached.ageMs,
    cacheFile: inventoryCacheFile,
    inventoryCacheFile,
    diagnostics: diagnoseCatalogDiscrepancies(resolved.catalog),
    fallback: refreshFailed
      ? { used: true, reason: "runtime_unavailable" }
      : { used: false },
  };
}

export async function resolveModelCatalogWithDiscovery({
  discoverModels,
  discoveryContext = {},
  runtimeInventory,
  capabilityRegistry = [],
  runtimeCatalog,
  runtimeError = null,
  cacheFile = modelCachePath(),
  inventoryCacheFile,
  now = Date.now(),
  forceRefresh = false,
  clearCache = false,
  liveRefresh = false,
} = {}) {
  if (!isPlainObject(discoveryContext)) {
    throw new RoutingError(
      "invalid_schema",
      "discoveryContext must be an object",
      { field: "discoveryContext" },
    );
  }

  inventoryCacheFile = resolvedInventoryCacheFile(cacheFile, inventoryCacheFile);
  const refreshRequested = Boolean(forceRefresh || liveRefresh);

  if (clearCache) {
    await Promise.all([
      clearModelInventoryCache(inventoryCacheFile),
      clearModelCache(cacheFile),
    ]);
  }

  if (runtimeInventory !== undefined) {
    const catalog = await resolveLiveInventory({
      inventory: runtimeInventory,
      capabilityRegistry,
      inventoryCacheFile,
      now,
    });
    return {
      ...catalog,
      discovery: {
        attempted: false,
        reason: "runtime_inventory_supplied",
      },
    };
  }

  if (runtimeCatalog !== undefined || runtimeError !== null) {
    const catalog = await resolveModelCatalog({
      ...(runtimeCatalog !== undefined ? { runtimeCatalog } : {}),
      ...(runtimeError !== null ? { runtimeError } : {}),
      cacheFile,
      now,
      forceRefresh: refreshRequested,
      clearCache,
    });
    return {
      ...withLegacyInventory(catalog),
      discovery: {
        attempted: false,
        reason: runtimeCatalog !== undefined
          ? "runtime_catalog_supplied"
          : "runtime_error_supplied",
      },
    };
  }

  const plan = await planModelDiscovery({
    cacheFile,
    inventoryCacheFile,
    now,
    forceRefresh,
    clearCache,
    liveRefresh,
  });

  if (!plan.required) {
    if (plan.cacheKind === "inventory") {
      const cached = await resolveCachedInventory({
        capabilityRegistry,
        inventoryCacheFile,
        now,
      });
      return {
        ...cached,
        discovery: discoveryStatus(plan),
      };
    }

    const catalog = await resolveModelCatalog({
      cacheFile,
      now,
      clearCache,
    });
    return {
      ...withLegacyInventory(catalog),
      discovery: discoveryStatus(plan),
    };
  }

  if (typeof discoverModels !== "function") {
    const legacy = await resolveModelCatalog({
      cacheFile,
      now,
      forceRefresh: refreshRequested,
      clearCache,
    });
    return {
      ...withLegacyInventory(legacy),
      discovery: discoveryStatus(plan, {
        error: {
          code: "unsupported",
          message: "No model discovery adapter is available",
        },
      }),
    };
  }

  let discovered;
  let discoveryError;
  try {
    const raw = await discoverModels({
      reason: plan.reason,
      cacheState: plan.cacheState ?? null,
      ageMs: plan.ageMs ?? null,
      context: discoveryContext,
    });
    discovered = normalizeDiscoveryResult(raw);
  } catch (error) {
    discoveryError = normalizeDiscoveryError(error);
  }

  if (!discoveryError && discovered.kind === "inventory") {
    const catalog = await resolveLiveInventory({
      inventory: discovered.inventory,
      capabilityRegistry,
      inventoryCacheFile,
      now,
    });
    return {
      ...catalog,
      discovery: discoveryStatus(plan, {
        attempted: true,
        outcome: "success",
      }),
    };
  }

  if (!discoveryError && discovered.kind === "catalog") {
    const catalog = await resolveModelCatalog({
      runtimeCatalog: discovered.catalog,
      cacheFile,
      now,
      forceRefresh: refreshRequested,
      clearCache,
    });
    return {
      ...withLegacyInventory(catalog),
      discovery: discoveryStatus(plan, {
        attempted: true,
        outcome: "success",
      }),
    };
  }

  const cachedInventory = await resolveCachedInventory({
    capabilityRegistry,
    inventoryCacheFile,
    now,
    refreshFailed: true,
  });
  if (cachedInventory) {
    return {
      ...cachedInventory,
      discovery: discoveryStatus(plan, {
        attempted: true,
        outcome: "error",
        error: discoveryError,
      }),
    };
  }
  const legacy = await resolveModelCatalog({
    runtimeError: discoveryError,
    cacheFile,
    now,
    forceRefresh: refreshRequested,
    clearCache,
  });
  return {
    ...withLegacyInventory(legacy),
    discovery: discoveryStatus(plan, {
      attempted: true,
      outcome: "error",
      error: discoveryError,
    }),
  };
}
