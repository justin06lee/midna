#!/bin/sh
# The iPhone app to TestFlight: a fresh native project, a signed Release archive,
# and an upload to App Store Connect. Signing is automatic, with the App Store
# Connect API key: no Xcode account needed, and the .p8 never enters the repo.
#
#   scripts/testflight.sh            archive and upload build <ios.buildNumber in app.json>
#   UPLOAD=0 scripts/testflight.sh   archive and export an .ipa only
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
export DEVELOPER_DIR

[ -f "$ASC_KEY_PATH" ] || { echo "no API key at $ASC_KEY_PATH" >&2; exit 1; }
build=$(bun -e 'console.log(require("./app.json").expo.ios.buildNumber ?? "")')
[ -n "$build" ] || { echo "app.json has no expo.ios.buildNumber" >&2; exit 1; }

# Everything Xcode writes stays beside the project (ios/ is generated and ignored), not on the system disk.
out=ios/build
auth="-allowProvisioningUpdates -authenticationKeyPath $ASC_KEY_PATH -authenticationKeyID $ASC_KEY_ID -authenticationKeyIssuerID $ASC_ISSUER_ID"

CI=1 bunx expo prebuild -p ios --clean
mkdir -p "$out"
echo "archiving build $build for team $TEAM_ID"
# shellcheck disable=SC2086
xcodebuild -workspace ios/midna.xcworkspace -scheme midna -configuration Release \
  -destination generic/platform=iOS -derivedDataPath "$out/DerivedData" \
  -archivePath "$out/midna.xcarchive" $auth \
  DEVELOPMENT_TEAM="$TEAM_ID" CODE_SIGN_STYLE=Automatic \
  archive | tail -n 40

dest=export
[ "$UPLOAD" = 1 ] && dest=upload
cat > "$out/ExportOptions.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>$dest</string>
  <key>teamID</key><string>$TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key><false/>
  <key>uploadSymbols</key><true/>
  <key>testFlightInternalTestingOnly</key><true/>
</dict>
</plist>
PLIST
# shellcheck disable=SC2086
xcodebuild -exportArchive -archivePath "$out/midna.xcarchive" -exportPath "$out/export" \
  -exportOptionsPlist "$out/ExportOptions.plist" $auth | tail -n 20
echo "build $build: $([ "$UPLOAD" = 1 ] && echo "uploaded to App Store Connect" || echo "exported to $out/export")"
