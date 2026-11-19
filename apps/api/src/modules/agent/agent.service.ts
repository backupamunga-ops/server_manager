import { Injectable, Logger, NotImplementedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import { connect as netConnect, type Socket } from 'node:net';
import { AGENT_PROTOCOL_VERSION, type AgentCommand, type AgentOperation, type AgentResponse } from '@cloudlane/contracts';

@Injectable()
export class AgentService {
  private readonly logger = new Logger(AgentService.name);
  private readonly socketPath: string;
  private readonly hmacKey: string;
  private readonly serverId: string;

  constructor(config: ConfigService) {
    this.socketPath = config.get<string>('AGENT_SOCKET_PATH', '/run/cloudlane/agent.sock');
    this.hmacKey = config.get<string>('AGENT_HMAC_KEY', '');
    // In production, serverId is read from the installation identity.
    // The API and agent share this ID — the installer sets it in both env files.
    this.serverId = config.get<string>('INSTANCE_ID', 'inst_local');
  }

  /**
   * Send a typed command to the Go agent over the UNIX socket.
   * Signs with HMAC SHA-256, awaits response with timeout.
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
        message: 'AGENT_HMAC_KEY not set.',
      });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 30_000);

    const unsigned: Omit<AgentCommand, 'signature'> = {
      version: AGENT_PROTOCOL_VERSION,
      commandId: randomUUID(),
      serverId: this.serverId,
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

    this.logger.log(`Sending agent command: op=${operation} resource=${resourceId} cmd=${command.commandId}`);

    // Connect to the UNIX socket and send the command
    const response = await this.sendOverSocket(command);
    this.logger.log(`Agent response: op=${operation} status=${response.status}`);

    if (response.status === 'rejected' || response.status === 'failed') {
      throw new Error(`Agent ${response.status}: ${response.error?.code} — ${response.error?.message}`);
    }

    return response;
  }

  private sendOverSocket(command: AgentCommand): Promise<AgentResponse> {
    return new Promise((resolve, reject) => {
      const socket: Socket = netConnect(this.socketPath);
      const chunks: Buffer[] = [];
      let settled = false;

      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          socket.destroy();
          reject(new Error('Agent socket timeout (30s)'));
        }
      }, 30_000);

      socket.on('connect', () => {
        // Send the command as JSON + newline
        socket.write(JSON.stringify(command) + '\n');
      });

      socket.on('data', (data: Buffer) => {
        chunks.push(data);
        // Check if we have a complete response (ends with newline)
        const all = Buffer.concat(chunks);
        const newlineIdx = all.indexOf('\n');
        if (newlineIdx >= 0) {
          settled = true;
          clearTimeout(timeout);
          const responseStr = all.subarray(0, newlineIdx).toString('utf8');
          socket.destroy();
          try {
            const response = JSON.parse(responseStr) as AgentResponse;
            resolve(response);
          } catch (err) {
            reject(new Error(`Failed to parse agent response: ${(err as Error).message}`));
          }
        }
      });

      socket.on('error', (err: Error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`Agent socket error: ${err.message}`));
        }
      });

      socket.on('close', () => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          // If we have accumulated data, try to parse it
          if (chunks.length > 0) {
            const all = Buffer.concat(chunks);
            try {
              const response = JSON.parse(all.toString('utf8').trim()) as AgentResponse;
              resolve(response);
            } catch {
              reject(new Error('Agent socket closed before complete response'));
            }
          } else {
            reject(new Error('Agent socket closed before response'));
          }
        }
      });
    });
  }

  /**
   * Canonical JSON: keys sorted ascending, no whitespace, UTF-8.
   * Must match the Go agent's canonicalJSON function exactly.
   */
  private canonicalJson(obj: Record<string, unknown>): string {
    const keys = Object.keys(obj).sort();
    const pairs = keys.map(k => JSON.stringify(k) + ':' + JSON.stringify(obj[k]));
    return '{' + pairs.join(',') + '}';
  }
}
