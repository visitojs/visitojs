#!/bin/bash
# Inside an old Chrome image: serves the page on loopback, opens it under a virtual display, prints the page's result line.
/tools/busybox httpd -p 127.0.0.1:8099 -h /srv
echo "VERSION $(google-chrome --version 2>/dev/null)"
LOG=/tmp/chrome.log
xvfb-run -a google-chrome --no-sandbox --disable-gpu --no-first-run --no-default-browser-check \
  --user-data-dir=/tmp/profile --enable-logging=stderr --v=0 http://127.0.0.1:8099/page.html >"$LOG" 2>&1 &
for _ in $(seq 1 80); do
  grep -q 'VISITO_RESULT' "$LOG" && break
  sleep 0.5
done
grep -m1 -o 'VISITO_RESULT [^ ]* END' "$LOG" || echo "NO_RESULT $(tail -c 300 "$LOG" | tr '\n' ' ')"
pkill -9 chrome
pkill -9 Xvfb
exit 0
