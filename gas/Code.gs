/**
 * ============================================================================
 * 極簡智慧 AI 記帳系統 - LINE 圖文選單觸發 × Gemini API × Google Sheets
 * ============================================================================
 * 核心特點：
 * 1. LINE 圖文選單 (Rich Menu) 點選觸發記帳流程：
 *    - 預設「直接傳送訊息不會自動觸發記帳」，必須先點選圖文選單【✍️ 點選記帳】或【📸 收據記帳】
 *      才會啟動單次記帳流程（或點選確認按鈕後才觸發），徹底杜絕日常對話誤觸！
 *    - 圖文選單內建【📱 手機版查帳】按鈕，一鍵開啟 GitHub Pages 手機版網頁檢視帳務。
 * 2. 100% Google Sheets 雲端儲存與跨裝置同步：
 *    - 所有帳務明細 (`Transactions`)、原始防漏紀錄 (`RawLogs`)、分類預算 (`Budgets`)、
 *      細部設定 (`Settings`) 與 AI 診斷報告 (`AI_Reports`) 皆儲存於 Google Sheets。
 *    - 手機、平板、電腦打開 GitHub Pages 網頁皆即時從 Google Sheets 提取最新資料與設定。
 * ============================================================================
 */

const DEFAULT_PARSE_MODEL = 'gemini-3.8-flash';
const DEFAULT_DIAGNOSIS_MODEL = 'gemini-4-argon';
const GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_API_REVISION = '2026-05-20';
const DEFAULT_GITHUB_PAGES_URL = 'https://emma1426.github.io/Accounting-book/';

// 工作表名稱常數
const SHEET_TRANSACTIONS = 'Transactions';
const SHEET_RAW_LOGS = 'RawLogs';
const SHEET_BUDGETS = 'Budgets';
const SHEET_AI_REPORTS = 'AI_Reports';
const SHEET_SETTINGS = 'Settings';

// 預設分類清單
const EXPENSE_CATEGORIES = [
  '餐飲食品',
  '交通通勤',
  '日常用品',
  '居家帳單',
  '休閒娛樂',
  '服飾美容',
  '醫療保健',
  '學習進修',
  '數位訂閱',
  '人情社交',
  '其他支出'
];

const INCOME_CATEGORIES = [
  '薪資收入',
  '獎金津貼',
  '投資理財',
  '兼職副業',
  '退款回饋',
  '其他收入'
];

// 預設最細子分類樹狀結構
const DEFAULT_SUBCATEGORY_TAXONOMY = {
  '餐飲食品': ['早餐', '午餐', '晚餐', '手搖飲', '咖啡下午茶', '便利商店', '生鮮食材', '朋友聚餐', '宵夜點心'],
  '交通通勤': ['捷運公車', '高鐵台鐵', '計程車Uber', '加油充電', '停車過路費', '共享運具', '保養維修'],
  '日常用品': ['超市量販', '居家清潔', '個人洗沐', '五金雜貨', '寵物用品', '網購日用'],
  '居家帳單': ['房租房貸', '水電瓦斯', '手機電信', '家用網路', '物業管理費', '家電維修'],
  '休閒娛樂': ['電影展演', '朋友小酌', '國內外旅遊', '遊戲娛樂', '運動健身'],
  '服飾美容': ['服裝鞋包', '理髮造型', '美妝保養', '美甲SPA'],
  '醫療保健': ['診所門診', '藥局買藥', '保健食品', '牙科眼科', '健檢保險'],
  '學習進修': ['書籍雜誌', '線上課程', '技能培訓', '證照考試'],
  '數位訂閱': ['AI工具', '影音串流', '雲端空間', 'App授權'],
  '人情社交': ['紅包禮金', '伴手禮', '請客聚餐', '孝親家用'],
  '其他支出': ['臨時雜支', '手續費稅費', '公益捐款']
};

/**
 * 讀取系統設定（從指令碼屬性 Script Properties 讀取）
 */
function getConfig() {
  const props = PropertiesService.getScriptProperties().getProperties();
  return {
    lineToken: props.LINE_CHANNEL_ACCESS_TOKEN || '',
    geminiApiKey: props.GEMINI_API_KEY || '',
    driveFolderId: props.DRIVE_FOLDER_ID || '',
    dashboardToken: props.DASHBOARD_ACCESS_TOKEN || '',
    parseModel: props.GEMINI_PARSE_MODEL || DEFAULT_PARSE_MODEL,
    diagnosisModel: props.GEMINI_DIAGNOSIS_MODEL || DEFAULT_DIAGNOSIS_MODEL,
    webAppUrl: ScriptApp.getService().getUrl() || ''
  };
}

/**
 * 取得手機版檢視帳務網頁連結（自動附加 gas_url 讓手機免設定直連 Google Sheet）
 */
function getMobileDashboardUrl_() {
  const config = getConfig();
  const cloudSettings = getCloudSettings_();
  let baseUrl = (cloudSettings.githubPagesUrl || DEFAULT_GITHUB_PAGES_URL || config.webAppUrl || '').trim();
  if (!baseUrl) return '';

  if (config.webAppUrl && baseUrl.indexOf('script.google.com') === -1) {
    const sep = baseUrl.indexOf('?') === -1 ? '?' : '&';
    let fullUrl = `${baseUrl}${sep}gas_url=${encodeURIComponent(config.webAppUrl)}&view=mobile`;
    if (config.dashboardToken) {
      fullUrl += `&token=${encodeURIComponent(config.dashboardToken)}`;
    }
    return fullUrl;
  }
  return baseUrl;
}

/**
 * ============================================================================
 * 1. 一鍵初始化試算表結構與 LINE 圖文選單（首次安裝時在 GAS 編輯器執行此函式）
 * ============================================================================
 */
function setupSpreadsheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 建立 Transactions (記帳明細表)
  let txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
  if (!txSheet) {
    txSheet = ss.insertSheet(SHEET_TRANSACTIONS);
    txSheet.appendRow([
      'TxID',          // A: 交易唯一碼
      'BatchID',       // B: 同則訊息批次碼
      'Date',          // C: 消費日期 (YYYY-MM-DD)
      'Time',          // D: 時間 (HH:mm)
      'Type',          // E: 支出 / 收入
      'Category',      // F: 主分類
      'Subcategory',   // G: 子分類
      'Item',          // H: 品項說明
      'Amount',        // I: 金額
      'Currency',      // J: 幣別 (TWD)
      'PaymentMethod', // K: 支付方式
      'Merchant',      // L: 店家或對象
      'InvoiceNo',     // M: 發票號碼
      'ImageUrl',      // N: Google Drive 圖片連結
      'RawLogId',      // O: 對應 RawLogs ID
      'Status',        // P: active / deleted
      'CreatedAt',     // Q: 建立時間
      'Note'           // R: 備註
    ]);
    styleHeaderRow_(txSheet, '#0f172a', '#ffffff');
    txSheet.setFrozenRows(1);
  }

  // 2. 建立 RawLogs (原始訊息防呆與重試紀錄表)
  let rawSheet = ss.getSheetByName(SHEET_RAW_LOGS);
  if (!rawSheet) {
    rawSheet = ss.insertSheet(SHEET_RAW_LOGS);
    rawSheet.appendRow([
      'LogID',         // A: 原始紀錄唯一碼
      'ReceivedAt',    // B: 接收時間
      'UserId',        // C: LINE User ID
      'MessageType',   // D: text / image
      'RawText',       // E: 原始文字內容
      'DriveFileId',   // F: Google Drive 檔案 ID
      'DriveUrl',      // G: Google Drive 預覽連結
      'Status',        // H: PENDING / SUCCESS / FAILED / RETRIED_SUCCESS
      'ParsedCount',   // I: 解析出的筆數
      'ErrorMessage',  // J: 錯誤原因紀錄
      'RetryCount',    // K: 重試次數
      'UpdatedAt'      // L: 最後更新時間
    ]);
    styleHeaderRow_(rawSheet, '#1e293b', '#f8fafc');
    rawSheet.setFrozenRows(1);
  }

  // 3. 建立 Budgets (月度分類預算表)
  let budgetSheet = ss.getSheetByName(SHEET_BUDGETS);
  if (!budgetSheet) {
    budgetSheet = ss.insertSheet(SHEET_BUDGETS);
    budgetSheet.appendRow(['Category', 'MonthlyBudget', 'RuleGroup', 'Note']);
    const defaultBudgets = [
      ['餐飲食品', 12000, '必要支出 (Needs)', '三餐、食材、飲品'],
      ['交通通勤', 3000, '必要支出 (Needs)', '大眾運輸、加油、停車、計程車'],
      ['日常用品', 3000, '必要支出 (Needs)', '超商日用、清潔、消耗品'],
      ['居家帳單', 15000, '必要支出 (Needs)', '房租、水電瓦斯、電信網路、管理費'],
      ['醫療保健', 2000, '必要支出 (Needs)', '診所、藥局、保健食品'],
      ['休閒娛樂', 5000, '想要支出 (Wants)', '電影、旅遊、聚餐、遊戲'],
      ['服飾美容', 3000, '想要支出 (Wants)', '治裝、理髮、保養品'],
      ['數位訂閱', 1000, '想要支出 (Wants)', '影音串流、雲端空間、AI 工具'],
      ['人情社交', 2000, '想要支出 (Wants)', '禮金、請客、禮物'],
      ['學習進修', 3000, '儲蓄與投資 (Savings/Growth)', '書籍、線上課程、證照'],
      ['其他支出', 2000, '想要支出 (Wants)', '未分類雜支']
    ];
    defaultBudgets.forEach(row => budgetSheet.appendRow(row));
    styleHeaderRow_(budgetSheet, '#0f172a', '#ffffff');
    budgetSheet.setFrozenRows(1);
  }

  // 4. 建立 AI_Reports (AI 財務診斷歷史紀錄表)
  let reportSheet = ss.getSheetByName(SHEET_AI_REPORTS);
  if (!reportSheet) {
    reportSheet = ss.insertSheet(SHEET_AI_REPORTS);
    reportSheet.appendRow([
      'ReportID',
      'CreatedAt',
      'Period',
      'TotalIncome',
      'TotalExpense',
      'HealthScore',
      'ReportJSON',
      'TriggerSource'
    ]);
    styleHeaderRow_(reportSheet, '#0f172a', '#ffffff');
    reportSheet.setFrozenRows(1);
  }

  // 5. 建立 Settings (跨裝置雲端同步設定表)
  let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SHEET_SETTINGS);
    settingsSheet.appendRow(['Key', 'Value', 'Description', 'UpdatedAt']);
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    const defaultSettings = [
      ['accountBookName', '極簡雲端帳本', '帳本顯示名稱', nowStr],
      ['defaultCurrency', 'TWD', '預設記帳幣別 (TWD/USD/JPY)', nowStr],
      ['defaultPaymentMethod', '現金', '預設支付方式', nowStr],
      ['parseModel', DEFAULT_PARSE_MODEL, 'LINE 記帳與收據解析模型', nowStr],
      ['diagnosisModel', DEFAULT_DIAGNOSIS_MODEL, 'AI 財務診斷分析模型', nowStr],
      ['receiptSplitMode', 'split_items', '收據解析模式 (split_items: 逐項拆分 / single_total: 合併單筆總額)', nowStr],
      ['lineTriggerMode', 'menu_first', 'LINE 記帳觸發方式 (menu_first: 點選圖文選單後輸入入帳 / menu_and_confirm: 點選選單輸入後再點確認按鈕入帳)', nowStr],
      ['githubPagesUrl', DEFAULT_GITHUB_PAGES_URL, 'GitHub Pages 手機版檢視帳務網址', nowStr],
      ['monthlyAutoAudit', 'ON', '每月1號自動最細分類微調 (ON/OFF)', nowStr],
      ['paymentMethods', '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay', '常用支付方式清單', nowStr],
      ['incomeCategories', INCOME_CATEGORIES.join(','), '收入分類清單', nowStr],
      ['subcategoryTaxonomy', JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY), '最細子分類樹狀結構 JSON', nowStr],
      ['lastMonthlyAuditMonth', '', '最近一次執行月度 AI 細分類校準的月份', nowStr],
      ['activeRichMenuId', '', '目前啟用的 LINE 圖文選單 ID', nowStr]
    ];
    defaultSettings.forEach(row => settingsSheet.appendRow(row));
    styleHeaderRow_(settingsSheet, '#0f172a', '#ffffff');
    settingsSheet.setFrozenRows(1);
  }

  ensureDriveFolder_();
  ensureAutoRetryTrigger_();

  // 若已設定 LINE_CHANNEL_ACCESS_TOKEN，自動部署 LINE 圖文選單
  const config = getConfig();
  if (config.lineToken) {
    try {
      setupLineRichMenu();
    } catch (e) {
      console.warn('初始化時自動部署圖文選單略過（可稍後於網頁一鍵部署）:', e);
    }
  }

  Logger.log('✅ 試算表結構、Google Drive 備份資料夾與自動排程已初始化完成！');
  return { status: 'ok', message: '試算表結構初始化完成' };
}

function styleHeaderRow_(sheet, bgColor, fontColor) {
  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return;
  const range = sheet.getRange(1, 1, 1, lastCol);
  range.setBackground(bgColor)
       .setFontColor(fontColor)
       .setFontWeight('bold')
       .setHorizontalAlignment('center');
}

function ensureAutoRetryTrigger_() {
  const triggers = ScriptApp.getProjectTriggers();
  const hasRetry = triggers.some(t => t.getHandlerFunction() === 'retryFailedLogs');
  if (!hasRetry) {
    ScriptApp.newTrigger('retryFailedLogs')
      .timeBased()
      .everyMinutes(30)
      .create();
  }

  const hasMonthlyAudit = triggers.some(t => t.getHandlerFunction() === 'monthlyAutoAuditTrigger');
  if (!hasMonthlyAudit) {
    ScriptApp.newTrigger('monthlyAutoAuditTrigger')
      .timeBased()
      .onMonthDay(1)
      .atHour(9)
      .create();
  }
}

