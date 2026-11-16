#!/bin/sh
# Builds the UI and the binary, then serves them for Playwright under /ldap,
# in local mode with the token playwright.config.ts sends. The server's
# output goes to e2e/.tmp/server.log, new each run, which journey.spec.ts
# reads; look there when the server fails to start.
set -eu
cd "$(dirname "$0")/.."
npm run build
rm -rf e2e/.tmp/data
mkdir -p e2e/.tmp/data
(cd .. && go build -o web/e2e/.tmp/ldaplens ./cmd/ldaplens)
export DEMO_LDAP_PASSWORD=adminpassword BAD_LDAP_PASSWORD=wrong AD_LDAP_PASSWORD='Adm1nPassw0rd!'
exec e2e/.tmp/ldaplens --config ../deploy/e2e/connections.yaml \
  --listen 127.0.0.1:18091 --base-path /ldap --data-dir e2e/.tmp/data \
  --auth-token e2e-token-000000000 \
  >e2e/.tmp/server.log 2>&1
