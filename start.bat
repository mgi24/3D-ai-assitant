@echo off
cd /d "%~dp0"

if not exist "node_modules\electron\install.js" (
    echo [ERROR] Electron is not installed in this project.
    echo Run: npm install
    pause
    exit /b 1
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo Preparing the Electron Windows runtime...
    node "node_modules\electron\install.js"
    if errorlevel 1 (
        echo [ERROR] Electron runtime setup failed.
        pause
        exit /b 1
    )
)

if not exist ".venv\Scripts\python.exe" (
    echo [ERROR] Python virtual environment not found.
    echo Expected: %~dp0.venv\Scripts\python.exe
    pause
    exit /b 1
)

call npm run build
if errorlevel 1 (
    echo [ERROR] The desktop UI build failed.
    pause
    exit /b 1
)

rem Electron owns the only visible window; backend output is written to logs\desktop.log.
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0desktop-main.cjs"
exit /b 0
