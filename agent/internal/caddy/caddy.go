// Package caddy wraps Caddy CLI for config validation and reload.
package caddy

import (
	"context"
	"fmt"
	"os/exec"
)

// Validate checks a Caddyfile for syntax errors.
func Validate(ctx context.Context, configPath string) error {
	cmd := exec.CommandContext(ctx, "caddy", "validate", "--config", configPath, "--adapter", "caddyfile")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("caddy validate failed: %s: %w", string(output), err)
	}
	return nil
}

// Reload atomically reloads Caddy with a new config.
func Reload(ctx context.Context, configPath string) error {
	// Validate first
	if err := Validate(ctx, configPath); err != nil {
		return fmt.Errorf("validation failed before reload: %w", err)
	}

	cmd := exec.CommandContext(ctx, "caddy", "reload", "--config", configPath, "--adapter", "caddyfile")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("caddy reload failed: %s: %w", string(output), err)
	}
	return nil
}

// AddServiceRoute appends a reverse_proxy route for a service to the Caddyfile.
// The route matches a specific hostname and proxies to the container's port.
func AddServiceRoute(configPath, hostname, upstream string) error {
	// Read the current Caddyfile
	// In production, this would use Caddy's admin API to add routes dynamically.
	// For now, we append to the Caddyfile and reload.
	route := fmt.Sprintf(`
# Service route for %s (added by agent)
%s {
  tls internal
  reverse_proxy %s
}
`, hostname, hostname, upstream)

	// Append to the Caddyfile
	cmd := exec.Command("bash", "-c", fmt.Sprintf("echo '%s' >> %s", route, configPath))
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("failed to append route: %s: %w", string(output), err)
	}

	return nil
}
