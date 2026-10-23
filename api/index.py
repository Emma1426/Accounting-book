import os
import json
import base64
from http.server import BaseHTTPRequestHandler
from api.sheets_service import get_sheet_values, append_sheet_values, update_sheet_values
from api.line_service import reply_line_messages, get_line_message_content, setup_rich_menu_flow
from api.gemini_service import parse_accounting_text, parse_receipt_image

SPREADSHEET_ID = os.environ.get('SPREADSHEET_ID', '').strip()
DASHBOARD_TOKEN = os.environ.get('DASHBOARD_ACCESS_TOKEN', '').strip()

DEFAULT_CATEGORIES = [
    '餐飲食品', '交通通勤', '日常用品', '居家帳單', '休閒娛樂',
    '服飾美容', '醫療保健', '學習進修', '數位訂閱', '人情社交', '其他支出'
]

class handler(BaseHTTPRequestHandler):
    def _send_json(self, data, status=200):
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
        self.end_headers()
        self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))

    def do_OPTIONS(self):
        self._send_json({"ok": True})

    def do_GET(self):
        self._send_json({
            "ok": True,
            "status": "online",
            "message": "AI Accounting Serverless Backend (Direct Google Sheets API)"
        })

    def do_POST(self):
        try:
            content_length = int(self.headers.get('Content-Length', 0))
            body_bytes = self.rfile.read(content_length)
            body_str = body_bytes.decode('utf-8')
            params = json.loads(body_str) if body_str else {}
        except Exception as e:
            self._send_json({"ok": False, "error": f"JSON 解析失敗: {e}"}, status=400)
            return

        # 1. 判斷是否為 LINE Webhook
        if 'events' in params:
            self.handle_line_webhook(params)
            return

        # 2. 判斷是否為 Dashboard API
        action = params.get('dashboardAction') or params.get('action')
        token = params.get('token', '')

        if DASHBOARD_TOKEN and token != DASHBOARD_TOKEN:
            self._send_json({"ok": False, "error": "安全通行碼 (DASHBOARD_ACCESS_TOKEN) 驗證失敗"}, status=403)
            return

        self.handle_dashboard_action(action, params)

    def handle_line_webhook(self, params):
        events = params.get('events', [])
        for ev in events:
            ev_type = ev.get('type')
            reply_token = ev.get('replyToken')
            if not reply_token or reply_token.startswith('000000'):
                continue

            if ev_type == 'message':
                msg = ev.get('message', {})
                msg_type = msg.get('type')

                if msg_type == 'text':
                    text = msg.get('text', '').strip()
                    if text == '✍️ 點選記帳':
                        reply_line_messages(reply_token, [{
                            "type": "text",
                            "text": "請直接輸入記帳內容（例如：「午餐便當 120 現金」或「全聯買生活用品 650 信用卡」）"
                        }])
                    elif text == '📸 收據記帳':
                        reply_line_messages(reply_token, [{
                            "type": "text",
                            "text": "請直接拍照或傳送發票/收據圖片，AI 將自動辨識明細。"
                        }])
                    else:
                        # 進行文字記帳解析
                        try:
                            res = parse_accounting_text(text, DEFAULT_CATEGORIES, {})
                            items = res.get('items', [])
                            note = res.get('assistantNote', '記帳完成！')
                            
                            # 寫入 Google Sheet
                            if SPREADSHEET_ID and items:
                                rows = []
                                for it in items:
                                    rows.append([
                                        f"TX-{int(os.times()[4]*1000)}",
                                        "LINE-TEXT",
                                        "2026-10-23",
                                        it.get('type', '支出'),
                                        it.get('category', '其他支出'),
                                        it.get('subcategory', ''),
                                        it.get('item', ''),
                                        it.get('amount', 0),
                                        it.get('merchant', ''),
                                        it.get('paymentMethod', ''),
                                        it.get('note', '')
                                    ])
                                append_sheet_values(SPREADSHEET_ID, "Transactions!A:K", rows)

                            reply_line_messages(reply_token, [{
                                "type": "text",
                                "text": f"{note}\n\n已成功為您記錄 {len(items)} 筆交易！"
                            }])
                        except Exception as e:
                            reply_line_messages(reply_token, [{
                                "type": "text",
                                "text": f"抱歉，記帳處理發生錯誤：{e}"
                            }])

        self._send_json({"ok": True})

    def handle_dashboard_action(self, action, params):
        if action == 'setup_rich_menu':
            dash_url = params.get('githubPagesUrl', '')
            img_b64 = params.get('imageBase64', '')
            img_mime = params.get('imageMimeType', 'image/png')
            
            img_bytes = base64.b64decode(img_b64) if img_b64 else None
            res = setup_rich_menu_flow(dash_url, img_bytes, img_mime)
            self._send_json(res)
            return

        if action == 'bootstrap':
            if not SPREADSHEET_ID:
                self._send_json({"ok": True, "transactions": [], "budgets": [], "summary": {}})
                return

            rows = get_sheet_values(SPREADSHEET_ID, "Transactions!A2:K500")
            txs = []
            for r in rows:
                if len(r) >= 8:
                    txs.append({
                        "id": r[0],
                        "date": r[2],
                        "type": r[3],
                        "category": r[4],
                        "item": r[6],
                        "amount": float(r[7]) if r[7] else 0
                    })
            self._send_json({
                "ok": True,
                "transactions": txs,
                "summary": {"totalCount": len(txs)}
            })
            return

        self._send_json({"ok": False, "error": f"未知的 API Action: {action}"})
