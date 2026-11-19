package ipc

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"sync"
	"time"

	"github.com/backupamunga-ops/cloudlane/agent/internal/caddy"
	"github.com/backupamunga-ops/cloudlane/agent/internal/commands"
	"github.com/backupamunga-ops/cloudlane/agent/internal/docker"
	"github.com/backupamunga-ops/cloudlane/agent/internal/identity"
)

type Server struct {
	ident   *identity.Identity
	hmacKey []byte
	mu      sync.Mutex
}

func NewServer(ident *identity.Identity, hmacKey []byte) *Server {
	return &Server{ident: ident, hmacKey: hmacKey}
}

func Listen(path string) (net.Listener, error) {
	return net.Listen("unix", path)
}

func (s *Server) Serve(ctx context.Context, l net.Listener) error {
	for {
		conn, err := l.Accept()
		if err != nil {
			select {
			case <-ctx.Done():
				return nil
			default:
				return fmt.Errorf("accept: %w", err)
			}
		}
		go s.handleConn(ctx, conn)
	}
}

func (s *Server) handleConn(ctx context.Context, conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(60 * time.Second))
	scanner := bufio.NewScanner(conn)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	for scanner.Scan() {
		var cmd Command
		if err := json.Unmarshal(scanner.Bytes(), &cmd); err != nil {
			s.writeResponse(conn, Response{
				Status:     "rejected",
				Error:      &ResponseError{Code: ErrPayloadInvalid, Message: "malformed JSON"},
				ObservedAt: time.Now().UTC().Format(time.RFC3339),
			})
			continue
		}
		resp := s.processCommand(ctx, &cmd)
		s.writeResponse(conn, resp)
	}
}

func (s *Server) processCommand(ctx context.Context, cmd *Command) Response {
	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)

	// Validation chain
	if cmd.Version != 1 {
		return s.reject(cmd, ErrPayloadInvalid, "unsupported protocol version", nowStr)
	}
	if cmd.ServerID != s.ident.InstanceID {
		return s.reject(cmd, ErrServerIDMismatch, "serverId mismatch", nowStr)
	}
	expiresAt, err := time.Parse(time.RFC3339, cmd.ExpiresAt)
	if err != nil {
		return s.reject(cmd, ErrPayloadInvalid, "invalid expiresAt", nowStr)
	}
	if now.After(expiresAt) {
		return s.reject(cmd, ErrExpired, "command expired", nowStr)
	}
	if !s.verifySignature(cmd) {
		log.Printf("REJECTED signature_invalid cmd=%s op=%s", cmd.CommandID, cmd.Operation)
		return s.reject(cmd, ErrSignatureInvalid, "signature failed", nowStr)
	}
	if !AllowedOperations[cmd.Operation] {
		log.Printf("REJECTED operation_not_allowed cmd=%s op=%s", cmd.CommandID, cmd.Operation)
		return s.reject(cmd, ErrOperationNotAllowed, fmt.Sprintf("operation %q not allowlisted", cmd.Operation), nowStr)
	}
	if err := s.validatePayload(cmd); err != nil {
		log.Printf("REJECTED payload_invalid cmd=%s op=%s err=%v", cmd.CommandID, cmd.Operation, err)
		return s.reject(cmd, ErrPayloadInvalid, err.Error(), nowStr)
	}

	// Dispatch to handler
	result, err := s.dispatch(ctx, cmd)
	if err != nil {
		log.Printf("FAILED cmd=%s op=%s err=%v", cmd.CommandID, cmd.Operation, err)
		return Response{
			CommandID:  cmd.CommandID,
			Status:     "failed",
			Error:      &ResponseError{Code: ErrInternal, Message: err.Error()},
			ObservedAt: nowStr,
		}
	}

	log.Printf("COMPLETED cmd=%s op=%s resource=%s", cmd.CommandID, cmd.Operation, cmd.ResourceID)
	return Response{
		CommandID:  cmd.CommandID,
		Status:     "completed",
		Result:     result,
		ObservedAt: nowStr,
	}
}

func (s *Server) reject(cmd *Command, code string, message string, nowStr string) Response {
	return Response{
		CommandID:  cmd.CommandID,
		Status:     "rejected",
		Error:      &ResponseError{Code: code, Message: message},
		ObservedAt: nowStr,
	}
}

