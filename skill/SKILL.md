---
name: codex-route-advisor
description: 將 Codex 開發需求拆成 routing-oriented Bounded Tasks，逐 task 建議 model / reasoning effort / tools，並輸出 dependency-aware Dispatch Plan。Jev 可作 per-task assessment backend；不可用時由目前 Agent 依相同 rubric fallback。Skill 不執行 runtime model switching。
---

# Codex Route Advisor

## Product boundary

本 Skill 是 **Advisor**，不是 runtime Router。

```text
User task
→ bounded-task decomposition
→ per-task routing assessment
→ model / reasoning effort / tool recommendation
→ Dispatch Plan
→ Coordinator Agent executes / delegates
```

Coordinator Agent 負責 worker spawn、execution、retry、integration 與 final validation。
本 Skill 不實作 Provider / Model Picker / Proxy / transport interception，也不宣稱已切換模型。

## Invocation commands

若使用者以 `$codex-route-advisor <command>` 明確呼叫本 Skill，先讀取 `references/commands.md`，並在一般開發 workflow 前處理 command；**不得把 `init`、`status`、`reset` 等 lifecycle command 當成開發任務做 Bounded Task decomposition**。

正式支援：

```text
$codex-route-advisor init
$codex-route-advisor config [changes]
$codex-route-advisor status
$codex-route-advisor reset [workspace|global]
$codex-route-advisor verify [jev-live]
$codex-route-advisor plan <task>
```

沒有 command 時維持 Normal workflow。這是 Skill invocation contract，不是另一套 shell CLI；底層仍調用既有 scripts / lifecycle workflow。

## Normal workflow

處理一般開發需求時：

1. 先解析有效設定（Session > Workspace > Global > Skill default）。若 `enabled = false`，立即 bypass 本 Skill：不做 decomposition、Jev detection / assessment、Agent routing assessment、recommendation、Dispatch Plan 或 execution trace，後續維持 host / Coordinator 原生行為。
2. 若 `enabled = true`，讀取 `references/bounded-task-decomposition.md`。
3. 對原始需求做一次主要 decomposition pass。
4. 只有 capability、reasoning、primary tools、dependency、validation 或 risk boundary 真的改變時才 split。
5. **做一次 explicit parallel-safety pass**：對同一 dependency frontier 上的 tasks，若它們沒有 dependency 關係、修改不同 mutable implementation surfaces、共用介面/測試契約已固定，且各自可獨立驗收，必須把它們放進同一 `parallelGroups` 候選；不要只在 rationale 寫「independent」卻漏掉 `parallelGroups`。
6. 為每個 bounded task 建立 Agent fallback assessment。
7. 若 effective Router 選擇 Jev，交由 `scripts/advise-task.mjs` 對每個 bounded task 自動呼叫 production Jev assessment adapter；不要自行捏造 Jev decision。Host 預先提供的 Jev assessment 只保留作 deterministic fixture / compatibility override。
8. 若 effective `allowModelEscalation = false`，從目前 Host / turn context 取得使用者在 App / CLI / VSCode picker 選定的 Coordinator `model + effort`，以 `coordinatorProfile` 傳給 `scripts/advise-task.mjs`；不得猜測或用 routing default 代替目前 Host profile。
9. 將 normalized request 送入 `scripts/advise-task.mjs`。
10. 使用回傳 Dispatch Plan 決定 coordinator 執行順序與 worker allocation。
11. 依 Dispatch Plan 的 `executionMode` 決定後續：
   - `plan`：顯示 plan 後停止，不執行；
   - `confirm`：顯示 plan，詢問使用者是否依 plan 執行；只有明確同意後才進入 execution；
   - `auto`：顯示簡短 plan 後，由 Coordinator 直接依 plan 執行 / delegation。
## Bounded Task

Normalized task fields：

```text
id
goal
context
dependsOn
deliverable
acceptance
conditional
boundaryReason
```

Bounded Task 是「最小需要獨立 routing decision 的工作單位」。

停止拆分條件：
- 子步驟需要相同 model / reasoning profile；
- 使用相同核心 tools；
- 共享相同 local context；
- 屬於同一 validation cycle；
- 沒有獨立 dependency gate。

