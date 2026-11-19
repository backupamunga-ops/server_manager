// Package identity loads the agent's installation identity.
package identity

import "fmt"

type Identity struct {
	InstanceID string
}

func Load(instanceID string) (*Identity, error) {
	if instanceID == "" {
		return nil, fmt.Errorf("instance ID is required")
	}
	return &Identity{InstanceID: instanceID}, nil
}
