import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  MODEL_CACHE_STALE_MS,
  MODEL_CACHE_TTL_MS,
  diagnoseCatalogDiscrepancies,
  readModelCache,
  resolveModelCatalog,
  writeModelCacheAtomic,
} from "../scripts/model-catalog.mjs";

const catalog = [{
  id: "sol-current",
  family: "sol",
  tiers: ["balanced", "strong"],
  supportedEfforts: ["medium", "high", "xhigh"],
  available: true,
}];

async function tempCache(name) {
  const dir = await mkdtemp(join(tmpdir(), `codex-route-advisor-${name}-`));
  return join(dir, "model-cache.json");
}

test("runtime catalog has precedence and is persisted atomically", async () => {
  const file = await tempCache("runtime");
  const now = Date.parse("2026-09-26T04:00:00.000Z");
  const result = await resolveModelCatalog({
    runtimeCatalog: catalog,
    cacheFile: file,
    now,
  });

  assert.equal(result.source, "runtime");
  assert.equal(result.freshness, "live");
  assert.deepEqual(result.catalog, catalog);

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.equal(saved.schemaVersion, 1);
  assert.equal(saved.fetchedAt, "2026-09-26T04:00:00.000Z");
  assert.deepEqual(saved.catalog, catalog);
});

test("fresh cache is used within the 24 hour TTL", async () => {
  const file = await tempCache("fresh");
  const fetched = Date.parse("2026-09-25T12:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalog({
    cacheFile: file,
    now: fetched + MODEL_CACHE_TTL_MS,
  });

  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "fresh");
  assert.equal(result.fallback.used, false);
});

test("cache becomes stale after TTL but remains usable for seven days", async () => {
  const file = await tempCache("stale");
  const fetched = Date.parse("2026-09-20T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalog({
    cacheFile: file,
    now: fetched + MODEL_CACHE_TTL_MS + 1,
    runtimeError: { code: "service_unavailable" },
  });

  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.deepEqual(result.fallback, {
    used: true,
    reason: "runtime_unavailable",
  });
});

test("cache older than seven days falls back to built-in capabilities", async () => {
  const file = await tempCache("expired");
  const fetched = Date.parse("2026-09-01T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalog({
    cacheFile: file,
    now: fetched + MODEL_CACHE_STALE_MS + 1,
  });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "expired");
  assert.deepEqual(result.catalog, []);
});

test("incompatible cache schema is invalidated and rebuilt from built-in state", async () => {
  const file = await tempCache("schema");
  await writeFile(file, JSON.stringify({
    schemaVersion: 99,
    fetchedAt: "2026-09-26T00:00:00.000Z",
    catalog,
  }), "utf8");

  const result = await resolveModelCatalog({ cacheFile: file });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "invalidated");
  const reread = await readModelCache(file);
  assert.equal(reread.state, "missing");
});

test("clear cache removes prior runtime state before selection", async () => {
  const file = await tempCache("clear");
  await writeModelCacheAtomic(catalog, { file, now: Date.now() });

  const result = await resolveModelCatalog({
    cacheFile: file,
    clearCache: true,
  });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "missing");
});

test("force refresh does not treat an otherwise fresh cache as fresh", async () => {
  const file = await tempCache("refresh");
  const fetched = Date.parse("2026-09-26T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });
  const result = await resolveModelCatalog({
    cacheFile: file,
    now: fetched + 1000,
    forceRefresh: true,
    runtimeError: { code: "network_error" },
  });

  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.equal(result.fallback.reason, "runtime_unavailable");
});

test("runtime and built-in tier discrepancies are diagnostic only", () => {
  const diagnostics = diagnoseCatalogDiscrepancies([
    {
      id: "sol-runtime",
      family: "sol",
      tiers: ["balanced"],
      supportedEfforts: ["medium"],
      available: true,
    },
    {
      id: "nova-runtime",
      family: "nova",
      tiers: ["fast"],
      supportedEfforts: ["high"],
      available: true,
    },
  ]);

  assert.deepEqual(diagnostics, [
    {
      code: "runtime_builtin_tier_discrepancy",
      model: "sol-runtime",
      family: "sol",
      runtimeOnly: [],
      builtinOnly: ["strong"],
    },
    {
      code: "runtime_family_not_builtin",
      model: "nova-runtime",
      family: "nova",
    },
  ]);
});

test("duplicate catalog model ids are rejected", async () => {
  const file = await tempCache("duplicates");
  await assert.rejects(
    () => resolveModelCatalog({
      runtimeCatalog: [catalog[0], { ...catalog[0] }],
      cacheFile: file,
    }),
    (error) => error.code === "invalid_schema" && error.field === "modelCatalog.id",
  );
});

test("route-task exposes runtime then cached catalog metadata", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-cli-"));
  const cacheFile = join(dir, "model-cache.json");
  const script = fileURLToPath(new URL("../scripts/route-task.mjs", import.meta.url));
  const globalConfigPath = join(dir, "missing-global.json");

  const baseInput = {
    task: "bounded deterministic task",
    workspaceRoot: dir,
    globalConfigPath,
    routerPreference: "model",
    modelDecision: {
      tier: "fast",
      confidence: 0.9,
      reason: "deterministic routing decision",
    },
    modelCachePath: cacheFile,
  };

  const runtimeInput = {
    ...baseInput,
    modelCatalog: [{
      id: "luna-current",
      family: "luna",
      tiers: ["fast"],
      supportedEfforts: ["high"],
      available: true,
    }],
  };

  const first = spawnSync(process.execPath, [script], {
    input: JSON.stringify(runtimeInput),
    encoding: "utf8",
  });
  assert.equal(first.status, 0, first.stderr);
  const firstOutput = JSON.parse(first.stdout.trim());
  assert.equal(firstOutput.catalog.source, "runtime");
  assert.equal(firstOutput.decision.model, "luna-current");

  const second = spawnSync(process.execPath, [script], {
    input: JSON.stringify(baseInput),
    encoding: "utf8",
  });
  assert.equal(second.status, 0, second.stderr);
  const secondOutput = JSON.parse(second.stdout.trim());
  assert.equal(secondOutput.catalog.source, "cache");
  assert.equal(secondOutput.catalog.freshness, "fresh");
  assert.equal(secondOutput.decision.model, "luna-current");
});

