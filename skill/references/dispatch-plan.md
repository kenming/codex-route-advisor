# Dispatch Plan Contract

The Dispatch Plan is the primary v1 output of Codex Route Advisor.
It advises the current coordinator; it does not execute worker tasks.

## Plan metadata

Required fields:
- `version`: contract version, currently `1`;
- `taskSummary`: concise summary of the original request;
- `executionMode`: `plan`, `confirm`, or `auto`; controls coordinator behavior after planning;
- `assessmentMode`: `jev`, `agent`, or `mixed`;
- `executionOrder`: one topological ordering of all task IDs;
- `parallelGroups`: zero or more conservative groups of task IDs safe to run in parallel;
- `tasks`: normalized plan tasks.

## Plan task

Each plan task contains the complete normalized bounded-task fields:
- `id`, `goal`, `context`, `dependsOn`, `deliverable`, `acceptance`;
- `conditional`;
- `boundaryReason`.

It then adds routing advice:
- `assessment.source`: `jev` or `agent`;
- `assessment.confidence`: number from 0 through 1;
- optional normalized assessment signals;
- when Agent assessment is used after a Jev attempt, `assessment.fallback = { from: "jev", reason }`;
- `recommendation.tier`: `fast | balanced | strong | long`;
- `recommendation.effort`: `low | medium | high | xhigh | max`;
- optional `recommendation.model`;
- when upward escalation is blocked: `recommendation.model / effort` are the effective capped profile, while `preferredModel / preferredEffort` retain the uncapped recommendation and `constraint = model_escalation_disabled`;
- `tools`: required tool/capability labels;
- `rationale`: short routing rationale.

## Execution mode

`executionMode` is advisory control for the coordinator, not a runtime action performed by this script:

- `plan`: return/show the Dispatch Plan and stop before execution;
- `confirm`: return/show the Dispatch Plan, ask the user for approval, then execute only after approval;
- `auto`: return/show the Dispatch Plan and allow the coordinator to continue execution without an approval pause.

The Skill default is `confirm`. Configuration precedence is Session > Workspace > Global > Skill default.

## Conditional tasks

Use `conditional: false` for unconditional tasks.

For a task that runs only after another task's result:
```json
{
  "conditional": {
    "taskId": "T3",
    "outcome": "failure"
  }
}
```

The referenced task must also appear in `dependsOn`.

## Execution order

`executionOrder` must contain every task exactly once.
A dependency must appear before the task that depends on it.

## Parallel groups

A parallel group may contain only existing tasks with no direct or transitive dependency
between members.

The schema can represent a group, but the validator deliberately remains conservative:
it rejects dependency-related members and duplicate task membership inside a group.

For Agent-authored plans, parallel-safe tasks should be made explicit: if tasks share a dependency frontier, mutate distinct implementation surfaces, rely on a fixed interface/test contract, and have independent acceptance checks, include them in `parallelGroups`. Do not describe tasks as independent while leaving the group empty.

At execution time, a capable Coordinator should concurrently delegate members of a declared group after a final runtime safety check. If it chooses not to, it should record the concrete conflict or host limitation that invalidated the plan-time recommendation.

## Coordinator delegation fidelity

When a coordinator delegates a plan task to a sub-agent, the recommendation is an execution requirement for that delegated worker, not display-only metadata. If `constraint = model_escalation_disabled` is present, dispatch the effective `model / effort`; the `preferred*` fields are diagnostic context and must not be used to bypass the policy.

- Resolve an abstract family token such as `luna`, `sol`, or `astra` to a concrete model id accepted by the current host before spawning.
- Spawn with explicit `model=<concrete id>` and `reasoning_effort=<recommendation.effort>`.
- Use `fork_turns="none"` by default, or a finite positive turn count only when bounded parent context is required.
- Do not use `fork_turns="all"` for a task with model/effort allocation: a full-history fork inherits the parent model/effort and cannot faithfully apply an override on Codex hosts with that behavior.
- A non-full-history worker message must carry enough bounded-task context to execute independently.
- If the requested profile cannot be executed, record a delegation fallback and do not silently inherit the parent profile.
- Runtime `actualModel` / `actualEffort` remain evidence fields and must not be copied from the recommendation.

## Validation boundary

The deterministic validator checks contract and graph integrity only.
It does not decide whether decomposition was semantically good, whether a model choice is
optimal, or whether two tasks truly avoid shared mutable state. Those remain Advisor /
coordinator judgments.
