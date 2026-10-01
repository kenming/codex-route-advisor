import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendEvent,
  cleanupRuns,
  createTraceRun,
  finalizeTraceRun,
  openTraceRun,
  traceRoot,
} from "../scripts/trace.mjs";

function plan() {
  return {
    version: 1,
    taskSummary: "Trace test",
    executionMode: "auto",
    assessmentMode: "agent",
    executionOrder: ["T1"],
    parallelGroups: [],
    tasks: [{
      id: "T1",
      goal: "Read one file",
      context: {},
      dependsOn: [],
      deliverable: "Summary",
      acceptance: ["Summary produced"],
      conditional: false,
      boundaryReason: "Independent routing boundary",
      assessment: { source: "agent", confidence: 0.9 },
      recommendation: { tier: "fast", effort: "high", model: "luna" },
      tools: ["read"],
      rationale: "Low-risk read-only task",
    }],
  };
}

test("trace run stores plan, lifecycle events, and final state", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "advisor-trace-"));
  const now = new Date("2026-09-28T10:00:00.000Z");
  const run = await createTraceRun({
    workspaceRoot,
    plan: plan(),
    now,
    runId: "run-basic",
  });

  await appendEvent(run, {
    event: "task_dispatch_requested",
    taskId: "T1",
    requestedModel: "luna",
    requestedEffort: "high",
  }, new Date("2026-09-28T10:00:01.000Z"));

  await appendEvent(run, {
    event: "task_started",
    taskId: "T1",
    workerId: "worker-1",
    actualModel: "luna",
    actualEffort: "high",
  }, new Date("2026-09-28T10:00:02.000Z"));

  await finalizeTraceRun(run, {
    now: new Date("2026-09-28T10:00:03.000Z"),
  });

  const state = JSON.parse(await readFile(run.runFile, "utf8"));
  const savedPlan = JSON.parse(await readFile(run.planFile, "utf8"));
  const events = (await readFile(run.eventsFile, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  assert.equal(state.status, "completed");
  assert.equal(state.traceStatus, "complete");
  assert.equal(state.truncated, false);
  assert.equal(state.tracePolicy.maxRunBytes, 5 * 1024 * 1024);
  assert.equal(savedPlan.tasks[0].recommendation.model, "luna");
  assert.deepEqual(
    events.map((item) => item.event),
    ["plan_created", "task_dispatch_requested", "task_started", "run_completed"],
  );
  assert.equal(events[2].actualModel, "luna");
});

test("trace becomes truncated, drops verbose events, and preserves critical lifecycle events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "advisor-truncate-"));
  const policy = {
    enabled: true,
    maxRunBytes: 420,
    maxTotalBytes: 1024 * 1024,
    trimToBytes: 800 * 1024,
    retentionDays: 14,
  };
  const run = await createTraceRun({
    workspaceRoot,
    plan: plan(),
    policy,
    runId: "run-truncated",
    now: new Date("2026-09-28T11:00:00.000Z"),
  });

  await appendEvent(run, {
    event: "worker_debug",
    taskId: "T1",
    detail: "x".repeat(500),
  }, new Date("2026-09-28T11:00:01.000Z"));

  const dropped = await appendEvent(run, {
    event: "worker_debug",
    taskId: "T1",
    detail: "later verbose event",
  }, new Date("2026-09-28T11:00:02.000Z"));

  const critical = await appendEvent(run, {
    event: "task_completed",
    taskId: "T1",
    status: "success",
  }, new Date("2026-09-28T11:00:03.000Z"));

  const state = JSON.parse(await readFile(run.runFile, "utf8"));
  const eventText = await readFile(run.eventsFile, "utf8");

  assert.equal(state.traceStatus, "truncated");
  assert.equal(state.truncated, true);
  assert.equal(state.truncateReason, "max_run_bytes");
  assert.ok(state.droppedEventCount >= 2);
  assert.equal(dropped.written, false);
  assert.equal(critical.written, true);
  assert.match(eventText, /"event":"log_truncated"/);
  assert.match(eventText, /"event":"task_completed"/);
});

test("retention cleanup removes expired runs", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "advisor-retention-"));
  const root = traceRoot(workspaceRoot);
  const oldDir = join(root, "old-run");
  const recentDir = join(root, "recent-run");
  await mkdir(oldDir, { recursive: true });
  await mkdir(recentDir, { recursive: true });

  await writeFile(join(oldDir, "run.json"), JSON.stringify({
    runId: "old-run",
    startedAt: "2026-09-01T00:00:00.000Z",
  }), "utf8");
  await writeFile(join(oldDir, "events.jsonl"), "old\n", "utf8");
  await writeFile(join(recentDir, "run.json"), JSON.stringify({
    runId: "recent-run",
    startedAt: "2026-09-27T00:00:00.000Z",
  }), "utf8");

  const result = await cleanupRuns(root, {
    enabled: true,
    maxRunBytes: 1024,
    maxTotalBytes: 1024 * 1024,
    trimToBytes: 800 * 1024,
    retentionDays: 14,
  }, new Date("2026-09-28T12:00:00.000Z"));

  assert.deepEqual(result.deletedRuns.map((item) => item.runId), ["old-run"]);
  assert.ok(result.freedBytes > 0);
  await assert.rejects(() => readFile(join(oldDir, "run.json"), "utf8"), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(join(recentDir, "run.json"), "utf8")).runId, "recent-run");
});

test("trace run can be reopened for coordinator append/finalize", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "advisor-reopen-"));
  await createTraceRun({
    workspaceRoot,
    plan: plan(),
    runId: "run-reopen",
    now: new Date("2026-09-28T13:00:00.000Z"),
    policy: {
      enabled: true,
      maxRunBytes: 2048,
      maxTotalBytes: 1024 * 1024,
      trimToBytes: 800 * 1024,
      retentionDays: 7,
    },
  });

  const reopened = await openTraceRun({ workspaceRoot, runId: "run-reopen" });
  assert.equal(reopened.policy.maxRunBytes, 2048);
  assert.equal(reopened.policy.retentionDays, 7);
  await appendEvent(reopened, {
    event: "delegation_failed",
    taskId: "T1",
    reason: "worker_capability_unavailable",
  });
  const final = await finalizeTraceRun(reopened, { status: "failed" });

  assert.equal(final.status, "failed");
  assert.match(await readFile(reopened.eventsFile, "utf8"), /delegation_failed/);
  assert.match(await readFile(reopened.eventsFile, "utf8"), /run_failed/);
});

test("total-size cleanup trims oldest runs down to trimToBytes", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "advisor-total-trim-"));
  const root = traceRoot(workspaceRoot);

  for (const [name, startedAt] of [
    ["run-1", "2026-09-28T08:00:00.000Z"],
    ["run-2", "2026-09-28T09:00:00.000Z"],
    ["run-3", "2026-09-28T10:00:00.000Z"],
  ]) {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "run.json"), JSON.stringify({ runId: name, startedAt }), "utf8");
    await writeFile(join(dir, "events.jsonl"), "x".repeat(220), "utf8");
  }

  const result = await cleanupRuns(root, {
    enabled: true,
    maxRunBytes: 1024,
    maxTotalBytes: 500,
    trimToBytes: 300,
    retentionDays: 14,
  }, new Date("2026-09-28T12:00:00.000Z"));

  assert.ok(result.deletedRuns.some((item) => item.runId === "run-1"));
  assert.ok(result.remainingBytes <= 300);
});
