#!/bin/bash

# Check for correct number of arguments
if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <output_directory>"
  exit 1
fi

WEBPAGE_URL="https://onlyfans.com"
OUTPUT_DIR="./samples/obfuscated"
mkdir -p "$OUTPUT_DIR"

WEBPAGE_SOURCE=$(curl --silent --show-error -H "User-Agent: Mozilla/5.0" "$WEBPAGE_URL")

JS_URL=$(echo "$WEBPAGE_SOURCE" | grep -oP 'https:\/\/static2\.onlyfans\.com\/static\/prod\/[a-f0-9]\/202[567]\d{8}-[a-f0-9]{10}\/[a-f0-9]{4}\.js')
if [ -z "$JS_URL" ]; then
    echo "$WEBPAGE_SOURCE"
    echo "No matching JavaScript file found in the webpage source."
    exit 1
fi

TIMESTAMP=$(echo "$JS_URL" | grep -oP '202[567]\d{8}-[a-f0-9]{10}')
if [ -z "$TIMESTAMP" ]; then
    echo "Failed to extract timestamp from the JavaScript URL."
    exit 1
fi

OUTPUT_FILE="$OUTPUT_DIR/$TIMESTAMP.js"

curl --silent --show-error -H "User-Agent: Mozilla/5.0" -o "$OUTPUT_FILE" "$JS_URL"
if [ $? -ne 0 ]; then
    echo "Failed to download JavaScript file from $JS_URL."
    exit 1
fi

echo "$OUTPUT_FILE"
