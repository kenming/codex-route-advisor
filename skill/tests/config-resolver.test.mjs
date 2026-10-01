import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergePreferenceLayers,
  readConfigFile,
  writeConfigAtomic,
} from "../scripts/config.mjs";
import { applyModelEscalationPolicy, resolveRoutingDecision } from "../scripts/resolver.mjs";

test("enabled defaults to true and follows Session > Workspace > Global precedence", () => {
  assert.equal(mergePreferenceLayers().enabled, true);
  assert.equal(mergePreferenceLayers().enabledSource, "skill_default");

  const globalOff = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, enabled: false },
  });
  assert.equal(globalOff.enabled, false);
  assert.equal(globalOff.enabledSource, "global");

  const workspaceOn = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, enabled: false },
    workspaceConfig: { schemaVersion: 1, enabled: true },
  });
  assert.equal(workspaceOn.enabled, true);
  assert.equal(workspaceOn.enabledSource, "workspace");

  const sessionOff = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, enabled: true },
    workspaceConfig: { schemaVersion: 1, enabled: true },
    sessionOverride: { enabled: false },
  });
  assert.equal(sessionOff.enabled, false);
  assert.equal(sessionOff.enabledSource, "session");
});

test("invalid enabled value is rejected", () => {
  assert.throws(
    () => mergePreferenceLayers({
      workspaceConfig: { schemaVersion: 1, enabled: "false" },
    }),
    (error) => error.code === "invalid_schema" && error.field === "enabled",
  );
});

test("executionMode defaults to confirm and follows Session > Workspace > Global precedence", () => {
  assert.equal(mergePreferenceLayers().executionMode, "confirm");
  assert.equal(mergePreferenceLayers().executionModeSource, "skill_default");

  const globalOnly = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, executionMode: "plan" },
  });
  assert.equal(globalOnly.executionMode, "plan");
  assert.equal(globalOnly.executionModeSource, "global");

  const workspaceWins = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, executionMode: "plan" },
    workspaceConfig: { schemaVersion: 1, executionMode: "auto" },
  });
  assert.equal(workspaceWins.executionMode, "auto");
  assert.equal(workspaceWins.executionModeSource, "workspace");

  const sessionWins = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, executionMode: "plan" },
    workspaceConfig: { schemaVersion: 1, executionMode: "auto" },
    sessionOverride: { executionMode: "confirm" },
  });
  assert.equal(sessionWins.executionMode, "confirm");
  assert.equal(sessionWins.executionModeSource, "session");
});

test("invalid executionMode is rejected", () => {
  assert.throws(
    () => mergePreferenceLayers({
      workspaceConfig: { schemaVersion: 1, executionMode: "manual" },
    }),
    (error) => error.code === "invalid_schema" && error.field === "executionMode",
  );
});

test("allowModelEscalation defaults to false and follows scope precedence", () => {
  const defaults = mergePreferenceLayers();
  assert.equal(defaults.allowModelEscalation, false);
  assert.equal(defaults.allowModelEscalationSource, "skill_default");

  const merged = mergePreferenceLayers({
    globalConfig: { schemaVersion: 1, allowModelEscalation: true },
    workspaceConfig: { schemaVersion: 1, allowModelEscalation: false },
    sessionOverride: { allowModelEscalation: true },
  });
  assert.equal(merged.allowModelEscalation, true);
  assert.equal(merged.allowModelEscalationSource, "session");
});

test("model escalation policy caps a stronger same-family profile at the coordinator profile", () => {
  const result = applyModelEscalationPolicy({
    recommendation: {
      tier: "strong",
      model: "sol",
      modelFamily: "sol",
      reasoningEffort: "xhigh",
    },
    coordinatorProfile: { model: "sol", effort: "medium" },
    allowModelEscalation: false,
  });

  assert.equal(result.model, "sol");
  assert.equal(result.reasoningEffort, "medium");
  assert.equal(result.preferredModel, "sol");
  assert.equal(result.preferredReasoningEffort, "xhigh");
  assert.equal(result.escalationConstraint, "model_escalation_disabled");
});

test("lower-family Luna Max remains allowed under a Sol Medium coordinator", () => {
  const result = applyModelEscalationPolicy({
    recommendation: {
      tier: "fast",
      model: "luna",
      modelFamily: "luna",
      reasoningEffort: "max",
    },
    coordinatorProfile: { model: "sol", effort: "medium" },
    allowModelEscalation: false,
  });

  assert.equal(result.model, "luna");
  assert.equal(result.reasoningEffort, "max");
  assert.equal(result.escalationConstrained, false);
});

