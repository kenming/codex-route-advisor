# Codex Route Advisor

[English](README.md) | [繁體中文](README.zh-TW.md)

`codex-route-advisor` is a planning and model-allocation Advisor for Codex development work.

It does not intercept runtime requests or switch models by itself. Instead, it decomposes a development request into routing-oriented **Bounded Tasks**, evaluates each task independently, recommends a model / reasoning effort / tool profile, and emits a dependency-aware **Dispatch Plan** for the active **Coordinator**.

```text
User task
→ Bounded Task decomposition
→ per-task routing assessment
→ model / reasoning effort / tool recommendation
→ Dispatch Plan
→ Coordinator executes / delegates
```

## Quick start

### 1. Prerequisites

- a Codex-compatible Agent / Coordinator that can load workspace Skills;
- Node.js available to run the bundled `.mjs` scripts;
- Jev is optional;
- to enable Jev detection, expose `TYPESAFE_API_KEY` in the environment.

This repository does not currently declare a minimum Node.js version. If Jev is unavailable, Codex Route Advisor remains fully usable through Agent fallback.

### 2. Install

Copy the contents of this repository's `skill/` directory into the target workspace:

```text
<workspace>/.agents/skills/codex-route-advisor/
├─ SKILL.md
├─ scripts/
├─ references/
└─ examples/
```

At minimum, the installed Skill root must contain `SKILL.md`, `scripts/`, and `references/`.

### 3. First-time setup

Start with the default safe mode:

```json
{
  "enabled": true,
  "executionMode": "confirm",
  "allowModelEscalation": false,
  "router": {
    "backend": "auto",
    "prefer": "jev"
  }
}
```

The effective preference precedence is:

```text
Session > Workspace > Global > Skill default
```

On first use, the Skill should inspect existing configuration, detect whether Jev credentials are present, obtain runtime model facts when available, and then apply Session / Workspace / Global preferences. Initialization must not make a Jev live API call automatically.

The preferred first-run invocation is:

```text
$codex-route-advisor init
```

It also asks whether the Advisor may exceed the model currently selected in the Host picker; the recommended default is **No** (`allowModelEscalation=false`).

To inspect the current configuration manually:

```powershell
'{"action":"inspect","workspaceRoot":"<workspace>"}' |
  node .agents\skills\codex-route-advisor\scripts\configure.mjs
```

If you do not want Jev, set `router.backend` to `model`. To disable the entire Advisor, set `enabled` to `false`.

### 4. Verify the installation

Check Jev capability without making a live API call:

```powershell
node .agents\skills\codex-route-advisor\scripts\detect-jev.mjs
```

Expected states include:

```text
configured_unverified
unavailable
```

Only when you explicitly want a live Jev capability check:

```powershell
node .agents\skills\codex-route-advisor\scripts\verify-jev.mjs
```

Run the included Advisor smoke test:

```powershell
Get-Content .agents\skills\codex-route-advisor\examples\advisor-mvp.request.json -Raw |
  node .agents\skills\codex-route-advisor\scripts\advise-task.mjs
```

A successful enabled run returns `state = advised`, a validated Dispatch Plan, and `trace.runId`.

### 5. Use it normally

Normal users do not author the bridge JSON shown later in this README. Invoke the Skill with a natural-language development request, for example:

```text
Implement the login API and its focused tests. Use suitable models for each bounded task,
show me the Dispatch Plan first, and diagnose failures only if validation fails.
```

With the default `executionMode = confirm`, the expected flow is:

```text
request
→ Advisor forms Bounded Tasks
→ Jev or Agent assesses each task
→ Advisor recommends model / effort / tools
→ Dispatch Plan is shown
→ user confirms
→ Coordinator executes / delegates
```

Explicit Skill commands:

```text
$codex-route-advisor init
$codex-route-advisor config
$codex-route-advisor status
$codex-route-advisor reset workspace
$codex-route-advisor verify
$codex-route-advisor plan <task>
```

These are Skill invocation commands handled by the Coordinator, not a second shell CLI. See `references/commands.md` for exact semantics and safety rules.

Common controls:

```text
Temporarily disable Advisor       → enabled = false
Use Advisor without Jev           → router.backend = model
Prefer Jev with Agent fallback    → router.backend = auto, router.prefer = jev
Plan only                         → executionMode = plan
Execute after confirmation        → executionMode = confirm
Allow Coordinator to continue     → executionMode = auto
Prevent upward model escalation   → allowModelEscalation = false (default)
Allow upward model escalation     → allowModelEscalation = true
```

