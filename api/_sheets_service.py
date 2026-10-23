import os
import json
import base64
from io import BytesIO
from datetime import datetime, timezone, timedelta

try:
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    from googleapiclient.http import MediaIoBaseUpload
    _HAS_GOOGLE_LIBS = True
except ImportError:
    service_account = None
    build = None
    MediaIoBaseUpload = None
    _HAS_GOOGLE_LIBS = False

SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
]

SHEET_TRANSACTIONS = 'Transactions'
SHEET_RAW_LOGS = 'RawLogs'
SHEET_BUDGETS = 'Budgets'
SHEET_AI_REPORTS = 'AI_Reports'
SHEET_SETTINGS = 'Settings'

DEFAULT_PARSE_MODEL = 'gemini-3.8-flash'
DEFAULT_DIAGNOSIS_MODEL = 'gemini-4-argon'
DEFAULT_GITHUB_PAGES_URL = 'https://emma1426.github.io/Accounting-book/'
DEFAULT_FALLBACK_GAS_URL = 'https://script.google.com/macros/s/AKfycbw_mtxNkSJgeX25OG0daPgFQpRZsrV1EFENIuTui7WofCX2m0LBm7_g9etytA-qweJ0yg/exec'

EXPENSE_CATEGORIES = [
    '餐飲食品', '交通通勤', '日常用品', '居家帳單', '休閒娛樂',
    '服飾美容', '醫療保健', '學習進修', '數位訂閱', '人情社交', '其他支出'
]

INCOME_CATEGORIES = [
    '薪資收入', '獎金津貼', '投資理財', '兼職副業', '退款回饋', '其他收入'
]

DEFAULT_SUBCATEGORY_TAXONOMY = {
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
}

DEFAULT_BUDGETS_ROWS = [
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
]

def now_taipei():
    tz = timezone(timedelta(hours=8))
    return datetime.now(tz)

def now_str():
    return now_taipei().strftime('%Y-%m-%d %H:%M:%S')

def get_spreadsheet_id():
    return os.environ.get('SPREADSHEET_ID', '').strip()

def get_env_credentials():
    """從環境變數 GOOGLE_SERVICE_ACCOUNT_JSON (字串或 base64) 建立憑證"""
    if not _HAS_GOOGLE_LIBS or not service_account:
        return None
    sa_json = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '').strip()
    if not sa_json:
        local_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', 'service_account.json')
        if os.path.exists(local_path):
            try:
                return service_account.Credentials.from_service_account_file(local_path, scopes=SCOPES)
            except Exception as e:
                print(f"Error loading service account file: {e}")
                return None
        return None

    try:
        if sa_json.startswith('{'):
            info = json.loads(sa_json)
        else:
            decoded = base64.b64decode(sa_json).decode('utf-8')
            info = json.loads(decoded)
        return service_account.Credentials.from_service_account_info(info, scopes=SCOPES)
    except Exception as e:
        print(f"Error parsing service account: {e}")
        return None

def is_direct_sheets_configured():
    """檢查是否已設定直連 Google Sheets 所需的 SPREADSHEET_ID 與 Service Account 憑證"""
    return bool(get_spreadsheet_id() and get_env_credentials())

def get_sheets_service():
    creds = get_env_credentials()
    if not creds or not build:
        return None
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)

def get_drive_service():
    creds = get_env_credentials()
    if not creds or not build:
        return None
    return build('drive', 'v3', credentials=creds, cache_discovery=False)

