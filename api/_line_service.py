import os
import json
import zlib
import struct
import urllib.request
import urllib.error

try:
    import requests
except ImportError:
    requests = None

LINE_API_BASE = "https://api.line.me/v2/bot"
LINE_DATA_BASE = "https://api-data.line.me/v2/bot"

def _http_request(method, url, headers=None, json_body=None, raw_data=None, timeout=20):
    """具備 requests 與標準庫 urllib 雙重支援的 HTTP 呼叫工具"""
    hdrs = dict(headers or {})
    if requests is not None:
        resp = requests.request(
            method=method,
            url=url,
            headers=hdrs,
            json=json_body,
            data=raw_data,
            timeout=timeout
        )
        return resp.status_code, resp.content, resp.headers

    data_bytes = raw_data
    if json_body is not None:
        data_bytes = json.dumps(json_body, ensure_ascii=False).encode('utf-8')
        if 'Content-Type' not in hdrs:
            hdrs['Content-Type'] = 'application/json'

    req = urllib.request.Request(url, data=data_bytes, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read(), dict(r.info())
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})

def get_line_token(override_token=None):
    if override_token and str(override_token).strip():
        return str(override_token).strip()
    return os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '').strip()

def line_headers(content_type="application/json", override_token=None):
    token = get_line_token(override_token)
    h = {"Authorization": f"Bearer {token}"}
    if content_type:
        h["Content-Type"] = content_type
    return h

def reply_line_messages(reply_token, messages, override_token=None):
    token = get_line_token(override_token)
    if not token or not reply_token or reply_token.startswith('000000'):
        return False
    url = f"{LINE_API_BASE}/message/reply"
    payload = {
        "replyToken": reply_token,
        "messages": messages
    }
    status, _, _ = _http_request("POST", url, headers=line_headers(override_token=token), json_body=payload, timeout=15)
    return status == 200

def reply_line_text(reply_token, text, mobile_url='', override_token=None):
    return reply_line_messages(
        reply_token,
        [{
            "type": "text",
            "text": text,
            "quickReply": build_standard_quick_reply(mobile_url)
        }],
        override_token=override_token
    )

def get_line_message_content(message_id, override_token=None):
    token = get_line_token(override_token)
    url = f"{LINE_DATA_BASE}/message/{message_id}/content"
    status, content, hdrs = _http_request("GET", url, headers=line_headers(None, override_token=token), timeout=30)
    if status == 200:
        ctype = hdrs.get('Content-Type') or hdrs.get('content-type') or 'image/jpeg'
        return content, ctype
    return None, None

def create_default_rich_menu_image():
    """使用純 Python 標準庫 (zlib + struct) 動態產生 1200x810 文青六宮格 PNG（零外部 C 套件依賴）"""
    width, height = 1200, 810
    bg = bytes((246, 245, 240))
    ink = bytes((20, 20, 19))

    col1, col2 = width // 3, (width // 3) * 2
    row_mid = height // 2

    # 預先建構常用的橫列樣板以極速生成影像
    blank_row = b'\x00' + bg * width
    full_border_row = b'\x00' + (bg * 10) + (ink * (width - 20)) + (bg * 10)

    mid_arr = bytearray(b'\x00' + bg * width)
    # 左右外框
    for x in (10, 11, 12, 16, width - 17, width - 13, width - 12, width - 11):
        offset = 1 + x * 3
        mid_arr[offset:offset + 3] = ink
    # 垂直六宮格分隔線
    for x in (col1 - 1, col1, col2 - 1, col2):
        offset = 1 + x * 3
        mid_arr[offset:offset + 3] = ink
    normal_grid_row = bytes(mid_arr)

    rows = []
    for y in range(height):
        if y < 10 or y >= height - 10 or (13 <= y < 16) or (height - 16 <= y < height - 13):
            rows.append(blank_row)
        elif (10 <= y < 13) or (height - 13 <= y < height - 10) or y == 16 or y == height - 17 or (row_mid - 1 <= y <= row_mid):
            rows.append(full_border_row)
        else:
            rows.append(normal_grid_row)

    raw_data = b''.join(rows)

    def make_chunk(chunk_type, data):
        chunk = chunk_type + data
        return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)
    compressed = zlib.compress(raw_data, level=6)
    return (
        b'\x89PNG\r\n\x1a\n' +
        make_chunk(b'IHDR', ihdr) +
        make_chunk(b'IDAT', compressed) +
        make_chunk(b'IEND', b'')
    )

