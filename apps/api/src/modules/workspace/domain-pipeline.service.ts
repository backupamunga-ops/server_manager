/**
 * Domain pipeline — the REAL VPS work behind the central domain registry.
 *
 * Replaces the "(demo)" simulations in workspace.service.ts for the domain
 * actions. Runs on the VPS itself (cloudlane-api is a local systemd service),
 * so host command execution follows the deployer pattern used by
 * deploy/agent/cloudlane-agent.js: promisified execFile with argument ARRAYS
 * (never a shell string), timeouts and capped output buffers.
 *
 * Capabilities:
 *  - verifyTxt:      `dig +short TXT _cloudlane.<domain>` against the zone's
 *                    expected verification token (registry convention; the
 *                    DomainsService "domains" module keeps its own
 *                    `_cloudlane-challenge` convention for the legacy model).
 *  - routeFor:       writes the per-service Caddy route file in the EXACT
 *                    format of the agent release flow
 *                    (deploy/agent/cloudlane-agent.js → release.activate →
 *                    /etc/caddy/services/<serviceId>.caddy) and reloads Caddy.
 *  - removeRoute:    deletes the route file(s) of a hostname and reloads.
 *  - httpsStatus:    route existence + real TLS handshake probe (peer
 *                    certificate inspection, the node:tls equivalent of
 *                    `openssl s_client -servername <host>`).
 *  - Managed DNS:    NOT attempted (no authoritative nameservers on this VPS).
 *                    Enforced in code: managed transitions stay pending until
 *                    real NS infrastructure exists; callers get a structured
 *                    explanation instead of a silent simulation.
 *  - Mailboxes:      registry metadata only — nothing physical is created,
 *                    started or exposed here (no mail transport).
 *
 * Route file layout note: the live /etc/caddy/Caddyfile imports
 * `import /etc/caddy/services/*.caddy` INSIDE the panel IP site block, so
 * service route files must be inner directive snippets (exactly like the
 * agent writes them). Hostname-routed custom domains need a TOP-LEVEL import
 * of a hostnames directory; routeFor detects that capability and writes a
 * hostname site block when (and only when) the Caddyfile declares it.
 */
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { connect as tlsConnect } from 'node:tls';
import { promisify } from 'node:util';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';

const execFileAsync = promisify(execFile);

// ─── Paths (env-overridable for tests; defaults match the live installation) ───
const CADDY_CONFIG = process.env.CADDY_CONFIG_PATH ?? '/etc/caddy/Caddyfile';
const CADDY_SERVICES_DIR = process.env.CADDY_SERVICES_DIR ?? '/etc/caddy/services';
const CADDY_HOSTNAMES_DIR = process.env.CADDY_HOSTNAMES_DIR ?? '/etc/caddy/hostnames';
const AGENT_STATE_FILE = process.env.AGENT_STATE_FILE ?? '/var/lib/cloudlane/agent/state.json';
/** Set DOMAIN_PIPELINE_DRY_RUN=1 to plan writes/reloads without touching the host. */
const DRY_RUN = ['1', 'true', 'yes'].includes(
  (process.env.DOMAIN_PIPELINE_DRY_RUN ?? '').toLowerCase(),
);

// ─── Validation ───
// Full domain/hostname (lowercase, no wildcard, no trailing dot). Zones use the
// same shape; the workspace service additionally rejects underscores per-label.
const HOSTNAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
// Service/hostname identifiers may become file names — restrict to safe chars.
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export interface TxtVerificationResult {
  domain: string;
  /** FQDN that was queried. */
  challengeName: string;
  verified: boolean;
  /** Normalized (unquoted) TXT values found at the challenge name. */
  found: string[];
  expectedToken?: string;
  /** Set when the lookup itself failed (timeout, resolver error). */
  error?: string;
}

export interface AgentServiceRuntime {
  deploymentId?: string;
  port?: number;
  containerId?: string;
}

