#!/bin/sh
# The iPhone app to TestFlight: a fresh native project, a signed Release archive,
# and an upload to App Store Connect. The archive signs automatically through the
# App Store Connect API key (no Xcode account needed; the .p8 never enters the
# repo); the export signs with the Apple Distribution identity and App Store profile.
#
#   scripts/testflight.sh            archive and upload build <ios.buildNumber in app.json>
#   UPLOAD=0 scripts/testflight.sh   archive and export an .ipa only
#   MIDNA_ALARMS=0 scripts/testflight.sh   a build without the alarms module (modules/midna-alarms),
#                                    should its Swift ever stop a build: the app runs without it
#   MIDNA_FOCUS=1 scripts/testflight.sh    a build with Screen Time (docs/screen-time.md): only once Apple has
#                                    granted the team Family Controls (Distribution); without it the module
#                                    (modules/midna-focus) stays out of the build
#
# Each upload needs a build number App Store Connect hasn't seen: raise
# expo.ios.buildNumber in app.json first.
set -eu
cd "$(dirname "$0")/.."

: "${DEVELOPER_DIR:=/Volumes/T7/Stockpile/Xcode.app/Contents/Developer}"
: "${TEAM_ID:=65UN46K6FA}"
: "${ASC_KEY_ID:?the App Store Connect API key id (Keys page), e.g. ASC_KEY_ID=ABC123DEFG}"
: "${ASC_ISSUER_ID:?the App Store Connect API issuer id}"
: "${ASC_KEY_PATH:=$HOME/.appstoreconnect/private_keys/AuthKey_$ASC_KEY_ID.p8}"
: "${UPLOAD:=1}"
# The App Store profile, made through the API for the Apple Distribution certificate (docs/mobile.md):
# the API key may not use Apple's cloud signing, so the export signs manually.
: "${PROFILE:=midna App Store}"
export DEVELOPER_DIR

[ -f "$ASC_KEY_PATH" ] || { echo "no API key at $ASC_KEY_PATH" >&2; exit 1; }
build=$(bun -e 'console.log(require("./app.json").expo.ios.buildNumber ?? "")')
[ -n "$build" ] || { echo "app.json has no expo.ios.buildNumber" >&2; exit 1; }

# Everything Xcode writes stays beside the project, not on the system disk, and outside ios/,
# which prebuild --clean deletes: the build cache survives from one build to the next.
out=build
auth="-allowProvisioningUpdates -authenticationKeyPath $ASC_KEY_PATH -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"

# xcodebuild's whole output goes to a log; on failure its end is shown and the script stops.
run() {
  log=$1
  shift
  if ! "$@" >"$log" 2>&1; then
    tail -n 40 "$log" >&2
    echo "failed: see $log" >&2
    exit 1
  fi
}

# The Apple Distribution identity lives in its own keychain, unlocked with a password kept in the
# login keychain, so codesign never stops to ask (see docs/mobile.md).
kc=$HOME/Library/Keychains/midna-signing.keychain-db
if [ -f "$kc" ]; then
  security unlock-keychain -p "$(security find-generic-password -s midna-signing-keychain -w)" "$kc"
fi

# The export signs with $PROFILE, which holds only the capabilities the app id had when it was made:
# an entitlement app.json asks for that the profile lacks fails the export after a long archive. So check
# first, and when it lacks one (or isn't installed), turn the capability on and make the profile again
# through the API (scripts/profile.ts), then check once more.
missing() {
  profiles="$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"
  granted=""
  for f in "$profiles"/*.mobileprovision; do
    [ -f "$f" ] || continue
    plist=$(security cms -D -i "$f" 2>/dev/null) || continue
    [ "$(printf '%s' "$plist" | plutil -extract Name raw -o - - 2>/dev/null)" = "$PROFILE" ] || continue
    granted=$(printf '%s' "$plist" | plutil -extract Entitlements json -o - - 2>/dev/null)
  done
  [ -n "$granted" ] || { echo "no installed profile"; return; }
  # With Screen Time, app.config.js asks for two more than app.json does.
  GRANTED="$granted" bun -e 'const g = JSON.parse(process.env.GRANTED); const focus = process.env.MIDNA_FOCUS === "1" ? ["com.apple.developer.family-controls", "com.apple.security.application-groups"] : []; console.log([...Object.keys(require("./app.json").expo.ios.entitlements ?? {}), ...focus].filter((k) => !(k in g)).join(" "))'
}
lacks=$(missing)
if [ -n "$lacks" ]; then
  echo "the profile \"$PROFILE\": $lacks; making it again through the API"
  ASC_KEY_ID=$ASC_KEY_ID ASC_ISSUER_ID=$ASC_ISSUER_ID ASC_KEY_PATH=$ASC_KEY_PATH PROFILE=$PROFILE bun scripts/profile.ts
  lacks=$(missing)
  [ -z "$lacks" ] || { echo "the profile \"$PROFILE\" still lacks $lacks: see docs/push.md" >&2; exit 1; }
fi

# A module left out of this build is hidden from autolinking, and put back whatever happens: the alarms when
# asked (MIDNA_ALARMS=0), Screen Time unless asked for (MIDNA_FOCUS=1; app.config.js adds its entitlement and extensions).
hidden=""
hide() {
  mv "modules/$1/expo-module.config.json" "modules/$1/expo-module.config.json.off"
  hidden="$hidden $1"
  echo "building without modules/$1"
}
unhide() {
  for m in $hidden; do mv "modules/$m/expo-module.config.json.off" "modules/$m/expo-module.config.json"; done
}
trap unhide EXIT
[ "${MIDNA_ALARMS:-1}" = 0 ] && hide midna-alarms
[ "${MIDNA_FOCUS:-0}" = 1 ] || hide midna-focus

CI=1 bunx expo prebuild -p ios --clean
mkdir -p "$out"
rm -rf "$out/midna.xcarchive" "$out/export"
echo "archiving build $build for team $TEAM_ID"
# shellcheck disable=SC2086
run "$out/archive.log" xcodebuild -workspace ios/midna.xcworkspace -scheme midna -configuration Release \
  -destination generic/platform=iOS -derivedDataPath "$out/DerivedData" \
  -archivePath "$out/midna.xcarchive" $auth \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  archive

dest=export
[ "$UPLOAD" = 1 ] && dest=upload
# Screen Time's three extensions each sign with an App Store profile of their own, made by hand once Apple
# has granted Family Controls (docs/screen-time.md).
extensions=""
if [ "${MIDNA_FOCUS:-0}" = 1 ]; then
  for e in focus-monitor focus-shield focus-shield-action; do
    extensions="$extensions
    <key>sh.midna.mobile.$e</key><string>midna $e App Store</string>"
  done
fi
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$dest</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>manual</string>
  <key>signingCertificate</key><string>Apple Distribution</string>
  <key>provisioningProfiles</key>
  <dict>
    <key>sh.midna.mobile</key><string>$PROFILE</string>$extensions
  </dict>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST
echo "$([ "$UPLOAD" = 1 ] && echo uploading || echo exporting) build $build"
# shellcheck disable=SC2086
run "$out/export.log" xcodebuild -exportArchive -archivePath "$out/midna.xcarchive" -exportPath "$out/export" \
  -exportOptionsPlist "$out/ExportOptions.plist" $auth
echo "build $build: $([ "$UPLOAD" = 1 ] && echo "uploaded to App Store Connect" || echo "exported to $out/export")"
