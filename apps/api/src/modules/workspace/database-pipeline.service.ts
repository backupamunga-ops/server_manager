/**
 * DatabasePipelineService — the REAL database pipeline behind the Cloudlane
 * panel's database features (createDatabase, dbUserAdd, dbPrivileges,
 * toggleDbUser, rotateDbUser, rotateDb, backupDb, connection info).
 *
 * Command path (why this file shells out to `docker` directly):
 *   The sanctioned IPC path to the host is AgentService (HMAC-signed JSON over
 *   /run/cloudlane/agent.sock), but the deployed agent allowlists exactly eight
 *   operations (release.startCandidate/stop/inspect/activate, caddy.reload/
 *   validate, volume.create/delete) — there is no generic docker-exec command,
 *   and extending it means editing packages/contracts/src/agent/index.ts AND
 *   the deployed agent script + a cloudlane-agent restart. The API itself runs
 *   on the VPS as root (cloudlane-api.service has no User=), so this service
 *   shells out to the local docker CLI with execFile (no shell, argv-level
 *   quoting) — the same primitive the agent's dockerExec() uses. If the agent
 *   later grows `db.provision` / `db.sql` / `db.dump` operations, replace the
 *   private `docker()` helper with AgentService.send() calls; every public
 *   method signature here stays identical.
 *
 * Physical layout:
 *   - One Docker container per database service, named `cl-<databaseName>`,
 *     image postgres:16-alpine / mysql:8 / mariadb:11, attached to the
 *     platform-internal `cloudlane-internal` bridge network, published on
 *     127.0.0.1:<auto-allocated ephemeral host port> only.
 *   - Two credentials per container, generated with crypto.randomBytes:
 *       root (postgres / root) — administration, dumps
 *       cl_app                 — the application credential shown in the
 *                                panel and used in connection strings.
 *   - Passwords are returned to the caller and MUST be persisted through
 *     SecretsService (AES envelope) by the caller — this service is
 *     deliberately stateless (no Prisma), so the pipeline stays testable and
 *     the workspace aggregate remains the single source of truth.
 *   - Backups: /var/lib/cloudlane/backups/<databaseName>/<timestamp>.sql via
 *     real pg_dump / mysqldump inside the container.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { promisify } from 'node:util';

const execCapture = promisify(execFile) as (
  cmd: string,
  args: string[],
  opts: { encoding: 'utf8'; timeout?: number; maxBuffer?: number },
) => Promise<{ stdout: string; stderr: string }>;

const BACKUP_ROOT = '/var/lib/cloudlane/backups';
/** Application credential created inside every provisioned container. */
export const DB_APP_USERNAME = 'cl_app';

/** Mirrors the images the panel advertises per engine. */
const ENGINE_SPECS: Record<string, { image: string; containerPort: number; rootUsername: string }> = {
  PostgreSQL: { image: 'postgres:16-alpine', containerPort: 5432, rootUsername: 'postgres' },
  MySQL: { image: 'mysql:8', containerPort: 3306, rootUsername: 'root' },
  MariaDB: { image: 'mariadb:11', containerPort: 3306, rootUsername: 'root' },
};

/**
 * Mirrors PG_PRIVS / MYSQL_PRIVS in workspace.service.ts (kept local to avoid a
 * circular import — workspace.service will import THIS file, not vice versa).
 */
const MYSQL_PRIVS = ['ALTER', 'ALTER ROUTINE', 'CREATE', 'CREATE ROUTINE',
  'CREATE TEMPORARY TABLES', 'CREATE VIEW', 'DELETE', 'DROP', 'EVENT', 'EXECUTE', 'INDEX',
  'INSERT', 'LOCK TABLES', 'REFERENCES', 'SELECT', 'SHOW VIEW', 'TRIGGER', 'UPDATE'];
