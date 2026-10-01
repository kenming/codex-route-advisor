import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  MODEL_CACHE_STALE_MS,
  MODEL_CACHE_TTL_MS,
  readModelCache,
  writeModelCacheAtomic,
} from "../scripts/model-catalog.mjs";
import {
  ModelDiscoveryError,
  normalizeDiscoveryError,
  planModelDiscovery,
  resolveModelCatalogWithDiscovery,
} from "../scripts/model-discovery.mjs";

const catalog = [{
  id: "sol-live",
  family: "sol",
  tiers: ["balanced", "strong"],
  supportedEfforts: ["medium", "high", "xhigh"],
  available: true,
}];
const fastCatalog = [{
  id: "luna-live",
  family: "luna",
  tiers: ["fast"],
  supportedEfforts: ["high"],
  available: true,
}];

async function tempCache(name) {
  const dir = await mkdtemp(join(tmpdir(), `codex-route-advisor-discovery-${name}-`));
  return join(dir, "model-cache.json");
}

test("missing cache requires model discovery", async () => {
  const file = await tempCache("missing");
  const plan = await planModelDiscovery({ cacheFile: file });

  assert.equal(plan.required, true);
  assert.equal(plan.reason, "cache_missing");
  assert.equal(plan.cacheState, "missing");
});

test("fresh cache suppresses automatic model discovery", async () => {
  const file = await tempCache("fresh");
  const fetched = Date.parse("2026-09-26T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const plan = await planModelDiscovery({
    cacheFile: file,
    now: fetched + MODEL_CACHE_TTL_MS,
  });

  assert.equal(plan.required, false);
  assert.equal(plan.reason, "cache_fresh");
});
test("stale cache is reused until explicit refresh while expired cache requests discovery", async () => {
  const file = await tempCache("age");
  const fetched = Date.parse("2026-09-01T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const stale = await planModelDiscovery({
    cacheFile: file,
    now: fetched + MODEL_CACHE_TTL_MS + 1,
  });
  assert.equal(stale.required, false);
  assert.equal(stale.reason, "cache_stale");

  const expired = await planModelDiscovery({
    cacheFile: file,
    now: fetched + MODEL_CACHE_STALE_MS + 1,
  });
  assert.equal(expired.required, true);
  assert.equal(expired.reason, "cache_expired");
});

test("stale cache does not call discovery without an explicit refresh trigger", async () => {
  const file = await tempCache("stale-no-refresh");
  const fetched = Date.parse("2026-09-20T00:00:00.000Z");
  const now = fetched + MODEL_CACHE_TTL_MS + 1;
  await writeModelCacheAtomic([{ ...catalog[0], id: "sol-old" }], {
    file,
    now: fetched,
  });

  let calls = 0;
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    now,
    discoverModels: async () => {
      calls += 1;
      return { catalog };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.equal(result.discovery.attempted, false);
  assert.equal(result.discovery.reason, "cache_stale");
});
test("discovery failure keeps eligible stale cache and normalized error", async () => {
  const file = await tempCache("stale-error");
  const fetched = Date.parse("2026-09-20T00:00:00.000Z");
  const now = fetched + MODEL_CACHE_TTL_MS + 1;
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    now,
    liveRefresh: true,
    discoverModels: async () => {
      throw new ModelDiscoveryError("rate_limited", "provider throttled");
    },
  });

  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.equal(result.fallback.reason, "runtime_unavailable");
  assert.equal(result.discovery.reason, "live_refresh");
  assert.equal(result.discovery.outcome, "error");
  assert.deepEqual(result.discovery.error, {
    code: "rate_limited",
    message: "provider throttled",
  });
});

test("expired cache plus discovery failure falls back to built-in", async () => {
  const file = await tempCache("expired-error");
  const fetched = Date.parse("2026-09-01T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    now: fetched + MODEL_CACHE_STALE_MS + 1,
    discoverModels: async () => {
      const error = new Error("offline");
      error.code = "ENETUNREACH";
      throw error;
    },
  });
  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "expired");
  assert.equal(result.fallback.reason, "runtime_unavailable_cache_expired");
  assert.equal(result.discovery.reason, "cache_expired");
  assert.equal(result.discovery.error.code, "network_error");
});