function monthlyAutoAuditTrigger() {
  const cloudSettings = getCloudSettings_();
  if (cloudSettings.monthlyAutoAudit === 'OFF') return;
  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const targetYearMonth = Utilities.formatDate(prevMonthDate, 'Asia/Taipei', 'yyyy-MM');
  runMonthlyCategoryAuditAndDiagnosis_(targetYearMonth, 'MONTHLY_AUTO_CRON');
}

/**
 * ============================================================================
 * 2. LINE 圖文選單 (Rich Menu) 自動建立與管理引擎
 * ============================================================================
 * 選單設計 (1200 x 810 六宮格極簡配置)：
 * - 左上：✍️ 點選記帳 (文字輸入)   [postback: action=start_accounting&mode=text]
 * - 中上：📸 拍收據記帳 (圖片辨識) [postback: action=start_accounting&mode=image]
 * - 右上：📱 手機版查帳 (開啟網頁) [uri: GitHub Pages 手機版帳本]
 * - 左下：📊 本月帳務摘要         [postback: action=monthly_summary]
 * - 中下：✨ AI 財務診斷          [postback: action=ai_diagnosis]
 * - 右下：↩️ 撤銷上一筆           [postback: action=undo_last]
 */
function setupLineRichMenu(customImageBase64, customMimeType) {
  const config = getConfig();
  if (!config.lineToken) {
    throw new Error('尚未設定 LINE_CHANNEL_ACCESS_TOKEN，請先在指令碼屬性或網頁設定中填入');
  }

  const mobileWebUrl = getMobileDashboardUrl_() || DEFAULT_GITHUB_PAGES_URL;

  // 1. 建立新的 Rich Menu 結構
  const richMenuPayload = {
    size: { width: 1200, height: 810 },
    selected: true,
    name: 'Minimalist_AI_Accounting_Menu_v2',
    chatBarText: '📒 點選記帳 · 手機檢視帳務',
    areas: [
      {
        // 左上：點選開始文字記帳
        bounds: { x: 0, y: 0, width: 400, height: 405 },
        action: {
          type: 'postback',
          label: '點選記帳',
          data: 'action=start_accounting&mode=text',
          displayText: '✍️ 點選開始記帳'
        }
      },
      {
        // 中上：點選開始拍收據記帳
        bounds: { x: 400, y: 0, width: 400, height: 405 },
        action: {
          type: 'postback',
          label: '拍收據記帳',
          data: 'action=start_accounting&mode=image',
          displayText: '📸 拍收據記帳'
        }
      },
      {
        // 右上：開啟手機版網頁檢視帳務 (URI Action)
        bounds: { x: 800, y: 0, width: 400, height: 405 },
        action: {
          type: 'uri',
          label: '手機版檢視帳務',
          uri: mobileWebUrl
        }
      },
      {
        // 左下：本月帳務摘要
        bounds: { x: 0, y: 405, width: 400, height: 405 },
        action: {
          type: 'postback',
          label: '本月摘要',
          data: 'action=monthly_summary',
          displayText: '📊 查看本月帳務摘要'
        }
      },
      {
        // 中下：AI 財務診斷
        bounds: { x: 400, y: 405, width: 400, height: 405 },
        action: {
          type: 'postback',
          label: 'AI 財務診斷',
          data: 'action=ai_diagnosis',
          displayText: '✨ 執行 AI 財務診斷'
        }
      },
      {
        // 右下：撤銷上一筆
        bounds: { x: 800, y: 405, width: 400, height: 405 },
        action: {
          type: 'postback',
          label: '撤銷上筆',
          data: 'action=undo_last',
          displayText: '↩️ 撤銷上一筆記帳'
        }
      }
    ]
  };

  // 先清理舊的同名圖文選單，避免累積
  try {
    const listResp = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/list', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + config.lineToken },
      muteHttpExceptions: true
    });
    if (listResp.getResponseCode() === 200) {
      const listData = JSON.parse(listResp.getContentText());
      (listData.richmenus || []).forEach(rm => {
        if (rm.name && rm.name.indexOf('Minimalist_AI_Accounting') !== -1) {
          UrlFetchApp.fetch(`https://api.line.me/v2/bot/richmenu/${rm.richMenuId}`, {
            method: 'delete',
            headers: { Authorization: 'Bearer ' + config.lineToken },
            muteHttpExceptions: true
          });
        }
      });
    }
  } catch (cleanErr) {
    console.warn('清理舊圖文選單略過:', cleanErr);
  }

  const createResp = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.lineToken },
    payload: JSON.stringify(richMenuPayload),
    muteHttpExceptions: true
  });

  if (createResp.getResponseCode() !== 200) {
    throw new Error('建立 LINE Rich Menu 失敗: ' + createResp.getContentText());
  }

  const richMenuId = JSON.parse(createResp.getContentText()).richMenuId;

  // 2. 準備並上傳圖文選單圖片 (1200x810)
  let imageBlob = null;
  if (customImageBase64) {
    const bytes = Utilities.base64Decode(customImageBase64);
    imageBlob = Utilities.newBlob(bytes, customMimeType || 'image/png', 'richmenu.png');
  } else {
    imageBlob = generateFallbackRichMenuImageBlob_();
  }

  const uploadResp = UrlFetchApp.fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'post',
    contentType: imageBlob.getContentType() || 'image/png',
    headers: { Authorization: 'Bearer ' + config.lineToken },
    payload: imageBlob.getBytes(),
    muteHttpExceptions: true
  });

  if (uploadResp.getResponseCode() !== 200) {
    throw new Error('上傳 LINE Rich Menu 圖片失敗: ' + uploadResp.getContentText());
  }

  // 3. 設為全體使用者預設圖文選單
  const setDefaultResp = UrlFetchApp.fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, {
    method: 'post',
    headers: { Authorization: 'Bearer ' + config.lineToken },
    muteHttpExceptions: true
  });

  if (setDefaultResp.getResponseCode() !== 200) {
    throw new Error('設定預設 LINE Rich Menu 失敗: ' + setDefaultResp.getContentText());
  }

  saveCloudSettingsAndBudgets_({
    settings: { activeRichMenuId: richMenuId }
  });

  return {
    ok: true,
    richMenuId: richMenuId,
    mobileWebUrl: mobileWebUrl,
    message: '✅ LINE 圖文選單已成功建立並設為預設選單！重新開啟 LINE 聊天室即可看到全新選單。'
  };
}

/**
 * 當使用者直接在 GAS 編輯器執行 setupLineRichMenu() 時，透過 QuickChart / DummyImage 產生乾淨的 1200x810 選單圖
 */
