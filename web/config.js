/**
 * ============================================================================
 * GitHub Pages 跨裝置預設連線設定檔 (web/config.js)
 * ============================================================================
 * 所有開啟 GitHub Pages 的裝置（手機 LINE 內建瀏覽器、Safari、平板、電腦）
 * 皆會自動透過下方 GAS Web App URL 從同一份 Google Sheet 讀取與儲存帳務與設定。
 * ============================================================================
 */
window.ACCOUNTING_CLOUD_CONFIG = {
  // Google Apps Script Web App URL (同時提供兩個屬性名稱確保完全相容)
  DEFAULT_GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycbw_mtxNkSJgeX25OG0daPgFQpRZsrV1EFENIuTui7WofCX2m0LBm7_g9etytA-qweJ0yg/exec",
  GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycbw_mtxNkSJgeX25OG0daPgFQpRZsrV1EFENIuTui7WofCX2m0LBm7_g9etytA-qweJ0yg/exec",

  // GitHub Pages 手機版檢視帳務網址（供 LINE 圖文選單與卡片按鈕自動連結）
  DEFAULT_GITHUB_PAGES_URL: "https://emma1426.github.io/Accounting-book/",

  // 若在 GAS 有設定 DASHBOARD_ACCESS_TOKEN 通行碼可填於此（預設留空）
  DEFAULT_DASHBOARD_TOKEN: "",
  DASHBOARD_TOKEN: ""
};
