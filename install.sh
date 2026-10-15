#!/usr/bin/env bash
# Compiles, packages, and installs the extension into this container's VS Code
# server, or into desktop VS Code where there is no server (e.g. on a Mac).
#
# Extensions installed into a devcontainer live under ~/.vscode-server, which is
# part of the container filesystem and not one of the mounted volumes, so a
# rebuild wipes them. VS Code then restores only the marketplace extensions
# listed in devcontainer.json — this one is local-only and isn't among them, so
# re-run this script after every rebuild.
set -euo pipefail

cd "$(dirname "$0")"

npm run compile
# The git read path is a Rust binary (core/), built for this machine and
# shipped inside the VSIX at bin/wt-core.
cargo build --release --manifest-path core/Cargo.toml
mkdir -p bin
cp core/target/release/wt-core bin/wt-core
npx --yes @vscode/vsce package --out release.vsix
vsix="$PWD/release.vsix"
echo "VSIX: $vsix"

# The bin directory is named after the VS Code commit, so it changes whenever
# VS Code updates. Take the most recent one.
cli=$(ls -dt "$HOME"/.vscode-server/bin/*/bin/code-server 2>/dev/null | head -1 || true)
# No server: desktop VS Code, through `code` on PATH or, on a Mac where the
# shell command was never installed, the CLI inside the app bundle.
if [ -z "$cli" ]; then
  for candidate in \
    "$(command -v code || true)" \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then
      cli=$candidate
      break
    fi
  done
fi
if [ -z "$cli" ]; then
  echo "No VS Code found: no server under ~/.vscode-server/bin and no desktop 'code' CLI" >&2
  exit 1
fi

"$cli" --install-extension "$vsix" --force
echo "Installed $vsix with $cli. Run 'Developer: Reload Window' in VS Code to load it."
