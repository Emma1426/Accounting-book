import os
import json
import base64
from google.oauth2 import service_account
from googleapiclient.discovery import build

SCOPES = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive'
]

def get_env_credentials():
    """從環境變數 GOOGLE_SERVICE_ACCOUNT_JSON (字串或 base64) 建立憑證"""
    sa_json = os.environ.get('GOOGLE_SERVICE_ACCOUNT_JSON', '').strip()
    if not sa_json:
        # 也支援本機檔案 fallback
        local_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', 'service_account.json')
        if os.path.exists(local_path):
            return service_account.Credentials.from_service_account_file(local_path, scopes=SCOPES)
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

def get_sheets_service():
    creds = get_env_credentials()
    if not creds:
        return None
    return build('sheets', 'v4', credentials=creds, cache_discovery=False)

def get_drive_service():
    creds = get_env_credentials()
    if not creds:
        return None
    return build('drive', 'v3', credentials=creds, cache_discovery=False)

def get_sheet_values(spreadsheet_id, range_name):
    service = get_sheets_service()
    if not service:
        return []
    try:
        result = service.spreadsheets().values().get(
            spreadsheetId=spreadsheet_id,
            range=range_name
        ).execute()
        return result.get('values', [])
    except Exception as e:
        print(f"Error reading range {range_name}: {e}")
        return []

def append_sheet_values(spreadsheet_id, range_name, values):
    service = get_sheets_service()
    if not service:
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
    if not service:
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
