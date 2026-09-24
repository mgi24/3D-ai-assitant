"""Minimal test: can pywebview create and show a window at all?"""
import os
os.environ["WEBVIEW2_DEFAULT_BACKGROUND_COLOR"] = "0"

import webview
import threading
import time
import ctypes
from ctypes import wintypes

print("[test] Creating minimal webview window...")
window = webview.create_window(
    title='AICHAT TEST',
    html='<html><body style="background:red"><h1>TEST WINDOW</h1></body></html>',
    width=300,
    height=200,
    frameless=False,
    transparent=False,
    on_top=True
)

def check_window():
    """After 5 seconds, check if window appeared."""
    time.sleep(5)
    user32 = ctypes.windll.user32
    found = []
    def cb(hwnd, extra):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            txt = buff.value
            if 'AICHAT TEST' in txt:
                found.append(txt)
        return True
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    if found:
        print(f"[test] SUCCESS: Window found! Title: {found}")
    else:
        print("[test] FAIL: No window found after 5 seconds!")
    
    # Close window after check
    time.sleep(1)
    try:
        window.destroy()
    except:
        pass

t = threading.Thread(target=check_window, daemon=True)
t.start()

print("[test] Calling webview.start()...")
webview.start(debug=True)
print("[test] webview.start() returned.")