const PG_PRIVS = ['CONNECT', 'CREATE', 'TEMPORARY', 'USAGE', 'SELECT', 'INSERT', 'UPDATE',
  'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'EXECUTE'];
/** Table-level PG privileges (everything else in PG_PRIVS is db/schema/function level). */
const PG_TABLE_PRIVS = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];

export interface ProvisionedDatabase {
  engine: string;
  image: string;
  databaseName: string;
  containerName: string;
  /** Always 127.0.0.1 — containers are never published on a public interface. */
  host: string;
  /** Auto-allocated ephemeral host port (docker-assigned, parsed from `docker port`). */
  port: number;
  rootUsername: string;
  rootPassword: string;
  appUsername: string;
  appPassword: string;
}

export interface DbConnectionInfo {
  engine: string;
  databaseName: string;
  containerName: string;
  host: string;
  port: number;
  /** The application credential to splice into a connection string. */
  username: string;
  containerStatus: string;
}

export interface DbUserResult {
  username: string;
  /** Plaintext — the caller persists it via SecretsService.encrypt(). */
  password: string;
}

export interface DbBackupResult {
  engine: string;
  databaseName: string;
  path: string;
  size: number;
}

@Injectable()
export class DatabasePipelineService {
  private readonly logger = new Logger(DatabasePipelineService.name);
  /** Container name → cached MYSQL_ROOT_PASSWORD (read once via printenv). */
  private readonly mysqlRootCache = new Map<string, string>();

  // ─────────────────────────── public API ───────────────────────────

  /**
   * Create a real Docker database container on the VPS: pull the engine image,
   * run it on the internal network with an auto-allocated 127.0.0.1 host port,
   * wait until it accepts connections, create the application user and grant
   * it the standard app preset. Returns both credentials (caller encrypts them
   * with SecretsService). Cleans the container up again on any failure.
   */
  /**
   * Provisioning is serialized: concurrent creates raced on the deterministic
   * container name (cl-<database>) and each other's docker exec loops.
   */
  private provisionChain: Promise<unknown> = Promise.resolve();

  async provision(
    engine: string,
    databaseName: string,
    name: string,
    opts?: { force?: boolean },
  ): Promise<ProvisionedDatabase> {
    const task = this.provisionChain.then(() => this.runProvision(engine, databaseName, name, opts?.force ?? false));
    this.provisionChain = task.catch(() => undefined);
    return task as Promise<ProvisionedDatabase>;
  }

  private async runProvision(
    engine: string,
    databaseName: string,
    name: string,
    force: boolean,
  ): Promise<ProvisionedDatabase> {
    const spec = this.specFor(engine);
    this.assertDatabaseName(databaseName);
    const cname = this.containerNameFor(databaseName);

    const existing = (
      await this.docker(
        ['ps', '-a', '--filter', `name=^/${cname}$`, '--format', '{{.Names}}'],
        { failLabel: 'Could not list existing containers on this server' },
      )
    ).trim();
    if (existing) {
      if (!force) {
        throw new BadRequestException(
          `A database container named ${cname} already exists on this server. Choose a different database name.`,
        );
      }
      // Self-heal path: a stale container (left by a deleted service or a
      // failed run) blocks the deterministic name — remove it and re-create.
      await this.docker(['rm', '-f', cname], {
        failLabel: `Could not remove the stale container ${cname}`,
      });
    }

    const rootPassword = this.generatePassword();
    const appPassword = this.generatePassword();

    this.logger.log(`Provisioning database container ${cname} (${spec.image}) for "${name}"`);
    await this.docker(['pull', spec.image], {
      timeout: 480_000,
      failLabel: `Could not pull the ${spec.image} image`,
    });

    const runArgs = [
      'run', '-d', '--name', cname,
      '--label', 'cloudlane.managed=true',
      '--restart', 'unless-stopped',
      '--network', 'cloudlane-internal',
      '-p', `127.0.0.1::${spec.containerPort}`,
    ];
    if (engine === 'PostgreSQL') {
      runArgs.push('-e', `POSTGRES_PASSWORD=${rootPassword}`, '-e', `POSTGRES_DB=${databaseName}`, spec.image);
    } else {
      runArgs.push('-e', `MYSQL_ROOT_PASSWORD=${rootPassword}`, '-e', `MYSQL_DATABASE=${databaseName}`, spec.image);
    }
    try {
      await this.docker(runArgs, { timeout: 180_000, failLabel: `Could not start the ${spec.image} container` });
    } catch (err) {
      await this.docker(['rm', '-f', cname]).catch(() => {});
      throw err;
    }

    try {
      await this.waitForReady(engine, cname, databaseName, rootPassword);
      await this.createDbUser(engine, databaseName, DB_APP_USERNAME, appPassword);
      await this.grantPrivileges(
        engine,
        databaseName,
        DB_APP_USERNAME,
        engine === 'PostgreSQL'
          ? ['CONNECT', 'USAGE', 'SELECT', 'INSERT', 'UPDATE', 'DELETE']
          : ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'INDEX'],
      );
    } catch (err) {
      await this.docker(['rm', '-f', cname]).catch(() => {});
      throw err;
    }

