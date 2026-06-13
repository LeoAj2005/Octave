#!/bin/bash
# Dedicated Security Bundling Matrix for ArchiveTune TV Wrapper Destination File Output
TARGET_APP_CONTEXT_DIRECTORY="."
BUILD_DESTINATION_FOLDER="./dist"
APP_MANIFEST_FILE="appinfo.json"

echo "========================================================================"
echo "          ArchiveTune webOS Target Packaging Verification Node          "
echo "========================================================================"

# 1. Validate manifest presence
if [ ! -f "$APP_MANIFEST_FILE" ]; then
    echo "[-] Execution Aborted: Path file context metadata manifest [appinfo.json] missing."
    exit 1
fi

# 2. Check for CLI tooling availability
if ! command -v ares-package &> /dev/null; then
    echo "[-] Execution Aborted: LG webOS SDK tools ('ares-package') missing in shell environment paths."
    exit 1
fi

# 3. Reset distribution folder
rm -rf "$BUILD_DESTINATION_FOLDER"
mkdir -p "$BUILD_DESTINATION_FOLDER"

echo "[+] Executing secure validation packaging layout maps..."
# Added -n to bypass the broken, legacy minifier tool on modern JS code blocks
ares-package . -o "$BUILD_DESTINATION_FOLDER" -n

# 4. Failsafe check: Handle the rimraf crash gracefully. If the IPK exists, the build is valid!
if [ -f "$BUILD_DESTINATION_FOLDER/moe.rukamori.archivetune.tv_1.0.0_all.ipk" ]; then
    echo "[+] SUCCESS: WebOS binary deployed inside $BUILD_DESTINATION_FOLDER directory context."
    exit 0
else
    echo "[-] Packaging process failed: IPK bundle was not found."
    exit 1
fi