#!/usr/bin/env bash
# Render Build Script for Native Node.js Environment
set -o errexit

echo "Installing npm dependencies..."
npm install

echo "Building static dashboard..."
npm run build

echo "Installing Chromium for Puppeteer..."
# Cache browser in Render's build cache directory
export PUPPETEER_CACHE_DIR=/opt/render/project/src/.cache/puppeteer
npx puppeteer browsers install chrome || true

echo "Build complete!"
