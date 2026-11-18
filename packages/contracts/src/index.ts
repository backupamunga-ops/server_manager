/**
 * @cloudlane/contracts
 *
 * Shared TypeScript types for the Cloudlane platform.
 * Consumed by:
 *   - apps/dashboard (SvelteKit) — generated client + DTOs
 *   - apps/api (NestJS) — request/response DTOs, agent client
 *   - agent (Go) — JSON schema for the typed command envelope
 *                 (Go types are maintained in agent/internal/ipc/types.go)
 */

export * from './api/index.js';
export * from './agent/index.js';
export * from './events/index.js';
