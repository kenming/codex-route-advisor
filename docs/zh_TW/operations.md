# 操作與排錯

[README](../../README.zh-TW.md) | [設定說明](configuration.md) | [English](../en/operations.md)

## 指令流程

以下是 Codex 對話中的 Skill commands，不是 shell CLI。

| 指令 | 行為與邊界 |
| --- | --- |
| `$codex-route-advisor init` | 檢查設定、credential 與可取得的 model facts，顯示現況，再問未決選項；明確選定 scope 才寫入。重跑保留未指定欄位；儲存前取消不寫檔。 |
| `$codex-route-advisor config` | 顯示有效值及來源；附變更要求時 patch 指定 scope，保留其他欄位。 |
| `$codex-route-advisor status` | 唯讀顯示 config、Jev 與模型相容性，不修改偏好、不呼叫 Jev live API。 |
| `$codex-route-advisor reset workspace` | 確認後只移除 Workspace config；Global、cache 與 traces 保留。`reset global` 同理。省略 scope 需確認 Workspace 解讀，不默認 all。 |
| `$codex-route-advisor verify` | 本機檢查 Skill 檔案、設定、model facts 與 credential；不自動做 Jev live probe。 |
| `$codex-route-advisor verify jev-live` | 明確要求 live probe；不修改 Router 或 persisted config。 |
| `$codex-route-advisor plan <任務>` | Session-only `executionMode=plan`；拆解、assessment、計畫驗證與 trace 完成後停止，不執行 workers 或修改實作檔。 |

`init` 首次向上調度預設 No；重跑保留既有選擇。已明確提供的欄位與 scope 不應重問。未知指令應顯示支援項目，不能猜成 destructive operation。

## 日常執行

描述任務與驗收條件即可，不需手寫 bridge JSON。局部實作與其 focused test 通常是一個 bounded task；只有失敗才進行的根因診斷屬獨立條件式任務。

`parallelGroups` 是並行候選。Coordinator 執行前仍需檢查共享 mutable state；Host 不支援 delegation 或有新衝突時，應說明改用 sequential / local execution 的理由。

模型配置見 [README](../../README.zh-TW.md#模型配置與執行行為)。執行時用 effective profile，不可改回被上限阻擋的 preferred profile；無法執行指定 worker 時記錄 fallback，不宣稱已遵循推薦。需要說明時可要求：

```text
請 explain 這份 Dispatch Plan：說明拆解邊界、assessment source、fallback 原因、
模型選擇、相依關係與停止拆解的理由。
```

## Jev 啟用與驗證

1. 在執行 Codex 的實際環境提供 `TYPESAFE_API_KEY`，不要放進 config 或 prompt。Windows App 與 WSL／CLI 不一定共用環境；credential 必須能被執行腳本的程序讀到。
2. 以 `init` 選 Jev-assisted，並選擇套用 scope。
3. 若要確認 API，明確執行 `$codex-route-advisor verify jev-live`。
4. 再以真實任務確認 production assessment。probe 成功只證明 live capability，不等同每個 task 都完成 Jev assessment。

| 狀態／事件 | 意義 |
| --- | --- |
| `configured_unverified` | credential 存在，尚未證明 live API 成功 |
| `unavailable / missing_api_key` | 當前程序沒有 credential；仍可使用 Agent |
| `assessment.source=jev` | 該 task 採用 Jev assessment |
| `assessment.source=agent`、有 `fallback` | Jev 嘗試後回退；查看 `fallback.reason` |

Jev 在 bounded tasks 形成後逐 task 評估，不負責拆解。預設 confidence threshold 為 `0.75`；不可用、失敗或低信心時走相同 rubric 的 Agent fallback；Agent 仍低信心時要求澄清，不自動升級 tier。選 Agent-only 不呼叫 Jev。

## 更新、重設與移除

- **更新**：替換安裝目錄的 `skill/` 內容，保留 Project／Global config 與 cache；取得新套件即可閱讀新版 README／docs。
- **重設**：用 `reset workspace` 或 `reset global`，確認後移除該 scope 的 config，不刪 cache／traces。
- **移除**：刪除安裝的 Skill 目錄；config／cache 留存，需另行明確選擇清除。

Skill 變更通常自動偵測；若選單未更新，重啟 Codex App，再在原 Project 開啟新對話。參考[官方 Skills 文件](https://learn.chatgpt.com/docs/build-skills)。

## 常見問題

| 現象 | 檢查方式 |
| --- | --- |
| 找不到 Skill | 確認 `<project>/.agents/skills/codex-route-advisor/SKILL.md` 與 scripts／references 存在，對話使用正確 Project；必要時重啟。 |
| init 只說等待設定 | 正常應顯示可回答的下一題；更新至修正版，裸 init 重測並記錄回覆。 |
| 修改設定沒有作用 | 用 config 看來源；Session > Workspace > Global。另開新對話可排除舊 Session。 |
| enabled=false 卻期待看到計畫 | 這會完整 bypass；只想規劃請保持 enabled=true，選 plan。 |
| Jev missing_api_key | 檢查實際程序的環境；不要貼出 key。可暫用 Agent-only。 |
| 新模型 unclassified | Host 可用但尚無 exact-id policy；status 顯示、verify warning，不自動 routing 或取代 defaults。 |
| availability／effort 無法確認 | 檢查 Host inventory／cache；缺少 facts 不能宣稱已驗證，不從模型名稱推測。 |
| 配置模型比預期低 | 看 Coordinator model＋effort 與 escalation policy，比較 preferred / effective；真實 worker 以 Host evidence 確認。 |
| 設定解析失敗 | 檢查 strict JSON、schemaVersion=1 與合法 model／effort；參考設定文件，不覆寫其他正常欄位。 |
| 計畫執行不完整 | 比對依賴、條件 outcome、delegation fallback 與最終驗收；推薦計畫不是完成證據。 |

## Trace 與問題回報

一般 Advisor 計畫產生後，Workspace 保存：

```text
.codex/codex-route-advisor/runs/<run-id>/
├─ run.json             # 執行摘要與 trace 狀態
├─ dispatch-plan.json   # 已驗證計畫
└─ events.jsonl         # Coordinator lifecycle evidence
```

`requestedModel / requestedEffort` 是意圖，`actualModel / actualEffort / workerId` 必須有 Host runtime evidence，不能直接複製。`traceStatus=truncated` 代表資料遭截斷，不能當作完整 trace。

預設 events 檔上限 5 MiB、run storage 上限 100 MiB（超限清到 80 MiB）、保留 14 天。Skill 不自動修改你的 `.gitignore`／exclude；是否忽略 `.codex/` 由你決定。完整格式見 [trace contract](../../skill/references/execution-trace.md)。

回報可使用：

```text
環境：OS / Host 與版本 / Skill 版本 / Coordinator model 與 effort
設定：相關有效值與來源（不含 key）
重現：原始 prompt / 操作步驟
結果：預期行為 / 實際行為 / 是否可重現
證據：去敏感資訊的 Dispatch Plan / runId / events / error
```

不要提供 key、token、公司 secrets、未公開程式碼或私人資料。使用最小去識別化重現即可。開發用人工 checklist 與測試不包含在此套件；日常操作結果可由 maintainer 追加至開發驗證紀錄。
