#!/bin/bash
# One-time setup: create a stable self-signed code-signing identity in the
# login keychain for CardMirror release builds.
#
# Why: an ad-hoc signature (`codesign -s -`) changes the app's code
# identity on every build, so macOS treats each update as a brand-new app
# and TCC grants (microphone, for voice control) are lost on every
# update. Signing with a stable certificate makes the app's "designated
# requirement" reference that cert, so TCC matches every future build and
# the grants persist across auto-updates.
#
# This does NOT remove Gatekeeper's first-install friction (only Apple
# notarization does); it only stabilizes the app's identity.
#
# Same scheme as Fast Debate Paste's setup-signing.sh (proven 2026-07-14).
# Safe to re-run: if the identity already exists, it does nothing.
# The certificate is self-signed and used only for local signing — it is
# never trusted as a root and grants no special privileges.
set -euo pipefail

IDENTITY="CardMirror Local Signing"
LOGIN_KC="$HOME/Library/Keychains/login.keychain-db"

if security find-identity -p codesigning "$LOGIN_KC" 2>/dev/null | grep -q "$IDENTITY"; then
  echo "Signing identity already present: \"$IDENTITY\""
  echo "Nothing to do."
  exit 0
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
cd "$WORK"

cat > cert.cnf <<CNF
[ req ]
distinguished_name = dn
x509_extensions = v3
prompt = no
[ dn ]
CN = $IDENTITY
[ v3 ]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
CNF

echo "==> Generating self-signed code-signing certificate…"
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem \
  -days 3650 -nodes -config cert.cnf >/dev/null 2>&1

# Export with the legacy 3DES/SHA1 PBE that macOS's keychain can import
# (LibreSSL's modern default PBE is rejected with a bogus "passphrase"
# error on import).
echo "==> Packaging as PKCS#12…"
openssl pkcs12 -export -inkey key.pem -in cert.pem -out identity.p12 \
  -passout pass:cardmirror -name "$IDENTITY" \
  -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1 >/dev/null 2>&1

echo "==> Importing into login keychain…"
# -A lets codesign use the private key without per-build authorization
# prompts. -T additionally whitelists codesign explicitly.
security import identity.p12 -k "$LOGIN_KC" -f pkcs12 -P "cardmirror" \
  -A -T /usr/bin/codesign

if security find-identity -p codesigning "$LOGIN_KC" | grep -q "$IDENTITY"; then
  echo "==> Done. Identity installed:"
  security find-identity -p codesigning "$LOGIN_KC" | grep "$IDENTITY"
  echo
  echo "Release builds (npm run release / dist:signed) will now sign with"
  echo "this identity via CSC_NAME. Existing installs will re-prompt for"
  echo "the microphone ONCE after their first update to a signed build;"
  echo "the grant persists across all updates after that."
else
  echo "error: identity not found after import" >&2
  exit 1
fi
