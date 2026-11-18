# Cloudlane Agent Dockerfile
# Builds the Go agent binary. The installer extracts it to run on the host.

FROM golang:1.22-alpine AS builder
RUN apk add --no-cache ca-certificates git
WORKDIR /build

COPY agent/go.mod agent/go.sum ./
RUN go mod download

COPY agent/ ./
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -ldflags="-s -w" -o /cloudlane-agent ./cmd/cloudlane-agent

FROM alpine:3.20 AS runtime
RUN apk add --no-cache ca-certificates tini docker-cli
COPY --from=builder /cloudlane-agent /usr/local/bin/cloudlane-agent

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["cloudlane-agent"]
