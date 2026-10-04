# Codex Route Advisor

[English](README.md) | [繁體中文](README.zh-TW.md)

`codex-route-advisor` 是用於 Codex 開發工作的規劃與模型配置顧問（Advisor）。

它不會自行攔截執行期請求，也不會自行切換模型。它會先把開發需求拆成適合路由判斷的**有界任務（Bounded Task）**，逐一評估每個任務，建議模型／推理強度／工具配置，再輸出具相依關係的**派送計畫（Dispatch Plan）**，供目前的**協調器（Coordinator）**執行。

```text
使用者需求
→ 有界任務（Bounded Task）拆解
→ 逐任務路由評估（per-task routing assessment）
→ 模型／推理強度／工具建議
→ 派送計畫（Dispatch Plan）
→ 協調器（Coordinator）執行／委派
```

## 快速開始（Quick Start）

### 1. 前置需求

- 可載入 Workspace Skill 的 Codex 相容 Agent / Coordinator；
- 可執行內附 `.mjs` scripts 的 Node.js；
- Jev 為選用能力，不是必要依賴；
- 若要啟用 Jev 偵測，需在環境中提供 `TYPESAFE_API_KEY`。

目前 repository **沒有宣告最低 Node.js 版本**，因此 README 不自行假設最低版本。即使沒有 Jev，Codex Route Advisor 仍可透過 Agent fallback 完整運作。

### 2. 安裝

將此 repository 的 `skill/` 目錄內容複製到目標 Workspace：

```text
<workspace>/.agents/skills/codex-route-advisor/
├─ SKILL.md
├─ scripts/
├─ references/
└─ examples/
```

安裝後的 Skill root 至少必須包含 `SKILL.md`、`scripts/` 與 `references/`。

### 3. 首次設定

建議先使用預設的安全模式：

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

設定優先順序固定為：

```text
Session > Workspace > Global > Skill default
```

第一次使用時，Skill 應先檢查既有設定、偵測是否具備 Jev credential、在可取得時讀取 runtime model facts，再套用 Session / Workspace / Global preference。初始化階段**不應自動呼叫 Jev live API**。

建議直接使用正式初始化指令：

```text
$codex-route-advisor init
```

初始化也會詢問是否允許 Advisor 超過 Host picker 目前選定的模型；建議預設選 **No**（`allowModelEscalation=false`）。

若要手動檢查目前設定：

```powershell
'{"action":"inspect","workspaceRoot":"<workspace>"}' |
  node .agents\skills\codex-route-advisor\scripts\configure.mjs
```

如果不想使用 Jev，將 `router.backend` 設為 `model`。若要完全關閉 Advisor，則將 `enabled` 設為 `false`。

### 4. 驗證安裝

先檢查 Jev capability；這個動作**不會發送 live API request**：

```powershell
node .agents\skills\codex-route-advisor\scripts\detect-jev.mjs
```

可能回傳：

```text
configured_unverified
unavailable
```

只有在你明確需要驗證 Jev Live capability 時才執行：

```powershell
node .agents\skills\codex-route-advisor\scripts\verify-jev.mjs
```

接著執行內附 Advisor smoke test：

```powershell
Get-Content .agents\skills\codex-route-advisor\examples\advisor-mvp.request.json -Raw |
  node .agents\skills\codex-route-advisor\scripts\advise-task.mjs
```

Advisor 啟用且成功時，CLI 會回傳 `state = advised`、已驗證的 Dispatch Plan 與 `trace.runId`。

### 5. 日常使用

一般使用者**不需要手工撰寫**本 README 後面示範的 bridge JSON；正常情況是直接以自然語言要求 Agent 使用 Skill，例如：

```text
請實作登入 API 與 focused tests。依每個 Bounded Task 選擇適合的模型，
先顯示 Dispatch Plan；只有驗證失敗時才進一步診斷。
```

在預設 `executionMode = confirm` 下，預期流程為：

```text
使用者需求
→ Advisor 建立 Bounded Tasks
→ Jev 或 Agent 逐 task assessment
→ Advisor 建議 model / effort / tools
→ 顯示 Dispatch Plan
→ 使用者確認
→ Coordinator 執行／委派
```

正式 Skill 指令：

```text
$codex-route-advisor init
$codex-route-advisor config
$codex-route-advisor status
$codex-route-advisor reset workspace
$codex-route-advisor verify
$codex-route-advisor plan <task>
```