def setup_rich_menu_flow(mobile_web_url, custom_image_bytes=None, custom_mime="image/png", override_token=None):
    token = get_line_token(override_token)
    if not token:
        return {
            "ok": False,
            "error": "尚未設定 LINE_CHANNEL_ACCESS_TOKEN，請先在環境變數或網頁設定頁填入"
        }

    # 1. 清理舊的同名圖文選單，避免累積
    try:
        st_list, content_list, _ = _http_request(
            "GET",
            f"{LINE_API_BASE}/richmenu/list",
            headers=line_headers(override_token=token),
            timeout=10
        )
        if st_list == 200 and content_list:
            data_list = json.loads(content_list.decode('utf-8'))
            for rm in data_list.get('richmenus', []):
                rm_name = rm.get('name', '')
                rm_id = rm.get('richMenuId', '')
                if rm_id and ('Minimalist_AI_Accounting' in rm_name or 'AI 記帳' in rm_name):
                    _http_request(
                        "DELETE",
                        f"{LINE_API_BASE}/richmenu/{rm_id}",
                        headers=line_headers(override_token=token),
                        timeout=10
                    )
    except Exception as e:
        print(f"清理舊選單略過: {e}")

    # 2. 建立 1200x810 六宮格極簡圖文選單結構（與前端 Canvas 100% 對齊）
    target_uri = mobile_web_url or "https://emma1426.github.io/Accounting-book/"
    rich_menu_payload = {
        "size": {"width": 1200, "height": 810},
        "selected": True,
        "name": "Minimalist_AI_Accounting_Menu_v2",
        "chatBarText": "📒 點選記帳 · 手機檢視帳務",
        "areas": [
            {
                "bounds": {"x": 0, "y": 0, "width": 400, "height": 405},
                "action": {
                    "type": "postback",
                    "label": "點選記帳",
                    "data": "action=start_accounting&mode=text",
                    "displayText": "✍️ 點選開始記帳"
                }
            },
            {
                "bounds": {"x": 400, "y": 0, "width": 400, "height": 405},
                "action": {
                    "type": "postback",
                    "label": "拍收據記帳",
                    "data": "action=start_accounting&mode=image",
                    "displayText": "📸 拍收據記帳"
                }
            },
            {
                "bounds": {"x": 800, "y": 0, "width": 400, "height": 405},
                "action": {
                    "type": "uri",
                    "label": "手機版檢視帳務",
                    "uri": target_uri
                }
            },
            {
                "bounds": {"x": 0, "y": 405, "width": 400, "height": 405},
                "action": {
                    "type": "postback",
                    "label": "本月摘要",
                    "data": "action=monthly_summary",
                    "displayText": "📊 查看本月帳務摘要"
                }
            },
            {
                "bounds": {"x": 400, "y": 405, "width": 400, "height": 405},
                "action": {
                    "type": "postback",
                    "label": "AI 財務診斷",
                    "data": "action=ai_diagnosis",
                    "displayText": "✨ 執行 AI 財務診斷"
                }
            },
            {
                "bounds": {"x": 800, "y": 405, "width": 400, "height": 405},
                "action": {
                    "type": "postback",
                    "label": "撤銷上筆",
                    "data": "action=undo_last",
                    "displayText": "↩️ 撤銷上一筆記帳"
                }
            }
        ]
    }

    st_create, body_create, _ = _http_request(
        "POST",
        f"{LINE_API_BASE}/richmenu",
        headers=line_headers(override_token=token),
        json_body=rich_menu_payload,
        timeout=15
    )
    if st_create != 200:
        return {"ok": False, "error": f"建立 LINE Rich Menu 失敗: {body_create.decode('utf-8', errors='ignore')}"}

    rich_menu_id = json.loads(body_create.decode('utf-8')).get('richMenuId')

    # 3. 上傳圖文選單圖片
    if custom_image_bytes:
        img_bytes = custom_image_bytes
        content_type = custom_mime or "image/jpeg"
    else:
        img_bytes = create_default_rich_menu_image()
        content_type = "image/png"

    st_up, body_up, _ = _http_request(
        "POST",
        f"{LINE_DATA_BASE}/richmenu/{rich_menu_id}/content",
        headers=line_headers(content_type, override_token=token),
        raw_data=img_bytes,
        timeout=30
    )
    if st_up != 200:
        return {"ok": False, "error": f"上傳 LINE Rich Menu 圖片失敗: {body_up.decode('utf-8', errors='ignore')}"}

    # 4. 設為全體使用者預設圖文選單
    st_def, body_def, _ = _http_request(
        "POST",
        f"{LINE_API_BASE}/user/all/richmenu/{rich_menu_id}",
        headers=line_headers(override_token=token),
        timeout=15
    )
    if st_def != 200:
        return {"ok": False, "error": f"設定預設 LINE Rich Menu 失敗: {body_def.decode('utf-8', errors='ignore')}"}

    return {
        "ok": True,
        "richMenuId": rich_menu_id,
        "mobileWebUrl": target_uri
    }

