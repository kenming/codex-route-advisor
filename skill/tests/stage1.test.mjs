import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergePreferenceLayers } from "../scripts/config.mjs";
import { resolveExplicitOverride } from "../scripts/resolver.mjs";

const configureScript = fileURLToPath(new URL("../scripts/configure.mjs", import.meta.url));
const routeTaskScript = fileURLToPath(new URL("../scripts/route-task.mjs", import.meta.url));

function runJson(script, input) {
  const result = spawnSync(process.execPath, [script], {
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return {
    status: result.status,
    stderr: result.stderr,
    output: JSON.parse(result.stdout.trim()),
  };
}

test("Stage 1 defaults are keyed directly by routing tier", () => {
  const merged = mergePreferenceLayers();
  assert.deepEqual(merged.routing, {
    fast: { model: "luna", effort: "high" },
    balanced: { model: "sol", effort: "medium" },
    strong: { model: "sol", effort: "xhigh" },
    long: { model: "astra", effort: "medium" },
  });
});

test("explicit override bypasses classification and validates the requested model", () => {
  const result = resolveExplicitOverride({
    override: { model: "luna-current", reasoningEffort: "max" },
    modelCatalog: [{
      id: "luna-current",
      family: "luna",
      tiers: ["fast"],
      supportedEfforts: ["high", "max"],
      available: true,
    }],
  });

  assert.equal(result.tier, "fast");
  assert.equal(result.model, "luna-current");
  assert.equal(result.reasoningEffort, "max");
  assert.equal(result.decisionSource, "user_override");
  assert.equal(result.dispatchStatus, "not_dispatched");
  assert.equal(result.fallback, null);
});

test("explicit override never silently replaces an unavailable concrete model", () => {
  assert.throws(
    () => resolveExplicitOverride({
      override: { model: "luna-old", reasoningEffort: "max" },
      modelCatalog: [
        {
          id: "luna-old",
          family: "luna",
          tiers: ["fast"],
          supportedEfforts: ["max"],
          available: false,
        },
        {
          id: "luna-new",
          family: "luna",
          tiers: ["fast"],
          supportedEfforts: ["max"],
          available: true,
        },
      ],
    }),
    (error) => (
      error.code === "model_unavailable"
      && error.model === "luna-old"
      && error.explicitOverride === true
    ),
  );
});

test("configure supports Workspace persistence and inspection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-configure-"));
  const globalFile = join(dir, "global.json");
  const workspaceFile = join(dir, "workspace.json");

  const saved = runJson(configureScript, {
    scope: "workspace",
    file: workspaceFile,
    router: "jev",
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.output.saved, true);
  assert.equal(saved.output.scope, "workspace");
  assert.equal(saved.output.config.router.prefer, "jev");

  const inspected = runJson(configureScript, {
    action: "inspect",
    workspaceRoot: dir,
    globalConfigPath: globalFile,
    workspaceConfigPath: workspaceFile,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.output.config.workspace.exists, true);
  assert.equal(inspected.output.config.global.exists, false);
  assert.equal(inspected.output.effective.router.prefer, "jev");
});

test("configure Session scope returns an override without persistence", () => {
  const result = runJson(configureScript, {
    scope: "session",
    router: "model",
    executionMode: "plan",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.saved, false);
  assert.equal(result.output.scope, "session");
  assert.equal(result.output.session.router.backend, "model");
  assert.equal(result.output.session.executionMode, "plan");
});

test("configure persists and inspects enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-enabled-"));
  const file = join(dir, "workspace.json");

  const saved = runJson(configureScript, {
    scope: "workspace",
    file,
    enabled: false,
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.output.config.enabled, false);

  const inspected = runJson(configureScript, {
    action: "inspect",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    workspaceConfigPath: file,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.output.effective.enabled, false);
  assert.equal(inspected.output.effective.enabledSource, "workspace");
});

test("configure persists and inspects executionMode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-mode-"));
  const file = join(dir, "workspace.json");

  const saved = runJson(configureScript, {
    scope: "workspace",
    file,
    executionMode: "auto",
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.output.config.executionMode, "auto");

  const inspected = runJson(configureScript, {
    action: "inspect",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    workspaceConfigPath: file,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.output.effective.executionMode, "auto");
  assert.equal(inspected.output.effective.executionModeSource, "workspace");
});