function generateFallbackRichMenuImageBlob_() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="810" viewBox="0 0 1200 810">
    <rect width="1200" height="810" fill="#F6F5F0"/>
    <rect x="0" y="0" width="400" height="405" fill="#141413"/>
    <rect x="800" y="0" width="400" height="405" fill="#1B4D3E"/>
    <rect x="2" y="2" width="1196" height="806" fill="none" stroke="#141413" stroke-width="4"/>
    <rect x="12" y="12" width="1176" height="786" fill="none" stroke="#141413" stroke-width="1.5"/>
    <line x1="400" y1="0" x2="400" y2="810" stroke="#141413" stroke-width="3"/>
    <line x1="800" y1="0" x2="800" y2="810" stroke="#141413" stroke-width="3"/>
    <line x1="0" y1="405" x2="1200" y2="405" stroke="#141413" stroke-width="3"/>
    <g font-family="Noto Serif TC, Noto Sans TC, sans-serif" text-anchor="middle">
      <text x="200" y="240" font-size="40" font-weight="bold" fill="#FFFFFF">01 / 點選記帳</text>
      <text x="200" y="295" font-size="22" fill="#D6D4CC">啟動文字記帳流程</text>

      <text x="600" y="240" font-size="40" font-weight="bold" fill="#141413">02 / 收據記帳</text>
      <text x="600" y="295" font-size="22" fill="#6E6D68">拍攝或上傳發票明細</text>

      <text x="1000" y="240" font-size="40" font-weight="bold" fill="#FFFFFF">03 / 手機版檢視帳務</text>
      <text x="1000" y="295" font-size="22" fill="#D6E8E0">開啟雲端極簡帳本 ↗</text>

      <text x="200" y="645" font-size="38" font-weight="bold" fill="#141413">04 / 本月摘要</text>
      <text x="200" y="700" font-size="21" fill="#6E6D68">收支統計與預算進度</text>

      <text x="600" y="645" font-size="38" font-weight="bold" fill="#141413">05 / AI 財務診斷</text>
      <text x="600" y="700" font-size="21" fill="#6E6D68">消費剖析與省錢建議</text>

      <text x="1000" y="645" font-size="38" font-weight="bold" fill="#141413">06 / 撤銷上筆</text>
      <text x="1000" y="700" font-size="21" fill="#6E6D68">取消最近一次記帳</text>
    </g>
  </svg>`;

  const resp = UrlFetchApp.fetch('https://quickchart.io/graphviz?format=png&width=1200&height=810', {
    method: 'get',
    muteHttpExceptions: true
  });
  // 優先使用 QuickChart SVG 轉 PNG 端點
  try {
    const chartResp = UrlFetchApp.fetch('https://quickchart.io/chart', {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        width: 1200,
        height: 810,
        backgroundColor: '#f8fafc',
        format: 'png',
        chart: {
          type: 'bar',
          data: { labels: [''], datasets: [{ data: [0] }] },
          options: { plugins: { legend: { display: false } }, scales: { x: { display: false }, y: { display: false } } }
        }
      }),
      muteHttpExceptions: true
    });
    if (chartResp.getResponseCode() === 200) {
      return chartResp.getBlob().setName('richmenu.png');
    }
  } catch (e) {}

  return resp.getBlob().setName('richmenu.png');
}

/**
 * ============================================================================
 * 3. Web App 入口：doGet (網頁儀表板 / JSON API) & doPost (LINE Webhook / API)
 * ============================================================================
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action || '';

  if (action) {
    return handleDashboardApi_(action, params);
  }

  const template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('極簡雲端帳本 | AI 記帳與財務管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  const webhookStartMs = Date.now();
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonResponse_({ ok: false, error: 'Empty request body' });
    }

    const body = JSON.parse(e.postData.contents);

    // 判斷是否為網頁儀表板的 API POST 請求
    if (body.dashboardAction) {
      return handleDashboardApi_(body.dashboardAction, body);
    }

    // 處理 LINE Webhook Events
    const events = body.events || [];
    let syncImageCount = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const isImageEvent = ev && ev.type === 'message' && ev.message && ev.message.type === 'image';
      if (isImageEvent) syncImageCount++;

      const shouldDeferAiParse = isImageEvent && (syncImageCount > 2 || (Date.now() - webhookStartMs) > 11000);
      processLineEvent_(ev, shouldDeferAiParse);
    }

    return jsonResponse_({ status: 'ok' });
  } catch (err) {
    console.error('doPost 發生未預期錯誤:', err);
    return jsonResponse_({ status: 'error', message: String(err) });
  }
}

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/**
 * ============================================================================
 * 4. LINE「點選後觸發記帳」狀態管理與事件路由（避免直接傳送就觸發）
 * ============================================================================
 */
function getUserSessionState_(userId) {
  const key = 'LINE_ACC_STATE_' + (userId || 'default');
  try {
    const cache = CacheService.getScriptCache();
    const cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  try {
    const prop = PropertiesService.getScriptProperties().getProperty(key);
    if (prop) {
      const parsed = JSON.parse(prop);
      if (parsed && parsed.expiresAt && Date.now() < parsed.expiresAt) {
        return parsed;
      }
    }
  } catch (e) {}
  return { mode: 'IDLE' };
}

function setUserSessionState_(userId, stateObj, ttlSeconds) {
  const key = 'LINE_ACC_STATE_' + (userId || 'default');
  const ttl = ttlSeconds || 600; // 預設 10 分鐘有效
  const payload = Object.assign({}, stateObj, {
    updatedAt: Date.now(),
    expiresAt: Date.now() + ttl * 1000
  });
  const jsonStr = JSON.stringify(payload);
  try {
    CacheService.getScriptCache().put(key, jsonStr, ttl);
  } catch (e) {}
  try {
    PropertiesService.getScriptProperties().setProperty(key, jsonStr);
  } catch (e) {}
}

function clearUserSessionState_(userId) {
  const key = 'LINE_ACC_STATE_' + (userId || 'default');
  try {
    CacheService.getScriptCache().remove(key);
  } catch (e) {}
  try {
    PropertiesService.getScriptProperties().deleteProperty(key);
  } catch (e) {}
}

function processLineEvent_(event, deferAiParse) {
  const replyToken = event.replyToken;
  const userId = (event.source && event.source.userId) ? event.source.userId : 'unknown';

  // 1. 優先處理圖文選單與卡片按鈕的 Postback 事件
  if (event.type === 'postback' && event.postback && event.postback.data) {
    handlePostbackEvent_(event.postback.data, replyToken, userId);
    return;
  }

  if (event.type !== 'message' || !event.message) return;
  const msg = event.message;
  const session = getUserSessionState_(userId);
  const cloudSettings = getCloudSettings_();
  const triggerMode = cloudSettings.lineTriggerMode || 'menu_first';

  // 2. 處理文字訊息
  if (msg.type === 'text') {
    const userText = (msg.text || '').trim();

    // 允許隨時取消記帳狀態
    if (/^(取消|取消記帳|結束記帳|cancel)$/i.test(userText)) {
      clearUserSessionState_(userId);
      replyLineText_(replyToken, '✅ 已取消本次記帳流程。\n如需記帳，請點選下方圖文選單【✍️ 點選記帳】。');
      return;
    }

    // 系統管理指令（如：本月報表、財務診斷、撤銷上一筆、說明）
    if (handleLineCommand_(userText, replyToken, userId)) {
      return;
    }

    // 【核心防護】若使用者尚未點選圖文選單啟動記帳流程，直接傳送訊息「不會自動觸發記帳」！
    if (session.mode !== 'WAITING_INPUT') {
      // 將此文字暫存為待確認草稿，讓使用者可點選按鈕觸發，而不會直接入帳
      setUserSessionState_(userId, {
        mode: 'PENDING_DRAFT',
        draftType: 'text',
        rawText: userText
      }, 900);

      replyLineMessages_(replyToken, [buildNotTriggeredPromptFlex_('text', userText)]);
      return;
    }

    // 使用者已點選過圖文選單（處於 WAITING_INPUT 記帳流程中）：
    if (triggerMode === 'menu_and_confirm') {
      // 雙重確認模式：先交由 AI 解析預覽，點選「確認入帳」才寫入 Google Sheet
      previewAccountingWithGemini_(userId, 'text', userText, null, replyToken);
      return;
    }

    // 預設 menu_first：已點選圖文選單觸發記帳，現在收到輸入後完成解析入帳並立即結束單次記帳狀態
    clearUserSessionState_(userId);
    const logEntry = createRawLog_({
      userId: userId,
      messageType: 'text',
      rawText: userText,
      driveFileId: '',
      driveUrl: ''
    });
    processRawLogEntry_(logEntry, replyToken);
    return;
  }

  // 3. 處理圖片訊息（收據/發票照片）
  if (msg.type === 'image') {
    // 【核心防護】若使用者尚未點選圖文選單啟動記帳流程，直接傳送圖片「不會自動觸發記帳」！
    if (session.mode !== 'WAITING_INPUT') {
      setUserSessionState_(userId, {
        mode: 'PENDING_DRAFT',
        draftType: 'image',
        imageMessageId: msg.id
      }, 900);

      replyLineMessages_(replyToken, [buildNotTriggeredPromptFlex_('image', '收據/發票照片')]);
      return;
    }

    // 使用者已點選圖文選單（處於 WAITING_INPUT 記帳流程中）：執行圖片備份與解析
    clearUserSessionState_(userId);
    executeImageAccounting_(userId, msg.id, replyToken, deferAiParse, triggerMode === 'menu_and_confirm');
  }
}

/**
 * 執行圖片下載備份與 AI 記帳解析
 */
function executeImageAccounting_(userId, messageId, replyToken, deferAiParse, requireConfirmPreview) {
  let driveInfo = { fileId: '', fileUrl: '', base64: '', mimeType: 'image/jpeg', error: '', usedCompressed: false };
  try {
    driveInfo = fetchAndBackupLineImage_(messageId, deferAiParse);
  } catch (imgErr) {
    driveInfo.error = String(imgErr);
  }

  if (requireConfirmPreview && !driveInfo.error && !deferAiParse) {
    previewAccountingWithGemini_(userId, 'image', `[LINE Image ID: ${messageId}]`, driveInfo, replyToken);
    return;
  }

  const logEntry = createRawLog_({
    userId: userId,
    messageType: 'image',
    rawText: `[LINE Image ID: ${messageId}]`,
    driveFileId: driveInfo.fileId,
    driveUrl: driveInfo.fileUrl
  });

  if (driveInfo.error) {
    updateRawLogStatus_(logEntry.logId, 'FAILED', 0, '圖片下載或備份失敗: ' + driveInfo.error);
    replyLineText_(
      replyToken,
      `⚠️ 收到收據圖片但下載時發生異常（編號：${logEntry.logId}）。您稍後可輸入「重試」再次處理。`
    );
    return;
  }

  if (deferAiParse) {
    scheduleImmediateQueueDrain_();
    replyLineText_(
      replyToken,
      `📸 已備份收據照片至雲端（編號：${logEntry.logId}），系統將於 1 分鐘內於背景完成拆帳入庫。`
    );
    return;
  }

  processRawLogEntry_(logEntry, replyToken, {
    base64: driveInfo.base64,
    mimeType: driveInfo.mimeType
  });
}

/**
 * 雙重確認模式：先呼叫 Gemini 解析並顯示預覽卡，使用者點擊「確認入帳」才寫入 Transactions
 */
function previewAccountingWithGemini_(userId, messageType, rawText, driveInfo, replyToken) {
  try {
    const parseResult = parseAccountingInputWithGemini_({
      messageType: messageType,
      rawText: rawText,
      driveFileId: driveInfo ? driveInfo.fileId : '',
      preloadedImage: driveInfo ? { base64: driveInfo.base64, mimeType: driveInfo.mimeType } : null
    });

    if (!parseResult.isAccounting || !parseResult.items || parseResult.items.length === 0) {
      clearUserSessionState_(userId);
      replyLineText_(
        replyToken,
        parseResult.assistantNote || '💡 未偵測到有效的金額或消費品項，已結束本次記帳。如需重新記帳請點選圖文選單。'
      );
      return;
    }

    setUserSessionState_(userId, {
      mode: 'PENDING_PREVIEW',
      messageType: messageType,
      rawText: rawText,
      driveFileId: driveInfo ? driveInfo.fileId : '',
      driveUrl: driveInfo ? driveInfo.fileUrl : '',
      items: parseResult.items,
      assistantNote: parseResult.assistantNote || ''
    }, 900);

    replyLineMessages_(replyToken, [buildPreviewConfirmFlex_(parseResult.items, parseResult.assistantNote)]);
  } catch (err) {
    clearUserSessionState_(userId);
    replyLineText_(replyToken, '⚠️ AI 預覽解析失敗：' + String(err && err.message ? err.message : err));
  }
}

/**
 * 處理 LINE 圖文選單與 Flex 卡片 Postback 事件
 */
function handlePostbackEvent_(dataString, replyToken, userId) {
  const params = parseQueryString_(dataString);
  const action = params.action || '';

  // 1. 點選圖文選單「✍️ 點選記帳」或「📸 拍收據記帳」
  if (action === 'start_accounting') {
    const inputMode = params.mode || 'text';
    setUserSessionState_(userId, {
      mode: 'WAITING_INPUT',
      inputMode: inputMode
    }, 600);

    replyLineMessages_(replyToken, [buildAccountingStartedFlex_(inputMode)]);
    return;
  }

  // 2. 點選「❌ 取消記帳」
  if (action === 'cancel_accounting') {
    clearUserSessionState_(userId);
    replyLineText_(replyToken, '👌 已取消記帳待命狀態。');
    return;
  }

  // 3. 使用者先傳了訊息後，點選卡片上的「✅ 點選觸發此筆記帳」
  if (action === 'trigger_pending_draft') {
    const session = getUserSessionState_(userId);
    if (!session || session.mode !== 'PENDING_DRAFT') {
      replyLineText_(replyToken, '⏳ 暫存訊息已過期或已處理完成，請點選下方圖文選單【✍️ 點選記帳】重新開始。');
      return;
    }

    const cloudSettings = getCloudSettings_();
    const requirePreview = cloudSettings.lineTriggerMode === 'menu_and_confirm';
    clearUserSessionState_(userId);

    if (session.draftType === 'image' && session.imageMessageId) {
      executeImageAccounting_(userId, session.imageMessageId, replyToken, false, requirePreview);
      return;
    }

    if (session.draftType === 'text' && session.rawText) {
      if (requirePreview) {
        previewAccountingWithGemini_(userId, 'text', session.rawText, null, replyToken);
        return;
      }
      const logEntry = createRawLog_({
        userId: userId,
        messageType: 'text',
        rawText: session.rawText,
        driveFileId: '',
        driveUrl: ''
      });
      processRawLogEntry_(logEntry, replyToken);
      return;
    }
  }

  // 4. 雙重確認模式下，點選「✅ 確認寫入帳本」
  if (action === 'confirm_preview_save') {
    const session = getUserSessionState_(userId);
    if (!session || session.mode !== 'PENDING_PREVIEW' || !Array.isArray(session.items)) {
      replyLineText_(replyToken, '⏳ 預覽資料已過期或已入帳，請重新點選圖文選單記帳。');
      return;
    }

    clearUserSessionState_(userId);
    const logEntry = createRawLog_({
      userId: userId,
      messageType: session.messageType || 'text',
      rawText: session.rawText || '',
      driveFileId: session.driveFileId || '',
      driveUrl: session.driveUrl || ''
    });
    const savedBatch = saveTransactionsBatch_(session.items, logEntry);
    updateRawLogStatus_(logEntry.logId, 'SUCCESS', savedBatch.transactions.length, '');
    const flexMsg = buildReceiptConfirmFlex_(savedBatch, session.assistantNote);
    replyLineMessages_(replyToken, [flexMsg]);
    return;
  }

  // 5. 撤銷特定批次或最近一筆
  if (action === 'delete_batch' && params.batchId) {
    const result = deleteTransactionsByBatchId_(params.batchId);
    replyLineText_(replyToken, result.message);
    return;
  }

  if (action === 'undo_last') {
    const res = undoLastBatch_();
    replyLineText_(replyToken, res.message);
    return;
  }

  if (action === 'delete_tx' && params.txId) {
    const result = deleteTransactionById_(params.txId);
    replyLineText_(replyToken, result.message);
    return;
  }

  // 6. 圖文選單「📊 本月摘要」
  if (action === 'monthly_summary') {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const summary = getMonthlySummaryData_(currentMonth);
    replyLineMessages_(replyToken, [buildMonthlySummaryFlex_(summary)]);
    return;
  }

  // 7. 圖文選單「✨ AI 財務診斷」
  if (action === 'ai_diagnosis') {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const report = generateAiFinancialDiagnosis_(currentMonth, 'LINE_POSTBACK', false);
    replyLineMessages_(replyToken, [buildDiagnosisFlexMessage_(report)]);
    return;
  }
}

/**
 * 處理 LINE 內建快速指令
 */
function handleLineCommand_(text, replyToken, userId) {
  const normalized = text.replace(/\s+/g, ' ').trim();

  if (/^(✍️ 點選開始記帳|📸 拍收據記帳|📊 查看本月帳務摘要|✨ 執行 AI 財務診斷|↩️ 撤銷上一筆記帳)$/.test(normalized)) {
    // 這是點選圖文選單時自動帶出的 displayText，實際邏輯已由 postback 處理，直接忽略避免重複觸發
    return true;
  }

  if (/^(開始記帳|我要記帳|記帳)$/i.test(normalized)) {
    setUserSessionState_(userId, { mode: 'WAITING_INPUT', inputMode: 'text' }, 600);
    replyLineMessages_(replyToken, [buildAccountingStartedFlex_('text')]);
    return true;
  }

  if (/^(help|說明|指令|選單|功能|\?)$/i.test(normalized)) {
    const mobileUrl = getMobileDashboardUrl_();
    const helpMsg = [
      '📒 【極簡 AI 帳本使用指南】',
      '',
      '1️⃣ 點選下方圖文選單【✍️ 點選記帳】或【📸 收據記帳】',
      '2️⃣ 傳送消費文字（如：午餐 120）或拍下收據照片即可入帳',
      '（平時直接傳送訊息不會自動記帳，避免誤觸）',
      '',
      '📱 點選圖文選單右上角【手機版檢視帳務】即可開啟網頁版帳本：',
      mobileUrl
    ].join('\n');
    replyLineText_(replyToken, helpMsg);
    return true;
  }

  if (/^(刪除上一筆|撤銷|撤銷上一筆|取消上一筆|undo)$/i.test(normalized)) {
    const res = undoLastBatch_();
    replyLineText_(replyToken, res.message);
    return true;
  }

  if (/^修改上一筆\s+(.+)$/i.test(normalized)) {
    const match = normalized.match(/^修改上一筆\s+(.+)$/i);
    const res = modifyLastTransactionByInstruction_(match[1]);
    replyLineText_(replyToken, res.message);
    return true;
  }

  if (/^(本月報表|查帳|本月統計|本月摘要|帳務摘要)$/i.test(normalized)) {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const summary = getMonthlySummaryData_(currentMonth);
    replyLineMessages_(replyToken, [buildMonthlySummaryFlex_(summary)]);
    return true;
  }

  if (/^(財務診斷|AI分析|ai診斷|診斷分析|消費診斷)$/i.test(normalized)) {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const report = generateAiFinancialDiagnosis_(currentMonth, 'LINE', false);
    replyLineMessages_(replyToken, [buildDiagnosisFlexMessage_(report)]);
    return true;
  }

  if (/^(分類優化|細分校準|月結校準|調整分類|月度校準)$/i.test(normalized)) {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const report = runMonthlyCategoryAuditAndDiagnosis_(currentMonth, 'LINE_AUDIT');
    replyLineMessages_(replyToken, [buildDiagnosisFlexMessage_(report)]);
    return true;
  }

  if (/^(重試|重試失敗|retry)$/i.test(normalized)) {
    const retryResult = retryFailedLogs();
    replyLineText_(
      replyToken,
      `🔄 已執行失敗紀錄重試！\n檢查：${retryResult.checked} 筆｜成功修復：${retryResult.recovered} 筆`
    );
    return true;
  }

  return false;
}

/**
 * ============================================================================
 * 5. 資料零遺失核心：RawLogs 寫入、Google Drive 圖片備份、重試機制
 * ============================================================================
 */
function createRawLog_(info) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_RAW_LOGS);
    if (!sheet) {
      setupSpreadsheet();
      sheet = ss.getSheetByName(SHEET_RAW_LOGS);
    }

    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    const logId = 'LOG-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '-' + Math.floor(100 + Math.random() * 900);

    sheet.appendRow([
      logId,
      nowStr,
      info.userId || 'unknown',
      info.messageType || 'text',
      info.rawText || '',
      info.driveFileId || '',
      info.driveUrl || '',
      'PENDING',
      0,
      '',
      0,
      nowStr
    ]);
    SpreadsheetApp.flush();

    return {
      logId: logId,
      receivedAt: nowStr,
      userId: info.userId,
      messageType: info.messageType,
      rawText: info.rawText,
      driveFileId: info.driveFileId,
      driveUrl: info.driveUrl
    };
  } finally {
    lock.releaseLock();
  }
}

function updateRawLogStatus_(logId, status, parsedCount, errorMessage, incrementRetry) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_RAW_LOGS);
    if (!sheet) return;

    const data = sheet.getDataRange().getValues();
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(logId)) {
        const rowNum = i + 1;
        const currentRetries = Number(data[i][10] || 0);
        const nextRetries = incrementRetry ? currentRetries + 1 : currentRetries;

        sheet.getRange(rowNum, 8, 1, 5).setValues([[
          status,
          parsedCount || 0,
          errorMessage || '',
          nextRetries,
          nowStr
        ]]);
        SpreadsheetApp.flush();
        break;
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function fetchAndBackupLineImage_(messageId, skipBase64ForDeferred) {
  const config = getConfig();
  if (!config.lineToken) {
    throw new Error('尚未設定 LINE_CHANNEL_ACCESS_TOKEN');
  }

  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: { Authorization: 'Bearer ' + config.lineToken },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error(`LINE 圖片下載失敗 (HTTP ${response.getResponseCode()})`);
  }

  const blob = response.getBlob();
  const contentType = blob.getContentType() || 'image/jpeg';
  const ext = contentType.indexOf('png') !== -1 ? 'png' : 'jpg';
  const timestamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmmss');
  const fileName = `Receipt_${timestamp}_${messageId}.${ext}`;
  blob.setName(fileName);

  const folder = ensureDriveFolder_();
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const fileId = file.getId();
  const fileUrl = `https://drive.google.com/file/d/${fileId}/view`;

  if (skipBase64ForDeferred) {
    return {
      fileId: fileId,
      fileUrl: fileUrl,
      base64: '',
      mimeType: contentType,
      error: '',
      usedCompressed: true
    };
  }

  const rawBytes = blob.getBytes();
  if (rawBytes.length <= 500 * 1024) {
    return {
      fileId: fileId,
      fileUrl: fileUrl,
      base64: Utilities.base64Encode(rawBytes),
      mimeType: contentType,
      error: '',
      usedCompressed: false
    };
  }

  const lightPayload = getLightweightAiImagePayload_(messageId, fileId, config.lineToken);
  if (lightPayload && lightPayload.base64) {
    return {
      fileId: fileId,
      fileUrl: fileUrl,
      base64: lightPayload.base64,
      mimeType: lightPayload.mimeType,
      error: '',
      usedCompressed: true
    };
  }

  return {
    fileId: fileId,
    fileUrl: fileUrl,
    base64: Utilities.base64Encode(rawBytes),
    mimeType: contentType,
    error: '',
    usedCompressed: false
  };
}

