@echo off
rem Ruliba Clays eSign - first-time setup and start on this PC (test use).
rem Double-click this file. Progress is shown here; full details go to setup-log.txt.
cd /d "%~dp0"
set LOG=%~dp0setup-log.txt
echo eSign setup started %DATE% %TIME% > "%LOG%"

echo [1/7] Checking Docker Desktop...
docker info >> "%LOG%" 2>&1
if errorlevel 1 (echo Docker Desktop is not running. Start it, wait until it says "Engine running", then run this again. & echo FAILED: docker not running >> "%LOG%" & pause & exit /b 1)

echo [2/7] Starting database, Redis and Mailpit...
docker compose -f compose.dev.yml up -d >> "%LOG%" 2>&1
if errorlevel 1 (echo Could not start the database. See setup-log.txt. & echo FAILED: compose up >> "%LOG%" & pause & exit /b 1)
set /a N=0
:waitdb
docker compose -f compose.dev.yml exec -T postgres pg_isready -U postgres >> "%LOG%" 2>&1
if not errorlevel 1 goto dbready
set /a N+=1
if %N% GEQ 30 (echo The database did not start. See setup-log.txt. & echo FAILED: db not ready >> "%LOG%" & pause & exit /b 1)
timeout /t 2 /nobreak > nul
goto waitdb
:dbready

echo [3/7] Installing packages (a few minutes the first time)...
call npm install >> "%LOG%" 2>&1
if errorlevel 1 (echo npm install failed. See setup-log.txt. & echo FAILED: npm install >> "%LOG%" & pause & exit /b 1)

echo [4/7] Building...
call npm run build -w packages/shared >> "%LOG%" 2>&1 || (echo Build failed. See setup-log.txt. & echo FAILED: build shared >> "%LOG%" & pause & exit /b 1)
call npm run build -w apps/api >> "%LOG%" 2>&1 || (echo Build failed. See setup-log.txt. & echo FAILED: build api >> "%LOG%" & pause & exit /b 1)

echo [5/7] Creating the database tables...
call npm run db:migrate >> "%LOG%" 2>&1 || (echo Database setup failed. See setup-log.txt. & echo FAILED: migrate >> "%LOG%" & pause & exit /b 1)

echo [6/7] Adding starting data and the first administrator...
call npm run db:seed >> "%LOG%" 2>&1 || (echo Seed failed. See setup-log.txt. & echo FAILED: seed >> "%LOG%" & pause & exit /b 1)

echo [7/7] Starting eSign (three windows will open: keep them open while testing)...
echo SETUP OK %DATE% %TIME% >> "%LOG%"
call "%~dp0start-test.bat"
