@echo off
REM ---- Karaoke song downloader (Windows) ----
REM Double-click to search interactively, OR run from a terminal with args:
REM     fetch_songs.bat "Adele Hello karaoke"
cd /d "%~dp0"

if not exist ".venv\" (
    echo Creating virtual environment...
    python -m venv .venv
)
call .venv\Scripts\activate.bat
echo Checking downloader (yt-dlp)...
python -m pip install -q -U yt-dlp

if not "%~1"=="" (
    python fetch_songs.py %*
    echo.
    echo Done. Re-run start_agent.bat to sync new songs to the cloud.
    pause
    goto :eof
)

echo.
echo Type a song to search (e.g.  Adele Hello karaoke ) or paste a YouTube URL.
echo Press Enter on an empty line to finish.
echo.
:loop
set "QUERY="
set /p QUERY="Search> "
if "%QUERY%"=="" goto done
python fetch_songs.py "%QUERY%"
goto loop
:done
echo.
echo Done. Re-run start_agent.bat to sync new songs to the cloud.
pause
