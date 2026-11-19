<script lang="ts">
  import { page } from '$app/state';
  import { api, ApiError, type ServiceDetail, type DeploymentSummary, type DeploymentEvent, type ServiceVariable, type DomainInfo } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import Dialog from '$design/Dialog.svelte';
  import { toast } from '$stores/toast';

  const serviceId = page.params.serviceId as string;
  const TABS = ['Overview', 'Deployments', 'Logs', 'Variables', 'Domains', 'Settings'] as const;
  type Tab = (typeof TABS)[number];

  let tab = $state<Tab>('Overview');

  let svc = $state<ServiceDetail | null>(null);
  let deployments = $state<DeploymentSummary[]>([]);
  let variables = $state<ServiceVariable[]>([]);
  let domains = $state<DomainInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let events = $state<DeploymentEvent[]>([]);
  let selectedDeployment = $state('');
  let eventsTimer: ReturnType<typeof setInterval> | null = null;

  // step-up (variables + rollback) via password reauthentication
  let stepUpOpen = $state(false);
  let stepUpPassword = $state('');
  let stepUpBusy = $state(false);
  let stepUpError = $state<string | null>(null);
  type PendingAction =
    | { kind: 'setVar'; key: string; value: string }
    | { kind: 'delVar'; key: string }
    | { kind: 'rollback'; deploymentId: string };
  let pendingAction = $state<PendingAction | null>(null);

  // redeploy progress
  let redeploying = $state(false);
  let pipelineEvents = $state<DeploymentEvent[]>([]);
  let pipelineDone = $state<null | 'LIVE' | 'FAILED'>(null);

  async function refresh() {
    try {
      svc = await api.services.get(serviceId);
      deployments = (await api.deployments.list(serviceId)).items;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Failed to load service.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    (async () => {
      await refresh();
      try {
        domains = (await api.domains.list()).items;
      } catch {
        domains = [];
      }
    })();
  });

  $effect(() => {
    if (tab === 'Variables' && variables.length === 0 && svc) {
      loadVariables();
    }
    if (tab === 'Logs' && deployments.length > 0 && !selectedDeployment) {
      selectedDeployment = deployments[0].id;
    }
    if (tab === 'Deployments') {
      watchActivePipeline();
    }
  });

  let pipelineWatcher: ReturnType<typeof setInterval> | null = null;

  function watchActivePipeline() {
    const active = deployments[0];
    if (!active) return;
    const activeStages = ['REQUESTED', 'QUEUED', 'FETCHING', 'VALIDATING', 'DETECTING', 'BUILDING', 'STARTING_CANDIDATE', 'HEALTH_CHECKING', 'ACTIVATING'];
    if (!activeStages.includes(active.status)) {
      if (pipelineWatcher) { clearInterval(pipelineWatcher); pipelineWatcher = null; }
      return;
    }
    if (pipelineWatcher) return;
    pipelineWatcher = setInterval(async () => {
      try {
        const res = await api.deployments.list(serviceId);
        deployments = res.items;
        const top = res.items[0];
        if (!top || !activeStages.includes(top.status)) {
          if (pipelineWatcher) clearInterval(pipelineWatcher);
          pipelineWatcher = null;
        }
      } catch {
        /* transient */
      }
    }, 3000);
  }

  $effect(() => {
    if (tab === 'Logs' && selectedDeployment) {
      loadEvents(selectedDeployment);
      if (eventsTimer) clearInterval(eventsTimer);
      const dep = deployments.find((d) => d.id === selectedDeployment);
      const activeStages = ['REQUESTED', 'QUEUED', 'FETCHING', 'VALIDATING', 'DETECTING', 'BUILDING', 'STARTING_CANDIDATE', 'HEALTH_CHECKING', 'ACTIVATING'];
      if (dep && activeStages.includes(dep.status)) {
        eventsTimer = setInterval(() => loadEvents(selectedDeployment), 2000);
      }
    }
    return () => {
      if (eventsTimer) clearInterval(eventsTimer);
      eventsTimer = null;
    };
  });

  async function loadEvents(deploymentId: string) {
    try {
      events = (await api.deployments.events(serviceId, deploymentId)).items;
    } catch {
      /* transient */
    }
  }

  async function loadVariables() {
    try {
      variables = (await api.services.variables.list(serviceId)).items;
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Failed to load variables.');
    }
  }

  function statusPill(status: string | null): { cls: string; label: string } {
    if (status === 'LIVE') return { cls: 'success', label: 'Live' };
    if (status === 'FAILED') return { cls: 'warning', label: 'Failed' };
    if (['REQUESTED', 'QUEUED', 'FETCHING', 'VALIDATING', 'DETECTING', 'BUILDING', 'STARTING_CANDIDATE', 'HEALTH_CHECKING', 'ACTIVATING'].includes(status ?? ''))
      return { cls: 'warning', label: 'Deploying' };
    if (status === 'deploying') return { cls: 'warning', label: 'Deploying' };
    return { cls: '', label: status || 'Draft' };
  }

  function fmtSize(bytes: number): string {
    if (bytes > 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    if (bytes > 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${bytes} B`;
  }

  function fmtUptime(startedAt: string, finishedAt: string | null): string {
    if (!finishedAt) return '—';
    const s = Math.round((new Date(finishedAt).getTime() - new Date(startedAt).getTime()) / 1000);
    return s < 60 ? `${s}s` : `${Math.round(s / 60)}m ${s % 60}s`;
  }

  function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  // ---------- step-up + actions ----------
  function requestStepUp(action: NonNullable<typeof pendingAction>) {
    pendingAction = action;
    stepUpPassword = '';
    stepUpError = null;
    stepUpOpen = true;
  }

  async function confirmStepUp(e: SubmitEvent) {
    e.preventDefault();
    stepUpBusy = true;
    stepUpError = null;
    try {
      await api.auth.reauthenticatePassword(stepUpPassword);
      stepUpOpen = false;
      const act = pendingAction;
      if (!act) return;
      if (act.kind === 'setVar') {
        await api.services.variables.set(serviceId, act.key, act.value);
        toast('success', `Variable ${act.key} saved.`);
        await loadVariables();
        await refresh();
      } else if (act.kind === 'delVar') {
        await api.services.variables.remove(serviceId, act.key);
        toast('info', `Variable ${act.key} deleted.`);
        await loadVariables();
        await refresh();
      } else if (act.kind === 'rollback') {
        await api.deployments.rollback(serviceId, act.deploymentId);
        toast('success', 'Rollback completed — previous release is live.');
        await refresh();
      }
    } catch (err) {
      stepUpError =
        err instanceof ApiError
          ? err.status === 401
            ? 'Password is not correct.'
            : err.message
          : 'Reauthentication failed.';
    } finally {
      stepUpBusy = false;
    }
  }

  async function redeploy() {
    redeploying = true;
    pipelineEvents = [];
    pipelineDone = null;
    try {
      const res = await api.deployments.redeploy(serviceId);
      const poll = setInterval(async () => {
        try {
          const res2 = await api.deployments.events(serviceId, res.deploymentId);
          pipelineEvents = res2.items;
          const last = res2.items[res2.items.length - 1];
          if (last?.stage === 'LIVE' || last?.stage === 'FAILED') {
            clearInterval(poll);
            pipelineDone = last.stage as 'LIVE' | 'FAILED';
            redeploying = false;
            await refresh();
            toast(last.stage === 'LIVE' ? 'success' : 'error', last.stage === 'LIVE' ? 'Redeployment is live.' : 'Redeployment failed.');
          }
        } catch {
          /* transient */
        }
      }, 2000);
    } catch (err) {
      redeploying = false;
      toast('error', err instanceof ApiError ? err.message : 'Redeploy failed.');
    }
  }

  function copyUrl() {
    navigator.clipboard.writeText(`${window.location.origin}/services/${serviceId}/`).then(
      () => toast('info', 'Service URL copied.'),
      () => toast('error', 'Copy failed.'),
    );
  }
</script>

{#if loading}
  <p class="subtitle">Loading service…</p>
{:else if error || !svc}
  <div class="callout" role="alert">
    <strong class="strong">Service unavailable</strong>
    <p>{error ?? 'Not found.'}</p>
  </div>
{:else}
  <nav class="crumb" aria-label="Breadcrumb">
    <a href="/projects">Projects</a>
    <span>/</span>
    <a href={`/projects/${svc.projectId}`}>{svc.projectId.slice(0, 8)}…</a>
    <span>/</span>
    <span class="current">{svc.name}</span>
  </nav>

  <header class="page-head">
    <div>
      <h1>{svc.name}</h1>
      <p class="subtitle">
        {svc.framework} · {svc.source === 'github' ? `GitHub ${svc.githubLink?.repoFullName}` : 'ZIP upload'} ·
        created {timeAgo(svc.createdAt)}
        {#if svc.activeDeployment?.status === 'LIVE'}
          · live at <a href={`/services/${serviceId}/`} class="mono url-link">/services/{serviceId}/</a>
        {/if}
      </p>
    </div>
    <div class="row" style="gap: 8px;">
      {#if svc.activeDeployment?.status === 'LIVE'}
        <button class="icon-btn" type="button" aria-label="Copy service URL" onclick={copyUrl}>
          <Icon name="copy" />
        </button>
        <a class="btn secondary" href={`/services/${serviceId}/`} target="_blank" rel="noopener">
          <Icon name="external" size={14} /> Open
        </a>
      {/if}
      <button class="btn primary" type="button" disabled={redeploying} onclick={redeploy}>
        <Icon name="deployments" size={16} /> {redeploying ? 'Redeploying…' : 'Redeploy'}
      </button>
    </div>
  </header>

  {#if redeploying || pipelineDone}
    <div class="card" style="margin-bottom: 20px;">
      <ol class="event-log mono" aria-live="polite">
        {#each pipelineEvents as ev (ev.id)}
          <li class="lvl-{ev.level}">
            <span class="ts">{new Date(ev.createdAt).toLocaleTimeString()}</span>
            <span>{ev.message}</span>
          </li>
        {:else}
          <li><span>Queuing deployment…</span></li>
        {/each}
      </ol>
    </div>
  {/if}

  <div class="tabs" role="tablist" aria-label="Service sections">
    {#each TABS as t (t)}
      <button
        class="tab"
        class:active={tab === t}
        role="tab"
        aria-selected={tab === t}
        type="button"
        onclick={() => (tab = t)}
      >
        {t}
      </button>
    {/each}
  </div>

  <section class="tab-panel">
    {#if tab === 'Overview'}
      <div class="facts-grid">
        <div class="card fact">
          <span class="eyebrow">Status</span>
          <span class="pill {statusPill(svc.activeDeployment?.status ?? svc.observedState).cls}">
            <span class="dot" aria-hidden="true"></span>
            {statusPill(svc.activeDeployment?.status ?? svc.observedState).label}
          </span>
        </div>
        <div class="card fact">
          <span class="eyebrow">Framework</span>
          <strong>{svc.framework}</strong>
        </div>
        <div class="card fact">
          <span class="eyebrow">Source</span>
          <strong>{svc.source === 'github' ? 'GitHub' : 'ZIP upload'}</strong>
          <small>{svc.source === 'github' ? svc.githubLink?.repoFullName : svc.zipSource?.detectedFramework}</small>
        </div>
        <div class="card fact">
          <span class="eyebrow">Environment variables</span>
          <strong class="tabular">{svc.variables.length}</strong>
        </div>
      </div>
      <div class="callout">
        <strong class="strong">Service URL</strong>
        <p>
          {#if svc.activeDeployment?.status === 'LIVE'}
            This service is served at <code class="mono">/services/{serviceId}/</code> on this
            installation. Custom hostnames can be attached after domain verification
            (see Domains).
          {:else}
            The default URL becomes available when a deployment reaches LIVE state.
          {/if}
        </p>
      </div>
    {:else if tab === 'Deployments'}
      {#if deployments.length === 0}
        <div class="card empty-state">
          <span class="icon-box"><Icon name="deployments" size={22} /></span>
          <h3>No deployments yet</h3>
          <p class="subtitle">Use Redeploy to trigger the first pipeline run.</p>
        </div>
      {:else}
        <div class="card table-card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Revision</th>
                  <th scope="col">Status</th>
                  <th scope="col">Started</th>
                  <th scope="col">Duration</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each deployments as dep (dep.id)}
                  <tr>
                    <td class="mono">{dep.revision}</td>
                    <td>
                      <span class="pill {statusPill(dep.status).cls}">
                        <span class="dot" aria-hidden="true"></span>
                        {statusPill(dep.status).label}
                      </span>
                      {#if dep.errorMessage}
                        <small class="error-inline">{dep.errorMessage}</small>
                      {/if}
                    </td>
                    <td>{timeAgo(dep.startedAt)}</td>
                    <td>{fmtUptime(dep.startedAt, dep.finishedAt)}</td>
                    <td>
                      <div class="row" style="gap: 6px;">
                        <button class="btn secondary small" type="button" onclick={() => { selectedDeployment = dep.id; tab = 'Logs'; }}>
                          Logs
                        </button>
                        {#if dep.status === 'LIVE' && svc.activeDeploymentId !== dep.id}
                          <button class="btn secondary small" type="button" onclick={() => requestStepUp({ kind: 'rollback', deploymentId: dep.id })}>
                            Rollback
                          </button>
                        {/if}
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
        <p class="subtitle quiet">
          Rollback re-activates a previous release through the agent with an atomic Caddy swap
          (build plan §11.4) and requires re-authentication.
        </p>
      {/if}
    {:else if tab === 'Logs'}
      <label class="field">
        Deployment
        <select bind:value={selectedDeployment}>
          {#each deployments as dep (dep.id)}
            <option value={dep.id}>{dep.revision} — {dep.status}</option>
          {/each}
        </select>
      </label>
      <ol class="event-log mono" aria-live="polite">
        {#each events as ev (ev.id)}
          <li class="lvl-{ev.level}">
            <span class="ts">{new Date(ev.createdAt).toLocaleTimeString()}</span>
            <span>{ev.message}</span>
          </li>
        {:else}
          <li><span class="ts">—</span><span>No events for this deployment.</span></li>
        {/each}
      </ol>
    {:else if tab === 'Variables'}
      <div class="row" style="justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <p class="subtitle" style="margin: 0;">
          Environment variables are encrypted at rest and injected into service deployments.
          Changes require re-authentication.
        </p>
        <button class="btn primary" type="button" onclick={() => requestStepUp({ kind: 'setVar', key: '', value: '' })}>
          <Icon name="plus" size={16} /> Add variable
        </button>
      </div>
      {#if variables.length === 0}
        <div class="card empty-state">
          <span class="icon-box"><Icon name="key" size={22} /></span>
          <h3>No variables set</h3>
          <p class="subtitle">Values are stored encrypted and shown only to the owner.</p>
        </div>
      {:else}
        <div class="card table-card">
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th scope="col">Key</th>
                  <th scope="col">Value</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {#each variables as v (v.key)}
                  <tr>
                    <td class="mono">{v.key}</td>
                    <td class="mono var-value">{v.value}</td>
                    <td>{timeAgo(v.updatedAt)}</td>
                    <td>
                      <div class="row" style="gap: 6px;">
                        <button class="btn secondary small" type="button" onclick={() => requestStepUp({ kind: 'setVar', key: v.key, value: v.value })}>
                          Edit
                        </button>
                        <button class="btn danger small" type="button" onclick={() => requestStepUp({ kind: 'delVar', key: v.key })}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    {:else if tab === 'Domains'}
      <div class="callout">
        <strong class="strong">Default service URL</strong>
        <p>
          This service is reachable at <code class="mono">/services/{serviceId}/</code> on the
          installation address. Attach a custom domain in Phase 4 — verified domains are listed
          under <a href="/domains">Domains</a> and will be selectable here.
        </p>
      </div>
      <div class="card table-card">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Verified domain</th>
                <th scope="col">Status</th>
                <th scope="col">Attachment</th>
              </tr>
            </thead>
            <tbody>
              {#each domains.filter((d) => d.status === 'VERIFIED') as d (d.id)}
                <tr>
                  <td class="mono">{d.host}</td>
                  <td><span class="pill success"><span class="dot" aria-hidden="true"></span>Verified</span></td>
                  <td><small class="quiet">Planned for Phase 4 (custom hostname routing)</small></td>
                </tr>
              {:else}
                <tr>
                  <td colspan={3}><small class="quiet">No verified domains yet — add one under Domains.</small></td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {:else if tab === 'Settings'}
      <h2 style="margin-top: 0;">Source</h2>
      {#if svc.source === 'zip' && svc.zipSource}
        <div class="facts-grid">
          <div class="card fact">
            <span class="eyebrow">Archive size</span>
            <strong>{fmtSize(svc.zipSource.fileSize)}</strong>
          </div>
          <div class="card fact">
            <span class="eyebrow">Entries</span>
            <strong class="tabular">{svc.zipSource.entryCount}</strong>
          </div>
          <div class="card fact sha-fact">
            <span class="eyebrow">SHA-256</span>
            <code class="mono sha">{svc.zipSource.sha256}</code>
          </div>
        </div>
      {:else if svc.source === 'github' && svc.githubLink}
        <div class="facts-grid">
          <div class="card fact">
            <span class="eyebrow">Repository</span>
            <strong class="mono">{svc.githubLink.repoFullName}</strong>
          </div>
          <div class="card fact">
            <span class="eyebrow">Branch</span>
            <strong class="mono">{svc.githubLink.branch}</strong>
          </div>
          <div class="card fact">
            <span class="eyebrow">Last revision</span>
            <strong class="mono">{svc.githubLink.lastRevision?.slice(0, 7) ?? '—'}</strong>
          </div>
        </div>
        <p class="subtitle quiet">
          Auto-deploy via GitHub webhooks arrives with the GitHub App integration (Phase 3).
        </p>
      {/if}
      <h2>Runtime</h2>
      <div class="facts-grid">
        <div class="card fact">
          <span class="eyebrow">Desired state</span>
          <strong>{svc.status}</strong>
        </div>
        <div class="card fact">
          <span class="eyebrow">Observed state</span>
          <strong>{svc.observedState ?? '—'}</strong>
        </div>
        <div class="card fact">
          <span class="eyebrow">Active deployment</span>
          <strong class="mono">{svc.activeDeploymentId?.slice(0, 8) ?? '—'}</strong>
        </div>
      </div>
    {/if}
  </section>
{/if}

<!-- step-up dialog -->
<Dialog title="Re-authenticate" bind:open={stepUpOpen} onclose={() => (pendingAction = null)}>
  <form onsubmit={confirmStepUp} novalidate>
    <p class="subtitle">
      This action touches service configuration. Confirm your password to continue
      (step-up unlocks sensitive operations for 5 minutes).
    </p>
    <label class="field">
      Password
      <input type="password" bind:value={stepUpPassword} autocomplete="current-password" required />
    </label>
    {#if stepUpError}<p class="error" role="alert">{stepUpError}</p>{/if}
    <button class="btn primary full" type="submit" disabled={stepUpBusy || !stepUpPassword}>
      {stepUpBusy ? 'Verifying…' : 'Confirm'}
    </button>
  </form>
</Dialog>

<style>
  .crumb {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 13px;
    margin-bottom: 10px;
    color: var(--muted);
  }
  .crumb a {
    color: var(--muted);
  }
  .crumb .current {
    color: var(--text);
    font-weight: 600;
  }
  .page-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  h1 {
    margin: 0 0 4px;
  }
  .url-link {
    color: var(--primary);
  }
  .facts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 14px;
    margin-bottom: 16px;
  }
  .fact {
    display: grid;
    gap: 6px;
    align-content: start;
    padding: 16px 18px;
  }
  .sha {
    word-break: break-all;
    font-size: 12px;
    color: var(--secondary);
  }
  .table-card {
    padding: 0;
  }
  td small {
    display: block;
    color: var(--muted);
  }
  .error-inline {
    display: block;
    color: var(--danger);
    font-size: 12px;
  }
  .var-value {
    max-width: 320px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .event-log {
    background: var(--sunken);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: 12px 14px;
    max-height: 340px;
    overflow-y: auto;
    font-size: 12px;
    line-height: 1.6;
    margin: 0 0 16px;
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
  .event-log .lvl-success span:last-child {
    color: var(--success);
  }
  .event-log .lvl-error span:last-child {
    color: var(--danger);
  }
  .event-log .lvl-warning span:last-child {
    color: var(--warning);
  }
  .full {
    width: 100%;
  }
</style>
