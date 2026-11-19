// Package main is the entry point for the Cloudlane Go agent.
package main

import (
	"context"
	"flag"
	"log"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/backupamunga-ops/cloudlane/agent/internal/identity"
	"github.com/backupamunga-ops/cloudlane/agent/internal/ipc"
)

func main() {
	socketPath := flag.String("socket", "/run/cloudlane/agent.sock", "UNIX socket path")
	hmacKeyFile := flag.String("hmac-key-file", "/etc/cloudlane/agent-hmac.key", "Path to HMAC key file")
	instanceID := flag.String("instance-id", "", "Installation instance ID (must match API)")
	flag.Parse()

	if *instanceID == "" {
		log.Fatal("instance-id is required")
	}

	hmacKey, err := os.ReadFile(*hmacKeyFile)
	if err != nil {
		log.Fatalf("failed to read hmac key file: %v", err)
	}
	if len(hmacKey) < 32 {
		log.Fatal("hmac key must be at least 32 bytes")
	}

	ident, err := identity.Load(*instanceID)
	if err != nil {
		log.Fatalf("failed to load identity: %v", err)
	}

	if err := os.MkdirAll("/run/cloudlane", 0o755); err != nil {
		log.Fatalf("failed to create socket dir: %v", err)
	}

	if _, err := os.Stat(*socketPath); err == nil {
		if err := os.Remove(*socketPath); err != nil {
			log.Fatalf("failed to remove stale socket: %v", err)
		}
	}

	listener, err := ipc.Listen(*socketPath)
	if err != nil {
		log.Fatalf("failed to listen: %v", err)
	}
	defer listener.Close()

	if err := os.Chmod(*socketPath, 0o660); err != nil {
		log.Fatalf("failed to chmod socket: %v", err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		log.Printf("received signal %v, shutting down", sig)
		cancel()
		time.Sleep(500 * time.Millisecond)
		os.Exit(0)
	}()

	server := ipc.NewServer(ident, hmacKey)
	log.Printf("cloudlane-agent listening on %s (instance=%s)", *socketPath, ident.InstanceID)
	log.Printf("allowlisted operations: %d", len(ipc.AllowedOperations))

	if err := server.Serve(ctx, listener); err != nil {
		log.Printf("server exited: %v", err)
	}
}
