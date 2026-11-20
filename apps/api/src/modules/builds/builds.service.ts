/**
 * BuildsService — Vercel-style build pipeline for application services.
 *
 * Detection matrix (zip names + extracted file contents):
 *   Next.js / Nuxt / SvelteKit / Vite (React, Vue, Solid) / Angular / Astro /
 *   NestJS / Express & friends (Node) / Go / Python / PHP / Java / C# / Rust / Ruby.
 *
 * Buildable Node frameworks run `install + build` inside a queued
 * `node:20-alpine` builder container (concurrency 1, memory/cpu capped) with
 * the extracted source mounted at /src. The output is classified:
 *   - static output dir (out/, dist/, build/, Angular dist/x/browser) → moved
 *     into the deployment html dir and served by the existing caddy file-server.
 *   - runtime app (next start, node dist/main.js, node build …) → served by a
 *     long-lived runtime container via the agent (startCandidate with cmd).
 *
 * Non-Node stacks are detected and reported with a clear "runtime coming
 * soon" reason instead of failing with a generic error.
 */
import { spawn } from 'node:child_process';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';

const BUILDER_IMAGE = 'node:20-alpine';
const BUILD_TIMEOUT_MS = 12 * 60 * 1000;
const BUILD_MEMORY = '1g';
const BUILD_CPUS = '1.5';
const RUNTIME_MEMORY_MIB = 512;
const RUNTIME_CPU = 0.5;

/** Directories stripped from entry counts and never extracted/deployed. */
export const IGNORED_DIRS = ['node_modules/', '.git/', '.next/', '.turbo/', '.cache/', '.pnpm-store/'];

export interface FrameworkInfo {
  /** Canonical framework label shown in the UI. */
  label: string;
  /** One of: static | runtime | build-static | build-runtime | build-auto | unsupported */
  kind: 'static' | 'runtime' | 'build-static' | 'build-runtime' | 'build-auto' | 'unsupported';
  /** Build container command (build-static/build-runtime). */
  buildCmd?: string;
  /** Runtime container command (build-runtime/runtime). */
  runCmd?: string[];
  /** True when no npm install is required (pure static, express w/o deps). */
  needsInstall?: boolean;
  /** Human reason for unsupported stacks. */
  reason?: string;
}

export interface BuildResult {
  mode: 'static' | 'runtime' | 'source-only';
  framework: string;
  entryCount?: number;
  buildLog?: string;
  runCmd?: string[];
  imageRef?: string;
  reason?: string;
}

@Injectable()
export class BuildsService {
  private readonly logger = new Logger(BuildsService.name);
  /** Build queue: one build at a time — the VPS is small and builds are heavy. */
  private chain: Promise<unknown> = Promise.resolve();

  // ── detection ────────────────────────────────────────────────────────────

  /** Name-based detection before extraction (client + finalize paths). */
  detectFromNames(names: string[]): string {
    const has = (n: string) => names.some((x) => x.endsWith(n));
    if (has('go.mod')) return 'Go';
    if (has('requirements.txt') || has('pyproject.toml') || has('manage.py')) return 'Python';
    if (has('composer.json')) return 'PHP';
    if (has('pom.xml') || has('build.gradle') || has('build.gradle.kts')) return 'Java';
    if (names.some((x) => x.endsWith('.csproj')) || names.some((x) => x.endsWith('.sln'))) return 'C#';
    if (has('cargo.toml')) return 'Rust';
    if (has('gemfile')) return 'Ruby';
    if (has('nest-cli.json')) return 'NestJS';
    if (has('next.config.js') || has('next.config.mjs') || has('next.config.ts')) return 'Next.js';
    if (has('nuxt.config.ts') || has('nuxt.config.js')) return 'Nuxt';
    if (has('svelte.config.js') || has('svelte.config.mjs')) return 'SvelteKit';
    if (has('angular.json')) return 'Angular';
    if (has('astro.config.mjs') || has('astro.config.js')) return 'Astro';
    if (has('vite.config.js') || has('vite.config.ts')) return 'React/Vite';
    if (has('dockerfile')) return 'Dockerfile';
    if (has('package.json')) return 'Node.js';
    if (has('index.html')) return 'Static HTML';
    return 'Static HTML';
  }