這些是由 Coordinator 處理的 Skill invocation commands，不是另一套 shell CLI；完整語意與安全規則請見 `references/commands.md`。

常用控制：

```text
暫時完全關閉 Advisor           → enabled = false
使用 Advisor，但不使用 Jev     → router.backend = model
優先使用 Jev，失敗時 Agent 回退 → router.backend = auto, router.prefer = jev
只規劃、不執行                 → executionMode = plan
確認後執行                     → executionMode = confirm
允許 Coordinator 直接繼續      → executionMode = auto
禁止向上模型升級               → allowModelEscalation = false（預設）
允許向上模型升級               → allowModelEscalation = true
```

完整設定契約請參考 `references/configuration.md`；安裝、初始化、更新與移除流程請參考 `references/operations.md`。

## 產品邊界（Product Boundary）

本 Skill 是**顧問（Advisor）**，不是執行期路由器（runtime Router）。

它負責：

- 只在能力、推理深度、主要工具、相依順序、驗證方式或風險確實形成獨立路由邊界時，才建立新的有界任務（Bounded Task）；
- 為不同有界任務（Bounded Task）建議不同路由配置；
- 保留循序、平行與條件式執行關係；
- 將 Jev 作為可選的逐任務評估後端，並正式支援代理回退（Agent fallback）；
- 輸出已驗證的派送計畫（Dispatch Plan）與受限的執行追蹤（execution trace）。

它**不負責** Provider routing、Model Picker 控制、Proxy / gateway transport、host interception，也不自行做 runtime model switching。

Worker 建立、工具呼叫、重試、整合、執行期安全檢查與最終驗證，仍由協調器（Coordinator）負責。

## 動態模型偵測（Dynamic Model Discovery）

Codex Route Advisor 可透過 `codex debug models` 讀取目前 Codex host 實際提供的模型清單，因此新模型出現在環境後，不需要先修改 Skill 程式碼，便能立即被模型 Inventory 發現。

模型「可用性」與「路由能力」刻意分離：

- 新偵測到的模型會立即進入 runtime Inventory；
- Host 明確提供的 supported reasoning efforts 會保留在 Inventory；
- exact-id capability registry 只負責 Advisor policy 的 family 與 routing tiers；
- 若新模型尚無 capability metadata，仍會顯示為 `unclassified`，但 `routable = false`；
- 後續補上 capability metadata 後，可直接重新分類既有 cache 中的模型，不必再次進行 discovery request。

因此 Advisor 能隨 Codex host 的模型供應變化而調整，同時不會從模型名稱猜測能力，也不會把所有剛出現的新模型直接視為可安全自動路由。

## 可執行顧問流程（Executable Advisor Pipeline）

主要入口：

```text
scripts/advise-task.mjs
```

一般使用者仍以自然語言呼叫 Skill。包含 `boundedTasks`、`assessments` 等欄位的 JSON，是 Agent 與 deterministic script 之間的橋接契約（bridge contract），不是要求使用者手工填寫的表單。

```text
標準化需求
→ 有界任務（Bounded Task）圖驗證
→ Jev／代理回退（Agent fallback）路由
→ 模型／推理強度解析
→ 派送計畫（Dispatch Plan）
→ deterministic validation
```

如果沒有提供語意拆解（semantic decomposition），整個需求會保守維持為單一任務。真正的語意拆解由 Agent 依 `references/bounded-task-decomposition.md` 完成；script 不會使用關鍵字 heuristics 假裝理解任務語意。

## 有界任務規則（Bounded Task Rules）

有界任務（Bounded Task）是「最小需要獨立路由決策的工作單位」。

只有當子任務至少在下列一個面向有實質差異時才拆分：

- 所需能力（capability）；
- 推理深度（reasoning depth）；
- 主要工具集合（primary tool set）；
- 相依順序（dependency ordering）；
- 驗證方式（validation method）；
- 風險／影響範圍（risk / blast radius）。

當預期子步驟共用相同路由配置、工具、本地脈絡、驗證循環與相依關卡時，就應停止拆分。

常見情境：

```text
實作 X
→ 執行 X 的 focused test
→ 只有 focused test 失敗時才診斷根因
```

優先拆成：