export interface RouteResult {
  hostname: string;
  serviceId: string;
  port: number;
  routeStyle: 'hostname' | 'service';
  routeFile: string;
  /** Public route the hostname is served under. */
  routePath: string;
  reloaded: boolean;
  dryRun?: boolean;
  /** Present when dry-run: the snippet that would be written. */
  snippet?: string;
}

export interface RemoveRouteResult {
  hostname: string;
  removed: string[];
  reloaded: boolean;
  dryRun?: boolean;
}

export interface HttpsStatusResult {
  hostname: string;
  routed: boolean;
  https: boolean;
  routeStyle?: 'hostname' | 'service';
  routeFile?: string | null;
  certificate?: {
    subject?: string;
    issuer?: string;
    validTo?: string;
    matchesHostname: boolean;
  } | null;
  detail?: string;
}

export interface ManagedDnsExplanation {
  supported: false;
  code: 'MANAGED_DNS_UNAVAILABLE';
  message: string;
  whatManagedModeWouldDo: string[];
  requiredInfrastructure: string[];
  interimGuidance: string[];
}

export interface DnsModeTransition {
  target: string;
  allowed: boolean;
  /** True when the caller must keep pendingDnsMode set (transition stays pending). */
  holdPending: boolean;
  explanation?: ManagedDnsExplanation;
}

export interface DnsRecordGuideEntry {
  type: string;
  fqdn: string;
  value: string;
  ttl: number;
  priority?: number;
  instruction: string;
}

export interface DnsRecordGuide {
  zone: string;
  checklist: string[];
  records: DnsRecordGuideEntry[];
  verification: {
    type: 'TXT';
    name: string;
    purpose: string;
  };
}

interface AgentState {
  services?: Record<string, AgentServiceRuntime>;
}

@Injectable()
export class DomainPipelineService {
  private readonly logger = new Logger(DomainPipelineService.name);

  // ───────────────────────────────────────────────────────────────────────────
  // 1. TXT verification (real dig on the VPS resolver)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Run `dig +short TXT _cloudlane.<domain>` on the VPS and check the zone's
   * expected verification token. Follows the deployer command-execution
   * pattern (argument array, no shell, timeout, capped buffer), so the token
   * can never be interpreted by a shell.
   */
  async verifyTxt(domainInput: string, expectedToken: string): Promise<TxtVerificationResult> {
    const domain = this.normalizeHostname(domainInput, 'domain');
    if (!expectedToken.trim()) {
      throw new BadRequestException('The zone has no expected verification token.');
    }
    const challengeName = `_cloudlane.${domain}`;

    let stdout = '';
    let error: string | undefined;
    try {
      const res = await execFileAsync('dig', ['+short', 'TXT', challengeName], {
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      });
      stdout = res.stdout;
    } catch (err) {
      const e = err as Error & { killed?: boolean };
      error = e.killed ? `dig timed out for ${challengeName}` : `dig failed: ${e.message}`;
      this.logger.warn(`verifyTxt lookup problem: ${error}`);
    }

    // dig prints one line per TXT record, each line = quoted chunks.
    const found = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => this.unquoteTxtLine(line));