  /** Full detection after extraction: reads package.json / framework configs. */
  async detect(dir: string, fallback: string): Promise<FrameworkInfo> {
    const names = await this.listNames(dir, '');
    const label = this.detectFromNames(names);
    const framework = label === 'Static HTML' && fallback && fallback !== 'auto' ? fallback : label;

    switch (framework) {
      case 'Go':
      case 'Python':
      case 'PHP':
      case 'Java':
      case 'C#':
      case 'Rust':
      case 'Ruby':
        return {
          label: framework,
          kind: 'unsupported',
          reason: `${framework} runtimes are detected but not hosted yet — deploy its build output as static files, or watch for the runtime update.`,
        };
      case 'Nuxt':
        return {
          label: 'Nuxt',
          kind: 'build-static',
          buildCmd: 'npx nuxt build',
          needsInstall: true,
        };
      case 'Angular':
        return {
          label: 'Angular',
          kind: 'build-static',
          buildCmd: 'npx ng build --configuration production',
          needsInstall: true,
        };
      case 'Astro':
        return {
          label: 'Astro',
          kind: 'build-static',
          buildCmd: 'npx astro build',
          needsInstall: true,
        };
      case 'SvelteKit':
        return await this.detectSvelteKit(dir);
      case 'Next.js':
        return await this.detectNext(dir);
      case 'React/Vite':
        return {
          label: 'React/Vite',
          kind: 'build-static',
          buildCmd: 'npm run build',
          needsInstall: true,
        };
      case 'NestJS':
        return {
          label: 'NestJS',
          kind: 'runtime',
          runCmd: ['node', 'dist/main.js'],
          needsInstall: true,
        };
      case 'Node.js': {
        const pkg = await this.readPackageJson(dir);
        const hasIndexHtml = names.some((n) => n.endsWith('index.html'));
        if (!pkg && hasIndexHtml) return { label: 'Static HTML', kind: 'static' };
        return await this.detectNodeEntry(dir, pkg);
      }
      case 'Dockerfile':
        return {
          label: 'Dockerfile',
          kind: 'unsupported',
          reason: 'Custom Dockerfile builds are not enabled in this phase — use one of the supported frameworks.',
        };
      default:
        return { label: framework || 'Static HTML', kind: 'static' };
    }
  }

  private async detectSvelteKit(dir: string): Promise<FrameworkInfo> {
    const cfg = await this.readFirst(dir, ['svelte.config.js', 'svelte.config.mjs']);
    if (cfg && /adapter-node/.test(cfg)) {
      return {
        label: 'SvelteKit',
        kind: 'build-runtime',
        buildCmd: 'npm run build',
        needsInstall: true,
        runCmd: ['node', 'build/index.js'],
      };
    }
    // adapter-static or unset: build first, classify by the produced output
    return { label: 'SvelteKit', kind: 'build-auto', buildCmd: 'npm run build', needsInstall: true, runCmd: ['node', 'build/index.js'] };
  }

  private async detectNext(dir: string): Promise<FrameworkInfo> {
    // Classify by build OUTPUT (out/ vs .next/BUILD_ID) — config text is not
    // reliable (comments/conditional exports). See executeBuild.
    return {
      label: 'Next.js',
      kind: 'build-auto',
      buildCmd: 'npm run build',
      needsInstall: true,
      runCmd: ['npx', 'next', 'start', '-p', '80'],
    };
  }