test("preference merge is field-level with Session > Workspace > Global > default", () => {
  const merged = mergePreferenceLayers({
    globalConfig: {
      schemaVersion: 1,
      routing: {
        strong: { model: "astra" },
        fast: { effort: "xhigh" },
      },
    },
    workspaceConfig: {
      schemaVersion: 1,
      routing: {
        strong: { effort: "high" },
      },
    },
    sessionOverride: {
      routing: {
        strong: { effort: "xhigh" },
      },
    },
  });

  assert.deepEqual(merged.routing.strong, {
    model: "astra",
    effort: "xhigh",
  });
  assert.equal(merged.sources.strong.model, "global");
  assert.equal(merged.sources.strong.effort, "session");
  assert.equal(merged.routing.fast.model, "luna");
  assert.equal(merged.routing.fast.effort, "xhigh");
});

test("invalid override does not silently fall back", () => {
  assert.throws(
    () => mergePreferenceLayers({
      workspaceConfig: {
        schemaVersion: 1,
        routing: {
          strong: { effort: "ultra" },
        },
      },
    }),
    (error) => (
      error.code === "unsupported_effort"
      && error.source === "workspace"
      && error.tier === "strong"
    ),
  );
});

test("missing config is valid and malformed config is not", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-config-"));
  const missing = await readConfigFile(join(dir, "missing.json"), "workspace");
  assert.equal(missing, null);

  const invalidPath = join(dir, "invalid.json");
  await writeFile(invalidPath, "{not-json", "utf8");
  await assert.rejects(
    () => readConfigFile(invalidPath, "workspace"),
    (error) => error.code === "invalid_schema" && error.source === "workspace",
  );
});

test("atomic config write preserves valid schema", async () => {
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-write-"));
  const file = join(dir, "config.json");
  const config = {
    schemaVersion: 1,
    experimentalFoo: { enabled: true },
    routing: {
      strong: { effort: "high" },
    },
  };

  await writeConfigAtomic(file, config);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.experimentalFoo, { enabled: true });
  assert.equal(saved.routing.strong.effort, "high");
});

test("minimal resolver applies defaults and Luna High floor", () => {
  const merged = mergePreferenceLayers();
  const result = resolveRoutingDecision({
    decision: {
      tier: "fast",
      backend: "model",
    },
    preferences: merged.routing,
    sources: merged.sources,
  });

  assert.equal(result.modelFamily, "luna");
  assert.equal(result.model, "luna");
  assert.equal(result.reasoningEffort, "high");
  assert.equal(result.preferenceSource.reasoningEffort, "skill_default");
});

test("Luna below High is a semantic configuration error", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        fast: { effort: "medium" },
      },
    },
  });

  assert.throws(
    () => resolveRoutingDecision({
      decision: {
        tier: "fast",
        backend: "model",
      },
      preferences: merged.routing,
      sources: merged.sources,
    }),
    (error) => error.code === "invalid_model_effort_combination",
  );
});

test("explicit concrete model can be validated by supplied runtime catalog", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        strong: { model: "sol-current", effort: "xhigh" },
      },
    },
  });

  const result = resolveRoutingDecision({
    decision: {
      tier: "strong",
      backend: "model",
    },
    preferences: merged.routing,
    sources: merged.sources,
    modelCatalog: [{
      id: "sol-current",
      family: "sol",
      tiers: ["strong"],
      supportedEfforts: ["high", "xhigh"],
      available: true,
    }],
  });

  assert.equal(result.model, "sol-current");
  assert.equal(result.modelFamily, "sol");
  assert.equal(result.availability, "validated");
});

test("unavailable concrete model uses same-tier replacement without changing route", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        strong: { model: "sol-old", effort: "xhigh" },
      },
    },
  });

  const result = resolveRoutingDecision({
    decision: {
      tier: "strong",
      backend: "model",
    },
    preferences: merged.routing,
    sources: merged.sources,
    modelCatalog: [
      {
        id: "sol-old",
        family: "sol",
        tiers: ["strong"],
        supportedEfforts: ["xhigh"],
        available: false,
      },
      {
        id: "sol-new",
        family: "sol",
        tiers: ["strong"],
        supportedEfforts: ["xhigh"],
        available: true,
      },
    ],
  });

  assert.equal(result.tier, "strong");
  assert.equal(result.tier, "strong");
  assert.equal(result.model, "sol-new");
  assert.deepEqual(result.modelFallback, {
    reason: "model_unavailable",
    from: "sol-old",
    to: "sol-new",
  });
});


test("global config update can replace existing file and preserve unknown fields", async () => {
  const { updateGlobalConfig } = await import("../scripts/config.mjs");
  const dir = await mkdtemp(join(tmpdir(), "codex-route-advisor-global-"));
  const file = join(dir, "config.json");

  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, experimentalFoo: { enabled: true } }),
    "utf8",
  );

  await updateGlobalConfig((config) => {
    config.router = { backend: "auto", prefer: "jev" };
  }, { file });

  await updateGlobalConfig((config) => {
    config.router = { backend: "model" };
  }, { file });

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.experimentalFoo, { enabled: true });
  assert.deepEqual(saved.router, { backend: "model" });
});


