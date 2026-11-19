// Package commands implements the typed operation handlers.
package commands

import (
	"context"
	"fmt"
	"path/filepath"

	"github.com/backupamunga-ops/cloudlane/agent/internal/docker"
)

// ReleaseStartCandidatePayload matches the TypeScript contract.
type ReleaseStartCandidatePayload struct {
	ImageRef          string   `json:"imageRef"`
	ImageDigest       *string  `json:"imageDigest"`
	CPULimit          float64  `json:"cpuLimit"`
	MemoryLimitMiB    int      `json:"memoryLimitMiB"`
	InternalPort      int      `json:"internalPort"`
	EnvVarsHash       string   `json:"envVarsHash"`
	VolumeIDs         []string `json:"volumeIds"`
	StaticArtifactPath *string `json:"staticArtifactPath"`
}

// ReleaseStartCandidate starts a Docker container for a deployment.
func ReleaseStartCandidate(ctx context.Context, resourceID string, payload ReleaseStartCandidatePayload) (map[string]interface{}, error) {
	containerName := fmt.Sprintf("cloudlane-svc-%s", resourceID)

	// Pull image if needed
	if err := docker.PullImage(ctx, payload.ImageRef); err != nil {
		return nil, fmt.Errorf("pull image failed: %w", err)
	}

	// Build volume mounts
	var mounts []docker.VolumeMount
	for _, volID := range payload.VolumeIDs {
		mounts = append(mounts, docker.VolumeMount{
			Source: volID,
			Target: "/data",
		})
	}

	// For static ZIP deploys, mount the extracted HTML directory
	var command []string
	if payload.StaticArtifactPath != nil {
		mounts = append(mounts, docker.VolumeMount{
			Source:   *payload.StaticArtifactPath,
			Target:   "/srv",
			ReadOnly: true,
		})
		// Use Caddy to serve static files
		command = []string{"caddy", "file-server", "--listen", fmt.Sprintf(":%d", payload.InternalPort), "--root", "/srv"}
	}

	opts := docker.StartContainerOptions{
		Name:         containerName,
		Image:        payload.ImageRef,
		MemoryMB:     payload.MemoryLimitMiB,
		CPUs:         payload.CPULimit,
		InternalPort: payload.InternalPort,
		VolumeMounts: mounts,
		Network:      "cloudlane-internal",
		Command:      command,
	}

	containerID, err := docker.StartContainer(ctx, opts)
	if err != nil {
		return nil, err
	}

	return map[string]interface{}{
		"containerId":   containerID,
		"containerName": containerName,
		"state":         "started",
	}, nil
}

// ReleaseStopPayload matches the TypeScript contract.
type ReleaseStopPayload struct {
	ContainerID string `json:"containerId"`
}

// ReleaseStop stops and removes a container.
func ReleaseStop(ctx context.Context, payload ReleaseStopPayload) (map[string]interface{}, error) {
	if err := docker.StopContainer(ctx, payload.ContainerID); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"stopped": true,
	}, nil
}

// ReleaseInspectPayload matches the TypeScript contract.
type ReleaseInspectPayload struct {
	DeploymentID string `json:"deploymentId"`
}

// ReleaseInspect returns the current state of a deployment's container.
func ReleaseInspect(ctx context.Context, resourceID string, payload ReleaseInspectPayload) (map[string]interface{}, error) {
	containerName := fmt.Sprintf("cloudlane-svc-%s", resourceID)
	c, err := docker.InspectContainer(ctx, containerName)
	if err != nil {
		return map[string]interface{}{
			"state":        "not_found",
			"healthStatus": "unknown",
		}, nil
	}

	healthStatus := "unknown"
	if c.Status == "healthy" {
		healthStatus = "healthy"
	} else if c.Status != "" {
		healthStatus = "unhealthy"
	}
	if c.State == "running" && c.Status == "" {
		healthStatus = "healthy" // no health check configured, assume healthy if running
	}

	return map[string]interface{}{
		"containerId":   c.ID,
		"containerName": c.Name,
		"state":         c.State,
		"healthStatus":  healthStatus,
	}, nil
}

// VolumeCreatePayload matches the TypeScript contract.
type VolumeCreatePayload struct {
	VolumeID  string `json:"volumeId"`
	Name      string `json:"name"`
	MountPath string `json:"mountPath"`
	QuotaMB   int    `json:"quotaMB"`
}

// VolumeCreate creates a named Docker volume.
func VolumeCreate(ctx context.Context, payload VolumeCreatePayload) (map[string]interface{}, error) {
	volName := fmt.Sprintf("cloudlane-vol-%s", payload.VolumeID)
	if err := docker.CreateVolume(ctx, volName); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"volumeName": volName,
		"mountPath":  payload.MountPath,
	}, nil
}

// VolumeDeletePayload matches the TypeScript contract.
type VolumeDeletePayload struct {
	VolumeID string `json:"volumeID"`
}

// VolumeDelete removes a named Docker volume.
func VolumeDelete(ctx context.Context, payload VolumeDeletePayload) (map[string]interface{}, error) {
	volName := fmt.Sprintf("cloudlane-vol-%s", payload.VolumeID)
	if err := docker.DeleteVolume(ctx, volName); err != nil {
		return nil, err
	}
	return map[string]interface{}{
		"deleted": true,
	}, nil
}

// ValidateMountPath ensures the mount path is in the allowlist.
func ValidateMountPath(path string) bool {
	allowed := []string{"/data", "/uploads", "/cache"}
	for _, a := range allowed {
		if path == a || filepath.Clean(path) == a {
			return true
		}
	}
	return false
}