  private async detectNodeEntry(dir: string, pkg: Record<string, unknown> | null): Promise<FrameworkInfo> {
    const start = String((pkg?.scripts as Record<string, string> | undefined)?.start ?? '').trim();
    if (start) {
      // "node dist/main.js" / "npm run …" prefixes stripped to the real argv
      const argv = start.replace(/^(npm|yarn|pnpm)\s+(run|start)?\s*/i, '').split(/\s+/).filter(Boolean);
      if (argv.length && argv[0] !== 'next') return { label: 'Node.js', kind: 'runtime', runCmd: argv, needsInstall: true };
      if (argv[0] === 'next') return { label: 'Next.js', kind: 'build-runtime', buildCmd: 'npm run build', needsInstall: true, runCmd: ['npx', 'next', 'start', '-p', '80'] };
    }
    const names = await this.listNames(dir, '');
    const candidates = ['server.js', 'app.js', 'index.js', 'dist/main.js', 'dist/index.js', 'src/index.js', 'src/main.js'];
    const entry = candidates.find((c) => names.some((n) => n === c || n.endsWith(`/${c}`)));
    if (entry) return { label: 'Node.js', kind: 'runtime', runCmd: ['node', entry], needsInstall: true };
    // Fallback: install deps and serve anything static found
    return {
      label: 'Node.js',
      kind: 'build-static',
      buildCmd: 'npm run build || true',
      needsInstall: true,
    };
  }

  // ── build execution ──────────────────────────────────────────────────────

  async runBuild(deploymentId: string, srcDir: string, info: FrameworkInfo, onStage?: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => Promise<void>): Promise<BuildResult> {
    if (info.kind === 'static') return { mode: 'static', framework: info.label };
    if (info.kind === 'unsupported') return { mode: 'source-only', framework: info.label, reason: info.reason };
    // 'runtime' needs dependency install inside the builder before the app
    // container starts; queued like every build.
    if (info.kind === 'runtime') {
      const task = this.chain.then(() => this.executeRuntimeInstall(deploymentId, srcDir, info, onStage));
      this.chain = task.catch(() => undefined);
      return task;
    }

    // queued — one build at a time
    const task = this.chain.then(() => this.executeBuild(deploymentId, srcDir, info, onStage));
    this.chain = task.catch(() => undefined);
    return task;
  }

  private async executeRuntimeInstall(
    deploymentId: string,
    srcDir: string,
    info: FrameworkInfo,
    onStage?: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => Promise<void>,
  ): Promise<BuildResult> {
    const started = Date.now();
    const lockfile = await this.pickLockfile(srcDir);
    const installCmd = lockfile === 'pnpm-lock.yaml'
      ? 'corepack pnpm install --frozen-lockfile || corepack pnpm install --no-frozen-lockfile'
      : lockfile === 'yarn.lock'
        ? 'yarn install --frozen-lockfile || yarn install'
        : 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund';
    const script = [
      'set -o pipefail',
      `cd /src || cd $(find /src -maxdepth 4 -name package.json -not -path "*/node_modules/*" | head -1 | xargs dirname)`,
      `echo "[install] ${info.label}: ${lockfile ?? 'no lockfile (npm install)'}"`,
      `${installCmd} 2>&1 | tail -25`,
      'echo "[done] dependencies installed"',
    ].join('\n');
    await onStage?.(`[BUILD] Installing dependencies for ${info.label} in ${BUILDER_IMAGE}`, 'info');
    let code = 0;
    let log = '';
    try {
      code = await this.dockerRunScript(srcDir, script, (chunk) => { log += chunk; });
    } catch (err) {
      log += `\n[docker] ${String(err).slice(0, 300)}`;
      code = 125;
    }
    if (code !== 0) {
      throw new Error(`Dependency install failed (exit ${code}) after ${Math.round((Date.now() - started) / 1000)}s:\n${log.split('\n').slice(-10).join('\n')}`);
    }
    await onStage?.('[BUILD] Dependencies installed', 'success');
    return { mode: 'runtime', framework: info.label, runCmd: info.runCmd, imageRef: BUILDER_IMAGE, buildLog: log.slice(-4000) };
  }

