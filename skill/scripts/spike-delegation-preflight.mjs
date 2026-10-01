#!/usr/bin/env node

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const requests = [
  { taskId: "T1", agentPath: "/root/preflight_t1_fast", requestedModel: "gpt-6-luna", requestedEffort: "high" },
  { taskId: "T2", agentPath: "/root/preflight_t2_balanced", requestedModel: "gpt-6-sol", requestedEffort: "medium" },
  { taskId: "T3", agentPath: "/root/preflight_t3_strong", requestedModel: "gpt-6-sol", requestedEffort: "xhigh" },
];

function oneValue(values) {
  const distinct = [...new Set(values.filter(Boolean))];
  return distinct.length === 1 ? distinct[0] : null;
}

function selection(rows, actualKey, requestedKey) {
  if (rows.some((row) => !row[actualKey])) return "unverifiable";
  return rows.every((row) => row[actualKey] === row[requestedKey]) ? "verified" : "unsupported";
}

export async function inspectDelegation(parentThreadId, sessionsDirectory) {
  const found = new Map();
  for (const name of await readdir(sessionsDirectory)) {
    if (!name.endsWith(".jsonl")) continue;
    const file = path.join(sessionsDirectory, name);
    const lines = (await readFile(file, "utf8")).trim().split(/\r?\n/);
    const meta = JSON.parse(lines[0]).payload;
    if (meta?.parent_thread_id !== parentThreadId || !meta.source?.subagent) continue;
    const request = requests.find((item) => item.agentPath === meta.agent_path);
    if (!request) continue;
    if (found.has(request.taskId)) throw new Error(`Duplicate rollout for ${request.taskId}`);
    const records = lines.map((line) => JSON.parse(line));
    const contexts = records.filter((record) => record.type === "turn_context").map((record) => record.payload);
    found.set(request.taskId, {
      taskId: request.taskId,
      requestedModel: request.requestedModel,
      requestedEffort: request.requestedEffort,
      workerId: meta.id ?? null,
      runtimeVersion: meta.cli_version ?? null,
      actualModel: oneValue(contexts.map((context) => context.model)),
      actualEffort: oneValue(contexts.map((context) => context.effort)),
      delegationMechanism: "collaboration.spawn_agent",
      evidenceSource: {
        file,
        workerId: "session_meta.payload.id",
        runtimeVersion: "session_meta.payload.cli_version",
        actualModel: "turn_context.payload.model",
        actualEffort: "turn_context.payload.effort",
        status: "event_msg.payload.type",
      },
      status: records.some((record) => record.type === "event_msg" && record.payload?.type === "task_complete")
        ? "completed" : "unverifiable",
    });
  }
  const tasks = requests.map((request) => found.get(request.taskId) ?? {
    ...request,
    workerId: null,
    runtimeVersion: null,
    actualModel: null,
    actualEffort: null,
    delegationMechanism: "collaboration.spawn_agent",
    evidenceSource: null,
    status: "unverifiable",
  });
  const workerIds = tasks.map((task) => task.workerId);
  return {
    parentThreadId,
    evidenceScope: "Codex host rollout turn_context; provider response metadata was not inspected",
    capabilities: {
      delegation: tasks.every((task) => task.status === "completed") ? "verified" : "unverifiable",
      modelSelection: selection(tasks, "actualModel", "requestedModel"),
      effortSelection: selection(tasks, "actualEffort", "requestedEffort"),
      workerIdentity: workerIds.every(Boolean) && new Set(workerIds).size === tasks.length
        ? "verified" : workerIds.some(Boolean) ? "unverifiable" : "unavailable",
      runtimeEvidence: tasks.every((task) => task.actualModel && task.actualEffort)
        ? "verified" : tasks.some((task) => task.actualModel || task.actualEffort) ? "unverifiable" : "unavailable",
    },
    tasks,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [parentThreadId, sessionsDirectory] = process.argv.slice(2);
  if (!parentThreadId || !sessionsDirectory) {
    process.stderr.write("Usage: node spike-delegation-preflight.mjs <parent-thread-id> <sessions-directory>\n");
    process.exitCode = 2;
  } else {
    console.log(JSON.stringify(await inspectDelegation(parentThreadId, sessionsDirectory), null, 2));
  }
}