See `references/configuration.md` for the complete configuration contract and `references/operations.md` for lifecycle operations.

## Product boundary

The Skill is an **Advisor**, not a runtime Router.

It does:

- create Bounded Tasks only where capability, reasoning depth, primary tools, dependency order, validation, or risk justify an independent routing decision;
- recommend different routing profiles for different Bounded Tasks;
- preserve sequential, parallel, and conditional execution relationships;
- use Jev as an optional per-task assessment backend, with Agent fallback;
- produce a validated Dispatch Plan and bounded execution trace.

It does **not** own provider routing, Model Picker control, proxy / gateway transport, host interception, or automatic runtime model switching.

Worker spawning, tool calls, retries, integration, runtime safety checks, and final validation remain the Coordinator's responsibility.

## Dynamic model discovery

Codex Route Advisor can inspect the model inventory currently exposed by the Codex host through `codex debug models`, so newly available models do not require a Skill code change merely to become visible.

Availability and routing capability are deliberately separate:

- newly discovered models are added to the runtime inventory immediately;
- an exact-id capability registry defines family, routing tiers, and supported reasoning efforts;
- a discovered model without capability metadata remains visible as `unclassified` and `routable = false`;
- after capability metadata is added, a cached inventory entry can become routable without requiring another discovery request.

The Advisor therefore adapts to host model availability without inferring capabilities from model names or claiming that every newly discovered model is safe to route automatically.

## Executable Advisor pipeline

Primary executable entry point:

```text
scripts/advise-task.mjs
```

Normal users invoke the Skill with natural language. The JSON containing `boundedTasks`, `assessments`, and related fields is an Agent-to-script bridge contract, not a user-authored form.

```text
normalized request
→ Bounded Task graph validation
→ Jev / Agent fallback routing
→ model / effort resolution
→ Dispatch Plan
→ deterministic validation
```

If no semantic decomposition is supplied, the request is conservatively kept as one task. Semantic decomposition is performed by the Agent using `references/bounded-task-decomposition.md`; the script does not use keyword heuristics to pretend it understands task semantics.

## Bounded Task rules

A Bounded Task is the smallest unit that deserves an independent routing decision.

Split only when a child materially differs in at least one of these dimensions:

- required capability;
- reasoning depth;
- primary tool set;
- dependency ordering;
- validation method;
- risk / blast radius.

Stop decomposition when the likely child steps share the same routing profile, tools, local context, validation cycle, and dependency gate.

A common case is:

```text
implement X
→ run focused test for X
→ diagnose only if that focused test fails
```

Prefer:

```text
T1 implement X + run its focused test
T2 diagnose failure — depends on T1, only if T1 fails
```

Do **not** split implementation from its focused verification merely to manufacture a conditional gate. The new routing boundary is the failure diagnosis, not the focused test inside the same implementation cycle.

## Parallel planning

After decomposition, the Agent performs one explicit parallel-safety pass.

Tasks on the same dependency frontier should be placed in `parallelGroups` when all of the following hold:

- no dependency relationship exists between them;
- they mutate different implementation surfaces;
- their shared interface or test contract is already fixed;
- each task has independent acceptance criteria.

Do not describe tasks as independent while leaving a safe parallel group implicit.

At execution time, the Coordinator performs a final mutable-state safety check. If the host supports sub-agent delegation and no new conflict is found, declared group members should be delegated concurrently. If the Coordinator declines a declared group, it should record the concrete conflict or host limitation.

## Routing taxonomy

| Tier | Default profile | Typical use |
| --- | --- | --- |
| Fast | Luna High | Clear, local, low-ambiguity implementation or deterministic verification |
| Balanced | Sol Medium | Ordinary engineering judgment and bounded design choices |
| Strong | Sol XHigh | Unknown root cause, competing hypotheses, deep diagnosis |
| Long | Astra Medium | Broad-context redesign, migration, rollout, sustained cross-system reasoning |

A difficult child task does not automatically escalate its siblings. `long` is not a generic upgrade from `strong`.

## Jev and Agent fallback

Jev is optional and is used only after Bounded Tasks have been identified. When the effective Router prefers Jev, Advisor now invokes the production Jev assessment adapter automatically for each task; callers do not need to pre-inject a Jev decision.

The main value of Jev is not that routing becomes possible only when Jev exists. Its value is that routing judgment can be delegated to a specialized, independent assessment backend:

