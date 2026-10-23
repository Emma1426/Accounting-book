/**
 * ============================================================================
 * GitHub Pages 跨裝置預設連線設定檔 (config.js)
 * ============================================================================
 * 💡 使用方式（二選一）：
 * 方式 1（推薦，所有裝置打開網址直接免設定同步）：
 *   將您部署 Google Apps Script 後取得的「網頁應用程式網址 (https://script.google.com/macros/s/.../exec)」
 *   貼入下方 DEFAULT_GAS_WEB_APP_URL 雙引號內並推送至 GitHub。
 *   之後無論用手機、iPad 或電腦打開 GitHub Pages，都會自動抓取同一份 Google Sheet 資料！
 *
 * 方式 2（不在程式碼填網址，透過網頁 QR Code / 專屬連結配對）：
 *   保持下方為空字串，直接在 GitHub Pages 網頁的「⚙️ 設定同步」分頁貼上 GAS 網址，
 *   網頁會自動產生「跨裝置配對 QR Code」供手機與平板掃描一秒綁定！
 * ============================================================================
 */
window.ACCOUNTING_CLOUD_CONFIG = {
  // 填入您的 Google Apps Script Web App URL，例如："https://script.google.com/macros/s/AKfycb.../exec"
  DEFAULT_GAS_WEB_APP_URL: "https://script.google.com/macros/s/AKfycbw_mtxNkSJgeX25OG0daPgFQpRZsrV1EFENIuTui7WofCX2m0LBm7_g9etytA-qweJ0yg/exec",

  // 若您在 GAS 有設定 DASHBOARD_ACCESS_TOKEN 通行碼，可選填於此（或留空由各裝置自行輸入）
  DEFAULT_DASHBOARD_TOKEN: ""
};