test("force refresh bypasses fresh cache while preserving it on failure", async () => {
  const file = await tempCache("force-refresh");
  const fetched = Date.parse("2026-09-26T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    now: fetched + 1000,
    forceRefresh: true,
    discoverModels: async () => {
      throw new ModelDiscoveryError("provider_unavailable", "temporarily unavailable");
    },
  });

  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.equal(result.discovery.reason, "force_refresh");
  assert.equal(result.discovery.outcome, "error");
});

test("explicit live refresh replaces an otherwise fresh cache", async () => {
  const file = await tempCache("live-refresh");
  const fetched = Date.parse("2026-09-26T00:00:00.000Z");
  await writeModelCacheAtomic([{ ...catalog[0], id: "sol-old" }], {
    file,
    now: fetched,
  });
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    now: fetched + 1000,
    liveRefresh: true,
    discoverModels: async () => ({ catalog }),
  });

  assert.equal(result.source, "runtime");
  assert.equal(result.catalog[0].id, "sol-live");
  assert.equal(result.discovery.reason, "live_refresh");
});

test("invalid adapter payload is normalized as invalid_provider_response", async () => {
  const file = await tempCache("invalid-response");
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    discoverModels: async () => ({ models: catalog }),
  });

  assert.equal(result.source, "builtin");
  assert.equal(result.discovery.outcome, "error");
  assert.equal(result.discovery.error.code, "invalid_provider_response");
});

test("undefined catalog is rejected without overwriting eligible stale cache", async () => {
  const file = await tempCache("undefined-catalog");
  const fetched = Date.parse("2026-09-20T00:00:00.000Z");
  const now = fetched + MODEL_CACHE_TTL_MS + 1;
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    now,
    liveRefresh: true,
    discoverModels: async () => ({ catalog: undefined }),
  });

  assert.equal(result.discovery.outcome, "error");
  assert.equal(result.discovery.error.code, "invalid_provider_response");
  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.deepEqual(result.catalog, catalog);
  const stored = await readModelCache(file);
  assert.deepEqual(stored.cache.catalog, catalog);
  assert.equal(stored.cache.fetchedAt, new Date(fetched).toISOString());
});

test("missing adapter preserves Phase 4 fallback and reports unsupported discovery", async () => {
  const file = await tempCache("unsupported");
  const result = await resolveModelCatalogWithDiscovery({ cacheFile: file });

  assert.equal(result.source, "builtin");
  assert.deepEqual(result.fallback, { used: false });
  assert.equal(result.discovery.attempted, false);
  assert.equal(result.discovery.error.code, "unsupported");
});

test("clear cache does not imply live discovery", async () => {
  const file = await tempCache("clear-only");
  await writeModelCacheAtomic(catalog, { file, now: Date.now() });

  let calls = 0;
  const result = await resolveModelCatalogWithDiscovery({
    cacheFile: file,
    clearCache: true,
    discoverModels: async () => {
      calls += 1;
      return { catalog };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "missing");
  assert.equal(result.discovery.reason, "cache_cleared");
});

test("unknown adapter failures normalize to provider_unavailable", () => {
  assert.deepEqual(normalizeDiscoveryError(new Error("boom")), {
    code: "provider_unavailable",
    message: "boom",
  });
});
test("nested transport cause normalizes to network_error", () => {
  const error = new TypeError("fetch failed");
  error.cause = { code: "ECONNREFUSED" };
  assert.deepEqual(normalizeDiscoveryError(error), {
    code: "network_error",
    message: "fetch failed",
  });
});
test("route-task accepts deterministic discovery input for host integration tests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-discovery-cli-"));
  const cacheFile = join(dir, "model-cache.json");
  const script = fileURLToPath(new URL("../scripts/route-task.mjs", import.meta.url));
  const fetched = Date.parse("2026-09-26T00:00:00.000Z");
  await writeModelCacheAtomic([{
    ...fastCatalog[0],
    id: "luna-old",
  }], { file: cacheFile, now: fetched });

  const input = {
    task: "bounded deterministic task",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    modelCachePath: cacheFile,
    routerPreference: "model",
    modelDecision: {
      tier: "fast",
      confidence: 0.9,
      reason: "deterministic routing decision",
    },
    modelDiscovery: { catalog: fastCatalog },
    catalog: { liveRefresh: true },
  };

  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());

  assert.equal(output.catalog.source, "runtime");
  assert.equal(output.catalog.discovery.attempted, true);
  assert.equal(output.catalog.discovery.reason, "live_refresh");
  assert.equal(output.decision.model, "luna-live");
});
