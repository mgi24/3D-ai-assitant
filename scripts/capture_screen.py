import ctypes
import sys
from pathlib import Path
from ctypes import wintypes
from PIL import Image

def capture_screen(output_path="screenshot.png"):
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32

    # Get monitor dimensions
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)

    hwnd = user32.GetDesktopWindow()
    hdc_screen = user32.GetDC(hwnd)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_screen)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_screen, width, height)
    old_bmp = gdi32.SelectObject(hdc_mem, hbmp)

    # SRCCOPY = 0x00CC0020
    gdi32.BitBlt(hdc_mem, 0, 0, width, height, hdc_screen, 0, 0, 0x00CC0020)

    # Bitmap info header
    class BITMAPINFOHEADER(ctypes.Structure):
        _fields_ = [
            ("biSize", wintypes.DWORD),
            ("biWidth", wintypes.LONG),
            ("biHeight", wintypes.LONG),
            ("biPlanes", wintypes.WORD),
            ("biBitCount", wintypes.WORD),
            ("biCompression", wintypes.DWORD),
            ("biSizeImage", wintypes.DWORD),
            ("biXPelsPerMeter", wintypes.LONG),
            ("biYPelsPerMeter", wintypes.LONG),
            ("biClrUsed", wintypes.DWORD),
            ("biClrImportant", wintypes.DWORD),
        ]

    class BITMAPINFO(ctypes.Structure):
        _fields_ = [
            ("bmiHeader", BITMAPINFOHEADER),
            ("bmiColors", wintypes.DWORD * 3)
        ]

    bmi = BITMAPINFO()
    bmi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
    bmi.bmiHeader.biWidth = width
    bmi.bmiHeader.biHeight = -height  # top-down DIB
    bmi.bmiHeader.biPlanes = 1
    bmi.bmiHeader.biBitCount = 32
    bmi.bmiHeader.biCompression = 0  # BI_RGB

    buffer_size = width * height * 4
    buffer = ctypes.create_string_buffer(buffer_size)

    gdi32.GetDIBits(hdc_mem, hbmp, 0, height, buffer, ctypes.byref(bmi), 0)

    # Cleanup GDI handles
    gdi32.SelectObject(hdc_mem, old_bmp)
    gdi32.DeleteObject(hbmp)
    gdi32.DeleteDC(hdc_mem)
    user32.ReleaseDC(hwnd, hdc_screen)

    img = Image.frombuffer("RGBA", (width, height), buffer, "raw", "BGRA", 0, 1)
    img.save(output_path)
    print(f"Captured screen {width}x{height} -> {output_path}")
    return output_path

if __name__ == "__main__":
    output_path = sys.argv[1] if len(sys.argv) > 1 else "test-results/screenshot_test.png"
    capture_screen(output_path)
