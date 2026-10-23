import os
import json
import requests
from datetime import datetime, timezone, timedelta
from api.sheets_service import (
    DEFAULT_PARSE_MODEL,
    DEFAULT_DIAGNOSIS_MODEL,
    DEFAULT_SUBCATEGORY_TAXONOMY,
    INCOME_CATEGORIES
)

GEMINI_INTERACTIONS_ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/interactions'
GEMINI_API_REVISION = '2026-05-20'

def now_taipei():
    return datetime.now(timezone(timedelta(hours=8)))

def get_gemini_api_key(override_key=None):
    if override_key and str(override_key).strip():
        return str(override_key).strip()
    return os.environ.get('GEMINI_API_KEY', '').strip()

def map_to_generate_content_model(model_name):
    """若Interactions端點不可用或使用者指定舊版名稱時的備援模型映射"""
    m = (model_name or '').strip()
    if m in ('gemini-3.8-flash', 'gemini-4-argon', ''):
        return 'gemini-2.5-flash'
    return m

def call_gemini_interactions_api(model, system_instruction, input_parts, schema=None, api_key=None):
    """
    優先呼叫與原 GAS 相同的 v1beta/interactions (Api-Revision: 2026-05-20)，
    若發生模型名稱或端點不支援則自動無縫切換至標準 generateContent API。
    """
    key = get_gemini_api_key(api_key)
    if not key:
        raise ValueError("尚未設定 GEMINI_API_KEY 環境變數（可在 Vercel 環境變數或網頁設定頁填入）")

    selected_model = model or os.environ.get('GEMINI_PARSE_MODEL', DEFAULT_PARSE_MODEL)

    # 1. 嘗試 Interactions API
    req_body = {
        "model": selected_model,
        "system_instruction": system_instruction or "",
        "input": input_parts,
        "store": False
    }
    if schema:
        req_body["response_format"] = {
            "type": "text",
            "mime_type": "application/json",
            "schema": schema
        }

    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
        "Api-Revision": GEMINI_API_REVISION
    }

    try:
        resp = requests.post(GEMINI_INTERACTIONS_ENDPOINT, json=req_body, headers=headers, timeout=55)
        if 200 <= resp.status_code < 300:
            parsed = resp.json()
            if isinstance(parsed.get('output_text'), str) and parsed['output_text'].strip():
                return parsed['output_text'].strip()
            steps = parsed.get('steps', [])
            if isinstance(steps, list):
                for step in reversed(steps):
                    if step and step.get('type') == 'model_output' and isinstance(step.get('content'), list):
                        texts = [p.get('text') for p in step['content'] if p and p.get('type') == 'text' and p.get('text')]
                        if texts:
                            return ''.join(texts).strip()
    except Exception as e:
        print(f"Interactions API attempt notice: {e}")

    # 2. 自動 Fallback 至標準 generateContent API
    fallback_model = map_to_generate_content_model(selected_model)
    gen_url = f"https://generativelanguage.googleapis.com/v1beta/models/{fallback_model}:generateContent?key={key}"

    gc_parts = []
    for part in input_parts:
        if part.get('type') == 'text':
            gc_parts.append({"text": part.get('text', '')})
        elif part.get('type') == 'image':
            gc_parts.append({
                "inlineData": {
                    "mimeType": part.get('mime_type', 'image/jpeg'),
                    "data": part.get('data', '')
                }
            })

    gc_payload = {
        "contents": [{"parts": gc_parts}]
    }
    if system_instruction:
        gc_payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}

    gen_config = {"temperature": 0.2}
    if schema:
        gen_config["responseMimeType"] = "application/json"
        gen_config["responseSchema"] = schema
    gc_payload["generationConfig"] = gen_config

    resp2 = requests.post(gen_url, json=gc_payload, headers={"Content-Type": "application/json"}, timeout=55)
    if resp2.status_code < 200 or resp2.status_code >= 300:
        raise RuntimeError(f"Gemini API HTTP {resp2.status_code}: {resp2.text[:300]}")

    data2 = resp2.json()
    try:
        text_out = data2['candidates'][0]['content']['parts'][0]['text']
        return text_out.strip()
    except Exception as e:
        raise RuntimeError(f"Gemini API 回傳解析失敗: {e}")

def get_accounting_schema():
    return {
        "type": "object",
        "properties": {
            "isAccounting": {"type": "boolean"},
            "assistantNote": {"type": "string"},
            "items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "date": {"type": "string"},
                        "time": {"type": "string"},
                        "type": {"type": "string", "enum": ["支出", "收入"]},
                        "category": {"type": "string"},
                        "subcategory": {"type": "string"},
                        "item": {"type": "string"},
                        "amount": {"type": "number"},
                        "currency": {"type": "string"},
                        "paymentMethod": {"type": "string"},
                        "merchant": {"type": "string"},
                        "invoiceNo": {"type": "string"},
                        "note": {"type": "string"}
                    },
                    "required": ["date", "type", "category", "subcategory", "item", "amount", "currency", "paymentMethod"]
                }
            }
        },
        "required": ["isAccounting", "assistantNote", "items"]
    }