# ============================================================================
# LINE Flex Messages & Quick Reply 建構器（與原 GAS 100% 視覺對齊）
# ============================================================================

def build_standard_quick_reply(mobile_url=''):
    items = [
        {
            "type": "action",
            "action": {
                "type": "postback",
                "label": "✍️ 點選記帳",
                "data": "action=start_accounting&mode=text",
                "displayText": "✍️ 點選開始記帳"
            }
        },
        {
            "type": "action",
            "action": {
                "type": "postback",
                "label": "📸 收據記帳",
                "data": "action=start_accounting&mode=image",
                "displayText": "📸 拍收據記帳"
            }
        }
    ]
    if mobile_url:
        items.append({
            "type": "action",
            "action": {
                "type": "uri",
                "label": "📱 手機檢視帳務",
                "uri": mobile_url
            }
        })
    items.append({
        "type": "action",
        "action": {
            "type": "postback",
            "label": "📊 本月摘要",
            "data": "action=monthly_summary",
            "displayText": "📊 查看本月帳務摘要"
        }
    })
    return {"items": items}

def build_accounting_started_flex(input_mode='text', mobile_url=''):
    is_image = (input_mode == 'image')
    footer_contents = [
        {
            "type": "button",
            "style": "secondary",
            "height": "sm",
            "action": {
                "type": "postback",
                "label": "❌ 取消記帳",
                "data": "action=cancel_accounting",
                "displayText": "取消記帳"
            }
        }
    ]
    if mobile_url:
        footer_contents.append({
            "type": "button",
            "style": "link",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "📱 手機查帳",
                "uri": mobile_url
            }
        })

    return {
        "type": "flex",
        "altText": "📸 已開啟收據記帳模式，請傳送照片" if is_image else "✍️ 已開啟記帳模式，請輸入消費內容",
        "contents": {
            "type": "bubble",
            "size": "kilo",
            "header": {
                "type": "box",
                "layout": "vertical",
                "backgroundColor": "#0f172a",
                "paddingAll": "14px",
                "contents": [
                    {
                        "type": "text",
                        "text": "📸 收據記帳模式已啟動" if is_image else "✍️ 文字記帳模式已啟動",
                        "color": "#ffffff",
                        "weight": "bold",
                        "size": "sm"
                    }
                ]
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "paddingAll": "14px",
                "spacing": "sm",
                "contents": [
                    {
                        "type": "text",
                        "text": "請點選下方按鈕拍攝或選擇您的發票 / 收據照片上傳：" if is_image else "請輸入這筆消費內容（支援單則多筆），例如：",
                        "size": "xs",
                        "color": "#334155",
                        "wrap": True
                    },
                    {
                        "type": "text",
                        "text": "• 紙本發票、超商明細、餐廳收據或網購截圖" if is_image else "• 午餐便當 120\n• 早餐45 拿鐵65 捷運30\n• 10/23 薪水入帳 55000",
                        "size": "xs",
                        "color": "#64748b",
                        "wrap": True
                    }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "horizontal",
                "spacing": "sm",
                "contents": footer_contents
            }
        },
        "quickReply": {
            "items": [
                {"type": "action", "action": {"type": "camera", "label": "📷 拍攝收據"}},
                {"type": "action", "action": {"type": "cameraRoll", "label": "🖼️ 相簿選圖"}},
                {
                    "type": "action",
                    "action": {
                        "type": "postback",
                        "label": "❌ 取消記帳",
                        "data": "action=cancel_accounting",
                        "displayText": "取消記帳"
                    }
                }
            ]
        }
    }

def build_not_triggered_prompt_flex(draft_type, preview_text, mobile_url=''):
    short_preview = str(preview_text or '')[:40]
    sub_btns = [
        {
            "type": "button",
            "style": "secondary",
            "height": "sm",
            "action": {
                "type": "postback",
                "label": "忽略訊息",
                "data": "action=cancel_accounting"
            }
        }
    ]
    if mobile_url:
        sub_btns.append({
            "type": "button",
            "style": "secondary",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "📱 手機查帳",
                "uri": mobile_url
            }
        })

    return {
        "type": "flex",
        "altText": "⏸️ 尚未觸發記帳：請點選確認按鈕或圖文選單開始記帳",
        "contents": {
            "type": "bubble",
            "size": "kilo",
            "header": {
                "type": "box",
                "layout": "vertical",
                "backgroundColor": "#334155",
                "paddingAll": "14px",
                "contents": [
                    {
                        "type": "text",
                        "text": "⏸️ 直接傳送不會自動記帳",
                        "color": "#ffffff",
                        "weight": "bold",
                        "size": "sm"
                    }
                ]
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "paddingAll": "14px",
                "spacing": "sm",
                "contents": [
                    {
                        "type": "text",
                        "text": f"收到內容：「{short_preview}」",
                        "size": "xs",
                        "weight": "bold",
                        "color": "#0f172a",
                        "wrap": True
                    },
                    {
                        "type": "text",
                        "text": "為避免日常對話誤觸，請先點選下方圖文選單【✍️ 點選記帳】，或直接點選下方按鈕將此筆內容入帳：",
                        "size": "xs",
                        "color": "#64748b",
                        "wrap": True
                    }
                ]
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": [
                    {
                        "type": "button",
                        "style": "primary",
                        "color": "#0f172a",
                        "height": "sm",
                        "action": {
                            "type": "postback",
                            "label": "✅ 點選觸發此筆記帳",
                            "data": "action=trigger_pending_draft",
                            "displayText": "✅ 確認觸發記帳"
                        }
                    },
                    {
                        "type": "box",
                        "layout": "horizontal",
                        "spacing": "sm",
                        "contents": sub_btns
                    }
                ]
            }
        }
    }

