import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  resolveInventoryCatalog,
  writeModelInventoryCacheAtomic,
} from "../scripts/model-inventory.mjs";
import { resolveModelCatalogWithDiscovery } from "../scripts/model-discovery.mjs";
import { resolveRoutingDecision } from "../scripts/resolver.mjs";

const sol61Capability = {
  id: "gpt-6.1-sol",
  family: "sol",
  tiers: ["balanced", "strong"],
  supportedEfforts: ["medium", "high", "xhigh"],
};

async function tempPaths(name) {
  const dir = await mkdtemp(join(tmpdir(), `codex-route-advisor-inventory-${name}-`));
  return {
    catalogCache: join(dir, "model-cache.json"),
    inventoryCache: join(dir, "model-inventory-cache.json"),
  };
}

test("newly discovered model remains visible but unclassified and non-routable", async () => {
  const paths = await tempPaths("unknown");
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: paths.catalogCache,
    inventoryCacheFile: paths.inventoryCache,
    discoverModels: async () => ({
      inventory: [{ id: "gpt-6.1-sol", available: true }],
    }),
  });

  assert.equal(result.source, "runtime");
  assert.deepEqual(result.inventory, [
    { id: "gpt-6.1-sol", available: true },
  ]);
  assert.deepEqual(result.catalog, []);
  assert.deepEqual(result.unclassified, [{
    id: "gpt-6.1-sol",
    available: true,
    capabilityStatus: "unclassified",
    routable: false,
  }]);
});

test("cached inventory becomes routable after capability update without rediscovery", async () => {
  const paths = await tempPaths("late-capability");
  const now = Date.parse("2026-09-30T00:00:00.000Z");
  await writeModelInventoryCacheAtomic(
    [{ id: "gpt-6.1-sol", available: true }],
    { file: paths.inventoryCache, now },
  );

  let discoveryCalls = 0;
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: paths.catalogCache,
    inventoryCacheFile: paths.inventoryCache,
    now: now + 1000,
    capabilityRegistry: [sol61Capability],
    discoverModels: async () => {
      discoveryCalls += 1;
      return { inventory: [] };
    },
  });

  assert.equal(discoveryCalls, 0);
  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "fresh");
  assert.deepEqual(result.unclassified, []);
  assert.deepEqual(result.catalog, [{
    ...sol61Capability,
    available: true,
  }]);
});

test("mixed inventory routes known model and keeps unknown model unclassified", () => {
  const result = resolveInventoryCatalog([
    { id: "gpt-6.1-sol", available: true },
    { id: "gpt-6.2-sol", available: true },
  ], {
    capabilityRegistry: [sol61Capability],
  });

  assert.deepEqual(result.catalog, [{
    ...sol61Capability,
    available: true,
  }]);
  assert.deepEqual(result.unclassified, [{
    id: "gpt-6.2-sol",
    available: true,
    capabilityStatus: "unclassified",
    routable: false,
  }]);
});

test("classified but unavailable model cannot be selected", () => {
  const classified = resolveInventoryCatalog([
    { id: "gpt-6.1-sol", available: false },
  ], {
    capabilityRegistry: [sol61Capability],
  });

  assert.throws(
    () => resolveRoutingDecision({
      decision: {
        tier: "strong",
        backend: "model",
        confidence: 0.95,
        reason: "deterministic test",
      },
      preferences: {
        strong: { model: "sol", effort: "xhigh" },
      },
      sources: {},
      modelCatalog: classified.catalog,
    }),
    (error) => error.code === "model_unavailable",
  );
});

test("inventory cache location follows a custom catalog cache during tests", async () => {
  const paths = await tempPaths("derived-cache");
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: paths.catalogCache,
    runtimeInventory: [{ id: "gpt-6.1-sol", available: true }],
    capabilityRegistry: [sol61Capability],
  });

  assert.equal(result.source, "runtime");
  assert.equal(result.cacheFile, `${paths.catalogCache}.inventory`);
  assert.equal(result.catalog[0].id, "gpt-6.1-sol");
});

test("route-task error preserves discovered unclassified inventory diagnostics", async () => {
  const paths = await tempPaths("cli-unclassified");
  const script = fileURLToPath(new URL("../scripts/route-task.mjs", import.meta.url));
  const input = {
    task: "route a strong implementation task",
    workspaceRoot: join(paths.catalogCache, ".."),
    globalConfigPath: join(paths.catalogCache, "..", "missing-global.json"),
    modelCachePath: paths.catalogCache,
    modelInventoryCachePath: paths.inventoryCache,
    routerPreference: "model",
    modelDecision: {
      tier: "strong",
      confidence: 0.95,
      reason: "deterministic strong route",
    },
    modelDiscovery: {
      inventory: [{ id: "gpt-6.1-sol", available: true }],
    },
    catalog: { liveRefresh: true },
  };

  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });

  assert.equal(result.status, 1, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.error, "model_unavailable");
  assert.equal(output.catalog.source, "runtime");
  assert.equal(output.catalog.discovery.outcome, "success");
  assert.deepEqual(output.catalog.unclassified, [{
    id: "gpt-6.1-sol",
    available: true,
    capabilityStatus: "unclassified",
    routable: false,
  }]);
});
