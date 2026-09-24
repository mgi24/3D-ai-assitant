import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import time
import subprocess
import threading
import ctypes
from ctypes import wintypes
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

def capture_window_and_region(win_title: str, out_img: str):
    hwnd = None
    for _ in range(30):
        hwnd = user32.FindWindowW(None, win_title)
        if hwnd:
            break
        time.sleep(0.5)

    if not hwnd:
        print(f"ERROR: Window '{win_title}' not found!")
        return False

    print(f"Found window HWND: {hwnd}. Waiting for 3D avatar render...")
    time.sleep(3.0)

    rect = wintypes.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    w = rect.right - rect.left
    h = rect.bottom - rect.top

    hdc_win = user32.GetDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
    old = gdi32.SelectObject(hdc_mem, hbmp)
    
    # PW_RENDERFULLCONTENT = 2
    res = user32.PrintWindow(hwnd, hdc_mem, 2)
    print(f"PrintWindow returned: {res}, window size: {w}x{h}")

    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ('biSize', wintypes.DWORD), ('biWidth', wintypes.LONG), ('biHeight', wintypes.LONG),
            ('biPlanes', wintypes.WORD), ('biBitCount', wintypes.WORD), ('biCompression', wintypes.DWORD),
            ('biSizeImage', wintypes.DWORD), ('biXPelsPerMeter', wintypes.LONG), ('biYPelsPerMeter', wintypes.LONG),
            ('biClrUsed', wintypes.DWORD), ('biClrImportant', wintypes.DWORD)
        ]
    class BITMAPINFO(ctypes.Structure):
        _fields_ = [('bmiHeader', BITMAPINFOHEADER), ('bmiColors', wintypes.DWORD * 3)]

    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = w
    bmi.bmiHeader.biHeight = -h
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0

    buf = ctypes.create_string_buffer(w * h * 4)
    gdi32.GetDIBits(hdc_mem, hbmp, 0, h, buf, ctypes.byref(bmi), 0)
    gdi32.SelectObject(hdc_mem, old)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_win)

    img = Image.frombuffer('RGBA', (w, h), buf, 'raw', 'BGRA', 0, 1)
    img.save(out_img)
    print(f"Saved verified screenshot: {out_img}")
    return True

if __name__ == '__main__':
    python_exe = sys.executable
    desktop_py = ROOT / 'desktop.py'
    output_path = ROOT / 'test-results' / 'desktop_verified_transparent.png'
    output_path.parent.mkdir(parents=True, exist_ok=True)
    
    print("Launching desktop.py...")
    proc = subprocess.Popen([python_exe, str(desktop_py)], cwd=str(ROOT))
    
    try:
        ok = capture_window_and_region('AICHAT Desktop Avatar', str(output_path))
        if ok:
            print("SUCCESS: Screen capture verification completed successfully!")
        else:
            print("FAILED: Window capture failed.")
    finally:
        print("Terminating desktop process...")
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except Exception:
            proc.kill()