def build_preview_confirm_flex(items, assistant_note=''):
    total_amount = sum(float(t.get('amount') or 0) for t in items)
    rows = []
    for t in items[:6]:
        rows.append({
            "type": "box",
            "layout": "horizontal",
            "margin": "xs",
            "contents": [
                {
                    "type": "text",
                    "text": f"{t.get('category', '')} › {t.get('subcategory') or '一般'}｜{t.get('item', '')}",
                    "size": "xs",
                    "color": "#334155",
                    "flex": 4,
                    "wrap": True
                },
                {
                    "type": "text",
                    "text": f"${int(float(t.get('amount') or 0)):,}",
                    "size": "xs",
                    "weight": "bold",
                    "color": "#0f172a",
                    "align": "end",
                    "flex": 2
                }
            ]
        })

    return {
        "type": "flex",
        "altText": f"📋 記帳預覽：共 {len(items)} 筆 (${int(total_amount):,})，請點選確認入帳",
        "contents": {
            "type": "bubble",
            "size": "kilo",
            "header": {
                "type": "box",
                "layout": "vertical",
                "backgroundColor": "#0f172a",
                "paddingAll": "14px",
                "contents": [
                    {"type": "text", "text": "📋 AI 記帳預覽（請點選確認入帳）", "color": "#94a3b8", "size": "xs"},
                    {"type": "text", "text": f"NT$ {int(total_amount):,}", "color": "#ffffff", "weight": "bold", "size": "xl", "margin": "xs"}
                ]
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "paddingAll": "14px",
                "contents": rows
            },
            "footer": {
                "type": "box",
                "layout": "horizontal",
                "spacing": "sm",
                "contents": [
                    {
                        "type": "button",
                        "style": "secondary",
                        "height": "sm",
                        "action": {"type": "postback", "label": "取消", "data": "action=cancel_accounting"}
                    },
                    {
                        "type": "button",
                        "style": "primary",
                        "color": "#10b981",
                        "height": "sm",
                        "action": {
                            "type": "postback",
                            "label": "✅ 確認入帳",
                            "data": "action=confirm_preview_save",
                            "displayText": "✅ 確認寫入帳本"
                        }
                    }
                ]
            }
        }
    }

