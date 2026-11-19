package ipc

// Command mirrors AgentCommand in packages/contracts/src/agent/index.ts.
type Command struct {
	Version     int                    `json:"version"`
	CommandID   string                 `json:"commandId"`
	ServerID    string                 `json:"serverId"`
	WorkspaceID string                 `json:"workspaceId"`
	Operation   string                 `json:"operation"`
	ResourceID  string                 `json:"resourceId"`
	Payload     map[string]interface{} `json:"payload"`
	IssuedAt    string                 `json:"issuedAt"`
	ExpiresAt   string                 `json:"expiresAt"`
	Signature   string                 `json:"signature"`
}

// Response mirrors AgentResponse in packages/contracts.
type Response struct {
	CommandID  string                 `json:"commandId"`
	Status     string                 `json:"status"`
	Result     map[string]interface{} `json:"result,omitempty"`
	Error      *ResponseError         `json:"error,omitempty"`
	ObservedAt string                 `json:"observedAt"`
}

type ResponseError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

const (
	ErrSignatureInvalid    = "SIGNATURE_INVALID"
	ErrExpired             = "EXPIRED"
	ErrServerIDMismatch    = "SERVER_ID_MISMATCH"
	ErrOperationNotAllowed = "OPERATION_NOT_ALLOWED"
	ErrResourceNotFound    = "RESOURCE_NOT_FOUND"
	ErrPayloadInvalid      = "PAYLOAD_INVALID"
	ErrRateLimited         = "RATE_LIMITED"
	ErrInternal            = "INTERNAL_ERROR"
	ErrDocker              = "DOCKER_ERROR"
	ErrCaddy               = "CADDY_ERROR"
)