    return {
      domain,
      challengeName,
      verified: found.includes(expectedToken.trim()),
      found,
      expectedToken: expectedToken.trim(),
      error,
    };
  }

  /**
   * Resolve the zone's expected token: the registry convention stores it as a
   * TXT record named `_cloudlane` on the zone (created by `registerDomain`).
   * Pass the zone's dnsRecord rows here; the caller does the Prisma query.
   */
  resolveZoneToken(records: Array<{ type: string; name: string; value: string }>): string | null {
    const rec = records.find(
      (r) => r.type === 'TXT' && (r.name === '_cloudlane' || r.name.endsWith('._cloudlane')),
    );
    return rec ? rec.value : null;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 2. Caddy routing (routeFor / removeRoute)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Bind `hostname` to the service's container port by writing the Caddy
   * per-service route file and reloading Caddy — the same pipeline the agent
   * release flow uses on `release.activate`.
   *
   * Route style is decided by the live Caddyfile:
   *  - 'hostname': the Caddyfile has a top-level `import <hostnames-dir>/*.caddy`
   *    → a site block routing the hostname itself (Caddy obtains a real
   *    certificate for it).
   *  - 'service' (current live layout): the exact agent format
   *    `/etc/caddy/services/<serviceId>.caddy` with a path-based
   *    `handle /services/<serviceId>/*` route under the panel IP site
   *    (served with the panel's Let's Encrypt IP certificate).
   */
  async routeFor(
    hostnameInput: string,
    service: { id: string; name?: string },
  ): Promise<RouteResult> {
    const hostname = this.normalizeHostname(hostnameInput, 'hostname');
    const serviceId = String(service.id ?? '');
    if (!ID_RE.test(serviceId)) {
      throw new BadRequestException('Invalid service identifier.');
    }

    const runtime = await this.readServiceRuntime(serviceId);
    const port = runtime.port ?? 0;
    const deploymentId = runtime.deploymentId ?? 'unknown';
    if (!port) {
      throw new BadRequestException(
        `Service ${service.name ?? serviceId} has no running container with a published port. Deploy it first.`,
      );
    }

    const hostnameCapable = await this.hasTopLevelHostnameImport();
    const style: 'hostname' | 'service' = hostnameCapable ? 'hostname' : 'service';
    const routeFile =
      style === 'hostname'
        ? `${CADDY_HOSTNAMES_DIR}/${hostname}.caddy`
        : `${CADDY_SERVICES_DIR}/${serviceId}.caddy`;

    // EXACT format of the agent release flow (deploy/agent/cloudlane-agent.js).
    const snippet =
      style === 'hostname'
        ? [
            `# Cloudlane managed hostname route for ${hostname} (service ${serviceId})`,
            `${hostname} {`,
            `  reverse_proxy 127.0.0.1:${port}`,
            '}',
            '',
          ].join('\n')
        : [
            `# Cloudlane managed route for service ${serviceId} (deployment ${deploymentId})`,
            `handle /services/${serviceId}/* {`,
            `  uri strip_prefix /services/${serviceId}`,
            `  reverse_proxy 127.0.0.1:${port}`,
            '}',
            '',
          ].join('\n');

    if (DRY_RUN) {
      this.logger.log(`DRY-RUN routeFor ${hostname} → ${serviceId}:${port} (${routeFile})`);
      return {
        hostname,
        serviceId,
        port,
        routeStyle: style,
        routeFile,
        routePath: style === 'hostname' ? `https://${hostname}/` : `/services/${serviceId}/`,
        reloaded: false,
        dryRun: true,
        snippet,
      };
    }

    await mkdir(CADDY_HOSTNAMES_DIR, { recursive: true, mode: 0o755 });
    await mkdir(CADDY_SERVICES_DIR, { recursive: true, mode: 0o755 });
    // Atomic swap on the same filesystem (agent pattern: tmp file + rename).
    const tmpPath = `${routeFile}.tmp`;
    await writeFile(tmpPath, snippet, { mode: 0o644 });
    await rename(tmpPath, routeFile);

    await this.reloadCaddy();
    this.logger.log(
      `Route activated: ${hostname} → 127.0.0.1:${port} (${style} style, ${routeFile})`,
    );

    return {
      hostname,
      serviceId,
      port,
      routeStyle: style,
      routeFile,
      routePath: style === 'hostname' ? `https://${hostname}/` : `/services/${serviceId}/`,
      reloaded: true,
    };
  }

  /**
   * Delete the route file(s) for a hostname and reload Caddy. Pass serviceId
   * when the host uses the service-style path route (file is named after the
   * service, not the hostname). Idempotent: missing files are ignored.
   */
  async removeRoute(hostnameInput: string, serviceId?: string): Promise<RemoveRouteResult> {
    const hostname = this.normalizeHostname(hostnameInput, 'hostname');
    const removed: string[] = [];
    const candidates = [`${CADDY_HOSTNAMES_DIR}/${hostname}.caddy`];
    const svc = serviceId ? String(serviceId) : '';
    if (svc && ID_RE.test(svc)) candidates.push(`${CADDY_SERVICES_DIR}/${svc}.caddy`);

    for (const file of candidates) {
      if (await this.fileExists(file)) {
        if (!DRY_RUN) await rm(file, { force: true });
        removed.push(file);
      }
    }

    if (DRY_RUN) {
      return { hostname, removed, reloaded: false, dryRun: true };
    }
    let reloaded = false;
    if (removed.length > 0) {
      await this.reloadCaddy();
      reloaded = true;
      this.logger.log(`Routes removed for ${hostname}: ${removed.join(', ')}`);
    }
    return { hostname, removed, reloaded };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 3. HTTPS status
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Check whether the hostname's route exists and whether Caddy obtained a
   * certificate for it. The TLS probe performs a real handshake against the
   * local Caddy (node:tls peer-certificate inspection — the equivalent of
   * `openssl s_client -connect 127.0.0.1:443 -servername <hostname>`) and
   * requires the presented certificate to actually cover the hostname.
   * Under the current IP-site layout the panel's LE IP certificate is served
   * for unknown SNI values, which does NOT count as HTTPS for the hostname.
   */
  async httpsStatus(hostnameInput: string, serviceId?: string): Promise<HttpsStatusResult> {
    const hostname = this.normalizeHostname(hostnameInput, 'hostname');
    const svc = serviceId ? String(serviceId) : '';

    const hostnameFile = `${CADDY_HOSTNAMES_DIR}/${hostname}.caddy`;
    const serviceFile = svc && ID_RE.test(svc) ? `${CADDY_SERVICES_DIR}/${svc}.caddy` : null;

    let routeStyle: 'hostname' | 'service' | undefined;
    let routeFile: string | null = null;
    if (await this.fileExists(hostnameFile)) {
      routeStyle = 'hostname';
      routeFile = hostnameFile;
    } else if (serviceFile && (await this.fileExists(serviceFile))) {
      routeStyle = 'service';
      routeFile = serviceFile;
    }

    if (!routeFile) {
      return {
        hostname,
        routed: false,
        https: false,
        certificate: null,
        detail: 'No route file for this hostname.',
      };
    }

    const probe = await this.tlsProbe(hostname);
    return {
      hostname,
      routed: true,
      https: probe.matchesHostname,
      routeStyle,
      routeFile,
      certificate: probe.certificate,
      detail: probe.detail,
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // 4. DNS mode governance + manual-DNS guide
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Managed DNS mode is NOT supported: this installation runs no authoritative
   * nameservers. Callers (dnsModePrepare) must keep managed transitions in
   * pendingDnsMode and use this explanation as the user-facing reason.
   */
  managedDnsExplanation(): ManagedDnsExplanation {
    return {
      supported: false,
      code: 'MANAGED_DNS_UNAVAILABLE',
      message:
        'Managed DNS is not available on this installation yet. The platform runs no authoritative ' +
        'nameservers, so records for this zone cannot be served directly. Your switch to managed ' +
        'DNS is recorded and stays pending; nothing was changed on the VPS.',
      whatManagedModeWouldDo: [
        'Publish the zone from Cloudlane-run authoritative nameservers (NS records at your registrar).',
        'Apply every DnsRecord row in the registry to the live zone automatically.',
        'Provision and renew TLS certificates for hostnames without manual A/CNAME records.',
      ],
      requiredInfrastructure: [
        'At least two authoritative nameserver hosts with the zone data replicated.',
        'Registrar NS delegation for the zone.',
        'DNSSEC signing and zone transfer (AXFR) between the nameserver pair.',
      ],
      interimGuidance: [
        'Keep the zone in manual DNS mode and publish records at your current DNS provider.',
        'Use the DNS record checklist for the exact records to publish.',
        'Managed-mode changes remain pending in the registry and can be cancelled at any time.',
      ],
    };
  }

  /**
   * Evaluate a dnsModePrepare transition. 'manual' is always allowed (external
   * DNS is the supported mode). 'managed' is refused with the explanation
   * object — the caller keeps pendingDnsMode='managed' set (pending) instead
   * of flipping dnsMode.
   */
  evaluateDnsModeTransition(
    zone: { dnsMode: string; pendingDnsMode?: string | null },
    target: string,
  ): DnsModeTransition {
    if (target === 'manual') {
      return { target, allowed: true, holdPending: false };
    }
    if (target === 'managed') {
      return {
        target,
        allowed: false,
        holdPending: true,
        explanation: this.managedDnsExplanation(),
      };
    }
    return {
      target,
      allowed: false,
      holdPending: false,
      explanation: {
        ...this.managedDnsExplanation(),
        code: 'MANAGED_DNS_UNAVAILABLE',
        message: `Unknown DNS mode "${target}". Supported targets: manual, managed (pending only).`,
      },
    };
  }

  /**
   * Manual-DNS checklist for the registry's DnsRecord rows. Server-side source
   * of truth for what the client shows; safe to render directly.
   */
  dnsRecordGuide(
    zoneName: string,
    records: Array<{
      type: string;
      name: string;
      value: string;
      ttl: number;
      priority?: number | null;
    }>,
  ): DnsRecordGuide {
    const zone = zoneName.toLowerCase();
    const entries = records.map((r) => {
      const fqdn = this.fqdn(r.name, zone);
      const value =
        r.priority !== null && r.priority !== undefined && r.type === 'MX'
          ? `${r.priority} ${r.value}`
          : r.value;
      return {
        type: r.type,
        fqdn,
        value: r.value,
        ttl: r.ttl,
        priority: r.priority ?? undefined,
        instruction: `Publish a ${r.type} record for ${fqdn} → "${value}" (TTL ${r.ttl}) at your DNS provider.`,
      };
    });
    return {
      zone,
      checklist: [
        `1. Point the zone at this server: ${zone} A <this-server-IPv4> (and AAAA for IPv6).`,
        `2. Prove ownership: publish TXT _cloudlane.${zone} with the verification token shown in the panel.`,
        ...entries.map((e, i) => `${i + 3}. ${e.instruction}`),
        'Changes propagate within the TTL you chose; re-run Verify to re-check.',
      ],
      records: entries,
      verification: {
        type: 'TXT',
        name: `_cloudlane.${zone}`,
        purpose: 'Proves control of the zone for verification (checked with dig on the VPS).',
      },
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Private helpers — deployer command pattern (execFile, no shell)
  // ───────────────────────────────────────────────────────────────────────────

  private normalizeHostname(input: string, label: string): string {
    const host = String(input ?? '')
      .trim()
      .toLowerCase()
      .replace(/\.$/, '');
    if (!HOSTNAME_RE.test(host) || host.length > 253) {
      throw new BadRequestException(`Enter a valid ${label} (lowercase DNS name).`);
    }
    return host;
  }

  /** dig returns quoted, space-separated chunks; normalize to one value per record. */
  private unquoteTxtLine(line: string): string {
    const matches = line.matchAll(/"((?:[^"\\]|\\.)*)"/g);
    const chunks = [...matches].map((m) => m[1].replace(/\\(.)/g, '$1'));
    return chunks.length > 0 ? chunks.join('') : line.replace(/^"|"$/g, '');
  }

  /** serviceId → { deploymentId, port } from the agent's runtime state file. */
  private async readServiceRuntime(serviceId: string): Promise<AgentServiceRuntime> {
    try {
      const raw = await readFile(AGENT_STATE_FILE, 'utf-8');
      const state = JSON.parse(raw) as AgentState;
      return state.services?.[serviceId] ?? {};
    } catch (err) {
      this.logger.warn(`Cannot read agent state (${AGENT_STATE_FILE}): ${(err as Error).message}`);
      return {};
    }
  }

  /**
   * Hostname-routing capability: the Caddyfile must import the hostnames
   * directory at TOP LEVEL (column 0). The live file imports only
   * /etc/caddy/services inside the panel IP site block, so only inner
   * directive snippets are valid there.
   */
  private async hasTopLevelHostnameImport(): Promise<boolean> {
    try {
      const caddyfile = await readFile(CADDY_CONFIG, 'utf-8');
      return caddyfile
        .split('\n')
        .some(
          (line) =>
            /^import\s+\S*hostnames\/\*\.caddy\s*$/.test(line.trimStart()) &&
            line.startsWith('import'),
        );
    } catch {
      return false;
    }
  }

  /** Validate + reload. `systemctl reload caddy` first (unit ExecReload), direct caddy reload as fallback. */
  private async reloadCaddy(): Promise<void> {
    try {
      await execFileAsync(
        'caddy',
        ['validate', '--config', CADDY_CONFIG, '--adapter', 'caddyfile'],
        {
          timeout: 20_000,
          maxBuffer: 1024 * 1024,
        },
      );
    } catch (err) {
      throw new BadRequestException(
        `Caddy config validation failed after the route change: ${(err as Error).message}`,
      );
    }
    try {
      await execFileAsync('systemctl', ['reload', 'caddy'], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
    } catch {
      // Fallback mirrors the agent shim's reload exactly.
      await execFileAsync('caddy', ['reload', '--config', CADDY_CONFIG, '--adapter', 'caddyfile'], {
        timeout: 20_000,
        maxBuffer: 1024 * 1024,
      });
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  /** `_cloudlane` / `@` / bare label / already-FQDN → fully qualified name. */
  private fqdn(name: string, zone: string): string {
    const n = name.trim().toLowerCase().replace(/\.$/, '');
    if (n === '@' || n === zone) return zone;
    if (n === '_cloudlane') return `_cloudlane.${zone}`;
    if (n.endsWith(`.${zone}`)) return n;
    return `${n}.${zone}`;
  }

  /**
   * Real TLS handshake against local Caddy with SNI=hostname. Resolves with
   * the peer certificate and whether it covers the hostname.
   */
  private async tlsProbe(hostname: string): Promise<{
    matchesHostname: boolean;
    certificate: HttpsStatusResult['certificate'];
    detail?: string;
  }> {
    return new Promise((resolve) => {
      let settled = false;
      const done = (r: {
        matchesHostname: boolean;
        certificate: HttpsStatusResult['certificate'];
        detail?: string;
      }) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const socket = tlsConnect({
        host: '127.0.0.1',
        port: 443,
        servername: hostname,
        rejectUnauthorized: false, // we only inspect; trust decision is the SAN match below
      });
      socket.setTimeout(5000);
      socket.on('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        socket.destroy();
        if (!cert || Object.keys(cert).length === 0) {
          done({ matchesHostname: false, certificate: null, detail: 'No certificate presented.' });
          return;
        }
        const san = String(cert.subjectaltname ?? '');
        const matches = san
          .split(', ')
          .some((entry) => entry.trim().toLowerCase() === `dns:${hostname}`);
        done({
          matchesHostname: matches,
          certificate: {
            subject: cert.subject?.CN,
            issuer: cert.issuer?.O ?? cert.issuer?.CN,
            validTo: cert.valid_to,
            matchesHostname: matches,
          },
          detail: matches
            ? `Certificate covers ${hostname}.`
            : `Certificate served (${cert.subject?.CN ?? 'unknown subject'}) does not cover ${hostname}.`,
        });
      });
      socket.on('timeout', () => {
        socket.destroy();
        done({ matchesHostname: false, certificate: null, detail: 'TLS handshake timed out.' });
      });
      socket.on('error', (err) => {
        done({
          matchesHostname: false,
          certificate: null,
          detail: `TLS handshake failed: ${err.message}`,
        });
      });
    });
  }
}
