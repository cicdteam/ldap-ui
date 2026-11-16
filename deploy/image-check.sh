#!/bin/sh
# Checks one ldaplens image built for one platform: image and binary
# architecture, unpacked size, version, /healthz of server mode (the default
# command) on a read-only root filesystem, and the login link of local mode
# with a volume.
# Usage: image-check.sh <image> <platform> <version>.
# Exits non-zero on the first failure and always removes its containers (with
# their anonymous volumes) and temporary files.
set -eu
image=$1 platform=$2 version=$3
arch=${platform#linux/}
max_bytes=$((40 * 1024 * 1024))
# ELF e_machine (bytes 18-19, little endian) of the binary we expect.
case $arch in
  amd64) machine=3e00 ;;
  arm64) machine=b700 ;;
  *) echo "$platform: unsupported platform" >&2; exit 1 ;;
esac

got=$(docker image inspect -f '{{.Architecture}}' "$image")
[ "$got" = "$arch" ] || { echo "$image: architecture $got, want $arch" >&2; exit 1; }

name=ldaplens-image-check-$arch
local_name=ldaplens-image-check-local-$arch
cid=
tmp=$(mktemp -d)
trap 'docker rm -fv ${cid:+"$cid"} "$name" "$local_name" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT

# The label above comes from the base image; the binary is what runs.
# Export the rootfs without running it, so no emulation is needed here.
cid=$(docker create --platform "$platform" "$image")
docker export -o "$tmp/rootfs.tar" "$cid"
tar -xf "$tmp/rootfs.tar" -C "$tmp" ldaplens
got=$(od -An -tx1 -j18 -N2 "$tmp/ldaplens" | tr -d ' \n')
[ "$got" = "$machine" ] || { echo "$image: /ldaplens ELF machine $got, want $machine ($arch)" >&2; exit 1; }

# Unpacked rootfs size; .Size from image inspect depends on the image store.
size=$(wc -c <"$tmp/rootfs.tar" | tr -d ' ')
[ "$size" -lt "$max_bytes" ] || { echo "$image: rootfs $size bytes, limit $max_bytes" >&2; exit 1; }

got=$(docker run --rm --platform "$platform" "$image" --version)
[ "$got" = "ldaplens $version" ] || { echo "$image: --version printed '$got', want 'ldaplens $version'" >&2; exit 1; }

# Server mode writes nothing, so it runs on a read-only root without a volume.
# The one profile binds anonymously, which needs the token.
printf 'connections:\n  - name: anon\n    url: ldap://127.0.0.1:1389\n' >"$tmp/connections.yaml"
chmod 644 "$tmp/connections.yaml"
docker rm -fv "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" --platform "$platform" --read-only -p 127.0.0.1::8080 \
  -v "$tmp/connections.yaml:/etc/ldaplens/connections.yaml:ro" \
  -e LDAPLENS_CONFIG=/etc/ldaplens/connections.yaml \
  -e LDAPLENS_AUTH_TOKEN=image-check-token-0000 "$image" >/dev/null
port=$(docker port "$name" 8080/tcp | head -1 | sed 's/.*://')
[ -n "$port" ] || { echo "$image: port 8080 not published" >&2; docker logs "$name" >&2; exit 1; }
i=0
until curl -fs --max-time 1 -o /dev/null "http://127.0.0.1:$port/healthz"; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "$image: /healthz not 200 after 30 tries" >&2; docker logs "$name" >&2; exit 1; }
  sleep 0.5
done

# Local mode keeps a token in the volume at /data and logs the login link.
docker rm -fv "$local_name" >/dev/null 2>&1 || true
docker run -d --name "$local_name" --platform "$platform" -v /data "$image" local >/dev/null
i=0
until docker logs "$local_name" 2>&1 | grep -q '/?token='; do
  i=$((i + 1))
  [ "$i" -lt 30 ] || { echo "$image: local mode logged no login link after 30 tries" >&2; docker logs "$local_name" >&2; exit 1; }
  sleep 0.5
done
echo "$image ($platform): ok, ldaplens $version, rootfs $size bytes"