def build_receipt_confirm_flex(saved_batch, assistant_note='', mobile_url=''):
    txs = saved_batch.get('transactions', [])
    total_amount = sum(float(t.get('amount') or 0) for t in txs)
    is_income = all(t.get('type') == '收入' for t in txs) if txs else False
    header_color = '#059669' if is_income else '#0f172a'

    item_rows = []
    for t in txs[:8]:
        amt = int(float(t.get('amount') or 0))
        sub = f" › {t['subcategory']}" if t.get('subcategory') else ""
        item_rows.append({
            "type": "box",
            "layout": "horizontal",
            "margin": "sm",
            "contents": [
                {
                    "type": "text",
                    "text": f"{t.get('category', '')}{sub}｜{t.get('item', '')}",
                    "size": "xs",
                    "color": "#334155",
                    "flex": 4,
                    "wrap": True
                },
                {
                    "type": "text",
                    "text": f"{'+' if t.get('type') == '收入' else ''}${amt:,}",
                    "size": "xs",
                    "color": "#059669" if t.get('type') == '收入' else "#0f172a",
                    "weight": "bold",
                    "align": "end",
                    "flex": 2
                }
            ]
        })

    first_tx = txs[0] if txs else {"date": "", "paymentMethod": "現金"}
    footer_buttons = []
    if mobile_url:
        footer_buttons.append({
            "type": "button",
            "style": "primary",
            "color": "#0f172a",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "📱 手機版檢視帳務 (網頁)",
                "uri": mobile_url
            }
        })

    footer_buttons.append({
        "type": "box",
        "layout": "horizontal",
        "spacing": "sm",
        "contents": [
            {
                "type": "button",
                "style": "secondary",
                "height": "sm",
                "action": {
                    "type": "postback",
                    "label": "➕ 再記一筆",
                    "data": "action=start_accounting&mode=text",
                    "displayText": "✍️ 點選開始記帳"
                }
            },
            {
                "type": "button",
                "style": "secondary",
                "height": "sm",
                "action": {
                    "type": "postback",
                    "label": "↩️ 撤銷此筆",
                    "data": f"action=delete_batch&batchId={saved_batch.get('batchId', '')}",
                    "displayText": "↩️ 撤銷此筆記帳"
                }
            }
        ]
    })

    return {
        "type": "flex",
        "altText": f"✅ 已記帳 {len(txs)} 筆，共 ${int(total_amount):,}",
        "contents": {
            "type": "bubble",
            "size": "kilo",
            "header": {
                "type": "box",
                "layout": "vertical",
                "backgroundColor": header_color,
                "paddingAll": "14px",
                "contents": [
                    {
                        "type": "box",
                        "layout": "horizontal",
                        "contents": [
                            {
                                "type": "text",
                                "text": "💰 收入已入帳" if is_income else "✅ 已寫入 Google Sheet",
                                "color": "#ffffff",
                                "weight": "bold",
                                "size": "xs",
                                "flex": 3
                            },
                            {
                                "type": "text",
                                "text": f"{first_tx.get('date', '')} · {first_tx.get('paymentMethod', '')}",
                                "color": "#cbd5e1",
                                "size": "xxs",
                                "align": "end",
                                "gravity": "center",
                                "flex": 3
                            }
                        ]
                    },
                    {
                        "type": "text",
                        "text": f"NT$ {int(total_amount):,}",
                        "color": "#ffffff",
                        "weight": "bold",
                        "size": "xl",
                        "margin": "sm"
                    }
                ]
            },
            "body": {
                "type": "box",
                "layout": "vertical",
                "paddingAll": "14px",
                "contents": item_rows
            },
            "footer": {
                "type": "box",
                "layout": "vertical",
                "spacing": "sm",
                "contents": footer_buttons
            }
        },
        "quickReply": build_standard_quick_reply(mobile_url)
    }