因此「修改一段程式 + 跑 focused test」通常維持一個 task。

特別是這種常見流程：

```text
implement X
→ run focused test for X
→ only if that test fails, diagnose root cause
```

應優先拆成：
- T1：implement X + run its focused test（同一 bounded task / validation cycle）；
- T2：diagnose failure，depends on T1，且 `conditional.outcome = failure`。

**不要只因 focused test 的 pass/fail 會觸發 conditional diagnosis，就把 implementation 與 focused test 自己拆成兩個 bounded tasks。** 真正的新 routing boundary 是 failure diagnosis，而不是同一實作循環內的 focused verification。

若 request 沒有提供 semantic decomposition，`decompose-task.mjs` 會保守地把整個 request 視為單一 `T1`；它不使用關鍵字 heuristics 假裝理解需求。

## Per-task assessment

每個 bounded task 都必須準備 Agent fallback：

```json
{
  "tier": "balanced",
  "confidence": 0.9,
  "reason": "ordinary bounded engineering work"
}
```

可選 signals：
- `taskComplexity`
- `reasoningRequired`
- `toolComplexity`

值域皆為 `0..1`。

正常 Jev-enabled execution 不需要 host 預先提供 Jev assessment；`advise-task.mjs` 會在 bounded task 形成後自行呼叫 production Jev adapter。若測試或相容性情境明確注入 Jev assessment，格式仍使用相同的 `tier / confidence / reason`，並可帶相同 signals。
## Routing taxonomy

只允許：

- `fast`：明確、局部、低歧義、主要依既有 pattern 執行。
- `balanced`：一般工程判斷，有局部設計選擇。
- `strong`：根因未知、需要 competing hypotheses 或深度診斷。
- `long`：長程、廣上下文、migration / rollout / major redesign planning。

Default profiles：

```text
Fast     → Luna High
Balanced → Sol Medium
Strong   → Sol XHigh
Long     → Astra Medium
```

低 confidence 不是自動升級 tier 的理由。

## Jev / Agent fallback

既有 routing primitive 內部仍使用 backend 名稱 `model` 表示非-Jev decision path。
在 Advisor public contract 中它必須正規化為：

```text
backend=jev   → assessment.source=jev
backend=model → assessment.source=agent
```

Policy：
- Jev >= confidence threshold → 採用 Jev。
- Jev unavailable / error / low confidence → 使用 Agent fallback。
- Agent 仍低於 threshold → `clarification_required`。
- 一個 request 可由不同 bounded tasks 得到不同 tier；不得因一個 Strong child task 升級所有 siblings。
## Executable input

`scripts/advise-task.mjs` 接受 JSON stdin。

最小單 task input：

```json
{
  "task": "Rename one config field and update its focused test",
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
```

Multi-task request 可另外提供：
- `context`
- `constraints`
- `boundedTasks`
- `parallelGroups`
- `assessments.<taskId>.jev`（deterministic fixture / compatibility override）
- `assessments.<taskId>.jevError`（deterministic failure fixture）
- `routerPreference`
- `confidenceThreshold`
- `modelInventory`
- `modelCapabilities`
- `coordinatorProfile: { model, effort }`（`allowModelEscalation=false` 時必要，必須反映目前 Host picker / turn context）
- legacy `modelCatalog`
- model cache / refresh controls
- config path / session overrides

正常 CLI 執行若未提供 explicit runtime inventory/catalog，會自動透過
`scripts/codex-model-source.mjs` 呼叫 `codex debug models` 取得目前 Codex
host 的 Model Inventory；library / test caller 仍可注入 deterministic source。

### Agent-to-script authoring normalization

Bridge JSON 是 Agent 內部產物，不要求 Agent 每次先背完整 schema。輸入端接受下列 shorthand，進入 Dispatch Plan 前一律正規化成 canonical shape：

- top-level `context: "text"` → `context: { "summary": "text" }`；
- top-level `constraints: "text"` → `constraints: { "summary": "text" }`；
- `boundedTasks[i].context: "text"` → `{ "summary": "text" }`；
- `boundedTasks[i].acceptance: "criterion"` → `["criterion"]`。

