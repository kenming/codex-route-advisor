# Operations

## Install

將發佈的 Skill 目錄複製到：

```text
<workspace>/.agents/skills/codex-route-advisor/
```

目錄至少包含：

```text
SKILL.md
scripts/
references/
```

## Invocation commands

Skill-level command contract：

```text
$codex-route-advisor init
$codex-route-advisor config [changes]
$codex-route-advisor status
$codex-route-advisor reset [workspace|global]
$codex-route-advisor verify [jev-live]
$codex-route-advisor plan <task>
```

這些 command 由 Coordinator 依 `commands.md` 映射到既有 scripts / workflow，不代表另外提供 shell executable。沒有 command 時使用一般 Advisor workflow。

## Initialize

`$codex-route-advisor init` 由 Skill 依序：

1. `configure.mjs` inspect 既有設定。
2. `detect-jev.mjs` 偵測 Jev capability。
3. 取得 runtime model facts。
4. 完成 Router / profiles / scope 對話。
5. 明確詢問：`Allow model escalation beyond the currently selected host model?`，預設選 `No`，對應 `allowModelEscalation=false`。
6. `configure.mjs` 寫入 Workspace 或 Global，或回傳 Session override。

初始化不應自動產生 Jev live API call。若已有 persisted config，`init` 視為 guided update，不先隱含 reset。

## Config / status

`$codex-route-advisor config` 無參數時 inspect effective config；有變更要求時維持 `configure.mjs` patch semantics。

`$codex-route-advisor status` 為 read-only：整合 config presence/effective values、Jev credential detection、model inventory/cache、Model Compatibility Report，以及 Host 可驗證時的 Coordinator profile。Compatibility 必須分組顯示 `classified / unclassified / unavailable`；不得寫設定、自動分類 model、更新 defaults 或進行 Jev live call。

## Reset

`$codex-route-advisor reset` 是 destructive lifecycle operation。刪除 Workspace / Global persisted config 前必須取得明確確認；未指定 scope 時最多預設為 Workspace，且仍需讓使用者確認。不得默認 `reset all`。

Config reset 不連帶刪除 model cache、execution traces 或其他 state；只有使用者明確要求時才一併處理。

## Verify Jev

`$codex-route-advisor verify` 預設只做 local/non-destructive verification。Model Compatibility Report 中的 available + `unclassified` model 只產生 `model_unclassified` warning，不使 local verification 失敗，也不得因此自動新增 policy、更新 defaults 或修改 persisted config。只有使用者明確要求 `$codex-route-advisor verify jev-live` 或等價語意時執行：

```text
node scripts/verify-jev.mjs
```

Live verification 不得靜默修改 Router preference。

## Plan command

`$codex-route-advisor plan <task>` 將 `<task>` 視為一般開發需求，但以 Session override 強制 `executionMode=plan`。仍執行 decomposition、assessment、model allocation、Dispatch Plan validation 與 trace；到 planning boundary 即停止，不執行 worker 或 implementation change，也不把 `plan` 持久化到 Workspace / Global config。

## Update

更新 Skill package 時：

- 替換 `<workspace>/.agents/skills/codex-route-advisor/` 內容；
- 不因更新而刪除 Workspace / Global config；
- 不因更新而刪除 model cache。

## Configuration state

Workspace：

```text
<workspace>/.codex/codex-route-advisor/config.json
```

Global：

```text
Windows  %LOCALAPPDATA%\codex-route-advisor\config.json
macOS    ~/Library/Application Support/codex-route-advisor/config.json
Linux    $XDG_CONFIG_HOME/codex-route-advisor/config.json
         or ~/.config/codex-route-advisor/config.json
```

## Model cache

依 `model-catalog.md` 的平台路徑。

Cache 與 config 是獨立 state。

## Uninstall

移除：

```text
<workspace>/.agents/skills/codex-route-advisor/
```

不自動刪除 config / cache。

若使用者明確要求 reset，再分別刪除 Workspace / Global config 或 model cache。

## Development validation

Repository 中執行：

```text
node --check skill/scripts/*.mjs
node --test skill/tests/*.test.mjs
git diff --check
```

Stage 1 acceptance 還應驗證：

- Jev configured / unavailable；
- Model Router fallback；
- low-confidence clarification；
- explicit override；
- Workspace / Global / Session precedence；
- `dispatchStatus = not_dispatched`。
