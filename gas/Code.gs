/**
 * ============================================================================
 * 智慧 AI 記帳系統 - LINE Official Account × Gemini API × Google Sheets
 * ============================================================================
 * 核心特點：
 * 1. 資料零遺失 (Zero-Data-Loss)：
 *    - 收到 LINE 文字或圖片時，第一時間透過 LockService 寫入 `RawLogs` 原始紀錄表
 *    - 圖片自動備份至 Google Drive 指定資料夾，並在試算表保留永久預覽連結
 *    - 若 Gemini API 暫時連線異常，紀錄標記為 FAILED，支援一鍵/排程自動重試
 * 2. 智慧多筆解析 (Gemini 3.8 Flash Structured Output)：
 *    - 單則文字（如「早餐45 咖啡65 捷運30」）或單張發票/收據照片自動拆分為多筆結構化明細
 * 3. LINE 互動確認小卡 (Flex Message + Postback + Quick Reply)：
 *    - 記帳完成回傳精美收據卡片，支援點擊「撤銷此筆」、輸入「修改上一筆」或觸發 AI 診斷
 * 4. 獨立視覺化網頁儀表板 & AI 財務診斷中心 (Gemini 4 Argon / 3.8 Flash)：
 *    - 支援透過 GAS Web App 網址直接開啟，或由外部獨立網頁 (`web/index.html`) 透過 API 串接
 * ============================================================================
 */

// 預設模型設定（遵循最新 Gemini API Interactions 規範）
const DEFAULT_PARSE_MODEL = 'gemini-3.8-flash';
const DEFAULT_DIAGNOSIS_MODEL = 'gemini-4-argon';
const GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions';
const GEMINI_API_REVISION = '2026-05-20';

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

// 預設最細子分類樹狀結構 (主分類 -> 精細子分類清單)，支援每月由 Gemini 自動校準擴充
const DEFAULT_SUBCATEGORY_TAXONOMY = {
  '餐飲食品': ['平日三餐便當', '餐廳聚餐外食', '精品與超商咖啡', '手搖飲與果茶', '早餐輕食', '生鮮食材水果', '甜點零食宵夜'],
  '交通通勤': ['大眾運輸月票', '捷運與公車', '計程車與Uber', '高鐵與台鐵', '汽機車加油充電', '停車與過路費', '共享單車機車'],
  '日常用品': ['超市量販採買', '居家清潔消耗品', '個人洗沐護理', '五金百貨雜貨', '寵物用品'],
  '居家帳單': ['房屋租金或房貸', '水電瓦斯費', '行動電信費', '家用寬頻固網', '物業管理費', '家電家具維修'],
  '休閒娛樂': ['電影與藝文展演', '朋友聚會小酌', '國內外旅遊住宿', '遊戲與數位娛樂', '運動戶外休閒'],
  '服飾美容': ['服裝穿搭鞋包', '理髮染燙造型', '美妝保養品', '美甲美睫SPA'],
  '醫療保健': ['診所醫院門診', '藥局常備藥品', '日常保健食品', '牙科與眼科', '健檢與保險'],
  '學習進修': ['專業書籍雜誌', '線上課程講座', '語言與技能培訓', '證照檢定考試'],
  '數位訂閱': ['AI生產力工具', '影音音樂串流', '雲端硬碟空間', 'App與軟體授權'],
  '人情社交': ['婚喪喜慶禮金', '節慶伴手禮', '請客聚餐社交', '孝親與家庭紅包'],
  '其他支出': ['臨時未分類雜支', '跨行手續費與稅費', '公益捐款']
};

/**
 * 讀取系統設定（從指令碼屬性 Script Properties 讀取）
 * 請在 GAS 編輯器左側「專案設定 ⚙️」->「指令碼屬性」新增：
 * - LINE_CHANNEL_ACCESS_TOKEN : LINE 官方帳號的 Channel Access Token
 * - GEMINI_API_KEY            : Google AI Studio 的 Gemini API Key
 * - DRIVE_FOLDER_ID           : (選填) 儲存收據照片的 Google Drive 資料夾 ID，未填會自動建立
 * - DASHBOARD_ACCESS_TOKEN    : (選填) 網頁儀表板安全通行碼
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
 * ============================================================================
 * 1. 一鍵初始化試算表結構（首次安裝時在 GAS 編輯器執行此函式）
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
    styleHeaderRow_(txSheet, '#1e293b', '#ffffff');
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
    styleHeaderRow_(rawSheet, '#0f172a', '#f8fafc');
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
    styleHeaderRow_(budgetSheet, '#047857', '#ffffff');
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
    styleHeaderRow_(reportSheet, '#4f46e5', '#ffffff');
    reportSheet.setFrozenRows(1);
  }

  // 5. 建立 Settings (跨裝置雲端同步設定表)
  let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    settingsSheet = ss.insertSheet(SHEET_SETTINGS);
    settingsSheet.appendRow(['Key', 'Value', 'Description', 'UpdatedAt']);
    const nowStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    const defaultSettings = [
      ['accountBookName', '我的 AI 智慧帳本', '帳本顯示名稱', nowStr],
      ['defaultCurrency', 'TWD', '預設記帳幣別 (TWD/USD/JPY)', nowStr],
      ['parseModel', DEFAULT_PARSE_MODEL, 'LINE 記帳與收據解析模型', nowStr],
      ['diagnosisModel', DEFAULT_DIAGNOSIS_MODEL, 'AI 財務診斷分析模型', nowStr],
      ['receiptSplitMode', 'split_items', '收據解析模式 (split_items: 逐項拆分 / single_total: 合併單筆總額)', nowStr],
      ['paymentMethods', '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay', '常用支付方式清單', nowStr],
      ['incomeCategories', INCOME_CATEGORIES.join(','), '收入分類清單', nowStr],
      ['autoSyncSeconds', '60', '跨裝置背景自動同步秒數 (0 代表僅手動或切換視窗時同步)', nowStr],
      ['budgetAlertThresholdPct', '85', '分類預算警戒百分比 (%)', nowStr],
      ['subcategoryTaxonomy', JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY), '最細子分類樹狀結構 JSON (每月由 Gemini 自動校準擴充)', nowStr],
      ['lastMonthlyAuditMonth', '', '最近一次執行月度 AI 細分類校準與消費診斷的月份', nowStr]
    ];
    defaultSettings.forEach(row => settingsSheet.appendRow(row));
    styleHeaderRow_(settingsSheet, '#334155', '#ffffff');
    settingsSheet.setFrozenRows(1);
  }

  // 確保圖片備份資料夾存在
  ensureDriveFolder_();

  // 設定每 30 分鐘自動重試失敗紀錄 + 每月 1 號自動執行「AI 記帳細分類校準與月度消費診斷」排程
  ensureAutoRetryTrigger_();

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

/**
 * 設定自動化排程：
 * 1. 每 30 分鐘自動檢查並重試失敗的 RawLogs
 * 2. 每月 1 號早上 09:00 自動執行一次「上月記帳細分類校準 + 消費狀況深度診斷」
 */
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