// dispatch routes a validated command to the appropriate handler.
func (s *Server) dispatch(ctx context.Context, cmd *Command) (map[string]interface{}, error) {
	// Create a timeout context for the operation
	opCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	switch cmd.Operation {
	case "release.startCandidate":
		var payload commands.ReleaseStartCandidatePayload
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		return commands.ReleaseStartCandidate(opCtx, cmd.ResourceID, payload)

	case "release.stop":
		var payload commands.ReleaseStopPayload
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		return commands.ReleaseStop(opCtx, payload)

	case "release.inspect":
		var payload commands.ReleaseInspectPayload
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		return commands.ReleaseInspect(opCtx, cmd.ResourceID, payload)

	case "volume.create":
		var payload commands.VolumeCreatePayload
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		if !commands.ValidateMountPath(payload.MountPath) {
			return nil, fmt.Errorf("mount path %s not in allowlist [/data, /uploads, /cache]", payload.MountPath)
		}
		return commands.VolumeCreate(opCtx, payload)

	case "volume.delete":
		var payload commands.VolumeDeletePayload
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		return commands.VolumeDelete(opCtx, payload)

	case "caddy.validate":
		var payload struct {
			ConfigPath string `json:"configPath"`
		}
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		if err := caddy.Validate(opCtx, payload.ConfigPath); err != nil {
			return nil, err
		}
		return map[string]interface{}{"valid": true}, nil

	case "caddy.reload":
		var payload struct {
			ConfigSha256 string `json:"configSha256"`
			ConfigPath   string `json:"configPath"`
		}
		if err := decodePayload(cmd.Payload, &payload); err != nil {
			return nil, fmt.Errorf("invalid payload: %w", err)
		}
		if err := caddy.Reload(opCtx, payload.ConfigPath); err != nil {
			return nil, err
		}
		return map[string]interface{}{"reloaded": true}, nil

	default:
		return nil, fmt.Errorf("unhandled operation: %s", cmd.Operation)
	}
}

func decodePayload(raw map[string]interface{}, target interface{}) error {
	data, err := json.Marshal(raw)
	if err != nil {
		return err
	}
	return json.Unmarshal(data, target)
}

func (s *Server) verifySignature(cmd *Command) bool {
	unsigned := map[string]interface{}{
		"version":     cmd.Version,
		"commandId":   cmd.CommandID,
		"serverId":    cmd.ServerID,
		"workspaceId": cmd.WorkspaceID,
		"operation":   cmd.Operation,
		"resourceId":  cmd.ResourceID,
		"payload":     cmd.Payload,
		"issuedAt":    cmd.IssuedAt,
		"expiresAt":   cmd.ExpiresAt,
	}
	canonical, err := canonicalJSON(unsigned)
	if err != nil {
		return false
	}
	expected := computeHMACSHA256(canonical, s.hmacKey)
	return constantTimeEqual(expected, cmd.Signature)
}

func (s *Server) validatePayload(cmd *Command) error {
	payloadBytes, err := json.Marshal(cmd.Payload)
	if err != nil {
		return fmt.Errorf("cannot marshal payload")
	}
	payloadStr := string(payloadBytes)
	for _, forbidden := range ForbiddenPayloadPatterns {
		if contains(payloadStr, forbidden) {
			return fmt.Errorf("payload contains forbidden pattern")
		}
	}
	return nil
}

func (s *Server) writeResponse(conn net.Conn, resp Response) {
	respBytes, _ := json.Marshal(resp)
	conn.Write(respBytes)
	conn.Write([]byte("\n"))
}

// Reference docker package to suppress unused import warning if handlers
// are refactored to not use it directly.
var _ = docker.StartContainer

func canonicalJSON(m map[string]interface{}) (string, error) {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sortStrings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		kBytes, err := json.Marshal(k)
		if err != nil {
			return "", err
		}
		vBytes, err := json.Marshal(m[k])
		if err != nil {
			return "", err
		}
		parts = append(parts, string(kBytes)+":"+string(vBytes))
	}
	result := "{"
	for i, p := range parts {
		if i > 0 {
			result += ","
		}
		result += p
	}
	result += "}"
	return result, nil
}

func constantTimeEqual(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var r byte
	for i := 0; i < len(a); i++ {
		r |= a[i] ^ b[i]
	}
	return r == 0
}

func contains(s, substr string) bool {
	return len(s) >= len(substr) && indexOf(s, substr) >= 0
}

func indexOf(s, substr string) int {
	for i := 0; i <= len(s)-len(substr); i++ {
		match := true
		for j := 0; j < len(substr); j++ {
			if s[i+j] != substr[j] {
				match = false
				break
			}
		}
		if match {
			return i
		}
	}
	return -1
}

func sortStrings(s []string) {
	for i := 1; i < len(s); i++ {
		for j := i; j > 0 && s[j-1] > s[j]; j-- {
			s[j-1], s[j] = s[j], s[j-1]
		}
	}
}
