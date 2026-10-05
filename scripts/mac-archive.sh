#!/usr/bin/env bash
# Mac + Xcode only. This script cannot run on Linux and does not produce an IPA here.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "이 스크립트는 macOS + Xcode에서만 IPA를 만듭니다."
  echo "이 Linux 환경에서는 IPA가 생성되지 않았습니다."
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "xcodebuild가 없습니다. App Store에서 Xcode를 설치하세요."
  exit 1
fi

TEAM="${DEVELOPMENT_TEAM:-}"
if [[ -z "$TEAM" ]]; then
  echo "DEVELOPMENT_TEAM 환경변수를 넣으세요. 예:"
  echo "  DEVELOPMENT_TEAM=ABCDE12345 ./scripts/mac-archive.sh"
  echo "Xcode → Signing & Capabilities에서 Team ID를 확인할 수 있습니다."
  exit 1
fi

npm install
npx cap sync ios

DEST="$ROOT/dist"
ARCHIVE="$DEST/EyeMouse.xcarchive"
EXPORT="$DEST/export"
mkdir -p "$DEST"

cat > "$DEST/ExportOptions.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>development</string>
  <key>teamID</key>
  <string>${TEAM}</string>
  <key>compileBitcode</key>
  <false/>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>stripSwiftSymbols</key>
  <true/>
</dict>
</plist>
EOF

xcodebuild -project ios/App/App.xcodeproj -scheme App -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$TEAM" \
  CODE_SIGN_STYLE=Automatic \
  archive

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT" \
  -exportOptionsPlist "$DEST/ExportOptions.plist"

echo "IPA: $EXPORT"
ls -la "$EXPORT"
