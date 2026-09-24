"""Test: webview with transparent+frameless loading from localhost server."""
import os
os.environ["WEBVIEW2_DEFAULT_BACKGROUND_COLOR"] = "0"

import webview
import threading
import time
import ctypes
import urllib.request
from ctypes import wintypes

PORT = 4317
URL = f"http://127.0.0.1:{PORT}"

# Check if server is already running
def is_server_ready():
    try:
        req = urllib.request.Request(f"{URL}/api/health", headers={'User-Agent': 'test'})
        with urllib.request.urlopen(req, timeout=1) as res:
            return res.status == 200
    except:
        return False

# Start server if needed
server_process = None
if not is_server_ready():
    import subprocess, sys
    print("[test] Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, 'server.py'],
        cwd=os.path.dirname(os.path.abspath(__file__)) + '/..'
    )
    for i in range(30):
        if is_server_ready():
            print("[test] Server ready!")
            break
        time.sleep(0.3)
    else:
        print("[test] Server not ready after timeout")

print(f"[test] Server status: {'READY' if is_server_ready() else 'NOT READY'}")
print("[test] Creating transparent+frameless webview window...")

window = webview.create_window(
    title='AICHAT Desktop Avatar',
    url=URL,
    width=440,
    height=700,
    frameless=True,
    transparent=True,
    easy_drag=True,
    on_top=True
)

def check_window():
    time.sleep(8)
    user32 = ctypes.windll.user32
    found = []
    def cb(hwnd, extra):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            txt = buff.value
            if txt and ('AICHAT' in txt or 'Avatar' in txt):
                rect = wintypes.RECT()
                user32.GetWindowRect(hwnd, ctypes.byref(rect))
                found.append((txt, rect.left, rect.top, rect.right, rect.bottom))
        return True
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    if found:
        for txt, l, t, r, b in found:
            print(f"[test] WINDOW FOUND: '{txt}' at ({l},{t})-({r},{b}) Size={r-l}x{b-t}")
    else:
        print("[test] FAIL: No AICHAT window found after 8 seconds!")
    
    time.sleep(2)
    try:
        window.destroy()
    except:
        pass

t = threading.Thread(target=check_window, daemon=True)
t.start()

print("[test] Calling webview.start()...")
webview.start(debug=True)
print("[test] webview.start() returned.")

if server_process and server_process.poll() is None:
    server_process.terminate()
