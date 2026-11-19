<script lang="ts">
  import { api, type OverviewData, ApiError } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import { toast } from '$stores/toast';

  let data = $state<OverviewData | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);

  $effect(() => {
    (async () => {
      try {
        data = await api.overview.get();
      } catch (err) {
        error = err instanceof ApiError ? err.message : 'Failed to load overview.';
      } finally {
        loading = false;
      }
    })();
  });

  function statusPill(status: string | null): { cls: string; label: string } {
    switch (status) {
      case 'LIVE':
        return { cls: 'success', label: 'Live' };
      case 'FAILED':
        return { cls: 'warning', label: 'Failed' };
      case 'deploying':
        return { cls: 'warning', label: 'Deploying' };
      default:
        return { cls: '', label: 'Draft' };
    }
  }

  function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return `${Math.floor(s / 86400)} d ago`;
  }

  function openService(id: string) {
    window.location.href = `/services/${id}`;
  }
</script>

{#if loading}
  <p class="subtitle">Loading workspace…</p>
{:else if error}
  <div class="callout" role="alert">
    <strong class="strong">Overview unavailable</strong>
    <p>{error}</p>
  </div>
{:else if data}
  <header class="page-head">
    <div>
      <h1>Overview</h1>
      <p class="subtitle">{data.workspace?.name ?? 'Workspace'} — real-time platform state.</p>
    </div>
    <a class="btn primary" href="/projects">
      <Icon name="plus" size={16} /> Deploy new
    </a>
  </header>

  <div class="stats-grid">
    <div class="card stat">
      <span class="eyebrow">Projects</span>
      <span class="summary-num tabular">{data.stats.projects}</span>
    </div>
    <div class="card stat">
      <span class="eyebrow">Services</span>
      <span class="summary-num tabular">{data.stats.services}</span>
    </div>
    <div class="card stat">
      <span class="eyebrow">Live deployments</span>
      <span class="summary-num tabular">{data.stats.live}</span>
    </div>
    <div class="card stat">
      <span class="eyebrow">Needs attention</span>
      <span class="summary-num tabular">{data.stats.failed}</span>
    </div>
  </div>

  <h2>Projects</h2>
  {#if data.projects.length === 0}
    <div class="card empty-state">
      <span class="icon-box"><Icon name="projects" size={22} /></span>
      <h3>No projects yet</h3>
      <p class="subtitle">Projects will appear here once you create one.</p>
      <a class="btn primary" href="/projects">Create project</a>
    </div>
  {:else}
    <div class="tiles">
      {#each data.projects as project (project.id)}
        <a class="project-tile tile14" href={`/projects/${project.id}`}>
          <span class="project-tile-icon mark14"><Icon name="projects" /></span>
          <span class="tile14-text">
            <strong class="project-tile-name">{project.name}</strong>
            <small class="project-tile-address">
              {project.services.length} service{project.services.length === 1 ? '' : 's'}
            </small>
          </span>
          {#each project.services.slice(0, 1) as svc (svc.id)}
            {#if svc.activeDeploymentStatus}
              <span class="pill {statusPill(svc.activeDeploymentStatus).cls}">
                <span class="dot" aria-hidden="true"></span>
                {statusPill(svc.activeDeploymentStatus).label}
              </span>
            {/if}
          {/each}
        </a>
      {/each}
    </div>
  {/if}

  <h2>Services</h2>
  {#if data.projects.every((p) => p.services.length === 0)}
    <div class="card empty-state">
      <span class="icon-box"><Icon name="deployments" size={22} /></span>
      <h3>No services deployed</h3>
      <p class="subtitle">Deploy a ZIP file or a GitHub repository to get started.</p>
      <a class="btn primary" href="/projects">Deploy a service</a>
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
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {#each data.projects as project (project.id)}
              {#each project.services as svc (svc.id)}
                <tr>
                  <td>
                    <strong class="strong">{svc.name}</strong>
                    <small>{project.name}</small>
                  </td>
                  <td>{svc.framework}</td>
                  <td class="mono">{svc.source === 'github' ? 'GitHub' : 'ZIP'}</td>
                  <td>
                    {#if svc.activeDeploymentStatus}
                      <span class="pill {statusPill(svc.activeDeploymentStatus).cls}">
                        <span class="dot" aria-hidden="true"></span>
                        {statusPill(svc.activeDeploymentStatus).label}
                      </span>
                    {:else}
                      <span class="pill"><span class="dot" aria-hidden="true"></span>Draft</span>
                    {/if}
                  </td>
                  <td>
                    <button class="btn secondary small" type="button" onclick={() => openService(svc.id)}>
                      Manage
                    </button>
                  </td>
                </tr>
              {/each}
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}

  <h2>Recent activity</h2>
  {#if data.recentActivity.length === 0}
    <p class="subtitle quiet">No recorded activity yet.</p>
  {:else}
    <div class="card">
      <ul class="activity-list">
        {#each data.recentActivity as ev (ev.id)}
          <li>
            <span class="pill {ev.status === 'success' ? 'success' : ev.status === 'error' ? 'warning' : ''}">
              <span class="dot" aria-hidden="true"></span>{ev.status}
            </span>
            <span class="act-desc">{ev.action.replaceAll('_', ' ').toLowerCase()}</span>
            <small class="quiet">{timeAgo(ev.createdAt)}</small>
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/if}

<style>
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
  h2 {
    margin: 28px 0 12px;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
    gap: 14px;
  }
  .stat {
    display: grid;
    gap: 6px;
    padding: 18px 20px;
  }
  .tiles {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px;
  }
  @media (min-width: 1380px) {
    .tiles {
      grid-template-columns: repeat(3, 1fr);
    }
  }
  @media (max-width: 700px) {
    .tiles {
      grid-template-columns: 1fr;
    }
  }
  .table-card {
    padding: 0;
  }
  .activity-list {
    list-style: none;
    margin: 0;
    padding: 8px 0;
    display: grid;
  }
  .activity-list li {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 20px;
    border-bottom: 1px solid var(--border);
  }
  .activity-list li:last-child {
    border-bottom: 0;
  }
  .act-desc {
    flex: 1;
    font-size: 14px;
    color: var(--secondary);
  }
</style>
