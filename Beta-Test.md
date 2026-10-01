# Codex Route Advisor — Beta Test Guide

感謝協助測試 **Codex Route Advisor**。

這一輪 Beta 想驗證的重點很簡單：

> 一位已經在使用 Codex 的開發者，是否能自行安裝這個 Skill，直接拿自己的開發任務來用，並理解 Advisor 給出的 Bounded Task 與 Dispatch Plan。

不需要額外安裝程式，也不需要執行任何安裝 Script。

---

## 1. 安裝 Skill

解壓你收到的 Beta 套件後，會看到：

```text
codex-route-advisor/
├─ README.md
├─ README.zh-TW.md
├─ Beta-Test.md
├─ LICENSE
└─ skill/
   ├─ SKILL.md
   ├─ scripts/
   ├─ references/
   └─ examples/
```

### 建議：先安裝在單一 Project

把：

```text
codex-route-advisor/skill/
```

的內容複製到你的 Project Skill 目錄：

```text
<project>/.agents/skills/codex-route-advisor/
```

完成後應為：

```text
<project>/.agents/skills/codex-route-advisor/SKILL.md
```

這是本輪 Beta **最建議的安裝方式**，因為只影響目前測試 Project，也比較容易移除或重測。

### Global Skill

如果你的 Codex 環境本來就支援 Global Skills，也可以把同一份：

```text
codex-route-advisor/skill/
```

內容安裝到該環境使用的 `codex-route-advisor` Global Skill 目錄。

例如在 Windows 環境，常見的使用者層級位置是：

```text
C:\Users\<username>\.agents\skills\codex-route-advisor\
```

也可以寫成：

```text
%USERPROFILE%\.agents\skills\codex-route-advisor\
```

不同 Codex host / client 的 Global Skill discovery path 可能不同，因此以上 Windows 路徑只作為常見範例；若你的環境使用其他 Global Skills 目錄，請以該環境實際設定為準。若不確定，建議先使用上面的 Project 安裝方式。

> Skill 正式名稱是 `codex-route-advisor`。請保留這個資料夾名稱，不要改成 `codex-advisor-skill`。

---

## 2. 第一次使用

安裝前後都可直接從套件根目錄閱讀：

- 繁體中文：`README.zh-TW.md`
- English：`README.md`

README 屬於 distribution 文件，不需要複製進 Skill root。

請依 README 的 **Quick Start / 快速開始** 操作。

你不需要手工撰寫任何 Advisor JSON，也不需要直接呼叫內部 bridge contract。

正常情況下，直接像平常使用 Codex 一樣描述你的開發需求即可。

例如：

```text
請幫我實作登入 API、補 focused tests，
並在驗證失敗時再進一步診斷。
```

Advisor 預期會：

```text
你的需求
→ 拆成必要的 Bounded Tasks
→ 評估每個 task 需要的能力
→ 建議 model / reasoning effort / tools
→ 產生 Dispatch Plan
→ 交給目前的 Coordinator 執行或委派
```

---

## 3. 建議至少測這三種情境

### A. 一般 Advisor 使用

先用預設設定即可。

建議直接拿一個你自己原本就會交給 Codex 的真實 coding task 測試，而不是只跑 README 範例。

請觀察：

- Bounded Task 拆解是否合理；
- 是否拆得太細或太粗；
- model / reasoning effort 建議是否合理；
- Dispatch Plan 是否容易理解；
- Coordinator 是否真的依建議執行或委派。

### B. 不使用 Jev

如果你想確認沒有 Jev 時是否仍能正常工作，可使用：

```text
enabled = true
router.backend = model
```

此時 Advisor 仍然完整運作，只是 routing assessment 改由 Agent 完成。

### C. 完全停用 Advisor

設定：

```text
enabled = false
```

預期：

```text
不做 Bounded Task decomposition
不做 Jev / Agent routing assessment
不產生 Dispatch Plan
不建立 Advisor execution trace
回到原本 host / Coordinator 的處理方式
```

如果你已經有 Jev，也歡迎另外測試 Jev-assisted mode；README 中有完整設定方式。

---

## 4. Beta 最希望收到的回饋

除了 bug，我們更想知道實際使用體驗。

特別是：

- README 是否足以讓你自己完成安裝？
- 有沒有哪一步必須問作者才知道怎麼做？
- Bounded Task 是否符合你平常拆工作的方式？
- routing recommendation 是否合理？
- Dispatch Plan 對你的 Codex 工作流有沒有實際幫助？
- Jev 的角色是否容易理解？
- 有沒有覺得 Advisor 反而增加不必要的流程？

即使只是：

> 「我看到這裡不知道下一步要做什麼。」

也非常有價值。

---

## 5. 建議回報格式

可以直接用下面格式回報：

```text
【環境】
OS：
Codex 使用方式：
Node.js version：
是否使用 Jev：

【測試任務】
原始 Prompt：

【Advisor 結果】
Bounded Task 拆解：
Dispatch Plan：
實際執行結果：

【問題】
哪一步出現問題：
預期行為：
實際行為：
是否可以重現：

【使用感受】
拆解是否合理：
routing recommendation 是否合理：
Dispatch Plan 是否有幫助：
最不容易理解的地方：
```

若方便，也可以附上已移除敏感資訊的：

- Dispatch Plan；
- error message；
- CLI output；
- screenshot；
- execution trace 片段。

---

## 6. 請不要提供敏感資料

回報問題時，請不要提供：

- API key；
- password / token；
- 公司內部 secrets；
- 未公開原始碼；
- 客戶資料；
- 其他私人或機密資訊。

如果問題發生在私人專案，請盡量使用去識別化內容或最小重現案例。

---

## 7. Beta 階段已知邊界

目前 Codex Route Advisor v1：

- 是 planning / model-allocation **Advisor**，不是 runtime Router；
- 不自行控制 Provider / Model Picker / Proxy；
- 不自行攔截 runtime request；
- Jev 是 optional routing-assessment backend；
- 沒有 Jev 時仍可使用 Agent fallback；
- Jev 不負責 Bounded Task decomposition；
- 實際 model / effort 是否被 host 採用，仍取決於 Coordinator / host capability。

這一輪 Beta 的目的不是要求你配合 Advisor，而是確認：

> **Advisor 能不能自然地融入你原本的 Codex 開發工作流。**