Canonical bounded-task contract 仍然是：
- `context` = object；
- `acceptance` = non-empty string array。

不要依賴其他隱式 coercion；graph、conditional、dependency、routing assessment 等欄位仍採嚴格驗證。

每個 task 的 `assessments.<taskId>.agent` 都是必要 fallback；這讓 Jev failure 不需要重新做一套 routing taxonomy。
## Dispatch Plan

Primary output：

```text
version
taskSummary
executionMode
assessmentMode
executionOrder
parallelGroups
tasks[]
```

每個 plan task 包含：
- normalized bounded task；
- `assessment.source = jev | agent`；
- confidence / optional signals；
- `recommendation.tier / effort / model`；
- 若 escalation 被 policy 阻擋，另保留 `recommendation.preferredModel / preferredEffort / constraint=model_escalation_disabled`；
- required tools；
- short rationale。

`scripts/advise-task.mjs` 在輸出前必須通過 `validateDispatchPlan()`。
它只產生 advisory plan，不執行 worker。

## Execution trace

Advisor CLI 建立 Dispatch Plan 後，會建立：

```text
<workspace>/.codex/codex-route-advisor/runs/<run-id>/
├─ run.json
├─ dispatch-plan.json
└─ events.jsonl
```

Coordinator 在 delegation / execution 過程必須沿用同一 `runId` 追加事件。詳細 contract 見 `references/execution-trace.md`。

硬性規則：
- `requestedModel / requestedEffort` 可來自 Advisor recommendation；
- `actualModel / actualEffort / workerId` 只能在 runtime 真正確認後記錄；
- 不得把 requested 值複製成 actual 值假裝已分派；
- 若 `run.json.traceStatus = truncated`，user-facing response 必須明確標示 trace 已截斷；
- 建立 trace **不得自動修改 consumer repository 的 `.gitignore`、exclude 或其他 VCS 設定**。若 workspace 尚未忽略 `.codex/`，保留為 untracked runtime state 即可；只有使用者明確要求時才修改 ignore 規則。

## Coordinator behavior

拿到 Dispatch Plan 後先處理 `executionMode`：

- `plan`：只呈現 Dispatch Plan，停止於 planning boundary。
- `confirm`：呈現 Dispatch Plan，明確詢問是否依此 plan 執行；未取得同意前不得修改檔案或執行 worker task。
- `auto`：可直接進入 Coordinator execution，不需額外 approval pause。

之後若進入 execution：
- `allowModelEscalation=false` 時，`recommendation.model / effort` 已是 effective profile；Coordinator 必須執行 effective profile，不得改回被阻擋的 `preferredModel / preferredEffort`；
- 依 `executionOrder` 與 `dependsOn` 執行；
- `parallelGroups` 代表 Advisor 已完成第一輪 parallel-safety 判定。Coordinator 仍需做 runtime mutable-state safety check；若 host 支援 sub-agent delegation，且沒有發現新的衝突，應對 group 成員做 concurrent delegation，而不是無理由退回 coordinator sequential execution；
- 若 Coordinator 因新的 shared mutable state、未固定介面、工具限制或 host capability 而不採用某個 parallel group，必須在 trace / user-facing summary 記錄原因；
- `conditional` 僅在指定 predecessor outcome 成立時執行；
- task 執行結果由 coordinator 整合與驗證。

### Delegation fidelity

若 Coordinator 決定把某個 plan task 委派給 sub-agent，必須忠實執行該 task 的 routing recommendation：

1. `recommendation.model` 若已是 host 接受的 concrete model id，直接使用。
2. 若它只是 family token（例如 `luna` / `sol` / `astra`），先從目前 host / `spawn_agent` 可用模型或已驗證 runtime model catalog 中解析成同 family 的 concrete model id；不得把 family token 直接傳給只接受 concrete id 的 host。
3. 呼叫 `spawn_agent` 時，必須明確傳入：
   - `model = <resolved concrete model id>`；
   - `reasoning_effort = recommendation.effort`；
   - `fork_turns = "none"`，或在確有必要時使用有限的正整數 turn count。
