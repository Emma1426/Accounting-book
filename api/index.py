import os
import sys
import re
import json
import time
import base64
import random
import urllib.request
import urllib.error
from urllib.parse import urlparse, parse_qs, urlencode
from http.server import BaseHTTPRequestHandler

_CUR_DIR = os.path.dirname(os.path.abspath(__file__))
_ROOT_DIR = os.path.dirname(_CUR_DIR)
for _p in (_CUR_DIR, _ROOT_DIR):
    if _p not in sys.path:
        sys.path.insert(0, _p)

try:
    from _sheets_service import (
        SHEET_TRANSACTIONS,
        SHEET_RAW_LOGS,
        SHEET_BUDGETS,
        SHEET_AI_REPORTS,
        SHEET_SETTINGS,
        DEFAULT_PARSE_MODEL,
        DEFAULT_DIAGNOSIS_MODEL,
        DEFAULT_GITHUB_PAGES_URL,
        DEFAULT_FALLBACK_GAS_URL,
        EXPENSE_CATEGORIES,
        INCOME_CATEGORIES,
        DEFAULT_SUBCATEGORY_TAXONOMY,
        DEFAULT_BUDGETS_ROWS,
        now_taipei,
        now_str,
        get_spreadsheet_id,
        is_direct_sheets_configured,
        get_sheet_values,
        batch_get_all_sheets,
        append_sheet_values,
        update_sheet_values,
        clear_sheet_range,
        upload_image_to_drive
    )
    from _line_service import (
        get_line_token,
        reply_line_messages,
        reply_line_text,
        get_line_message_content,
        setup_rich_menu_flow,
        build_accounting_started_flex,
        build_not_triggered_prompt_flex,
        build_preview_confirm_flex,
        build_receipt_confirm_flex,
        build_monthly_summary_flex,
        build_diagnosis_flex_message
    )
    from _gemini_service import (
        get_gemini_api_key,
        call_gemini_interactions_api,
        parse_accounting_input_with_gemini,
        get_diagnosis_and_audit_schema
    )
except ImportError:
    from api._sheets_service import (
        SHEET_TRANSACTIONS,
        SHEET_RAW_LOGS,
        SHEET_BUDGETS,
        SHEET_AI_REPORTS,
        SHEET_SETTINGS,
        DEFAULT_PARSE_MODEL,
        DEFAULT_DIAGNOSIS_MODEL,
        DEFAULT_GITHUB_PAGES_URL,
        DEFAULT_FALLBACK_GAS_URL,
        EXPENSE_CATEGORIES,
        INCOME_CATEGORIES,
        DEFAULT_SUBCATEGORY_TAXONOMY,
        DEFAULT_BUDGETS_ROWS,
        now_taipei,
        now_str,
        get_spreadsheet_id,
        is_direct_sheets_configured,
        get_sheet_values,
        batch_get_all_sheets,
        append_sheet_values,
        update_sheet_values,
        clear_sheet_range,
        upload_image_to_drive
    )
    from api._line_service import (
        get_line_token,
        reply_line_messages,
        reply_line_text,
        get_line_message_content,
        setup_rich_menu_flow,
        build_accounting_started_flex,
        build_not_triggered_prompt_flex,
        build_preview_confirm_flex,
        build_receipt_confirm_flex,
        build_monthly_summary_flex,
        build_diagnosis_flex_message
    )
    from api._gemini_service import (
        get_gemini_api_key,
        call_gemini_interactions_api,
        parse_accounting_input_with_gemini,
        get_diagnosis_and_audit_schema
    )

# 記憶體快取（搭配 Google Sheet Settings 持久化，確保 Serverless 跨實例也能保留狀態）
_MEMORY_SESSIONS = {}

def get_dashboard_token():
    return os.environ.get('DASHBOARD_ACCESS_TOKEN', '').strip()

def get_fallback_gas_url():
    return os.environ.get('GAS_WEB_APP_URL', DEFAULT_FALLBACK_GAS_URL).strip()

def proxy_to_gas_fallback(method='GET', query_params=None, json_body=None):
    """當 Vercel 尚未設定 GOOGLE_SERVICE_ACCOUNT_JSON 或 SPREADSHEET_ID 時，無縫代理轉發至雲端 GAS Web App"""
    gas_url = get_fallback_gas_url()
    if not gas_url:
        return None
    try:
        if method == 'GET':
            q = urlencode(query_params or {})
            target = f"{gas_url}{'&' if '?' in gas_url else '?'}{q}" if q else gas_url
            req = urllib.request.Request(target, method='GET')
        else:
            body_bytes = json.dumps(json_body or {}, ensure_ascii=False).encode('utf-8')
            req = urllib.request.Request(
                gas_url,
                data=body_bytes,
                headers={'Content-Type': 'text/plain;charset=utf-8'},
                method='POST'
            )
        with urllib.request.urlopen(req, timeout=55) as resp:
            raw = resp.read().decode('utf-8', errors='replace')
            return json.loads(raw)
    except Exception as e:
        print(f"GAS fallback proxy error: {e}")
        return None

def format_date_cell(val):
    if not val:
        return ''
    s = str(val).strip()
    return s[:10]

def format_time_cell(val):
    if not val:
        return ''
    s = str(val).strip()
    return s[:5]

def safe_float(val, default=0.0):
    try:
        if val is None or val == '':
            return default
        return float(str(val).replace(',', '').strip())
    except Exception:
        return default

# ============================================================================
# 雲端設定、預算與金鑰讀寫 (Google Sheets: Settings & Budgets)
# ============================================================================

def get_cloud_settings(sheets_cache=None):
    sid = get_spreadsheet_id()
    out = {
        "accountBookName": "極簡雲端帳本",
        "defaultCurrency": "TWD",
        "currency": "TWD",
        "defaultPaymentMethod": "現金",
        "parseModel": DEFAULT_PARSE_MODEL,
        "aiParseModel": DEFAULT_PARSE_MODEL,
        "diagnosisModel": DEFAULT_DIAGNOSIS_MODEL,
        "aiDiagnosisModel": DEFAULT_DIAGNOSIS_MODEL,
        "receiptSplitMode": "split_items",
        "lineTriggerMode": "menu_first",
        "githubPagesUrl": DEFAULT_GITHUB_PAGES_URL,
        "monthlyAutoAudit": "ON",
        "paymentMethods": "現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay",
        "incomeCategories": ",".join(INCOME_CATEGORIES),
        "subcategoryTaxonomy": json.dumps(DEFAULT_SUBCATEGORY_TAXONOMY, ensure_ascii=False),
        "lastMonthlyAuditMonth": "",
        "activeRichMenuId": "",
        "expenseCategories": list(EXPENSE_CATEGORIES)
    }

    settings_rows = (
        sheets_cache.get(SHEET_SETTINGS)
        if sheets_cache and SHEET_SETTINGS in sheets_cache
        else (get_sheet_values(sid, f"{SHEET_SETTINGS}!A1:D200") if sid else [])
    )

    if settings_rows and len(settings_rows) > 1:
        for row in settings_rows[1:]:
            if not row:
                continue
            k = str(row[0] or '').strip()
            v = str(row[1] if len(row) > 1 and row[1] is not None else '').strip()
            if k and v != '[object Object]':
                out[k] = v

    out["currency"] = out.get("currency") or out.get("defaultCurrency") or "TWD"
    out["defaultCurrency"] = out["currency"]
    out["aiParseModel"] = out.get("aiParseModel") or out.get("parseModel") or DEFAULT_PARSE_MODEL
    out["parseModel"] = out["aiParseModel"]
    out["aiDiagnosisModel"] = out.get("aiDiagnosisModel") or out.get("diagnosisModel") or DEFAULT_DIAGNOSIS_MODEL
    out["diagnosisModel"] = out["aiDiagnosisModel"]

    try:
        raw_tax = out.get("subcategoryTaxonomy")
        parsed_tax = raw_tax if isinstance(raw_tax, dict) else json.loads(raw_tax or '{}')
        out["subcategoryTaxonomyObj"] = parsed_tax if (isinstance(parsed_tax, dict) and len(parsed_tax) > 0) else dict(DEFAULT_SUBCATEGORY_TAXONOMY)
    except Exception:
        out["subcategoryTaxonomyObj"] = dict(DEFAULT_SUBCATEGORY_TAXONOMY)

    budget_rows = (
        sheets_cache.get(SHEET_BUDGETS)
        if sheets_cache and SHEET_BUDGETS in sheets_cache
        else (get_sheet_values(sid, f"{SHEET_BUDGETS}!A1:D100") if sid else [])
    )

    budgets_list = []
    if budget_rows and len(budget_rows) > 1:
        for r in budget_rows[1:]:
            if not r:
                continue
            cat = str(r[0] or '').strip()
            if cat:
                amt = safe_float(r[1] if len(r) > 1 else 0)
                budgets_list.append({
                    "category": cat,
                    "budget": amt,
                    "monthlyBudget": amt,
                    "ruleGroup": str(r[2] if len(r) > 2 and r[2] else '必要支出 (Needs)'),
                    "note": str(r[3] if len(r) > 3 and r[3] else '')
                })
    else:
        for r in DEFAULT_BUDGETS_ROWS:
            budgets_list.append({
                "category": r[0],
                "budget": r[1],
                "monthlyBudget": r[1],
                "ruleGroup": r[2],
                "note": r[3]
            })

    if budgets_list:
        out["expenseCategories"] = [b["category"] for b in budgets_list]
    out["budgetsList"] = budgets_list

    out["settings"] = {
        "accountBookName": out["accountBookName"],
        "currency": out["currency"],
        "defaultCurrency": out["defaultCurrency"],
        "defaultPaymentMethod": out["defaultPaymentMethod"],
        "aiParseModel": out["aiParseModel"],
        "parseModel": out["parseModel"],
        "aiDiagnosisModel": out["aiDiagnosisModel"],
        "diagnosisModel": out["diagnosisModel"],
        "receiptSplitMode": out["receiptSplitMode"],
        "lineTriggerMode": out["lineTriggerMode"],
        "githubPagesUrl": out["githubPagesUrl"],
        "monthlyAutoAudit": out["monthlyAutoAudit"],
        "activeRichMenuId": out["activeRichMenuId"],
        "subcategoryTaxonomy": out["subcategoryTaxonomyObj"]
    }
    return out

