import time
import threading
import webview
from PIL import ImageGrab

def take_screenshot():
    time.sleep(3)
    # Grab screen
    im = ImageGrab.grab()
    im.save('transparency_test.png')
    print("Screenshot captured to transparency_test.png")
    time.sleep(1)
    # close window
    webview.windows[0].destroy()

html = """<!DOCTYPE html>
<html style="background: transparent;">
<head>
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: transparent !important;
    overflow: hidden;
  }
  .circle {
    width: 200px;
    height: 200px;
    background: red;
    border-radius: 50%;
    margin: 50px auto;
    display: flex;
    align-items: center;
    justify-content: center;
    color: white;
    font-family: sans-serif;
    font-size: 20px;
  }
</style>
</head>
<body style="background: transparent;">
  <div class="circle">TEST CIRCLE</div>
</body>
</html>
"""

t = threading.Thread(target=take_screenshot, daemon=True)
t.start()

window = webview.create_window(
    'Test Transparency',
    html=html,
    width=350,
    height=350,
    frameless=True,
    transparent=True,
    on_top=True
)
webview.start(debug=False)
