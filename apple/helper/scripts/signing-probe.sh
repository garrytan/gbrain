#!/usr/bin/env bash
# Headless signing probe for GBrain Helper.app, run by .github/workflows/apple-helper.yml.
#
# The question: on a Mac with no Apple developer account and nobody at the
# screen, can a key and self-signed certificate made on that Mac sign the app
# (hardened runtime, designated requirement pinned to the bundle id and the
# certificate) with no dialog, or does the certificate first need to be trusted
# for code signing ("Always Trust"), which asks for a password once?
#
# Attempts, in order, stopping at the first that signs and verifies:
#   A. untrusted certificate, keychain named only with --keychain
#   B. untrusted certificate, keychain also on the user's search list
#   C. certificate trusted for code signing (admin trust settings via sudo)
# Every codesign call runs under a 120-second alarm, so a dialog waiting for a
# person fails the attempt instead of hanging the job. The answer goes to the
# job summary. Exits non-zero only when no attempt worked.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
keychain="$work/gbrain-helper-signing.keychain-db"
app="$work/GBrain Helper.app"
bundle_id="io.gbrain.apple-helper"
program="gbrain-apple-helper"
report="$work/report.md"
saved_keychains=()
trusted=0
outcome=""

cleanup() {
  if [ "${#saved_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${saved_keychains[@]}" || true
  fi
  if [ "$trusted" = 1 ]; then
    sudo security remove-trusted-cert -d "$work/cert.pem" >/dev/null 2>&1 || true
  fi
  security delete-keychain "$keychain" >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

limited() {
  perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' 120 "$@"
}

note() {
  printf '%s\n' "$*" | tee -a "$report"
}

macos="$(sw_vers -productVersion) ($(sw_vers -buildVersion)), $(uname -m)"
note "## GBrain Helper signing probe"
note ""
note "- macOS $macos"
note "- $(swift --version 2>&1 | head -n 1)"

swift build -c release --package-path "$here"
bin_dir="$(swift build -c release --package-path "$here" --show-bin-path)"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Library/LaunchAgents"
cp "$bin_dir/$program" "$app/Contents/MacOS/$program"
cp "$here/Bundle/Info.plist" "$app/Contents/Info.plist"
cp "$here/Bundle/$bundle_id.plist" "$app/Contents/Library/LaunchAgents/$bundle_id.plist"

unlock="$(/usr/bin/openssl rand -hex 24)"
security create-keychain -p "$unlock" "$keychain"
security set-keychain-settings -lut 3600 "$keychain"
security unlock-keychain -p "$unlock" "$keychain"

cat >"$work/cert.cnf" <<'EOF'
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = GBrain Helper Local Signing
[ext]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF
/usr/bin/openssl req -new -x509 -newkey rsa:2048 -nodes -days 3650 -config "$work/cert.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" 2>/dev/null
legacy=""
case "$(/usr/bin/openssl version)" in
  OpenSSL\ 3*) legacy="-legacy" ;;
esac
p12_unlock="$(/usr/bin/openssl rand -hex 16)"
# shellcheck disable=SC2086
/usr/bin/openssl pkcs12 -export $legacy -inkey "$work/key.pem" -in "$work/cert.pem" \
  -name "GBrain Helper Local Signing" -out "$work/identity.p12" -passout "pass:$p12_unlock"
security import "$work/identity.p12" -k "$keychain" -P "$p12_unlock" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "$unlock" "$keychain" >/dev/null
rm -f "$work/key.pem" "$work/identity.p12"

leaf="$(/usr/bin/openssl x509 -in "$work/cert.pem" -outform der | shasum -a 1 | awk '{print toupper($1)}')"
requirement="identifier \"$bundle_id\" and certificate leaf = H\"$leaf\""
listed="$(security find-identity -p codesigning "$keychain" | grep -c "$leaf" || true)"
valid="$(security find-identity -v -p codesigning "$keychain" | grep -c "$leaf" || true)"
note "- Certificate: self-signed, code-signing key use, 10 years, own keychain; listed as a signing identity: $listed, listed as valid: $valid"

sign() {
  limited codesign --force --keychain "$keychain" --sign "$leaf" --options runtime --timestamp=none \
    --entitlements "$here/Bundle/$program.entitlements" "-r=designated => $requirement" "$app" 2>"$work/codesign.err"
}

verify() {
  codesign --verify --strict --verbose=2 "$app" 2>>"$work/codesign.err" &&
    codesign --verify --strict "-R=$requirement" "$app" 2>>"$work/codesign.err" &&
    codesign -d -r- "$app" 2>&1 | grep -qiF "certificate leaf = H\"$leaf\""
}

attempt() {
  if sign && verify; then
    outcome="$1"
    note "- $1: signed and verified"
    return 0
  fi
  note "- $1: failed: $(tr '\n' ' ' <"$work/codesign.err" | cut -c1-300)"
  return 1
}

if ! attempt "A (untrusted certificate, keychain named with --keychain)"; then
  while IFS= read -r entry; do
    entry="${entry#"${entry%%[![:space:]]*}"}"
    entry="${entry#\"}"
    entry="${entry%\"}"
    [ -n "$entry" ] && saved_keychains+=("$entry")
  done <<KEYCHAINS
$(security list-keychains -d user)
KEYCHAINS
  security list-keychains -d user -s "$keychain" ${saved_keychains[@]+"${saved_keychains[@]}"}
  if ! attempt "B (untrusted certificate, keychain on the search list)"; then
    if limited sudo security add-trusted-cert -d -r trustRoot -p codeSign -k /Library/Keychains/System.keychain "$work/cert.pem"; then
      trusted=1
      attempt "C (certificate trusted for code signing)" || true
    else
      note "- C: could not mark the certificate trusted without a dialog"
    fi
  fi
fi

if [ -n "$outcome" ]; then
  note "- Signed program runs: $("$app/Contents/MacOS/$program" --version 2>&1 || echo failed)"
  before="$(codesign -d -r- "$app" 2>&1 | grep designated || true)"
  cp "$bin_dir/$program" "$app/Contents/MacOS/$program"
  if sign && verify && [ "$before" = "$(codesign -d -r- "$app" 2>&1 | grep designated || true)" ]; then
    note "- Re-signing a fresh copy keeps the same designated requirement, so grants that match it carry over"
  else
    note "- Re-signing a fresh copy changed or broke the designated requirement"
  fi
fi

note ""
case "$outcome" in
  A*|B*) note "**Answer:** an untrusted self-signed certificate signs the helper with no dialog on macOS $macos. No Always Trust step is needed." ;;
  C*) note "**Answer:** on macOS $macos signing needed the certificate trusted for code signing first, so setup needs the one-time Always Trust step." ;;
  *) note "**Answer:** no attempt signed the helper headlessly on macOS $macos, so setup falls back to ad hoc signing." ;;
esac
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  cat "$report" >>"$GITHUB_STEP_SUMMARY"
fi
[ -n "$outcome" ]