def ensure_spreadsheet_initialized(spreadsheet_id=None):
    """確認 5 張工作表皆存在，若缺少則自動建立並填入預設表頭與初始值"""
    sid = spreadsheet_id or get_spreadsheet_id()
    if not sid:
        return False
    service = get_sheets_service()
    if not service:
        return False

    try:
        meta = service.spreadsheets().get(spreadsheetId=sid).execute()
        existing_sheets = {s['properties']['title'] for s in meta.get('sheets', [])}
    except Exception as e:
        print(f"Error getting spreadsheet metadata: {e}")
        return False

    required_sheets = [SHEET_TRANSACTIONS, SHEET_RAW_LOGS, SHEET_BUDGETS, SHEET_AI_REPORTS, SHEET_SETTINGS]
    missing = [s for s in required_sheets if s not in existing_sheets]

    if missing:
        requests_body = [{'addSheet': {'properties': {'title': title}}} for title in missing]
        try:
            service.spreadsheets().batchUpdate(
                spreadsheetId=sid,
                body={'requests': requests_body}
            ).execute()
        except Exception as e:
            print(f"Error creating sheets: {e}")

    ts = now_str()
    if SHEET_TRANSACTIONS in missing:
        append_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1", [[
            'TxID', 'BatchID', 'Date', 'Time', 'Type', 'Category', 'Subcategory',
            'Item', 'Amount', 'Currency', 'PaymentMethod', 'Merchant', 'InvoiceNo',
            'ImageUrl', 'RawLogId', 'Status', 'CreatedAt', 'Note'
        ]])

    if SHEET_RAW_LOGS in missing:
        append_sheet_values(sid, f"{SHEET_RAW_LOGS}!A1", [[
            'LogID', 'ReceivedAt', 'UserId', 'MessageType', 'RawText',
            'DriveFileId', 'DriveUrl', 'Status', 'ParsedCount',
            'ErrorMessage', 'RetryCount', 'UpdatedAt'
        ]])

    if SHEET_BUDGETS in missing:
        rows = [['Category', 'MonthlyBudget', 'RuleGroup', 'Note']] + DEFAULT_BUDGETS_ROWS
        append_sheet_values(sid, f"{SHEET_BUDGETS}!A1", rows)

    if SHEET_AI_REPORTS in missing:
        append_sheet_values(sid, f"{SHEET_AI_REPORTS}!A1", [[
            'ReportID', 'CreatedAt', 'Period', 'TotalIncome',
            'TotalExpense', 'HealthScore', 'ReportJSON', 'TriggerSource'
        ]])

    if SHEET_SETTINGS in missing:
        default_settings = [
            ['Key', 'Value', 'Description', 'UpdatedAt'],
            ['accountBookName', '極簡雲端帳本', '帳本顯示名稱', ts],
            ['defaultCurrency', 'TWD', '預設記帳幣別', ts],
            ['defaultPaymentMethod', '現金', '預設支付方式', ts],
            ['parseModel', DEFAULT_PARSE_MODEL, 'LINE 記帳與收據解析模型', ts],
            ['diagnosisModel', DEFAULT_DIAGNOSIS_MODEL, 'AI 財務診斷分析模型', ts],
            ['receiptSplitMode', 'split_items', '收據解析模式', ts],
            ['lineTriggerMode', 'menu_first', 'LINE 記帳觸發方式', ts],
            ['githubPagesUrl', DEFAULT_GITHUB_PAGES_URL, '手冊檢視帳務網址', ts],
            ['monthlyAutoAudit', 'ON', '每月1號自動最細分類微調', ts],
            ['paymentMethods', '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay', '常用支付方式清單', ts],
            ['incomeCategories', ','.join(INCOME_CATEGORIES), '收入分類清單', ts],
            ['subcategoryTaxonomy', json.dumps(DEFAULT_SUBCATEGORY_TAXONOMY, ensure_ascii=False), '最細子分類樹狀結構 JSON', ts],
            ['lastMonthlyAuditMonth', '', '最近一次執行月度 AI 細分類校準的月份', ts],
            ['activeRichMenuId', '', '目前啟用的 LINE 圖文選單 ID', ts]
        ]
        append_sheet_values(sid, f"{SHEET_SETTINGS}!A1", default_settings)

    return True

def get_sheet_values(spreadsheet_id, range_name):
    service = get_sheets_service()
    if not service or not spreadsheet_id:
        return []
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range=range_name
        ).execute()
        return result.get('values', [])
    except Exception as e:
        if 'Unable to parse range' in str(e):
            ensure_spreadsheet_initialized(spreadsheet_id)
            try:
                result = service.spreadsheets().values().get(
                    spreadsheetId=spreadsheet_id,
                    range=range_name
                ).execute()
                return result.get('values', [])
            except Exception:
                return []
        print(f"Error reading range {range_name}: {e}")
        return []

