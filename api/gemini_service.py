import os
import json
import base64
import requests

DEFAULT_PARSE_MODEL = 'gemini-2.5-flash'
DEFAULT_DIAGNOSIS_MODEL = 'gemini-2.5-pro'

def get_gemini_api_key():
    return os.environ.get('GEMINI_API_KEY', '').strip()

def call_gemini(system_instruction, contents, generation_config=None, model=None):
    api_key = get_gemini_api_key()
    if not api_key:
        raise ValueError("缺少 GEMINI_API_KEY 環境變數")
    
    selected_model = model or os.environ.get('GEMINI_PARSE_MODEL', DEFAULT_PARSE_MODEL)
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{selected_model}:generateContent?key={api_key}"
    
    payload = {
        "contents": contents
    }
    if system_instruction:
        payload["systemInstruction"] = {
            "parts": [{"text": system_instruction}]
        }
    if generation_config:
        payload["generationConfig"] = generation_config
        
    headers = {"Content-Type": "application/json"}
    resp = requests.post(url, json=payload, headers=headers, timeout=60)
    
    if resp.status_code != 200:
        raise Exception(f"Gemini API 呼叫失敗 ({resp.status_code}): {resp.text}")
        
    data = resp.json()
    try:
        candidate = data['candidates'][0]
        text = candidate['content']['parts'][0]['text']
        return text
    except Exception as e:
        raise Exception(f"解析 Gemini 回傳格式失敗: {e}, 原文: {resp.text}")

def parse_accounting_text(text, categories, subcategories, date_str=None):
    prompt = f"""
你是一個極為精準的台灣繁體中文個人記帳專家。請將使用者的記帳輸入解析為結構化 JSON 陣列。
現有主分類：{json.dumps(categories, ensure_ascii=False)}
參考子分類分類樹：{json.dumps(subcategories, ensure_ascii=False)}

請輸出嚴格的 JSON 格式：
{{
  "items": [
    {{
      "type": "支出" 或 "收入",
      "amount": 數字(大於0),
      "category": "主分類名稱",
      "subcategory": "子分類名稱",
      "item": "項目說明",
      "merchant": "商家或對象",
      "paymentMethod": "現金/信用卡/LINE Pay/街口/轉帳等",
      "note": "備註說明",
      "confidence": 0.0 到 1.0 的信心指數
    }}
  ],
  "assistantNote": "親切簡短的確認回應與理財小提醒（繁體中文，約 30 字）"
}}
使用者輸入：
"{text}"
"""
    system_inst = "你是一個專業的財務記帳助手，只輸出合法 JSON，請勿包含 markdown 以外多餘說明。"
    gen_config = {
        "responseMimeType": "application/json",
        "temperature": 0.2
    }
    contents = [{"parts": [{"text": prompt}]}]
    
    raw = call_gemini(system_inst, contents, gen_config)
    try:
        return json.loads(raw)
    except:
        clean = raw.replace('```json', '').replace('```', '').strip()
        return json.loads(clean)

def parse_receipt_image(image_bytes, mime_type, categories, subcategories):
    b64_data = base64.b64encode(image_bytes).decode('utf-8')
    prompt = f"""
請辨識並分析此收據/發票/明細圖片中的所有消費品項與金額。
現有主分類：{json.dumps(categories, ensure_ascii=False)}
參考子分類：{json.dumps(subcategories, ensure_ascii=False)}

請輸出嚴格的 JSON 格式：
{{
  "items": [
    {{
      "type": "支出",
      "amount": 數字,
      "category": "主分類",
      "subcategory": "子分類",
      "item": "品名",
      "merchant": "商家名稱",
      "paymentMethod": "支付方式",
      "note": "備註",
      "confidence": 0.9
    }}
  ],
  "assistantNote": "親切總結辨識結果（繁體中文）"
}}
"""
    contents = [{
        "parts": [
            {"text": prompt},
            {
                "inlineData": {
                    "mimeType": mime_type,
                    "data": b64_data
                }
            }
        ]
    }]
    gen_config = {
        "responseMimeType": "application/json",
        "temperature": 0.2
    }
    raw = call_gemini("你是一個收據與發票 OCR 辨識解析專家，只輸出合法 JSON。", contents, gen_config)
    try:
        return json.loads(raw)
    except:
        clean = raw.replace('```json', '').replace('```', '').strip()
        return json.loads(clean)
