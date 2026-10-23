# 📒 極簡雲端 AI 帳本（LINE 圖文選單點選記帳 × Google Sheets × GitHub Pages）

這是一套結合 **LINE 官方帳號圖文選單 (Rich Menu)**、**Gemini API**、**Google Sheets 雲端試算表** 與 **GitHub Pages 極簡響應式網頁** 的個人記帳系統。

---

## ✨ 系統核心設計

| 功能特色 | 運作方式 | 對應檔案與函式 |
| :--- | :--- | :--- |
| **1. LINE 圖文選單 (Rich Menu) 點選觸發記帳** | **直接傳送訊息不會自動觸發記帳**（避免日常對話誤觸）。必須先點選 LINE 底部圖文選單的 **【✍️ 點選記帳】** 或 **【📸 收據記帳】** 後才進入記帳流程（若不小心直接傳訊，系統也會先暫存並提供「點選觸發此筆記帳」按鈕）。 | [`gas/Code.gs`](gas/Code.gs) (`setupLineRichMenu`, `processLineEvent_`, `handlePostbackEvent_`) |
| **2. 點選開啟手機版網頁檢視帳務** | LINE 圖文選單右上角與每張記帳確認小卡皆內建 **【📱 手機版檢視帳務】** 按鈕，點選即直接在手機開啟 GitHub Pages 帳本網頁，並自動帶入 Google Sheet 連線參數。 | [`gas/Code.gs`](gas/Code.gs) (`getMobileDashboardUrl_`)、[`index.html`](index.html) |
| **3. 100% Google Sheet 儲存與提取** | 移除假資料干擾，GitHub Pages 網頁透過 [`config.js`](config.js) 預設綁定 GAS 網址，所有收支明細 (`Transactions`)、原始紀錄 (`RawLogs`)、預算 (`Budgets`) 與 AI 診斷 (`AI_Reports`) 皆即時從 Google Sheet 讀取。 | [`config.js`](config.js)、[`index.html`](index.html) (`refreshAllData`, `callCloudBackend`) |
| **4. 跨裝置設定同步儲存** | 在網頁「設定與選單」修改分類預算、子分類字典、帳本名稱、AI 模型或記帳觸發模式，點擊 **「儲存設定至 Google Sheet」** 即寫入 `Settings` 與 `Budgets` 工作表，手機、平板、電腦開啟網頁即自動同步共用。 | [`gas/Code.gs`](gas/Code.gs) (`saveCloudSettingsAndBudgets_`, `getCloudSettings_`)、[`index.html`](index.html) (`saveAllCloudSettings`) |
| **5. 極簡版面設計 (Minimalist UI)** | 精簡為「總覽、帳務明細、AI 診斷、設定與選單」四大分頁，去除冗長橫幅與複雜色塊，針對手機單手瀏覽與電腦大螢幕雙向最佳化。 | [`index.html`](index.html)、[`web/index.html`](web/index.html)、[`gas/Index.html`](gas/Index.html) |

---

## 📱 LINE 圖文選單 (6 宮格極簡配置)

圖文選單尺寸為 `1200 × 810`，可直接在 GitHub 網頁的 **「設定與選單」** 分頁點擊 **「一鍵建立 / 更新 LINE 圖文選單」** 自動繪製並上傳至 LINE 官方帳號：

1. **左上【✍️ 點選記帳】**：點選後開啟文字記帳待命狀態，輸入如 `午餐 120` 即完成 AI 拆帳入庫。
2. **中上【📸 收據記帳】**：點選後開啟收據辨識狀態，並自動浮出「📷 拍攝收據 / 🖼️ 相簿選圖」快捷鍵。
3. **右上【📱 手機版檢視帳務】**：直接開啟 GitHub Pages 手機版網頁，即時檢視 Google Sheet 帳務。
4. **左下【📊 本月摘要】**：在 LINE 內快速查看本月收支與分類統計。
5. **中下【✨ AI 財務診斷】**：由 Gemini 分析當月消費結構與省錢建議。
6. **右下【↩️ 撤銷上筆】**：一鍵取消最近一次記帳紀錄。

---

## 🚀 更新與部署步驟

1. **更新 Google Apps Script (`Code.gs`)**：
   - 打開您的 Google Sheet ➔ **「擴充功能」→「Apps Script」**。
   - 將 [`gas/Code.gs`](gas/Code.gs) 內容貼上覆蓋原有的 `Code.gs`，並將 [`gas/Index.html`](gas/Index.html) 貼上覆蓋原有的 `Index.html`。
   - 點選右上角 **「部署」→「管理部署作業」→ 點擊鉛筆圖示「編輯」→ 版本選擇「新版本 (New version)」→ 點擊「部署」**（如此可維持原來的 GAS 網址不變）。
2. **一鍵啟用 LINE 圖文選單**：
   - 打開您的 GitHub Pages 網址（或本地網頁）➔ 切換至 **「設定與選單」** 分頁 ➔ 點擊 **「一鍵建立 / 更新 LINE 圖文選單」**。
   - 重新打開手機上的 LINE 官方帳號聊天室，底部即會出現全新的六宮格圖文選單！