def batch_get_all_sheets(spreadsheet_id=None):
    """一次讀取所有常用工作表，大幅降低延遲與 API 呼叫次數"""
    sid = spreadsheet_id or get_spreadsheet_id()
    service = get_sheets_service()
    if not service or not sid:
        return {}
    ranges = [
        f"{SHEET_TRANSACTIONS}!A1:R5000",
        f"{SHEET_RAW_LOGS}!A1:L500",
        f"{SHEET_BUDGETS}!A1:D100",
        f"{SHEET_AI_REPORTS}!A1:H200",
        f"{SHEET_SETTINGS}!A1:D200"
    ]
    try:
        res = service.spreadsheets().values().batchGet(
            spreadsheetId=sid,
            ranges=ranges
        ).execute()
        value_ranges = res.get('valueRanges', [])
        out = {}
        sheet_names = [SHEET_TRANSACTIONS, SHEET_RAW_LOGS, SHEET_BUDGETS, SHEET_AI_REPORTS, SHEET_SETTINGS]
        for idx, name in enumerate(sheet_names):
            if idx < len(value_ranges):
                out[name] = value_ranges[idx].get('values', [])
            else:
                out[name] = []
        return out
    except Exception as e:
        print(f"Batch get failed, initializing sheets: {e}")
        ensure_spreadsheet_initialized(sid)
        try:
            res = service.spreadsheets().values().batchGet(
                spreadsheetId=sid,
                ranges=ranges
            ).execute()
            value_ranges = res.get('valueRanges', [])
            out = {}
            sheet_names = [SHEET_TRANSACTIONS, SHEET_RAW_LOGS, SHEET_BUDGETS, SHEET_AI_REPORTS, SHEET_SETTINGS]
            for idx, name in enumerate(sheet_names):
                out[name] = value_ranges[idx].get('values', []) if idx < len(value_ranges) else []
            return out
        except Exception as e2:
            print(f"Batch get second attempt failed: {e2}")
            return {}

def append_sheet_values(spreadsheet_id, range_name, values):
    service = get_sheets_service()
    if not service or not spreadsheet_id:
        return False
    try:
        body = {'values': values}
        service.spreadsheets().values().append(
            spreadsheetId=spreadsheet_id,
            range=range_name,
            valueInputOption='USER_ENTERED',
            insertDataOption='INSERT_ROWS',
            body=body
        ).execute()
        return True
    except Exception as e:
        print(f"Error appending values to {range_name}: {e}")
        return False

def update_sheet_values(spreadsheet_id, range_name, values):
    service = get_sheets_service()
    if not service or not spreadsheet_id:
        return False
    try:
        body = {'values': values}
        service.spreadsheets().values().update(
            spreadsheetId=spreadsheet_id,
            range=range_name,
            valueInputOption='USER_ENTERED',
            body=body
        ).execute()
        return True
    except Exception as e:
        print(f"Error updating {range_name}: {e}")
        return False

def clear_sheet_range(spreadsheet_id, range_name):
    service = get_sheets_service()
    if not service or not spreadsheet_id:
        return False
    try:
        service.spreadsheets().values().clear(
            spreadsheetId=spreadsheet_id,
            range=range_name,
            body={}
        ).execute()
        return True
    except Exception as e:
        print(f"Error clearing {range_name}: {e}")
        return False

def upload_image_to_drive(image_bytes, mime_type, filename):
    """若設定有 DRIVE_FOLDER_ID 則上傳備份至 Google Drive"""
    drive = get_drive_service()
    folder_id = os.environ.get('DRIVE_FOLDER_ID', '').strip()
    if not drive or not MediaIoBaseUpload:
        return '', ''
    try:
        file_metadata = {'name': filename}
        if folder_id:
            file_metadata['parents'] = [folder_id]
        media = MediaIoBaseUpload(BytesIO(image_bytes), mimetype=mime_type, resumable=False)
        file = drive.files().create(
            body=file_metadata,
            media_body=media,
            fields='id'
        ).execute()
        file_id = file.get('id', '')
        if file_id:
            try:
                drive.permissions().create(
                    fileId=file_id,
                    body={'type': 'anyone', 'role': 'reader'}
                ).execute()
            except Exception:
                pass
            return file_id, f"https://drive.google.com/file/d/{file_id}/view"
    except Exception as e:
        print(f"Drive upload skipped/error: {e}")
    return '', ''
