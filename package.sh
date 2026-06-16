#!/bin/bash

# -----------------------------------------------------------------------------
#                     Dynamic webOS Packaging Script
# -----------------------------------------------------------------------------

TARGET_APP_CONTEXT_DIRECTORY="."
BUILD_DESTINATION_FOLDER="./dist"
APP_MANIFEST_FILE="appinfo.json"

echo "========================================================================"
echo "           Advanced webOS Packaging & Verification System              "
echo "========================================================================"

# 1. Validate manifest presence
if [ ! -f "$APP_MANIFEST_FILE" ]; then
    echo "❌ Execution Aborted: App manifest file '$APP_MANIFEST_FILE' not found."
    echo "   Make sure you are running this from the root of your project directory."
    exit 1
fi

# 2. Check for CLI tooling availability
if ! command -v ares-package &> /dev/null; then
    echo "❌ Execution Aborted: The webOS CLI tool 'ares-package' was not found."
    echo "   Ensure your Docker image was built correctly with the CLI installed."
    exit 1
fi

# 3. Dynamically extract app ID and version from appinfo.json
# We use 'jq', a lightweight and flexible command-line JSON processor.
# If 'jq' is not found, this script will exit with a helpful message.
if ! command -v jq &> /dev/null; then
    echo "❌ Execution Aborted: 'jq' is required for dynamic versioning."
    echo "   Please ensure your Dockerfile includes 'apt-get install -y jq'."
    exit 1
fi

# Read ID and version from the manifest
APP_ID=$(jq -r '.id' "$APP_MANIFEST_FILE")
APP_VERSION=$(jq -r '.version' "$APP_MANIFEST_FILE")

# Verify that jq successfully extracted the values
if [ -z "$APP_ID" ] || [ "$APP_ID" == "null" ]; then
    echo "❌ Execution Aborted: Could not read app 'id' from '$APP_MANIFEST_FILE'."
    exit 1
fi

if [ -z "$APP_VERSION" ] || [ "$APP_VERSION" == "null" ]; then
    echo "❌ Execution Aborted: Could not read app 'version' from '$APP_MANIFEST_FILE'."
    exit 1
fi

echo "🔍 Found App: $APP_ID, Version: $APP_VERSION"

# Construct the expected output filename dynamically
EXPECTED_IPK_FILENAME="${APP_ID}_${APP_VERSION}_all.ipk"
EXPECTED_IPK_PATH="${BUILD_DESTINATION_FOLDER}/${EXPECTED_IPK_FILENAME}"

# 4. Reset distribution folder
echo "🧹 Cleaning build directory..."
rm -rf "$BUILD_DESTINATION_FOLDER"
mkdir -p "$BUILD_DESTINATION_FOLDER"

# 5. Execute the packaging command
echo "🔨 Executing secure packaging process (with minifier bypass)..."
ares-package "$TARGET_APP_CONTEXT_DIRECTORY" -o "$BUILD_DESTINATION_FOLDER" -n

# 6. Final validation check
if [ -f "$EXPECTED_IPK_PATH" ]; then
    echo "✅ SUCCESS: Build artifact deployed to:"
    echo "   -> $EXPECTED_IPK_PATH"
    echo ""
    echo "   IPK Details:"
    ls -lh "$EXPECTED_IPK_PATH"
    exit 0
else
    echo "❌ FAILURE: Packaging process did not produce the expected output."
    echo "   Expected file: $EXPECTED_IPK_FILENAME"
    echo "   Build folder contents:"
    ls -R "$BUILD_DESTINATION_FOLDER"
    exit 1
fi