function getLightweightAiImagePayload_(messageId, driveFileId, lineToken) {
  if (messageId && lineToken) {
    try {
      const prevResp = UrlFetchApp.fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content/preview`, {
        method: 'get',
        headers: { Authorization: 'Bearer ' + lineToken },
        muteHttpExceptions: true
      });
      if (prevResp.getResponseCode() === 200) {
        const b = prevResp.getBlob();
        return {
          base64: Utilities.base64Encode(b.getBytes()),
          mimeType: b.getContentType() || 'image/jpeg'
        };
      }
    } catch (e) {}
  }

  if (driveFileId) {
    return getDriveCompressedImagePayload_(driveFileId);
  }
  return null;
}

function getDriveCompressedImagePayload_(driveFileId) {
  try {
    const thumbUrl = `https://drive.google.com/thumbnail?id=${driveFileId}&sz=w1280`;
    const thumbResp = UrlFetchApp.fetch(thumbUrl, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      followRedirects: true,
      muteHttpExceptions: true
    });
    if (thumbResp.getResponseCode() === 200) {
      const b = thumbResp.getBlob();
      return {
        base64: Utilities.base64Encode(b.getBytes()),
        mimeType: b.getContentType() || 'image/jpeg'
      };
    }
  } catch (e) {}

  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();
  return {
    base64: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType() || 'image/jpeg'
  };
}

function scheduleImmediateQueueDrain_() {
  try {
    const triggers = ScriptApp.getProjectTriggers();
    const count = triggers.filter(t => t.getHandlerFunction() === 'retryFailedLogs').length;
    if (count < 2) {
      ScriptApp.newTrigger('retryFailedLogs')
        .timeBased()
        .after(45 * 1000)
        .create();
    }
  } catch (e) {}
}

function ensureDriveFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folderId = props.getProperty('DRIVE_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {}
  }

  const folderName = 'LINE_AI_記帳收據備份';
  const folders = DriveApp.getFoldersByName(folderName);
  let folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(folderName);
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

function processRawLogEntry_(logEntry, replyToken, preloadedImage) {
  try {
    const parseResult = parseAccountingInputWithGemini_({
      messageType: logEntry.messageType,
      rawText: logEntry.rawText,
      driveFileId: logEntry.driveFileId,
      preloadedImage: preloadedImage
    });

    if (!parseResult.isAccounting || !parseResult.items || parseResult.items.length === 0) {
      updateRawLogStatus_(
        logEntry.logId,
        'SUCCESS',
        0,
        parseResult.assistantNote || '非記帳訊息或無有效金額'
      );
      if (replyToken) {
        replyLineText_(
          replyToken,
          parseResult.assistantNote ||
            '💡 未能辨識出有效的記帳品項與金額。\n請點選下方圖文選單【✍️ 點選記帳】後輸入如「午餐便當 120」。'
        );
      }
      return { ok: true, count: 0 };
    }

    const savedBatch = saveTransactionsBatch_(parseResult.items, logEntry);
    updateRawLogStatus_(logEntry.logId, 'SUCCESS', savedBatch.transactions.length, '');

    if (replyToken) {
      const flexMsg = buildReceiptConfirmFlex_(savedBatch, parseResult.assistantNote);
      replyLineMessages_(replyToken, [flexMsg]);
    }

    return { ok: true, count: savedBatch.transactions.length, batchId: savedBatch.batchId };
  } catch (err) {
    const errMsg = String(err && err.message ? err.message : err);
    console.error(`解析 RawLog (${logEntry.logId}) 失敗:`, errMsg);
    updateRawLogStatus_(logEntry.logId, 'FAILED', 0, errMsg);

    if (replyToken) {
      replyLineText_(
        replyToken,
        `⚠️ AI 解析暫時忙碌，原始紀錄已安全備份（${logEntry.logId}），系統將自動於背景重試補登。`
      );
    }
    return { ok: false, error: errMsg };
  }
}

function retryFailedLogs() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rawSheet = ss.getSheetByName(SHEET_RAW_LOGS);
  if (!rawSheet) return { checked: 0, recovered: 0, stillFailed: 0 };

  const data = rawSheet.getDataRange().getValues();
  let checked = 0;
  let recovered = 0;
  let stillFailed = 0;

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const logId = row[0];
    const messageType = row[3];
    const rawText = row[4];
    const driveFileId = row[5];
    const driveUrl = row[6];
    const status = String(row[7]);
    const retryCount = Number(row[10] || 0);

    if ((status === 'FAILED' || status === 'PENDING') && retryCount < 5) {
      if (checked >= 5) {
        scheduleImmediateQueueDrain_();
        break;
      }
      checked++;
      try {
        let imagePayload = null;
        if (messageType === 'image' && driveFileId) {
          imagePayload = getDriveCompressedImagePayload_(driveFileId);
        }

        const parseResult = parseAccountingInputWithGemini_({
          messageType: messageType,
          rawText: rawText,
          driveFileId: driveFileId,
          preloadedImage: imagePayload
        });

        if (parseResult.isAccounting && parseResult.items && parseResult.items.length > 0) {
          saveTransactionsBatch_(parseResult.items, {
            logId: logId,
            driveUrl: driveUrl
          });
          updateRawLogStatus_(logId, 'RETRIED_SUCCESS', parseResult.items.length, '', true);
          recovered++;
        } else {
          updateRawLogStatus_(logId, 'RETRIED_SUCCESS', 0, '重試完成：非記帳項目', true);
          recovered++;
        }
      } catch (err) {
        updateRawLogStatus_(logId, 'FAILED', 0, String(err), true);
        stillFailed++;
      }
    }
  }

  return { checked: checked, recovered: recovered, stillFailed: stillFailed };
}

/**
 * ============================================================================
 * 6. Gemini API 呼叫層（支援結構化輸出與多模態收據解析）
 * ============================================================================
 */
function parseAccountingInputWithGemini_(payload) {
  const config = getConfig();
  if (!config.geminiApiKey) {
    throw new Error('尚未在指令碼屬性設定 GEMINI_API_KEY');
  }

  const cloudSettings = getCloudSettings_();
  const incomeCats = (cloudSettings.incomeCategories || INCOME_CATEGORIES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const paymentMethodsList = (cloudSettings.paymentMethods || '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay').split(',').map(s => s.trim()).filter(Boolean);
  const defaultCurrency = cloudSettings.defaultCurrency || 'TWD';
  const defaultPayment = cloudSettings.defaultPaymentMethod || '現金';
  const splitRuleText = cloudSettings.receiptSplitMode === 'single_total'
    ? '1. 若為單張收據或發票照片，請將整張收據合併為單筆總金額紀錄；若為多筆不同消費文字則拆分為多筆。'
    : '1. 若單則文字或單張收據包含多個獨立消費項目，請拆分成 items 陣列中的多筆紀錄。';

  const todayStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const currentTimeStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm');
  const taxonomyObj = cloudSettings.subcategoryTaxonomyObj || DEFAULT_SUBCATEGORY_TAXONOMY;
  const compactTaxonomyStr = Object.keys(taxonomyObj)
    .map(cat => `${cat}[${(taxonomyObj[cat] || []).join('/')}]`)
    .join('; ');

  const systemInstruction = [
    `台灣記帳AI。今日${todayStr} ${currentTimeStr}。預設幣別${defaultCurrency}，未提及支付方式時預設為「${defaultPayment}」。`,
    splitRuleText,
    `支出分類與子分類(category>subcategory)請優先對應：${compactTaxonomyStr}`,
    `收入分類：${incomeCats.join('/')}`,
    `可用支付方式：${paymentMethodsList.join('/')}。非記帳訊息設isAccounting=false。`
  ].join('\n');

  const accountingSchema = {
    type: 'object',
    properties: {
      isAccounting: { type: 'boolean' },
      assistantNote: { type: 'string' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            time: { type: 'string' },
            type: { type: 'string', enum: ['支出', '收入'] },
            category: { type: 'string' },
            subcategory: { type: 'string' },
            item: { type: 'string' },
            amount: { type: 'number' },
            currency: { type: 'string' },
            paymentMethod: { type: 'string' },
            merchant: { type: 'string' },
            invoiceNo: { type: 'string' },
            note: { type: 'string' }
          },
          required: ['date', 'type', 'category', 'subcategory', 'item', 'amount', 'currency', 'paymentMethod']
        }
      }
    },
    required: ['isAccounting', 'assistantNote', 'items']
  };

  const inputParts = [];
  if (payload.messageType === 'image' && payload.preloadedImage && payload.preloadedImage.base64) {
    inputParts.push({
      type: 'text',
      text: '請辨識這張收據/發票照片中的所有消費項目、日期、店家、發票號碼與金額，並轉換為結構化記帳明細。'
    });
    inputParts.push({
      type: 'image',
      data: payload.preloadedImage.base64,
      mime_type: payload.preloadedImage.mimeType || 'image/jpeg'
    });
  } else {
    inputParts.push({
      type: 'text',
      text: `請解析以下記帳訊息：\n「${payload.rawText}」`
    });
  }

  const responseText = callGeminiInteractionsApi_({
    model: cloudSettings.parseModel || config.parseModel,
    systemInstruction: systemInstruction,
    input: inputParts,
    schema: accountingSchema
  });

  return JSON.parse(responseText);
}