- **Specialized routing judgment**: Jev focuses on deciding which capability tier each Bounded Task requires instead of making the executing Agent also act as the Router.
- **Lower self-routing coupling**: routing assessment is separated from the Agent that performs the work, keeping resource-allocation judgment outside the executor role.
- **More consistent policy application**: different Coordinators / Agents can normalize Jev assessments into the same shared routing policy and Dispatch Plan contract.
- **Not a hard dependency**: when Jev credentials are absent, Jev fails, or confidence is too low, the Agent applies the same rubric as a fallback and Advisor operation continues.

These are architectural and responsibility-separation benefits; they are not a guarantee that Jev will be more accurate than Agent fallback for every task.

```text
Jev high confidence
→ Jev assessment
→ shared routing policy
→ recommendation

Jev unavailable / failed / low confidence
→ Agent fallback assessment
→ same routing policy
→ recommendation
```

The public Dispatch Plan exposes the selected source and, when fallback occurs, its diagnostic cause:

```text
assessment.source = jev | agent
assessment.fallback = { from: "jev", reason }   # only when Jev was attempted then fell back
```

No Jev credential is required for normal Advisor operation.

## Agent-to-script authoring normalization

The bridge accepts a small set of shorthand forms to reduce avoidable schema retries:

- top-level `context: "text"` → `{ "summary": "text" }`;
- top-level `constraints: "text"` → `{ "summary": "text" }`;
- `boundedTasks[i].context: "text"` → `{ "summary": "text" }`;
- `boundedTasks[i].acceptance: "criterion"` → `["criterion"]`.

The emitted Dispatch Plan remains canonical:

- task `context` is an object;
- task `acceptance` is a non-empty string array.

Other graph, conditional, dependency, and routing-assessment errors remain strict validation failures.

## Example

Run the repository's mixed-tier fixture:

```powershell
Get-Content skill\examples\advisor-mvp.request.json -Raw |
  node skill\scripts\advise-task.mjs
```

Or send a minimal request directly:

```powershell
@'
{
  "task": "Rename one config field and update its focused test",
  "routerPreference": { "backend": "model" },
  "assessments": {
    "T1": {
      "agent": {
        "tier": "balanced",
        "confidence": 0.9,
        "reason": "one bounded engineering cycle"
      },
      "tools": ["code-edit", "node:test"]
    }
  }
}
'@ | node scripts/advise-task.mjs
```

The primary output is `plan`:

```text
version
taskSummary
executionMode
assessmentMode
executionOrder
parallelGroups
tasks[]
```

Each plan task contains the normalized Bounded Task contract plus assessment, recommendation, tools, and rationale.

## Advisor enable/disable and operating modes

`enabled` is the master switch for Codex Route Advisor and defaults to `true`.

```text
Advisor disabled
→ enabled: false
→ completely bypass Advisor
→ no decomposition / assessment / recommendation / Dispatch Plan / trace

Advisor with Agent assessment
→ enabled: true
→ router.backend: model
→ Advisor remains active but does not use Jev

Advisor with Jev-assisted assessment
→ enabled: true
→ router.backend: auto (prefer: jev) or jev
→ prefer Jev; fall back to the Agent when Jev is unavailable, fails, or is low-confidence
```

`enabled: false` is not the same as `executionMode: plan`: `plan` still runs the full Advisor pipeline and stops after producing a Dispatch Plan, while `enabled: false` bypasses the pipeline before decomposition.

See `references/configuration.md` for the full configuration contract, scope precedence, and config locations.

## Execution mode

`executionMode` controls what the Coordinator does after receiving the Dispatch Plan.

| Mode | Coordinator behavior |
| --- | --- |
| `plan` | Show the Dispatch Plan and stop before execution |
| `confirm` | Show the Dispatch Plan and require explicit user approval before execution; default |
| `auto` | Show a concise plan and continue directly into Coordinator execution / delegation |

Preference precedence:

```text
Session > Workspace > Global > Skill default (confirm)
```

Session-only example:

```json
{
  "scope": "session",
  "executionMode": "plan"
}
```

Persistent Workspace example:

```json
{
  "scope": "workspace",
  "executionMode": "auto"
}
```

The Advisor script still does not execute workers itself.

## Coordinator delegation fidelity

When the Coordinator delegates a plan task, the task's routing recommendation is an execution requirement, not display-only metadata.

1. If `recommendation.model` is already a concrete host-supported model id, use it directly.
2. If it is an abstract family token such as `luna`, `sol`, or `astra`, resolve it to a concrete model id accepted by the current host.
3. Spawn with explicit:
   - `model=<resolved concrete model id>`;
   - `reasoning_effort=<recommendation.effort>`;
   - `fork_turns="none"` by default, or a finite positive turn count only when bounded parent context is truly required.
