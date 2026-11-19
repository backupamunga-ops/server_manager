// Package docker wraps the Docker CLI for the agent's typed operations.
// We use the CLI instead of the Docker Go SDK to keep the binary small
// and avoid heavy dependencies on the 1GB VPS target.
package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"time"
)

// Container represents a running Docker container.
type Container struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	State  string `json:"state"`
	Status string `json:"status"`
}

// StartContainerOptions defines the parameters for starting a new container.
type StartContainerOptions struct {
	Name        string   // container name, e.g. "cloudlane-svc-{serviceId}"
	Image       string   // image ref, e.g. "caddy:2-alpine"
	MemoryMB    int      // memory limit in MB
	CPUs        float64  // CPU limit in cores
	InternalPort int     // port the container listens on
	VolumeMounts []VolumeMount // volumes to mount
	EnvVars     []string // environment variables in KEY=VALUE format
	Network     string   // Docker network name
	Command     []string // command + args
}

type VolumeMount struct {
	Source   string // host path or volume name
	Target   string // container path
	ReadOnly bool
}

// StartContainer runs a Docker container with the given options.
func StartContainer(ctx context.Context, opts StartContainerOptions) (string, error) {
	args := []string{
		"run", "-d",
		"--name", opts.Name,
		"--restart", "unless-stopped",
	}

	if opts.MemoryMB > 0 {
		args = append(args, "--memory", fmt.Sprintf("%dm", opts.MemoryMB))
	}
	if opts.CPUs > 0 {
		args = append(args, "--cpus", fmt.Sprintf("%.2f", opts.CPUs))
	}

	// Security: no privileged, no new privileges
	args = append(args, "--security-opt", "no-new-privileges")

	// Resource limits
	args = append(args, "--pids-limit", "100")

	// Network
	if opts.Network != "" {
		args = append(args, "--network", opts.Network)
	}

	// Volume mounts
	for _, v := range opts.VolumeMounts {
		mount := v.Source + ":" + v.Target
		if v.ReadOnly {
			mount += ":ro"
		}
		args = append(args, "-v", mount)
	}

	// Environment variables
	for _, e := range opts.EnvVars {
		args = append(args, "-e", e)
	}

	// Image
	args = append(args, opts.Image)

	// Command
	if len(opts.Command) > 0 {
		args = append(args, opts.Command...)
	}

	cmd := exec.CommandContext(ctx, "docker", args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("docker run failed: %s: %w", string(output), err)
	}

	containerID := strings.TrimSpace(string(output))
	return containerID, nil
}

// StopContainer stops and removes a container.
func StopContainer(ctx context.Context, name string) error {
	// Stop
	stopCmd := exec.CommandContext(ctx, "docker", "stop", "-t", "10", name)
	if output, err := stopCmd.CombinedOutput(); err != nil {
		// Container may already be stopped — try to remove anyway
		_ = output
	}

	// Remove
	rmCmd := exec.CommandContext(ctx, "docker", "rm", "-f", name)
	if output, err := rmCmd.CombinedOutput(); err != nil {
		return fmt.Errorf("docker rm failed: %s: %w", string(output), err)
	}

	return nil
}

// InspectContainer returns the state of a container.
func InspectContainer(ctx context.Context, name string) (*Container, error) {
	cmd := exec.CommandContext(ctx, "docker", "inspect", "--format", "{{json .}}", name)
	output, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("container not found or inspect failed: %w", err)
	}

	var raw struct {
		ID    string `json:"Id"`
		Name  string `json:"Name"`
		State struct {
			Status     string `json:"Status"`
			Health     struct {
				Status string `json:"Status"`
			} `json:"Health"`
		} `json:"State"`
	}
	if err := json.Unmarshal(output, &raw); err != nil {
		return nil, fmt.Errorf("failed to parse inspect output: %w", err)
	}

	return &Container{
		ID:     raw.ID[:12],
		Name:   strings.TrimPrefix(raw.Name, "/"),
		State:  raw.State.Status,
		Status: raw.State.Health.Status,
	}, nil
}

// WaitForHealthy polls the container until it's running or timeout.
func WaitForHealthy(ctx context.Context, name string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}
		c, err := InspectContainer(ctx, name)
		if err != nil {
			return err
		}
		if c.State == "running" {
			return nil
		}
		time.Sleep(2 * time.Second)
	}
	return fmt.Errorf("container did not become healthy within %s", timeout)
}

// CreateVolume creates a named Docker volume.
func CreateVolume(ctx context.Context, name string) error {
	cmd := exec.CommandContext(ctx, "docker", "volume", "create", name)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("volume create failed: %s: %w", string(output), err)
	}
	return nil
}

// DeleteVolume removes a named Docker volume.
func DeleteVolume(ctx context.Context, name string) error {
	cmd := exec.CommandContext(ctx, "docker", "volume", "rm", name)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("volume delete failed: %s: %w", string(output), err)
	}
	return nil
}

// PullImage pulls a Docker image if not already present.
func PullImage(ctx context.Context, image string) error {
	// Check if image exists locally
	checkCmd := exec.CommandContext(ctx, "docker", "image", "inspect", image)
	if err := checkCmd.Run(); err == nil {
		return nil // image already exists
	}

	cmd := exec.CommandContext(ctx, "docker", "pull", image)
	if output, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("pull failed: %s: %w", string(output), err)
	}
	return nil
}
