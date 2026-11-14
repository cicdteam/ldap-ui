#!/bin/sh
# Runs a Go tool from PATH when it meets the minimum version exported by the
# Makefile, otherwise runs that minimum version in Docker.
# Usage: scripts/tool.sh TOOL [ARGS...]
set -eu

tool=$1
shift

semver() { grep -Eo '[0-9]+\.[0-9]+\.[0-9]+' | head -n 1; }

# at_least HAVE WANT succeeds when HAVE >= WANT.
at_least() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n 1)" = "$2" ]; }

# xtools_version reads `go version -m` output and prints the version of the
# golang.org/x/tools main module (the `mod` line; `dep` lines are ignored).
xtools_version() { awk -F '\t' '$2 == "mod" && $3 == "golang.org/x/tools" { print $4 }' | semver; }

case $tool in
gofumpt) min=$GOFUMPT_MIN pkg=mvdan.cc/gofumpt ;;
goimports) min=$GOIMPORTS_VERSION pkg=golang.org/x/tools/cmd/goimports ;;
govulncheck) min=$GOVULNCHECK_MIN pkg=golang.org/x/vuln/cmd/govulncheck ;;
golangci-lint) min=$GOLANGCI_LINT_MIN pkg= ;;
*)
	echo "tool.sh: unknown tool $tool" >&2
	exit 2
	;;
esac

local_version() {
	case $tool in
	gofumpt) gofumpt --version 2>/dev/null | semver ;;
	golangci-lint) golangci-lint --version 2>/dev/null | semver ;;
	govulncheck) govulncheck -version 2>/dev/null | grep Scanner | semver ;;
	goimports) go version -m "$(command -v goimports)" 2>/dev/null | xtools_version ;;
	esac
}

if command -v "$tool" >/dev/null 2>&1; then
	have=$(local_version || true)
	if [ -n "$have" ] && at_least "$have" "$min"; then
		exec "$tool" "$@"
	fi
	echo "tool.sh: $tool ${have:-unknown} is older than $min, using Docker" >&2
fi

run_docker() {
	exec docker run --rm --user "$(id -u):$(id -g)" \
		-e HOME=/tmp -e GOPATH=/tmp/go -e GOCACHE=/tmp/cache -e GOLANGCI_LINT_CACHE=/tmp/lintcache \
		-v "$PWD":/src -w /src "$@"
}

if [ "$tool" = golangci-lint ]; then
	run_docker "golangci/golangci-lint:v$min" golangci-lint "$@"
fi
run_docker "$GO_IMAGE" go run "$pkg@v$min" "$@"
