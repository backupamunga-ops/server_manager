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

func (s *Server) handleConn(_ context.Context, conn net.Conn) {
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(30 * time.Second))
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
		resp := s.processCommand(&cmd)
		s.writeResponse(conn, resp)
	}
}

func (s *Server) processCommand(cmd *Command) Response {
	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)

	if cmd.Version != 1 {
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrPayloadInvalid, Message: "unsupported protocol version"},
			ObservedAt: nowStr}
	}
	if cmd.ServerID != s.ident.InstanceID {
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrServerIDMismatch, Message: "serverId mismatch"},
			ObservedAt: nowStr}
	}
	expiresAt, err := time.Parse(time.RFC3339, cmd.ExpiresAt)
	if err != nil {
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrPayloadInvalid, Message: "invalid expiresAt"},
			ObservedAt: nowStr}
	}
	if now.After(expiresAt) {
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrExpired, Message: "command expired"},
			ObservedAt: nowStr}
	}
	if !s.verifySignature(cmd) {
		log.Printf("REJECTED signature_invalid cmd=%s op=%s", cmd.CommandID, cmd.Operation)
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrSignatureInvalid, Message: "signature failed"},
			ObservedAt: nowStr}
	}
	if !AllowedOperations[cmd.Operation] {
		log.Printf("REJECTED operation_not_allowed cmd=%s op=%s", cmd.CommandID, cmd.Operation)
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrOperationNotAllowed, Message: fmt.Sprintf("operation %q not allowlisted", cmd.Operation)},
			ObservedAt: nowStr}
	}
	if err := s.validatePayload(cmd); err != nil {
		log.Printf("REJECTED payload_invalid cmd=%s op=%s err=%v", cmd.CommandID, cmd.Operation, err)
		return Response{CommandID: cmd.CommandID, Status: "rejected",
			Error: &ResponseError{Code: ErrPayloadInvalid, Message: err.Error()},
			ObservedAt: nowStr}
	}

	log.Printf("ACCEPTED cmd=%s op=%s resource=%s (handler stub — CL-052)", cmd.CommandID, cmd.Operation, cmd.ResourceID)
	return Response{
		CommandID: cmd.CommandID,
		Status:    "completed",
		Result: map[string]interface{}{
			"note":    "command validated; handler implementation in CL-052",
			"allowed": true,
		},
		ObservedAt: nowStr,
	}
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