test("configure persists and inspects allowModelEscalation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-escalation-"));
  const file = join(dir, "workspace.json");

  const saved = runJson(configureScript, {
    scope: "workspace",
    file,
    allowModelEscalation: true,
  });
  assert.equal(saved.status, 0, saved.stderr);
  assert.equal(saved.output.config.allowModelEscalation, true);

  const inspected = runJson(configureScript, {
    action: "inspect",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    workspaceConfigPath: file,
  });
  assert.equal(inspected.status, 0, inspected.stderr);
  assert.equal(inspected.output.effective.allowModelEscalation, true);
  assert.equal(inspected.output.effective.allowModelEscalationSource, "workspace");
});

test("route-task emits EffectiveRoutingDecision as the primary JSON result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-stage1-"));
  const result = runJson(routeTaskScript, {
    task: "diagnose cross-subsystem rollback",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    modelCachePath: join(dir, "missing-cache.json"),
    modelDiscovery: {
      inventory: [{ id: "gpt-5.6-sol", available: true }],
    },
    routerPreference: "model",
    modelDecision: {
      tier: "strong",
      confidence: 0.91,
      reason: "unknown root cause across interacting subsystems",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.decision.tier, "strong");
  assert.equal(result.output.decision.model, "gpt-5.6-sol");
  assert.equal(result.output.decision.reasoningEffort, "xhigh");
  assert.equal(result.output.decision.decisionSource, "model");
  assert.equal(result.output.decision.dispatchStatus, "not_dispatched");
});

test("route-task explicitOverride skips routing classification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-override-"));
  const result = runJson(routeTaskScript, {
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    modelCachePath: join(dir, "missing-cache.json"),
    modelDiscovery: {
      inventory: [{ id: "gpt-5.6-luna", available: true }],
    },
    explicitOverride: {
      model: "luna",
      reasoningEffort: "max",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.routingDecision, null);
  assert.equal(result.output.decision.tier, "fast");
  assert.equal(result.output.decision.model, "gpt-5.6-luna");
  assert.equal(result.output.decision.decisionSource, "user_override");
  assert.equal(result.output.decision.dispatchStatus, "not_dispatched");
});

test("explicit override infers tier from the locked default profile when unique", () => {
  const result = resolveExplicitOverride({
    override: { model: "sol-current", reasoningEffort: "medium" },
    modelCatalog: [{
      id: "sol-current",
      family: "sol",
      tiers: ["balanced", "strong"],
      supportedEfforts: ["medium", "high", "xhigh"],
      available: true,
    }],
  });

  assert.equal(result.tier, "balanced");
  assert.equal(result.model, "sol-current");
});

test("explicit override requires tier when a multi-tier model cannot be inferred uniquely", () => {
  assert.throws(
    () => resolveExplicitOverride({
      override: { model: "sol-current", reasoningEffort: "high" },
      modelCatalog: [{
        id: "sol-current",
        family: "sol",
        tiers: ["balanced", "strong"],
        supportedEfforts: ["medium", "high", "xhigh"],
        available: true,
      }],
    }),
    (error) => (
      error.code === "explicit_override_tier_required"
      && error.field === "explicitOverride.tier"
    ),
  );
});

test("explicit override accepts an explicit valid tier for multi-tier models", () => {
  const result = resolveExplicitOverride({
    override: {
      tier: "strong",
      model: "sol-current",
      reasoningEffort: "high",
    },
    modelCatalog: [{
      id: "sol-current",
      family: "sol",
      tiers: ["balanced", "strong"],
      supportedEfforts: ["medium", "high", "xhigh"],
      available: true,
    }],
  });

  assert.equal(result.tier, "strong");
  assert.equal(result.reasoningEffort, "high");
});