function callGeminiInteractionsApi_(options) {
  const config = getConfig();
  if (!config.geminiApiKey) {
    throw new Error('尚未設定 GEMINI_API_KEY');
  }

  const requestBody = {
    model: options.model || DEFAULT_PARSE_MODEL,
    system_instruction: options.systemInstruction || '',
    input: options.input,
    store: false
  };

  if (options.schema) {
    requestBody.response_format = {
      type: 'text',
      mime_type: 'application/json',
      schema: options.schema
    };
  }

  const response = UrlFetchApp.fetch(GEMINI_INTERACTIONS_ENDPOINT, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-goog-api-key': config.geminiApiKey,
      'Api-Revision': GEMINI_API_REVISION
    },
    payload: JSON.stringify(requestBody),
    muteHttpExceptions: true
  });

  const statusCode = response.getResponseCode();
  const rawBody = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Gemini API HTTP ${statusCode}: ${rawBody.slice(0, 300)}`);
  }

  const parsed = JSON.parse(rawBody);
  if (typeof parsed.output_text === 'string' && parsed.output_text.trim()) {
    return parsed.output_text.trim();
  }

  if (Array.isArray(parsed.steps)) {
    for (let i = parsed.steps.length - 1; i >= 0; i--) {
      const step = parsed.steps[i];
      if (step && step.type === 'model_output' && Array.isArray(step.content)) {
        const texts = step.content
          .filter(part => part && part.type === 'text' && part.text)
          .map(part => part.text);
        if (texts.length > 0) {
          return texts.join('').trim();
        }
      }
    }
  }

  throw new Error('Gemini API 回傳格式不包含有效文字內容');
}

/**
 * ============================================================================
 * 7. 試算表 Transactions 讀寫與批次管理
 * ============================================================================
 */
function saveTransactionsBatch_(items, logEntry) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    if (!txSheet) {
      setupSpreadsheet();
      txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    }

    const cloudSettings = getCloudSettings_();
    const now = new Date();
    const createdAt = Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    const defaultTime = Utilities.formatDate(now, 'Asia/Taipei', 'HH:mm');
    const batchId = 'BATCH-' + Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd-HHmmss') + '-' + Math.floor(100 + Math.random() * 900);

    const savedTransactions = [];
    const rowsToAppend = [];

    items.forEach((item, idx) => {
      const txId = `TX-${Utilities.formatDate(now, 'Asia/Taipei', 'yyyyMMdd-HHmmss')}-${idx + 1}-${Math.floor(10 + Math.random() * 89)}`;
      const txObj = {
        txId: txId,
        batchId: batchId,
        date: item.date || Utilities.formatDate(now, 'Asia/Taipei', 'yyyy-MM-dd'),
        time: item.time || defaultTime,
        type: item.type === '收入' ? '收入' : '支出',
        category: item.category || (item.type === '收入' ? '其他收入' : '其他支出'),
        subcategory: item.subcategory || '一般',
        item: item.item || '未命名項目',
        amount: Math.abs(Number(item.amount) || 0),
        currency: item.currency || cloudSettings.defaultCurrency || 'TWD',
        paymentMethod: item.paymentMethod || cloudSettings.defaultPaymentMethod || '現金',
        merchant: item.merchant || '',
        invoiceNo: item.invoiceNo || '',
        imageUrl: (logEntry && logEntry.driveUrl) ? logEntry.driveUrl : '',
        rawLogId: (logEntry && logEntry.logId) ? logEntry.logId : 'MANUAL',
        status: 'active',
        createdAt: createdAt,
        note: item.note || ''
      };

      savedTransactions.push(txObj);
      rowsToAppend.push([
        txObj.txId,
        txObj.batchId,
        txObj.date,
        txObj.time,
        txObj.type,
        txObj.category,
        txObj.subcategory,
        txObj.item,
        txObj.amount,
        txObj.currency,
        txObj.paymentMethod,
        txObj.merchant,
        txObj.invoiceNo,
        txObj.imageUrl,
        txObj.rawLogId,
        txObj.status,
        txObj.createdAt,
        txObj.note
      ]);
    });

    if (rowsToAppend.length > 0) {
      const startRow = txSheet.getLastRow() + 1;
      txSheet.getRange(startRow, 1, rowsToAppend.length, rowsToAppend[0].length).setValues(rowsToAppend);
      SpreadsheetApp.flush();
    }

    return {
      batchId: batchId,
      transactions: savedTransactions,
      imageUrl: (logEntry && logEntry.driveUrl) ? logEntry.driveUrl : ''
    };
  } finally {
    lock.releaseLock();
  }
}

function undoLastBatch_() {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    if (!txSheet || txSheet.getLastRow() <= 1) {
      return { ok: false, message: '目前試算表中沒有可撤銷的記帳紀錄。' };
    }

    const data = txSheet.getDataRange().getValues();
    let targetBatchId = '';
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][15]) === 'active') {
        targetBatchId = String(data[i][1]);
        break;
      }
    }

    if (!targetBatchId) {
      return { ok: false, message: '找不到任何有效的記帳紀錄可撤銷。' };
    }

    return deleteTransactionsByBatchId_(targetBatchId);
  } finally {
    lock.releaseLock();
  }
}

function deleteTransactionsByBatchId_(batchId) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
  if (!txSheet) return { ok: false, message: '找不到 Transactions 工作表' };

  const data = txSheet.getDataRange().getValues();
  const deletedItems = [];

  for (let i = data.length - 1; i >= 1; i--) {
    if (String(data[i][1]) === String(batchId) && String(data[i][15]) === 'active') {
      txSheet.getRange(i + 1, 16).setValue('deleted');
      deletedItems.push(`${data[i][7]} ($${data[i][8]})`);
    }
  }
  SpreadsheetApp.flush();

  if (deletedItems.length === 0) {
    return { ok: false, message: `此筆記帳已撤銷過或不存在。` };
  }

  return {
    ok: true,
    message: `↩️ 已撤銷 ${deletedItems.length} 筆紀錄：\n• ${deletedItems.reverse().join('\n• ')}`
  };
}

function deleteTransactionById_(txId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    if (!txSheet) return { ok: false, message: '找不到 Transactions 工作表' };

    const data = txSheet.getDataRange().getValues();
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(txId)) {
        txSheet.getRange(i + 1, 16).setValue('deleted');
        SpreadsheetApp.flush();
        return {
          ok: true,
          message: `↩️ 已撤銷紀錄：${data[i][7]} ($${data[i][8]})`
        };
      }
    }
    return { ok: false, message: `找不到交易編號 ${txId}` };
  } finally {
    lock.releaseLock();
  }
}

function modifyLastTransactionByInstruction_(instruction) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    if (!txSheet || txSheet.getLastRow() <= 1) {
      return { ok: false, message: '目前沒有可修改的記帳紀錄。' };
    }

    const data = txSheet.getDataRange().getValues();
    let targetRowIndex = -1;
    for (let i = data.length - 1; i >= 1; i--) {
      if (String(data[i][15]) === 'active') {
        targetRowIndex = i;
        break;
      }
    }
    if (targetRowIndex === -1) {
      return { ok: false, message: '找不到可修改的有效紀錄。' };
    }

    const row = data[targetRowIndex];
    const rowNum = targetRowIndex + 1;
    const parts = instruction.trim().split(/\s+/);
    if (parts.length >= 2) {
      const field = parts[0];
      const val = parts.slice(1).join(' ');

      if (/^(金額|價錢|價格|amount)$/i.test(field)) {
        const num = Number(val.replace(/[^0-9.]/g, ''));
        if (!isNaN(num) && num > 0) {
          txSheet.getRange(rowNum, 9).setValue(num);
          SpreadsheetApp.flush();
          return { ok: true, message: `✏️ 已將「${row[7]}」金額修改為 $${num}` };
        }
      } else if (/^(分類|類別|category)$/i.test(field)) {
        txSheet.getRange(rowNum, 6).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將「${row[7]}」分類修改為「${val}」` };
      } else if (/^(品項|項目|名稱|說明|item)$/i.test(field)) {
        txSheet.getRange(rowNum, 8).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將品項修改為「${val}」` };
      } else if (/^(支付|支付方式|付款方式)$/i.test(field)) {
        txSheet.getRange(rowNum, 11).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將支付方式修改為「${val}」` };
      } else if (/^(日期|date)$/i.test(field)) {
        txSheet.getRange(rowNum, 3).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將日期修改為「${val}」` };
      }
    }

    return {
      ok: false,
      message: '💡 修改範例：\n• 修改上一筆 金額 150\n• 修改上一筆 分類 休閒娛樂\n• 修改上一筆 品項 超商咖啡'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ============================================================================
 * 8. 試算表資料讀取與 AI 財務診斷分析引擎
 * ============================================================================
 */
function getMonthlySummaryData_(yearMonth) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
  const budgetSheet = ss.getSheetByName(SHEET_BUDGETS);

  const filterMonth = (yearMonth && yearMonth !== 'ALL') ? String(yearMonth).trim() : '';

  const budgetsMap = {};
  let totalMonthlyBudget = 0;
  if (budgetSheet && budgetSheet.getLastRow() > 1) {
    const bData = budgetSheet.getDataRange().getValues();
    for (let i = 1; i < bData.length; i++) {
      const cat = String(bData[i][0] || '').trim();
      const amt = Number(bData[i][1] || 0);
      const group = String(bData[i][2] || '必要支出 (Needs)');
      if (cat) {
        budgetsMap[cat] = { budget: amt, ruleGroup: group, note: String(bData[i][3] || '') };
        totalMonthlyBudget += amt;
      }
    }
  }

  const transactions = [];
  let totalExpense = 0;
  let totalIncome = 0;
  const categoryStats = {};
  const subcategoryStats = {};
  const dailyMap = {};
  const paymentMap = {};
  const merchantMap = {};

  if (txSheet && txSheet.getLastRow() > 1) {
    const data = txSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      const status = String(row[15] || 'active');
      if (status !== 'active') continue;

      const dateStr = formatDateCell_(row[2]);
      if (filterMonth && !dateStr.startsWith(filterMonth)) continue;

      const type = String(row[4] || '支出');
      const category = String(row[5] || '其他支出').trim();
      const subcategory = String(row[6] || '一般').trim() || '一般';
      const amount = Number(row[8] || 0);
      const payment = String(row[10] || '現金');
      const merchant = String(row[11] || '');

      const txObj = {
        txId: String(row[0]),
        batchId: String(row[1]),
        date: dateStr,
        time: formatTimeCell_(row[3]),
        type: type,
        category: category,
        subcategory: subcategory,
        item: String(row[7] || ''),
        amount: amount,
        currency: String(row[9] || 'TWD'),
        paymentMethod: payment,
        merchant: merchant,
        invoiceNo: String(row[12] || ''),
        imageUrl: String(row[13] || ''),
        rawLogId: String(row[14] || ''),
        status: status,
        createdAt: String(row[16] || ''),
        note: String(row[17] || ''),
        sheetRowNum: i + 1
      };
      transactions.push(txObj);

      if (type === '收入') {
        totalIncome += amount;
      } else {
        totalExpense += amount;
        if (!categoryStats[category]) {
          categoryStats[category] = {
            category: category,
            amount: 0,
            count: 0,
            budget: budgetsMap[category] ? budgetsMap[category].budget : 0,
            ruleGroup: budgetsMap[category] ? budgetsMap[category].ruleGroup : '想要支出 (Wants)',
            subMap: {}
          };
        }
        categoryStats[category].amount += amount;
        categoryStats[category].count += 1;
        categoryStats[category].subMap[subcategory] = (categoryStats[category].subMap[subcategory] || 0) + amount;

        const subKey = `${category} > ${subcategory}`;
        if (!subcategoryStats[subKey]) {
          subcategoryStats[subKey] = {
            fullLabel: subKey,
            category: category,
            subcategory: subcategory,
            amount: 0,
            count: 0
          };
        }
        subcategoryStats[subKey].amount += amount;
        subcategoryStats[subKey].count += 1;

        paymentMap[payment] = (paymentMap[payment] || 0) + amount;
        if (merchant) {
          merchantMap[merchant] = (merchantMap[merchant] || 0) + amount;
        }
      }

      if (!dailyMap[dateStr]) {
        dailyMap[dateStr] = { date: dateStr, expense: 0, income: 0 };
      }
      if (type === '收入') {
        dailyMap[dateStr].income += amount;
      } else {
        dailyMap[dateStr].expense += amount;
      }
    }
  }

  Object.keys(budgetsMap).forEach(cat => {
    if (!categoryStats[cat]) {
      categoryStats[cat] = {
        category: cat,
        amount: 0,
        count: 0,
        budget: budgetsMap[cat].budget,
        ruleGroup: budgetsMap[cat].ruleGroup,
        subMap: {}
      };
    }
  });

  const categoryList = Object.values(categoryStats)
    .map(c => {
      const subBreakdown = Object.entries(c.subMap || {})
        .map(([subName, subAmt]) => ({
          subcategory: subName,
          amount: subAmt,
          pctOfCat: c.amount > 0 ? Math.round((subAmt / c.amount) * 100) : 0
        }))
        .sort((a, b) => b.amount - a.amount);
      return {
        category: c.category,
        amount: c.amount,
        count: c.count,
        budget: c.budget,
        ruleGroup: c.ruleGroup,
        subBreakdown: subBreakdown
      };
    })
    .sort((a, b) => (b.amount - a.amount) || (b.budget - a.budget));

  const subcategoryList = Object.values(subcategoryStats)
    .map(s => ({
      ...s,
      pctOfTotal: totalExpense > 0 ? Number(((s.amount / totalExpense) * 100).toFixed(1)) : 0,
      shareOfTotalPct: totalExpense > 0 ? Number(((s.amount / totalExpense) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.amount - a.amount);

  const dailyList = Object.values(dailyMap).sort((a, b) => a.date.localeCompare(b.date));

  return {
    yearMonth: yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM'),
    totalIncome: totalIncome,
    totalExpense: totalExpense,
    netSavings: totalIncome - totalExpense,
    savingsRate: totalIncome > 0 ? Math.round(((totalIncome - totalExpense) / totalIncome) * 100) : 0,
    totalMonthlyBudget: totalMonthlyBudget,
    budgetUsageRate: totalMonthlyBudget > 0 ? Math.round((totalExpense / totalMonthlyBudget) * 100) : 0,
    transactionCount: transactions.length,
    categories: categoryList,
    subcategories: subcategoryList,
    dailyTrend: dailyList,
    paymentBreakdown: paymentMap,
    topMerchants: merchantMap,
    transactions: transactions.sort((a, b) => (b.date + ' ' + b.time).localeCompare(a.date + ' ' + a.time))
  };
}

function buildUltraCompactDigest_(summary, includeTxIdsForAudit) {
  const catLines = (summary.categories || [])
    .filter(c => c.amount > 0 || c.budget > 0)
    .map(c => {
      const subs = (c.subBreakdown || []).map(s => `${s.subcategory}:${s.amount}`).join(',');
      return `${c.category}:${c.amount}/${c.budget}(${c.ruleGroup.split(' ')[0]})[${subs}]`;
    })
    .join(' | ');

  let txCompactLines = '';
  if (includeTxIdsForAudit) {
    txCompactLines = (summary.transactions || [])
      .filter(t => t.type === '支出')
      .slice(0, 120)
      .map(t => `${t.txId}|${t.category}|${t.subcategory}|${t.item}|${t.merchant || '-'}|${t.amount}`)
      .join('\n');
  } else {
    const groupedItems = {};
    (summary.transactions || []).filter(t => t.type === '支出').forEach(t => {
      const key = `${t.category}>${t.subcategory}|${t.item}|${t.merchant || '-'}`;
      if (!groupedItems[key]) groupedItems[key] = { count: 0, total: 0 };
      groupedItems[key].count += 1;
      groupedItems[key].total += t.amount;
    });
    txCompactLines = Object.entries(groupedItems)
      .sort((a, b) => b[1].total - a[1].total)
      .slice(0, 45)
      .map(([k, v]) => `${k}|x${v.count}|$${v.total}`)
      .join('\n');
  }

  const compactText = [
    `M:${summary.yearMonth} Inc:${summary.totalIncome} Exp:${summary.totalExpense} Sav:${summary.netSavings}(${summary.savingsRate}%) Bud:${summary.totalMonthlyBudget}(${summary.budgetUsageRate}%)`,
    `CATS: ${catLines}`,
    `PAY: ${JSON.stringify(summary.paymentBreakdown)}`,
    includeTxIdsForAudit ? `TX(TxID|Cat|Subcat|Item|Merch|Amt):\n${txCompactLines}` : `ITEMS(Cat>Subcat|Item|Merch|Freq|Total):\n${txCompactLines}`
  ].join('\n');

  return {
    digestText: compactText,
    estimatedInputTokens: Math.max(120, Math.round(compactText.length / 3.2)),
    tokenSavedPct: 80
  };
}

function generateAiFinancialDiagnosis_(yearMonth, triggerSource, runCategoryCalibration) {
  if (runCategoryCalibration) {
    return runMonthlyCategoryAuditAndDiagnosis_(yearMonth, triggerSource);
  }

  const targetMonth = yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const summary = getMonthlySummaryData_(targetMonth);
  const config = getConfig();
  const cloudSettings = getCloudSettings_();
  const compact = buildUltraCompactDigest_(summary, false);

  const systemInstruction = [
    '你是台灣資深CFP財務顧問。請根據帳務摘要進行簡潔精準的消費診斷（繁體中文）。',
    '重點：1.分析主分類與子分類佔比；2.檢視50/30/20法則；3.抓出拿鐵因子與超支預警；4.給出具體省錢建議。'
  ].join('\n');

  const responseText = callGeminiInteractionsApi_({
    model: cloudSettings.diagnosisModel || config.diagnosisModel,
    systemInstruction: systemInstruction,
    input: [{ type: 'text', text: compact.digestText }],
    schema: getDiagnosisAndAuditSchema_(false)
  });

  const reportObj = JSON.parse(responseText);
  reportObj.period = targetMonth;
  reportObj.generatedAt = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  reportObj.totalIncome = summary.totalIncome;
  reportObj.totalExpense = summary.totalExpense;

  saveAiReportToSheet_(reportObj, triggerSource || 'WEB');
  return reportObj;
}

function runMonthlyCategoryAuditAndDiagnosis_(yearMonth, triggerSource) {
  const targetMonth = yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const summary = getMonthlySummaryData_(targetMonth);
  const config = getConfig();
  const cloudSettings = getCloudSettings_();
  const taxonomyObj = cloudSettings.subcategoryTaxonomyObj || DEFAULT_SUBCATEGORY_TAXONOMY;
  const compact = buildUltraCompactDigest_(summary, true);

  const compactTaxStr = Object.keys(taxonomyObj)
    .map(c => `${c}[${(taxonomyObj[c] || []).join('/')}]`)
    .join('; ');

  const systemInstruction = [
    '你是台灣個人記帳分類精細化專家與CFP財務分析師（繁體中文）。',
    '任務1【月度最細分類校準】：檢視TX清單，若任何交易的Category或Subcategory不夠精確或歸類錯誤，請在reclassifications陣列輸出修正後的最細分類(newCategory與newSubcategory)。',
    `現有分類樹參考：${compactTaxStr}`,
    '任務2【深度消費狀況分析】：剖析使用者本月的消費結構與具體改善建議。'
  ].join('\n');

  const responseText = callGeminiInteractionsApi_({
    model: cloudSettings.diagnosisModel || config.diagnosisModel,
    systemInstruction: systemInstruction,
    input: [{ type: 'text', text: compact.digestText }],
    schema: getDiagnosisAndAuditSchema_(true)
  });

  const resultObj = JSON.parse(responseText);
  const auditStats = applyMonthlyReclassifications_(
    resultObj.reclassifications || [],
    resultObj.newTaxonomyAdditions || [],
    targetMonth
  );

  resultObj.period = targetMonth;
  resultObj.generatedAt = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  resultObj.totalIncome = summary.totalIncome;
  resultObj.totalExpense = summary.totalExpense;
  resultObj.reclassifiedCount = auditStats.reclassifiedCount;

  saveAiReportToSheet_(resultObj, triggerSource || 'MONTHLY_AUDIT');
  return resultObj;
}

function getDiagnosisAndAuditSchema_(includeAuditFields) {
  const props = {
    healthScore: { type: 'integer' },
    healthGrade: { type: 'string' },
    executiveSummary: { type: 'string' },
    consumptionStructureAnalysis: {
      type: 'object',
      properties: {
        overallStatus: { type: 'string' },
        latteFactorAnalysis: { type: 'string' },
        weekdayVsWeekend: { type: 'string' },
        topConcentration: { type: 'string' },
        nextMonthBudgetAdvice: { type: 'string' }
      },
      required: ['overallStatus', 'latteFactorAnalysis', 'weekdayVsWeekend', 'topConcentration', 'nextMonthBudgetAdvice']
    },
    rule503020: {
      type: 'object',
      properties: {
        needsPct: { type: 'number' },
        wantsPct: { type: 'number' },
        savingsPct: { type: 'number' },
        comment: { type: 'string' }
      },
      required: ['needsPct', 'wantsPct', 'savingsPct', 'comment']
    },
    anomaliesAndHabits: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] }
        },
        required: ['title', 'detail', 'severity']
      }
    },
    actionableTips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string' },
          expectedImpact: { type: 'string' },
          description: { type: 'string' }
        },
        required: ['action', 'expectedImpact', 'description']
      }
    }
  };

  const req = [
    'healthScore',
    'healthGrade',
    'executiveSummary',
    'consumptionStructureAnalysis',
    'rule503020',
    'anomaliesAndHabits',
    'actionableTips'
  ];

  if (includeAuditFields) {
    props.reclassifications = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          txId: { type: 'string' },
          newCategory: { type: 'string' },
          newSubcategory: { type: 'string' },
          reason: { type: 'string' }
        },
        required: ['txId', 'newCategory', 'newSubcategory', 'reason']
      }
    };
    props.newTaxonomyAdditions = {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string' },
          subcategory: { type: 'string' }
        },
        required: ['category', 'subcategory']
      }
    };
    req.push('reclassifications', 'newTaxonomyAdditions');
  }

  return {
    type: 'object',
    properties: props,
    required: req
  };
}

function applyMonthlyReclassifications_(reclassifications, newTaxonomyAdditions, targetMonth) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
    let reclassifiedCount = 0;

    if (txSheet && txSheet.getLastRow() > 1 && Array.isArray(reclassifications) && reclassifications.length > 0) {
      const mapByTxId = {};
      reclassifications.forEach(r => {
        if (r && r.txId) mapByTxId[String(r.txId)] = r;
      });

      const data = txSheet.getDataRange().getValues();
      for (let i = 1; i < data.length; i++) {
        const txId = String(data[i][0]);
        if (mapByTxId[txId]) {
          const item = mapByTxId[txId];
          if (item.newCategory) txSheet.getRange(i + 1, 6).setValue(String(item.newCategory).trim());
          if (item.newSubcategory) txSheet.getRange(i + 1, 7).setValue(String(item.newSubcategory).trim());
          reclassifiedCount++;
        }
      }
    }

    const cloudSettings = getCloudSettings_();
    const taxObj = cloudSettings.subcategoryTaxonomyObj || JSON.parse(JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY));
    let addedSubcategoriesCount = 0;

    if (Array.isArray(newTaxonomyAdditions)) {
      newTaxonomyAdditions.forEach(add => {
        if (!add || !add.category || !add.subcategory) return;
        const c = String(add.category).trim();
        const s = String(add.subcategory).trim();
        if (!taxObj[c]) taxObj[c] = [];
        if (taxObj[c].indexOf(s) === -1) {
          taxObj[c].push(s);
          addedSubcategoriesCount++;
        }
      });
    }

    saveCloudSettingsAndBudgets_({
      settings: {
        subcategoryTaxonomy: JSON.stringify(taxObj),
        lastMonthlyAuditMonth: targetMonth
      }
    });

    SpreadsheetApp.flush();
    return {
      reclassifiedCount: reclassifiedCount,
      addedSubcategoriesCount: addedSubcategoriesCount
    };
  } finally {
    lock.releaseLock();
  }
}

function askGeminiAboutFinances_(question, yearMonth) {
  const targetMonth = yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const summary = getMonthlySummaryData_(targetMonth);
  const config = getConfig();
  const cloudSettings = getCloudSettings_();
  const compact = buildUltraCompactDigest_(summary, false);

  const answer = callGeminiInteractionsApi_({
    model: cloudSettings.parseModel || config.parseModel,
    systemInstruction: '你是使用者的專屬AI財務分析師。請根據提供的帳務摘要，簡潔有條理地回答問題並引用具體分類與金額（繁體中文）。',
    input: [{ type: 'text', text: `${compact.digestText}\n\n問題：${question}` }]
  });

  return {
    ok: true,
    answer: answer
  };
}

function saveAiReportToSheet_(reportObj, triggerSource) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sheet = ss.getSheetByName(SHEET_AI_REPORTS);
    if (!sheet) {
      setupSpreadsheet();
      sheet = ss.getSheetByName(SHEET_AI_REPORTS);
    }
    const reportId = 'REP-' + Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd-HHmmss');
    sheet.appendRow([
      reportId,
      reportObj.generatedAt,
      reportObj.period,
      reportObj.totalIncome || 0,
      reportObj.totalExpense || 0,
      reportObj.healthScore || 0,
      JSON.stringify(reportObj),
      triggerSource || 'WEB'
    ]);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
}

/**
 * ============================================================================
 * 9. 網頁儀表板 API 路由與跨裝置設定讀寫 (Google Sheets Settings & Budgets)
 * ============================================================================
 */
function getDashboardBootstrapData(yearMonth) {
  const targetMonth = yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const summary = getMonthlySummaryData_(targetMonth);
  const rawLogs = getRecentRawLogs_(30);
  const latestReport = getLatestAiReport_(targetMonth);
  const cloudSettings = getCloudSettings_();
  const config = getConfig();
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  return {
    ok: true,
    syncedAt: Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss'),
    summary: summary,
    rawLogs: rawLogs,
    latestReport: latestReport,
    cloudSettings: cloudSettings,
    systemStatus: {
      hasGeminiKey: Boolean(config.geminiApiKey),
      hasLineToken: Boolean(config.lineToken),
      hasDashboardToken: Boolean(config.dashboardToken),
      driveFolderId: config.driveFolderId || '',
      spreadsheetUrl: ss ? ss.getUrl() : '',
      webAppUrl: config.webAppUrl || '',
      mobileDashboardUrl: getMobileDashboardUrl_()
    }
  };
}

function handleDashboardApi_(action, params) {
  try {
    const config = getConfig();
    if (config.dashboardToken && params.token !== config.dashboardToken) {
      return jsonResponse_({ ok: false, error: '安全通行碼 (DASHBOARD_ACCESS_TOKEN) 驗證失敗' });
    }

    if (action === 'bootstrap') {
      return jsonResponse_(getDashboardBootstrapData(params.yearMonth));
    }

    if (action === 'setup_rich_menu') {
      if (params.githubPagesUrl) {
        saveCloudSettingsAndBudgets_({ settings: { githubPagesUrl: String(params.githubPagesUrl).trim() } });
      }
      const res = setupLineRichMenu(params.imageBase64 || '', params.imageMimeType || 'image/png');
      return jsonResponse_(res);
    }

    if (action === 'run_diagnosis') {
      const report = generateAiFinancialDiagnosis_(params.yearMonth, 'WEB_DASHBOARD', Boolean(params.calibrateCategories));
      return jsonResponse_({
        ok: true,
        report: report,
        summary: getMonthlySummaryData_(params.yearMonth),
        cloudSettings: getCloudSettings_()
      });
    }

    if (action === 'run_monthly_audit') {
      const report = runMonthlyCategoryAuditAndDiagnosis_(params.yearMonth, 'WEB_MONTHLY_AUDIT');
      return jsonResponse_({
        ok: true,
        report: report,
        summary: getMonthlySummaryData_(params.yearMonth),
        cloudSettings: getCloudSettings_()
      });
    }

    if (action === 'ask_ai') {
      const res = askGeminiAboutFinances_(params.question || '請分析我本月的消費重點', params.yearMonth);
      return jsonResponse_(res);
    }

    if (action === 'add_manual_tx') {
      const item = params.transaction || {};
      const saved = saveTransactionsBatch_([item], { logId: 'WEB-MANUAL', driveUrl: '' });
      return jsonResponse_({
        ok: true,
        batch: saved,
        summary: getMonthlySummaryData_(params.yearMonth)
      });
    }

    if (action === 'parse_and_save') {
      let driveFileId = '';
      let driveUrl = '';
      let preloadedImage = null;

      if (params.imageBase64) {
        const mimeType = params.imageMimeType || 'image/jpeg';
        const ext = mimeType.indexOf('png') !== -1 ? 'png' : 'jpg';
        const timestamp = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyyMMdd_HHmmss');
        const bytes = Utilities.base64Decode(params.imageBase64);
        const blob = Utilities.newBlob(bytes, mimeType, `WebReceipt_${timestamp}.${ext}`);
        const folder = ensureDriveFolder_();
        const file = folder.createFile(blob);
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
        driveFileId = file.getId();
        driveUrl = `https://drive.google.com/file/d/${driveFileId}/view`;
        preloadedImage = { base64: params.imageBase64, mimeType: mimeType };
      }

      const logEntry = createRawLog_({
        userId: 'CLOUD-WEB-DASHBOARD',
        messageType: preloadedImage ? 'image' : 'text',
        rawText: params.rawText || (preloadedImage ? '[網頁上傳收據]' : ''),
        driveFileId: driveFileId,
        driveUrl: driveUrl
      });

      const procRes = processRawLogEntry_(logEntry, null, preloadedImage);
      return jsonResponse_({
        ok: procRes.ok,
        parsedCount: procRes.count || 0,
        batchId: procRes.batchId || '',
        driveUrl: driveUrl,
        error: procRes.error || ''
      });
    }

    if (action === 'delete_tx') {
      const res = deleteTransactionById_(params.txId);
      return jsonResponse_(res);
    }

    if (action === 'retry_failed') {
      const res = retryFailedLogs();
      return jsonResponse_({ ok: true, result: res });
    }

    if (action === 'update_budget') {
      const res = updateCategoryBudget_(params.category, Number(params.budget || 0));
      return jsonResponse_(res);
    }

    if (action === 'save_all_settings') {
      const res = saveCloudSettingsAndBudgets_(params);
      return jsonResponse_(res);
    }

    return jsonResponse_({ ok: false, error: '未知的 API Action: ' + action });
  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

