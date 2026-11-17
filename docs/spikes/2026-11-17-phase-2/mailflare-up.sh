#!/usr/bin/env bash
# SPIKE: start a fresh Mailflare + Mailpit pair and print an app password.
set -euo pipefail
NET=tbjmap-spike B=http://127.0.0.1:13000 J=$(mktemp)
podman rm -f spike-mailflare >/dev/null 2>&1 || true
podman run -d --name spike-mailflare --network $NET -p 127.0.0.1:13000:3000 -p 127.0.0.1:12525:2525 \
  -e SMTP_URL=smtp://spike-mailpit:1025 -e APP_URL=$B -e SMTP_INBOUND_PORT=2525 -e MAIL_HOSTNAME=example.test \
  localhost/mailflare-test:5330fa4 >/dev/null
for i in $(seq 1 60); do curl -sf -o /dev/null $B/api/setup/status && break; sleep 1; done
curl -s -X POST $B/api/setup/prepare >/dev/null
curl -s -X POST -H 'Content-Type: application/json' $B/api/auth/register \
  -d '{"domain":"example.test","username":"me","password":"Test-password-123!","skipDns":true,"enableSending":true,"usePasskey":false,"resetEmail":"reset@example.org"}' >/dev/null
curl -s -c $J -H 'Content-Type: application/json' -X POST $B/api/auth/login -d '{"email":"me@example.test","password":"Test-password-123!"}' >/dev/null
MBX=$(curl -s -b $J $B/api/mailboxes | jq -r '(.mailboxes // .)[0].id')
curl -s -b $J -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: same-origin' -X POST $B/api/api-keys \
  -d "{\"name\":\"thunderbird-test\",\"scopes\":[\"jmap\"],\"mailboxIds\":[\"$MBX\"]}" | jq -r .key
rm -f $J
