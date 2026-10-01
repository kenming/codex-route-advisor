import test from "node:test";
import assert from "node:assert/strict";

import {
  discoverCodexModels,
  normalizeCodexModelInventory,
  runCodexDebugModels,
} from "../scripts/codex-model-source.mjs";

test("Codex model source maps picker visibility to Advisor availability", () => {
  const inventory = normalizeCodexModelInventory({
    models: [
      { slug: "gpt-5.6-sol", visibility: "list" },
      { slug: "gpt-reserve", visibility: "hide" },
    ],
  });

  assert.deepEqual(inventory, [
    { id: "gpt-5.6-sol", available: true },
    { id: "gpt-reserve", available: false },
  ]);
});

test("Codex model source rejects malformed or duplicate slugs", () => {
  assert.throws(
    () => normalizeCodexModelInventory({ models: [{ visibility: "list" }] }),
    (error) => error.code === "invalid_provider_response",
  );
  assert.throws(
    () => normalizeCodexModelInventory({
      models: [
        { slug: "gpt-5.6-sol", visibility: "list" },
        { slug: "gpt-5.6-sol", visibility: "hide" },
      ],
    }),
    (error) => error.code === "invalid_provider_response",
  );
});

test("discoverCodexModels exposes inventory only", async () => {
  const result = await discoverCodexModels({
    payload: {
      models: [
        {
          slug: "gpt-6-astra",
          visibility: "list",
          supported_reasoning_levels: [{ effort: "medium" }],
        },
      ],
    },
  });

  assert.deepEqual(result, {
    inventory: [{ id: "gpt-6-astra", available: true }],
  });
});
test("runCodexDebugModels parses the CLI JSON response", async () => {
  const payload = { models: [{ slug: "gpt-5.6-luna", visibility: "list" }] };
  const result = await runCodexDebugModels({
    binary: "codex-test",
    exec: async (binary, args, options) => {
      if (process.platform === "win32") {
        assert.match(binary.toLowerCase(), /cmd\.exe$/);
        assert.deepEqual(args, ["/d", "/c", "codex-test", "debug", "models"]);
      } else {
        assert.equal(binary, "codex-test");
        assert.deepEqual(args, ["debug", "models"]);
      }
      assert.equal(options.encoding, "utf8");
      return { stdout: JSON.stringify(payload) };
    },
  });

  assert.deepEqual(result, payload);
});

test("runCodexDebugModels normalizes command failures", async () => {
  await assert.rejects(
    () => runCodexDebugModels({
      binary: "missing-codex",
      exec: async () => {
        throw new Error("not found");
      },
    }),
    (error) => (
      error.code === "provider_unavailable"
      && /Unable to read Codex model catalog/.test(error.message)
    ),
  );
});