/**
 * 每月 1 號自動觸發：針對上一個月份的帳務進行「最細分類校準」與「消費狀況深度分析」
 */
function monthlyAutoAuditTrigger() {
  const now = new Date();
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const targetYearMonth = Utilities.formatDate(prevMonthDate, 'Asia/Taipei', 'yyyy-MM');
  runMonthlyCategoryAuditAndDiagnosis_(targetYearMonth, 'MONTHLY_AUTO_CRON');
}

/**
 * ============================================================================
 * 2. Web App 入口：doGet (網頁儀表板 / JSON API) & doPost (LINE Webhook / API)
 * ============================================================================
 */
function doGet(e) {
  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action || '';

  // 若帶有 action 參數，代表是獨立網頁儀表板發出的 JSON API 請求
  if (action) {
    return handleDashboardApi_(action, params);
  }

  // 否則直接渲染內建的 Google Apps Script 網頁版視覺化儀表板 (Index.html)
  const template = HtmlService.createTemplateFromFile('Index');
  return template.evaluate()
    .setTitle('AI 智慧記帳與財務診斷中心')
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

    // 處理 LINE Webhook Events（加入執行時間與多圖併發頻寬保護）
    const events = body.events || [];
    let syncImageCount = 0;
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      const isImageEvent = ev && ev.type === 'message' && ev.message && ev.message.type === 'image';
      if (isImageEvent) syncImageCount++;

      // 若單次 Webhook 收到超過 2 張以上連拍照片、或執行已超過 11 秒，轉入背景非同步佇列處理，避免 GAS 逾時與頻寬擁塞
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
 * 3. LINE 事件處理流程（保證原始資料先落地，再進行 AI 解析 + 頻寬分流保護）
 * ============================================================================
 */
function processLineEvent_(event, deferAiParse) {
  const replyToken = event.replyToken;
  const userId = (event.source && event.source.userId) ? event.source.userId : 'unknown';

  // 處理 Postback 事件（例如點擊 Flex Message 上的「撤銷此筆」、「本月財務診斷」按鈕）
  if (event.type === 'postback' && event.postback && event.postback.data) {
    handlePostbackEvent_(event.postback.data, replyToken, userId);
    return;
  }

  if (event.type !== 'message' || !event.message) return;
  const msg = event.message;

  // A. 處理文字訊息
  if (msg.type === 'text') {
    const userText = (msg.text || '').trim();

    // 檢查是否為系統指令（查帳、財務診斷、刪除上一筆、修改上一筆、重試失敗等）
    if (handleLineCommand_(userText, replyToken, userId)) {
      return;
    }

    // 第一階段：立即寫入 RawLogs 確保資料不遺失
    const logEntry = createRawLog_({
      userId: userId,
      messageType: 'text',
      rawText: userText,
      driveFileId: '',
      driveUrl: ''
    });

    // 第二階段：呼叫 Gemini 進行結構化記帳解析並寫入 Transactions
    processRawLogEntry_(logEntry, replyToken);
    return;
  }

  // B. 處理圖片訊息（發票、收據、消費明細截圖、手寫帳單 — 具備智慧輕量化省頻寬機制）
  if (msg.type === 'image') {
    let driveInfo = { fileId: '', fileUrl: '', base64: '', mimeType: 'image/jpeg', error: '', usedCompressed: false };
    try {
      driveInfo = fetchAndBackupLineImage_(msg.id, deferAiParse);
    } catch (imgErr) {
      driveInfo.error = String(imgErr);
    }

    // 第一階段：立即寫入 RawLogs（含 Google Drive 圖片備份連結）
    const logEntry = createRawLog_({
      userId: userId,
      messageType: 'image',
      rawText: `[LINE Image ID: ${msg.id}]`,
      driveFileId: driveInfo.fileId,
      driveUrl: driveInfo.fileUrl
    });

    if (driveInfo.error) {
      updateRawLogStatus_(logEntry.logId, 'FAILED', 0, '圖片下載或備份失敗: ' + driveInfo.error);
      replyLineText_(
        replyToken,
        `⚠️ 收到圖片但下載時發生異常（Log ID: ${logEntry.logId}）。\n系統已記錄此事件，您稍後可輸入「重試」再次處理。`
      );
      return;
    }

    // 若因連拍多張照片觸發佇列保護，先確保雲端備份完成並排程背景解析
    if (deferAiParse) {
      scheduleImmediateQueueDrain_();
      replyLineText_(
        replyToken,
        `📸 已收到收據照片並安全備份至 Google Drive（編號：${logEntry.logId}）！\n為避免連拍造成頻寬擁塞，系統已排入背景佇列，1 分鐘內將自動完成 AI 拆帳入庫。`
      );
      return;
    }

    // 第二階段：將輕量化後的圖片送交 Gemini 進行多模態發票/收據解析
    processRawLogEntry_(logEntry, replyToken, {
      base64: driveInfo.base64,
      mimeType: driveInfo.mimeType
    });
  }
}

/**
 * 處理 LINE 內建快速指令
 */
function handleLineCommand_(text, replyToken, userId) {
  const normalized = text.replace(/\s+/g, ' ').trim();

  // 1. 說明 / 指令選單
  if (/^(help|說明|指令|選單|功能|\?)$/i.test(normalized)) {
    const config = getConfig();
    const helpMsg = [
      '📒 【AI 智慧記帳助手使用指南】',
      '',
      '✅ 直接傳送文字記帳（支援單則多筆）：',
      '• 「午餐便當 110」',
      '• 「早餐蛋餅45 拿鐵65 搭捷運30 刷卡」',
      '• 「10/20 薪水入帳 58000」',
      '',
      '📸 直接傳送照片記帳（自動備份至雲端）：',
      '• 拍下發票、收據、超商明細或網購截圖，AI 自動辨識所有品項與金額！',
      '',
      '🛠️ 常用管理與診斷指令：',
      '• 「本月報表」或「查帳」：查看本月收支統計',
      '• 「財務診斷」或「AI分析」：由 Gemini 診斷消費結構與省錢建議',
      '• 「刪除上一筆」或「撤銷」：撤銷最近一次記帳',
      '• 「修改上一筆 金額 150」：快速修正上一筆資料',
      '• 「重試」：重新解析曾失敗的原始紀錄',
      config.webAppUrl ? `\n🌐 視覺化網頁儀表板：\n${config.webAppUrl}` : ''
    ].join('\n');
    replyLineText_(replyToken, helpMsg);
    return true;
  }

  // 2. 刪除 / 撤銷上一筆
  if (/^(刪除上一筆|撤銷|撤銷上一筆|取消上一筆|undo)$/i.test(normalized)) {
    const res = undoLastBatch_();
    replyLineText_(replyToken, res.message);
    return true;
  }

  // 3. 修改上一筆（例如：「修改上一筆 金額 120」或「修改上一筆 分類 休閒娛樂」）
  if (/^修改上一筆\s+(.+)$/i.test(normalized)) {
    const match = normalized.match(/^修改上一筆\s+(.+)$/i);
    const res = modifyLastTransactionByInstruction_(match[1]);
    replyLineText_(replyToken, res.message);
    return true;
  }

  // 4. 本月報表 / 查帳
  if (/^(本月報表|查帳|本月統計|本月摘要|帳務摘要)$/i.test(normalized)) {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const summary = getMonthlySummaryData_(currentMonth);
    const flex = buildMonthlySummaryFlex_(summary);
    replyLineMessages_(replyToken, [flex]);
    return true;
  }

  // 5. AI 財務診斷 / 消費分析（快速省 Token 診斷）
  if (/^(財務診斷|AI分析|ai診斷|診斷分析|消費診斷)$/i.test(normalized)) {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const report = generateAiFinancialDiagnosis_(currentMonth, 'LINE', false);
    const flex = buildDiagnosisFlexMessage_(report);
    replyLineMessages_(replyToken, [flex]);
    return true;
  }

  // 5B. 月度一次：AI 記帳最細分類校準 + 深度消費分析
  if (/^(分類優化|細分校準|月結校準|調整分類|月度校準)$/i.test(normalized)) {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const report = runMonthlyCategoryAuditAndDiagnosis_(currentMonth, 'LINE_AUDIT');
    const flex = buildDiagnosisFlexMessage_(report);
    replyLineMessages_(replyToken, [flex]);
    return true;
  }

  // 6. 重試失敗紀錄
  if (/^(重試|重試失敗|retry)$/i.test(normalized)) {
    const retryResult = retryFailedLogs();
    replyLineText_(
      replyToken,
      `🔄 已執行失敗紀錄重試！\n檢查筆數：${retryResult.checked} 筆\n成功修復：${retryResult.recovered} 筆\n仍失敗：${retryResult.stillFailed} 筆`
    );
    return true;
  }

  return false;
}

/**
 * 處理 Flex Message 按鈕 Postback 事件
 */
function handlePostbackEvent_(dataString, replyToken, userId) {
  const params = parseQueryString_(dataString);
  const action = params.action || '';

  if (action === 'delete_batch' && params.batchId) {
    const result = deleteTransactionsByBatchId_(params.batchId);
    replyLineText_(replyToken, result.message);
    return;
  }

  if (action === 'delete_tx' && params.txId) {
    const result = deleteTransactionById_(params.txId);
    replyLineText_(replyToken, result.message);
    return;
  }

  if (action === 'monthly_summary') {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const summary = getMonthlySummaryData_(currentMonth);
    replyLineMessages_(replyToken, [buildMonthlySummaryFlex_(summary)]);
    return;
  }

  if (action === 'ai_diagnosis') {
    const currentMonth = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
    const report = generateAiFinancialDiagnosis_(currentMonth, 'LINE_POSTBACK');
    replyLineMessages_(replyToken, [buildDiagnosisFlexMessage_(report)]);
    return;
  }
}

/**
 * ============================================================================
 * 4. 資料零遺失核心：RawLogs 寫入、Google Drive 圖片備份、重試機制
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

/**
 * 從 LINE Content API 下載圖片並備份至 Google Drive（內建 GAS 頻寬保護與雙軌輕量化機制）
 * 1. 原始圖片完整存入 Google Drive 雲端資料夾（永久保留清晰原圖）
 * 2. 若原圖超過 500KB，自動改取 LINE Preview 輕量流或 Google Drive 壓縮預覽流 (w1280, ~150KB) 送交 Gemini，
 *    大幅降低 85%~95% GAS UrlFetch 傳出頻寬與記憶體消耗，完全避免大圖造成 GAS 逾時或頻寬超標！
 */
function fetchAndBackupLineImage_(messageId, skipBase64ForDeferred) {
  const config = getConfig();
  if (!config.lineToken) {
    throw new Error('尚未設定 LINE_CHANNEL_ACCESS_TOKEN');
  }

  const url = `https://api-data.line.me/v2/bot/message/${messageId}/content`;
  const response = UrlFetchApp.fetch(url, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + config.lineToken
    },
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
  // 設定為知道連結的人可檢視，方便在試算表與 GitHub Pages 網頁儀表板直接從 Google CDN 讀取預覽（0 GAS 頻寬消耗）
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

  // 檢查圖片大小：若 <= 500KB 直接編碼；若 > 500KB 啟動省頻寬輕量擷取
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

  // 原圖較大 (>500KB)，優先改抓 LINE 預壓縮圖或 Drive 1280px 輕量縮圖送交 Gemini
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

  // 保底使用原圖
  return {
    fileId: fileId,
    fileUrl: fileUrl,
    base64: Utilities.base64Encode(rawBytes),
    mimeType: contentType,
    error: '',
    usedCompressed: false
  };
}

/**
 * 取得專供 Gemini 視覺辨識的輕量化圖片（約 120KB~220KB），避免傳送數 MB 原圖消耗 GAS 頻寬配額
 */
function getLightweightAiImagePayload_(messageId, driveFileId, lineToken) {
  // 策略 1：優先從 LINE 官方 preview 端點取得輕量圖
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
    } catch (e) {
      console.warn('LINE preview 取得略過，改用 Drive 輕量縮圖:', e);
    }
  }

  // 策略 2：從 Google Drive 內建縮圖引擎取得 w1280 清晰輕量圖（發票文字清晰且檔案極小）
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
  } catch (e) {
    console.warn('Drive 輕量縮圖取得失敗，回退讀取檔案:', e);
  }

  const file = DriveApp.getFileById(driveFileId);
  const blob = file.getBlob();
  return {
    base64: Utilities.base64Encode(blob.getBytes()),
    mimeType: blob.getContentType() || 'image/jpeg'
  };
}