def get_diagnosis_and_audit_schema(include_audit_fields=False):
    props = {
        "healthScore": {"type": "integer"},
        "healthGrade": {"type": "string"},
        "executiveSummary": {"type": "string"},
        "consumptionStructureAnalysis": {
            "type": "object",
            "properties": {
                "overallStatus": {"type": "string"},
                "latteFactorAnalysis": {"type": "string"},
                "weekdayVsWeekend": {"type": "string"},
                "topConcentration": {"type": "string"},
                "nextMonthBudgetAdvice": {"type": "string"}
            },
            "required": ["overallStatus", "latteFactorAnalysis", "weekdayVsWeekend", "topConcentration", "nextMonthBudgetAdvice"]
        },
        "rule503020": {
            "type": "object",
            "properties": {
                "needsPct": {"type": "number"},
                "wantsPct": {"type": "number"},
                "savingsPct": {"type": "number"},
                "comment": {"type": "string"}
            },
            "required": ["needsPct", "wantsPct", "savingsPct", "comment"]
        },
        "anomaliesAndHabits": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "detail": {"type": "string"},
                    "severity": {"type": "string", "enum": ["high", "medium", "low"]}
                },
                "required": ["title", "detail", "severity"]
            }
        },
        "actionableTips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "action": {"type": "string"},
                    "expectedImpact": {"type": "string"},
                    "description": {"type": "string"}
                },
                "required": ["action", "expectedImpact", "description"]
            }
        }
    }
    req = [
        "healthScore", "healthGrade", "executiveSummary",
        "consumptionStructureAnalysis", "rule503020",
        "anomaliesAndHabits", "actionableTips"
    ]
    if include_audit_fields:
        props["reclassifications"] = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "txId": {"type": "string"},
                    "newCategory": {"type": "string"},
                    "newSubcategory": {"type": "string"},
                    "reason": {"type": "string"}
                },
                "required": ["txId", "newCategory", "newSubcategory", "reason"]
            }
        }
        props["newTaxonomyAdditions"] = {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "category": {"type": "string"},
                    "subcategory": {"type": "string"}
                },
                "required": ["category", "subcategory"]
            }
        }
        req.extend(["reclassifications", "newTaxonomyAdditions"])

    return {
        "type": "object",
        "properties": props,
        "required": req
    }

def parse_accounting_input_with_gemini(payload, cloud_settings, api_key=None):
    income_cats_str = cloud_settings.get('incomeCategories') or ','.join(INCOME_CATEGORIES)
    income_cats = [s.strip() for s in income_cats_str.split(',') if s.strip()]
    pay_str = cloud_settings.get('paymentMethods') or '現金,信用卡,LINE Pay,街口支付,悠遊卡/一卡通,銀行轉帳,Apple Pay'
    payment_methods = [s.strip() for s in pay_str.split(',') if s.strip()]
    default_currency = cloud_settings.get('defaultCurrency') or 'TWD'
    default_payment = cloud_settings.get('defaultPaymentMethod') or '現金'

    if cloud_settings.get('receiptSplitMode') == 'single_total':
        split_rule = '1. 若為單張收據或發票照片，請將整張收據合併為單筆總金額紀錄；若為多筆不同消費文字則拆分為多筆。'
    else:
        split_rule = '1. 若單則文字或單張收據包含多個獨立消費項目，請拆分成 items 陣列中的多筆紀錄。'

    now_dt = now_taipei()
    today_str = now_dt.strftime('%Y-%m-%d')
    time_str = now_dt.strftime('%H:%M')

    taxonomy_obj = cloud_settings.get('subcategoryTaxonomyObj') or DEFAULT_SUBCATEGORY_TAXONOMY
    compact_tax = '; '.join([f"{cat}[{'/'.join(taxonomy_obj.get(cat, []))}]" for cat in taxonomy_obj])

    system_instruction = '\n'.join([
        f"台灣記帳AI。今日{today_str} {time_str}。預設幣別{default_currency}，未提及支付方式時預設為「{default_payment}」。",
        split_rule,
        f"支出分類與子分類(category>subcategory)請優先對應：{compact_tax}",
        f"收入分類：{'/'.join(income_cats)}",
        f"可用支付方式：{'/'.join(payment_methods)}。非記帳訊息設isAccounting=false。"
    ])

    input_parts = []
    preloaded_img = payload.get('preloadedImage')
    if payload.get('messageType') == 'image' and preloaded_img and preloaded_img.get('base64'):
        raw_txt = payload.get('rawText', '')
        prompt_text = '請辨識這張收據/發票照片中的所有消費項目、日期、店家、發票號碼與金額，並轉換為結構化記帳明細。'
        if raw_txt and not raw_txt.startswith('['):
            prompt_text += f"\n補充說明：{raw_txt}"
        input_parts.append({"type": "text", "text": prompt_text})
        input_parts.append({
            "type": "image",
            "data": preloaded_img['base64'],
            "mime_type": preloaded_img.get('mimeType') or 'image/jpeg'
        })
    else:
        input_parts.append({
            "type": "text",
            "text": f"請解析以下記帳訊息：\n「{payload.get('rawText', '')}」"
        })

    model = cloud_settings.get('parseModel') or DEFAULT_PARSE_MODEL
    raw_resp = call_gemini_interactions_api(
        model=model,
        system_instruction=system_instruction,
        input_parts=input_parts,
        schema=get_accounting_schema(),
        api_key=api_key
    )
    clean = raw_resp.replace('```json', '').replace('```', '').strip()
    return json.loads(clean)
