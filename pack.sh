#!/bin/bash

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
BUILD_DIR="$SCRIPT_DIR/build"

if [ ! -d "$SRC_DIR" ]; then
    echo -e "\033[31mError: src directory not found at $SRC_DIR\033[0m"
    exit 1
fi

if [ ! -d "$BUILD_DIR" ]; then
    mkdir -p "$BUILD_DIR"
    echo -e "\033[32mCreated build directory\033[0m"
fi

TEMP_FIREFOX="$BUILD_DIR/temp_firefox"
TEMP_CHROME="$BUILD_DIR/temp_chrome"

rm -rf "$TEMP_FIREFOX" "$TEMP_CHROME"
mkdir -p "$TEMP_FIREFOX" "$TEMP_CHROME"

echo -e "\033[33mCopying files...\033[0m"

cd "$SRC_DIR"
find . -type f ! -name "firefox.manifest.json" ! -name "chrome.manifest.json" | while read -r file; do
    rel_path="${file#./}"

    mkdir -p "$TEMP_FIREFOX/$(dirname "$rel_path")"
    mkdir -p "$TEMP_CHROME/$(dirname "$rel_path")"

    cp "$file" "$TEMP_FIREFOX/$rel_path"
    cp "$file" "$TEMP_CHROME/$rel_path"
done

echo -e "\033[33mProcessing manifests...\033[0m"
cp "$SRC_DIR/firefox.manifest.json" "$TEMP_FIREFOX/manifest.json"
cp "$SRC_DIR/chrome.manifest.json" "$TEMP_CHROME/manifest.json"

echo -e "\033[33mPackaging Firefox version...\033[0m"
XPI_PATH="$BUILD_DIR/event_peeper_firefox.xpi"
rm -f "$XPI_PATH"

cd "$TEMP_FIREFOX"
zip -r "$XPI_PATH" . -q
cd "$SCRIPT_DIR"

echo -e "\033[32mCreated: $XPI_PATH\033[0m"

echo -e "\033[33mPackaging Chrome version...\033[0m"
ZIP_PATH="$BUILD_DIR/event_peeper_chrome.zip"
rm -f "$ZIP_PATH"

cd "$TEMP_CHROME"
zip -r "$ZIP_PATH" . -q
cd "$SCRIPT_DIR"

echo -e "\033[32mCreated: $ZIP_PATH\033[0m"

echo -e "\033[33mCleaning up...\033[0m"
rm -rf "$TEMP_FIREFOX" "$TEMP_CHROME"

echo ""
echo -e "\033[32mPackaging complete!\033[0m"
echo -e "\033[36mFirefox package: $XPI_PATH\033[0m"
echo -e "\033[36mChrome package: $ZIP_PATH\033[0m"