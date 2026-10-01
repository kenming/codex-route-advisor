import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { inspectDelegation } from "../scripts/spike-delegation-preflight.mjs";

test("preflight reads host facts independently of requested routing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "advisor-preflight-"));
  try {
    const cases = [
      ["t1_fast", "gpt-6-sol", "high"],
      ["t2_balanced", "gpt-6-sol", null],
      ["t3_strong", "gpt-6-sol", "xhigh"],
    ];
    for (const [suffix, model, effort] of cases) {
      const agentPath = `/root/preflight_${suffix}`;
      await writeFile(path.join(directory, `${suffix}.jsonl`), [
        { type: "session_meta", payload: { id: suffix, parent_thread_id: "parent", agent_path: agentPath, source: { subagent: {} } } },
        { type: "turn_context", payload: { model, effort } },
        { type: "event_msg", payload: { type: "task_complete" } },
      ].map((record) => JSON.stringify(record)).join("\n"));
    }
    const result = await inspectDelegation("parent", directory);
    assert.equal(result.capabilities.delegation, "verified");
    assert.equal(result.capabilities.modelSelection, "unsupported");
    assert.equal(result.capabilities.effortSelection, "unverifiable");
    assert.equal(result.tasks[0].requestedModel, "gpt-6-luna");
    assert.equal(result.tasks[0].actualModel, "gpt-6-sol");
    assert.equal(result.tasks[1].actualEffort, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