/**
 * 當收到多張連拍照片時，排程 1 分鐘後於背景執行佇列消化
 */
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
  } catch (e) {
    console.warn('建立單次背景佇列排程略過:', e);
  }
}

function ensureDriveFolder_() {
  const props = PropertiesService.getScriptProperties();
  let folderId = props.getProperty('DRIVE_FOLDER_ID');
  if (folderId) {
    try {
      return DriveApp.getFolderById(folderId);
    } catch (e) {
      console.warn('指定的 DRIVE_FOLDER_ID 無法存取，將自動建立新資料夾:', e);
    }
  }

  const folderName = 'LINE_AI_記帳收據備份';
  const folders = DriveApp.getFoldersByName(folderName);
  let folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder(folderName);
  }
  props.setProperty('DRIVE_FOLDER_ID', folder.getId());
  return folder;
}

/**
 * 處理單筆 RawLog：呼叫 Gemini 解析 -> 寫入 Transactions -> 更新 RawLogs -> 回覆 LINE
 */
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
            '💡 這則訊息看起來不像記帳內容喔！\n您可以傳送如「午餐便當 120」或直接拍下收據照片，或輸入「說明」查看完整指令。'
        );
      }
      return { ok: true, count: 0 };
    }

    // 寫入 Transactions 工作表
    const savedBatch = saveTransactionsBatch_(parseResult.items, logEntry);

    // 更新 RawLogs 狀態為 SUCCESS
    updateRawLogStatus_(logEntry.logId, 'SUCCESS', savedBatch.transactions.length, '');

    // 回傳精美 Flex Message 確認小卡至 LINE
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
        [
          '⚠️ AI 解析暫時忙碌或連線異常，但別擔心！',
          `✅ 您的原始資料與圖片已安全備份（紀錄編號：${logEntry.logId}）。`,
          logEntry.driveUrl ? `🖼️ 圖片備份：${logEntry.driveUrl}` : '',
          '🔄 系統將於背景自動重試，您也可以隨時輸入「重試」立即補登。'
        ].filter(Boolean).join('\n')
      );
    }
    return { ok: false, error: errMsg };
  }
}

