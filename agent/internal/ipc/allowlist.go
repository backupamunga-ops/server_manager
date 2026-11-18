// Package ipc implements the typed command IPC protocol over a UNIX socket.
package ipc

// AllowedOperations is the allowlist of operations the agent will accept.
var AllowedOperations = map[string]bool{
	"release.startCandidate": true,
	"release.stop":           true,
	"release.inspect":        true,
	"caddy.reload":           true,
	"caddy.validate":         true,
	"volume.create":          true,
	"volume.delete":          true,
}

// ForbiddenPayloadPatterns are substrings that MUST NEVER appear in any payload.
var ForbiddenPayloadPatterns = []string{
	"sh -c", "sudo ", "/bin/sh", "/bin/bash", "--privileged",
	"docker.sock", "/var/run/docker", "hostPath",
	":/host", ":/root", ":/etc", ":/var/lib/cloudlane",
}
