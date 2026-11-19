# OpenLDAP for the tests and the demo only: the admin password is fixed in
# slapd.conf. Our own because the prebuilt image we used is frozen.
FROM debian:trixie-slim@sha256:a72b4433de1cf7d6bae0c4cee74d0547f58601a643b3375f070c51600d63b6b2
# The package's own config and the dc=nodomain database its postinst creates
# go: slapd.conf replaces them.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends slapd ldap-utils \
 && rm -rf /var/lib/apt/lists/* /etc/ldap/slapd.d /var/lib/ldap/*
COPY slapd.conf /etc/ldap/slapd.conf
USER openldap
EXPOSE 1389
# slapd sizes its connection table from the open files limit: 1048576 (Docker
# Desktop) costs about 690 MiB idle, and an unlimited one can fail the start.
# Every start empties the database and loads every /ldifs/*.ldif before slapd
# listens, so a restart resets the data and a bad LDIF stops the container.
# -d none keeps slapd in the foreground, logging its errors but not every
# request (the healthcheck runs every second).
CMD ["sh", "-ec", "ulimit -n 1024; rm -f /var/lib/ldap/*.mdb; for f in /ldifs/*.ldif; do [ -e \"$f\" ] && slapadd -f /etc/ldap/slapd.conf -l \"$f\"; done; exec slapd -d none -f /etc/ldap/slapd.conf -h ldap://:1389/"]