test("route-task built-in fallback remains unchecked when no runtime/cache catalog exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-builtin-"));
  const script = fileURLToPath(new URL("../scripts/route-task.mjs", import.meta.url));
  const input = {
    task: "bounded deterministic task",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    modelCachePath: join(dir, "missing-cache.json"),
    modelDiscovery: {
      error: {
        code: "provider_unavailable",
        message: "deterministic no-provider fallback",
      },
    },
    routerPreference: "model",
    modelDecision: {
      tier: "fast",
      confidence: 0.9,
      reason: "deterministic routing decision",
    },
  };

  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.catalog.source, "builtin");
  assert.equal(output.decision.availability, "unchecked");
  assert.equal(output.decision.modelFamily, "luna");
  assert.equal(output.decision.model, "luna");
});

test("cache is still eligible exactly at the seven-day stale boundary", async () => {
  const file = await tempCache("seven-day-boundary");
  const fetched = Date.parse("2026-09-01T00:00:00.000Z");
  await writeModelCacheAtomic(catalog, { file, now: fetched });

  const result = await resolveModelCatalog({
    cacheFile: file,
    now: fetched + MODEL_CACHE_STALE_MS,
    runtimeError: { code: "service_unavailable" },
  });

  assert.equal(result.source, "cache");
  assert.equal(result.freshness, "stale");
  assert.equal(result.fallback.reason, "runtime_unavailable");
});

test("cache missing required catalog field is invalidated", async () => {
  const file = await tempCache("missing-catalog");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026-09-26T00:00:00.000Z",
  }), "utf8");

  const result = await resolveModelCatalog({ cacheFile: file });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "invalidated");
  const reread = await readModelCache(file);
  assert.equal(reread.state, "missing");
});

test("cache fetchedAt rejects non-canonical timestamp strings", async () => {
  const file = await tempCache("invalid-date-time");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026",
    catalog,
  }), "utf8");

  const result = await resolveModelCatalog({ cacheFile: file });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "invalidated");
  const reread = await readModelCache(file);
  assert.equal(reread.state, "missing");
});

test("cache fetchedAt rejects impossible calendar dates", async () => {
  const file = await tempCache("invalid-calendar-date");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026-02-30T00:00:00.000Z",
    catalog,
  }), "utf8");

  const result = await resolveModelCatalog({ cacheFile: file });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "invalidated");
  const reread = await readModelCache(file);
  assert.equal(reread.state, "missing");
});

test("cache runtime validation rejects top-level additional properties", async () => {
  const file = await tempCache("cache-extra-field");
  await writeFile(file, JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026-09-26T00:00:00.000Z",
    catalog,
    extra: true,
  }), "utf8");

  const result = await resolveModelCatalog({ cacheFile: file });

  assert.equal(result.source, "builtin");
  assert.equal(result.cacheState, "invalidated");
});

test("catalog runtime validation rejects entry additional properties", async () => {
  const file = await tempCache("entry-extra-field");
  await assert.rejects(
    () => resolveModelCatalog({
      runtimeCatalog: [{
        ...catalog[0],
        extra: true,
      }],
      cacheFile: file,
    }),
    (error) => (
      error.code === "invalid_schema"
      && error.field === "modelCatalog.extra"
    ),
  );
});

test("cache fetchedAt accepts only the canonical UTC writer format", async () => {
  const acceptedFile = await tempCache("canonical-time");
  await writeFile(acceptedFile, JSON.stringify({
    schemaVersion: 1,
    fetchedAt: "2026-09-26T00:00:00.000Z",
    catalog,
  }), "utf8");

  const accepted = await resolveModelCatalog({ cacheFile: acceptedFile });
  assert.equal(accepted.source, "cache");

  for (const [name, fetchedAt] of [
    ["no-milliseconds", "2026-09-26T00:00:00Z"],
    ["offset", "2026-09-26T08:00:00.000+08:00"],
    ["lowercase-t", "2026-09-26t00:00:00.000Z"],
    ["lowercase-z", "2026-09-26T00:00:00.000z"],
  ]) {
    const file = await tempCache(`noncanonical-${name}`);
    await writeFile(file, JSON.stringify({
      schemaVersion: 1,
      fetchedAt,
      catalog,
    }), "utf8");

    const result = await resolveModelCatalog({ cacheFile: file });
    assert.equal(result.source, "builtin", name);
    assert.equal(result.cacheState, "invalidated", name);
  }
});