def get_effective_secrets(cloud_settings=None):
    cs = cloud_settings or get_cloud_settings()
    gem_key = os.environ.get('GEMINI_API_KEY', '').strip() or cs.get('SECRET_GEMINI_API_KEY', '').strip()
    line_tok = os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '').strip() or cs.get('SECRET_LINE_TOKEN', '').strip()
    drv_id = os.environ.get('DRIVE_FOLDER_ID', '').strip() or cs.get('SECRET_DRIVE_FOLDER_ID', '').strip()
    return {
        "geminiApiKey": gem_key,
        "lineToken": line_tok,
        "driveFolderId": drv_id
    }

def get_mobile_dashboard_url(cloud_settings=None, request_host=''):
    cs = cloud_settings or get_cloud_settings()
    base_url = (cs.get('githubPagesUrl') or DEFAULT_GITHUB_PAGES_URL).strip()
    api_url = f"https://{request_host}/api/index" if request_host else ""
    dash_token = get_dashboard_token()

    if api_url and 'script.google.com' not in base_url:
        sep = '?' if '?' not in base_url else '&'
        full_url = f"{base_url}{sep}gas_url={ urlencode({'u': api_url})[2:] }&view=mobile"
        if dash_token:
            full_url += f"&token={ urlencode({'t': dash_token})[2:] }"
        return full_url
    return base_url

def save_cloud_settings_and_budgets(params):
    sid = get_spreadsheet_id()
    ts = now_str()
    if not sid:
        return {"ok": False, "error": "尚未在環境變數設定 SPREADSHEET_ID"}

    # 1. 更新 Settings 表
    settings_in = dict(params.get('settings') or {})
    sec = dict(params.get('secrets') or {})
    sec.update(params.get('scriptProperties') or {})

    gem_key = (sec.get('geminiApiKey') or sec.get('GEMINI_API_KEY') or '').strip()
    line_tok = (sec.get('lineToken') or sec.get('LINE_CHANNEL_ACCESS_TOKEN') or '').strip()
    drv_id = (sec.get('driveFolderId') or sec.get('DRIVE_FOLDER_ID') or '').strip()
    if gem_key:
        settings_in['SECRET_GEMINI_API_KEY'] = gem_key
    if line_tok:
        settings_in['SECRET_LINE_TOKEN'] = line_tok
    if drv_id:
        settings_in['SECRET_DRIVE_FOLDER_ID'] = drv_id

    if settings_in:
        if 'currency' in settings_in:
            settings_in['defaultCurrency'] = settings_in['currency']
        if 'defaultCurrency' in settings_in:
            settings_in['currency'] = settings_in['defaultCurrency']
        if 'aiParseModel' in settings_in:
            settings_in['parseModel'] = settings_in['aiParseModel']
        if 'parseModel' in settings_in:
            settings_in['aiParseModel'] = settings_in['parseModel']
        if 'aiDiagnosisModel' in settings_in:
            settings_in['diagnosisModel'] = settings_in['aiDiagnosisModel']
        if 'diagnosisModel' in settings_in:
            settings_in['aiDiagnosisModel'] = settings_in['diagnosisModel']

        existing = get_sheet_values(sid, f"{SHEET_SETTINGS}!A1:D200")
        if not existing:
            existing = [['Key', 'Value', 'Description', 'UpdatedAt']]

        key_map = {}
        for idx in range(1, len(existing)):
            if existing[idx] and len(existing[idx]) > 0:
                key_map[str(existing[idx][0]).strip()] = idx

        skip_keys = {'budgetsList', 'expenseCategories', 'settings', 'subcategoryTaxonomyObj'}
        for k, raw_val in settings_in.items():
            if k in skip_keys or raw_val is None:
                continue
            val_str = json.dumps(raw_val, ensure_ascii=False) if isinstance(raw_val, (dict, list)) else str(raw_val)
            if k in key_map:
                row_idx = key_map[k]
                while len(existing[row_idx]) < 4:
                    existing[row_idx].append('')
                existing[row_idx][1] = val_str
                existing[row_idx][3] = ts
            else:
                existing.append([k, val_str, '跨裝置同步設定', ts])
                key_map[k] = len(existing) - 1

        update_sheet_values(sid, f"{SHEET_SETTINGS}!A1", existing)

    # 2. 更新 Budgets 表
    budgets_in = params.get('budgets')
    if isinstance(budgets_in, list) and len(budgets_in) > 0:
        clear_sheet_range(sid, f"{SHEET_BUDGETS}!A2:D100")
        b_rows = [['Category', 'MonthlyBudget', 'RuleGroup', 'Note']]
        for b in budgets_in:
            if not b or not str(b.get('category') or '').strip():
                continue
            amt = b.get('budget') if b.get('budget') is not None else b.get('monthlyBudget', 0)
            b_rows.append([
                str(b['category']).strip(),
                max(0, safe_float(amt)),
                str(b.get('ruleGroup') or '必要支出 (Needs)'),
                str(b.get('note') or '')
            ])
        update_sheet_values(sid, f"{SHEET_BUDGETS}!A1", b_rows)

    return {
        "ok": True,
        "syncedAt": ts,
        "cloudSettings": get_cloud_settings(),
        "message": "✅ 設定已成功寫入 Google Sheets，所有裝置與 LINE 皆已同步！"
    }

def update_category_budget(category, new_budget):
    sid = get_spreadsheet_id()
    if not sid:
        return {"ok": False, "error": "尚未設定 SPREADSHEET_ID"}
    rows = get_sheet_values(sid, f"{SHEET_BUDGETS}!A1:D100")
    if not rows:
        rows = [['Category', 'MonthlyBudget', 'RuleGroup', 'Note']] + DEFAULT_BUDGETS_ROWS

    found = False
    for i in range(1, len(rows)):
        if rows[i] and str(rows[i][0]).strip() == str(category).strip():
            while len(rows[i]) < 4:
                rows[i].append('')
            rows[i][1] = max(0, safe_float(new_budget))
            found = True
            break

    if not found:
        rows.append([str(category).strip(), max(0, safe_float(new_budget)), '想要支出 (Wants)', '自訂分類'])

    update_sheet_values(sid, f"{SHEET_BUDGETS}!A1", rows)
    return {"ok": True, "message": f"已更新「{category}」月預算為 ${int(safe_float(new_budget)):,}"}

# ============================================================================
# LINE 使用者對話 Session 狀態管理
# ============================================================================

def get_user_session_state(user_id):
    key = f"LINE_ACC_STATE_{user_id or 'default'}"
    now_ms = int(time.time() * 1000)

    if key in _MEMORY_SESSIONS:
        st = _MEMORY_SESSIONS[key]
        if st.get('expiresAt', 0) > now_ms:
            return st

    cs = get_cloud_settings()
    raw = cs.get(key)
    if raw:
        try:
            parsed = json.loads(raw)
            if parsed.get('expiresAt', 0) > now_ms:
                _MEMORY_SESSIONS[key] = parsed
                return parsed
        except Exception:
            pass
    return {"mode": "IDLE"}

def set_user_session_state(user_id, state_obj, ttl_seconds=600):
    key = f"LINE_ACC_STATE_{user_id or 'default'}"
    now_ms = int(time.time() * 1000)
    payload = dict(state_obj or {})
    payload["updatedAt"] = now_ms
    payload["expiresAt"] = now_ms + (ttl_seconds * 1000)
    _MEMORY_SESSIONS[key] = payload
    try:
        save_cloud_settings_and_budgets({"settings": {key: json.dumps(payload, ensure_ascii=False)}})
    except Exception:
        pass

def clear_user_session_state(user_id):
    key = f"LINE_ACC_STATE_{user_id or 'default'}"
    _MEMORY_SESSIONS.pop(key, None)
    try:
        save_cloud_settings_and_budgets({"settings": {key: ""}})
    except Exception:
        pass

# ============================================================================
# RawLogs 與 Transactions 核心讀寫
# ============================================================================

def create_raw_log(info):
    sid = get_spreadsheet_id()
    dt = now_taipei()
    ts = dt.strftime('%Y-%m-%d %H:%M:%S')
    log_id = f"LOG-{dt.strftime('%Y%m%d-%H%M%S')}-{random.randint(100, 999)}"
    row = [
        log_id,
        ts,
        info.get('userId') or 'unknown',
        info.get('messageType') or 'text',
        info.get('rawText') or '',
        info.get('driveFileId') or '',
        info.get('driveUrl') or '',
        'PENDING',
        0,
        '',
        0,
        ts
    ]
    if sid:
        append_sheet_values(sid, f"{SHEET_RAW_LOGS}!A1", [row])
    return {
        "logId": log_id,
        "receivedAt": ts,
        "userId": info.get('userId'),
        "messageType": info.get('messageType'),
        "rawText": info.get('rawText'),
        "driveFileId": info.get('driveFileId', ''),
        "driveUrl": info.get('driveUrl', '')
    }

