#!/usr/bin/env bash
# Run the spike on both Thunderbird builds and summarize the open-message results.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DL="$HERE/../tb-dl"
for pair in "160.0:tb160" "153.7.0esr:esr153"; do
  ver="${pair%%:*}"; label="${pair##*:}"
  "$HERE/run.sh" "$DL/$ver/thunderbird/thunderbird" "$label" 2>&1 | grep -a -E "=====|exit:|ERROR|failed" | cut -c1-200
  echo "-- console errors ($label):"
  grep -a -h "console.error\|JavaScript error" "$HERE/out/$label"/run-*.log | grep -v SharedDataMap | cut -c1-260 | sort | uniq -c
  for n in 1 2 3; do
    f="$HERE/out/$label/profile/jmap-spike-run-$n.json"
    [ -f "$f" ] || { echo "run $n: no report"; continue; }
    python3 -I - "$f" "$n" <<'EOF'
import json, sys
r = json.load(open(sys.argv[1])); n = sys.argv[2]; fp = r["folderPane"]
print(f"TB {r['thunderbird']} run {n}: accounts={[e['name'] for e in r['live']]} bodies={[m['bodyReadBack'] for e in r['live'] for m in e['messages']]}")
for k in ("messageURI", "messageOpened", "aboutMessageURI", "headerSubject", "renderedBodySnippet", "streamTest", "openError", "messageServiceError"):
    if k in fp: print(f"    {k}: {fp[k]}")
print("    service calls:", r.get("messageServiceCalls"))
EOF
  done
done
