<script lang="ts">
  import { page } from '$app/state';
  import { api, ApiError, type ProjectSummary, type ServiceDetail } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import DeployDialog from '$features/deploy/DeployDialog.svelte';
  import { toast } from '$stores/toast';

  const projectId = page.params.projectId as string;

  let project = $state<(ProjectSummary & { services?: ServiceDetail[] }) | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let deployOpen = $state(false);

  $effect(() => {
    (async () => {
      try {
        project = await api.projects.get(projectId);
      } catch (err) {
        error = err instanceof ApiError ? err.message : 'Failed to load project.';
      } finally {
        loading = false;
      }
    })();
  });

  function onDeployed(serviceId: string) {
    window.location.href = `/services/${serviceId}`;
  }

  function statusPill(svc: ServiceDetail): { cls: string; label: string } {
    const st = svc.activeDeployment?.status ?? svc.observedState ?? '';
    if (st === 'LIVE') return { cls: 'success', label: 'Live' };
    if (st === 'FAILED') return { cls: 'warning', label: 'Failed' };
    if (st === 'deploying') return { cls: 'warning', label: 'Deploying' };
    return { cls: '', label: 'Draft' };
  }

  function copyLink(id: string) {
    const url = `${window.location.origin}/services/${id}/`;
    navigator.clipboard.writeText(url).then(
      () => toast('info', 'Service URL copied.'),
      () => toast('error', 'Copy failed.'),
    );
  }
</script>

{#if loading}
  <p class="subtitle">Loading project…</p>
{:else if error}
  <div class="callout" role="alert">
    <strong class="strong">Project unavailable</strong>
    <p>{error}</p>
  </div>
{:else if project}
  <nav class="crumb" aria-label="Breadcrumb">
    <a href="/projects">Projects</a>
    <span class="x-crumb-sep">/</span>
    <span class="current">{project.name}</span>
  </nav>
  <header class="page-head">
    <div>
      <h1>{project.name}</h1>
      <p class="subtitle">
        {project.services?.length ?? 0} service{(project.services?.length ?? 0) === 1 ? '' : 's'} in
        this project.
      </p>
    </div>
    <button class="btn primary" type="button" onclick={() => (deployOpen = true)}>
      <Icon name="deployments" size={16} /> Deploy new service
    </button>
  </header>

  {#if !project.services || project.services.length === 0}
    <div class="card empty-state">
      <span class="icon-box"><Icon name="deployments" size={22} /></span>
      <h3>No services in this project</h3>
      <p class="subtitle">Deploy a ZIP file or a GitHub repository to get started.</p>
      <button class="btn primary" type="button" onclick={() => (deployOpen = true)}>
        Deploy new service
      </button>
    </div>
  {:else}
    <div class="card table-card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Service</th>
              <th scope="col">Framework</th>
              <th scope="col">Source</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each project.services as svc (svc.id)}
              <tr>
                <td>
                  <strong class="strong">{svc.name}</strong>
                  <small class="mono">/services/{svc.id}/</small>
                </td>
                <td>{svc.framework}</td>
                <td class="mono">{svc.source === 'github' ? `GitHub · ${svc.githubLink?.repoFullName ?? ''}` : `ZIP · ${svc.zipSource?.detectedFramework ?? ''}`}</td>
                <td>
                  <span class="pill {statusPill(svc).cls}">
                    <span class="dot" aria-hidden="true"></span>
                    {statusPill(svc).label}
                  </span>
                </td>
                <td>
                  <div class="row wrap" style="gap: 6px;">
                    <a class="btn secondary small" href={`/services/${svc.id}`}>Manage</a>
                    {#if svc.activeDeployment?.status === 'LIVE'}
                      <button class="icon-btn" type="button" aria-label="Copy service URL" onclick={() => copyLink(svc.id)}>
                        <Icon name="copy" size={16} />
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
  {/if}
{/if}

<DeployDialog {projectId} bind:open={deployOpen} ondeployed={onDeployed} />

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
    margin-bottom: 28px;
  }
  h1 {
    margin: 0 0 4px;
  }
  .table-card {
    padding: 0;
  }
  td small {
    display: block;
    color: var(--muted);
  }
</style>
