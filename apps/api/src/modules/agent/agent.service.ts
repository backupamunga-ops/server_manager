import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { AGENT_PROTOCOL_VERSION, type AgentCommand, type AgentOperation, type AgentResponse } from '@cloudlane/contracts';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly socketPath: string;
  private readonly hmacKey: string;

  constructor(config: ConfigService) {
    this.socketPath = config.get<string>('AGENT_SOCKET_PATH', '/run/cloudlane/agent.sock');
    this.hmacKey = config.get<string>('AGENT_HMAC_KEY', '');
  }

  /**
   * Send a typed command to the Go agent and await its response.
   * TODO: CL-052 will implement the actual UNIX socket connection.
   */
  async send<T extends AgentOperation>(
    operation: T,
    workspaceId: string,
    resourceId: string,
    payload: Record<string, unknown>,
  ): Promise<AgentResponse> {
    if (!this.hmacKey) {
      throw new NotImplementedException({
        code: 'NOT_CONFIGURED',
        message: 'AGENT_HMAC_KEY not set. Agent integration wired in CL-052.',
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30_000);

    const unsigned: Omit<AgentCommand, 'signature'> = {
      version: AGENT_PROTOCOL_VERSION,
      commandId: randomUUID(),
      serverId: 'inst_local', // TODO: read from installation identity
      workspaceId,
      operation,
      resourceId,
      payload,
      issuedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    const canonical = this.canonicalJson(unsigned);
    const signature = createHmac('sha256', this.hmacKey).update(canonical).digest('hex');

    const command: AgentCommand = { ...unsigned, signature };

    this.logger.log(`Agent command queued (not sent): op=${operation} resource=${resourceId}`);
    // TODO: CL-052 — open net.connect(this.socketPath), write JSON + newline, read response
    throw new NotImplementedException({
      code: 'NOT_IMPLEMENTED',
      message: `Agent socket transport implemented in CL-052. Command was prepared: ${command.commandId}`,
    });
  }

  /**
   * Canonical JSON: keys sorted ascending, no whitespace, UTF-8.
   */
  private canonicalJson(obj: Record<string, unknown>): string {
    return JSON.stringify(obj, Object.keys(obj).sort());
  }
}
