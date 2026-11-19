<script lang="ts">
  import { api, ApiError, fileSha256, type DeploymentEvent } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import Dialog from '$design/Dialog.svelte';
  import { toast } from '$stores/toast';

  /**
   * Deploy wizard (prototype "Deploy a new project" + build plan §11.1/§11.2):
   * source choice (ZIP / GitHub) → upload or repo fields → create service →
   * live pipeline events → LIVE / FAILED with retry.
   */
  interface DeployDialogProps {
    open?: boolean;
    projectId: string;
    ondeployed?: (serviceId: string, deploymentId: string) => void;
  }
  let {
    open = $bindable(false),
    projectId,
    ondeployed,
  }: DeployDialogProps = $props();

  let source: 'zip' | 'github' | null = $state(null);
  let file = $state<File | null>(null);
  let uploadId = $state('');
  let dragOver = $state(false);
  let phase: 'choose' | 'configure' | 'deploying' | 'done' | 'failed' = $state('choose');
  let detected = $state<{ detectedFramework: string; entryCount: number } | null>(null);
  let serviceName = $state('');
  let repoFullName = $state('');
  let branch = $state('main');
  let events = $state<DeploymentEvent[]>([]);
  let deploymentId = $state('');
  let serviceId = $state('');
  let error = $state<string | null>(null);
  let busy = $state(false);
  let deployError = $state('');

  const isZip = $derived(source === 'zip');
  const canDeploy = $derived(
    isZip
      ? !!file && !!detected && /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(serviceName)
      : /^[\w.-]+\/[\w.-]+$/.test(repoFullName.trim()) &&
          /^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/.test(serviceName),
  );

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function reset() {
    source = null;
    file = null;
    uploadId = '';
    detected = null;
    serviceName = '';
    repoFullName = '';
    branch = 'main';
    events = [];
    deploymentId = '';
    serviceId = '';
    phase = 'choose';
    error = null;
    deployError = '';
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function close() {
    open = false;
    setTimeout(reset, 300);
  }

  async function pickFile(f: File | undefined | null) {
    error = null;
    if (!f) return;
    if (!f.name.toLowerCase().endsWith('.zip')) {
      error = 'Only .zip files are accepted.';
      return;
    }
    if (f.size > 50 * 1024 * 1024) {
      error = 'File too large. Maximum 50 MB.';
      return;
    }
    file = f;
    busy = true;
    try {
      const sha = await fileSha256(f);
      const init = await api.uploads.init(f.name, f.size, 'application/zip');
      uploadId = init.uploadId;
      await api.uploads.receive(init.uploadUrl, f, sha);
      detected = await api.uploads.finalize(init.uploadId, sha);
      if (!serviceName) serviceName = slugify(f.name.replace(/\.zip$/i, ''));
      toast('info', `Validated: ${detected.entryCount} entries, framework ${detected.detectedFramework}`);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Upload failed.';
      file = null;
      detected = null;
    } finally {
      busy = false;
    }
  }

  function slugify(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 49);
  }

  async function deploy() {
    error = null;
    busy = true;
    phase = 'deploying';
    try {
      let res: { serviceId: string; deploymentId: string };
      if (isZip) {
        res = await api.services.createFromZip(projectId, {
          name: serviceName,
          role: 'web',
          uploadId,
          framework: detected?.detectedFramework,
        });
      } else {
        res = await api.services.createFromGithub(projectId, {
          name: serviceName,
          role: 'web',
          repoFullName: repoFullName.trim(),
          branch: branch.trim() || 'main',
        });
      }
      serviceId = res.serviceId;
      deploymentId = res.deploymentId;
      pollEvents(serviceId, deploymentId);
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Deployment could not be queued.';
      phase = isZip ? 'configure' : 'configure';
    } finally {
      busy = false;
    }
  }

  function pollEvents(sid: string, did: string) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(async () => {
      try {
        const res = await api.deployments.events(sid, did);
        events = res.items;
        const last = events[events.length - 1];
        if (last?.stage === 'LIVE') {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          phase = 'done';
          toast('success', 'Deployment is live.');
        } else if (last?.stage === 'FAILED') {
          if (pollTimer) clearInterval(pollTimer);
          pollTimer = null;
          deployError = last.message;
          phase = 'failed';
          toast('error', 'Deployment failed.');
        }
      } catch {
        /* transient poll errors are ignored; the next tick retries */
      }
    }, 2000);
  }

  function done() {
    open = false;
    if (ondeployed && serviceId) ondeployed(serviceId, deploymentId);
    setTimeout(reset, 300);
  }
</script>