test("configure preserves existing same-scope settings on router-only and partial tier updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-patch-"));
  const file = join(dir, "workspace.json");

  const initial = runJson(configureScript, {
    scope: "workspace",
    file,
    router: "jev",
    routing: {
      balanced: { model: "sol-custom", effort: "high" },
      strong: { model: "sol-strong", effort: "xhigh" },
    },
  });
  assert.equal(initial.status, 0, initial.stderr);

  const routerOnly = runJson(configureScript, {
    scope: "workspace",
    file,
    router: "model",
  });
  assert.equal(routerOnly.status, 0, routerOnly.stderr);
  assert.deepEqual(routerOnly.output.config.routing, {
    balanced: { model: "sol-custom", effort: "high" },
    strong: { model: "sol-strong", effort: "xhigh" },
  });

  const partialTier = runJson(configureScript, {
    scope: "workspace",
    file,
    routing: {
      strong: { effort: "high" },
    },
  });
  assert.equal(partialTier.status, 0, partialTier.stderr);
  assert.deepEqual(partialTier.output.config.routing, {
    balanced: { model: "sol-custom", effort: "high" },
    strong: { model: "sol-strong", effort: "high" },
  });
  assert.deepEqual(partialTier.output.config.router, { backend: "model", prefer: "model" });
});

test("Session patch does not inject an unrelated router preference", () => {
  const result = runJson(configureScript, {
    scope: "session",
    routing: {
      fast: { effort: "xhigh" },
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output.session.router, undefined);
  assert.deepEqual(result.output.session.routing, {
    fast: { effort: "xhigh" },
  });
});

test("route-task clarification JSON preserves Jev fallback diagnostics", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-clarify-"));
  const result = runJson(routeTaskScript, {
    task: "ambiguous task",
    workspaceRoot: dir,
    globalConfigPath: join(dir, "missing-global.json"),
    modelCachePath: join(dir, "missing-cache.json"),
    routerPreference: { backend: "auto", prefer: "jev" },
    jevDecision: {
      tier: "balanced",
      confidence: 0.2,
      reason: "ambiguous Jev signal",
    },
    modelDecision: {
      tier: "strong",
      confidence: 0.3,
      reason: "still missing task requirements",
    },
  });

  assert.equal(result.status, 1);
  assert.equal(result.output.error, "clarification_required");
  assert.deepEqual(result.output.fallback, {
    from: "jev",
    reason: "low_confidence",
  });
});

test("abstract family explicit override resolves tier before catalog selection", () => {
  const catalogs = [
    [
      {
        id: "sol-strong",
        family: "sol",
        tiers: ["strong"],
        supportedEfforts: ["medium", "xhigh"],
        available: true,
      },
      {
        id: "sol-balanced",
        family: "sol",
        tiers: ["balanced"],
        supportedEfforts: ["medium"],
        available: true,
      },
    ],
    [
      {
        id: "sol-balanced",
        family: "sol",
        tiers: ["balanced"],
        supportedEfforts: ["medium"],
        available: true,
      },
      {
        id: "sol-strong",
        family: "sol",
        tiers: ["strong"],
        supportedEfforts: ["medium", "xhigh"],
        available: true,
      },
    ],
  ];

  for (const modelCatalog of catalogs) {
    const result = resolveExplicitOverride({
      override: { model: "sol", reasoningEffort: "medium" },
      modelCatalog,
    });

    assert.equal(result.tier, "balanced");
    assert.equal(result.model, "sol-balanced");
  }
});

test("configure partial Router object preserves unspecified same-scope fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-router-patch-"));
  const file = join(dir, "workspace.json");

  const initial = runJson(configureScript, {
    scope: "workspace",
    file,
    router: { backend: "auto", prefer: "jev" },
  });
  assert.equal(initial.status, 0, initial.stderr);

  const updated = runJson(configureScript, {
    scope: "workspace",
    file,
    router: { prefer: "model" },
  });
  assert.equal(updated.status, 0, updated.stderr);
  assert.deepEqual(updated.output.config.router, {
    backend: "auto",
    prefer: "model",
  });
});

test("configure accepts all execution modes and rejects unknown mode", () => {
  for (const executionMode of ["plan", "confirm", "auto"]) {
    const result = runJson(configureScript, {
      scope: "session",
      executionMode,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output.session.executionMode, executionMode);
  }

  const invalid = runJson(configureScript, {
    scope: "session",
    executionMode: "manual",
  });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.output.error, "invalid_schema");
  assert.equal(invalid.output.field, "executionMode");
});
