#!/usr/bin/env bash
# Installs the Helm chart in a kind cluster and signs in through it: builds
# the ldaplens image from this checkout and the test OpenLDAP image, loads
# both into kind, runs OpenLDAP with deploy/demo-ldif/demo.ldif, installs the
# chart with deploy/helm/test/kind-values.yaml, checks the API through
# kubectl port-forward, then upgrades to basePath /ldap and checks it again.
# The cluster is deleted at the end, also on a failure.
# Needs Docker, kind and kubectl. Run it from the repository root with
# make chart-kind, which exports the tool minimums for scripts/tool.sh.
set -euo pipefail

cluster=ldaplens-chart
chart=deploy/helm/ldaplens
tests=deploy/helm/test
port=18093 # e2e uses 18091 and 18092
url=http://127.0.0.1:$port
tmp=$(mktemp -d)
pf=

die() {
	echo "chart-kind: $*" >&2
	exit 1
}
for t in kind kubectl; do
	command -v "$t" >/dev/null || die "needs $t on PATH"
done

# Only the kubeconfig in $tmp: ~/.kube/config stays as it is.
export KUBECONFIG=$tmp/kubeconfig
# helm in Docker (scripts/tool.sh) reaches the cluster on the kind network.
export TOOL_DOCKER_ARGS="--network kind -v $tmp/kubeconfig-internal:/tmp/kubeconfig:ro -e KUBECONFIG=/tmp/kubeconfig"
helm() { scripts/tool.sh helm "$@"; }

# 2>/dev/null: bash reports the killed job.
stop_forward() {
	[ -z "$pf" ] || { kill "$pf" && wait "$pf"; } 2>/dev/null || true
}
cleanup() {
	local status=$?
	stop_forward
	if [ "$status" != 0 ] && [ -s "$KUBECONFIG" ]; then
		kubectl get pods -o wide || true
		kubectl get events --sort-by=.lastTimestamp || true
		kubectl logs --prefix --all-containers --tail 30 -l app=openldap || true
		kubectl logs --prefix --all-containers --tail 30 -l app.kubernetes.io/instance=ldaplens || true
	fi
	kind delete cluster --name "$cluster" || true
	rm -rf "$tmp"
}
trap cleanup EXIT

kind delete cluster --name "$cluster" # left over from an interrupted run
kind create cluster --name "$cluster" --wait 2m
kind get kubeconfig --internal --name "$cluster" >"$tmp/kubeconfig-internal"

docker build -f deploy/Dockerfile -t ldaplens:kind .
docker build -t ldaplens-openldap:kind deploy/openldap
kind load docker-image --name "$cluster" ldaplens:kind ldaplens-openldap:kind

kubectl create configmap openldap-ldif --from-file=deploy/demo-ldif/demo.ldif
kubectl apply -f "$tests/kind-openldap.yaml"
kubectl rollout status deploy/openldap --timeout 2m

helm install ldaplens "$chart" -f "$tests/kind-values.yaml" --wait --timeout 5m

# forward (re)starts the port-forward to the Service and waits for /readyz,
# which answers at the root whatever the base path.
forward() {
	stop_forward
	kubectl port-forward svc/ldaplens "$port:80" >"$tmp/port-forward.log" 2>&1 &
	pf=$!
	for _ in $(seq 30); do
		curl -fsS -o /dev/null "$url/readyz" 2>/dev/null && return
		sleep 1
	done
	die "port-forward: $(cat "$tmp/port-forward.log")"
}
# ok PATH fails unless PATH answers 200 with the probes' "ok", not the SPA.
ok() {
	local got
	got=$(curl -fsS "$url$1") || die "GET $1 failed"
	[ "$got" = ok ] || die "GET $1: want ok, got: $got"
}
# connect PASSWORD signs in to the demo profile as user001 and prints the
# HTTP status; the body goes to $tmp/body.
connect() {
	curl -sS -o "$tmp/body" -w '%{http_code}' -H 'Content-Type: application/json' \
		-d "{\"profile\":\"demo\",\"username\":\"user001\",\"password\":\"$1\"}" "$url/api/connect"
}

forward
ok /readyz
got=$(connect secret001)
[ "$got" = 200 ] || die "user001 with the right password: want 200, got $got $(cat "$tmp/body")"
got=$(connect wrong-password)
if [ "$got" != 401 ] || ! grep -qF '"code":"invalid_credentials"' "$tmp/body"; then
	die "user001 with a wrong password: want 401 invalid_credentials, got $got $(cat "$tmp/body")"
fi
echo "chart-kind: /readyz ok, user001 signs in, a wrong password gets invalid_credentials"

# The upgrade replaces the pods. kubectl port-forward prefers the oldest
# ready pod, so the old ones must be gone before it restarts.
old=$(kubectl get pods -l app.kubernetes.io/instance=ldaplens -o name)
helm upgrade ldaplens "$chart" -f "$tests/kind-values.yaml" --set basePath=/ldap --wait --timeout 5m
# shellcheck disable=SC2086 # pod names, one word each
kubectl wait --for=delete $old --timeout 1m
forward
ok /ldap/readyz
echo "chart-kind: ok"
