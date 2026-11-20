#!/usr/bin/env bash
# Checks the Helm chart without a cluster: lint, render the values sets in
# deploy/helm/test and validate them with kubeconform, render each
# fail-*.yaml, which must fail with the message on its first line
# ("# expect: ..."), check what the renders hold, and check that the chart's
# README lists every value. Every test values file goes over minimal.yaml.
# Run it from the repository root with make chart-check, which exports the
# tool minimums for scripts/tool.sh.
set -euo pipefail

chart=deploy/helm/ldaplens
tests=deploy/helm/test
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT

helm() { scripts/tool.sh helm "$@"; }
die() {
	echo "chart-check: $*" >&2
	exit 1
}
# has FILE TEXT fails unless FILE contains TEXT.
has() { grep -qF -- "$2" "$1" || die "$(basename "$1"): want $2"; }

helm lint --strict "$chart" -f "$tests/minimal.yaml"

mkdir "$out/pass"
helm template ldaplens "$chart" -f "$tests/minimal.yaml" >"$out/pass/minimal.yaml"
for f in full digest basepath; do
	helm template ldaplens "$chart" -f "$tests/minimal.yaml" -f "$tests/$f.yaml" >"$out/pass/$f.yaml"
done
cat "$out"/pass/*.yaml | scripts/tool.sh kubeconform -strict -summary -

for f in "$tests"/fail-*.yaml; do
	want=$(sed -n '1s/^# expect: //p' "$f")
	[ -n "$want" ] || die "$f: the first line must be # expect: <message>"
	if got=$(helm template ldaplens "$chart" -f "$tests/minimal.yaml" -f "$f" 2>&1); then
		die "$f rendered; want a failure with: $want"
	fi
	case $got in
	*"$want"*) echo "$f fails as expected" ;;
	*) die "$f: want a failure with: $want; got: $got" ;;
	esac
done

# Two releases in one namespace do not select each other's pods.
selector() { sed -n '/^  selector:/,/^  template:/p' "$1"; }
helm template a "$chart" -f "$tests/minimal.yaml" --show-only templates/deployment.yaml >"$out/a"
helm template b "$chart" -f "$tests/minimal.yaml" --show-only templates/deployment.yaml >"$out/b"
grep -qF 'app.kubernetes.io/instance: a' <(selector "$out/a") || die "release a: no instance in the selector"
[ "$(selector "$out/a")" != "$(selector "$out/b")" ] || die "releases a and b have the same selector"

# A change to connections alone rolls the pods.
checksum() { grep 'checksum/config:' "$1" || die "$(basename "$1"): no checksum/config annotation"; }
sed 's#url: ldaps://ldap\.#url: ldaps://ldap2.#' "$tests/minimal.yaml" |
	helm template ldaplens "$chart" -f - >"$out/other-url"
before=$(checksum "$out/pass/minimal.yaml")
after=$(checksum "$out/other-url")
[ "$before" != "$after" ] || die "another connection URL keeps the same checksum/config"

has "$out/pass/basepath.yaml" '{path: /ldap/readyz, port: http}'
has "$out/pass/basepath.yaml" '{path: /ldap/healthz, port: http}'
has "$out/pass/basepath.yaml" '{name: LDAPLENS_BASE_PATH, value: "/ldap"}'
grep -qx ' *- path: /ldap' "$out/pass/basepath.yaml" || die "basepath.yaml: want the Ingress path /ldap"

has "$out/pass/full.yaml" 'caFile: /etc/ldaplens/config/corp-ca.pem'
has "$out/pass/full.yaml" '{name: LDAPLENS_ALLOWED_HOSTS, value: "ldaplens.corp.example"}'
has "$out/pass/full.yaml" '{name: LDAPLENS_TRUSTED_PROXIES, value: "10.244.0.0/16,192.0.2.10"}'

digest=$(sed -n 's/^ *digest: //p' "$tests/digest.yaml")
has "$out/pass/digest.yaml" "image: \"ghcr.io/cicdteam/ldaplens@$digest\""
app=$(sed -n 's/^appVersion: "\(.*\)"$/\1/p' "$chart/Chart.yaml")
has "$out/pass/minimal.yaml" "image: \"ghcr.io/cicdteam/ldaplens:${app:?no appVersion in Chart.yaml}\""

# NOTES warns about an empty trustedProxies, and only then.
notes() { helm install ldaplens "$chart" --dry-run=client -f "$tests/minimal.yaml" "$@" | sed -n '/^NOTES:/,$p'; }
notes >"$out/notes-minimal"
notes -f "$tests/full.yaml" >"$out/notes-full"
has "$out/notes-minimal" 'trustedProxies is empty'
! grep -qF 'trustedProxies is empty' "$out/notes-full" || die "full.yaml: NOTES warns about trustedProxies"

# The README's values table names every top-level value and every key of
# the maps below. helm show readme loads the chart as helm package does, so
# a README left out by .helmignore fails here too.
helm show readme "$chart" >"$out/readme"
while read -r k; do
	grep -qF "| \`$k\` |" "$out/readme" || grep -qF "| \`$k." "$out/readme" || die "README.md: no $k in the values table"
done < <(awk '/^[A-Za-z]/ { top = $1; sub(/:.*/, "", top); print top; next }
	/^  [A-Za-z]/ && top ~ /^(image|ingress|networkPolicy|pdb|service|session)$/ { k = $1; sub(/:.*/, "", k); print top "." k }' "$chart/values.yaml")

# A release tag must match the Chart.yaml: vX.Y.Z its appVersion,
# chart-vX.Y.Z its version. Either prints the chart version to publish.
printf 'apiVersion: v2\nname: ldaplens\nversion: 0.2.0\nappVersion: "1.5.0"\n' >"$out/Chart.yaml"
release() { scripts/chart-version-check.sh "$1" "$out/Chart.yaml" 2>/dev/null; }
for tag in v1.5.0 chart-v0.2.0; do
	[ "$(release "$tag")" = 0.2.0 ] || die "chart-version-check: $tag should pass with 0.2.0"
done
for tag in v1.4.0 v0.2.0 chart-v0.1.0 chart-v1.5.0 1.5.0 0.2.0 main; do
	! release "$tag" >/dev/null || die "chart-version-check: $tag should fail"
done

echo "chart-check: ok"