4. Do not use `fork_turns="all"` for a task with model / effort allocation when the host inherits the parent profile for full-history forks.
5. A non-full-history worker message must carry enough Bounded Task context to execute independently.
6. If the requested profile cannot run, record a delegation fallback or unverifiable reason. Do not silently inherit the parent profile while claiming the recommendation was honored.

## Execution trace

Advisor CLI runs create bounded trace state under:

```text
<workspace>/.codex/codex-route-advisor/runs/<run-id>/
├─ run.json
├─ dispatch-plan.json
└─ events.jsonl
```

The Coordinator reuses the same `runId` for delegation and execution lifecycle events.

Retention policy:

- one `events.jsonl` file: maximum 5 MiB;
- total run storage: maximum 100 MiB, trimmed from oldest runs down to 80 MiB;
- retention: 14 days;
- when a run exceeds its limit, `run.json.traceStatus` becomes `truncated`; critical lifecycle events are preserved and `droppedEventCount` records dropped verbose events.

The development repository ignores its own runtime trace. An installed Skill must **not** automatically modify a consumer repository's `.gitignore`, Git exclude file, or other VCS configuration just to hide `.codex/`. If the consumer workspace does not already ignore it, the trace may remain untracked unless the user explicitly chooses to add an ignore rule.

## Runtime evidence boundary

A recommendation is routing intent; it is not proof that the runtime used the recommended profile.

- `requestedModel / requestedEffort` may come from the Dispatch Plan;
- `actualModel / actualEffort / workerId` may be recorded only when the host/runtime provides verifiable evidence;
- requested values must never be copied into actual fields merely to imply successful dispatch.

Release acceptance verifies per-worker model / effort from Codex-host rollout `turn_context`. This is **host-observed runtime evidence**, not independent provider-response metadata. If that evidence cannot be verified, fail closed rather than infer actual values.

## Mixed-tier example

One request may legitimately produce:

```text
T1 Implement local change + focused test → Fast / Luna High
T2 Diagnose failure                    → Strong / Sol XHigh
                                        only if T1 fails
```

Or, for independent implementation surfaces:

```text
T1 Implement helper A → Fast / Luna High
T2 Implement helper B → Fast / Luna High   (parallel with T1)
T3 Integrate A + B    → Fast / Luna High   (depends on T1, T2)
```

## Core scripts

Supported Advisor v1 runtime surface:

- `scripts/advise-task.mjs` — executable Advisor pipeline;
- `scripts/decompose-task.mjs` — Bounded Task normalization and graph checks;
- `scripts/validate-dispatch-plan.mjs` — deterministic Dispatch Plan validator;
- `scripts/routing.mjs` — Jev / Agent-fallback routing primitive;
- `scripts/resolver.mjs` — model / reasoning-effort resolution;
- `scripts/configure.mjs` — preference configuration;
- `scripts/detect-jev.mjs` / `verify-jev.mjs` — Jev capability lifecycle;
- `scripts/model-catalog.mjs` / `model-discovery.mjs` — runtime model facts;
- `scripts/trace.mjs` — execution trace, truncation, and retention.

Files named `spike-*` are historical or experimental evidence and are not part of the supported Advisor v1 runtime surface.

## Install

Install the contents of `skill/` as the Skill root:

```text
<workspace>/.agents/skills/codex-route-advisor/
├─ SKILL.md
├─ scripts/
├─ references/
└─ examples/
```

The Skill root must contain `SKILL.md`, `scripts/`, and `references/`.

After installation, run the smoke test:

```powershell
Get-Content .agents\skills\codex-route-advisor\examples\advisor-mvp.request.json -Raw |
  node .agents\skills\codex-route-advisor\scripts\advise-task.mjs
```

A successful CLI run returns `state = advised`, a validated Dispatch Plan, and `trace.runId`.

## Validation

The development regression suite is maintained at repository-level `tests/` and is intentionally excluded from the public Skill distribution.

## Current v1 limitations

Advisor v1 intentionally keeps a narrow boundary:

- one primary decomposition pass; no recursive decomposition;
- Jev does not choose the task graph;
- no persistent task/project-management layer;
- no provider-level routing transport or proxy;
- no guarantee that every host exposes per-worker model / effort overrides or verifiable runtime metadata;
- when Coordinator capabilities are unavailable, execution must degrade to a form the active Agent can actually perform or surface the capability gap.

## License

MIT — see the repository-level `LICENSE`.
