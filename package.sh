#!/bin/bash
# Build dist/dmdb-<version>.zip from extension/ ONLY, after auditing it for personal data.
# Refuses to build if anything suspicious is found.
#
# Optional local-only inputs (never part of this repo):
#   ../.audit-patterns   personal strings to look for, one per line
#   ../tests/*.test.js   unit tests, run before packaging if present
set -uo pipefail
cd "$(dirname "$0")"
VER=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
PATTERNS=../.audit-patterns
TMP=$(mktemp); trap 'rm -f "$TMP"' EXIT
fail=0
check() {   # check <regex> <description>   (case-insensitive, over extension/)
  if grep -rInEi "$1" extension > "$TMP" 2>/dev/null; then echo "AUDIT FAIL: $2"; cut -c1-160 "$TMP"; fail=1; fi
}

if ls ../tests/*.test.js >/dev/null 2>&1; then
  node --test ../tests/*.test.js > "$TMP" 2>&1 || { echo "tests failed"; tail -20 "$TMP"; exit 1; }
fi
check 'sessionid|csrftoken|fb_dtsg|ds_user_id|datr=|lsd=|@[a-z0-9-]+\.(com|net|org|io)\b' 'credentials or e-mail addresses'
check '/home/|/Users/|C:\\Users' 'absolute user paths'
check 'mid\.\$[A-Za-z0-9]{10,}' 'real message ids'
# long numeric ids, other than Instagram's public stored-query id
if grep -rInE '[0-9]{12,}' extension | grep -v '29028969043363744' > "$TMP"; then echo "AUDIT FAIL: long numeric ids"; cut -c1-160 "$TMP"; fail=1; fi
[ -f "$PATTERNS" ] && check "$(grep -v '^$' "$PATTERNS" | paste -sd'|')" "strings from $PATTERNS"
[ $fail = 0 ] || { echo "Not packaging."; exit 1; }

mkdir -p dist
OUT="dist/dmdb-$VER.zip"; rm -f "$OUT"
python3 - "$OUT" <<'PY'
import sys, zipfile, pathlib
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(pathlib.Path('extension').rglob('*')):
        if p.is_file(): z.write(p, p.relative_to('extension'))
PY
# audit the finished archive too (content of every file inside it)
if [ -f "$PATTERNS" ] && unzip -p "$OUT" | grep -aEi "$(grep -v '^$' "$PATTERNS" | paste -sd'|')" > /dev/null; then
  echo "AUDIT FAIL: personal string found inside $OUT"; rm -f "$OUT"; exit 1
fi
echo "OK: $OUT ($(du -h "$OUT" | cut -f1)), $(unzip -Z1 "$OUT" | wc -l) files:"; unzip -Z1 "$OUT" | sed 's/^/  /'