def build_monthly_summary_flex(summary, mobile_url=''):
    top_cats = [c for c in summary.get('categories', []) if c.get('amount', 0) > 0][:5]
    total_exp = summary.get('totalExpense', 0)
    if top_cats:
        cat_rows = []
        for c in top_cats:
            pct = round((c['amount'] / total_exp) * 100) if total_exp > 0 else 0
            cat_rows.append({
                "type": "box",
                "layout": "horizontal",
                "margin": "xs",
                "contents": [
                    {"type": "text", "text": f"{c['category']} ({pct}%)", "size": "xs", "color": "#334155", "flex": 3},
                    {"type": "text", "text": f"${int(c['amount']):,}", "size": "xs", "weight": "bold", "align": "end", "flex": 2}
                ]
            })
    else:
        cat_rows = [{"type": "text", "text": "本月尚無支出紀錄", "size": "xs", "color": "#94a3b8"}]

    footer_btns = []
    if mobile_url:
        footer_btns.append({
            "type": "button",
            "style": "primary",
            "color": "#0f172a",
            "height": "sm",
            "action": {
                "type": "uri",
                "label": "📱 開啟手機版網頁檢視帳務",
                "uri": mobile_url
            }
        })

    bubble = {
        "type": "bubble",
        "size": "kilo",
        "header": {
            "type": "box",
            "layout": "vertical",
            "backgroundColor": "#0f172a",
            "paddingAll": "14px",
            "contents": [
                {"type": "text", "text": f"📊 {summary.get('yearMonth', '')} 帳務摘要", "color": "#94a3b8", "weight": "bold", "size": "xs"},
                {"type": "text", "text": f"支出 NT$ {int(total_exp):,}", "color": "#ffffff", "weight": "bold", "size": "xl", "margin": "xs"},
                {"type": "text", "text": f"收入 ${int(summary.get('totalIncome', 0)):,} ｜ 結餘 ${int(summary.get('netSavings', 0)):,}", "color": "#cbd5e1", "size": "xxs", "margin": "xs"}
            ]
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "paddingAll": "14px",
            "contents": [
                {
                    "type": "text",
                    "text": f"預算使用率：{summary.get('budgetUsageRate', 0)}% （上限 ${int(summary.get('totalMonthlyBudget', 0)):,}）",
                    "size": "xs",
                    "weight": "bold",
                    "color": "#e11d48" if summary.get('budgetUsageRate', 0) > 90 else "#059669"
                },
                {"type": "separator", "margin": "sm"},
                {"type": "box", "layout": "vertical", "margin": "sm", "contents": cat_rows}
            ]
        }
    }
    if footer_btns:
        bubble["footer"] = {
            "type": "box",
            "layout": "vertical",
            "spacing": "sm",
            "contents": footer_btns
        }

    return {
        "type": "flex",
        "altText": f"📊 {summary.get('yearMonth', '')} 帳務摘要",
        "contents": bubble,
        "quickReply": build_standard_quick_reply(mobile_url)
    }

def build_diagnosis_flex_message(report, mobile_url=''):
    tips_rows = []
    for idx, tip in enumerate((report.get('actionableTips') or [])[:3]):
        tips_rows.append({
            "type": "box",
            "layout": "vertical",
            "margin": "sm",
            "contents": [
                {
                    "type": "text",
                    "text": f"{idx + 1}. {tip.get('action', '')}（{tip.get('expectedImpact', '')}）",
                    "size": "xs",
                    "weight": "bold",
                    "color": "#0f172a",
                    "wrap": True
                },
                {
                    "type": "text",
                    "text": tip.get('description', ''),
                    "size": "xxs",
                    "color": "#64748b",
                    "wrap": True,
                    "margin": "xs"
                }
            ]
        })

    bubble = {
        "type": "bubble",
        "size": "kilo",
        "header": {
            "type": "box",
            "layout": "vertical",
            "backgroundColor": "#0f172a",
            "paddingAll": "14px",
            "contents": [
                {"type": "text", "text": f"✨ {report.get('period', '')} AI 財務診斷", "color": "#94a3b8", "size": "xs", "weight": "bold"},
                {
                    "type": "box",
                    "layout": "baseline",
                    "margin": "xs",
                    "contents": [
                        {"type": "text", "text": str(report.get('healthScore', 0)), "color": "#ffffff", "size": "xxl", "weight": "bold", "flex": 0},
                        {"type": "text", "text": f" / 100 ({report.get('healthGrade', 'A')})", "color": "#cbd5e1", "size": "xs", "margin": "sm"}
                    ]
                }
            ]
        },
        "body": {
            "type": "box",
            "layout": "vertical",
            "paddingAll": "14px",
            "contents": [
                {
                    "type": "text",
                    "text": report.get('executiveSummary', ''),
                    "size": "xs",
                    "color": "#334155",
                    "wrap": True
                },
                {"type": "separator", "margin": "sm"},
                {"type": "box", "layout": "vertical", "contents": tips_rows}
            ]
        }
    }
    if mobile_url:
        bubble["footer"] = {
            "type": "box",
            "layout": "vertical",
            "contents": [
                {
                    "type": "button",
                    "style": "secondary",
                    "height": "sm",
                    "action": {
                        "type": "uri",
                        "label": "📱 手機版查看完整報表",
                        "uri": mobile_url
                    }
                }
            ]
        }

    return {
        "type": "flex",
        "altText": f"✨ AI 財務診斷：{report.get('healthScore', 0)} 分",
        "contents": bubble,
        "quickReply": build_standard_quick_reply(mobile_url)
    }
