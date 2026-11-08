@echo off
rem Checks the ruliba.com records that decide whether eSign emails land in the inbox or in spam.
rem Double-click it. Results are shown and saved to email-dns-check.txt next to this file.
cd /d "%~dp0"
set OUT=%~dp0email-dns-check.txt
set D=ruliba.com
echo eSign email DNS check for %D% - %DATE% %TIME% > "%OUT%"
echo. >> "%OUT%"
echo ==== MX (who receives mail for %D%) >> "%OUT%"
nslookup -type=MX %D% 8.8.8.8 >> "%OUT%" 2>&1
echo ==== SPF (TXT on %D%, look for v=spf1) >> "%OUT%"
nslookup -type=TXT %D% 8.8.8.8 >> "%OUT%" 2>&1
echo ==== DMARC (TXT on _dmarc.%D%, look for v=DMARC1) >> "%OUT%"
nslookup -type=TXT _dmarc.%D% 8.8.8.8 >> "%OUT%" 2>&1
echo ==== DKIM selector1 (CNAME to ...onmicrosoft.com) >> "%OUT%"
nslookup -type=CNAME selector1._domainkey.%D% 8.8.8.8 >> "%OUT%" 2>&1
echo ==== DKIM selector2 >> "%OUT%"
nslookup -type=CNAME selector2._domainkey.%D% 8.8.8.8 >> "%OUT%" 2>&1
type "%OUT%"
echo.
echo Saved to email-dns-check.txt
pause
