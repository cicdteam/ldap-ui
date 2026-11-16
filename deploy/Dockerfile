# syntax=docker/dockerfile:1
# Node only builds static assets.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json web/.npmrc ./
RUN npm ci --ignore-scripts
COPY web/ ./
RUN npm run build

FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /web/dist ./web/dist
ARG VERSION=dev
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w -X main.version=${VERSION}" -o /out/ldaplens ./cmd/ldaplens \
 && mkdir /out/data

FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=build /out/ldaplens /ldaplens
# Local mode keeps its data in $XDG_CONFIG_HOME/ldaplens: mount a volume at
# /data to keep it. Server mode writes nothing.
COPY --from=build --chown=65532:65532 /out/data /data
ENV LDAPLENS_LISTEN=0.0.0.0:8080 \
    XDG_CONFIG_HOME=/data
EXPOSE 8080
ENTRYPOINT ["/ldaplens"]
CMD ["server"]
