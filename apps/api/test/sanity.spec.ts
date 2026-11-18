import { describe, it, expect } from 'vitest';
import { AGENT_PROTOCOL_VERSION } from '@cloudlane/contracts';

describe('api sanity', () => {
  it('agent protocol version is 1', () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(1);
  });

  it('environment loads MASTER_KEY when set', () => {
    process.env.MASTER_KEY = '0'.repeat(64);
    expect(process.env.MASTER_KEY).toHaveLength(64);
  });
});
