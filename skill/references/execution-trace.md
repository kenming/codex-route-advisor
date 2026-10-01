# Execution Trace Contract

Codex Route Advisor uses a bounded execution trace for routing and delegation evidence.
It is not a general-purpose application log.

## Storage

Each Advisor CLI run creates:

```text
<workspace>/.codex/codex-route-advisor/runs/<run-id>/
├─ run.json
├─ dispatch-plan.json
└─ events.jsonl
```

The runs directory is runtime state and should be gitignored.

## Files

### run.json

Small run summary for fast inspection:

- `runId`
- `status`: initially `planned`, later coordinator-defined completion status
- `traceStatus`: `complete | truncated`
- `truncated`
- `truncateReason`
- `droppedEventCount`
- `tracePolicy`: the actual retention/truncation limits used for this run
- `startedAt`
- `completedAt`

### dispatch-plan.json

Immutable snapshot of the validated Advisor Dispatch Plan for this run.

### events.jsonl

Append-only lifecycle evidence. One JSON object per line.

Recommended events:

- `plan_created`
- `retention_cleanup`
- `preflight_checked`
- `task_dispatch_requested`
- `task_started`
- `task_completed`
- `task_failed`
- `task_skipped`
- `delegation_fallback`
- `delegation_failed`
- `log_truncated`
- `run_completed`
- `run_failed`

## Requested vs actual routing

Advisor recommendation is intent, not runtime evidence.

A dispatch request may record:

```json
{
  "event": "task_dispatch_requested",
  "taskId": "T1",
  "requestedModel": "luna",
  "requestedEffort": "high"
}
```

Only the coordinator/host may record actual runtime facts after they are known:

```json
{
  "event": "task_started",
  "taskId": "T1",
  "workerId": "worker-1",
  "actualModel": "luna",
  "actualEffort": "high"
}
```

Never copy requested model/effort into actual fields unless the runtime confirms them.

## Bounded logging policy

MVP defaults:

```text
maxRunBytes   = 5 MiB   (events.jsonl)
maxTotalBytes = 100 MiB (runs directory)
trimToBytes   = 80 MiB
retentionDays = 14
```

Cleanup runs before creating a new run:

1. delete runs older than `retentionDays`;
2. calculate remaining total bytes;
3. if total exceeds `maxTotalBytes`, delete oldest runs until total is at or below `trimToBytes`.

## Truncation

When adding a normal event would exceed `maxRunBytes`:

1. set `run.json.traceStatus = "truncated"`;
2. set `truncated = true` and `truncateReason = "max_run_bytes"`;
3. write one `log_truncated` marker;
4. drop subsequent non-critical events and increment `droppedEventCount`;
5. continue preserving critical lifecycle events.

Critical events are:

- `task_completed`
- `task_failed`
- `task_skipped`
- `delegation_failed`
- `run_completed`
- `run_failed`

A truncated trace must be surfaced to the user; it must not look complete.

## Coordinator CLI bridge

`scripts/trace.mjs` accepts JSON stdin.

Append an event:

```json
{
  "action": "append",
  "workspaceRoot": "<workspace>",
  "runId": "<run-id>",
  "event": {
    "event": "task_dispatch_requested",
    "taskId": "T1",
    "requestedModel": "luna",
    "requestedEffort": "high"
  }
}
```

Finalize:

```json
{
  "action": "finalize",
  "workspaceRoot": "<workspace>",
  "runId": "<run-id>",
  "status": "completed"
}
```

Cleanup can also be invoked explicitly with `action: "cleanup"`.
