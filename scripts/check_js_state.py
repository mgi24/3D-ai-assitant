import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import time
import webview

def check_js(window):
    time.sleep(3)
    # Check avatar load status
    res = window.evaluate_js("""
        (() => {
            return {
                bodyState: document.body.dataset.state,
                avatarState: document.body.dataset.avatar,
                avatarInfo: window.avatarInfo || null,
                avatarError: document.getElementById('avatar-error') ? document.getElementById('avatar-error').textContent : null,
                hasCanvas: !!document.querySelector('#avatar-stage canvas')
            };
        })()
    """)
    print("JS STATE AT 3s:", res)
    time.sleep(5)
    res2 = window.evaluate_js("""
        (() => {
            return {
                bodyState: document.body.dataset.state,
                avatarState: document.body.dataset.avatar,
                avatarInfo: window.avatarInfo || null,
                avatarError: document.getElementById('avatar-error') ? document.getElementById('avatar-error').textContent : null,
                hasCanvas: !!document.querySelector('#avatar-stage canvas')
            };
        })()
    """)
    print("JS STATE AT 8s:", res2)
    window.destroy()

if __name__ == '__main__':
    # Ensure server is running
    import desktop
    import subprocess
    server_process = None
    if not desktop.is_server_ready(4317):
        server_process = subprocess.Popen([sys.executable, str(ROOT / 'server.py')], cwd=str(ROOT))
        for _ in range(40):
            if desktop.is_server_ready(4317):
                break
            time.sleep(0.3)
    
    win = webview.create_window('Test Debug JS', url='http://127.0.0.1:4317', width=440, height=700)
    import threading
    t = threading.Thread(target=check_js, args=(win,), daemon=True)
    t.start()
    webview.start(debug=False)
    if server_process:
        server_process.kill()
