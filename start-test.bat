@echo off
rem Starts eSign for testing. Use this every time after the first setup.
cd /d "%~dp0"
docker compose -f compose.dev.yml up -d > nul 2>&1
start "eSign API" cmd /k "npm run dev:api"
start "eSign worker (emails)" cmd /k "npm run dev:worker"
start "eSign web" cmd /k "npm run dev:web"
echo Waiting for eSign to start...
timeout /t 25 /nobreak > nul
start "" http://localhost:5173
start "" http://localhost:8025
echo.
echo eSign:   http://localhost:5173   (sign in with SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD from apps/api/.env)
echo Emails:  http://localhost:8025
echo To stop: close the three eSign windows.
pause
