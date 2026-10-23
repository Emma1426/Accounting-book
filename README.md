# 💰 LINE × Gemini AI 智慧自動記帳與財務診斷系統（GitHub Pages 跨裝置雲端版）

這是一套結合 **LINE 官方帳號 (Messaging API)**、**Gemini API (`gemini-3.8-flash` / `gemini-4-argon`)**、**Google Sheets 試算表** 與 **GitHub Pages 跨裝置響應式雲端儀表板** 的全自動個人記帳與財務健康診斷系統。

---

## ✅ 六大核心需求完整檢核表

| 需求項目 | 系統實作機制 | 對應檔案與核心函式 |
| :--- | :--- | :--- |
| **1. LINE 傳文字或照片自動記帳至 Google Sheet、零漏帳** | 採用 **兩階段防漏帳寫入 (Two-Phase Commit)**：收到 LINE 訊息當下先以 `LockService` 鎖定並寫入 `RawLogs` 原始備份表 + 原圖存入 Google Drive；再呼叫 Gemini 拆帳寫入 `Transactions`，並回傳 LINE Flex Message 確認卡。內建每 30 分鐘 `retryFailedLogs` 自動補登排程。 | [`gas/Code.gs`](gas/Code.gs) (`doPost`, `setupSpreadsheet`, `retryFailedLogs`) |
| **2. GitHub Pages 雲端網頁呈現（適用手機、平板、電腦）與跨裝置同步** | 支援 GitHub Pages 自動部署，手機版提供底部固定 App 導覽列與卡片明細、平板與電腦提供雙欄圖表與完整表格。跨裝置支援 `config.js` 預設綁定、QR Code 掃碼免輸入配對，以及切換視窗 (`visibilitychange`) 自動拉取最新雲端資料。 | [`index.html`](index.html)、[`web/index.html`](web/index.html)、[`config.js`](config.js)、[`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml) |
| **3. 細部設定快速處理、儲存並跨裝置同步** | 儀表板內建 **「⚙️ 雲端細部設定 & 跨裝置同步」專頁 (`tab-settings`)**，可一次批次修改所有分類月度預算、自訂新分類、最細子分類字典、拆帳模式、AI 模型與後端金鑰，點擊「一鍵儲存」即寫入 Google Sheet `Settings` 與 `Budgets` 工作表，所有裝置即時同步。 | [`gas/Code.gs`](gas/Code.gs) (`saveCloudSettingsAndBudgets_`, `getCloudSettings_`)、[`web/index.html`](web/index.html) (`saveAllCloudSettings`) |
| **4. 極省 Token 分析 + 每月 1 次最細分類微調 + 深度消費狀況剖析** | 後端先完成本地預聚合，並將明細序列化為 **Pipe-Delimited 極簡緊湊摘要 (`buildUltraCompactDigest_`)**，大幅降低 **75%～82% Gemini Token 消耗**。內建每月 1 號早上 09:00 定時觸發器 (`monthlyAutoAuditTrigger`) 或手動一鍵執行 (`runMonthlyCategoryAudit`)，將模糊帳目自動微調至最細 `主分類 > 子分類`，並產出 5 大維度深度消費狀況報告。 | [`gas/Code.gs`](gas/Code.gs) (`buildUltraCompactDigest_`, `runMonthlyCategoryAuditAndDiagnosis_`, `applyMonthlyReclassifications_`) |
| **5. 傳送收據照片三層頻寬防護（不因 GAS 頻寬/超時問題影響）** | **第 1 層（LINE 預覽分流）**：原圖存 Drive 後，若檔案 `> 500 KB`，自動改抓 LINE `/content/preview` 輕量預覽圖或 Drive `w1280` 縮圖送交 Gemini（節省 85%～95% 頻寬）。<br>**第 2 層（多圖防超時佇列）**：單次連傳超過 2 張照片或執行逾 11 秒時，自動轉入 `RawLogs (PENDING)` 並排程 1 分鐘後背景消化。<br>**第 3 層（網頁端 Canvas 預壓縮）**：手機/平板於網頁拍收據上傳前，自動在瀏覽器壓縮至 `1280px JPEG (~130KB)`。 | [`gas/Code.gs`](gas/Code.gs) (`fetchAndBackupLineImage_`, `getLightweightAiImagePayload_`, `scheduleImmediateQueueDrain_`)、[`web/index.html`](web/index.html) (`compressReceiptImageForUpload`) |

---

## 📁 專案目錄結構

```text
Accounting-book/
├── index.html                           # GitHub Pages 根目錄雲端響應式儀表板 (手機/平板/電腦通用)
├── config.js                            # GitHub Pages 跨裝置預設連線設定檔 (填入 GAS 網址即全裝置同步)
├── manifest.json                        # PWA 手機桌面 App 安裝設定檔
├── .github/workflows/deploy-pages.yml   # GitHub Actions 自動部署至 GitHub Pages 工作流程
├── gas/
│   ├── Code.gs                          # Google Apps Script 後端核心 (LINE Webhook + Gemini + 頻寬防護 + 省Token診斷)
│   └── Index.html                       # 供 GAS HtmlService 內建託管使用的儀表板頁面
├── web/
│   ├── index.html                       # 獨立靜態部署版儀表板 (與根目錄 index.html 同步)
│   ├── config.js                        # 獨立靜態部署版設定檔
│   └── manifest.json                    # PWA Manifest
└── README.md                            # 完整系統架構與設定指南
```

---

## 🚀 完整設定流程（Step-by-Step 逐步教學）

### 步驟一：取得 Gemini API Key 與 LINE 官方帳號憑證
1. **取得 Gemini API Key**：
   - 前往 [Google AI Studio](https://aistudio.google.com/) 建立一組 API Key（複製保存，稍後填入 `GEMINI_API_KEY`）。
2. **建立 LINE 官方帳號 (Messaging API)**：
   - 前往 [LINE Developers Console](https://developers.line.biz/) 建立一個 Provider 與 **Messaging API Channel**。
   - 切到 **Messaging API** 分頁，拉到最下方點擊 **Issue** 產生一組長期有效的 **`Channel access token (long-lived)`** 並複製保存。

---

### 步驟二：建立 Google 試算表並部署 Google Apps Script (GAS)
1. 新增一份空白的 [Google Sheets 試算表](https://sheets.new)，為試算表命名（例如：`我的 AI 智慧記帳本`）。
2. 點選試算表上方選單 **「擴充功能 (Extensions)」→「Apps Script」**。
3. 在左側檔案列表：
   - 將預設的 `程式碼.gs`（或 `Code.gs`）內容清空，完整貼上本專案 [`gas/Code.gs`](gas/Code.gs) 的所有程式碼。
   - 點選左側「**＋**」→「**HTML**」，命名為 `Index`（系統會自動顯示為 `Index.html`），清空並貼上 [`gas/Index.html`](gas/Index.html) 的內容，按 `Ctrl+S` / `Cmd+S` 儲存。
4. **填入指令碼屬性 (Script Properties)**：
   - 點選 Apps Script 左側齒輪圖示 **「專案設定 (Project Settings)」** → 滑到最下方點選 **「新增指令碼屬性 (Add script property)」**：
     - `GEMINI_API_KEY`：貼上您的 Gemini API Key
     - `LINE_CHANNEL_ACCESS_TOKEN`：貼上您的 LINE Channel Access Token
     - `DASHBOARD_ACCESS_TOKEN`：（選填）自訂一組跨裝置安全密碼（例如 `my-secret-888`），或留空
5. **執行一鍵初始化試算表**：
   - 回到 Apps Script 左側「**編輯器 (`< >`)**」，在上方函式下拉選單選擇 **`setupSpreadsheet`**，點擊 **「執行 (Run)」**。
   - 首次執行會跳出 Google 權限審查，請點選「審查權限 → 選擇您的 Google 帳號 → 進階 → 前往專案 (不安全) → 允許」。
   - 執行完成後，您的 Google 試算表會自動建立好 5 個彩色工作表（`Transactions`、`RawLogs`、`Budgets`、`AI_Reports`、`Settings`），並自動掛載 **每 30 分鐘漏帳補登觸發器** 與 **每月 1 號 09:00 最細分類微調觸發器**！
6. **部署為網頁應用程式 (Web App)**：
   - 點選右上角 **「部署 (Deploy)」→「新增部署作業 (New deployment)」**。
   - 左上角齒輪選取類型：**「網頁應用程式 (Web app)」**。
   - **執行身分 (Execute as)**：選擇 **「我 (Me)」**。
   - **誰可以存取 (Who has access)**：選擇 **「所有人 (Anyone)」**（⚠️ 必選，如此 LINE Webhook 與 GitHub Pages 才能跨網域存取）。
   - 點擊「部署」，複製產生的 **網頁應用程式網址 (`https://script.google.com/macros/s/XXXX/exec`)**。

---

### 步驟三：設定 LINE Webhook 網址（開通傳文字/傳照片自動記帳）
1. 回到 [LINE Developers Console](https://developers.line.biz/) 您的 Channel → **Messaging API** 分頁。
2. 在 **Webhook settings** 區塊：
   - 將剛剛複製的 GAS 網址 (`https://script.google.com/macros/s/XXXX/exec`) 貼入 **Webhook URL** 並點擊 **Update**。
   - 點擊 **Verify**（測試連線成功）並開啟 **Use webhook** 開關。
3. 前往 **LINE Official Account Manager** →「回應設定」：
   - 將「自動回應訊息」設為 **停用**，將「Webhook」設為 **啟用**。
4. 現在只要用手機傳送文字（如：`午餐雞腿便當125 50嵐四季春45 LINE Pay`）或拍下發票/收據照片傳給 LINE 官方帳號，就會自動拆帳至最細子分類並回傳精美確認卡片！

---

### 步驟四：部署至 GitHub Pages 並完成手機 / 平板 / 電腦跨裝置同步
1. **設定預設連線網址（推薦，免逐台裝置輸入）**：
   - 打開專案根目錄的 [`config.js`](config.js)（以及 [`web/config.js`](web/config.js)），將您的 GAS Web App URL 填入：
     ```javascript
     window.ACCOUNTING_CLOUD_CONFIG = {
       GAS_WEB_APP_URL: 'https://script.google.com/macros/s/您的部署ID/exec',
       DASHBOARD_TOKEN: '',
       DEFAULT_MODEL: 'gemini-3.8-flash',
       AUTO_SYNC_INTERVAL_MS: 180000
     };
     ```
2. **推送至 GitHub 並開啟 GitHub Pages**：
   - 將此專案推送到您的 GitHub Repository。
   - 前往 GitHub Repo 的 **Settings → Pages**，在 **Build and deployment > Source** 選擇 **GitHub Actions**（本專案已內建 [`.github/workflows/deploy-pages.yml`](.github/workflows/deploy-pages.yml)）或選擇 **Deploy from a branch (`main` / `/root`)**。
   - 等待約 30 秒，即可打開您的 `https://<您的帳號>.github.io/<專案名稱>/`。
3. **跨裝置掃碼配對與細部設定同步**：
   - 若您不想將 GAS 網址寫在公開的 `config.js`，只需在電腦打開 GitHub Pages 儀表板 → 切換至 **「⚙️ 雲端細部設定 & 跨裝置同步」** 分頁 → 貼上 GAS 網址。
   - 畫面左側會即時產生 **專屬跨裝置 QR Code**，用手機或 iPad 相機一掃，即可免輸入直接綁定並同步所有帳務與細部設定！
