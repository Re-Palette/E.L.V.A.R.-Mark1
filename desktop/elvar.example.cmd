@echo off
rem Copy this file to "elvar.cmd" (it is git-ignored), fill in the URL, then double-click it (sign in inside the app the first time).
rem To start E.L.V.A.R. when you sign in to Windows: press Win+R, type  shell:startup , and put a SHORTCUT to elvar.cmd there.
cd /d "%~dp0"
set ELVAR_URL=https://YOUR-APP.vercel.app
rem Optional: a device token, so this PC never shows the sign-in screen (keep this file private)
rem set ELVAR_DEVICE_TOKEN=elv1....
if not exist node_modules ( call npm install )
start "" /min cmd /c "npm start"