def update_raw_log_status(log_id, status, parsed_count=0, error_message='', increment_retry=False):
    sid = get_spreadsheet_id()
    if not sid or not log_id:
        return
    rows = get_sheet_values(sid, f"{SHEET_RAW_LOGS}!A1:L500")
    if not rows or len(rows) <= 1:
        return
    ts = now_str()
    for i in range(len(rows) - 1, 0, -1):
        if rows[i] and str(rows[i][0]) == str(log_id):
            row_num = i + 1
            cur_retries = int(safe_float(rows[i][10] if len(rows[i]) > 10 else 0))
            next_retries = cur_retries + 1 if increment_retry else cur_retries
            update_sheet_values(
                sid,
                f"{SHEET_RAW_LOGS}!H{row_num}:L{row_num}",
                [[status, parsed_count or 0, error_message or '', next_retries, ts]]
            )
            break

def get_recent_raw_logs(limit=30, sheets_cache=None):
    sid = get_spreadsheet_id()
    rows = (
        sheets_cache.get(SHEET_RAW_LOGS)
        if sheets_cache and SHEET_RAW_LOGS in sheets_cache
        else (get_sheet_values(sid, f"{SHEET_RAW_LOGS}!A1:L500") if sid else [])
    )
    if not rows or len(rows) <= 1:
        return {"logs": [], "pendingOrFailedCount": 0}

    logs = []
    pending_or_failed = 0
    for i in range(len(rows) - 1, 0, -1):
        r = rows[i]
        if not r:
            continue
        status = str(r[7] if len(r) > 7 else '')
        if status in ('FAILED', 'PENDING'):
            pending_or_failed += 1
        if len(logs) < limit:
            logs.append({
                "logId": str(r[0] if len(r) > 0 else ''),
                "receivedAt": str(r[1] if len(r) > 1 else ''),
                "userId": str(r[2] if len(r) > 2 else ''),
                "messageType": str(r[3] if len(r) > 3 else ''),
                "rawText": str(r[4] if len(r) > 4 else ''),
                "driveFileId": str(r[5] if len(r) > 5 else ''),
                "driveUrl": str(r[6] if len(r) > 6 else ''),
                "status": status,
                "parsedCount": int(safe_float(r[8] if len(r) > 8 else 0)),
                "errorMessage": str(r[9] if len(r) > 9 else ''),
                "retryCount": int(safe_float(r[10] if len(r) > 10 else 0)),
                "updatedAt": str(r[11] if len(r) > 11 else '')
            })
    return {"logs": logs, "pendingOrFailedCount": pending_or_failed}

def save_transactions_batch(items, log_entry=None, cloud_settings=None):
    sid = get_spreadsheet_id()
    cs = cloud_settings or get_cloud_settings()
    dt = now_taipei()
    created_at = dt.strftime('%Y-%m-%d %H:%M:%S')
    default_time = dt.strftime('%H:%M')
    default_date = dt.strftime('%Y-%m-%d')
    batch_id = f"BATCH-{dt.strftime('%Y%m%d-%H%M%S')}-{random.randint(100, 999)}"

    saved_transactions = []
    rows_to_append = []

    for idx, item in enumerate(items):
        tx_id = f"TX-{dt.strftime('%Y%m%d-%H%M%S')}-{idx + 1}-{random.randint(10, 99)}"
        tx_type = '收入' if item.get('type') == '收入' else '支出'
        tx_obj = {
            "txId": tx_id,
            "batchId": batch_id,
            "date": item.get('date') or default_date,
            "time": item.get('time') or default_time,
            "type": tx_type,
            "category": item.get('category') or ('其他收入' if tx_type == '收入' else '其他支出'),
            "subcategory": item.get('subcategory') or '一般',
            "item": item.get('item') or '未命名項目',
            "amount": abs(safe_float(item.get('amount'), 0)),
            "currency": item.get('currency') or cs.get('defaultCurrency') or 'TWD',
            "paymentMethod": item.get('paymentMethod') or cs.get('defaultPaymentMethod') or '現金',
            "merchant": item.get('merchant') or '',
            "invoiceNo": item.get('invoiceNo') or '',
            "imageUrl": (log_entry.get('driveUrl') if log_entry else '') or '',
            "rawLogId": (log_entry.get('logId') if log_entry else '') or 'MANUAL',
            "status": "active",
            "createdAt": created_at,
            "note": item.get('note') or ''
        }
        saved_transactions.append(tx_obj)
        rows_to_append.append([
            tx_obj["txId"],
            tx_obj["batchId"],
            tx_obj["date"],
            tx_obj["time"],
            tx_obj["type"],
            tx_obj["category"],
            tx_obj["subcategory"],
            tx_obj["item"],
            tx_obj["amount"],
            tx_obj["currency"],
            tx_obj["paymentMethod"],
            tx_obj["merchant"],
            tx_obj["invoiceNo"],
            tx_obj["imageUrl"],
            tx_obj["rawLogId"],
            tx_obj["status"],
            tx_obj["createdAt"],
            tx_obj["note"]
        ])

    if sid and rows_to_append:
        append_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1", rows_to_append)

    return {
        "batchId": batch_id,
        "transactions": saved_transactions,
        "imageUrl": (log_entry.get('driveUrl') if log_entry else '') or ''
    }

def delete_transaction_by_id(tx_id):
    sid = get_spreadsheet_id()
    if not sid:
        return {"ok": False, "error": "尚未設定 SPREADSHEET_ID"}
    rows = get_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1:R5000")
    if not rows or len(rows) <= 1:
        return {"ok": False, "error": "找不到 Transactions 資料"}

    for i in range(len(rows) - 1, 0, -1):
        r = rows[i]
        if r and str(r[0]) == str(tx_id):
            row_num = i + 1
            update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!P{row_num}", [['deleted']])
            item_name = r[7] if len(r) > 7 else ''
            amt = r[8] if len(r) > 8 else 0
            return {"ok": True, "message": f"↩️ 已撤銷紀錄：{item_name} (${amt})"}

    return {"ok": False, "error": f"找不到交易編號 {tx_id}"}

def delete_transactions_by_batch_id(batch_id):
    sid = get_spreadsheet_id()
    if not sid:
        return {"ok": False, "message": "尚未設定 SPREADSHEET_ID"}
    rows = get_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1:R5000")
    if not rows or len(rows) <= 1:
        return {"ok": False, "message": "找不到 Transactions 資料"}

    deleted_items = []
    for i in range(len(rows) - 1, 0, -1):
        r = rows[i]
        status = str(r[15] if len(r) > 15 else 'active')
        if r and len(r) > 1 and str(r[1]) == str(batch_id) and status == 'active':
            row_num = i + 1
            update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!P{row_num}", [['deleted']])
            deleted_items.append(f"{r[7] if len(r) > 7 else ''} (${r[8] if len(r) > 8 else 0})")

    if not deleted_items:
        return {"ok": False, "message": "此筆記帳已撤銷過或不存在。"}
    deleted_items.reverse()
    return {
        "ok": True,
        "message": f"↩️ 已撤銷 {len(deleted_items)} 筆紀錄：\n• " + "\n• ".join(deleted_items)
    }

def undo_last_batch():
    sid = get_spreadsheet_id()
    if not sid:
        return {"ok": False, "message": "尚未設定 SPREADSHEET_ID"}
    rows = get_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1:R5000")
    if not rows or len(rows) <= 1:
        return {"ok": False, "message": "目前試算表中沒有可撤銷的記帳紀錄。"}

    target_batch_id = ''
    for i in range(len(rows) - 1, 0, -1):
        r = rows[i]
        status = str(r[15] if len(r) > 15 else 'active')
        if r and len(r) > 1 and status == 'active':
            target_batch_id = str(r[1])
            break

    if not target_batch_id:
        return {"ok": False, "message": "找不到任何有效的記帳紀錄可撤銷。"}
    return delete_transactions_by_batch_id(target_batch_id)

def modify_last_transaction_by_instruction(instruction):
    sid = get_spreadsheet_id()
    if not sid:
        return {"ok": False, "message": "尚未設定 SPREADSHEET_ID"}
    rows = get_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1:R5000")
    if not rows or len(rows) <= 1:
        return {"ok": False, "message": "目前沒有可修改的記帳紀錄。"}

    target_idx = -1
    for i in range(len(rows) - 1, 0, -1):
        r = rows[i]
        status = str(r[15] if len(r) > 15 else 'active')
        if r and status == 'active':
            target_idx = i
            break

    if target_idx == -1:
        return {"ok": False, "message": "找不到可修改的有效紀錄。"}

    row = rows[target_idx]
    row_num = target_idx + 1
    parts = instruction.strip().split()
    if len(parts) >= 2:
        field = parts[0]
        val = ' '.join(parts[1:])
        item_name = row[7] if len(row) > 7 else ''
        if re.match(r'^(金額|價錢|價格|amount)$', field, re.I):
            num = safe_float(re.sub(r'[^0-9.]', '', val), -1)
            if num > 0:
                update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!I{row_num}", [[num]])
                return {"ok": True, "message": f"✏️ 已將「{item_name}」金額修改為 ${int(num):,}"}
        elif re.match(r'^(分類|類別|category)$', field, re.I):
            update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!F{row_num}", [[val]])
            return {"ok": True, "message": f"✏️ 已將「{item_name}」分類修改為「{val}」"}
        elif re.match(r'^(品項|項目|名稱|說明|item)$', field, re.I):
            update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!H{row_num}", [[val]])
            return {"ok": True, "message": f"✏️ 已將品項修改為「{val}」"}
        elif re.match(r'^(支付|支付方式|付款方式)$', field, re.I):
            update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!K{row_num}", [[val]])
            return {"ok": True, "message": f"✏️ 已將支付方式修改為「{val}」"}
        elif re.match(r'^(日期|date)$', field, re.I):
            update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!C{row_num}", [[val]])
            return {"ok": True, "message": f"✏️ 已將日期修改為「{val}」"}

    return {
        "ok": False,
        "message": "💡 修改範例：\n• 修改上一筆 金額 150\n• 修改上一筆 分類 休閒娛樂\n• 修改上一筆 品項 超商咖啡"
    }

