"""Test: replicate exact desktop.py conditions to find the hang."""
import os
os.environ["WEBVIEW2_DEFAULT_BACKGROUND_COLOR"] = "0"

import sys
import time
import ctypes
import subprocess
import threading
import urllib.request
from ctypes import wintypes

import webview

PORT = 4317
URL = f"http://127.0.0.1:{PORT}"
ROOT = os.path.dirname(os.path.abspath(__file__)) + '/..'
WIN_TITLE = 'AICHAT Desktop Avatar'

class MARGINS(ctypes.Structure):
    _fields_ = [
        ('cxLeftWidth', ctypes.c_int),
        ('cxRightWidth', ctypes.c_int),
        ('cyTopHeight', ctypes.c_int),
        ('cyBottomHeight', ctypes.c_int)
    ]

dwmapi = ctypes.windll.dwmapi
margins_val = MARGINS(-1, -1, -1, -1)

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
    print("[test] Starting server...")
    server_process = subprocess.Popen(
        [sys.executable, os.path.join(ROOT, 'server.py')],
        cwd=ROOT
    )
    for i in range(30):
        if is_server_ready():
            print("[test] Server ready!")
            break
        time.sleep(0.3)

print("[test] Creating window...")
window = webview.create_window(
    title=WIN_TITLE,
    url=URL,
    width=440,
    height=700,
    frameless=True,
    transparent=True,
    easy_drag=True,
    on_top=True
)

# ---- TEST: Add event hooks EXACTLY like desktop.py but with prints ----
def apply_dwm(form):
    try:
        from webview.platforms.winforms import Color
        hwnd = form.Handle.ToInt32()
        dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins_val))
        form.BackColor = Color.Black
        print("[test] DWM applied!")
    except Exception as err:
        print(f"[test] DWM error: {err}")

def on_window_ready():
    print("[test] on_window_ready fired!")
    if hasattr(window, 'native') and window.native:
        try:
            from webview.platforms.winforms import WinForms
            if window.native.InvokeRequired:
                print("[test] InvokeRequired=True, calling Invoke...")
                window.native.Invoke(WinForms.MethodInvoker(lambda: apply_dwm(window.native)))
            else:
                print("[test] InvokeRequired=False, calling directly...")
                apply_dwm(window.native)
        except Exception as e:
            print(f"[test] on_window_ready error: {e}")
    else:
        print("[test] window.native not available")

window.events.shown += on_window_ready
window.events.loaded += on_window_ready

# ---- TEST: configure_window_transparency thread EXACTLY like desktop.py ----
def configure_window_transparency(win_title):
    print("[test] configure_window_transparency thread started")
    try:
        from webview.platforms.winforms import WinForms, Color

        for i in range(60):
            time.sleep(0.1)
            for form in list(WinForms.Application.OpenForms):
                if win_title in form.Text or 'AICHAT' in form.Text:
                    def apply():
                        try:
                            hwnd = form.Handle.ToInt32()
                            dwmapi.DwmExtendFrameIntoClientArea(hwnd, ctypes.byref(margins_val))
                            form.BackColor = Color.Black
                        except Exception as err:
                            print(f"[test] Thread DWM error: {err}")
                    try:
                        print(f"[test] Thread found form, invoking... (iteration {i})")
                        form.Invoke(WinForms.MethodInvoker(apply))
                        print("[test] Thread DWM applied successfully!")
                        return
                    except Exception as e:
                        print(f"[test] Thread invoke error: {e}")
    except Exception as e:
        print(f"[test] Thread error: {e}")

t = threading.Thread(target=configure_window_transparency, args=(WIN_TITLE,), daemon=True)
t.start()

# ---- Window check after 8 seconds ----
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
                found.append(txt)
        return True
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    if found:
        print(f"[test] WINDOW FOUND: {found}")
    else:
        print("[test] FAIL: No AICHAT window found!")
    time.sleep(2)
    try:
        window.destroy()
    except:
        pass

tc = threading.Thread(target=check_window, daemon=True)
tc.start()

print("[test] Calling webview.start(debug=False)...")
webview.start(debug=False)
print("[test] webview.start() returned.")

if server_process and server_process.poll() is None:
    server_process.terminate()