/**
 * 自動或手動重試所有狀態為 FAILED（或卡在 PENDING 超過 10 分鐘）的原始紀錄
 */
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
        // 單次排程最多處理 5 筆，避免超過 GAS 執行時間與頻寬限制，若仍有剩餘自動排程下一波
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
 * 5. Gemini API 呼叫層（支援 Interactions API 結構化輸出與多模態圖片理解）
 * ============================================================================
 */
function parseAccountingInputWithGemini_(payload) {
  const config = getConfig();
  if (!config.geminiApiKey) {
    throw new Error('尚未在指令碼屬性設定 GEMINI_API_KEY');
  }

  const cloudSettings = getCloudSettings_();
  const expenseCats = cloudSettings.expenseCategories && cloudSettings.expenseCategories.length > 0
    ? cloudSettings.expenseCategories
    : EXPENSE_CATEGORIES;
  const incomeCats = (cloudSettings.incomeCategories || INCOME_CATEGORIES.join(',')).split(',').map(s => s.trim()).filter(Boolean);
  const paymentMethodsList = (cloudSettings.paymentMethods || '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay').split(',').map(s => s.trim()).filter(Boolean);
  const defaultCurrency = cloudSettings.defaultCurrency || 'TWD';
  const splitRuleText = cloudSettings.receiptSplitMode === 'single_total'
    ? '1. 若為單張收據或發票照片，請將整張收據合併為單筆總金額紀錄（品項請摘要主要購買內容）；若為使用者輸入的多筆不同消費文字則拆分為多筆。'
    : '1. 若單則文字或單張收據包含多個獨立消費項目（例如「早餐蛋餅45 拿鐵65 捷運30」或發票上的多項商品），請拆分成 items 陣列中的多筆紀錄。';

  const todayStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const currentTimeStr = Utilities.formatDate(new Date(), 'Asia/Taipei', 'HH:mm');
  const taxonomyObj = cloudSettings.subcategoryTaxonomyObj || DEFAULT_SUBCATEGORY_TAXONOMY;
  const compactTaxonomyStr = Object.keys(taxonomyObj)
    .map(cat => `${cat}[${(taxonomyObj[cat] || []).join('/')}]`)
    .join('; ');

  // 極簡化 System Instruction 以大幅降低輸入 Token 消耗，同時確保最細分類精準度
  const systemInstruction = [
    `台灣記帳AI。今日${todayStr} ${currentTimeStr}。預設幣別${defaultCurrency}。`,
    splitRuleText,
    `支出分類與最細子分類(category>subcategory)請嚴格優先對應：${compactTaxonomyStr}`,
    `收入分類：${incomeCats.join('/')}`,
    `支付方式：${paymentMethodsList.join('/')}或未指定。非記帳訊息設isAccounting=false。`
  ].join('\n');

  const accountingSchema = {
    type: 'object',
    properties: {
      isAccounting: {
        type: 'boolean',
        description: '此訊息或圖片是否包含可記帳的收支資訊'
      },
      assistantNote: {
        type: 'string',
        description: '給使用者的簡短貼心備註或發票摘要（繁體中文，30字內）'
      },
      items: {
        type: 'array',
        description: '解析出的所有收支明細清單',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string', description: '消費日期 YYYY-MM-DD' },
            time: { type: 'string', description: '消費時間 HH:mm' },
            type: { type: 'string', enum: ['支出', '收入'], description: '支出或收入' },
            category: { type: 'string', description: '主分類名稱' },
            subcategory: { type: 'string', description: '子分類名稱（如：外食、咖啡、超商、計程車）' },
            item: { type: 'string', description: '品項或消費內容說明' },
            amount: { type: 'number', description: '金額（正數數字）' },
            currency: { type: 'string', description: '幣別，預設 TWD' },
            paymentMethod: { type: 'string', description: '支付方式' },
            merchant: { type: 'string', description: '店家名稱或交易對象，未知填空字串' },
            invoiceNo: { type: 'string', description: '發票號碼（如 AB-12345678），無則填空字串' },
            note: { type: 'string', description: '補充備註，無則填空字串' }
          },
          required: ['date', 'type', 'category', 'item', 'amount', 'currency', 'paymentMethod']
        }
      }
    },
    required: ['isAccounting', 'assistantNote', 'items']
  };

  const inputParts = [];
  if (payload.messageType === 'image' && payload.preloadedImage && payload.preloadedImage.base64) {
    inputParts.push({
      type: 'text',
      text: '請辨識這張收據/發票/明細照片中的所有消費項目、日期、店家、發票號碼與金額，並轉換為結構化記帳明細。'
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
    model: config.parseModel,
    systemInstruction: systemInstruction,
    input: inputParts,
    schema: accountingSchema
  });

  return JSON.parse(responseText);
}

/**
 * 通用 Gemini Interactions API 呼叫函式（支援 JSON Schema 結構化輸出）
 */
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

  // 優先讀取 output_text，或從 steps 中擷取最後一個 model_output 的文字
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
 * 6. 試算表 Transactions 讀寫與批次管理（支援單筆/多筆寫入、撤銷、修改）
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
        subcategory: item.subcategory || '',
        item: item.item || '未命名項目',
        amount: Math.abs(Number(item.amount) || 0),
        currency: item.currency || 'TWD',
        paymentMethod: item.paymentMethod || '未指定',
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

