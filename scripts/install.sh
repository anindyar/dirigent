#!/bin/bash
set -e

# Dirigent Installer
# Usage: curl -fsSL https://get.dirigent.dev | bash

REPO="anindyar/dirigent"
INSTALL_DIR="${DIRIGENT_INSTALL_DIR:-$HOME/.dirigent}"
BIN_DIR="${DIRIGENT_BIN_DIR:-$HOME/.local/bin}"

echo ""
echo "  🎭 Dirigent Installer"
echo "  AI Agent Orchestration Platform"
echo ""

# Detect OS and arch
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  x86_64) ARCH="x64" ;;
  aarch64 | arm64) ARCH="arm64" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

case "$OS" in
  linux | darwin) ;;
  *) echo "Unsupported OS: $OS"; exit 1 ;;
esac

echo "  OS: $OS"
echo "  Arch: $ARCH"
echo ""

# Check for Node.js
if ! command -v node &> /dev/null; then
  echo "❌ Node.js is required but not installed."
  echo ""
  echo "Install Node.js 20+ from: https://nodejs.org"
  echo "Or use nvm: curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash"
  exit 1
fi

NODE_VERSION=$(node -v | cut -d'.' -f1 | tr -d 'v')
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "❌ Node.js 20+ required (found: $(node -v))"
  exit 1
fi

echo "  Node.js: $(node -v) ✓"

# Install via npm
echo ""
echo "Installing Dirigent..."
npm install -g dirigent@latest

echo ""
echo "✅ Dirigent installed successfully!"
echo ""
echo "Getting started:"
echo ""
echo "  1. Initialize:  dirigent init"
echo "  2. Start:       dirigent up"
echo "  3. Dashboard:   http://localhost:3000"
echo ""
echo "Need help? https://github.com/$REPO"
echo ""