def process_raw_log_entry(log_entry, reply_token=None, preloaded_image=None, request_host=''):
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    mobile_url = get_mobile_dashboard_url(cs, request_host)

    try:
        parse_result = parse_accounting_input_with_gemini({
            "messageType": log_entry.get("messageType"),
            "rawText": log_entry.get("rawText"),
            "driveFileId": log_entry.get("driveFileId"),
            "preloadedImage": preloaded_image
        }, cs, api_key=secrets["geminiApiKey"])

        items = parse_result.get("items") or []
        if not parse_result.get("isAccounting") or len(items) == 0:
            note = parse_result.get("assistantNote") or "非記帳訊息或無有效金額"
            update_raw_log_status(log_entry["logId"], "SUCCESS", 0, note)
            if reply_token:
                reply_line_text(
                    reply_token,
                    parse_result.get("assistantNote") or "💡 未能辨識出有效的記帳品項與金額。\n請點選下方圖文選單【✍️ 點選記帳】後輸入如「午餐便當 120」。",
                    mobile_url=mobile_url,
                    override_token=secrets["lineToken"]
                )
            return {"ok": True, "count": 0}

        saved_batch = save_transactions_batch(items, log_entry, cs)
        update_raw_log_status(log_entry["logId"], "SUCCESS", len(saved_batch["transactions"]), "")

        if reply_token:
            flex_msg = build_receipt_confirm_flex(saved_batch, parse_result.get("assistantNote", ""), mobile_url)
            reply_line_messages(reply_token, [flex_msg], override_token=secrets["lineToken"])

        return {
            "ok": True,
            "count": len(saved_batch["transactions"]),
            "batchId": saved_batch["batchId"]
        }
    except Exception as err:
        err_msg = str(err)
        update_raw_log_status(log_entry["logId"], "FAILED", 0, err_msg)
        if reply_token:
            reply_line_text(
                reply_token,
                f"⚠️ AI 解析暫時忙碌，原始紀錄已安全備份（{log_entry['logId']}），稍後可於網頁點擊重試補登。\n原因：{err_msg[:120]}",
                mobile_url=mobile_url,
                override_token=secrets["lineToken"]
            )
        return {"ok": False, "error": err_msg}

def retry_failed_logs():
    sid = get_spreadsheet_id()
    if not sid:
        return {"checked": 0, "recovered": 0, "stillFailed": 0}
    rows = get_sheet_values(sid, f"{SHEET_RAW_LOGS}!A1:L500")
    if not rows or len(rows) <= 1:
        return {"checked": 0, "recovered": 0, "stillFailed": 0}

    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    checked = 0
    recovered = 0
    still_failed = 0

    for i in range(1, len(rows)):
        r = rows[i]
        if not r or len(r) < 8:
            continue
        log_id = r[0]
        msg_type = r[3] if len(r) > 3 else 'text'
        raw_text = r[4] if len(r) > 4 else ''
        drive_file_id = r[5] if len(r) > 5 else ''
        drive_url = r[6] if len(r) > 6 else ''
        status = str(r[7])
        retry_count = int(safe_float(r[10] if len(r) > 10 else 0))

        if status in ('FAILED', 'PENDING') and retry_count < 5 and msg_type == 'text':
            if checked >= 5:
                break
            checked += 1
            try:
                parse_res = parse_accounting_input_with_gemini({
                    "messageType": msg_type,
                    "rawText": raw_text,
                    "driveFileId": drive_file_id,
                    "preloadedImage": None
                }, cs, api_key=secrets["geminiApiKey"])
                items = parse_res.get("items") or []
                if parse_res.get("isAccounting") and len(items) > 0:
                    save_transactions_batch(items, {"logId": log_id, "driveUrl": drive_url}, cs)
                    update_raw_log_status(log_id, "RETRIED_SUCCESS", len(items), "", True)
                else:
                    update_raw_log_status(log_id, "RETRIED_SUCCESS", 0, "重試完成：非記帳項目", True)
                recovered += 1
            except Exception as e:
                update_raw_log_status(log_id, "FAILED", 0, str(e), True)
                still_failed += 1

    return {"checked": checked, "recovered": recovered, "stillFailed": still_failed}

# ============================================================================
# 月度報表統計與 AI 診斷引擎（與前端儀表板 100% 欄位對齊）
# ============================================================================

