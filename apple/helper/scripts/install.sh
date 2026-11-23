#!/usr/bin/env bash
# Builds GBrain Helper.app from this checkout, signs it with this Mac's own
# signing identity, installs it to ~/Applications and registers its
# background agent.
#
#   apple/helper/scripts/install.sh            build, sign, install and register
#   apple/helper/scripts/install.sh --repair   re-sign the installed app with the same identity and register it again
#
# The first run makes a signing keychain holding one self-signed code-signing
# certificate, with its random password in a 0600 file beside the helper's
# config. Every later run signs with that same certificate, so the app's
# designated requirement stays the same and macOS keeps its Full Disk Access,
# Automation and keychain grants. The script never makes a second identity:
# when the app is installed but its signing keychain is gone, it stops and
# changes nothing. It shows no dialog. Any program already running as you can
# read that password (and see it in the security command's arguments while
# this runs) and sign itself as the helper; that is the cost of signing on the
# Mac with no Apple developer account.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
bundle_id="io.gbrain.apple-helper"
program="gbrain-apple-helper"
app="$HOME/Applications/GBrain Helper.app"
support="$HOME/Library/Application Support/GBrain Helper"
keychain="$HOME/Library/Keychains/gbrain-helper-signing.keychain-db"
password_file="$support/signing-keychain-password"
lock="$support/install.lock"
cert_name="GBrain Helper Local Signing"

say() { printf '%s\n' "$*"; }
die() {
  printf 'install.sh: %s\n' "$1" >&2
  exit "$2"
}
limited() { perl -e 'alarm shift; exec @ARGV or die "exec: $!\n"' 120 "$@"; }

repair=0
case "$#:${1:-}" in
  0:) ;;
  1:--repair) repair=1 ;;
  *) die "usage: install.sh [--repair]" 64 ;;
esac

[ "$(uname -s)" = Darwin ] || die "GBrain Helper runs only on macOS." 69

mkdir -p "$support"
chmod 700 "$support"
if ! mkdir "$lock" 2>/dev/null; then
  holder="$(cat "$lock/pid" 2>/dev/null || true)"
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    die "another install.sh (pid $holder) is running. Nothing was changed." 75
  fi
  rm -rf "$lock"
  mkdir "$lock"
fi
printf '%s\n' "$$" >"$lock/pid"

work="$(mktemp -d)"
saved_keychains=()
on_search_list=0
minting=0
cleanup() {
  if [ "$on_search_list" = 1 ] && [ "${#saved_keychains[@]}" -gt 0 ]; then
    security list-keychains -d user -s "${saved_keychains[@]}" || true
  fi
  if [ "$minting" = 1 ]; then
    security delete-keychain "$keychain" >/dev/null 2>&1 || rm -f "$keychain"
    rm -f "$password_file"
  fi
  rm -rf "$work" "$lock"
}
trap cleanup EXIT
trap 'exit 130' INT TERM HUP

if [ ! -e "$app" ] && [ -e "$app.previous" ]; then
  mv "$app.previous" "$app"
  say "Put back $app from an install that was interrupted."
fi
rm -rf "$app.new"

if [ -e "$keychain" ]; then
  [ -s "$password_file" ] || die "the signing keychain $keychain exists, but its password file $password_file is missing, so it can't be unlocked. Nothing was changed." 78
elif [ -e "$app" ]; then
  die "GBrain Helper is installed at $app, but its signing keychain $keychain is gone. A new identity would make macOS treat the helper as a different app and drop its Full Disk Access, Automation and keychain access, so nothing was changed. Put the keychain and its password file back, or remove the app on purpose first." 1
elif [ "$repair" = 1 ]; then
  die "there is no installed app at $app to repair. Run install.sh without --repair." 1
fi
if [ "$repair" = 0 ]; then
  xcode-select -p >/dev/null 2>&1 || die "building the helper needs the Xcode Command Line Tools. Install them with: xcode-select --install" 69
fi

if [ ! -e "$keychain" ]; then
  minting=1
  rm -f "$password_file"
  (umask 077 && /usr/bin/openssl rand -hex 24 >"$password_file")
  password="$(cat "$password_file")"
  security create-keychain -p "$password" "$keychain"
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
    -name "$cert_name" -out "$work/identity.p12" -passout "pass:$p12_unlock"
  security unlock-keychain -p "$password" "$keychain"
  security import "$work/identity.p12" -k "$keychain" -P "$p12_unlock" -T /usr/bin/codesign >/dev/null
  security set-key-partition-list -S apple-tool:,apple: -s -k "$password" "$keychain" >/dev/null
  rm -f "$work/key.pem" "$work/identity.p12"
  minting=0
  say "Made a signing identity in $keychain."
fi
password="$(cat "$password_file")"

