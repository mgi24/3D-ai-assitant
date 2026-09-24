"""Quick diagnostic launcher for desktop.py — runs with full stdout tracing."""
import sys
import os
import subprocess
import time

os.environ["PYTHONUNBUFFERED"] = "1"
os.environ["WEBVIEW2_DEFAULT_BACKGROUND_COLOR"] = "0"

python = os.path.join(os.path.dirname(__file__), '..', '.venv', 'Scripts', 'python.exe')
desktop = os.path.join(os.path.dirname(__file__), '..', 'desktop.py')

print(f"[diag] Python: {python}")
print(f"[diag] desktop.py: {desktop}")
print(f"[diag] Starting desktop.py with unbuffered output...")
print(f"[diag] Time: {time.strftime('%H:%M:%S')}")

proc = subprocess.Popen(
    [python, '-u', desktop],
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    bufsize=1,
    env={**os.environ, "PYTHONUNBUFFERED": "1"}
)

start = time.time()
while time.time() - start < 25:
    line = proc.stdout.readline()
    if line:
        elapsed = time.time() - start
        print(f"[{elapsed:5.1f}s] {line.rstrip()}")
    elif proc.poll() is not None:
        print(f"[diag] Process exited with code {proc.returncode}")
        break
    else:
        time.sleep(0.1)

if proc.poll() is None:
    print(f"[diag] Process still running after 25s — checking window...")
    # Check if window exists
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    wins_found = []
    def cb(hwnd, extra):
        if user32.IsWindowVisible(hwnd):
            length = user32.GetWindowTextLengthW(hwnd)
            buff = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buff, length + 1)
            txt = buff.value
            if txt and ('AICHAT' in txt or 'Avatar' in txt):
                wins_found.append((hwnd, txt))
        return True
    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    
    if wins_found:
        for h, t in wins_found:
            print(f"[diag] WINDOW FOUND: HWND={h} Title={t}")
    else:
        print("[diag] NO AICHAT WINDOW FOUND — app is stuck/frozen!")
    
    proc.terminate()
    print("[diag] Terminated.")

# Drain remaining
for line in proc.stdout:
    print(f"[drain] {line.rstrip()}")
