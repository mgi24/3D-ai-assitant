import ctypes
from ctypes import wintypes
from PIL import Image

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

# 1. Find AICHAT windows
wins = []
def cb(hwnd, extra):
    if user32.IsWindowVisible(hwnd):
        length = user32.GetWindowTextLengthW(hwnd)
        buff = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buff, length + 1)
        txt = buff.value
        if txt and ('AICHAT' in txt or 'Avatar' in txt):
            rect = wintypes.RECT()
            user32.GetWindowRect(hwnd, ctypes.byref(rect))
            wins.append((hwnd, txt, rect.left, rect.top, rect.right, rect.bottom))
    return True

WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
user32.EnumWindows(WNDENUMPROC(cb), 0)

if wins:
    for hwnd, txt, l, t, r, b in wins:
        print(f'FOUND: HWND={hwnd} Title="{txt}" Rect=({l},{t},{r},{b}) Size={r-l}x{b-t}')
        
        # Capture using PrintWindow
        w = r - l
        h = b - t
        if w > 0 and h > 0:
            hdc_win = user32.GetDC(hwnd)
            hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
            hbmp = gdi32.CreateCompatibleBitmap(hdc_win, w, h)
            old = gdi32.SelectObject(hdc_mem, hbmp)
            res = user32.PrintWindow(hwnd, hdc_mem, 2)
            print(f'PrintWindow result: {res}')
            
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
            img.save('screen_check.png')
            print(f'Saved screen_check.png ({w}x{h})')
else:
    print('NO AICHAT WINDOW FOUND')
