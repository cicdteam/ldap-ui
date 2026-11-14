#!/bin/sh
# Test fixture, not a secret: installs the committed test CA's server
# certificate for Samba (smblds runs /entrypoint.d/* before starting samba),
# so ldapui can verify LDAPS to 127.0.0.1 with deploy/ad-test/tls/ca.pem.
set -e
d=/var/lib/samba/private/tls
mkdir -p "$d"
cp /certs/key.pem /certs/cert.pem /certs/ca.pem "$d/"
chmod 600 "$d/key.pem"