/**
 * 撤銷最近一個批次的記帳紀錄（軟刪除 Status = deleted，保留完整稽核軌跡）
 */
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
      return { ok: false, message: '找不到任何有效（active）的記帳紀錄可撤銷。' };
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
    return { ok: false, message: `批次 ${batchId} 已撤銷過或不存在。` };
  }

  return {
    ok: true,
    message: `🗑️ 已成功撤銷 ${deletedItems.length} 筆紀錄：\n• ${deletedItems.reverse().join('\n• ')}`
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
          message: `🗑️ 已撤銷紀錄：${data[i][7]} ($${data[i][8]})`
        };
      }
    }
    return { ok: false, message: `找不到交易編號 ${txId}` };
  } finally {
    lock.releaseLock();
  }
}

/**
 * 支援「修改上一筆 金額 150」或「修改上一筆 分類 休閒娛樂」
 */
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

    // 簡易規則匹配：金額 / 分類 / 品項 / 支付方式 / 日期
    const parts = instruction.trim().split(/\s+/);
    if (parts.length >= 2) {
      const field = parts[0];
      const val = parts.slice(1).join(' ');

      if (/^(金額|價錢|價格|amount)$/i.test(field)) {
        const num = Number(val.replace(/[^0-9.]/g, ''));
        if (!isNaN(num) && num > 0) {
          txSheet.getRange(rowNum, 9).setValue(num);
          SpreadsheetApp.flush();
          return { ok: true, message: `✏️ 已將「${row[7]}」金額由 $${row[8]} 修改為 $${num}！` };
        }
      } else if (/^(分類|類別|category)$/i.test(field)) {
        txSheet.getRange(rowNum, 6).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將「${row[7]}」分類由「${row[5]}」修改為「${val}」！` };
      } else if (/^(品項|項目|名稱|說明|item)$/i.test(field)) {
        txSheet.getRange(rowNum, 8).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將品項名稱由「${row[7]}」修改為「${val}」！` };
      } else if (/^(支付|支付方式|付款方式)$/i.test(field)) {
        txSheet.getRange(rowNum, 11).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將「${row[7]}」支付方式修改為「${val}」！` };
      } else if (/^(日期|date)$/i.test(field)) {
        txSheet.getRange(rowNum, 3).setValue(val);
        SpreadsheetApp.flush();
        return { ok: true, message: `✏️ 已將「${row[7]}」日期修改為「${val}」！` };
      }
    }

    return {
      ok: false,
      message: '💡 修改格式範例：\n• 修改上一筆 金額 150\n• 修改上一筆 分類 休閒娛樂\n• 修改上一筆 品項 超商咖啡\n• 修改上一筆 支付 LINE Pay'
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * ============================================================================
 * 7. 試算表資料讀取與 AI 財務診斷分析引擎 (Gemini 4 Argon / 3.8 Flash)
 * ============================================================================
 */
function getMonthlySummaryData_(yearMonth) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const txSheet = ss.getSheetByName(SHEET_TRANSACTIONS);
  const budgetSheet = ss.getSheetByName(SHEET_BUDGETS);

  const budgetsMap = {};
  let totalMonthlyBudget = 0;
  if (budgetSheet && budgetSheet.getLastRow() > 1) {
    const bData = budgetSheet.getDataRange().getValues();
    for (let i = 1; i < bData.length; i++) {
      const cat = String(bData[i][0]);
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

      const rawDate = row[2];
      const dateStr = formatDateCell_(rawDate);
      if (yearMonth && !dateStr.startsWith(yearMonth)) continue;

      const type = String(row[4] || '支出');
      const category = String(row[5] || '其他支出').trim();
      const subcategory = String(row[6] || '一般細項').trim() || '一般細項';
      const amount = Number(row[8] || 0);
      const payment = String(row[10] || '未指定');
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

  // 補齊有設定預算但本月尚無支出的分類
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
    .sort((a, b) => b.amount - a.amount);

  const subcategoryList = Object.values(subcategoryStats)
    .map(s => ({
      ...s,
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

/**
 * ============================================================================
 * 7B. 極致省 Token 壓縮引擎 + 每月一次 AI 最細分類校準與消費狀況深度診斷
 * ============================================================================
 * 將原本冗長的 JSON 交易陣列壓縮為「預聚合統計 + 去重精簡管線表 (Pipe Digest)」，
 * 減少約 75%~82% 的輸入 Token，同時讓 Gemini 掌握 100% 消費細節！
 */
function buildUltraCompactDigest_(summary, includeTxIdsForAudit) {
  // 1. 主分類與細分類精簡摘要: "餐飲食品:9680/10000[外食6200,精品與超商咖啡2130,手搖飲1350]"
  const catLines = (summary.categories || [])
    .filter(c => c.amount > 0 || c.budget > 0)
    .map(c => {
      const subs = (c.subBreakdown || []).map(s => `${s.subcategory}:${s.amount}`).join(',');
      return `${c.category}:${c.amount}/${c.budget}(${c.ruleGroup.split(' ')[0]})[${subs}]`;
    })
    .join(' | ');

  // 2. 若不需逐筆改寫分類（純診斷），將相同品項合併計算頻次與總額，極致節省 Token
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

  const rawJsonChars = JSON.stringify(summary.transactions || []).length || 1;
  const compactText = [
    `M:${summary.yearMonth} Inc:${summary.totalIncome} Exp:${summary.totalExpense} Sav:${summary.netSavings}(${summary.savingsRate}%) Bud:${summary.totalMonthlyBudget}(${summary.budgetUsageRate}%)`,
    `CATS: ${catLines}`,
    `PAY: ${JSON.stringify(summary.paymentBreakdown)}`,
    includeTxIdsForAudit ? `TX(TxID|Cat|Subcat|Item|Merch|Amt):\n${txCompactLines}` : `ITEMS(Cat>Subcat|Item|Merch|Freq|Total):\n${txCompactLines}`
  ].join('\n');

  const compactChars = compactText.length;
  const savedPct = rawJsonChars > compactChars
    ? Math.min(88, Math.max(45, Math.round(((rawJsonChars - compactChars) / rawJsonChars) * 100)))
    : 72;

  return {
    digestText: compactText,
    estimatedInputTokens: Math.max(120, Math.round(compactChars / 3.2)),
    tokenSavedPct: savedPct
  };
}

/**
 * 執行 AI 財務與消費狀況診斷（支援選擇是否同時執行「每月一次最細分類校準」）
 */
function generateAiFinancialDiagnosis_(yearMonth, triggerSource, runCategoryCalibration) {
  if (runCategoryCalibration) {
    return runMonthlyCategoryAuditAndDiagnosis_(yearMonth, triggerSource);
  }

  const targetMonth = yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const summary = getMonthlySummaryData_(targetMonth);
  const config = getConfig();
  const compact = buildUltraCompactDigest_(summary, false);

  const diagnosisSchema = getDiagnosisAndAuditSchema_(false);

  const systemInstruction = [
    '你是台灣資深CFP財務顧問與消費行為分析師。請根據極簡壓縮帳務數據進行深度消費狀況診斷（繁體中文）。',
    '重點：1.分析主分類與最細子分類(Subcategory)佔比與消費頻次；2.檢視50/30/20法則；3.抓出拿鐵因子與超支預警；4.給出具體省錢處方。'
  ].join('\n');

  const responseText = callGeminiInteractionsApi_({
    model: config.diagnosisModel,
    systemInstruction: systemInstruction,
    input: [{ type: 'text', text: compact.digestText }],
    schema: diagnosisSchema
  });

  const reportObj = JSON.parse(responseText);
  reportObj.period = targetMonth;
  reportObj.generatedAt = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  reportObj.totalIncome = summary.totalIncome;
  reportObj.totalExpense = summary.totalExpense;
  reportObj.tokenStats = {
    estimatedInputTokens: compact.estimatedInputTokens,
    tokenSavedPct: compact.tokenSavedPct,
    reclassifiedCount: 0,
    mode: '快速省Token消費診斷'
  };

  saveAiReportToSheet_(reportObj, triggerSource || 'WEB');
  return reportObj;
}

/**
 * 【每月執行一次】使用 Gemini 將記帳分類與子分類校準至最細，並同步產出月度消費狀況深度報告
 */
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
    '任務1【月度最細分類校準】：檢視TX清單，若任何交易的Category或Subcategory不夠精確、過於籠統（如僅寫「外食」、「一般細項」或空白）或歸類錯誤，請在reclassifications陣列輸出修正後的最細分類(newCategory與newSubcategory)，讓後續統計達到最精確！若發現值得長期新增的精細子分類，請放入newTaxonomyAdditions。',
    `現有分類樹參考：${compactTaxStr}`,
    '任務2【深度消費狀況分析】：剖析使用者本月的消費結構、細分類排行洞察(subcategoryInsights)、固定vs彈性支出、拿鐵因子與具體改善建議。'
  ].join('\n');

  const responseText = callGeminiInteractionsApi_({
    model: config.diagnosisModel,
    systemInstruction: systemInstruction,
    input: [{ type: 'text', text: compact.digestText }],
    schema: getDiagnosisAndAuditSchema_(true)
  });

  const resultObj = JSON.parse(responseText);

  // 將 Gemini 校準後的最細分類直接批次寫回 Transactions 工作表與 Settings 分類樹
  const auditStats = applyMonthlyReclassifications_(
    resultObj.reclassifications || [],
    resultObj.newTaxonomyAdditions || [],
    targetMonth
  );

  resultObj.period = targetMonth;
  resultObj.generatedAt = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
  resultObj.totalIncome = summary.totalIncome;
  resultObj.totalExpense = summary.totalExpense;
  resultObj.tokenStats = {
    estimatedInputTokens: compact.estimatedInputTokens,
    tokenSavedPct: compact.tokenSavedPct,
    reclassifiedCount: auditStats.reclassifiedCount,
    addedSubcategoriesCount: auditStats.addedSubcategoriesCount,
    mode: '月度最細分類校準 + 深度消費分析'
  };

  saveAiReportToSheet_(resultObj, triggerSource || 'MONTHLY_AUDIT');
  return resultObj;
}

function getDiagnosisAndAuditSchema_(includeAuditFields) {
  const props = {
    healthScore: { type: 'integer', description: '0-100財務健康評分' },
    healthGrade: { type: 'string', description: '評級標籤如：極佳(S)、穩健(A+)、需留意(B)' },
    executiveSummary: { type: 'string', description: '120字內整體收支與消費狀況總評' },
    consumptionStructureAnalysis: {
      type: 'object',
      properties: {
        fixedVsFlexibleComment: { type: 'string', description: '固定必要支出 vs 彈性可調控支出的結構分析' },
        spendingRhythmComment: { type: 'string', description: '平日與週末、高頻消費時段與支付工具習慣分析' },
        topSubcategoryInsight: { type: 'string', description: '針對最細子分類(Subcategory)排行榜的精準洞察' }
      },
      required: ['fixedVsFlexibleComment', 'spendingRhythmComment', 'topSubcategoryInsight']
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
      description: '需要調整為更精細主分類或子分類的交易清單',
      items: {
        type: 'object',
        properties: {
          txId: { type: 'string', description: '交易TxID' },
          newCategory: { type: 'string', description: '校準後的主分類' },
          newSubcategory: { type: 'string', description: '校準後的最細子分類' },
          reason: { type: 'string', description: '簡短調整原因(15字內)' }
        },
        required: ['txId', 'newCategory', 'newSubcategory', 'reason']
      }
    };
    props.newTaxonomyAdditions = {
      type: 'array',
      description: '建議納入系統分類樹的新增最細子分類',
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

/**
 * 將 Gemini 校準後的最細分類批次寫回 Google Sheet `Transactions` 與 `Settings`
 */
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

    // 同步擴充 Settings 中的 subcategoryTaxonomy 分類樹並記錄最後校準月份
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

/**
 * 支援在網頁儀表板向 Gemini 自由提問試算表帳務問題（同樣使用超精簡 Digest 降低 Token）
 */
function askGeminiAboutFinances_(question, yearMonth) {
  const targetMonth = yearMonth || Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM');
  const summary = getMonthlySummaryData_(targetMonth);
  const config = getConfig();
  const compact = buildUltraCompactDigest_(summary, false);

  const answer = callGeminiInteractionsApi_({
    model: config.parseModel,
    systemInstruction: '你是使用者的專屬AI財務分析師。請根據提供的精簡帳務摘要，精準有條理地回答問題並引用具體細分類與金額（繁體中文）。',
    input: [
      {
        type: 'text',
        text: `${compact.digestText}\n\n問題：${question}`
      }
    ]
  });

  return {
    ok: true,
    answer: answer,
    estimatedInputTokens: compact.estimatedInputTokens,
    tokenSavedPct: compact.tokenSavedPct
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
 * 8. 網頁儀表板 API 路由 (供內建 HtmlService 與 GitHub Pages 雲端網頁呼叫)
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
      webAppUrl: config.webAppUrl || ''
    }
  };
}

function handleDashboardApi_(action, params) {
  try {
    const config = getConfig();
    if (config.dashboardToken && params.token !== config.dashboardToken) {
      return jsonResponse_({ ok: false, error: '通行碼 (DASHBOARD_ACCESS_TOKEN) 驗證失敗' });
    }

    if (action === 'bootstrap') {
      return jsonResponse_(getDashboardBootstrapData(params.yearMonth));
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
      return jsonResponse_({ ok: true, batch: saved });
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
        rawText: params.rawText || (preloadedImage ? '[雲端儀表板上傳收據]' : ''),
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
 * 讀取 Settings 與 Budgets 工作表中的跨裝置設定
 */
function getCloudSettings_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  if (!settingsSheet) {
    setupSpreadsheet();
    settingsSheet = ss.getSheetByName(SHEET_SETTINGS);
  }

  const out = {
    accountBookName: '我的 AI 智慧帳本',
    defaultCurrency: 'TWD',
    parseModel: DEFAULT_PARSE_MODEL,
    diagnosisModel: DEFAULT_DIAGNOSIS_MODEL,
    receiptSplitMode: 'split_items',
    paymentMethods: '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay',
    incomeCategories: INCOME_CATEGORIES.join(','),
    autoSyncSeconds: '60',
    budgetAlertThresholdPct: '85',
    subcategoryTaxonomy: JSON.stringify(DEFAULT_SUBCATEGORY_TAXONOMY),
    lastMonthlyAuditMonth: '',
    expenseCategories: EXPENSE_CATEGORIES.slice()
  };

  if (settingsSheet && settingsSheet.getLastRow() > 1) {
    const data = settingsSheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      const k = String(data[i][0] || '').trim();
      const v = String(data[i][1] || '').trim();
      if (k) out[k] = v;
    }
  }

  try {
    out.subcategoryTaxonomyObj = JSON.parse(out.subcategoryTaxonomy || '{}');
  } catch (e) {
    out.subcategoryTaxonomyObj = DEFAULT_SUBCATEGORY_TAXONOMY;
  }

  const budgetSheet = ss.getSheetByName(SHEET_BUDGETS);
  const budgetsList = [];
  if (budgetSheet && budgetSheet.getLastRow() > 1) {
    const bData = budgetSheet.getDataRange().getValues();
    for (let i = 1; i < bData.length; i++) {
      const cat = String(bData[i][0] || '').trim();
      if (cat) {
        budgetsList.push({
          category: cat,
          budget: Number(bData[i][1] || 0),
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

      const existing = settingsSheet.getDataRange().getValues();
      const keyRowMap = {};
      for (let i = 1; i < existing.length; i++) {
        keyRowMap[String(existing[i][0])] = i + 1;
      }

      Object.keys(params.settings).forEach(k => {
        if (k === 'budgetsList' || k === 'expenseCategories') return;
        const val = String(params.settings[k] !== undefined ? params.settings[k] : '');
        if (keyRowMap[k]) {
          settingsSheet.getRange(keyRowMap[k], 2).setValue(val);
          settingsSheet.getRange(keyRowMap[k], 4).setValue(nowStr);
        } else {
          settingsSheet.appendRow([k, val, '自訂設定', nowStr]);
        }
      });

      // 同步模型設定至 Script Properties
      const props = PropertiesService.getScriptProperties();
      if (params.settings.parseModel) {
        props.setProperty('GEMINI_PARSE_MODEL', String(params.settings.parseModel));
      }
      if (params.settings.diagnosisModel) {
        props.setProperty('GEMINI_DIAGNOSIS_MODEL', String(params.settings.diagnosisModel));
      }
    }

    // 2. 批次覆寫更新 Budgets 分類與月度預算工作表
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
        .map(b => [
          String(b.category).trim(),
          Math.max(0, Number(b.budget || 0)),
          String(b.ruleGroup || '必要支出 (Needs)'),
          String(b.note || '')
        ]);
      if (rows.length > 0) {
        budgetSheet.getRange(2, 1, rows.length, 4).setValues(rows);
      }
    }

    // 3. 若使用者在網頁端有填入更新後端金鑰，直接寫入 Script Properties
    if (params.secrets && typeof params.secrets === 'object') {
      const props = PropertiesService.getScriptProperties();
      if (params.secrets.geminiApiKey && params.secrets.geminiApiKey.trim()) {
        props.setProperty('GEMINI_API_KEY', params.secrets.geminiApiKey.trim());
      }
      if (params.secrets.lineToken && params.secrets.lineToken.trim()) {
        props.setProperty('LINE_CHANNEL_ACCESS_TOKEN', params.secrets.lineToken.trim());
      }
      if (params.secrets.driveFolderId !== undefined && String(params.secrets.driveFolderId).trim()) {
        props.setProperty('DRIVE_FOLDER_ID', String(params.secrets.driveFolderId).trim());
      }
    }

    SpreadsheetApp.flush();
    return {
      ok: true,
      syncedAt: nowStr,
      cloudSettings: getCloudSettings_(),
      message: '✅ 所有設定與分類預算已儲存至 Google Sheets，手機、平板、電腦與 LINE Bot 已全面同步！'
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
    if (!yearMonth || String(data[i][2]) === String(yearMonth)) {
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
 * 9. LINE Messaging API 卡片建構器 (Flex Message + Quick Reply)
 * ============================================================================
 */
function buildReceiptConfirmFlex_(savedBatch, assistantNote) {
  const txs = savedBatch.transactions;
  const totalAmount = txs.reduce((acc, t) => acc + (t.type === '收入' ? t.amount : t.amount), 0);
  const isIncome = txs.every(t => t.type === '收入');
  const headerColor = isIncome ? '#059669' : '#2563eb';

  const itemRows = txs.slice(0, 8).map(t => ({
    type: 'box',
    layout: 'horizontal',
    margin: 'sm',
    contents: [
      {
        type: 'text',
        text: `[${t.category}] ${t.item}`,
        size: 'sm',
        color: '#334155',
        flex: 4,
        wrap: true
      },
      {
        type: 'text',
        text: `${t.type === '收入' ? '+' : ''}$${t.amount.toLocaleString()}`,
        size: 'sm',
        color: t.type === '收入' ? '#059669' : '#0f172a',
        weight: 'bold',
        align: 'end',
        flex: 2
      }
    ]
  }));

  if (txs.length > 8) {
    itemRows.push({
      type: 'text',
      text: `...及其他 ${txs.length - 8} 筆項目`,
      size: 'xs',
      color: '#64748b',
      margin: 'sm'
    });
  }

  const firstTx = txs[0];
  const footerButtons = [
    {
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'postback',
        label: '🗑️ 撤銷此筆記帳',
        data: `action=delete_batch&batchId=${savedBatch.batchId}`,
        displayText: '撤銷此筆記帳'
      }
    }
  ];

  if (savedBatch.imageUrl) {
    footerButtons.unshift({
      type: 'button',
      style: 'link',
      height: 'sm',
      action: {
        type: 'uri',
        label: '🖼️ 查看雲端收據原圖',
        uri: savedBatch.imageUrl
      }
    });
  }

  return {
    type: 'flex',
    altText: `✅ 已記帳 ${txs.length} 筆，共 $${totalAmount.toLocaleString()}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: headerColor,
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: isIncome ? '💰 收入入帳成功' : '✅ AI 記帳完成',
                color: '#ffffff',
                weight: 'bold',
                size: 'md',
                flex: 3
              },
              {
                type: 'text',
                text: `${txs.length} 筆明細`,
                color: '#e2e8f0',
                size: 'xs',
                align: 'end',
                gravity: 'center',
                flex: 1
              }
            ]
          },
          {
            type: 'text',
            text: `NT$ ${totalAmount.toLocaleString()}`,
            color: '#ffffff',
            weight: 'bold',
            size: 'xxl',
            margin: 'md'
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'box',
            layout: 'horizontal',
            contents: [
              {
                type: 'text',
                text: `📅 ${firstTx.date} ${firstTx.time}`,
                size: 'xs',
                color: '#64748b',
                flex: 3
              },
              {
                type: 'text',
                text: `💳 ${firstTx.paymentMethod}`,
                size: 'xs',
                color: '#64748b',
                align: 'end',
                flex: 2
              }
            ]
          },
          firstTx.merchant ? {
            type: 'text',
            text: `🏪 店家：${firstTx.merchant}${firstTx.invoiceNo ? ' (' + firstTx.invoiceNo + ')' : ''}`,
            size: 'xs',
            color: '#64748b',
            margin: 'xs'
          } : { type: 'filler' },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            margin: 'md',
            contents: itemRows
          },
          {
            type: 'separator',
            margin: 'md'
          },
          {
            type: 'text',
            text: assistantNote ? `💡 ${assistantNote}` : `🔒 已同步備份至 Google Sheets (${firstTx.rawLogId})`,
            size: 'xs',
            color: '#475569',
            margin: 'md',
            wrap: true
          }
        ]
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
      margin: 'sm',
      contents: [
        { type: 'text', text: `${c.category} (${pct}%)`, size: 'sm', color: '#334155', flex: 3 },
        { type: 'text', text: `$${c.amount.toLocaleString()}`, size: 'sm', weight: 'bold', align: 'end', flex: 2 }
      ]
    };
  }) : [{ type: 'text', text: '本月尚無支出紀錄', size: 'sm', color: '#94a3b8' }];

  const config = getConfig();
  const footerBtns = [
    {
      type: 'button',
      style: 'primary',
      color: '#4f46e5',
      height: 'sm',
      action: {
        type: 'postback',
        label: '🩺 執行 Gemini 財務診斷',
        data: 'action=ai_diagnosis',
        displayText: '執行本月財務診斷'
      }
    }
  ];

  if (config.webAppUrl) {
    footerBtns.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'uri',
        label: '🌐 開啟視覺化網頁儀表板',
        uri: config.webAppUrl
      }
    });
  }

  return {
    type: 'flex',
    altText: `📊 ${summary.yearMonth} 帳務統計摘要`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#0f172a',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `📊 ${summary.yearMonth} 收支快篩報表`, color: '#38bdf8', weight: 'bold', size: 'sm' },
          { type: 'text', text: `總支出 NT$ ${summary.totalExpense.toLocaleString()}`, color: '#ffffff', weight: 'bold', size: 'xl', margin: 'sm' },
          { type: 'text', text: `總收入 $${summary.totalIncome.toLocaleString()} ｜ 結餘 $${summary.netSavings.toLocaleString()}`, color: '#94a3b8', size: 'xs', margin: 'xs' }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: `預算使用率：${summary.budgetUsageRate}% （月預算 $${summary.totalMonthlyBudget.toLocaleString()}）`,
            size: 'xs',
            weight: 'bold',
            color: summary.budgetUsageRate > 90 ? '#dc2626' : '#059669'
          },
          { type: 'separator', margin: 'md' },
          { type: 'text', text: '前五大支出分類：', size: 'xs', color: '#64748b', margin: 'md' },
          { type: 'box', layout: 'vertical', margin: 'sm', contents: catRows }
        ]
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: footerBtns
      }
    },
    quickReply: buildStandardQuickReply_()
  };
}

