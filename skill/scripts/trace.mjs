#!/usr/bin/env node

import { appendFile, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const DEFAULT_TRACE_POLICY = Object.freeze({
  enabled: true,
  maxRunBytes: 5 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
  trimToBytes: 80 * 1024 * 1024,
  retentionDays: 14,
});

const CRITICAL_EVENTS = new Set([
  "log_truncated",
  "task_completed",
  "task_failed",
  "task_skipped",
  "delegation_failed",
  "run_completed",
  "run_failed",
]);

function iso(now) {
  return (now instanceof Date ? now : new Date(now)).toISOString();
}

function compactStamp(now) {
  return iso(now).replace(/[-:]/g, "").replace(".000Z", "Z");
}

export function traceRoot(workspaceRoot) {
  return join(workspaceRoot, ".codex", "codex-route-advisor", "runs");
}

export function makeRunId(now = new Date(), suffix = randomUUID().slice(0, 8)) {
  return `${compactStamp(now)}-${suffix}`;
}

async function pathSize(path) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  if (info.isFile()) return info.size;
  if (!info.isDirectory()) return 0;
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    total += await pathSize(join(path, entry.name));
  }
  return total;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeRunState(run) {
  await writeFile(run.runFile, `${JSON.stringify(run.state, null, 2)}\n`, "utf8");
}

async function listRuns(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const runs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const runFile = join(dir, "run.json");
    try {
      const state = await readJson(runFile);
      runs.push({
        runId: state.runId ?? entry.name,
        dir,
        startedAt: state.startedAt ?? null,
        size: await pathSize(dir),
      });
    } catch {
      const info = await stat(dir);
      runs.push({
        runId: entry.name,
        dir,
        startedAt: info.birthtime.toISOString(),
        size: await pathSize(dir),
      });
    }
  }
  return runs.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

export async function cleanupRuns(root, policy = DEFAULT_TRACE_POLICY, now = new Date()) {
  await mkdir(root, { recursive: true });
  const deleted = [];
  const cutoff = now.getTime() - policy.retentionDays * 24 * 60 * 60 * 1000;
  let runs = await listRuns(root);

  for (const run of runs) {
    const time = run.startedAt ? Date.parse(run.startedAt) : NaN;
    if (Number.isFinite(time) && time < cutoff) {
      await rm(run.dir, { recursive: true, force: true });
      deleted.push({ runId: run.runId, bytes: run.size, reason: "retention_days" });
    }
  }

  runs = await listRuns(root);
  let totalBytes = runs.reduce((sum, item) => sum + item.size, 0);
  if (totalBytes > policy.maxTotalBytes) {
    for (const run of runs) {
      if (totalBytes <= policy.trimToBytes) break;
      await rm(run.dir, { recursive: true, force: true });
      totalBytes -= run.size;
      deleted.push({ runId: run.runId, bytes: run.size, reason: "max_total_bytes" });
    }
  }

  return {
    deletedRuns: deleted,
    freedBytes: deleted.reduce((sum, item) => sum + item.bytes, 0),
    remainingBytes: totalBytes,
  };
}

