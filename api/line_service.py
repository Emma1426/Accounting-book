import os
import json
import base64
import requests
from io import BytesIO
from PIL import Image, ImageDraw, ImageFont

LINE_API_BASE = "https://api.line.me/v2/bot"
LINE_DATA_BASE = "https://api-data.line.me/v2/bot"

def get_line_token():
    return os.environ.get('LINE_CHANNEL_ACCESS_TOKEN', '').strip()

def line_headers(content_type="application/json"):
    token = get_line_token()
    h = {"Authorization": f"Bearer {token}"}
    if content_type:
        h["Content-Type"] = content_type
    return h

def reply_line_messages(reply_token, messages):
    url = f"{LINE_API_BASE}/message/reply"
    payload = {
        "replyToken": reply_token,
        "messages": messages
    }
    resp = requests.post(url, json=payload, headers=line_headers(), timeout=10)
    return resp.status_code == 200

def get_line_message_content(message_id):
    url = f"{LINE_DATA_BASE}/message/{message_id}/content"
    resp = requests.get(url, headers=line_headers(None), timeout=30)
    if resp.status_code == 200:
        return resp.content, resp.headers.get('Content-Type', 'image/jpeg')
    return None, None

def create_default_rich_menu_image():
    """使用 Pillow 動態繪製預設 2500x843 3格圖文選單圖片"""
    width, height = 2500, 843
    img = Image.new('RGB', (width, height), color=(26, 30, 46))
    draw = ImageDraw.Draw(img)

    # 繪製分隔線
    col_w = width // 3
    draw.line([(col_w, 40), (col_w, height - 40)], fill=(55, 65, 81), width=4)
    draw.line([(col_w * 2, 40), (col_w * 2, height - 40)], fill=(55, 65, 81), width=4)

    # 繪製文字與色塊裝飾
    # 這裡可以用簡單矩形與文字
    items = [
        ("✍️ 點選記帳", "點擊開始對話記帳", (59, 130, 246)),
        ("📸 收據記帳", "拍照或上傳發票收據", (16, 185, 129)),
        ("📱 手機查帳", "開啟智慧雲端儀表板", (168, 85, 247))
    ]

    for i, (title, subtitle, color) in enumerate(items):
        cx = i * col_w + col_w // 2
        # 標題外框
        rx1, ry1, rx2, ry2 = cx - 240, 250, cx + 240, 420
        draw.rounded_rectangle([rx1, ry1, rx2, ry2], radius=30, fill=color)

    out = BytesIO()
    img.save(out, format='PNG')
    return out.getvalue()

def setup_rich_menu_flow(dashboard_url, custom_image_bytes=None, custom_mime="image/png"):
    token = get_line_token()
    if not token:
        return {"ok": False, "error": "缺少 LINE_CHANNEL_ACCESS_TOKEN"}

    # 1. 取得舊選單並解除綁定刪除
    try:
        r = requests.get(f"{LINE_API_BASE}/user/all/richmenu", headers=line_headers(), timeout=10)
        if r.status_code == 200:
            old_id = r.json().get('richMenuId')
            if old_id:
                requests.delete(f"{LINE_API_BASE}/user/all/richmenu", headers=line_headers())
        
        # 列出所有選單並刪除
        r_list = requests.get(f"{LINE_API_BASE}/richmenu/list", headers=line_headers(), timeout=10)
        if r_list.status_code == 200:
            for menu in r_list.json().get('richmenus', []):
                mid = menu.get('richMenuId')
                requests.delete(f"{LINE_API_BASE}/richmenu/{mid}", headers=line_headers())
    except Exception as e:
        print(f"清理舊選單警告: {e}")

    # 2. 定義新 Rich Menu 結構 (3格)
    width = 2500
    height = 843
    col_w = width // 3

    menu_def = {
        "size": {"width": width, "height": height},
        "selected": True,
        "name": "AI 記帳專屬圖文選單",
        "chatBarText": "選單：點選記帳 / 查帳",
        "areas": [
            {
                "bounds": {"x": 0, "y": 0, "width": col_w, "height": height},
                "action": {
                    "type": "message",
                    "text": "✍️ 點選記帳"
                }
            },
            {
                "bounds": {"x": col_w, "y": 0, "width": col_w, "height": height},
                "action": {
                    "type": "message",
                    "text": "📸 收據記帳"
                }
            },
            {
                "bounds": {"x": col_w * 2, "y": 0, "width": col_w, "height": height},
                "action": {
                    "type": "uri",
                    "uri": dashboard_url or "https://emma1426.github.io/Accounting-book/?view=mobile"
                }
            }
        ]
    }

    # 3. 建立選單本體
    create_resp = requests.post(f"{LINE_API_BASE}/richmenu", json=menu_def, headers=line_headers(), timeout=15)
    if create_resp.status_code != 200:
        return {"ok": False, "error": f"建立 Rich Menu 失敗: {create_resp.text}"}

    rich_menu_id = create_resp.json().get('richMenuId')

    # 4. 上傳圖片
    if custom_image_bytes:
        img_bytes = custom_image_bytes
        content_type = custom_mime
    else:
        img_bytes = create_default_rich_menu_image()
        content_type = "image/png"

    upload_headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": content_type
    }
    up_resp = requests.post(
        f"{LINE_DATA_BASE}/richmenu/{rich_menu_id}/content",
        data=img_bytes,
        headers=upload_headers,
        timeout=30
    )
    if up_resp.status_code != 200:
        return {"ok": False, "error": f"上傳 Rich Menu 圖片失敗: {up_resp.text}"}

    # 5. 設為所有人預設選單
    def_resp = requests.post(
        f"{LINE_API_BASE}/user/all/richmenu/{rich_menu_id}",
        headers=line_headers(),
        timeout=15
    )
    if def_resp.status_code != 200:
        return {"ok": False, "error": f"設為預設 Rich Menu 失敗: {def_resp.text}"}

    return {"ok": True, "richMenuId": rich_menu_id}
