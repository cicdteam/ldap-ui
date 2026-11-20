#!/bin/sh
# Checks a release tag against a Chart.yaml and prints the chart version to
# publish. vX.Y.Z needs appVersion X.Y.Z: the chart ships with that release.
# chart-vX.Y.Z needs version X.Y.Z: a chart-only release.
# Usage: scripts/chart-version-check.sh TAG CHART_YAML
set -eu

tag=$1
file=$2

die() {
	echo "chart-version-check: $*" >&2
	exit 1
}
# field KEY prints the top-level KEY of the Chart.yaml without quotes.
field() { awk -v k="^$1:" '$0 ~ k { gsub(/"/, "", $2); print $2; exit }' "$file"; }

case $tag in
chart-v*) key=version want=${tag#chart-v} ;;
v*) key=appVersion want=${tag#v} ;;
*) die "$tag is not a vX.Y.Z or chart-vX.Y.Z tag" ;;
esac
have=$(field "$key")
[ "$have" = "$want" ] || die "tag $tag needs $key $want in $file, it has ${have:-none}"
version=$(field version)
[ -n "$version" ] || die "no version in $file"
echo "$version"