```text
T1 實作 X + 執行 focused test
T2 診斷失敗根因 — depends on T1，且只有 T1 失敗時執行
```

**不要只是為了建立條件式關卡，就把實作與同一驗證循環內的 focused test 拆成兩個有界任務（Bounded Task）。** 真正的新路由邊界，是失敗後的根因診斷，而不是 focused verification 本身。

## 平行規劃（Parallel Planning）

完成拆解後，Agent 必須做一次明確的平行安全檢查（parallel-safety pass）。

同一相依前緣（dependency frontier）上的任務，若同時滿足以下條件，應明確列入 `parallelGroups`：

- 任務之間沒有相依關係；
- 修改不同的 mutable implementation surface；
- 共用的介面或測試契約已固定；
- 各自具有獨立驗收條件。

不要只在文字理由中說明「彼此獨立」，卻漏掉安全且可執行的 `parallelGroups`。

執行時，協調器（Coordinator）仍需做最後一次 mutable-state safety check。如果 host 支援 sub-agent delegation，且沒有發現新的衝突，就應並行委派已宣告群組的成員。若決定不使用某個平行群組，應記錄具體衝突或 host capability 限制。

## 路由分類（Routing Taxonomy）

| 分類（Tier） | 預設配置 | 典型用途 |
| --- | --- | --- |
| Fast | `gpt-6-luna / high` | 明確、局部、低歧義的實作或 deterministic verification |
| Balanced | `gpt-6.1-sol / medium` | 一般工程判斷與有限設計選擇 |
| Strong | `gpt-6.1-sol / xhigh` | 未知根因、competing hypotheses、深度診斷 |
| Long | `gpt-6-astra / medium` | 廣上下文重構、migration、rollout、跨系統長程推理 |

某一個困難子任務，不會自動把其他 sibling tasks 一起升級。`long` 也不是 `strong` 的一般升級版。

## Jev 與代理回退（Agent Fallback）

Jev 是可選能力，而且只在有界任務（Bounded Task）已形成之後，負責逐任務路由評估。當 effective Router 偏好 Jev 時，Advisor 會自動對每個 task 呼叫 production Jev assessment adapter；呼叫端不需要預先注入 Jev decision。

使用 Jev 的主要價值不是讓 Advisor「才有能力 routing」，而是把 routing judgment 交給專門且獨立的 assessment backend：

- **專門化 routing judgment**：Jev 專注判斷每個 Bounded Task 應落在哪個 capability tier，而不是讓執行任務的 Agent 同時兼任 Router。
- **降低 self-routing coupling**：routing assessment 與執行 Agent 分離，避免同一個 Agent 同時扮演工作執行者與資源分配判斷者。
- **提高 policy 一致性**：不同 Coordinator / Agent 可以把 Jev assessment 正規化到同一套 shared routing policy 與 Dispatch Plan contract。
- **不是硬依賴**：沒有 Jev credential、Jev 呼叫失敗或 confidence 太低時，Agent 仍使用相同 rubric fallback；Advisor 功能不因此中斷。

這些是架構與責任分離上的優點，不代表對所有任務都保證比 Agent fallback 更高的實際判斷準確率。

```text
Jev 高信心
→ Jev assessment
→ 共用 routing policy
→ recommendation

Jev unavailable / failed / low confidence
→ 代理回退（Agent fallback）assessment
→ 同一套 routing policy
→ recommendation
```

對外的派送計畫（Dispatch Plan）會暴露 assessment source；若發生 fallback，也會保存原因：

```text
assessment.source = jev | agent
assessment.fallback = { from: "jev", reason }   # 只有 Jev 嘗試後 fallback 才出現
```

正常使用顧問（Advisor）不要求 Jev credential。

## Agent 對 script 的輸入正規化（Authoring Normalization）

Bridge 接受少量 shorthand，以降低 Agent 因型別細節造成不必要的 schema retry：

- top-level `context: "text"` → `{ "summary": "text" }`；
- top-level `constraints: "text"` → `{ "summary": "text" }`；
- `boundedTasks[i].context: "text"` → `{ "summary": "text" }`；
- `boundedTasks[i].acceptance: "criterion"` → `["criterion"]`。

輸出的派送計畫（Dispatch Plan）仍維持 canonical contract：

- task `context` 必須是 object；
- task `acceptance` 必須是 non-empty string array。

