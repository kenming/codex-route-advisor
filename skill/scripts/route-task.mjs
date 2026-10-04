#!/usr/bin/env node

import process from "node:process";
import { loadPreferences } from "./config.mjs";
import { discoverCodexModels } from "./codex-model-source.mjs";
import { resolveModelCatalogWithDiscovery } from "./model-discovery.mjs";
import { resolveExplicitOverride, resolveRoutingDecision } from "./resolver.mjs";
import { RoutingError, isPlainObject, routeTask } from "./routing.mjs";

async function readInput() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  if (!text.trim()) {
    throw new RoutingError("invalid_schema", "Expected a JSON request on stdin");
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RoutingError("invalid_schema", `Invalid JSON request: ${error.message}`);
  }
}

function adapterFromDecision(decision, errorSpec) {
  if (errorSpec) {
    return async () => {
      const error = new Error(errorSpec.message ?? errorSpec.code ?? "router failure");
      error.code = errorSpec.code;
      throw error;
    };
  }
  if (decision === undefined) return undefined;
  return async () => decision;
}

function discoveryAdapterFromInput(spec) {
  if (spec === undefined) return undefined;
  if (!isPlainObject(spec)) {
    throw new RoutingError("invalid_schema", "modelDiscovery must be an object", {
      field: "modelDiscovery",
    });
  }

  const allowedFields = new Set(["inventory", "catalog", "error"]);
  const unknownField = Object.keys(spec).find((key) => !allowedFields.has(key));
  if (unknownField) {
    throw new RoutingError(
      "invalid_schema",
      `Unexpected modelDiscovery field: ${unknownField}`,
      { field: `modelDiscovery.${unknownField}` },
    );
  }
  const defined = [
    spec.inventory !== undefined,
    spec.catalog !== undefined,
    spec.error !== undefined,
  ].filter(Boolean).length;
  if (defined !== 1) {
    throw new RoutingError(
      "invalid_schema",
      "modelDiscovery requires exactly one of inventory, catalog, or error",
      { field: "modelDiscovery" },
    );
  }
  if (spec.inventory !== undefined) {
    return async () => ({ inventory: spec.inventory });
  }
  if (spec.catalog !== undefined) {
    return async () => ({ catalog: spec.catalog });
  }
  if (spec.error !== undefined) {
    if (!isPlainObject(spec.error) || typeof spec.error.code !== "string") {
      throw new RoutingError(
        "invalid_schema",
        "modelDiscovery.error requires a string code",
        { field: "modelDiscovery.error" },
      );
    }
    return async () => {
      const error = new Error(spec.error.message ?? spec.error.code);
      error.code = spec.error.code;
      throw error;
    };
  }

  throw new RoutingError(
    "invalid_schema",
    "modelDiscovery requires inventory, catalog, or error",
    { field: "modelDiscovery" },
  );
}

function catalogMetadata(catalog) {
  return {
    source: catalog.source,
    freshness: catalog.freshness,
    fallback: catalog.fallback,
    diagnostics: catalog.diagnostics,
    cacheState: catalog.cacheState ?? null,
    inventory: catalog.inventory ?? [],
    unclassified: catalog.unclassified ?? [],
    compatibility: catalog.compatibility ?? {
      classified: [],
      unclassified: [],
      unavailable: [],
    },
    discovery: catalog.discovery ?? null,
  };
}

function cleanError(error) {
  const result = {
    state: "error",
    error: error?.code ?? "service_error",
    message: error?.message ?? "Unknown error",
  };

  for (const key of [
    "source",
    "tier",
    "field",
    "model",
    "effort",
    "confidence",
    "reason",
    "fallback",
    "catalog",
  ]) {
    if (error?.[key] !== undefined) result[key] = error[key];
  }
  return result;
}

async function main() {
  const input = await readInput();
  const preferences = await loadPreferences({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    sessionOverride: input.session ?? {},
    ...(input.globalConfigPath ? { globalPath: input.globalConfigPath } : {}),
    ...(input.workspaceConfigPath ? { workspacePath: input.workspaceConfigPath } : {}),
  });

  const discoverModels = discoveryAdapterFromInput(input.modelDiscovery)
    ?? discoverCodexModels;
  const catalog = await resolveModelCatalogWithDiscovery({
    discoverModels,
    ...(input.modelInventory !== undefined ? { runtimeInventory: input.modelInventory } : {}),
    ...(input.modelCapabilities !== undefined
      ? { capabilityRegistry: input.modelCapabilities }
      : {}),
    ...(input.modelCatalog !== undefined ? { runtimeCatalog: input.modelCatalog } : {}),
    ...(input.modelCatalogError !== undefined ? { runtimeError: input.modelCatalogError } : {}),
    ...(input.modelCachePath ? { cacheFile: input.modelCachePath } : {}),
    ...(input.modelInventoryCachePath
      ? { inventoryCacheFile: input.modelInventoryCachePath }
      : {}),
    ...(input.modelDiscoveryContext !== undefined
      ? { discoveryContext: input.modelDiscoveryContext }
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

  const effectiveCatalog = catalog.source === "builtin"
    ? undefined
    : catalog.catalog;

  let routingDecision = null;
  let effectiveDecision;

  try {
    if (input.explicitOverride !== undefined) {
      effectiveDecision = resolveExplicitOverride({
        override: input.explicitOverride,
        ...(effectiveCatalog === undefined ? {} : { modelCatalog: effectiveCatalog }),
      });
    } else {
      const jevRouter = adapterFromDecision(input.jevDecision, input.jevError);
      const modelRouter = adapterFromDecision(input.modelDecision, input.modelError);
      routingDecision = await routeTask({
        task: input.task,
        routerPreference: input.routerPreference ?? preferences.router,
        jevRouter,
        modelRouter,
        ...(input.confidenceThreshold !== undefined
          ? { confidenceThreshold: input.confidenceThreshold }
          : {}),
      });

      effectiveDecision = resolveRoutingDecision({
        decision: routingDecision,
        preferences: preferences.routing,
        sources: preferences.sources,
        ...(effectiveCatalog === undefined ? {} : { modelCatalog: effectiveCatalog }),
      });
    }
  } catch (error) {
    if (error && typeof error === "object" && error.catalog === undefined) {
      error.catalog = catalogMetadata(catalog);
    }
    throw error;
  }

  process.stdout.write(`${JSON.stringify({
    state: "resolved",
    decision: effectiveDecision,
    routingDecision,
    catalog: catalogMetadata(catalog),
  })}\n`);
}

await main().catch((error) => {
  const normalized = error instanceof RoutingError
    ? error
    : new RoutingError("service_error", error?.message ?? "Unexpected routing failure");
  process.stdout.write(`${JSON.stringify(cleanError(normalized))}\n`);
  process.exitCode = 1;
});