/**
 * 讀取 Settings 與 Budgets 工作表中的跨裝置設定（確保前後端欄位名稱 100% 對齊）
 */
function getCloudSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    setupSpreadsheet();
    settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  }

  const out = {
    accountBookName: '極簡雲端帳本',
    defaultCurrency: 'TWD',
    currency: 'TWD',
    defaultPaymentMethod: '現金',
    parseModel: DEFAULT_PARSE_MODEL,
    aiParseModel: DEFAULT_PARSE_MODEL,
    diagnosisModel: DEFAULT_DIAGNOSIS_MODEL,
    aiDiagnosisModel: DEFAULT_DIAGNOSIS_MODEL,
    receiptSplitMode: 'split_items',
    lineTriggerMode: 'menu_first',
    githubPagesUrl: DEFAULT_GITHUB_PAGES_URL,
    monthlyAutoAudit: 'ON',
    paymentMethods: '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay',
    incomeCategories: INCOME_CATEGORIES.join(','),
    subcategoryTaxonomy: JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY),
    lastMonthlyAuditMonth: '',
    activeRichMenuId: '',
    expenseCategories: EXPENSE_CATEGORIES.slice()
  };

  if (settingsSheet && settingsSheet.getLastRow() > 1) {
    const data = settingsSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const k = String(data[i][0] || '').trim();
      const v = String(data[i][1] !== undefined && data[i][1] !== null ? data[i][1] : '').trim();
      if (k && v !== '[object Object]') {
        out[k] = v;
      }
    }
  }

  // 雙向別名對齊，確保任何版本的前端都能讀取到正確設定值
  out.currency = out.currency || out.defaultCurrency || 'TWD';
  out.defaultCurrency = out.currency;
  out.aiParseModel = out.aiParseModel || out.parseModel || DEFAULT_PARSE_MODEL;
  out.parseModel = out.aiParseModel;
  out.aiDiagnosisModel = out.aiDiagnosisModel || out.diagnosisModel || DEFAULT_DIAGNOSIS_MODEL;
  out.diagnosisModel = out.aiDiagnosisModel;

  try {
    const parsedTax = typeof out.subcategoryTaxonomy === 'object'
      ? out.subcategoryTaxonomy
      : JSON.parse(out.subcategoryTaxonomy || '{}');
    out.subcategoryTaxonomyObj = (parsedTax && Object.keys(parsedTax).length > 0)
      ? parsedTax
      : JSON.parse(JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY));
  } catch (e) {
    out.subcategoryTaxonomyObj = JSON.parse(JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY));
  }

  const budgetSheet = ss.getSheetByName(SHEET_BUDGETS);
  const budgetsList = [];
  if (budgetSheet && budgetSheet.getLastRow() > 1) {
    const bData = budgetSheet.getDataRange().getValues();
    for (let i = 1; i < bData.length; i++) {
      const cat = String(bData[i][0] || '').trim();
      if (cat) {
        const amt = Number(bData[i][1] || 0);
        budgetsList.push({
          category: cat,
          budget: amt,
          monthlyBudget: amt,
          ruleGroup: String(bData[i][2] || '必要支出 (Needs)'),
          note: String(bData[i][3] || '')
        });
      }
    }
  }
  if (budgetsList.length > 0) {
    out.expenseCategories = budgetsList.map(b => b.category);
  }
  out.budgetsList = budgetsList;

  // 同時提供 settings 子物件，保持與前端結構 100% 相容
  out.settings = {
    accountBookName: out.accountBookName,
    currency: out.currency,
    defaultCurrency: out.defaultCurrency,
    defaultPaymentMethod: out.defaultPaymentMethod,
    aiParseModel: out.aiParseModel,
    parseModel: out.parseModel,
    aiDiagnosisModel: out.aiDiagnosisModel,
    diagnosisModel: out.diagnosisModel,
    receiptSplitMode: out.receiptSplitMode,
    lineTriggerMode: out.lineTriggerMode,
    githubPagesUrl: out.githubPagesUrl,
    monthlyAutoAudit: out.monthlyAutoAudit,
    activeRichMenuId: out.activeRichMenuId,
    subcategoryTaxonomy: out.subcategoryTaxonomyObj
  };

  return out;
}