其他 graph、conditional、dependency 與 routing assessment 錯誤仍採嚴格驗證，不做泛化 coercion。

## 範例（Example）

執行 repository 內附的 mixed-tier fixture：

```powershell
Get-Content skill\examples\advisor-mvp.request.json -Raw |
  node skill\scripts\advise-task.mjs
```

也可以直接送出最小 request：

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

主要輸出為 `plan`：

```text
version
taskSummary
executionMode
assessmentMode
executionOrder
parallelGroups
tasks[]
```

每個 plan task 都包含標準化的有界任務（Bounded Task）契約，以及 assessment、recommendation、tools 與 rationale。

## Advisor 開關與三種使用模式

`enabled` 是整個 Codex Route Advisor 的總開關，預設為 `true`。

```text
Advisor disabled
→ enabled: false
→ 完全 bypass Advisor
→ 不做 decomposition / assessment / recommendation / Dispatch Plan / trace

Advisor with Agent assessment
→ enabled: true
→ router.backend: model
→ Advisor 正常作用，但不使用 Jev

Advisor with Jev-assisted assessment
→ enabled: true
→ router.backend: auto（prefer: jev）或 jev
→ 優先使用 Jev；不可用、失敗或低信心時 fallback 到 Agent
```

`enabled: false` 與 `executionMode: plan` 不同：`plan` 仍會執行完整 Advisor pipeline，只是在產生 Dispatch Plan 後停止；`enabled: false` 則是在 pipeline 進入 decomposition 前直接 bypass。

完整設定、scope precedence 與 config path 請參考 `references/configuration.md`。

## 執行模式（Execution Mode）

`executionMode` 決定協調器（Coordinator）收到派送計畫（Dispatch Plan）後如何繼續。

| 模式 | 協調器（Coordinator）行為 |
| --- | --- |
| `plan` | 顯示派送計畫（Dispatch Plan）後停止，不執行 |
| `confirm` | 顯示派送計畫（Dispatch Plan），取得使用者明確同意後才執行；預設值 |
| `auto` | 顯示簡短計畫後直接進入協調器（Coordinator）執行／委派 |

設定優先順序（preference precedence）：

```text
Session > Workspace > Global > Skill default (confirm)
```

只套用目前 Session：

```json
{
  "scope": "session",
  "executionMode": "plan"
}
```

持久化到 Workspace：

```json
{
  "scope": "workspace",
  "executionMode": "auto"
}
```

顧問（Advisor）script 本身仍不執行 worker。

## 協調器委派忠實度（Coordinator Delegation Fidelity）

協調器（Coordinator）一旦決定把 plan task 委派給 sub-agent，就必須把該 task 的 routing recommendation 視為執行要求，而不是只用來顯示的 metadata。

1. 若 `recommendation.model` 已是 host 支援的 concrete model id，直接使用。
2. 若只是 `luna`、`sol`、`astra` 這類抽象 model family token，先解析成目前 host 接受的 concrete model id。
3. 呼叫 `spawn_agent` 時必須明確傳入：
   - `model=<resolved concrete model id>`；
   - `reasoning_effort=<recommendation.effort>`；
   - 預設 `fork_turns="none"`，只有真的需要有限 parent context 時才使用有限正整數 turn count。
4. 若 host 對 full-history fork 會繼承 parent profile，就不得用 `fork_turns="all"` 來執行具有 model / effort allocation 的 task。
5. 非 full-history worker 的 message 必須自包含足夠的有界任務（Bounded Task）脈絡，不能依賴完整 parent conversation。
6. 若建議配置無法執行，必須記錄 delegation fallback 或不可驗證原因；不得靜默繼承 parent profile，卻宣稱已忠實執行 recommendation。

## 執行追蹤（Execution Trace）

Advisor CLI 會在以下位置建立受限的執行追蹤（execution trace）：

```text
<workspace>/.codex/codex-route-advisor/runs/<run-id>/
├─ run.json
├─ dispatch-plan.json
└─ events.jsonl
```

協調器（Coordinator）在 delegation / execution 過程沿用同一個 `runId` 記錄 lifecycle events。

保留政策（retention policy）：

- 單一 `events.jsonl` 最大 5 MiB；
- 所有 runs 總量最大 100 MiB，超限時由最舊資料開始清理到 80 MiB；
- 保留 14 天；
- 單一 run 超限時，`run.json.traceStatus` 會變成 `truncated`，critical lifecycle events 仍保留，並以 `droppedEventCount` 記錄省略數量。