4. **不得使用 `fork_turns = "all"` 來執行有 model / effort recommendation 的 task**；Codex host 的 full-history fork 會繼承 parent model / effort，且不接受 override，會破壞 Dispatch Plan 的 allocation。
5. 因 `fork_turns != "all"`，worker message 必須自包含 task `goal`、必要 `context`、dependency outputs、`deliverable`、`acceptance` 與可用 tools；不要依賴完整 parent conversation。
6. 若推薦的 concrete model / effort 無法在目前 host 執行，先記錄 `delegation_fallback` / 不可驗證原因，再選擇經驗證的相容替代或由 coordinator 本地執行；**不得靜默退回 parent model / effort 並宣稱已遵循 recommendation**。
7. `requestedModel / requestedEffort` 代表 Advisor intent；`actualModel / actualEffort / workerId` 仍只能在 host runtime evidence 真正確認後記錄。

不要把 Dispatch Plan 擴張成 persistent task-management system。
不要 recursive decomposition。
## First-run configuration

`$codex-route-advisor init` 是正式 first-run / reconfigure 入口；其完整行為依 `references/commands.md` 與 `references/operations.md`。

初始化仍可使用既有：
- `scripts/configure.mjs`：Global / Workspace / Session preferences；
- `scripts/detect-jev.mjs`：Jev capability detection；
- `scripts/verify-jev.mjs`：只有使用者明確要求時做 live verification；
- model inventory / capability / catalog / discovery references：取得 runtime model facts；新發現但未分類的 model 不得進入 automatic routing。

Preference precedence：

```text
Session > Workspace > Global > Skill default
```

首次初始化必須詢問：`Allow model escalation beyond the currently selected host model?`，預設 `No`。其值寫入 `allowModelEscalation`；Skill default 亦為 `false`。

`allowModelEscalation=false` 代表目前 Host / App / CLI / VSCode picker 選定的 Coordinator model + effort 是 routing 上限；Advisor 可以保留更高階 preferred recommendation，但 effective worker profile 不得超過 Coordinator。只有明確設為 `true` 才允許 upward escalation。

`executionMode` 使用相同 precedence，預設為 `confirm`。使用者說「這次只規劃」等價於 Session `plan`；「這次自動執行」等價於 Session `auto`。只有使用者明確要求持久化時才寫 Workspace / Global。

Jev credential 未設定不阻止 Advisor 使用；Agent fallback 是正式支援路徑。

## User-facing response

正常模式保持精簡，例如：

```text
T1 Implement product list — Sol Medium
T2 Playwright validation — Luna High — depends on T1
T3 Diagnose/fix failure — Sol XHigh — only if T2 fails
```

只有在使用者要求 `explain` 時，再顯示 boundary reason、assessment source、confidence、routing reason 與 fallback diagnostics。

## Scripts

- `scripts/decompose-task.mjs`：bounded-task normalization / graph validation。
- `scripts/advise-task.mjs`：可執行 Advisor pipeline。
- `scripts/validate-dispatch-plan.mjs`：Dispatch Plan deterministic validator。
- `scripts/routing.mjs`：Jev / fallback routing primitive。
- `scripts/resolver.mjs`：model / effort resolution。
- `scripts/configure.mjs`：configuration。
- `scripts/detect-jev.mjs`、`verify-jev.mjs`：Jev capability lifecycle。
- `scripts/jev-assessor.mjs`：production per-task Jev routing assessment。
- `scripts/codex-model-source.mjs`：Codex host model source（`codex debug models` → Inventory）。
- `scripts/model-inventory.mjs`：availability inventory、inventory cache、exact-id capability classification。
- `scripts/model-catalog.mjs`、`model-discovery.mjs`：resolved catalog 與 provider-neutral discovery orchestration。
- `scripts/trace.mjs`：bounded execution trace、truncate 與 retention cleanup。

## References

- `references/commands.md`
- `references/bounded-task-decomposition.md`
- `references/dispatch-plan.md`
- `references/routing.md`
- `references/configuration.md`
- `references/model-catalog.md`
- `references/model-discovery.md`
- `references/execution-trace.md`
