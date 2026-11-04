#!/bin/bash
# Dobbeltklik for at starte timen.
cd "$(dirname "$0")"
clear
echo "Starting LærbarXR..."
echo

if ! command -v python3 >/dev/null 2>&1; then
    echo "This Mac doesn't have Python 3 set up yet."
    echo "macOS should offer to install it now — click Install, wait a"
    echo "couple of minutes, then double-click this file again."
    echo
    python3 --version
    read -p "Press Return to close this window."
    exit 1
fi

python3 relay.py
echo
read -p "Press Return to close this window."