/**
 * 一次快速儲存並跨裝置同步：偏好設定 (Settings 表) + 分類預算清單 (Budgets 表) + 金鑰屬性 (Script Properties)
 */
function saveCloudSettingsAndBudgets_(params) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');

    // 1. 更新 Settings 工作表
    if (params.settings && typeof params.settings === 'object') {
      let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
      if (!settingsSheet) {
        setupSpreadsheet();
        settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
      }

      const normalizedSettings = Object.assign({}, params.settings);
      if (normalizedSettings.currency) normalizedSettings.defaultCurrency = normalizedSettings.currency;
      if (normalizedSettings.defaultCurrency) normalizedSettings.currency = normalizedSettings.defaultCurrency;
      if (normalizedSettings.aiParseModel) normalizedSettings.parseModel = normalizedSettings.aiParseModel;
      if (normalizedSettings.parseModel) normalizedSettings.aiParseModel = normalizedSettings.parseModel;
      if (normalizedSettings.aiDiagnosisModel) normalizedSettings.diagnosisModel = normalizedSettings.aiDiagnosisModel;
      if (normalizedSettings.diagnosisModel) normalizedSettings.aiDiagnosisModel = normalizedSettings.diagnosisModel;

      const existing = settingsSheet.getDataRange().getValues();
      const keyRowMap = {};
      for (let i = 1; i < existing.length; i++) {
        keyRowMap[String(existing[i][0])] = i + 1;
      }

      Object.keys(normalizedSettings).forEach(k => {
        if (k === 'budgetsList' || k === 'expenseCategories' || k === 'settings' || k === 'subcategoryTaxonomyObj') return;
        const rawVal = normalizedSettings[k];
        if (rawVal === undefined) return;
        const val = (typeof rawVal === 'object' && rawVal !== null)
          ? JSON.stringify(rawVal)
          : String(rawVal);

        if (keyRowMap[k]) {
          settingsSheet.getRange(keyRowMap[k], 2).setValue(val);
          settingsSheet.getRange(keyRowMap[k], 4).setValue(nowStr);
        } else {
          settingsSheet.appendRow([k, val, '跨裝置同步設定', nowStr]);
          keyRowMap[k] = settingsSheet.getLastRow();
        }
      });

      const props = PropertiesService.getScriptProperties();
      if (normalizedSettings.parseModel) {
        props.setProperty('GEMINI_PARSE_MODEL', String(normalizedSettings.parseModel));
      }
      if (normalizedSettings.diagnosisModel) {
        props.setProperty('GEMINI_DIAGNOSIS_MODEL', String(normalizedSettings.diagnosisModel));
      }
    }

    // 2. 批次更新 Budgets 分類與月度預算工作表（相容 budget 與 monthlyBudget 欄位）
    if (Array.isArray(params.budgets) && params.budgets.length > 0) {
      let budgetSheet = ss.getSheetByName(SHEET_BUDGETS);
      if (!budgetSheet) {
        setupSpreadsheet();
        budgetSheet = ss.getSheetByName(SHEET_BUDGETS);
      }
      if (budgetSheet.getLastRow() > 1) {
        budgetSheet.getRange(2, 1, budgetSheet.getLastRow() - 1, 4).clearContent();
      }
      const rows = params.budgets
        .filter(b => b && String(b.category || '').trim())
        .map(b => {
          const amt = b.budget !== undefined ? Number(b.budget) : Number(b.monthlyBudget || 0);
          return [
            String(b.category).trim(),
            Math.max(0, isNaN(amt) ? 0 : amt),
            String(b.ruleGroup || '必要支出 (Needs)'),
            String(b.note || '')
          ];
        });
      if (rows.length > 0) {
        budgetSheet.getRange(2, 1, rows.length, 4).setValues(rows);
      }
    }

    // 3. 更新後端金鑰 Script Properties（相容 secrets 與 scriptProperties）
    const sec = Object.assign({}, params.secrets || {}, params.scriptProperties || {});
    if (Object.keys(sec).length > 0) {
      const props = PropertiesService.getScriptProperties();
      const gemKey = (sec.geminiApiKey || sec.GEMINI_API_KEY || '').trim();
      const lineTok = (sec.lineToken || sec.LINE_CHANNEL_ACCESS_TOKEN || '').trim();
      const drvId = (sec.driveFolderId || sec.DRIVE_FOLDER_ID || '').trim();
      if (gemKey) props.setProperty('GEMINI_API_KEY', gemKey);
      if (lineTok) props.setProperty('LINE_CHANNEL_ACCESS_TOKEN', lineTok);
      if (drvId) props.setProperty('DRIVE_FOLDER_ID', drvId);
    }

    SpreadsheetApp.flush();
    return {
      ok: true,
      syncedAt: nowStr,
      cloudSettings: getCloudSettings_(),
      message: '✅ 設定已成功寫入 Google Sheets，所有裝置與 LINE 皆已同步！'
    };
  } finally {
    lock.releaseLock();
  }
}

function getRecentRawLogs_(limit) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_RAW_LOGS);
  if (!sheet || sheet.getLastRow() <= 1) {
    return { logs: [], pendingOrFailedCount: 0 };
  }

  const data = sheet.getDataRange().getValues();
  const logs = [];
  let pendingOrFailedCount = 0;

  for (let i = data.length - 1; i >= 1; i--) {
    const status = String(data[i][7] || '');
    if (status === 'FAILED' || status === 'PENDING') {
      pendingOrFailedCount++;
    }
    if (logs.length < (limit || 30)) {
      logs.push({
        logId: String(data[i][0]),
        receivedAt: String(data[i][1]),
        userId: String(data[i][2]),
        messageType: String(data[i][3]),
        rawText: String(data[i][4]),
        driveFileId: String(data[i][5]),
        driveUrl: String(data[i][6]),
        status: status,
        parsedCount: Number(data[i][8] || 0),
        errorMessage: String(data[i][9] || ''),
        retryCount: Number(data[i][10] || 0),
        updatedAt: String(data[i][11] || '')
      });
    }
  }

  return { logs: logs, pendingOrFailedCount: pendingOrFailedCount };
}

function getLatestAiReport_(yearMonth) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(SHEET_AI_REPORTS);
  if (!sheet || sheet.getLastRow() <= 1) return null;

  const data = sheet.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (!yearMonth || yearMonth === 'ALL' || String(data[i][2]) === String(yearMonth)) {
      try {
        return JSON.parse(String(data[i][6]));
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

function updateCategoryBudget_(category, newBudget) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET_BUDGETS);
    if (!sheet) return { ok: false, message: '找不到 Budgets 工作表' };

    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][0]) === String(category)) {
        sheet.getRange(i + 1, 2).setValue(newBudget);
        SpreadsheetApp.flush();
        return { ok: true, message: `已更新「${category}」月預算為 $${newBudget}` };
      }
    }
    sheet.appendRow([category, newBudget, '想要支出 (Wants)', '自訂分類']);
    SpreadsheetApp.flush();
    return { ok: true, message: `已新增「${category}」月預算 $${newBudget}` };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ============================================================================
 * 10. LINE 極簡風互動小卡建構器 (Flex Messages + Quick Reply)
 * ============================================================================
 */

/**
 * 當使用者點選圖文選單「✍️ 點選記帳」或「📸 收據記帳」後回傳的啟動卡片
 */
