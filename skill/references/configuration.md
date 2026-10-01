# Configuration

## Scope precedence

設定合併順序固定：

```text
Session override
> Workspace config
> Global config
> Skill default
```

Session 不持久化。

## Config locations

Workspace：

```text
<workspace>/.codex/codex-route-advisor/config.json
```

Global：

```text
Windows: %LOCALAPPDATA%\codex-route-advisor\config.json
macOS:   ~/Library/Application Support/codex-route-advisor/config.json
Linux:   $XDG_CONFIG_HOME/codex-route-advisor/config.json
         fallback → ~/.config/codex-route-advisor/config.json
```

不存在的 config 是合法狀態。

## Schema

目前 `schemaVersion = 1`。

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "executionMode": "confirm",
  "allowModelEscalation": false,
  "router": {
    "backend": "auto",
    "prefer": "jev"
  },
  "routing": {
    "fast": {
      "model": "luna",
      "effort": "high"
    },
    "balanced": {
      "model": "sol",
      "effort": "medium"
    },
    "strong": {
      "model": "sol",
      "effort": "xhigh"
    },
    "long": {
      "model": "astra",
      "effort": "medium"
    }
  }
}
```

machine-readable schema：`config.schema.json`。

## Advisor enable / disable

`enabled` 是整個 Advisor 的總開關，型別為 boolean，Skill default 為 `true`。

```text
enabled = true
→ 正常執行 Advisor pipeline

enabled = false
→ 在 decomposition 前直接 bypass Advisor
→ 不做 Jev detection / assessment
→ 不做 Agent routing assessment
→ 不做 model / effort recommendation
→ 不產生 Dispatch Plan
→ 不建立 execution trace
→ 後續維持 host / Coordinator 原生行為
```

`enabled` 使用相同 precedence：

```text
Session > Workspace > Global > Skill default (true)
```

`enabled: false` 不等同 `executionMode: plan`；後者仍會執行完整 Advisor，只停止於 Dispatch Plan。

典型模式：

```text
enabled=false
→ Advisor disabled

enabled=true + router.backend=model
→ Advisor + Agent assessment only

enabled=true + router.backend=auto, router.prefer=jev
→ Advisor + Jev-assisted assessment with Agent fallback
```

## Execution mode

`executionMode` accepts exactly:

```text
plan
confirm
auto
```

Behavior:
- `plan`: Advisor returns the Dispatch Plan; coordinator stops before execution.
- `confirm`: Advisor returns the Dispatch Plan; coordinator asks the user whether to execute it. This is the Skill default.
- `auto`: Advisor returns the Dispatch Plan; coordinator may continue execution/delegation without another approval prompt.

It follows the same scope precedence:

```text
Session > Workspace > Global > Skill default
```

A per-turn natural-language override should be represented as a Session override rather than persisted unless the user explicitly requests Workspace or Global configuration.

## Model escalation policy

`allowModelEscalation` is a boolean and defaults to `false`.

- `false`: the model + reasoning effort currently selected in the Host / App / CLI / VSCode picker is the effective upper routing boundary. The Coordinator must pass it as `coordinatorProfile: { model, effort }` when invoking `advise-task.mjs`.
- `true`: Advisor may recommend and dispatch profiles above the current Coordinator when the normal tier policy resolves there.

When escalation is disabled, Advisor still performs the original assessment. If the preferred profile exceeds the Coordinator, the Dispatch Plan keeps the assessment tier and adds `preferredModel`, `preferredEffort`, and `constraint=model_escalation_disabled`, while `recommendation.model / effort` become the effective capped profile.

A lower model family may still use a higher effort (for example Luna Max under a Sol Medium coordinator); the boundary prevents upward capability-family routing and stronger effort within the same family.

This field follows the same precedence: `Session > Workspace > Global > Skill default(false)`.

## Field-level merge

各 scope 可只覆寫 `model` 或 `effort`。

`configure.mjs` 對同一 scope 的更新也採 patch semantics：未出現在本次 request 的 `enabled`、router、tier、executionMode、allowModelEscalation 或 tier field 必須保持原值，不得以 Skill defaults 重寫既有設定。

`router` object 也採 field-level patch。例如既有 `{ "backend": "auto", "prefer": "jev" }`，只送 `{ "prefer": "model" }` 後，`backend` 仍保持 `auto`。

例如：

```text
Global balanced.model = sol
Workspace balanced.effort = high
Session balanced.effort = xhigh
```

最後：

```text
balanced = Sol XHigh
```

來源分別保留在 `preferenceSource`。

## Defaults

```text
fast     → luna / high
balanced → sol / medium
strong   → sol / xhigh
long     → astra / medium
```

這些是 Skill default，不是不可覆寫的硬編碼選擇。

## Configure script

檢查目前狀態：

```json
{"action":"inspect","workspaceRoot":"<workspace>"}
```

寫 Workspace：

```json
{
  "scope": "workspace",
  "workspaceRoot": "<workspace>",
  "router": "jev"
}
```

完全關閉目前 Workspace 的 Advisor：

```json
{
  "scope": "workspace",
  "workspaceRoot": "<workspace>",
  "enabled": false
}
```

寫 Global：

```json
{
  "scope": "global",
  "router": "model"
}
```

Session：

```json
{
  "scope": "session",
  "router": "model",
  "executionMode": "plan"
}
```

只在本次 Session 暫時 bypass Advisor：

```json
{
  "scope": "session",
  "enabled": false
}
```

只調整 Workspace execution mode：

```json
{
  "scope": "workspace",
  "executionMode": "auto"
}
```

明確允許向上調度：

```json
{
  "scope": "workspace",
  "allowModelEscalation": true
}
```

首次初始化應主動詢問是否允許超過目前 Host 所選模型；預設答案為 No (`false`)。

Session 只回傳 override，不寫檔。

## Validation behavior

設定錯誤不靜默 fallback。

常見錯誤：

```text
invalid_schema
unknown_tier
unknown_model
unsupported_effort
invalid_model_tier_combination
invalid_model_effort_combination
model_unavailable
```

Luna 的 Skill policy floor 為 High。