test("explicit concrete model can remain unchecked when no runtime catalog is supplied", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        strong: { model: "vendor-custom-model", effort: "xhigh" },
      },
    },
  });

  const result = resolveRoutingDecision({
    decision: { tier: "strong", backend: "model" },
    preferences: merged.routing,
    sources: merged.sources,
  });

  assert.equal(result.model, "vendor-custom-model");
  assert.equal(result.modelFamily, null);
  assert.equal(result.availability, "unchecked");
});

test("concrete family-like model is not classified from its name without catalog", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        fast: { model: "gpt-next-luna", effort: "medium" },
      },
    },
  });

  const result = resolveRoutingDecision({
    decision: { tier: "fast", backend: "model" },
    preferences: merged.routing,
    sources: merged.sources,
  });

  assert.equal(result.model, "gpt-next-luna");
  assert.equal(result.modelFamily, null);
  assert.equal(result.reasoningEffort, "medium");
  assert.equal(result.availability, "unchecked");
});


test("runtime catalog entry without supportedEfforts is rejected as invalid schema", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        strong: { model: "sol-current", effort: "xhigh" },
      },
    },
  });

  assert.throws(
    () => resolveRoutingDecision({
      decision: { tier: "strong", backend: "model" },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [{
        id: "sol-current",
        family: "sol",
        tiers: ["strong"],
        available: true,
      }],
    }),
    (error) => (
      error.code === "invalid_schema"
      && error.field === "modelCatalog.supportedEfforts"
      && error.model === "sol-current"
    ),
  );
});

test("runtime catalog entry requires explicit valid tiers and availability", () => {
  const merged = mergePreferenceLayers();

  assert.throws(
    () => resolveRoutingDecision({
      decision: { tier: "fast", backend: "model" },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [{
        id: "luna-current",
        family: "luna",
        tiers: [],
        supportedEfforts: ["high"],
        available: true,
      }],
    }),
    (error) => error.code === "invalid_schema" && error.field === "modelCatalog.tiers",
  );

  assert.throws(
    () => resolveRoutingDecision({
      decision: { tier: "fast", backend: "model" },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [{
        id: "luna-current",
        family: "luna",
        tiers: ["fast"],
        supportedEfforts: ["high"],
      }],
    }),
    (error) => error.code === "invalid_schema" && error.field === "modelCatalog.available",
  );
});

test("runtime catalog rejects unsupported tier and effort vocabulary", () => {
  const merged = mergePreferenceLayers();

  assert.throws(
    () => resolveRoutingDecision({
      decision: { tier: "fast", backend: "model" },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [{
        id: "luna-current",
        family: "luna",
        tiers: ["turbo"],
        supportedEfforts: ["high"],
        available: true,
      }],
    }),
    (error) => error.code === "invalid_schema" && error.field === "modelCatalog.tiers",
  );

  assert.throws(
    () => resolveRoutingDecision({
      decision: { tier: "fast", backend: "model" },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [{
        id: "luna-current",
        family: "luna",
        tiers: ["fast"],
        supportedEfforts: ["ultra"],
        available: true,
      }],
    }),
    (error) => (
      error.code === "invalid_schema"
      && error.field === "modelCatalog.supportedEfforts"
    ),
  );
});


test("runtime catalog family must be a canonical lowercase token", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        fast: { model: "luna-current", effort: "medium" },
      },
    },
  });

  for (const family of ["luna ", " luna", "Luna"]) {
    assert.throws(
      () => resolveRoutingDecision({
        decision: { tier: "fast", backend: "model" },
        preferences: merged.routing,
        sources: merged.sources,
        modelCatalog: [{
          id: "luna-current",
          family,
          tiers: ["fast"],
          supportedEfforts: ["medium"],
          available: true,
        }],
      }),
      (error) => (
        error.code === "invalid_schema"
        && error.field === "modelCatalog.family"
        && error.model === "luna-current"
      ),
    );
  }
});

test("canonical Luna catalog family cannot bypass the High effort floor", () => {
  const merged = mergePreferenceLayers({
    sessionOverride: {
      routing: {
        fast: { model: "luna-current", effort: "medium" },
      },
    },
  });

  assert.throws(
    () => resolveRoutingDecision({
      decision: { tier: "fast", backend: "model" },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [{
        id: "luna-current",
        family: "luna",
        tiers: ["fast"],
        supportedEfforts: ["medium"],
        available: true,
      }],
    }),
    (error) => error.code === "invalid_model_effort_combination",
  );
});

test("authoritative empty runtime catalog does not degrade to unchecked availability", () => {
  const merged = mergePreferenceLayers();

  assert.throws(
    () => resolveRoutingDecision({
      decision: {
        tier: "fast",
        backend: "model",
      },
      preferences: merged.routing,
      sources: merged.sources,
      modelCatalog: [],
    }),
    (error) => error.code === "model_unavailable",
  );
});