  private async executeBuild(deploymentId: string, srcDir: string, info: FrameworkInfo, onStage?: (msg: string, level?: 'info' | 'success' | 'warning' | 'error') => Promise<void>): Promise<BuildResult> {
    const started = Date.now();
    const lockfile = await this.pickLockfile(srcDir);
    const installCmd = !info.needsInstall
      ? 'true'
      : lockfile === 'pnpm-lock.yaml'
        ? 'corepack pnpm install --frozen-lockfile || corepack pnpm install --no-frozen-lockfile'
        : lockfile === 'yarn.lock'
          ? 'yarn install --frozen-lockfile || yarn install'
          : 'npm ci --no-audit --no-fund || npm install --no-audit --no-fund';

    const script = [
      'set -o pipefail',
      `cd /src || cd $(find /src -maxdepth 4 -name package.json -not -path "*/node_modules/*" | head -1 | xargs dirname)`,
      `echo "[install] using ${lockfile ?? 'no lockfile (npm install)'}"`,
      `${installCmd} 2>&1 | tail -25`,
      `echo "[build] ${info.buildCmd}"`,
      `${info.buildCmd} 2>&1 | tail -40`,
      'echo "[done] build completed"',
    ].join('\n');

    await onStage?.(`[BUILD] Running ${info.label} build in ${BUILDER_IMAGE} (queued, ${BUILD_MEMORY} limit)`, 'info');
    this.logger.log(`Build ${deploymentId}: ${info.label} / ${info.kind}`);

    let log = '';
    let code = 0;
    try {
      code = await this.dockerRunScript(srcDir, script, (chunk) => {
        log += chunk;
      });
    } catch (err) {
      log += `\n[docker] ${String(err).slice(0, 300)}`;
      code = 125;
    }

    if (code !== 0) {
      const tail = log.split('\n').slice(-14).join('\n');
      throw new Error(`Build failed (exit ${code}) after ${Math.round((Date.now() - started) / 1000)}s:\n${tail}`);
    }

    // Classify by kind and output markers
    const names = await this.listNames(srcDir, '');
    const outDir = this.pickStaticOutput(srcDir, names);
    const hasNextBuildId = names.some((n) => n === '.next/build_id');
    const hasSvelteNodeServer = names.some((n) => n === 'build/index.js');

    if (info.kind === 'build-static') {
      if (!outDir) {
        throw new Error(
          'Build succeeded but no static output directory (out/, dist/, build/) was found. If this app is server-rendered, mark it with an SSR adapter or a start script.',
        );
      }
      const count = await this.replaceHtmlWithOutput(srcDir, outDir);
      await onStage?.(`[BUILD] Static output published from ${basename(outDir)} (${count} files)`, 'success');
      return { mode: 'static', framework: info.label, entryCount: count, buildLog: log.slice(-4000) };
    }

    if (info.kind === 'build-auto') {
      // Next.js: .next/BUILD_ID means `next start` is valid; out/ means export.
      // SvelteKit: build/index.js means adapter-node; otherwise static output.
      const nextRuntime = info.label === 'Next.js' && hasNextBuildId;
      const svelteRuntime = info.label === 'SvelteKit' && hasSvelteNodeServer;
      if (!nextRuntime && !svelteRuntime && outDir) {
        const count = await this.replaceHtmlWithOutput(srcDir, outDir);
        await onStage?.(`[BUILD] Static output published from ${basename(outDir)} (${count} files)`, 'success');
        return { mode: 'static', framework: info.label, entryCount: count, buildLog: log.slice(-4000) };
      }
      if (!nextRuntime && !svelteRuntime) {
        throw new Error('Build succeeded but neither a static output (out/, dist/, build/) nor a server build (.next/BUILD_ID, build/index.js) was found.');
      }
    }

    await onStage?.(`[BUILD] Runtime app ready — serving with ${info.runCmd?.join(' ')}`, 'success');
    return { mode: 'runtime', framework: info.label, runCmd: info.runCmd, imageRef: BUILDER_IMAGE, buildLog: log.slice(-4000) };
  }

