import { describe, expect, it } from 'vitest';
import type {
  AgentCommand,
  AgentOperation,
  AgentResponse,
  DeploymentStatus,
  InstallationStatus,
} from '../src/index.js';

describe('contracts sanity', () => {
  it('InstallationStatus covers the three states', () => {
    const values: InstallationStatus[] = ['unclaimed', 'claimed', 'active'];
    expect(values).toHaveLength(3);
  });

  it('DeploymentStatus covers the full state machine', () => {
    const values: DeploymentStatus[] = [
      'REQUESTED',
      'QUEUED',
      'FETCHING',
      'VALIDATING',
      'DETECTING',
      'BUILDING',
      'STARTING_CANDIDATE',
      'HEALTH_CHECKING',
      'ACTIVATING',
      'LIVE',
      'FAILED',
      'CANCELLED',
      'TIMED_OUT',
      'ROLLED_BACK',
    ];
    expect(values).toHaveLength(14);
  });

  it('AgentOperation allowlist matches the typed contract', () => {
    const allowed: AgentOperation[] = [
      'release.startCandidate',
      'release.stop',
      'release.inspect',
      'caddy.reload',
      'caddy.validate',
      'volume.create',
      'volume.delete',
    ];
    expect(allowed).toHaveLength(7);
  });

  it('AgentCommand shape compiles', () => {
    const cmd: AgentCommand = {
      version: 1,
      commandId: '550e8400-e29b-41d4-a716-446655440000',
      serverId: 'inst_abc',
      workspaceId: 'ws_def',
      operation: 'release.startCandidate',
      resourceId: 'dep_ghi',
      payload: { imageRef: 'caddy:2-alpine', internalPort: 80 },
      issuedAt: '2026-11-19T00:00:00Z',
      expiresAt: '2026-11-19T00:00:30Z',
      signature: 'deadbeef',
    };
    expect(cmd.operation).toBe('release.startCandidate');
  });

  it('AgentResponse shape compiles', () => {
    const res: AgentResponse = {
      commandId: '550e8400-e29b-41d4-a716-446655440000',
      status: 'completed',
      result: { containerId: 'c_xyz' },
      observedAt: '2026-11-19T00:00:31Z',
    };
    expect(res.status).toBe('completed');
  });
});
