#!/usr/bin/env bash
# Regenerates the home-screen icons in public/icons from public/unit-logo.jpg.
# Requires macOS `sips`. Run from anywhere: bash scripts/make-icons.sh
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/public/unit-logo.jpg"
out="$root/public/icons"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Source is 2048x2080 with no alpha: pad to a white square (never upscaled past 2080).
sips --padToHeightWidth 2080 2080 --padColor FFFFFF "$src" --out "$tmp/square.jpg" >/dev/null
# Maskable: logo ~80% of the canvas so it stays inside the safe zone.
sips --padToHeightWidth 2600 2600 --padColor FFFFFF "$src" --out "$tmp/mask.jpg" >/dev/null

mkdir -p "$out"
sips -s format png -z 512 512 "$tmp/square.jpg" --out "$tmp/icon-512.png" >/dev/null
sips -s format png -z 192 192 "$tmp/square.jpg" --out "$tmp/icon-192.png" >/dev/null
sips -s format png -z 180 180 "$tmp/square.jpg" --out "$tmp/apple-touch-icon-180.png" >/dev/null
sips -s format png -z 512 512 "$tmp/mask.jpg" --out "$tmp/icon-maskable-512.png" >/dev/null

cp "$tmp"/*.png "$out/"
echo "Wrote icons to $out"