    const port = await this.publishedPort(cname, spec.containerPort);
    this.logger.log(`Database ${cname} is ready on 127.0.0.1:${port}`);
    return {
      engine,
      image: spec.image,
      databaseName,
      containerName: cname,
      host: '127.0.0.1',
      port,
      rootUsername: spec.rootUsername,
      rootPassword,
      appUsername: DB_APP_USERNAME,
      appPassword,
    };
  }

  /** True when a container with this exact name exists (any state). */
  async containerExists(name: string): Promise<boolean> {
    const out = (
      await this.docker(
        ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'],
        { failLabel: 'Could not list containers on this server' },
      )
    ).trim();
    return out.length > 0;
  }

  /**
   * Create a real SQL user inside the container. Generates the password when
   * none is supplied; returns the plaintext for the caller to encrypt.
   * PostgreSQL: CREATE USER + GRANT CONNECT on the database.
   * MySQL/MariaDB: CREATE USER '<username>'@'%' IDENTIFIED BY ... .
   */
  async createDbUser(
    engine: string,
    databaseName: string,
    username: string,
    password?: string,
  ): Promise<DbUserResult> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    this.assertUsername(username);
    const cname = this.containerNameFor(databaseName);
    const pw = password ?? this.generatePassword();

    if (engine === 'PostgreSQL') {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [
          `CREATE USER ${this.pgIdent(username)} WITH PASSWORD ${this.pgLit(pw)}`,
          `GRANT CONNECT ON DATABASE ${this.pgIdent(databaseName)} TO ${this.pgIdent(username)}`,
        ],
        `Could not create the database user "${username}"`,
      );
    } else {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`CREATE USER ${this.myLit(username)}@'%' IDENTIFIED BY ${this.myLit(pw)}`],
        `Could not create the database user "${username}"`,
      );
    }
    return { username, password: pw };
  }

  /**
   * Re-sync a database user's password to the platform's stored credential.
   *
   * The encrypted credential on the Service row is canonical; containers can
   * drift (rebuilt volumes, manual resets). Opening db-admin from the panel
   * calls this first so the SSO token always carries a working password.
   */
  async resetAppUserPassword(
    engine: string,
    databaseName: string,
    username: string,
    password: string,
  ): Promise<void> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    this.assertUsername(username);
    const cname = this.containerNameFor(databaseName);
    if (engine === 'PostgreSQL') {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`ALTER ROLE ${this.pgIdent(username)} WITH PASSWORD ${this.pgLit(password)}`],
        `Could not sync the database user "${username}"`,
      );
    } else {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`ALTER USER ${this.myLit(username)}@'%' IDENTIFIED BY ${this.myLit(password)}`],
        `Could not sync the database user "${username}"`,
      );
    }
  }

  /**
   * Apply the EXACT privilege set to a user (set semantics, matching the
   * panel's privilege checkboxes): everything else on the database scope is
   * revoked first, then every listed privilege is granted. Names are validated
   * against the same PG_PRIVS / MYSQL_PRIVS lists the metadata layer uses.
   */
  async grantPrivileges(
    engine: string,
    databaseName: string,
    username: string,
    privileges: string[],
  ): Promise<{ applied: string[] }> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    this.assertUsername(username);
    const cname = this.containerNameFor(databaseName);
    const list = [...new Set(privileges)];

    if (engine === 'PostgreSQL') {
      const unknown = list.filter((p) => !PG_PRIVS.includes(p));
      if (unknown.length) {
        throw new BadRequestException(`Unsupported PostgreSQL privileges: ${unknown.join(', ')}.`);
      }
      const u = this.pgIdent(username);
      const d = this.pgIdent(databaseName);
      const stmts = [
        `REVOKE ALL PRIVILEGES ON DATABASE ${d} FROM ${u}`,
        `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${u}`,
        `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${u}`,
        `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${u}`,
        `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${u}`,
      ];
      for (const p of list) {
        if (p === 'CONNECT') stmts.push(`GRANT CONNECT ON DATABASE ${d} TO ${u}`);
        else if (p === 'TEMPORARY') stmts.push(`GRANT TEMPORARY ON DATABASE ${d} TO ${u}`);
        else if (p === 'USAGE') stmts.push(`GRANT USAGE ON SCHEMA public TO ${u}`);
        else if (p === 'CREATE') stmts.push(`GRANT CREATE ON SCHEMA public TO ${u}`);
        else if (p === 'EXECUTE') {
          stmts.push(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${u}`);
          stmts.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO ${u}`);
        } else if (PG_TABLE_PRIVS.includes(p)) {
          stmts.push(`GRANT ${p} ON ALL TABLES IN SCHEMA public TO ${u}`);
          stmts.push(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ${p} ON TABLES TO ${u}`);
        }
      }
      await this.sqlExec(engine, cname, databaseName, stmts, `Could not apply privileges to "${username}"`);
    } else {
      const unknown = list.filter((p) => !MYSQL_PRIVS.includes(p));
      if (unknown.length) {
        throw new BadRequestException(`Unsupported ${engine} privileges: ${unknown.join(', ')}.`);
      }
      const q = this.myIdent(databaseName);
      const grantee = `${this.myLit(username)}@'%'`;
      // MySQL 8.4 rejects "REVOKE ALL PRIVILEGES, GRANT OPTION" (1064) and
      // errors on revoking from a user with no grants (1141) — so only revoke
      // what SHOW GRANTS actually reports for this database.
      const stmts = await this.mysqlRevokeStatements(databaseName, username, grantee, q, cname, engine);
      if (list.length) stmts.push(`GRANT ${list.join(', ')} ON ${q}.* TO ${grantee}`);
      await this.sqlExec(engine, cname, databaseName, stmts, `Could not apply privileges to "${username}"`);
    }
    return { applied: list };
  }

  /** Full real-world revocation (panel: toggleDbUser → revoked): drop every privilege and disable login. */
  async revokeUser(engine: string, databaseName: string, username: string): Promise<void> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    this.assertUsername(username);
    const cname = this.containerNameFor(databaseName);

    if (engine === 'PostgreSQL') {
      const u = this.pgIdent(username);
      const d = this.pgIdent(databaseName);
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [
          `REVOKE ALL PRIVILEGES ON DATABASE ${d} FROM ${u}`,
          `REVOKE ALL PRIVILEGES ON SCHEMA public FROM ${u}`,
          `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${u}`,
          `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${u}`,
          `REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM ${u}`,
          `ALTER ROLE ${u} NOLOGIN`,
        ],
        `Could not revoke access for "${username}"`,
      );
    } else {
      const q = this.myIdent(databaseName);
      const grantee = `${this.myLit(username)}@'%'`;
      // See grantPrivileges — only revoke privileges that actually exist.
      const stmts = await this.mysqlRevokeStatements(databaseName, username, grantee, q, cname, engine);
      stmts.push(`ALTER USER ${this.myLit(username)}@'%' ACCOUNT LOCK`);
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        stmts,
        `Could not revoke access for "${username}"`,
      );
    }
  }

  /** Re-enable a previously revoked user (panel: toggleDbUser → restored) and re-grant its stored privileges. */
  async restoreUserAccess(
    engine: string,
    databaseName: string,
    username: string,
    privileges: string[],
  ): Promise<void> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    this.assertUsername(username);
    const cname = this.containerNameFor(databaseName);

    if (engine === 'PostgreSQL') {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`ALTER ROLE ${this.pgIdent(username)} LOGIN`],
        `Could not restore access for "${username}"`,
      );
    } else {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`ALTER USER ${this.myLit(username)}@'%' ACCOUNT UNLOCK`],
        `Could not restore access for "${username}"`,
      );
    }
    await this.grantPrivileges(engine, databaseName, username, privileges);
  }

  /** Rotate a SQL user's password in place (panel: rotateDbUser, and rotateDb for the app credential). */
  async rotateUserPassword(engine: string, databaseName: string, username: string): Promise<DbUserResult> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    this.assertUsername(username);
    const cname = this.containerNameFor(databaseName);
    const pw = this.generatePassword();

    if (engine === 'PostgreSQL') {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`ALTER ROLE ${this.pgIdent(username)} WITH PASSWORD ${this.pgLit(pw)}`],
        `Could not rotate the password for "${username}"`,
      );
    } else {
      await this.sqlExec(
        engine,
        cname,
        databaseName,
        [`ALTER USER ${this.myLit(username)}@'%' IDENTIFIED BY ${this.myLit(pw)}`],
        `Could not rotate the password for "${username}"`,
      );
    }
    this.logger.log(`Rotated password for SQL user "${username}" on ${cname}`);
    return { username, password: pw };
  }

  /**
   * Real database backup via pg_dump / mysqldump executed INSIDE the container,
   * written to /var/lib/cloudlane/backups/<databaseName>/<timestamp>.sql.
   * Throws when the dump comes back empty — nothing is recorded then.
   */
  async createBackup(engine: string, databaseName: string): Promise<DbBackupResult> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    const cname = this.containerNameFor(databaseName);

    const status = await this.containerStatus(cname);
    if (!status) {
      throw new BadRequestException(`No database container named ${cname} exists on this server.`);
    }
    if (status !== 'running') {
      throw new BadRequestException(
        `The database container ${cname} is ${status}; a backup needs it running.`,
      );
    }

    const dir = join(BACKUP_ROOT, databaseName);
    await mkdir(dir, { recursive: true });

    const dumpOpts = { timeout: 300_000, maxBuffer: 512 * 1024 * 1024 };
    let dump: string;
    if (engine === 'PostgreSQL') {
      dump = await this.docker(
        ['exec', cname, 'pg_dump', '-U', 'postgres', '-d', databaseName],
        { ...dumpOpts, failLabel: `pg_dump of "${databaseName}" failed` },
      );
    } else {
      const rootPw = await this.mysqlRootPassword(cname);
      dump = await this.docker(
        ['exec', '-e', `MYSQL_PWD=${rootPw}`, cname, this.dumpBin(engine), '-uroot',
          '--single-transaction', '--routines', '--events', databaseName],
        { ...dumpOpts, failLabel: `${this.dumpBin(engine)} of "${databaseName}" failed` },
      );
    }
    if (!dump || !dump.trim()) {
      throw new BadRequestException(
        `The backup of "${databaseName}" came back empty (0 bytes); nothing was saved.`,
      );
    }

    const ts = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').split('.')[0];
    let file = join(dir, `${ts}.sql`);
    if (await this.fileExists(file)) {
      file = join(dir, `${ts}-${randomBytes(3).toString('hex')}.sql`);
    }
    await writeFile(file, dump, 'utf8');
    const { size } = await stat(file);
    if (size <= 0) {
      throw new BadRequestException(`The backup of "${databaseName}" was written empty; please retry.`);
    }
    this.logger.log(`Backup of ${databaseName} written to ${file} (${size} bytes)`);
    return { engine, databaseName, path: file, size };
  }

  /**
   * Real connection coordinates for the panel's connection string:
   * host 127.0.0.1, the container's allocated host port (resolved live from
   * docker), and the application username. The caller splices the decrypted
   * password from Service.passwordCipher.
   */
  async connectionInfo(engine: string, databaseName: string): Promise<DbConnectionInfo> {
    const spec = this.specFor(engine);
    this.assertDatabaseName(databaseName);
    const cname = this.containerNameFor(databaseName);

    const status = await this.containerStatus(cname);
    if (!status) {
      throw new BadRequestException(`No database container named ${cname} exists on this server.`);
    }
    const port = await this.publishedPort(cname, spec.containerPort);
    return {
      engine,
      databaseName,
      containerName: cname,
      host: '127.0.0.1',
      port,
      username: DB_APP_USERNAME,
      containerStatus: status,
    };
  }

  /**
   * Remove the container (the panel has no delete action yet — provided for
   * 'reset' cleanup and future service deletion; backup files are kept).
   * No-op when the container does not exist.
   */
  async destroy(engine: string, databaseName: string): Promise<void> {
    this.specFor(engine);
    this.assertDatabaseName(databaseName);
    const cname = this.containerNameFor(databaseName);
    if (!(await this.containerStatus(cname))) return;
    await this.docker(['rm', '-f', cname], {
      failLabel: `Could not remove the database container ${cname}`,
    });
    this.logger.log(`Database container ${cname} removed`);
  }

  /**
   * Client binary names per engine: mariadb:11 images ship `mariadb` /
   * `mariadb-dump` and NO `mysql` alias, while mysql:8 only ships the
   * `mysql` family. Using the wrong name fails every exec with
   * "executable file not found in $PATH".
   */
  private sqlBin(engine: string): string {
    return engine === 'MariaDB' ? 'mariadb' : 'mysql';
  }

  private dumpBin(engine: string): string {
    return engine === 'MariaDB' ? 'mariadb-dump' : 'mysqldump';
  }

  /** Deterministic container name for a database service. */
  containerNameFor(databaseName: string): string {
    return `cl-${databaseName}`;
  }

  // ─────────────────────────── internals ───────────────────────────

  private specFor(engine: string) {
    const spec = ENGINE_SPECS[engine];
    if (!spec) {
      throw new BadRequestException(
        `Unsupported database engine "${engine}". Choose PostgreSQL, MySQL or MariaDB.`,
      );
    }
    return spec;
  }

  private assertDatabaseName(databaseName: string): void {
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(databaseName || '')) {
      throw new BadRequestException(
        'Enter a valid database name (letters, digits and underscores, starting with a letter).',
      );
    }
  }

  private assertUsername(username: string): void {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(username || '')) {
      throw new BadRequestException('Use a valid database username.');
    }
  }

  /** Alphanumeric password (no shell/SQL-special characters, no look-alikes). */
  private generatePassword(length = 28): string {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = randomBytes(length);
    let out = '';
    for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
    return out;
  }

  private pgIdent(v: string): string {
    return `"${v.replace(/"/g, '""')}"`;
  }

  private pgLit(v: string): string {
    return `'${v.replace(/'/g, "''")}'`;
  }

  private myIdent(v: string): string {
    return `\`${v.replace(/`/g, '``')}\``;
  }

  private myLit(v: string): string {
    return `'${v.replace(/['\\]/g, (c) => (c === '\\' ? '\\\\' : "\\'"))}'`;
  }

  /**
   * Run one docker CLI command (execFile — no host shell, no interpolation).
   * Never logs argv (credentials travel in -e flags); errors surface a short
   * stderr tail wrapped in BadRequestException.
   */
  private async docker(
    args: string[],
    opts: { timeout?: number; maxBuffer?: number; failLabel?: string } = {},
  ): Promise<string> {
    try {
      const { stdout } = await execCapture('docker', args, {
        encoding: 'utf8',
        timeout: opts.timeout ?? 60_000,
        maxBuffer: opts.maxBuffer ?? 8 * 1024 * 1024,
      });
      return stdout;
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const detail = (e.stderr || e.message || 'unknown docker error')
        .trim()
        .split('\n')
        .slice(-4)
        .join(' | ');
      this.logger.warn(`docker ${args[0]} failed: ${detail}`);
      throw new BadRequestException(`${opts.failLabel ?? `docker ${args[0]} failed`}: ${detail}`);
    }
  }

  /**
   * Execute SQL statements inside the container (psql -c / mysql -e).
   * The statements run as one batch; psql uses ON_ERROR_STOP so any failure
   * aborts the batch. SQL goes to the client as a single argv element — no
   * container shell involved, and all values are escaped before interpolation.
   */
  private async sqlExec(
    engine: string,
    cname: string,
    databaseName: string,
    statements: string[],
    failLabel: string,
  ): Promise<void> {
    const sql = `${statements.join(';\n')};`;
    if (engine === 'PostgreSQL') {
      await this.docker(
        ['exec', cname, 'psql', '-X', '-U', 'postgres', '-d', databaseName,
          '-v', 'ON_ERROR_STOP=1', '-c', sql],
        { failLabel },
      );
    } else {
      const rootPw = await this.mysqlRootPassword(cname);
      await this.docker(
        ['exec', '-e', `MYSQL_PWD=${rootPw}`, cname, this.sqlBin(engine), '-uroot', '-e', sql],
        { failLabel },
      );
    }
  }

  /**
   * MySQL/MariaDB revoke statements for the database scope, based on the
   * privileges the user CURRENTLY holds (SHOW GRANTS). Handles MySQL 8.4's
   * rejection of the combined "REVOKE ALL PRIVILEGES, GRANT OPTION" form and
   * the ER_NO_SUCH_GRANT (1141) error for fresh users with no grants.
   */
  private async mysqlRevokeStatements(
    databaseName: string,
    username: string,
    grantee: string,
    dbQualified: string,
    cname: string,
    engine = 'MySQL',
  ): Promise<string[]> {
    const current = await this.mysqlCurrentDbPrivs(cname, databaseName, username, engine);
    const stmts: string[] = [];
    if (current.privs.length) {
      stmts.push(`REVOKE ${current.privs.join(', ')} ON ${dbQualified}.* FROM ${grantee}`);
    }
    if (current.grantOption) {
      stmts.push(`REVOKE GRANT OPTION ON ${dbQualified}.* FROM ${grantee}`);
    }
    return stmts;
  }

  /** Parse `SHOW GRANTS FOR user@'%'` for the <db>.*-level privileges. */
  private async mysqlCurrentDbPrivs(
    cname: string,
    databaseName: string,
    username: string,
    engine = 'MySQL',
  ): Promise<{ privs: string[]; grantOption: boolean }> {
    const rootPw = await this.mysqlRootPassword(cname);
    const out = await this.docker(
      ['exec', '-e', `MYSQL_PWD=${rootPw}`, cname, this.sqlBin(engine), '-uroot', '-e',
        `SHOW GRANTS FOR ${this.myLit(username)}@'%'`],
      { failLabel: `Could not read the current grants of "${username}"` },
    );
    const re = new RegExp(`^GRANT\\s+(.+?)\\s+ON \`?${databaseName}\`?\\.\\*\\s+TO`, 'i');
    for (const line of out.split('\n')) {
      const m = re.exec(line.trim());
      if (!m) continue;
      const raw = m[1];
      const grantOption = /grant\s+option/i.test(raw);
      const privs = raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s && !/^grant\s+option$/i.test(s));
      return { privs, grantOption };
    }
    return { privs: [], grantOption: false };
  }

  /** Read the container's MYSQL_ROOT_PASSWORD (it stays in the container env; never leaves the host). */
  private async mysqlRootPassword(cname: string): Promise<string> {
    const cached = this.mysqlRootCache.get(cname);
    if (cached) return cached;
    const out = await this.docker(['exec', cname, 'printenv', 'MYSQL_ROOT_PASSWORD'], {
      failLabel:
        `Could not read the MySQL root credential from ${cname} — the container was not ` +
        'provisioned by Cloudlane, so it cannot be administered',
    });
    const pw = out.trim();
    if (!pw) {
      throw new BadRequestException(
        `The MySQL container ${cname} does not expose its root credential; cannot run SQL against it.`,
      );
    }
    this.mysqlRootCache.set(cname, pw);
    return pw;
  }

  private async waitForReady(
    engine: string,
    cname: string,
    databaseName: string,
    rootPassword: string,
  ): Promise<void> {
    const deadline = Date.now() + 150_000;
    let lastErr = 'no attempt';
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        if (engine === 'PostgreSQL') {
          await this.docker(
            ['exec', cname, 'pg_isready', '-U', 'postgres', '-d', databaseName],
            { timeout: 20_000 },
          );
        } else {
          // Authenticated probe — mysqladmin ping exits 0 even while the
          // first-boot temporary server is up WITHOUT the root password,
          // which would let provisioning race the image's init.
          await this.docker(
            ['exec', '-e', `MYSQL_PWD=${rootPassword}`, cname, this.sqlBin(engine), '-uroot', '-e', 'SELECT 1'],
            { timeout: 20_000 },
          );
        }
        return;
      } catch (err) {
        lastErr = (err as Error).message.slice(0, 200);
        if (/no such container/i.test(lastErr)) {
          let state = 'unavailable';
          try { state = (await this.docker(['inspect', '--format', '{{.State.Status}} exit={{.State.ExitCode}}', cname], { timeout: 10_000 })).trim(); } catch { /* gone */ }
          this.logger.error(`waitForReady ${cname}: container vanished during init (state: ${state}). lastErr: ${lastErr}`);
          throw new BadRequestException(`Database container ${cname} disappeared during initialization (last probe: ${lastErr}; state: ${state}).`);
        }
      }
    }
    this.logger.warn(`waitForReady ${cname}: deadline reached. lastErr: ${lastErr}`);
    await this.docker(['rm', '-f', cname]).catch(() => {});
    throw new BadRequestException(
      `The database container ${cname} did not become ready within 150s (${lastErr}).`,
    );
  }

  private async publishedPort(cname: string, containerPort: number): Promise<number> {
    const out = await this.docker(['port', cname, String(containerPort)], {
      failLabel: `Could not read the allocated host port of ${cname}`,
    });
    const m = /127\.0\.0\.1:(\d+)/.exec(out);
    if (!m) {
      throw new BadRequestException(
        `Container ${cname} has no published port on 127.0.0.1 (docker port output: ${out.trim()}).`,
      );
    }
    return Number(m[1]);
  }

  private async containerStatus(cname: string): Promise<string | null> {
    try {
      return (
        await this.docker(['inspect', '-f', '{{.State.Status}}', cname], { timeout: 15_000 })
      ).trim();
    } catch {
      return null;
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }
}