<Dialog title="Deploy a new project" bind:open onclose={close}>
  {#if phase === 'choose'}
    <div class="choice-stack">
      <button
        class="choice"
        class:selected={source === 'zip'}
        type="button"
        aria-pressed={source === 'zip'}
        onclick={() => {
          source = 'zip';
          phase = 'configure';
        }}
      >
        <Icon name="file" />
        <span>
          <strong>ZIP file</strong>
          <small>Upload a static site archive (.zip) from this device.</small>
        </span>
      </button>
      <button
        class="choice"
        class:selected={source === 'github'}
        type="button"
        aria-pressed={source === 'github'}
        onclick={() => {
          source = 'github';
          phase = 'configure';
        }}
      >
        <Icon name="github" />
        <span>
          <strong>GitHub repository</strong>
          <small>Deploy the branch archive of a public repository.</small>
        </span>
      </button>
    </div>
  {:else if phase === 'configure'}
    {#if isZip}
      <div
        class="upload-drop"
        class:drag-over={dragOver}
        role="button"
        tabindex="0"
        aria-label="Upload a ZIP file"
        ondragover={(e) => {
          e.preventDefault();
          dragOver = true;
        }}
        ondragleave={() => (dragOver = false)}
        ondrop={(e) => {
          e.preventDefault();
          dragOver = false;
          pickFile(e.dataTransfer?.files?.[0]);
        }}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') document.getElementById('deploy-file-input')?.click();
        }}
      >
        <span class="icon-box"><Icon name="upload" size={22} /></span>
        <h3>{file ? file.name : 'Upload website files'}</h3>
        <p class="subtitle">
          {busy
            ? 'Validating archive…'
            : file && detected
              ? `${detected.entryCount} entries · framework ${detected.detectedFramework}`
              : 'Drop a .zip here or choose one to preview its name.'}
        </p>
        <button class="btn secondary" type="button" onclick={() => document.getElementById('deploy-file-input')?.click()}>
          {file ? 'Choose another file' : 'Choose file'}
        </button>
        <input
          id="deploy-file-input"
          type="file"
          accept=".zip"
          hidden
          onchange={(e) => pickFile((e.currentTarget as HTMLInputElement).files?.[0])}
        />
      </div>
    {:else}
      <label class="field">
        Repository
        <input
          bind:value={repoFullName}
          placeholder="owner/repo"
          class="mono"
          spellcheck="false"
        />
        <small>Public repositories only in Phase 1+2. The branch archive is fetched at deploy time.</small>
      </label>
      <label class="field">
        Branch
        <input bind:value={branch} placeholder="main" class="mono" spellcheck="false" />
      </label>
    {/if}

    <label class="field">
      Service name
      <input bind:value={serviceName} placeholder="main-website" class="mono" spellcheck="false" />
      <small>Lowercase letters, digits and hyphens. Used in the service URL.</small>
    </label>

    {#if error}<p class="error" role="alert">{error}</p>{/if}

    {#snippet footer()}
      <button class="btn" type="button" onclick={() => (phase = 'choose')}>Back</button>
      <button class="btn primary" type="button" disabled={!canDeploy || busy} onclick={deploy}>
        {busy ? 'Starting…' : 'Deploy now'}
      </button>
    {/snippet}
  {:else if phase === 'deploying' || phase === 'done' || phase === 'failed'}
    <div class="pipeline">
      <ol class="event-log mono" aria-live="polite">
        {#each events as ev (ev.id)}
          <li class="lvl-{ev.level}">
            <span class="ts">{new Date(ev.createdAt).toLocaleTimeString()}</span>
            <span class="msg">{ev.message}</span>
          </li>
        {:else}
          <li class="lvl-info"><span class="msg">Queuing deployment…</span></li>
        {/each}
      </ol>
      {#if phase === 'done'}
        <div class="well">
          <div class="row">
            <span class="step-icon complete">✓</span>
            <strong class="strong">Deployment is live</strong>
          </div>
          <p class="subtitle">
            Served at <code class="mono">/services/{serviceId}/</code>
          </p>
        </div>
      {:else if phase === 'failed'}
        <div class="callout" style="border-color: var(--danger);" role="alert">
          <strong class="strong">Deployment failed</strong>
          <p>{deployError}</p>
        </div>
      {/if}
    </div>

    {#snippet footer()}
      {#if phase === 'done'}
        <button class="btn primary" type="button" onclick={done}>
          <Icon name="external" size={14} /> Open service
        </button>
      {:else if phase === 'failed'}
        <button class="btn" type="button" onclick={done}>Close</button>
        <button class="btn primary" type="button" onclick={() => (phase = 'configure')}>Retry</button>
      {:else}
        <span class="subtitle"><span class="spinner" aria-hidden="true"></span> Pipeline running…</span>
        <button class="btn" type="button" onclick={done}>Run in background</button>
      {/if}
    {/snippet}
  {/if}
</Dialog>

<style>
  .choice-stack {
    display: grid;
    gap: 12px;
  }
  .spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    border: 2px solid var(--border-default);
    border-top-color: var(--primary);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
    vertical-align: -2px;
    margin-right: 6px;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
  .pipeline {
    display: grid;
    gap: 14px;
  }
  .event-log {
    background: var(--sunken);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    max-height: 260px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.6;
    margin: 0;
    list-style: none;
  }
  .event-log li {
    display: flex;
    gap: 10px;
  }
  .event-log .ts {
    color: var(--muted);
    flex-shrink: 0;
  }
  .event-log .lvl-success .msg {
    color: var(--success);
  }
  .event-log .lvl-error .msg {
    color: var(--danger);
  }
  .event-log .lvl-warning .msg {
    color: var(--warning);
  }
</style>