def get_monthly_summary_data(year_month=None, sheets_cache=None):
    sid = get_spreadsheet_id()
    default_ym = now_taipei().strftime('%Y-%m')
    filter_month = str(year_month).strip() if (year_month and year_month != 'ALL') else ''

    budget_rows = (
        sheets_cache.get(SHEET_BUDGETS)
        if sheets_cache and SHEET_BUDGETS in sheets_cache
        else (get_sheet_values(sid, f"{SHEET_BUDGETS}!A1:D100") if sid else [])
    )

    budgets_map = {}
    total_monthly_budget = 0.0
    if budget_rows and len(budget_rows) > 1:
        for r in budget_rows[1:]:
            if not r:
                continue
            cat = str(r[0] or '').strip()
            amt = safe_float(r[1] if len(r) > 1 else 0)
            group = str(r[2] if len(r) > 2 and r[2] else '必要支出 (Needs)')
            note = str(r[3] if len(r) > 3 and r[3] else '')
            if cat:
                budgets_map[cat] = {"budget": amt, "ruleGroup": group, "note": note}
                total_monthly_budget += amt
    else:
        for r in DEFAULT_BUDGETS_ROWS:
            budgets_map[r[0]] = {"budget": float(r[1]), "ruleGroup": r[2], "note": r[3]}
            total_monthly_budget += float(r[1])

    tx_rows = (
        sheets_cache.get(SHEET_TRANSACTIONS)
        if sheets_cache and SHEET_TRANSACTIONS in sheets_cache
        else (get_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1:R5000") if sid else [])
    )

    transactions = []
    total_expense = 0.0
    total_income = 0.0
    category_stats = {}
    subcategory_stats = {}
    daily_map = {}
    payment_map = {}
    merchant_map = {}

    if tx_rows and len(tx_rows) > 1:
        for i in range(1, len(tx_rows)):
            row = tx_rows[i]
            if not row:
                continue
            status = str(row[15] if len(row) > 15 and row[15] else 'active')
            if status != 'active':
                continue

            date_str = format_date_cell(row[2] if len(row) > 2 else '')
            if filter_month and not date_str.startswith(filter_month):
                continue

            tx_type = str(row[4] if len(row) > 4 and row[4] else '支出')
            category = str(row[5] if len(row) > 5 and row[5] else '其他支出').strip() or '其他支出'
            subcategory = str(row[6] if len(row) > 6 and row[6] else '一般').strip() or '一般'
            amount = safe_float(row[8] if len(row) > 8 else 0)
            payment = str(row[10] if len(row) > 10 and row[10] else '現金')
            merchant = str(row[11] if len(row) > 11 and row[11] else '')

            tx_obj = {
                "txId": str(row[0] if len(row) > 0 else ''),
                "batchId": str(row[1] if len(row) > 1 else ''),
                "date": date_str,
                "time": format_time_cell(row[3] if len(row) > 3 else ''),
                "type": tx_type,
                "category": category,
                "subcategory": subcategory,
                "item": str(row[7] if len(row) > 7 and row[7] else ''),
                "amount": amount,
                "currency": str(row[9] if len(row) > 9 and row[9] else 'TWD'),
                "paymentMethod": payment,
                "merchant": merchant,
                "invoiceNo": str(row[12] if len(row) > 12 and row[12] else ''),
                "imageUrl": str(row[13] if len(row) > 13 and row[13] else ''),
                "rawLogId": str(row[14] if len(row) > 14 and row[14] else ''),
                "status": status,
                "createdAt": str(row[16] if len(row) > 16 and row[16] else ''),
                "note": str(row[17] if len(row) > 17 and row[17] else ''),
                "sheetRowNum": i + 1
            }
            transactions.append(tx_obj)

            if tx_type == '收入':
                total_income += amount
            else:
                total_expense += amount
                if category not in category_stats:
                    b_info = budgets_map.get(category, {"budget": 0, "ruleGroup": "想要支出 (Wants)"})
                    category_stats[category] = {
                        "category": category,
                        "amount": 0.0,
                        "count": 0,
                        "budget": b_info["budget"],
                        "ruleGroup": b_info["ruleGroup"],
                        "subMap": {}
                    }
                category_stats[category]["amount"] += amount
                category_stats[category]["count"] += 1
                sub_map = category_stats[category]["subMap"]
                sub_map[subcategory] = sub_map.get(subcategory, 0.0) + amount

                sub_key = f"{category} > {subcategory}"
                if sub_key not in subcategory_stats:
                    subcategory_stats[sub_key] = {
                        "fullLabel": sub_key,
                        "category": category,
                        "subcategory": subcategory,
                        "amount": 0.0,
                        "count": 0
                    }
                subcategory_stats[sub_key]["amount"] += amount
                subcategory_stats[sub_key]["count"] += 1

                payment_map[payment] = payment_map.get(payment, 0.0) + amount
                if merchant:
                    merchant_map[merchant] = merchant_map.get(merchant, 0.0) + amount

            if date_str:
                if date_str not in daily_map:
                    daily_map[date_str] = {"date": date_str, "expense": 0.0, "income": 0.0}
                if tx_type == '收入':
                    daily_map[date_str]["income"] += amount
                else:
                    daily_map[date_str]["expense"] += amount

    for cat, b_info in budgets_map.items():
        if cat not in category_stats:
            category_stats[cat] = {
                "category": cat,
                "amount": 0.0,
                "count": 0,
                "budget": b_info["budget"],
                "ruleGroup": b_info["ruleGroup"],
                "subMap": {}
            }

    category_list = []
    for c in category_stats.values():
        sub_breakdown = []
        for sub_name, sub_amt in c["subMap"].items():
            pct = round((sub_amt / c["amount"]) * 100) if c["amount"] > 0 else 0
            sub_breakdown.append({
                "subcategory": sub_name,
                "amount": sub_amt,
                "pctOfCat": pct
            })
        sub_breakdown.sort(key=lambda x: x["amount"], reverse=True)
        category_list.append({
            "category": c["category"],
            "amount": c["amount"],
            "count": c["count"],
            "budget": c["budget"],
            "ruleGroup": c["ruleGroup"],
            "subBreakdown": sub_breakdown
        })
    category_list.sort(key=lambda x: (x["amount"], x["budget"]), reverse=True)

    subcategory_list = []
    for s in subcategory_stats.values():
        pct_total = round((s["amount"] / total_expense) * 100, 1) if total_expense > 0 else 0
        item_copy = dict(s)
        item_copy["pctOfTotal"] = pct_total
        item_copy["shareOfTotalPct"] = pct_total
        subcategory_list.append(item_copy)
    subcategory_list.sort(key=lambda x: x["amount"], reverse=True)

    daily_list = sorted(daily_map.values(), key=lambda x: x["date"])
    transactions.sort(key=lambda x: f"{x['date']} {x['time']}", reverse=True)

    net_savings = total_income - total_expense
    savings_rate = round((net_savings / total_income) * 100) if total_income > 0 else 0
    budget_usage_rate = round((total_expense / total_monthly_budget) * 100) if total_monthly_budget > 0 else 0

    return {
        "yearMonth": year_month or default_ym,
        "totalIncome": total_income,
        "totalExpense": total_expense,
        "netSavings": net_savings,
        "savingsRate": savings_rate,
        "totalMonthlyBudget": total_monthly_budget,
        "budgetUsageRate": budget_usage_rate,
        "transactionCount": len(transactions),
        "categories": category_list,
        "subcategories": subcategory_list,
        "dailyTrend": daily_list,
        "paymentBreakdown": payment_map,
        "topMerchants": merchant_map,
        "transactions": transactions
    }

def build_ultra_compact_digest(summary, include_tx_ids_for_audit=False):
    cat_lines = []
    for c in summary.get("categories", []):
        if c.get("amount", 0) > 0 or c.get("budget", 0) > 0:
            subs = ",".join([f"{s['subcategory']}:{int(s['amount'])}" for s in c.get("subBreakdown", [])])
            rg = (c.get("ruleGroup") or "").split(" ")[0]
            cat_lines.append(f"{c['category']}:{int(c['amount'])}/{int(c['budget'])}({rg})[{subs}]")

    if include_tx_ids_for_audit:
        exp_txs = [t for t in summary.get("transactions", []) if t.get("type") == "支出"][:120]
        tx_compact = "\n".join([
            f"{t['txId']}|{t['category']}|{t['subcategory']}|{t['item']}|{t.get('merchant') or '-'}|{int(t['amount'])}"
            for t in exp_txs
        ])
        tx_header = f"TX(TxID|Cat|Subcat|Item|Merch|Amt):\n{tx_compact}"
    else:
        grouped = {}
        for t in summary.get("transactions", []):
            if t.get("type") == "支出":
                k = f"{t['category']}>{t['subcategory']}|{t['item']}|{t.get('merchant') or '-'}"
                if k not in grouped:
                    grouped[k] = {"count": 0, "total": 0.0}
                grouped[k]["count"] += 1
                grouped[k]["total"] += t["amount"]
        sorted_items = sorted(grouped.items(), key=lambda x: x[1]["total"], reverse=True)[:45]
        tx_compact = "\n".join([f"{k}|x{v['count']}|${int(v['total'])}" for k, v in sorted_items])
        tx_header = f"ITEMS(Cat>Subcat|Item|Merch|Freq|Total):\n{tx_compact}"

    compact_text = "\n".join([
        f"M:{summary.get('yearMonth')} Inc:{int(summary.get('totalIncome', 0))} Exp:{int(summary.get('totalExpense', 0))} Sav:{int(summary.get('netSavings', 0))}({summary.get('savingsRate', 0)}%) Bud:{int(summary.get('totalMonthlyBudget', 0))}({summary.get('budgetUsageRate', 0)}%)",
        f"CATS: {' | '.join(cat_lines)}",
        f"PAY: {json.dumps(summary.get('paymentBreakdown', {}), ensure_ascii=False)}",
        tx_header
    ])
    return {"digestText": compact_text}

def save_ai_report_to_sheet(report_obj, trigger_source='WEB'):
    sid = get_spreadsheet_id()
    if not sid:
        return
    dt = now_taipei()
    report_id = f"REP-{dt.strftime('%Y%m%d-%H%M%S')}"
    row = [
        report_id,
        report_obj.get('generatedAt') or dt.strftime('%Y-%m-%d %H:%M:%S'),
        report_obj.get('period') or dt.strftime('%Y-%m'),
        report_obj.get('totalIncome') or 0,
        report_obj.get('totalExpense') or 0,
        report_obj.get('healthScore') or 0,
        json.dumps(report_obj, ensure_ascii=False),
        trigger_source
    ]
    append_sheet_values(sid, f"{SHEET_AI_REPORTS}!A1", [row])

def get_latest_ai_report(year_month=None, sheets_cache=None):
    sid = get_spreadsheet_id()
    rows = (
        sheets_cache.get(SHEET_AI_REPORTS)
        if sheets_cache and SHEET_AI_REPORTS in sheets_cache
        else (get_sheet_values(sid, f"{SHEET_AI_REPORTS}!A1:H200") if sid else [])
    )
    if not rows or len(rows) <= 1:
        return None

    for i in range(len(rows) - 1, 0, -1):
        r = rows[i]
        if not r or len(r) < 7:
            continue
        if not year_month or year_month == 'ALL' or str(r[2]) == str(year_month):
            try:
                return json.loads(str(r[6]))
            except Exception:
                return None
    return None

def generate_ai_financial_diagnosis(year_month=None, trigger_source='WEB_DASHBOARD', run_category_calibration=False):
    if run_category_calibration:
        return run_monthly_category_audit_and_diagnosis(year_month, trigger_source)

    target_month = year_month or now_taipei().strftime('%Y-%m')
    summary = get_monthly_summary_data(target_month)
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    compact = build_ultra_compact_digest(summary, False)

    system_instruction = (
        "你是台灣資深CFP財務顧問。請根據帳務摘要進行簡潔精準的消費診斷（繁體中文）。\n"
        "重點：1.分析主分類與子分類佔比；2.檢視50/30/20法則；3.抓出拿鐵因子與超支預警；4.給出具體省錢建議。"
    )
    resp_text = call_gemini_interactions_api(
        model=cs.get('diagnosisModel') or DEFAULT_DIAGNOSIS_MODEL,
        system_instruction=system_instruction,
        input_parts=[{"type": "text", "text": compact["digestText"]}],
        schema=get_diagnosis_and_audit_schema(False),
        api_key=secrets["geminiApiKey"]
    )
    clean = resp_text.replace('```json', '').replace('```', '').strip()
    report_obj = json.loads(clean)
    report_obj["period"] = target_month
    report_obj["generatedAt"] = now_str()
    report_obj["totalIncome"] = summary["totalIncome"]
    report_obj["totalExpense"] = summary["totalExpense"]

    save_ai_report_to_sheet(report_obj, trigger_source)
    return report_obj

def run_monthly_category_audit_and_diagnosis(year_month=None, trigger_source='WEB_MONTHLY_AUDIT'):
    target_month = year_month or now_taipei().strftime('%Y-%m')
    summary = get_monthly_summary_data(target_month)
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    tax_obj = cs.get("subcategoryTaxonomyObj") or DEFAULT_SUBCATEGORY_TAXONOMY
    compact = build_ultra_compact_digest(summary, True)

    compact_tax_str = "; ".join([f"{c}[{'/'.join(tax_obj.get(c, []))}]" for c in tax_obj])
    system_instruction = "\n".join([
        "你是台灣個人記帳分類精細化專家與CFP財務分析師（繁體中文）。",
        "任務1【月度最細分類校準】：檢視TX清單，若任何交易的Category或Subcategory不夠精確或歸類錯誤，請在reclassifications陣列輸出修正後的最細分類(newCategory與newSubcategory)。",
        f"現有分類樹參考：{compact_tax_str}",
        "任務2【深度消費狀況分析】：剖析使用者本月的消費結構與具體改善建議。"
    ])

    resp_text = call_gemini_interactions_api(
        model=cs.get('diagnosisModel') or DEFAULT_DIAGNOSIS_MODEL,
        system_instruction=system_instruction,
        input_parts=[{"type": "text", "text": compact["digestText"]}],
        schema=get_diagnosis_and_audit_schema(True),
        api_key=secrets["geminiApiKey"]
    )
    clean = resp_text.replace('```json', '').replace('```', '').strip()
    result_obj = json.loads(clean)

    # 套用分類修正
    sid = get_spreadsheet_id()
    reclassifications = result_obj.get("reclassifications") or []
    reclassified_count = 0
    if sid and reclassifications:
        map_by_tx = {str(r["txId"]): r for r in reclassifications if r and r.get("txId")}
        tx_rows = get_sheet_values(sid, f"{SHEET_TRANSACTIONS}!A1:R5000")
        if tx_rows and len(tx_rows) > 1:
            for i in range(1, len(tx_rows)):
                tx_id = str(tx_rows[i][0]) if tx_rows[i] else ''
                if tx_id in map_by_tx:
                    item = map_by_tx[tx_id]
                    row_num = i + 1
                    new_cat = str(item.get("newCategory") or '').strip()
                    new_sub = str(item.get("newSubcategory") or '').strip()
                    if new_cat and new_sub:
                        update_sheet_values(sid, f"{SHEET_TRANSACTIONS}!F{row_num}:G{row_num}", [[new_cat, new_sub]])
                        reclassified_count += 1

    new_adds = result_obj.get("newTaxonomyAdditions") or []
    for add in new_adds:
        if not add or not add.get("category") or not add.get("subcategory"):
            continue
        c = str(add["category"]).strip()
        s = str(add["subcategory"]).strip()
        if c not in tax_obj:
            tax_obj[c] = []
        if s not in tax_obj[c]:
            tax_obj[c].append(s)

    save_cloud_settings_and_budgets({
        "settings": {
            "subcategoryTaxonomy": json.dumps(tax_obj, ensure_ascii=False),
            "lastMonthlyAuditMonth": target_month
        }
    })

    result_obj["period"] = target_month
    result_obj["generatedAt"] = now_str()
    result_obj["totalIncome"] = summary["totalIncome"]
    result_obj["totalExpense"] = summary["totalExpense"]
    result_obj["reclassifiedCount"] = reclassified_count

    save_ai_report_to_sheet(result_obj, trigger_source)
    return result_obj

def ask_gemini_about_finances(question, year_month=None):
    target_month = year_month or now_taipei().strftime('%Y-%m')
    summary = get_monthly_summary_data(target_month)
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    compact = build_ultra_compact_digest(summary, False)

    answer = call_gemini_interactions_api(
        model=cs.get('parseModel') or DEFAULT_PARSE_MODEL,
        system_instruction="你是使用者的專屬AI財務分析師。請根據提供的帳務摘要，簡潔有條理地回答問題並引用具體分類與金額（繁體中文）。",
        input_parts=[{"type": "text", "text": f"{compact['digestText']}\n\n問題：{question}"}],
        api_key=secrets["geminiApiKey"]
    )
    return {"ok": True, "answer": answer}

def get_dashboard_bootstrap_data(year_month=None, request_host=''):
    sid = get_spreadsheet_id()
    target_month = year_month or now_taipei().strftime('%Y-%m')
    sheets_cache = batch_get_all_sheets(sid) if sid else {}

    summary = get_monthly_summary_data(target_month, sheets_cache=sheets_cache)
    raw_logs = get_recent_raw_logs(30, sheets_cache=sheets_cache)
    latest_report = get_latest_ai_report(target_month, sheets_cache=sheets_cache)
    cloud_settings = get_cloud_settings(sheets_cache=sheets_cache)
    secrets = get_effective_secrets(cloud_settings)
    api_url = f"https://{request_host}/api/index" if request_host else ""

    return {
        "ok": True,
        "syncedAt": now_str(),
        "summary": summary,
        "rawLogs": raw_logs,
        "latestReport": latest_report,
        "cloudSettings": cloud_settings,
        "systemStatus": {
            "hasGeminiKey": bool(secrets["geminiApiKey"]),
            "hasLineToken": bool(secrets["lineToken"]),
            "hasDashboardToken": bool(get_dashboard_token()),
            "driveFolderId": secrets["driveFolderId"],
            "spreadsheetUrl": f"https://docs.google.com/spreadsheets/d/{sid}/edit" if sid else "",
            "webAppUrl": api_url,
            "mobileDashboardUrl": get_mobile_dashboard_url(cloud_settings, request_host)
        }
    }

# ============================================================================
# LINE Webhook 事件與 Postback 處理
# ============================================================================

def execute_image_accounting(user_id, message_id, reply_token, require_confirm_preview=False, request_host=''):
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    mobile_url = get_mobile_dashboard_url(cs, request_host)

    img_bytes, content_type = get_line_message_content(message_id, override_token=secrets["lineToken"])
    if not img_bytes:
        log_entry = create_raw_log({
            "userId": user_id,
            "messageType": "image",
            "rawText": f"[LINE Image ID: {message_id}]"
        })
        update_raw_log_status(log_entry["logId"], "FAILED", 0, "LINE 圖片下載失敗")
        reply_line_text(
            reply_token,
            f"⚠️ 收到收據圖片但下載時發生異常（編號：{log_entry['logId']}）。",
            mobile_url=mobile_url,
            override_token=secrets["lineToken"]
        )
        return

    b64_str = base64.b64encode(img_bytes).decode('utf-8')
    ext = 'png' if 'png' in (content_type or '') else 'jpg'
    fname = f"Receipt_{now_taipei().strftime('%Y%m%d_%H%M%S')}_{message_id}.{ext}"
    file_id, file_url = upload_image_to_drive(img_bytes, content_type or 'image/jpeg', fname)

    if require_confirm_preview:
        try:
            parse_res = parse_accounting_input_with_gemini({
                "messageType": "image",
                "rawText": f"[LINE Image ID: {message_id}]",
                "driveFileId": file_id,
                "preloadedImage": {"base64": b64_str, "mimeType": content_type or "image/jpeg"}
            }, cs, api_key=secrets["geminiApiKey"])
            items = parse_res.get("items") or []
            if not parse_res.get("isAccounting") or not items:
                clear_user_session_state(user_id)
                reply_line_text(
                    reply_token,
                    parse_res.get("assistantNote") or "💡 未偵測到有效的金額或消費品項，已結束本次記帳。",
                    mobile_url=mobile_url,
                    override_token=secrets["lineToken"]
                )
                return
            set_user_session_state(user_id, {
                "mode": "PENDING_PREVIEW",
                "messageType": "image",
                "rawText": f"[LINE Image ID: {message_id}]",
                "driveFileId": file_id,
                "driveUrl": file_url,
                "items": items,
                "assistantNote": parse_res.get("assistantNote", "")
            }, 900)
            reply_line_messages(
                reply_token,
                [build_preview_confirm_flex(items, parse_res.get("assistantNote", ""))],
                override_token=secrets["lineToken"]
            )
            return
        except Exception as e:
            clear_user_session_state(user_id)
            reply_line_text(reply_token, f"⚠️ AI 預覽解析失敗：{e}", mobile_url=mobile_url, override_token=secrets["lineToken"])
            return

    log_entry = create_raw_log({
        "userId": user_id,
        "messageType": "image",
        "rawText": f"[LINE Image ID: {message_id}]",
        "driveFileId": file_id,
        "driveUrl": file_url
    })
    process_raw_log_entry(
        log_entry,
        reply_token=reply_token,
        preloaded_image={"base64": b64_str, "mimeType": content_type or "image/jpeg"},
        request_host=request_host
    )

def handle_postback_event(data_string, reply_token, user_id, request_host=''):
    qs = parse_qs(data_string)
    params = {k: v[0] for k, v in qs.items()}
    action = params.get('action', '')
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    mobile_url = get_mobile_dashboard_url(cs, request_host)

    if action == 'start_accounting':
        input_mode = params.get('mode', 'text')
        set_user_session_state(user_id, {"mode": "WAITING_INPUT", "inputMode": input_mode}, 600)
        reply_line_messages(
            reply_token,
            [build_accounting_started_flex(input_mode, mobile_url)],
            override_token=secrets["lineToken"]
        )
        return

    if action == 'cancel_accounting':
        clear_user_session_state(user_id)
        reply_line_text(reply_token, "👌 已取消記帳待命狀態。", mobile_url=mobile_url, override_token=secrets["lineToken"])
        return

    if action == 'trigger_pending_draft':
        session = get_user_session_state(user_id)
        if not session or session.get('mode') != 'PENDING_DRAFT':
            reply_line_text(
                reply_token,
                "⏳ 暫存訊息已過期或已處理完成，請點選下方圖文選單【✍️ 點選記帳】重新開始。",
                mobile_url=mobile_url,
                override_token=secrets["lineToken"]
            )
            return

        require_preview = (cs.get('lineTriggerMode') == 'menu_and_confirm')
        clear_user_session_state(user_id)

        if session.get('draftType') == 'image' and session.get('imageMessageId'):
            execute_image_accounting(user_id, session['imageMessageId'], reply_token, require_preview, request_host)
            return

        if session.get('draftType') == 'text' and session.get('rawText'):
            raw_text = session['rawText']
            if require_preview:
                try:
                    parse_res = parse_accounting_input_with_gemini(
                        {"messageType": "text", "rawText": raw_text},
                        cs,
                        api_key=secrets["geminiApiKey"]
                    )
                    items = parse_res.get("items") or []
                    if not parse_res.get("isAccounting") or not items:
                        reply_line_text(
                            reply_token,
                            parse_res.get("assistantNote") or "💡 未偵測到有效的金額或消費品項。",
                            mobile_url=mobile_url,
                            override_token=secrets["lineToken"]
                        )
                        return
                    set_user_session_state(user_id, {
                        "mode": "PENDING_PREVIEW",
                        "messageType": "text",
                        "rawText": raw_text,
                        "items": items,
                        "assistantNote": parse_res.get("assistantNote", "")
                    }, 900)
                    reply_line_messages(
                        reply_token,
                        [build_preview_confirm_flex(items, parse_res.get("assistantNote", ""))],
                        override_token=secrets["lineToken"]
                    )
                except Exception as e:
                    reply_line_text(reply_token, f"⚠️ AI 預覽解析失敗：{e}", mobile_url=mobile_url, override_token=secrets["lineToken"])
                return

            log_entry = create_raw_log({"userId": user_id, "messageType": "text", "rawText": raw_text})
            process_raw_log_entry(log_entry, reply_token=reply_token, request_host=request_host)
            return

    if action == 'confirm_preview_save':
        session = get_user_session_state(user_id)
        if not session or session.get('mode') != 'PENDING_PREVIEW' or not isinstance(session.get('items'), list):
            reply_line_text(
                reply_token,
                "⏳ 預覽資料已過期或已入帳，請重新點選圖文選單記帳。",
                mobile_url=mobile_url,
                override_token=secrets["lineToken"]
            )
            return
        clear_user_session_state(user_id)
        log_entry = create_raw_log({
            "userId": user_id,
            "messageType": session.get('messageType', 'text'),
            "rawText": session.get('rawText', ''),
            "driveFileId": session.get('driveFileId', ''),
            "driveUrl": session.get('driveUrl', '')
        })
        saved_batch = save_transactions_batch(session['items'], log_entry, cs)
        update_raw_log_status(log_entry["logId"], "SUCCESS", len(saved_batch["transactions"]), "")
        flex_msg = build_receipt_confirm_flex(saved_batch, session.get('assistantNote', ''), mobile_url)
        reply_line_messages(reply_token, [flex_msg], override_token=secrets["lineToken"])
        return

    if action == 'delete_batch' and params.get('batchId'):
        res = delete_transactions_by_batch_id(params['batchId'])
        reply_line_text(reply_token, res["message"], mobile_url=mobile_url, override_token=secrets["lineToken"])
        return

    if action == 'undo_last':
        res = undo_last_batch()
        reply_line_text(reply_token, res["message"], mobile_url=mobile_url, override_token=secrets["lineToken"])
        return

    if action == 'delete_tx' and params.get('txId'):
        res = delete_transaction_by_id(params['txId'])
        reply_line_text(reply_token, res.get("message") or res.get("error", ""), mobile_url=mobile_url, override_token=secrets["lineToken"])
        return

    if action == 'monthly_summary':
        cur_ym = now_taipei().strftime('%Y-%m')
        summary = get_monthly_summary_data(cur_ym)
        reply_line_messages(
            reply_token,
            [build_monthly_summary_flex(summary, mobile_url)],
            override_token=secrets["lineToken"]
        )
        return

    if action == 'ai_diagnosis':
        cur_ym = now_taipei().strftime('%Y-%m')
        report = generate_ai_financial_diagnosis(cur_ym, 'LINE_POSTBACK', False)
        reply_line_messages(
            reply_token,
            [build_diagnosis_flex_message(report, mobile_url)],
            override_token=secrets["lineToken"]
        )
        return

def handle_line_command(text, reply_token, user_id, request_host=''):
    normalized = re.sub(r'\s+', ' ', text).strip()
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    mobile_url = get_mobile_dashboard_url(cs, request_host)

    if re.match(r'^(✍️ 點選開始記帳|📸 拍收據記帳|📊 查看本月帳務摘要|✨ 執行 AI 財務診斷|↩️ 撤銷上一筆記帳)$', normalized):
        return True

    if re.match(r'^(✍️ 點選記帳|開始記帳|我要記帳|記帳)$', normalized, re.I):
        set_user_session_state(user_id, {"mode": "WAITING_INPUT", "inputMode": "text"}, 600)
        reply_line_messages(reply_token, [build_accounting_started_flex('text', mobile_url)], override_token=secrets["lineToken"])
        return True

    if re.match(r'^(📸 收據記帳)$', normalized, re.I):
        set_user_session_state(user_id, {"mode": "WAITING_INPUT", "inputMode": "image"}, 600)
        reply_line_messages(reply_token, [build_accounting_started_flex('image', mobile_url)], override_token=secrets["lineToken"])
        return True

    if re.match(r'^(help|說明|指令|選單|功能|\?)$', normalized, re.I):
        help_msg = "\n".join([
            "📒 【極簡 AI 帳本使用指南】",
            "",
            "1️⃣ 點選下方圖文選單【✍️ 點選記帳】或【📸 收據記帳】",
            "2️⃣ 傳送消費文字（如：午餐 120）或拍下收據照片即可入帳",
            "（平時直接傳送訊息不會自動記帳，避免誤觸）",
            "",
            "📱 點選圖文選單右上角【手機版檢視帳務】即可開啟網頁版帳本：",
            mobile_url
        ])
        reply_line_text(reply_token, help_msg, mobile_url=mobile_url, override_token=secrets["lineToken"])
        return True

    if re.match(r'^(刪除上一筆|撤銷|撤銷上一筆|取消上一筆|undo)$', normalized, re.I):
        res = undo_last_batch()
        reply_line_text(reply_token, res["message"], mobile_url=mobile_url, override_token=secrets["lineToken"])
        return True

    m_mod = re.match(r'^修改上一筆\s+(.+)$', normalized, re.I)
    if m_mod:
        res = modify_last_transaction_by_instruction(m_mod.group(1))
        reply_line_text(reply_token, res["message"], mobile_url=mobile_url, override_token=secrets["lineToken"])
        return True

    if re.match(r'^(本月報表|查帳|本月統計|本月摘要|帳務摘要)$', normalized, re.I):
        cur_ym = now_taipei().strftime('%Y-%m')
        summary = get_monthly_summary_data(cur_ym)
        reply_line_messages(reply_token, [build_monthly_summary_flex(summary, mobile_url)], override_token=secrets["lineToken"])
        return True

    if re.match(r'^(財務診斷|AI分析|ai診斷|診斷分析|消費診斷)$', normalized, re.I):
        cur_ym = now_taipei().strftime('%Y-%m')
        report = generate_ai_financial_diagnosis(cur_ym, 'LINE', False)
        reply_line_messages(reply_token, [build_diagnosis_flex_message(report, mobile_url)], override_token=secrets["lineToken"])
        return True

    if re.match(r'^(分類優化|細分校準|月結校準|調整分類|月度校準)$', normalized, re.I):
        cur_ym = now_taipei().strftime('%Y-%m')
        report = run_monthly_category_audit_and_diagnosis(cur_ym, 'LINE_AUDIT')
        reply_line_messages(reply_token, [build_diagnosis_flex_message(report, mobile_url)], override_token=secrets["lineToken"])
        return True

    if re.match(r'^(重試|重試失敗|retry)$', normalized, re.I):
        r_res = retry_failed_logs()
        reply_line_text(
            reply_token,
            f"🔄 已執行失敗紀錄重試！\n檢查：{r_res['checked']} 筆｜成功修復：{r_res['recovered']} 筆",
            mobile_url=mobile_url,
            override_token=secrets["lineToken"]
        )
        return True

    return False

def process_line_event(event, request_host=''):
    reply_token = event.get('replyToken')
    source = event.get('source') or {}
    user_id = source.get('userId') or 'unknown'

    if event.get('type') == 'postback' and event.get('postback', {}).get('data'):
        handle_postback_event(event['postback']['data'], reply_token, user_id, request_host)
        return

    if event.get('type') != 'message' or not event.get('message'):
        return

    msg = event['message']
    session = get_user_session_state(user_id)
    cs = get_cloud_settings()
    secrets = get_effective_secrets(cs)
    trigger_mode = cs.get('lineTriggerMode') or 'menu_first'
    mobile_url = get_mobile_dashboard_url(cs, request_host)

    if msg.get('type') == 'text':
        user_text = (msg.get('text') or '').strip()
        if re.match(r'^(取消|取消記帳|結束記帳|cancel)$', user_text, re.I):
            clear_user_session_state(user_id)
            reply_line_text(
                reply_token,
                "✅ 已取消本次記帳流程。\n如需記帳，請點選下方圖文選單【✍️ 點選記帳】。",
                mobile_url=mobile_url,
                override_token=secrets["lineToken"]
            )
            return

        if handle_line_command(user_text, reply_token, user_id, request_host):
            return

        if session.get('mode') != 'WAITING_INPUT':
            set_user_session_state(user_id, {
                "mode": "PENDING_DRAFT",
                "draftType": "text",
                "rawText": user_text
            }, 900)
            reply_line_messages(
                reply_token,
                [build_not_triggered_prompt_flex('text', user_text, mobile_url)],
                override_token=secrets["lineToken"]
            )
            return

        if trigger_mode == 'menu_and_confirm':
            try:
                parse_res = parse_accounting_input_with_gemini(
                    {"messageType": "text", "rawText": user_text},
                    cs,
                    api_key=secrets["geminiApiKey"]
                )
                items = parse_res.get("items") or []
                if not parse_res.get("isAccounting") or not items:
                    clear_user_session_state(user_id)
                    reply_line_text(
                        reply_token,
                        parse_res.get("assistantNote") or "💡 未偵測到有效的金額或消費品項，已結束本次記帳。",
                        mobile_url=mobile_url,
                        override_token=secrets["lineToken"]
                    )
                    return
                set_user_session_state(user_id, {
                    "mode": "PENDING_PREVIEW",
                    "messageType": "text",
                    "rawText": user_text,
                    "items": items,
                    "assistantNote": parse_res.get("assistantNote", "")
                }, 900)
                reply_line_messages(
                    reply_token,
                    [build_preview_confirm_flex(items, parse_res.get("assistantNote", ""))],
                    override_token=secrets["lineToken"]
                )
            except Exception as e:
                clear_user_session_state(user_id)
                reply_line_text(reply_token, f"⚠️ AI 預覽解析失敗：{e}", mobile_url=mobile_url, override_token=secrets["lineToken"])
            return

        clear_user_session_state(user_id)
        log_entry = create_raw_log({"userId": user_id, "messageType": "text", "rawText": user_text})
        process_raw_log_entry(log_entry, reply_token=reply_token, request_host=request_host)
        return

    if msg.get('type') == 'image':
        if session.get('mode') != 'WAITING_INPUT':
            set_user_session_state(user_id, {
                "mode": "PENDING_DRAFT",
                "draftType": "image",
                "imageMessageId": msg.get('id')
            }, 900)
            reply_line_messages(
                reply_token,
                [build_not_triggered_prompt_flex('image', '收據/發票照片', mobile_url)],
                override_token=secrets["lineToken"]
            )
            return

        clear_user_session_state(user_id)
        execute_image_accounting(
            user_id,
            msg.get('id'),
            reply_token,
            require_confirm_preview=(trigger_mode == 'menu_and_confirm'),
            request_host=request_host
        )

# ============================================================================
# Dashboard API 統一路由
# ============================================================================

def handle_dashboard_action(action, params, request_host='', is_get=False):
    try:
        dash_token = get_dashboard_token()
        if dash_token and str(params.get('token') or '') != dash_token:
            return {"ok": False, "error": "安全通行碼 (DASHBOARD_ACCESS_TOKEN) 驗證失敗"}

        # 若尚未在 Vercel 環境變數設定直連 Google Sheets 憑證，自動無縫轉發至既有雲端 GAS 後端
        if not is_direct_sheets_configured():
            if is_get and action == 'bootstrap':
                proxied = proxy_to_gas_fallback('GET', query_params=params)
                if proxied is not None:
                    return proxied
            else:
                body_payload = dict(params or {})
                body_payload['dashboardAction'] = action
                proxied = proxy_to_gas_fallback('POST', json_body=body_payload)
                if proxied is not None:
                    return proxied

        if action == 'bootstrap':
            return get_dashboard_bootstrap_data(params.get('yearMonth'), request_host=request_host)

        if action == 'setup_rich_menu':
            if params.get('githubPagesUrl'):
                save_cloud_settings_and_budgets({
                    "settings": {"githubPagesUrl": str(params['githubPagesUrl']).strip()}
                })
            cs = get_cloud_settings()
            secrets = get_effective_secrets(cs)
            mobile_url = get_mobile_dashboard_url(cs, request_host)
            img_b64 = params.get('imageBase64') or ''
            img_mime = params.get('imageMimeType') or 'image/png'
            img_bytes = base64.b64decode(img_b64) if img_b64 else None

            res = setup_rich_menu_flow(
                mobile_web_url=mobile_url,
                custom_image_bytes=img_bytes,
                custom_mime=img_mime,
                override_token=secrets["lineToken"]
            )
            if res.get('ok') and res.get('richMenuId'):
                save_cloud_settings_and_budgets({
                    "settings": {"activeRichMenuId": res["richMenuId"]}
                })
            return res

        if action == 'run_diagnosis':
            report = generate_ai_financial_diagnosis(
                params.get('yearMonth'),
                'WEB_DASHBOARD',
                bool(params.get('calibrateCategories'))
            )
            return {
                "ok": True,
                "report": report,
                "summary": get_monthly_summary_data(params.get('yearMonth')),
                "cloudSettings": get_cloud_settings()
            }

        if action == 'run_monthly_audit':
            report = run_monthly_category_audit_and_diagnosis(params.get('yearMonth'), 'WEB_MONTHLY_AUDIT')
            return {
                "ok": True,
                "report": report,
                "summary": get_monthly_summary_data(params.get('yearMonth')),
                "cloudSettings": get_cloud_settings()
            }

        if action == 'ask_ai':
            return ask_gemini_about_finances(
                params.get('question') or '請分析我本月的消費重點',
                params.get('yearMonth')
            )

        if action == 'add_manual_tx':
            item = params.get('transaction') or {}
            saved = save_transactions_batch([item], {"logId": "WEB-MANUAL", "driveUrl": ""})
            return {
                "ok": True,
                "batch": saved,
                "summary": get_monthly_summary_data(params.get('yearMonth'))
            }

        if action == 'parse_and_save':
            drive_file_id = ''
            drive_url = ''
            preloaded_image = None

            if params.get('imageBase64'):
                mime_type = params.get('imageMimeType') or 'image/jpeg'
                ext = 'png' if 'png' in mime_type else 'jpg'
                ts_file = now_taipei().strftime('%Y%m%d_%H%M%S')
                img_bytes = base64.b64decode(params['imageBase64'])
                drive_file_id, drive_url = upload_image_to_drive(img_bytes, mime_type, f"WebReceipt_{ts_file}.{ext}")
                preloaded_image = {
                    "base64": params['imageBase64'],
                    "mimeType": mime_type
                }

            log_entry = create_raw_log({
                "userId": "CLOUD-WEB-DASHBOARD",
                "messageType": "image" if preloaded_image else "text",
                "rawText": params.get('rawText') or ("[網頁上傳收據]" if preloaded_image else ""),
                "driveFileId": drive_file_id,
                "driveUrl": drive_url
            })
            proc_res = process_raw_log_entry(log_entry, reply_token=None, preloaded_image=preloaded_image, request_host=request_host)
            return {
                "ok": proc_res.get("ok", False),
                "parsedCount": proc_res.get("count", 0),
                "batchId": proc_res.get("batchId", ""),
                "driveUrl": drive_url,
                "error": proc_res.get("error", "")
            }

        if action == 'delete_tx':
            return delete_transaction_by_id(params.get('txId'))

        if action == 'retry_failed':
            return {"ok": True, "result": retry_failed_logs()}

        if action == 'update_budget':
            return update_category_budget(params.get('category'), safe_float(params.get('budget'), 0))

        if action == 'save_all_settings':
            return save_cloud_settings_and_budgets(params)

        return {"ok": False, "error": f"未知的 API Action: {action}"}
    except Exception as err:
        return {"ok": False, "error": str(err)}

def _read_static_asset(filename):
    candidates = [
        os.path.join(_ROOT_DIR, filename),
        os.path.join(_ROOT_DIR, 'web', filename),
        os.path.join(_CUR_DIR, f"_{filename}"),
        os.path.join(_CUR_DIR, filename)
    ]
    for path in candidates:
        if os.path.isfile(path):
            try:
                with open(path, 'rb') as f:
                    return f.read()
            except Exception:
                pass
    return None

# ============================================================================
# Vercel Serverless HTTP Handler
# ============================================================================

class handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # 避免預設 stderr log 在部分環境引發 IO 例外
        return

    def _send_raw(self, body_bytes, content_type='text/html; charset=utf-8', status=200):
        try:
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body_bytes)))
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()
            self.wfile.write(body_bytes)
        except BaseException as e:
            print(f"Raw response write warning: {e}")

    def _send_json(self, data, status=200):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self._send_raw(body, content_type='application/json; charset=utf-8', status=status)

    def do_OPTIONS(self):
        try:
            self._send_json({"ok": True})
        except BaseException as e:
            print(f"OPTIONS error: {e}")

    def do_GET(self):
        try:
            parsed_url = urlparse(self.path)
            req_path = parsed_url.path or '/'
            qs = parse_qs(parsed_url.query)
            params = {k: v[0] for k, v in qs.items()}
            action = params.get('action') or params.get('dashboardAction') or ''
            host = self.headers.get('Host', '')

            # 1. 若帶有 API Action 參數，執行雲端帳務 API
            if action:
                res = handle_dashboard_action(action, params, request_host=host, is_get=True)
                self._send_json(res)
                return

            asset_param = params.get('_asset', '')

            # 2. 靜態設定檔與 PWA Manifest 路由
            if asset_param == 'config.js' or req_path.endswith('/config.js') or req_path == '/config.js':
                asset = _read_static_asset('config.js')
                if asset is not None:
                    self._send_raw(asset, content_type='application/javascript; charset=utf-8')
                    return

            if asset_param == 'manifest.json' or req_path.endswith('/manifest.json') or req_path == '/manifest.json':
                asset = _read_static_asset('manifest.json')
                if asset is not None:
                    self._send_raw(asset, content_type='application/manifest+json; charset=utf-8')
                    return

            # 3. 若明確要求 JSON 健康檢查 (?format=json 或 ?health=1)
            if params.get('format') == 'json' or params.get('health') == '1':
                self._send_json({
                    "ok": True,
                    "status": "online",
                    "mode": "direct_sheets" if is_direct_sheets_configured() else "gas_cloud_proxy",
                    "message": "AI Accounting Serverless Backend is active"
                })
                return

            # 4. 預設回傳完整前端網頁儀表板 (index.html)
            html_bytes = _read_static_asset('index.html')
            if html_bytes is not None:
                self._send_raw(html_bytes, content_type='text/html; charset=utf-8')
                return

            # 5. 備援健康檢查
            self._send_json({
                "ok": True,
                "status": "online",
                "mode": "direct_sheets" if is_direct_sheets_configured() else "gas_cloud_proxy",
                "message": "AI Accounting Serverless Backend is active"
            })
        except BaseException as e:
            self._send_json({"ok": False, "error": f"GET 處理異常: {e}"}, status=200)

    def do_POST(self):
        try:
            host = self.headers.get('Host', '')
            try:
                content_length = int(self.headers.get('Content-Length') or 0)
                body_bytes = self.rfile.read(content_length) if content_length > 0 else b''
                body_str = body_bytes.decode('utf-8', errors='replace')
                params = json.loads(body_str) if body_str else {}
            except Exception as e:
                self._send_json({"ok": False, "error": f"JSON 解析失敗: {e}"}, status=400)
                return

            # 1. 判斷是否為網頁儀表板的 API POST 請求
            action = params.get('dashboardAction') or params.get('action')
            if action:
                res = handle_dashboard_action(action, params, request_host=host, is_get=False)
                self._send_json(res)
                return

            # 2. 處理 LINE Webhook Events
            if 'events' in params:
                if not is_direct_sheets_configured():
                    proxy_to_gas_fallback('POST', json_body=params)
                    self._send_json({"status": "ok", "mode": "gas_cloud_proxy"})
                    return
                for ev in params.get('events', []):
                    try:
                        process_line_event(ev, request_host=host)
                    except Exception as err:
                        print(f"LINE event error: {err}")
                self._send_json({"status": "ok"})
                return

            self._send_json({"ok": False, "error": "無法辨識的請求格式"}, status=400)
        except BaseException as e:
            self._send_json({"ok": False, "error": f"POST 處理異常: {e}"}, status=200)
