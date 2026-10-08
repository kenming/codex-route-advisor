# Invocation Commands

Codex Route Advisor supports explicit Skill-level invocation commands.

```text
$codex-route-advisor <command> [arguments]
```

These are **Skill invocation commands**, not a separate shell CLI. The Coordinator interprets the command and maps it to the existing Advisor scripts/workflows.

If no command is supplied, the Skill runs the normal Advisor workflow for the user's development request.

## Supported commands

| Command | Purpose |
| --- | --- |
| `init` | Initialize or re-run the guided Advisor setup |
| `config` | Inspect or modify effective configuration |
| `status` | Show read-only Advisor/Jev/model/config status |
| `reset` | Remove persisted Advisor configuration for an explicit scope |
| `verify` | Verify installation and local capabilities; live Jev only when explicitly requested |
| `plan <task>` | Produce a Dispatch Plan only; do not execute |

## `init`

```text
$codex-route-advisor init
```

Workflow:
1. inspect current configuration;
2. detect Jev credential presence without a network call;
3. obtain runtime model facts when available;
4. ask the normal Router/profile/scope questions;
5. ask whether model escalation beyond the current Host-selected model is allowed;
6. default that answer to **No** (`allowModelEscalation=false`);
7. persist only to the scope explicitly chosen by the user.

Initialization must not make a Jev live API call automatically.
Existing configuration is not deleted first. Re-running `init` is an update flow, not an implicit reset.

### Guided interaction

After inspection, the first response must briefly show the effective Router,
profiles, executionMode and allowModelEscalation with their sources, config
presence, and Jev/model detection results. Report unavailable facts as unknown.
Then ask a concrete question with answerable choices; do not stop at
"checks complete" or "waiting for your settings" without a question.

For a bare `init`, start with Router: keep the current selection, Agent-only,
or Jev-assisted with Agent fallback. Continue with profiles, executionMode
(`plan | confirm | auto`), escalation (`No | Yes`), and scope
(`Session | Workspace | Global`). Ask one selection at a time unless the user
prefers a combined form. Show the current value and a keep-current choice;
use Skill defaults only for first-run values, including escalation **No**.
Every intermediate response must ask the next unresolved question.

Honor choices already supplied in the invocation or conversation; do not ask
again for an explicit scope or change. If the user requests only one change
and says to preserve the rest, apply that patch rather than reopening all
profile questions. Persist only after the scope and requested changes are
explicit; cancellation before saving must leave persisted config unchanged.

On completion, read back the resulting settings and report the applied scope,
effective values/sources, and saved file (or Session-only / no file written).
For example, with an existing Agent-only configuration, the first question
can be: "Keep Agent assessment, or change to Jev-assisted with Agent fallback?"

## `config`

```text
$codex-route-advisor config
$codex-route-advisor config executionMode=plan
$codex-route-advisor config allowModelEscalation=false
$codex-route-advisor config enabled=false scope=workspace
$codex-route-advisor config enabled=true scope=session
```

With no arguments, inspect effective configuration and show each value's source.
With requested changes, preserve existing same-scope values and apply normal patch semantics.

`enabled` defaults to `true` and follows Session > Workspace > Global > Skill default.
Session changes are conversation-only; Workspace / Global changes persist until changed.
If a requested change omits scope, ask for scope before saving; do not infer persistence.
These arguments are interpreted by the Coordinator and mapped to the existing configuration script.
Changing `enabled` does not install a Host hook or guarantee implicit Skill selection.
Lifecycle commands remain available while disabled, so the user can inspect or re-enable Advisor.
Do not automatically change `enabled` merely because the user explicitly invokes the Skill.

## `status`

```text
$codex-route-advisor status
```

Read-only summary:
- Advisor enabled state and effective config;
- Workspace / Global config presence;
- Jev `configured_unverified | unavailable` state;
- runtime model inventory/cache facts when available;
- model compatibility grouped as `classified / unclassified / unavailable`;
- current Coordinator model/effort only when the Host exposes them.

Compatibility meanings:
- `classified`: Host available and exact Advisor policy exists;
- `unclassified`: Host available but no exact Advisor policy; it remains non-routable;
- `unavailable`: Advisor policy exists but the model is unavailable or not observed by the Host.

`status` must not persist configuration, auto-classify models, update defaults, or make a Jev live API call.

## `reset`

```text
$codex-route-advisor reset workspace
$codex-route-advisor reset global
```

Reset is destructive and requires explicit confirmation before deleting persisted config.
Default reset scope is **workspace** only when the user omitted a scope and confirms that interpretation.

Resetting config does not delete the model cache or execution traces unless the user explicitly asks for those assets too.
Do not silently perform `reset all`.

## `verify`

```text
$codex-route-advisor verify
$codex-route-advisor verify jev-live
```

Default verification is local/non-destructive:
- required Skill files/scripts are present;
- configuration loads and validates;
- model discovery/cache can be inspected;
- model compatibility can be evaluated;
- Jev credential presence can be detected.

An available `unclassified` model produces a `model_unclassified` warning only. That condition does not fail installation verification and must not auto-classify the model, change defaults, or mutate persisted configuration.

Only `verify jev-live` or an equivalent explicit request may run `scripts/verify-jev.mjs`.
Live verification must not change Router preference or persisted configuration.

## `plan <task>`

```text
$codex-route-advisor plan <task>
$codex-route-advisor plan Implement product search and validate it with Playwright
```

Treat the remainder as the development task and apply a **Session-only** `executionMode=plan`.
First apply the normal enabled gate: if effective `enabled=false`, report that Advisor is disabled and produce no plan or trace; do not override it implicitly.
Run normal decomposition, assessment, model allocation, Dispatch Plan validation, and trace creation.
Stop at the planning boundary; do not execute workers or modify implementation files.

## Command errors

Unknown commands should not be guessed. Show the supported command names and ask the user to choose or restate the request.
A malformed destructive command must fail closed rather than infer a broader reset scope.
