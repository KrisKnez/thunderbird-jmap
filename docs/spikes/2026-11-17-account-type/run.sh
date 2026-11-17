#!/usr/bin/env bash
# Throwaway spike runner: ./run.sh <thunderbird-binary> <label>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TB="$1"
LABEL="$2"
OUT="$HERE/out/$LABEL"
PROFILE="$OUT/profile"
ID="jmap-spike@example.invalid"

rm -rf "$OUT"
mkdir -p "$PROFILE/extensions"

# Package the add-on.
(cd "$HERE/addon" && rm -f "$OUT/spike.xpi" && zip -qr "$OUT/spike.xpi" .)
cp "$OUT/spike.xpi" "$PROFILE/extensions/$ID.xpi"

cat > "$PROFILE/user.js" <<'EOF'
user_pref("xpinstall.signatures.required", false);
user_pref("extensions.autoDisableScopes", 0);
user_pref("extensions.enabledScopes", 15);
user_pref("extensions.startupScanScopes", 15);
user_pref("extensions.experiments.enabled", true);
user_pref("browser.dom.window.dump.enabled", true);
user_pref("devtools.console.stdout.chrome", true);
user_pref("mail.provider.suppress_dialog_on_startup", true);
user_pref("mail.shell.checkDefaultClient", false);
user_pref("mail.rights.override", true);
user_pref("datareporting.policy.dataSubmissionEnabled", false);
user_pref("app.update.auto", false);
user_pref("app.update.enabled", false);
user_pref("jmapspike.autoquit", true);
EOF

for run in 1 2 3; do
  echo "===== $LABEL run $run"
  set +e
  MOZ_HEADLESS=1 MOZ_HEADLESS_WIDTH=1280 MOZ_HEADLESS_HEIGHT=800 \
    timeout 120 "$TB" --headless -no-remote -profile "$PROFILE" \
    >"$OUT/run-$run.log" 2>&1
  echo "exit: $?"
  set -e
  grep -a "jmap-spike" "$OUT/run-$run.log" || true
  if [ -f "$PROFILE/jmap-spike-error.json" ]; then
    echo "ERROR REPORT:"; cat "$PROFILE/jmap-spike-error.json"; exit 1
  fi
done
echo "Reports in $PROFILE"
