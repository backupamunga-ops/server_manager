/**
 * Agent module — typed IPC client to the Go agent.
 *
 * Connects to /run/cloudlane/agent.sock, signs commands with HMAC SHA-256
 * using the AGENT_HMAC_KEY, enforces expiry, returns typed responses.
 *
 * Full implementation wired in CL-052. This module exposes the client
 * so deployment workers can call agent.release.startCandidate etc.
 */
import { Module } from '@nestjs/common';
import { AgentService } from './agent.service.js';

@Module({
  providers: [AgentService],
  exports: [AgentService],
})
export class AgentModule {}
