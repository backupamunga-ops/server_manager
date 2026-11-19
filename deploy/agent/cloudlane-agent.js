#!/usr/bin/env node
/**
 * Cloudlane Agent (Node.js runtime shim)
 *
 * Implements the typed agent IPC contract (packages/contracts/src/agent):
 * - UNIX socket at /run/cloudlane/agent.sock
 * - HMAC SHA-256 signed commands, expiry, operation allowlist, forbidden payload patterns
 * - Docker command execution for release lifecycle
 * - Localhost port publishing for service containers
 * - release.activate: per-service Caddy route under /services/{serviceId}/* with atomic reload
 *
 * The Go agent (agent/) is the long-term implementation; this shim provides the
 * same wire contract on hosts without a compiled Go binary.
 *
 * Usage: node cloudlane-agent.js --socket /run/cloudlane/agent.sock --hmac-key-file /etc/cloudlane/agent-hmac.key --instance-id inst_xxx
 */

const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Parse args
const args = process.argv.slice(2);
let socketPath = '/run/cloudlane/agent.sock';
let hmacKeyFile = '/etc/cloudlane/agent-hmac.key';
let instanceId = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--socket') socketPath = args[i + 1];
  if (args[i] === '--hmac-key-file') hmacKeyFile = args[i + 1];
  if (args[i] === '--instance-id') instanceId = args[i + 1];
}

if (!instanceId) {
  console.error('instance-id is required');
  process.exit(1);
}

const hmacKey = fs.readFileSync(hmacKeyFile, 'utf-8').trim();
if (hmacKey.length < 32) {
  console.error('HMAC key must be at least 32 bytes');
  process.exit(1);
}

// Allowed operations (mirror of packages/contracts/src/agent + Go allowlist)
const ALLOWED_OPS = new Set([
  'release.startCandidate',
  'release.stop',
  'release.inspect',
  'release.activate',
  'caddy.reload',
  'caddy.validate',
  'volume.create',
  'volume.delete',
]);

// Forbidden payload patterns (mirror of Go agent)
const FORBIDDEN = [
  'sh -c',
  'sudo ',
  '/bin/sh',
  '/bin/bash',
  '--privileged',
  'docker.sock',
  '/var/run/docker',
  'hostPath',
  ':/host',
  ':/root',
  ':/etc',
  ':/var/lib/cloudlane',
];

// ---------------------------------------------------------------------------
// State: per-service runtime mapping (serviceId -> { deploymentId, port, containerId })
// ---------------------------------------------------------------------------
const STATE_DIR = '/var/lib/cloudlane/agent';
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const CADDY_SERVICES_DIR = '/etc/caddy/services';
const PANEL_CADDYFILE = '/etc/caddy/Caddyfile';
const PORT_RANGE_START = 4101;
const PORT_RANGE_END = 4999;

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) {
    return { services: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), { mode: 0o600 });
}

function allocPort(state) {
  const used = new Set(
    Object.values(state.services)
      .map((s) => s.port)
      .filter(Boolean),
  );
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!used.has(p)) return p;
  }
  throw { message: 'no free localhost ports in agent range', code: 'PORT_EXHAUSTED' };
}

// ---------------------------------------------------------------------------
// Command execution helpers
// ---------------------------------------------------------------------------
function dockerExec(args) {
  return new Promise((resolve, reject) => {
    execFile(
      'docker',
      args,
      { timeout: 120000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject({ message: stderr || err.message, code: 'DOCKER_ERROR' });
        else resolve(stdout.trim());
      },
    );
  });
}

function caddyExec(args) {
  return new Promise((resolve, reject) => {
    execFile('caddy', args, { timeout: 15000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject({ message: stderr || err.message, code: 'CADDY_ERROR' });
      else resolve(stdout.trim());
    });
  });
}

