@echo off
rem Copy this file to "elvar.cmd" (it is git-ignored), fill in the two values, then double-click it.
rem To start E.L.V.A.R. when you sign in to Windows: press Win+R, type  shell:startup , and put a SHORTCUT to elvar.cmd there.
cd /d "%~dp0"
set ELVAR_URL=https://YOUR-APP.vercel.app
set ELVAR_ACCESS_TOKEN=YOUR_TOKEN
if not exist node_modules ( call npm install )
start "" /min cmd /c "npm start"