function buildAccountingStartedFlex_(inputMode) {
  const isImage = inputMode === 'image';
  const mobileUrl = getMobileDashboardUrl_();

  return {
    type: 'flex',
    altText: isImage ? '📸 已開啟收據記帳模式，請傳送照片' : '✍️ 已開啟記帳模式，請輸入消費內容',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: isImage ? '📸 收據記帳模式已啟動' : '✍️ 文字記帳模式已啟動',
            color: '#ffffff',
            weight: 'bold',
            size: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: isImage
              ? '請點選下方按鈕拍攝或選擇您的發票 / 收據照片上傳：'
              : '請輸入這筆消費內容（支援單則多筆），例如：',
            size: 'xs',
            color: '#334155',
            wrap: true
          },
          {
            type: 'text',
            text: isImage
              ? '• 紙本發票、超商明細、餐廳收據或網購截圖'
              : '• 午餐便當 120\n• 早餐45 拿鐵65 捷運30\n• 10/23 薪水入帳 55000',
            size: 'xs',
            color: '#64748b',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '❌ 取消記帳',
              data: 'action=cancel_accounting',
              displayText: '取消記帳'
            }
          },
          mobileUrl ? {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'uri',
              label: '📱 手機查帳',
              uri: mobileUrl
            }
          } : { type: 'filler' }
        ]
      }
    },
    quickReply: {
      items: [
        {
          type: 'action',
          action: { type: 'camera', label: '📷 拍攝收據' }
        },
        {
          type: 'action',
          action: { type: 'cameraRoll', label: '🖼️ 相簿選圖' }
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '❌ 取消記帳',
            data: 'action=cancel_accounting',
            displayText: '取消記帳'
          }
        }
      ]
    }
  };
}

/**
 * 當使用者「未點選圖文選單」而直接傳送文字或圖片時的防誤觸提示卡
 */
function buildNotTriggeredPromptFlex_(draftType, previewText) {
  const mobileUrl = getMobileDashboardUrl_();
  const shortPreview = String(previewText || '').slice(0, 40);

  const footerBtns = [
    {
      type: 'button',
      style: 'primary',
      color: '#0f172a',
      height: 'sm',
      action: {
        type: 'postback',
        label: '✅ 點選觸發此筆記帳',
        data: 'action=trigger_pending_draft',
        displayText: '✅ 確認觸發記帳'
      }
    },
    {
      type: 'box',
      layout: 'horizontal',
      spacing: 'sm',
      contents: [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'postback',
            label: '忽略訊息',
            data: 'action=cancel_accounting'
          }
        },
        mobileUrl ? {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'uri',
            label: '📱 手機查帳',
            uri: mobileUrl
          }
        } : { type: 'filler' }
      ]
    }
  ];

  return {
    type: 'flex',
    altText: '⏸️ 尚未觸發記帳：請點選確認按鈕或圖文選單開始記帳',
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#334155',
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: '⏸️ 直接傳送不會自動記帳',
            color: '#ffffff',
            weight: 'bold',
            size: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        spacing: 'sm',
        contents: [
          {
            type: 'text',
            text: `收到內容：「${shortPreview}」`,
            size: 'xs',
            weight: 'bold',
            color: '#0f172a',
            wrap: true
          },
          {
            type: 'text',
            text: '為避免日常對話誤觸，請先點選下方圖文選單【✍️ 點選記帳】，或直接點選下方按鈕將此筆內容入帳：',
            size: 'xs',
            color: '#64748b',
            wrap: true
          }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerBtns
      }
    }
  };
}

/**
 * 雙重確認模式下的「AI 解析預覽確認卡」
 */
function buildPreviewConfirmFlex_(items, assistantNote) {
  const totalAmount = items.reduce((acc, t) => acc + (Number(t.amount) || 0), 0);
  const rows = items.slice(0, 6).map(t => ({
    type: 'box',
    layout: 'horizontal',
    margin: 'xs',
    contents: [
      {
        type: 'text',
        text: `${t.category} › ${t.subcategory || '一般'}｜${t.item}`,
        size: 'xs',
        color: '#334155',
        flex: 4,
        wrap: true
      },
      {
        type: 'text',
        text: `$${Number(t.amount || 0).toLocaleString()}`,
        size: 'xs',
        weight: 'bold',
        color: '#0f172a',
        align: 'end',
        flex: 2
      }
    ]
  }));

  return {
    type: 'flex',
    altText: `📋 記帳預覽：共 ${items.length} 筆 ($${totalAmount.toLocaleString()})，請點選確認入帳`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: '📋 AI 記帳預覽（請點選確認入帳）', color: '#94a3b8', size: 'xs' },
          { type: 'text', text: `NT$ ${totalAmount.toLocaleString()}`, color: '#ffffff', weight: 'bold', size: 'xl', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: rows
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: '取消',
              data: 'action=cancel_accounting'
            }
          },
          {
            type: 'button',
            style: 'primary',
            color: '#10b981',
            height: 'sm',
            action: {
              type: 'postback',
              label: '✅ 確認入帳',
              data: 'action=confirm_preview_save',
              displayText: '✅ 確認寫入帳本'
            }
          }
        ]
      }
    }
  };
}

/**
 * 記帳完成回傳的極簡確認小卡（內建「📱 手機版檢視帳務」、「➕ 再記一筆」、「↩️ 撤銷此筆」）
 */
function buildReceiptConfirmFlex_(savedBatch, assistantNote) {
  const txs = savedBatch.transactions;
  const totalAmount = txs.reduce((acc, t) => acc + t.amount, 0);
  const isIncome = txs.every(t => t.type === '收入');
  const headerColor = isIncome ? '#059669' : '#0f172a';
  const mobileUrl = getMobileDashboardUrl_();

  const itemRows = txs.slice(0, 8).map(t => ({
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      {
        type: 'text',
        text: `${t.category}${t.subcategory ? ' › ' + t.subcategory : ''}｜${t.item}`,
        size: 'xs',
        color: '#334155',
        flex: 4,
        wrap: true
      },
      {
        type: 'text',
        text: `${t.type === '收入' ? '+' : ''}$${t.amount.toLocaleString()}`,
        size: 'xs',
        color: t.type === '收入' ? '#059669' : '#0f172a',
        weight: 'bold',
        align: 'end',
        flex: 2
      }
    ]
  }));

  const firstTx = txs[0];
  const footerButtons = [];

  if (mobileUrl) {
    footerButtons.push({
      type: 'button',
      style: 'primary',
      color: '#0f172a',
      height: 'sm',
      action: {
        type: 'uri',
        label: '📱 手機版檢視帳務 (網頁)',
        uri: mobileUrl
      }
    });
  }

  footerButtons.push({
    type: 'box',
    layout: 'horizontal',
    spacing: 'sm',
    contents: [
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: '➕ 再記一筆',
          data: 'action=start_accounting&mode=text',
          displayText: '✍️ 點選開始記帳'
        }
      },
      {
        type: 'button',
        style: 'secondary',
        height: 'sm',
        action: {
          type: 'postback',
          label: '↩️ 撤銷此筆',
          data: `action=delete_batch&batchId=${savedBatch.batchId}`,
          displayText: '↩️ 撤銷此筆記帳'
        }
      }
    ]
  });

  return {
    type: 'flex',
    altText: `✅ 已記帳 ${txs.length} 筆，共 $${totalAmount.toLocaleString()}`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '14px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: isIncome ? '💰 收入已入帳' : '✅ 已寫入 Google Sheet',
                color: '#ffffff',
                weight: 'bold',
                size: 'xs',
                flex: 3
              },
              {
                type: 'text',
                text: `${firstTx.date} · ${firstTx.paymentMethod}`,
                color: '#cbd5e1',
                size: 'xxs',
                align: 'end',
                gravity: 'center',
                flex: 3
              }
            ]
          },
          {
            type: 'text',
            text: `NT$ ${totalAmount.toLocaleString()}`,
            color: '#ffffff',
            weight: 'bold',
            size: 'xl',
            margin: 'sm'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: itemRows
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerButtons
      }
    },
    quickReply: buildStandardQuickReply_()
  };
}

function buildMonthlySummaryFlex_(summary) {
  const topCats = summary.categories.filter(c => c.amount > 0).slice(0, 5);
  const catRows = topCats.length > 0 ? topCats.map(c => {
    const pct = summary.totalExpense > 0 ? Math.round((c.amount / summary.totalExpense) * 100) : 0;
    return {
      type: 'box',
      layout: 'horizontal',
      margin: 'xs',
      contents: [
        { type: 'text', text: `${c.category} (${pct}%)`, size: 'xs', color: '#334155', flex: 3 },
        { type: 'text', text: `$${c.amount.toLocaleString()}`, size: 'xs', weight: 'bold', align: 'end', flex: 2 }
      ]
    };
  }) : [{ type: 'text', text: '本月尚無支出紀錄', size: 'xs', color: '#94a3b8' }];

  const mobileUrl = getMobileDashboardUrl_();
  const footerBtns = [];

  if (mobileUrl) {
    footerBtns.push({
      type: 'button',
      style: 'primary',
      color: '#0f172a',
      height: 'sm',
      action: {
        type: 'uri',
        label: '📱 開啟手機版網頁檢視帳務',
        uri: mobileUrl
      }
    });
  }

  return {
    type: 'flex',
    altText: `📊 ${summary.yearMonth} 帳務摘要`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: `📊 ${summary.yearMonth} 帳務摘要`, color: '#94a3b8', weight: 'bold', size: 'xs' },
          { type: 'text', text: `支出 NT$ ${summary.totalExpense.toLocaleString()}`, color: '#ffffff', weight: 'bold', size: 'xl', margin: 'xs' },
          { type: 'text', text: `收入 $${summary.totalIncome.toLocaleString()} ｜ 結餘 $${summary.netSavings.toLocaleString()}`, color: '#cbd5e1', size: 'xxs', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: `預算使用率：${summary.budgetUsageRate}% （上限 $${summary.totalMonthlyBudget.toLocaleString()}）`,
            size: 'xs',
            weight: 'bold',
            color: summary.budgetUsageRate > 90 ? '#e11d48' : '#059669'
          },
          { type: 'separator', margin: 'sm' },
          { type: 'box', layout: 'vertical', margin: 'sm', contents: catRows }
        ]
      },
      footer: footerBtns.length > 0 ? {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerBtns
      } : undefined
    },
    quickReply: buildStandardQuickReply_()
  };
}

function buildDiagnosisFlexMessage_(report) {
  const mobileUrl = getMobileDashboardUrl_();
  const tipsRows = (report.actionableTips || []).slice(0, 3).map((tip, idx) => ({
    type: 'box',
    layout: 'vertical',
    margin: 'sm',
    contents: [
      {
        type: 'text',
        text: `${idx + 1}. ${tip.action}（${tip.expectedImpact}）`,
        size: 'xs',
        weight: 'bold',
        color: '#0f172a',
        wrap: true
      },
      {
        type: 'text',
        text: tip.description,
        size: 'xxs',
        color: '#64748b',
        wrap: true,
        margin: 'xs'
      }
    ]
  }));

  return {
    type: 'flex',
    altText: `✨ AI 財務診斷：${report.healthScore} 分`,
    contents: {
      type: 'bubble',
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '14px',
        contents: [
          { type: 'text', text: `✨ ${report.period} AI 財務診斷`, color: '#94a3b8', size: 'xs', weight: 'bold' },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'xs',
            contents: [
              { type: 'text', text: `${report.healthScore}`, color: '#ffffff', size: 'xxl', weight: 'bold', flex: 0 },
              { type: 'text', text: ` / 100 (${report.healthGrade})`, color: '#cbd5e1', size: 'xs', margin: 'sm' }
            ]
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '14px',
        contents: [
          {
            type: 'text',
            text: report.executiveSummary || '',
            size: 'xs',
            color: '#334155',
            wrap: true
          },
          { type: 'separator', margin: 'sm' },
          {
            type: 'box',
            layout: 'vertical',
            contents: tipsRows
          }
        ]
      },
      footer: mobileUrl ? {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'uri',
              label: '📱 手機版查看完整報表',
              uri: mobileUrl
            }
          }
        ]
      } : undefined
    },
    quickReply: buildStandardQuickReply_()
  };
}

function buildStandardQuickReply_() {
  const mobileUrl = getMobileDashboardUrl_();
  const items = [
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '✍️ 點選記帳',
        data: 'action=start_accounting&mode=text',
        displayText: '✍️ 點選開始記帳'
      }
    },
    {
      type: 'action',
      action: {
        type: 'postback',
        label: '📸 收據記帳',
        data: 'action=start_accounting&mode=image',
        displayText: '📸 拍收據記帳'
      }
    }
  ];

  if (mobileUrl) {
    items.push({
      type: 'action',
      action: {
        type: 'uri',
        label: '📱 手機檢視帳務',
        uri: mobileUrl
      }
    });
  }

  items.push({
    type: 'action',
    action: {
      type: 'postback',
      label: '📊 本月摘要',
      data: 'action=monthly_summary',
      displayText: '📊 查看本月帳務摘要'
    }
  });

  return { items: items };
}

function replyLineText_(replyToken, text) {
  replyLineMessages_(replyToken, [
    {
      type: 'text',
      text: text,
      quickReply: buildStandardQuickReply_()
    }
  ]);
}

function replyLineMessages_(replyToken, messages) {
  const config = getConfig();
  if (!config.lineToken || !replyToken) return;

  UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + config.lineToken },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: messages
    }),
    muteHttpExceptions: true
  });
}

/**
 * ============================================================================
 * 11. 輔助工具函式
 * ============================================================================
 */
function formatDateCell_(val) {
  if (!val) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, 'Asia/Taipei', 'yyyy-MM-dd');
  }
  return String(val).trim().slice(0, 10);
}

function formatTimeCell_(val) {
  if (!val) return '';
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val.getTime())) {
    return Utilities.formatDate(val, 'Asia/Taipei', 'HH:mm');
  }
  return String(val).trim().slice(0, 5);
}

function parseQueryString_(qs) {
  const out = {};
  if (!qs) return out;
  qs.split('&').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx > -1) {
      const k = decodeURIComponent(pair.slice(0, idx));
      const v = decodeURIComponent(pair.slice(idx + 1));
      out[k] = v;
    }
  });
  return out;
}
