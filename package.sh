#!/bin/bash
# Build release zips from extension/ ONLY, after auditing it for personal data.
#   ./package.sh [chrome|firefox|all]      (default: all)
#   -> dist/dmdb-chrome-<version>.zip, dist/dmdb-firefox-<version>.zip
# Refuses to build if anything suspicious is found.
#
# The Chromium manifest in extension/ is the source of truth. The Firefox build is generated from it:
# no `key`, background.scripts instead of a service worker, and browser_specific_settings.gecko.
#
# Optional local-only inputs (never part of this repo):
#   ../.audit-patterns   personal strings to look for, one per line
#   ../tests/*.test.js   unit tests, run before packaging if present
set -uo pipefail
cd "$(dirname "$0")"
TARGET=${1:-all}
case "$TARGET" in chrome|firefox|all) ;; *) echo "usage: $0 [chrome|firefox|all]"; exit 2;; esac
VER=$(python3 -c "import json;print(json.load(open('extension/manifest.json'))['version'])")
PATTERNS=../.audit-patterns
TMP=$(mktemp); STAGES=()
trap 'rm -f "$TMP"; [ ${#STAGES[@]} -gt 0 ] && rm -rf "${STAGES[@]}"' EXIT
fail=0
check() {   # check <regex> <description> [dir]   (case-insensitive)
  if grep -rInEi "$1" "${3:-extension}" > "$TMP" 2>/dev/null; then echo "AUDIT FAIL: $2"; cut -c1-160 "$TMP"; fail=1; fi
}

if ls ../tests/*.test.js >/dev/null 2>&1; then
  node --test ../tests/*.test.js > "$TMP" 2>&1 || { echo "tests failed"; tail -20 "$TMP"; exit 1; }
fi
audit_dir() {
  local d=$1
  check 'sessionid|csrftoken|fb_dtsg|ds_user_id|datr=|lsd=|@[a-z0-9-]+\.(com|net|org|io)\b' 'credentials or e-mail addresses' "$d"
  check '/home/|/Users/|C:\\Users' 'absolute user paths' "$d"
  check 'mid\.\$[A-Za-z0-9]{10,}' 'real message ids' "$d"
  # long numeric ids, other than Instagram's public stored-query id
  if grep -rInE '[0-9]{12,}' "$d" | grep -v '29028969043363744' > "$TMP"; then echo "AUDIT FAIL: long numeric ids"; cut -c1-160 "$TMP"; fail=1; fi
  [ -f "$PATTERNS" ] && check "$(grep -v '^$' "$PATTERNS" | paste -sd'|')" "strings from $PATTERNS" "$d"
}

build() {   # build <chrome|firefox>
  local t=$1 stage out
  stage=$(mktemp -d); STAGES+=("$stage")
  cp -r extension/. "$stage"/
  if [ "$t" = firefox ]; then
    python3 - "$stage/manifest.json" <<'PY'
import json, sys
p = sys.argv[1]; m = json.load(open(p))
m.pop('key', None)                                   # Chromium-only
m['background'] = {'scripts': ['compat.js', 'parse.js', 'db.js', 'background.js']}   # no service workers in Firefox
m['browser_specific_settings'] = {'gecko': {
    'id': 'dmdb@dmdb.example',                       # reserved TLD: cannot collide with a real address
    'strict_min_version': '140.0',                   # CSS Custom Highlight API; content-script world MAIN needs 128+
    'data_collection_permissions': {'required': ['none']},   # nothing is collected or transmitted
}, 'gecko_android': {'strict_min_version': '142.0'}}    # first Android release that knows data_collection_permissions
json.dump(m, open(p, 'w'), indent=2); open(p, 'a').write('\n')
PY
  fi
  audit_dir "$stage"
  [ $fail = 0 ] || { echo "Not packaging $t."; return 1; }
  mkdir -p dist; out="dist/dmdb-$t-$VER.zip"; rm -f "$out"
  python3 - "$stage" "$out" <<'PY'
import sys, zipfile, pathlib
src, out = pathlib.Path(sys.argv[1]), sys.argv[2]
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
    for p in sorted(src.rglob('*')):
        if p.is_file(): z.write(p, p.relative_to(src))
PY
  if [ -f "$PATTERNS" ] && unzip -p "$out" | grep -aEi "$(grep -v '^$' "$PATTERNS" | paste -sd'|')" > /dev/null; then
    echo "AUDIT FAIL: personal string found inside $out"; rm -f "$out"; return 1
  fi
  echo "OK: $out ($(du -h "$out" | cut -f1), $(unzip -Z1 "$out" | wc -l) files)"
}

audit_dir extension
[ $fail = 0 ] || { echo "Not packaging."; exit 1; }
rc=0
[ "$TARGET" = firefox ] || build chrome || rc=1
[ "$TARGET" = chrome ]  || build firefox || rc=1
exit $rc
