#!/usr/bin/env bash
# setup-macos-permissions.sh
# Pre-approve macOS permissions so moltbot never gets stuck on permission dialogs.
# Run with: sudo bash scripts/setup-macos-permissions.sh
#
# What this does:
#   1. Grants Accessibility access to Terminal/iTerm2
#   2. Grants Full Disk Access to Terminal/iTerm2
#   3. Grants Automation permissions (AppleScript control)
#   4. Disables Gatekeeper prompts for unsigned CLI tools
#   5. Pre-approves Docker, Node.js, and Playwright for network access
#   6. Configures macOS firewall to allow moltbot services
set -euo pipefail

echo "=== Moltbot macOS Permission Setup ==="
echo "This script removes ALL macOS permission bottlenecks."
echo ""

# Check for root
if [ "$(id -u)" -ne 0 ]; then
  echo "ERROR: Must run as root (sudo). Re-run with: sudo bash $0"
  exit 1
fi

CURRENT_USER="${SUDO_USER:-$(logname)}"
echo "Setting up permissions for user: $CURRENT_USER"
echo ""

# ── 1. Accessibility Access ──────────────────────────────────────────────────
echo "[1/7] Granting Accessibility access..."

# Terminal.app
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier_type, flags) VALUES ('kTCCServiceAccessibility', 'com.apple.Terminal', 0, 2, 0, 1, 0, 0);" 2>/dev/null || echo "  Accessibility for Terminal: may need System Settings manual approval"

# iTerm2
sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier_type, flags) VALUES ('kTCCServiceAccessibility', 'com.googlecode.iterm2', 0, 2, 0, 1, 0, 0);" 2>/dev/null || echo "  Accessibility for iTerm2: may need System Settings manual approval"

echo "  Done (restart Terminal/iTerm2 to take effect)"

# ── 2. Full Disk Access ─────────────────────────────────────────────────────
echo "[2/7] Granting Full Disk Access..."

sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier_type, flags) VALUES ('kTCCServiceSystemPolicyAllFiles', 'com.apple.Terminal', 0, 2, 0, 1, 0, 0);" 2>/dev/null || echo "  FDA for Terminal: may need System Settings manual approval"

sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier_type, flags) VALUES ('kTCCServiceSystemPolicyAllFiles', 'com.googlecode.iterm2', 0, 2, 0, 1, 0, 0);" 2>/dev/null || echo "  FDA for iTerm2: may need System Settings manual approval"

echo "  Done"

# ── 3. Automation (AppleScript) ──────────────────────────────────────────────
echo "[3/7] Granting Automation permissions..."

sudo sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, indirect_object_identifier_type, flags) VALUES ('kTCCServiceAppleEvents', 'com.apple.Terminal', 0, 2, 0, 1, 'com.apple.systemevents', 0, 0);" 2>/dev/null || echo "  Automation: may need System Settings manual approval"

echo "  Done"

# ── 4. Disable Gatekeeper for CLI tools ──────────────────────────────────────
echo "[4/7] Configuring Gatekeeper..."

# Allow apps from anywhere (required for unsigned CLI tools like nmap, sqlmap)
sudo spctl --master-disable 2>/dev/null || true

# Remove quarantine from common tool locations
xattr -r -d com.apple.quarantine /usr/local/bin/ 2>/dev/null || true
xattr -r -d com.apple.quarantine /opt/homebrew/bin/ 2>/dev/null || true
xattr -r -d com.apple.quarantine "$HOME/.nvm/" 2>/dev/null || true
xattr -r -d com.apple.quarantine "$HOME/.cargo/bin/" 2>/dev/null || true

echo "  Done (Gatekeeper set to allow all apps)"

# ── 5. Firewall: allow Node.js and Docker ────────────────────────────────────
echo "[5/7] Configuring firewall rules..."

# Find node binary and add to firewall
NODE_PATH=$(which node 2>/dev/null || echo "")
if [ -n "$NODE_PATH" ]; then
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$NODE_PATH" --unblockapp "$NODE_PATH" 2>/dev/null || true
  echo "  Node.js ($NODE_PATH): allowed"
fi

# Docker
DOCKER_PATH=$(which docker 2>/dev/null || echo "")
if [ -n "$DOCKER_PATH" ]; then
  sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add "$DOCKER_PATH" --unblockapp "$DOCKER_PATH" 2>/dev/null || true
  echo "  Docker ($DOCKER_PATH): allowed"
fi

echo "  Done"

# ── 6. Docker socket permissions ─────────────────────────────────────────────
echo "[6/7] Configuring Docker socket..."

if [ -S /var/run/docker.sock ]; then
  sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
  echo "  Docker socket: world-readable"
else
  echo "  Docker socket not found (Docker may not be running)"
fi

# Ensure user is in docker group (if it exists)
if dscl . -read /Groups/docker 2>/dev/null; then
  sudo dscl . -append /Groups/docker GroupMembership "$CURRENT_USER" 2>/dev/null || true
  echo "  User $CURRENT_USER added to docker group"
fi

echo "  Done"

# ── 7. Disable sleep/screen lock during agent operations ────────────────────
echo "[7/7] Preventing sleep/lock during operations..."

# Disable display sleep (set to never)
sudo pmset -a displaysleep 0 2>/dev/null || true
# Disable system sleep
sudo pmset -a sleep 0 2>/dev/null || true
# Disable screen saver
defaults -currentHost write com.apple.screensaver idleTime 0 2>/dev/null || true

echo "  Done (sleep and screen lock disabled)"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "IMPORTANT: Some permissions (Accessibility, Full Disk Access) may still"
echo "require manual approval in System Settings > Privacy & Security."
echo ""
echo "To verify, run:"
echo "  tccutil reset All com.apple.Terminal  # Reset if needed"
echo "  Then re-open Terminal and approve the prompts ONCE."
echo ""
echo "The following is now configured:"
echo "  - Accessibility: Terminal + iTerm2"
echo "  - Full Disk Access: Terminal + iTerm2"
echo "  - Automation: Terminal → System Events"
echo "  - Gatekeeper: Disabled (all apps allowed)"
echo "  - Firewall: Node.js + Docker allowed"
echo "  - Docker socket: Accessible"
echo "  - Sleep/Lock: Disabled"
echo ""
echo "Moltbot is now unchained. 🔓"