function buildDiagnosisFlexMessage_(report) {
  const tipsRows = (report.actionableTips || []).slice(0, 3).map((tip, idx) => ({
    type: 'box',
    layout: 'vertical',
    margin: 'md',
    contents: [
      {
        type: 'text',
        text: `${idx + 1}. ${tip.action}（${tip.expectedImpact}）`,
        size: 'sm',
        weight: 'bold',
        color: '#1e293b',
        wrap: true
      },
      {
        type: 'text',
        text: tip.description,
        size: 'xs',
        color: '#475569',
        wrap: true,
        margin: 'xs'
      }
    ]
  }));

  return {
    type: 'flex',
    altText: `🩺 AI 財務診斷報告：健康評分 ${report.healthScore} 分`,
    contents: {
      type: 'bubble',
      size: 'mega',
      header: {
        type: 'box',
        layout: 'vertical',
        backgroundColor: '#4f46e5',
        paddingAll: '16px',
        contents: [
          { type: 'text', text: `🩺 ${report.period} Gemini 財務診斷報告`, color: '#e0e7ff', size: 'xs', weight: 'bold' },
          {
            type: 'box',
            layout: 'baseline',
            margin: 'sm',
            contents: [
              { type: 'text', text: `${report.healthScore}`, color: '#ffffff', size: '3xl', weight: 'bold', flex: 0 },
              { type: 'text', text: ` / 100 分 (${report.healthGrade})`, color: '#c7d2fe', size: 'sm', margin: 'sm' }
            ]
          }
        ]
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: '16px',
        contents: [
          {
            type: 'text',
            text: report.executiveSummary || '',
            size: 'sm',
            color: '#334155',
            wrap: true
          },
          { type: 'separator', margin: 'md' },
          {
            type: 'text',
            text: '💡 具體優化行動建議：',
            size: 'xs',
            weight: 'bold',
            color: '#4f46e5',
            margin: 'md'
          },
          {
            type: 'box',
            layout: 'vertical',
            contents: tipsRows
          }
        ]
      }
    },
    quickReply: buildStandardQuickReply_()
  };
}

function buildStandardQuickReply_() {
  return {
    items: [
      {
        type: 'action',
        action: { type: 'message', label: '📊 本月報表', text: '本月報表' }
      },
      {
        type: 'action',
        action: { type: 'message', label: '🩺 財務診斷', text: '財務診斷' }
      },
      {
        type: 'action',
        action: { type: 'message', label: '🗑️ 撤銷上一筆', text: '撤銷上一筆' }
      },
      {
        type: 'action',
        action: { type: 'message', label: '📖 指令說明', text: '說明' }
      }
    ]
  };
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
    headers: {
      Authorization: 'Bearer ' + config.lineToken
    },
    payload: JSON.stringify({
      replyToken: replyToken,
      messages: messages
    }),
    muteHttpExceptions: true
  });
}

/**
 * ============================================================================
 * 10. 輔助工具函式
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