// ---------------------------------------------------------------------------
// IPC protocol (same canonical JSON + HMAC as the Go agent)
// ---------------------------------------------------------------------------
function canonicalJson(obj) {
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

function computeHmac(canonical, key) {
  return crypto.createHmac('sha256', key).update(canonical).digest('hex');
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf-8');
  const bb = Buffer.from(String(b), 'utf-8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Process a command
async function processCommand(cmd) {
  const now = new Date().toISOString();

  // Validate version
  if (cmd.version !== 1) {
    return {
      commandId: cmd.commandId,
      status: 'rejected',
      error: { code: 'PAYLOAD_INVALID', message: 'unsupported version' },
      observedAt: now,
    };
  }

  // Validate server ID
  if (cmd.serverId !== instanceId) {
    return {
      commandId: cmd.commandId,
      status: 'rejected',
      error: { code: 'SERVER_ID_MISMATCH', message: 'serverId mismatch' },
      observedAt: now,
    };
  }

  // Validate expiry
  const expiresAt = new Date(cmd.expiresAt);
  if (Date.now() > expiresAt.getTime()) {
    return {
      commandId: cmd.commandId,
      status: 'rejected',
      error: { code: 'EXPIRED', message: 'command expired' },
      observedAt: now,
    };
  }

  // Verify signature
  const unsigned = {
    version: cmd.version,
    commandId: cmd.commandId,
    serverId: cmd.serverId,
    workspaceId: cmd.workspaceId,
    operation: cmd.operation,
    resourceId: cmd.resourceId,
    payload: cmd.payload,
    issuedAt: cmd.issuedAt,
    expiresAt: cmd.expiresAt,
  };
  const expected = computeHmac(canonicalJson(unsigned), hmacKey);
  if (!timingSafeEqual(expected, cmd.signature)) {
    console.log(`REJECTED signature_invalid cmd=${cmd.commandId} op=${cmd.operation}`);
    return {
      commandId: cmd.commandId,
      status: 'rejected',
      error: { code: 'SIGNATURE_INVALID', message: 'signature failed' },
      observedAt: now,
    };
  }

  // Check operation allowlist
  if (!ALLOWED_OPS.has(cmd.operation)) {
    console.log(`REJECTED operation_not_allowed cmd=${cmd.commandId} op=${cmd.operation}`);
    return {
      commandId: cmd.commandId,
      status: 'rejected',
      error: {
        code: 'OPERATION_NOT_ALLOWED',
        message: `operation ${cmd.operation} not allowlisted`,
      },
      observedAt: now,
    };
  }

  // Check forbidden patterns
  const payloadStr = JSON.stringify(cmd.payload);
  for (const f of FORBIDDEN) {
    if (payloadStr.includes(f)) {
      console.log(`REJECTED payload_invalid cmd=${cmd.commandId} op=${cmd.operation}`);
      return {
        commandId: cmd.commandId,
        status: 'rejected',
        error: { code: 'PAYLOAD_INVALID', message: 'forbidden pattern detected' },
        observedAt: now,
      };
    }
  }

  // Execute the operation
  try {
    let result;
    const p = cmd.payload;

    switch (cmd.operation) {
      case 'release.startCandidate': {
        const state = loadState();
        const deploymentId = cmd.resourceId;
        const serviceId = p.serviceId || cmd.resourceId;
        const containerName = `cloudlane-svc-${deploymentId}`;

        // Idempotent (re)start of the same deployment container
        try {
          await dockerExec(['rm', '-f', containerName]);
        } catch (e) {}

        const port = allocPort(state);
        const dockerArgs = [
          'run',
          '-d',
          '--name',
          containerName,
          '--restart',
          'unless-stopped',
          '--security-opt',
          'no-new-privileges',
          '--pids-limit',
          '100',
        ];

        if (p.memoryLimitMiB > 0) dockerArgs.push('--memory', `${p.memoryLimitMiB}m`);
        if (p.cpuLimit > 0) dockerArgs.push('--cpus', String(p.cpuLimit));
        dockerArgs.push('--network', 'cloudlane-internal');

        // Volume mounts
        if (p.volumeIds) {
          for (const volId of p.volumeIds) {
            dockerArgs.push('-v', `${volId}:/data`);
          }
        }

        // Static artifact mount
        if (p.staticArtifactPath) {
          dockerArgs.push('-v', `${p.staticArtifactPath}:/srv:ro`);
        }

        // Publish on localhost only; the panel Caddy routes the public path
        dockerArgs.push('-p', `127.0.0.1:${port}:${p.internalPort || 80}`);

        dockerArgs.push(p.imageRef || 'caddy:2-alpine');

        // Command for static file serving
        if (p.staticArtifactPath) {
          dockerArgs.push(
            'caddy',
            'file-server',
            '--listen',
            `:${p.internalPort || 80}`,
            '--root',
            '/srv',
          );
        }

        const containerId = await dockerExec(dockerArgs);
        state.services[serviceId] = {
          deploymentId,
          port,
          containerId: containerId.substring(0, 12),
          containerName,
        };
        saveState(state);
        result = {
          containerId: containerId.substring(0, 12),
          containerName,
          port,
          state: 'started',
        };
        break;
      }

      case 'release.activate': {
        const state = loadState();
        const serviceId = p.serviceId || cmd.resourceId;
        const deploymentId = p.deploymentId;
        const port = p.port;

        if (!serviceId || !deploymentId || !port) {
          throw {
            message: 'serviceId, deploymentId and port are required',
            code: 'PAYLOAD_INVALID',
          };
        }

        const prev = state.services[serviceId];
        // Stop the container of the previously active deployment (atomic swap)
        if (prev && prev.deploymentId !== deploymentId && prev.containerName) {
          try {
            await dockerExec(['rm', '-f', prev.containerName]);
          } catch (e) {}
        }

        // Write the per-service Caddy route and reload atomically
        fs.mkdirSync(CADDY_SERVICES_DIR, { recursive: true, mode: 0o755 });
        const snippetPath = path.join(CADDY_SERVICES_DIR, `${serviceId}.caddy`);
        const snippet = [
          `# Cloudlane managed route for service ${serviceId} (deployment ${deploymentId})`,
          `handle /services/${serviceId}/* {`,
          `  uri strip_prefix /services/${serviceId}`,
          `  reverse_proxy 127.0.0.1:${port}`,
          '}',
          '',
        ].join('\n');
        const tmpPath = `${snippetPath}.tmp`;
        fs.writeFileSync(tmpPath, snippet, { mode: 0o644 });
        fs.renameSync(tmpPath, snippetPath); // atomic swap on same filesystem

        await caddyExec(['validate', '--config', PANEL_CADDYFILE, '--adapter', 'caddyfile']);
        await caddyExec(['reload', '--config', PANEL_CADDYFILE, '--adapter', 'caddyfile']);

        state.services[serviceId] = {
          ...(state.services[serviceId] || {}),
          deploymentId,
          port,
          activeRoute: `/services/${serviceId}/`,
        };
        saveState(state);

        result = { url: `/services/${serviceId}/`, port, activated: true };
        break;
      }

      case 'release.stop': {
        const containerId = p.containerId;
        try {
          await dockerExec(['stop', '-t', '10', containerId]);
        } catch (e) {}
        try {
          await dockerExec(['rm', '-f', containerId]);
        } catch (e) {}
        result = { stopped: true };
        break;
      }

      case 'release.inspect': {
        const containerName = p.containerName || `cloudlane-svc-${cmd.resourceId}`;
        try {
          const inspect = await dockerExec(['inspect', '--format', '{{json .}}', containerName]);
          const info = JSON.parse(inspect);
          result = {
            containerId: info.Id ? info.Id.substring(0, 12) : undefined,
            containerName: info.Name ? info.Name.replace('/', '') : undefined,
            state: info.State?.Status || 'unknown',
            healthStatus:
              info.State?.Health?.Status ||
              (info.State && info.State.Status === 'running' ? 'healthy' : 'unknown'),
          };
        } catch (e) {
          result = { state: 'not_found', healthStatus: 'unknown' };
        }
        break;
      }

      case 'caddy.validate': {
        await caddyExec(['validate', '--config', p.configPath, '--adapter', 'caddyfile']);
        result = { valid: true };
        break;
      }

      case 'caddy.reload': {
        await caddyExec(['validate', '--config', p.configPath, '--adapter', 'caddyfile']);
        await caddyExec(['reload', '--config', p.configPath, '--adapter', 'caddyfile']);
        result = { reloaded: true };
        break;
      }

      case 'volume.create': {
        const volName = `cloudlane-vol-${p.volumeId}`;
        await dockerExec(['volume', 'create', '--label', 'cloudlane.managed=true', volName]);
        result = { created: true, volume: volName };
        break;
      }

      case 'volume.delete': {
        const volName = `cloudlane-vol-${p.volumeId}`;
        await dockerExec(['volume', 'rm', volName]);
        result = { deleted: true };
        break;
      }

      default:
        throw { message: `unhandled operation: ${cmd.operation}`, code: 'INTERNAL_ERROR' };
    }

    console.log(`COMPLETED cmd=${cmd.commandId} op=${cmd.operation} resource=${cmd.resourceId}`);
    return {
      commandId: cmd.commandId,
      status: 'completed',
      result,
      observedAt: new Date().toISOString(),
    };
  } catch (err) {
    console.log(`FAILED cmd=${cmd.commandId} op=${cmd.operation} err=${err.message}`);
    return {
      commandId: cmd.commandId,
      status: 'failed',
      error: { code: err.code || 'INTERNAL_ERROR', message: err.message },
      observedAt: new Date().toISOString(),
    };
  }
}

// Create UNIX socket server
const dir = path.dirname(socketPath);
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o770 });

// Remove stale socket
try {
  fs.unlinkSync(socketPath);
} catch (e) {}

const server = net.createServer((socket) => {
  let buffer = '';

  socket.on('data', async (data) => {
    buffer += data.toString('utf-8');

    // Process complete lines (commands end with newline)
    while (buffer.includes('\n')) {
      const idx = buffer.indexOf('\n');
      const line = buffer.substring(0, idx);
      buffer = buffer.substring(idx + 1);

      if (!line.trim()) continue;

      try {
        const cmd = JSON.parse(line);
        const response = await processCommand(cmd);
        socket.write(`${JSON.stringify(response)}\n`);
      } catch (e) {
        socket.write(
          `${JSON.stringify({
            status: 'rejected',
            error: { code: 'PAYLOAD_INVALID', message: 'malformed JSON' },
            observedAt: new Date().toISOString(),
          })}\n`,
        );
      }
    }
  });

  socket.on('error', () => {});
});

server.listen(socketPath, () => {
  fs.chmodSync(socketPath, 0o660);
  console.log(`cloudlane-agent listening on ${socketPath} (instance=${instanceId})`);
  console.log(`allowlisted operations: ${ALLOWED_OPS.size}`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  process.exit(1);
});