  /** Blocking docker build with caps; returns the process exit code. */
  private dockerRunScript(srcDir: string, script: string, onChunk: (s: string) => void): Promise<number> {
    return new Promise((resolve) => {
      const args = [
        'run', '--rm',
        // outbound registry access for npm install; no host services exposed
        '--network', 'cloudlane-internal',
        '-m', BUILD_MEMORY,
        '--cpus', BUILD_CPUS,
        '--pids-limit', '256',
        '-v', `${srcDir}:/src`,
        '-w', '/src',
        'node:20-alpine',
        'sh', '-lc', script,
      ];
      const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => {
        onChunk(`\n[timeout] build exceeded ${BUILD_TIMEOUT_MS / 60000} minutes — killed\n`);
        child.kill('SIGKILL');
      }, BUILD_TIMEOUT_MS);
      child.stdout.on('data', (d) => onChunk(String(d)));
      child.stderr.on('data', (d) => onChunk(String(d)));
      child.on('close', (c) => {
        clearTimeout(timer);
        resolve(c ?? 1);
      });
      child.on('error', () => {
        clearTimeout(timer);
        resolve(125);
      });
    });
  }

  // ── output helpers ───────────────────────────────────────────────────────

  private pickStaticOutput(srcDir: string, names: string[]): string | null {
    const rel = ['out', 'dist', 'build'];
    for (const r of rel) {
      if (names.some((n) => n === `${r}/index.html` || n.startsWith(`${r}/`))) return join(srcDir, r);
    }
    // Angular: dist/<project>/browser
    const angular = names.find((n) => /^dist\/[^/]+\/browser\/index\.html$/.test(n));
    if (angular) return join(srcDir, 'dist', angular.split('/')[1], 'browser');
    return null;
  }

  private async hasServerEntry(info: FrameworkInfo): Promise<boolean> {
    return info.kind === 'build-runtime' && Array.isArray(info.runCmd) && info.runCmd.length > 0;
  }

  /** Move the static output into html/ (replacing the source tree). */
  private async replaceHtmlWithOutput(htmlDir: string, outDir: string): Promise<number> {
    const staging = `${htmlDir}-static`;
    await rm(staging, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      const cp = spawn('cp', ['-a', `${outDir}/.`, staging]);
      cp.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`copy failed (${c})`))));
      cp.on('error', reject);
    });
    await rm(htmlDir, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => {
      const cp = spawn('mv', [staging, htmlDir]);
      cp.on('close', (c) => (c === 0 ? resolve() : reject(new Error(`move failed (${c})`))));
      cp.on('error', reject);
    });
    const names = await this.listNames(htmlDir, '');
    return names.filter((n) => !IGNORED_DIRS.some((d) => n.startsWith(d))).length;
  }

  private async pickLockfile(srcDir: string): Promise<string | null> {
    for (const f of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
      try {
        await stat(join(srcDir, f));
        return f;
      } catch { /* next */ }
    }
    return null;
  }

  private async readPackageJson(dir: string): Promise<Record<string, unknown> | null> {
    try {
      const raw = await readFile(join(dir, 'package.json'), 'utf8');
      return JSON.parse(raw) as Record<string, unknown>;
    } catch { return null; }
  }

  private async readFirst(dir: string, files: string[]): Promise<string | null> {
    for (const f of files) {
      try {
        return await readFile(join(dir, f), 'utf8');
      } catch { /* next */ }
    }
    return null;
  }

  private async listNames(dir: string, prefix: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(join(dir, prefix), { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (IGNORED_DIRS.some((d) => (rel + '/').startsWith(d))) continue;
      if (e.isDirectory()) out.push(...(await this.listNames(dir, rel)));
      else out.push(rel.toLowerCase());
    }
    return out;
  }
}