security unlock-keychain -p "$password" "$keychain"
security set-keychain-settings "$keychain"
leaves="$(security find-identity -p codesigning "$keychain" | awk '$2 ~ /^[0-9A-F]{40}$/ {print $2}' | sort -u)"
count="$(printf '%s' "$leaves" | grep -c . || true)"
[ "$count" = 1 ] || die "expected one signing identity in $keychain and found $count. Nothing was changed. If GBrain Helper was never installed on this Mac, remove $keychain and $password_file, then run install.sh again." 1
leaf="$leaves"
requirement="identifier \"$bundle_id\" and certificate leaf = H\"$leaf\""

staged="$work/GBrain Helper.app"
if [ "$repair" = 1 ]; then
  ditto "$app" "$staged"
else
  if ! swift build -c release --package-path "$here" >"$work/build.log" 2>&1; then
    tail -n 30 "$work/build.log" >&2
    die "the Swift build failed (last lines above). Nothing was installed." 1
  fi
  bin_dir="$(swift build -c release --package-path "$here" --show-bin-path)"
  mkdir -p "$staged/Contents/MacOS" "$staged/Contents/Library/LaunchAgents"
  cp "$bin_dir/$program" "$staged/Contents/MacOS/$program"
  cp "$here/Bundle/Info.plist" "$staged/Contents/Info.plist"
  cp "$here/Bundle/$bundle_id.plist" "$staged/Contents/Library/LaunchAgents/$bundle_id.plist"
fi

while IFS= read -r entry; do
  entry="${entry#"${entry%%[![:space:]]*}"}"
  entry="${entry#\"}"
  entry="${entry%\"}"
  [ -n "$entry" ] && [ "$entry" != "$keychain" ] && saved_keychains+=("$entry")
done <<KEYCHAINS
$(security list-keychains -d user)
KEYCHAINS
on_search_list=1
security list-keychains -d user -s "$keychain" ${saved_keychains[@]+"${saved_keychains[@]}"}
security unlock-keychain -p "$password" "$keychain"
if ! limited codesign --force --keychain "$keychain" --sign "$leaf" --options runtime --timestamp=none \
  --entitlements "$here/Bundle/$program.entitlements" "-r=designated => $requirement" "$staged" 2>"$work/codesign.err"; then
  cat "$work/codesign.err" >&2
  die "codesign failed. Nothing was installed." 1
fi
designated() { codesign -d -r- "$1" 2>&1 | grep '^designated' || true; }
codesign --verify --strict "-R=$requirement" "$staged" 2>"$work/codesign.err" ||
  die "the signed app failed verification: $(tr '\n' ' ' <"$work/codesign.err") Nothing was installed." 1
new="$(designated "$staged")"
if [ -e "$app" ]; then
  old="$(designated "$app")"
  [ -z "$old" ] || [ "$old" = "$new" ] ||
    die "the new signature's designated requirement differs from the installed app's, so macOS would drop its grants. Nothing was changed. Installed: $old" 1
fi

mkdir -p "$HOME/Applications"
ditto "$staged" "$app.new"
codesign --verify --strict "-R=$requirement" "$app.new"
rm -rf "$app.previous"
[ ! -e "$app" ] || mv "$app" "$app.previous"
if ! mv "$app.new" "$app"; then
  [ ! -e "$app.previous" ] || mv "$app.previous" "$app"
  die "couldn't move the new app into place; the installed one is unchanged." 1
fi
rm -rf "$app.previous"
say "Installed $app, signed by certificate $leaf."

/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app"
registration="$("$app/Contents/MacOS/$program" register)"
say "$registration"
label="gui/$(id -u)/$bundle_id"
if launchctl print "$label" >/dev/null 2>&1; then
  launchctl kickstart -k "$label"
  say "Restarted $label."
fi
if ! "$app/Contents/MacOS/$program" validate-config >/dev/null 2>&1; then
  say "There is no valid helper config yet, so the helper restarts every 10 seconds until one exists. Write one with: \"$app/Contents/MacOS/$program\" init --port <port>"
elif [ "$registration" != "background agent registered and on" ]; then
  say "GBrain Helper starts once you turn it on in System Settings, so this install didn't wait for it to answer."
else
  port="$(/usr/bin/plutil -extract port raw "$support/config.json")"
  answered=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    if /usr/bin/curl -fsS -m 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
      answered=1
      break
    fi
    sleep 1
  done
  [ "$answered" = 1 ] || die "GBrain Helper is installed but isn't answering on 127.0.0.1:$port. Read ~/Library/Logs/$program.log and run: launchctl print $label" 1
  say "GBrain Helper is answering on 127.0.0.1:$port."
fi

cat <<EOF

What stays on this Mac: GBrain Helper runs in the background and shows in System Settings under
General > Login Items & Extensions, and in the Privacy lists you allow it in. To remove it:
  1. "$app/Contents/MacOS/$program" send-setup --off
  2. "$app/Contents/MacOS/$program" unregister
  3. rm -rf "$app"
  4. security delete-generic-password -s $bundle_id -a send-keys
     security delete-keychain "$keychain"
  5. rm -rf "$support" ~/Library/Logs/$program.log
  6. tccutil reset All $bundle_id   (clears its Full Disk Access, Automation and Contacts grants)
EOF
