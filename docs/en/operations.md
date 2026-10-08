# Operations and troubleshooting

[README](../../README.md) | [Configuration](configuration.md) | [繁體中文](../zh_TW/operations.md)

## Command behavior

These are Skill commands entered in a Codex conversation, not shell CLI commands.

| Command | Behavior and boundaries |
| --- | --- |
| `$codex-route-advisor init` | Inspect config, credentials, and available model facts; show current values and ask unresolved choices. Write after explicit scope selection. Preserve unspecified fields on reruns; cancellation before saving leaves files unchanged. |
| `$codex-route-advisor config` | Show effective values and sources; changes patch the chosen scope without replacing other fields. |
| `$codex-route-advisor status` | Read-only config, Jev, and model compatibility; no preference changes or Jev live call. |
| `$codex-route-advisor reset workspace` | After confirmation, remove only Workspace config; preserve Global, cache, and traces. Likewise for `reset global`. An omitted scope requires confirmation of Workspace, never an implicit all. |
| `$codex-route-advisor verify` | Local Skill file, config, model-fact, and credential checks; no automatic Jev live probe. |
| `$codex-route-advisor verify jev-live` | Explicit live probe without changing Router or persisted config. |
| `$codex-route-advisor plan <task>` | Session-only `executionMode=plan`; stop after decomposition, assessment, plan validation, and trace creation. No workers or implementation edits. |

First-run escalation defaults to No; reruns preserve existing choices. Explicit fields and scope should not be asked again. Unknown commands should list supported commands rather than be guessed as destructive operations.

## Everyday execution

Describe the work and acceptance criteria; no bridge JSON is needed. A local implementation and focused test usually form one Bounded Task; failure-only diagnosis is a separate conditional task.

`parallelGroups` are concurrency candidates. The Coordinator still checks shared mutable state. If delegation is unavailable or new conflicts appear, it should explain sequential/local execution.

See [model allocation](../../README.md#model-allocation-and-execution). Execute the effective profile, not a higher preferred profile blocked by policy. Record fallback when a worker cannot run; do not claim the recommendation was honored. To inspect the reasoning, ask:

```text
Explain this Dispatch Plan: decomposition boundaries, assessment source, fallback,
model choices, dependencies, and why further decomposition stopped.
```

## Jev setup and verification

1. Provide `TYPESAFE_API_KEY` in the environment that actually runs Codex. Do not put it in config or prompts. Windows App and WSL/CLI processes may see different environments.
2. Select Jev-assisted with `init` and choose its scope.
3. Explicitly run `$codex-route-advisor verify jev-live` if you want to test the API.
4. Use a real task to check production assessment. A successful probe establishes live capability, not per-task assessment completion.

| State / event | Meaning |
| --- | --- |
| `configured_unverified` | Credential exists; live API success has not been established |
| `unavailable / missing_api_key` | No credential in the current process; Agent remains available |
| `assessment.source=jev` | This task used Jev assessment |
| `assessment.source=agent` with `fallback` | A Jev attempt fell back; inspect `fallback.reason` |

Jev assesses tasks after decomposition; it does not form the task graph. The default confidence threshold is `0.75`. Unavailability, errors, or low confidence use Agent fallback with the same rubric. Low Agent confidence requires clarification, not automatic tier escalation. Agent-only does not call Jev.

## Updates, reset, and removal

- **Update**: replace installed `skill/` contents, keeping Project/Global config and cache; read the new package's README and docs.
- **Reset**: use `reset workspace` or `reset global`, then confirm removal of that scope's config; cache and traces remain.
- **Uninstall**: remove the installed Skill directory. Config/cache remain unless separately selected for cleanup.

Skill changes are normally detected automatically. If the selector does not update, restart Codex App and open a new conversation in the same Project. See [official Skills documentation](https://learn.chatgpt.com/docs/build-skills).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| Skill not found | Verify `<project>/.agents/skills/codex-route-advisor/SKILL.md`, scripts, references, and correct Project; restart if needed. |
| init only says it is waiting for settings | It should ask an answerable next question. Update to the fix, rerun bare init, and record the response. |
| Setting change has no effect | Inspect sources: Session > Workspace > Global. A new conversation removes old Session overrides. |
| No plan with enabled=false | This bypasses Advisor. Keep enabled=true and select plan for planning only. |
| Jev missing_api_key | Check the actual process environment without sharing the key; Agent-only remains usable. |
| New model is unclassified | Host availability exists but exact-id policy does not. Status reports it, verify warns; no automatic routing/default promotion. |
| Availability / effort unknown | Check Host inventory/cache; missing facts are not verified facts. Do not infer from model names. |
| Allocated model lower than expected | Check Coordinator model/effort and escalation policy, then preferred vs effective. Verify actual workers with Host evidence. |
| Config parsing fails | Check strict JSON, schemaVersion=1, valid model/effort; consult Configuration without overwriting unrelated fields. |
| Execution incomplete | Compare dependencies, condition outcomes, delegation fallback, and final acceptance. A plan is not completion evidence. |

## Traces and issue reports

Normal Advisor planning creates Workspace state:

```text
.codex/codex-route-advisor/runs/<run-id>/
├─ run.json             # Run summary and trace status
├─ dispatch-plan.json   # Validated plan
└─ events.jsonl         # Coordinator lifecycle evidence
```

`requestedModel / requestedEffort` are intent. `actualModel / actualEffort / workerId` require Host runtime evidence and must not be copied from requested values. `traceStatus=truncated` means the trace is incomplete.

Defaults: 5 MiB per events file, 100 MiB total run storage (trimmed to 80 MiB when exceeded), and 14-day retention. The Skill does not change `.gitignore` or exclude settings automatically; you choose whether to ignore `.codex/`. See [trace contract](../../skill/references/execution-trace.md).

Issue report template:

```text
Environment: OS / Host and version / Skill version / Coordinator model and effort
Settings: relevant effective values and sources (no key)
Reproduction: original prompt / steps
Result: expected / actual behavior / reproducibility
Evidence: sanitized Dispatch Plan / runId / events / error
```

Do not share keys, tokens, company secrets, private source code, or personal data. A minimal sanitized reproduction is sufficient. Development checklists/tests are excluded from this package; maintainers can record results from real use in development acceptance records.