export async function createTraceRun({
  workspaceRoot,
  plan,
  policy = DEFAULT_TRACE_POLICY,
  now = new Date(),
  runId = makeRunId(now),
} = {}) {
  if (!policy.enabled) return null;
  if (!workspaceRoot) throw new Error("workspaceRoot is required for trace logging");
  if (!plan || typeof plan !== "object") throw new Error("plan is required for trace logging");

  const root = traceRoot(workspaceRoot);
  const cleanup = await cleanupRuns(root, policy, now);
  const dir = join(root, runId);
  await mkdir(dir, { recursive: false });

  const state = {
    runId,
    status: "planned",
    traceStatus: "complete",
    truncated: false,
    truncateReason: null,
    droppedEventCount: 0,
    tracePolicy: { ...policy },
    startedAt: iso(now),
    completedAt: null,
  };

  const run = {
    root,
    dir,
    runId,
    policy,
    state,
    runFile: join(dir, "run.json"),
    planFile: join(dir, "dispatch-plan.json"),
    eventsFile: join(dir, "events.jsonl"),
  };

  await writeRunState(run);
  await writeFile(run.planFile, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  await appendEvent(run, {
    event: "plan_created",
    executionMode: plan.executionMode,
    taskCount: Array.isArray(plan.tasks) ? plan.tasks.length : undefined,
  }, now);

  if (cleanup.deletedRuns.length > 0) {
    await appendEvent(run, {
      event: "retention_cleanup",
      deletedRuns: cleanup.deletedRuns.length,
      freedBytes: cleanup.freedBytes,
      reasons: [...new Set(cleanup.deletedRuns.map((item) => item.reason))],
    }, now);
  }

  return run;
}

export async function openTraceRun({
  workspaceRoot,
  runId,
  policy = null,
} = {}) {
  if (!workspaceRoot || !runId) throw new Error("workspaceRoot and runId are required");
  const root = traceRoot(workspaceRoot);
  const dir = join(root, runId);
  const runFile = join(dir, "run.json");
  const state = await readJson(runFile);
  return {
    root,
    dir,
    runId,
    policy: policy ?? state.tracePolicy ?? DEFAULT_TRACE_POLICY,
    state,
    runFile,
    planFile: join(dir, "dispatch-plan.json"),
    eventsFile: join(dir, "events.jsonl"),
  };
}

export async function appendEvent(run, event, now = new Date()) {
  if (!run) return { written: false, disabled: true };
  if (!event || typeof event.event !== "string" || !event.event.trim()) {
    throw new Error("trace event requires a non-empty event name");
  }

  const payload = {
    timestamp: iso(now),
    runId: run.runId,
    ...event,
  };
  const line = `${JSON.stringify(payload)}\n`;
  const currentBytes = await pathSize(run.eventsFile);
  const wouldExceed = currentBytes + Buffer.byteLength(line, "utf8") > run.policy.maxRunBytes;

  if (run.state.truncated && !CRITICAL_EVENTS.has(event.event)) {
    run.state.droppedEventCount += 1;
    await writeRunState(run);
    return { written: false, truncated: true };
  }

  if (wouldExceed && !run.state.truncated) {
    run.state.truncated = true;
    run.state.traceStatus = "truncated";
    run.state.truncateReason = "max_run_bytes";
    run.state.droppedEventCount += CRITICAL_EVENTS.has(event.event) ? 0 : 1;
    const marker = {
      timestamp: iso(now),
      runId: run.runId,
      event: "log_truncated",
      reason: "max_run_bytes",
      limitBytes: run.policy.maxRunBytes,
    };
    await appendFile(run.eventsFile, `${JSON.stringify(marker)}\n`, "utf8");
    await writeRunState(run);
    if (!CRITICAL_EVENTS.has(event.event)) return { written: false, truncated: true };
  }

  await appendFile(run.eventsFile, line, "utf8");
  return { written: true, truncated: run.state.truncated };
}

export async function finalizeTraceRun(run, {
  status = "completed",
  event = status === "completed" ? "run_completed" : "run_failed",
  details = {},
  now = new Date(),
} = {}) {
  if (!run) return null;
  await appendEvent(run, { event, status, ...details }, now);
  run.state.status = status;
  run.state.completedAt = iso(now);
  await writeRunState(run);
  return structuredClone(run.state);
}

async function readStdinJson() {
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  if (!text.trim()) throw new Error("Expected JSON request on stdin");
  return JSON.parse(text);
}

async function cli() {
  const input = await readStdinJson();
  const policyOverride = input.policy === undefined
    ? null
    : { ...DEFAULT_TRACE_POLICY, ...input.policy };

  if (input.action === "cleanup") {
    const root = traceRoot(input.workspaceRoot ?? process.cwd());
    const result = await cleanupRuns(root, policyOverride ?? DEFAULT_TRACE_POLICY);
    process.stdout.write(`${JSON.stringify({ state: "cleaned", ...result })}\n`);
    return;
  }

  const run = await openTraceRun({
    workspaceRoot: input.workspaceRoot ?? process.cwd(),
    runId: input.runId,
    policy: policyOverride,
  });

  if (input.action === "append") {
    const result = await appendEvent(run, input.event);
    process.stdout.write(`${JSON.stringify({
      state: "appended",
      runId: run.runId,
      traceStatus: run.state.traceStatus,
      droppedEventCount: run.state.droppedEventCount,
      ...result,
    })}\n`);
    return;
  }

  if (input.action === "finalize") {
    const state = await finalizeTraceRun(run, {
      status: input.status ?? "completed",
      details: input.details ?? {},
    });
    process.stdout.write(`${JSON.stringify({ state: "finalized", run: state })}\n`);
    return;
  }

  throw new Error("action must be append, finalize, or cleanup");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await cli().catch((error) => {
    process.stdout.write(`${JSON.stringify({ state: "error", message: error.message })}\n`);
    process.exitCode = 1;
  });
}
