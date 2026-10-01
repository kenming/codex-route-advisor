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

## `config`

```text
$codex-route-advisor config
$codex-route-advisor config executionMode=plan
$codex-route-advisor config allowModelEscalation=false
```

With no arguments, inspect effective configuration and show each value's source.
With requested changes, preserve existing same-scope values and apply normal patch semantics.

## `status`

```text
$codex-route-advisor status
```

Read-only summary:
- Advisor enabled state and effective config;
- Workspace / Global config presence;
- Jev `configured_unverified | unavailable` state;
- runtime model inventory/cache facts when available;
- current Coordinator model/effort only when the Host exposes them.

`status` must not persist configuration or make a Jev live API call.

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
- Jev credential presence can be detected.

Only `verify jev-live` or an equivalent explicit request may run `scripts/verify-jev.mjs`.
Live verification must not change Router preference or persisted configuration.

## `plan <task>`

```text
$codex-route-advisor plan <task>
$codex-route-advisor plan Implement product search and validate it with Playwright
```

Treat the remainder as the development task and apply a **Session-only** `executionMode=plan`.
Run normal decomposition, assessment, model allocation, Dispatch Plan validation, and trace creation.
Stop at the planning boundary; do not execute workers or modify implementation files.

## Command errors

Unknown commands should not be guessed. Show the supported command names and ask the user to choose or restate the request.
A malformed destructive command must fail closed rather than infer a broader reset scope.
