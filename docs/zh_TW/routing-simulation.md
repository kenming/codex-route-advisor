# 配置模擬與 Token 預算

[README](../../README.zh-TW.md) | [English](../en/routing-simulation.md)

**以下是人工設定預算的示意情境，非實測、benchmark 或節省承諾。** 模型配置與 Token 預算分別列示：換用較小模型不代表 Token 自動減少。這個例子展示如何比較方案，不是 Advisor 已內建的 Token 估算功能。

## 模擬條件與提示詞

假設 Coordinator 為 `gpt-6-astra / medium`，`enabled=true`、`executionMode=plan`、`allowModelEscalation=false`。本次 Session 將 Fast effort 明確覆寫為 `max`；Skill default 仍為 Luna / High。假設 Host 提供所有列示模型與 effort，且可對 Worker 採用推薦配置。這些是模擬前提，不是目前 Host 的 discovery 或執行證據。

```text
使用 codex-route-advisor 做配置模擬，只產生計畫，不執行。
模擬 Coordinator 為 gpt-6-astra / medium；不變更實際 Host picker。
本次 Session 使用 enabled=true、executionMode=plan、
allowModelEscalation=false；Fast profile effort 覆寫為 max。
其餘 profiles 使用 Skill defaults，不持久化設定。

在既有產品系統新增搜尋功能：
1. 定義搜尋 API 契約、實作 API，並完成 focused tests。
2. 依固定 API 契約實作搜尋介面與 focused tests。
3. 依固定 API 契約更新 API 使用文件與範例。
4. 整合跨服務驗證，規劃分批上線、監控與回復程序。

產生 Bounded Tasks、相依關係與 per-task model / effort 建議。
把模擬建議與實際執行證據分開；不啟動 Worker、不呼叫 Jev、
不寫設定或 execution trace。
```

這是文件模擬，不是把未知 Host facts 當作實際 `coordinatorProfile` 傳入執行流程。實際使用請讓 Host 取得目前 model / effort、model availability 與 supported efforts；不支援 Luna / Max 時應回報並調整配置，不能宣稱已派送。

## 配置與依賴示例

| Task | 工作／驗收 | Tier | 模擬推薦 model / effort | 依賴 |
| --- | --- | --- | --- | --- |
| T1 | 固定搜尋 API 契約、完成 API 與 focused tests | balanced | `gpt-6.1-sol / medium` | 無 |
| T2 | 依契約完成搜尋介面與 focused tests | balanced | `gpt-6.1-sol / medium` | T1 |
| T3 | 完成 API 使用文件，範例符合契約 | fast | `gpt-6-luna / max` | T1 |
| T4 | 跨服務驗證與分批上線／回復計畫，含監控和驗收條件 | long | `gpt-6-astra / medium` | T2、T3 |

T2 與 T3 修改不同檔案、共用契約已固定且可獨立驗收，故為候選 parallel group。各實作與自身 focused test 維持同一 bounded task。以上是合理的手工示例，並非實際執行 `advise-task.mjs` 的輸出；真正建議依需求、rubric 與有效設定而定。

## 預算比較

單位：k tokens，即 1,000 tokens。兩個方案假設相同起始 repository、任務範圍與驗收品質。Baseline 全程使用 Astra / Medium；混合方案保留 Astra 作 Coordinator 與長程規劃，其餘配置如上。

![假設預算：純 Astra 為 100k，混合配置含協調開銷為 85k；非實測](../assets/routing-simulation.zh-TW.svg)

| 方案／項目 | model / effort | 輸入 | 輸出（含 reasoning） | 合計 |
| --- | --- | ---: | ---: | ---: |
| Baseline：全部工作，含原生規劃與驗證 | Astra / Medium | 60 | 40 | **100** |
| 混合 T1 | Sol / Medium | 7 | 5 | 12 |
| 混合 T2 | Sol / Medium | 5 | 3 | 8 |
| 混合 T3 | Luna / Max | 12 | 8 | 20 |
| 混合 T4 | Astra / Medium | 20 | 15 | 35 |
| 混合協調開銷：Advisor 規劃、交接、整合與最終驗證 | Astra / Medium | 6 | 4 | 10 |
| **混合合計** | — | **50** | **35** | **85** |

這些數字是為示意計算而手工設定的預算，沒有套用任何 model / effort 的固定節省係數。圖中灰色協調區塊仍使用 Astra；混合方案的 Astra 總額為 35 + 10 = 45k，不能將「Astra 用量減少 55%」誤當「總 Token 減少 55%」。

```text
混合總額 = Sol 20k + Luna 20k + Astra 工作 35k + Astra 協調 10k = 85k
總 Token 差異 = 1 − 混合總額 / Baseline 總額
             = 1 − 85 / 100 = 15%（僅本假設）
```

輸入包含重複送入的上下文與 tool results，輸出包含 reasoning；cached input 仍是輸入 Token，只是費用可能不同。API 的 reasoning tokens 已包含在 `output_tokens`，不能再次加總。[OpenAI reasoning usage 說明](https://developers.openai.com/api/docs/guides/reasoning)。

## 開銷敏感度與限制

固定混合工作預算 75k，只變動協調、重複上下文或重試開銷，結果就可能不同。下表仍是假設情境，不是統計信賴區間。

| 協調／重試開銷 | 混合總額 | 相對 Baseline 100k |
| ---: | ---: | --- |
| 10k | 85k | 減少 15% |
| 25k | 100k | 無節省 |
| 40k | 115k | 增加 15% |

實際工作 Token 也會隨模型、effort、上下文及重試改變，因此不能僅由 Dispatch Plan 得出可靠節省比例。Token 差異不等於費用或訂閱額度差異；本文沒有假設 API 單價，也沒有推算 Codex 訂閱配額。

要改成實測比較，對相同起始 repository 與驗收條件分別執行兩方案，收集所有 Coordinator / Worker / assessment 呼叫的 input / output usage（包含失敗與重試）、實際 model / effort 及品質結果。缺少完整 usage 時維持「估算」，不要以任務數或推薦配置代替實際 Token。此範例採 Agent assessment，不包含 Jev 呼叫；實測若使用 Jev，須另列其用量與成本。