本開發 repository 會忽略自己的 runtime trace。Skill 安裝到其他 workspace 後，**不得**只是為了隱藏 `.codex/` 就自動修改 consumer repository 的 `.gitignore`、Git exclude 或其他 VCS 設定。若 consumer workspace 尚未忽略它，可以維持 untracked runtime state；只有使用者明確要求時才修改 ignore 規則。

## 執行期證據邊界（Runtime Evidence Boundary）

Recommendation 代表路由意圖（routing intent），不代表 runtime 已證實使用該配置。

- `requestedModel / requestedEffort` 可以來自派送計畫（Dispatch Plan）；
- `actualModel / actualEffort / workerId` 只能在 host/runtime 提供可驗證證據時記錄；
- 不得把 requested 值直接複製成 actual 值，藉此暗示成功 dispatch。

Release acceptance 目前使用 Codex host rollout 的 `turn_context` 驗證 per-worker model / effort。這屬於 **host-observed runtime evidence**，不是獨立的 provider-response metadata。若無法驗證實際 evidence，就必須 fail closed，不得推測 actual values。

## 混合配置範例（Mixed-tier Example）

同一個 request 可以合理產生：

```text
T1 實作局部修改 + focused test → Fast / gpt-6-luna / high
T2 診斷失敗根因                  → Strong / gpt-6.1-sol / xhigh
                                     only if T1 fails
```

若是不同 implementation surfaces 的獨立工作，也可以：

```text
T1 實作 helper A → Fast / gpt-6-luna / high
T2 實作 helper B → Fast / gpt-6-luna / high   （與 T1 平行）
T3 整合 A + B    → Fast / gpt-6-luna / high   （depends on T1, T2）
```

## 核心 scripts（Core Scripts）

Advisor v1 正式支援的 runtime surface：

- `scripts/advise-task.mjs` — 可執行的顧問（Advisor）pipeline；
- `scripts/decompose-task.mjs` — 有界任務（Bounded Task）正規化與 graph checks；
- `scripts/validate-dispatch-plan.mjs` — deterministic 派送計畫（Dispatch Plan）validator；
- `scripts/routing.mjs` — Jev／代理回退（Agent fallback）routing primitive；
- `scripts/resolver.mjs` — 模型／推理強度解析；
- `scripts/configure.mjs` — preference configuration；
- `scripts/detect-jev.mjs` / `verify-jev.mjs` — Jev capability lifecycle；
- `scripts/model-catalog.mjs` / `model-discovery.mjs` — runtime model facts；
- `scripts/trace.mjs` — 執行追蹤（execution trace）、truncation 與 retention。

名稱為 `spike-*` 的檔案屬於歷史／實驗證據，不是 Advisor v1 正式支援的 runtime surface。

## 安裝（Install）

將 `skill/` 目錄內容安裝為 Skill root：

```text
<workspace>/.agents/skills/codex-route-advisor/
├─ SKILL.md
├─ scripts/
├─ references/
└─ examples/
```

Skill root 必須包含 `SKILL.md`、`scripts/`、`references/`。

安裝後可執行 smoke test：

```powershell
Get-Content .agents\skills\codex-route-advisor\examples\advisor-mvp.request.json -Raw |
  node .agents\skills\codex-route-advisor\scripts\advise-task.mjs
```

成功時 CLI 會回傳 `state = advised`、已驗證的派送計畫（Dispatch Plan）與 `trace.runId`。

## 驗證（Validation）

開發用 regression suite 維護於 repository-level `tests/`，刻意不包含在公開 Skill distribution 內。

## v1 目前限制（Current v1 Limitations）

Advisor v1 刻意維持明確且狹窄的產品邊界：

- 一次主要拆解（primary decomposition pass），不做 recursive decomposition；
- Jev 不負責決定 task graph；
- 不提供 persistent task/project-management layer；
- 不提供 provider-level routing transport 或 proxy；
- 不保證所有 host 都暴露 per-worker model / effort override 或可驗證的 runtime metadata；
- 當協調器（Coordinator）能力不可用時，execution 必須退化到目前 Agent 真正能執行的形式，或明確回報 capability gap。

## 授權（License）

MIT — 請參考 repository 根目錄的 `LICENSE`。
