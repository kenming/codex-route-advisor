# Troubleshooting

## Skill 沒有被找到

確認：

```text
<workspace>/.agents/skills/codex-route-advisor/SKILL.md
```

存在，且 `scripts/`、`references/` 與 SKILL.md 位於同一 Skill root。

## Jev unavailable

Jev 是可選 backend。

若 `detect-jev.mjs` 回傳 unavailable：

- 不視為 Skill 安裝失敗；
- 使用 Model Router；
- 不自動呼叫 Jev。

## Jev configured but unverified

這是正常狀態。

只有使用者要求時執行 live verification。

## Jev routing failure

若 Jev unavailable、network error、provider error 或低信心：

```text
Jev
→ Model Router fallback
```

`fallback.from` 與 `fallback.reason` 必須保留。

## Model Router 仍低信心

應回傳：

```text
clarification_required
```

要求使用者補充需求；不要直接升級到 Strong 或 Long。

## Preferred model unavailable

一般 tier preference 可以選擇同 tier 且不降低能力的 available replacement。

若是 **explicit concrete model override**：

- 不得靜默替換；
- 請使用者選同模型可用 effort、等效模型或取消 override。

## Invalid config

設定錯誤不靜默忽略。

先確認錯誤來源：

```text
Session
Workspace
Global
Skill default
```

常見錯誤：

- `unknown_tier`
- `unsupported_effort`
- `invalid_model_tier_combination`
- `invalid_model_effort_combination`
- `model_unavailable`

## 選到模型但沒有執行

Stage 1 的正確行為就是：

```text
dispatchStatus = not_dispatched
```

Stage 1 只產生 `EffectiveRoutingDecision`。

真正的 selected-model execution 屬於 Stage 2 Dispatcher。
