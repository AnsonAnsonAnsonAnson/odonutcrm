#!/usr/bin/env bash
# Creates throwaway certificates so the .pkpass signing path can be exercised in tests and
# local dev. Passes signed with these will NOT install on an iPhone; use your real
# Pass Type ID certificate for that (see docs/04-apple-google-wallet-setup.md).
set -euo pipefail
OUT="${1:-./certs-test}"
mkdir -p "$OUT"
cd "$OUT"
openssl req -x509 -newkey rsa:2048 -nodes -keyout wwdr.key -out wwdr.pem -days 30 -subj "/CN=Test WWDR CA" 2>/dev/null
openssl req -newkey rsa:2048 -nodes -keyout signer.key -out signer.csr -subj "/UID=pass.test.odonut/CN=Pass Type ID: pass.test.odonut/OU=TESTTEAM01" 2>/dev/null
openssl x509 -req -in signer.csr -CA wwdr.pem -CAkey wwdr.key -CAcreateserial -out signer.pem -days 30 2>/dev/null
rm -f signer.csr wwdr.srl
echo "Test certificates written to $OUT"
