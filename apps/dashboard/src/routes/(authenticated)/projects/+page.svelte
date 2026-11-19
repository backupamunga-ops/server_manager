<script lang="ts">
  import { api, ApiError, type ProjectSummary } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import Dialog from '$design/Dialog.svelte';
  import { toast } from '$stores/toast';

  let projects = $state<ProjectSummary[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let showNew = $state(false);
  let newName = $state('');
  let creating = $state(false);
  let newError = $state<string | null>(null);

  $effect(() => {
    (async () => {
      try {
        projects = await api.projects.list();
      } catch (err) {
        error = err instanceof ApiError ? err.message : 'Failed to load projects.';
      } finally {
        loading = false;
      }
    })();
  });

  async function createProject(e: SubmitEvent) {
    e.preventDefault();
    newError = null;
    creating = true;
    try {
      const created = await api.projects.create(newName.trim());
      toast('success', `Project "${created.name}" created.`);
      showNew = false;
      newName = '';
      projects = await api.projects.list();
    } catch (err) {
      newError = err instanceof ApiError ? err.message : 'Project creation failed.';
    } finally {
      creating = false;
    }
  }
</script>

<header class="page-head">
  <div>
    <h1>Projects</h1>
    <p class="subtitle">Group services by product. Deploy a new service from a project.</p>
  </div>
  <button class="btn primary" type="button" onclick={() => (showNew = true)}>
    <Icon name="plus" size={16} /> New project
  </button>
</header>

{#if loading}
  <p class="subtitle">Loading projects…</p>
{:else if error}
  <div class="callout" role="alert">
    <strong class="strong">Projects unavailable</strong>
    <p>{error}</p>
  </div>
{:else if projects.length === 0}
  <div class="card empty-state">
    <span class="icon-box"><Icon name="projects" size={22} /></span>
    <h3>No projects yet</h3>
    <p class="subtitle">Projects will appear here once you create one.</p>
    <button class="btn primary" type="button" onclick={() => (showNew = true)}>
      Create project
    </button>
  </div>
{:else}
  <div class="tiles">
    {#each projects as project (project.id)}
      <a class="project-tile tile14" href={`/projects/${project.id}`}>
        <span class="project-tile-icon mark14"><Icon name="projects" /></span>
        <span class="tile14-text">
          <strong class="project-tile-name">{project.name}</strong>
          <small class="project-tile-address">
            {project.serviceCount ?? 0} service{(project.serviceCount ?? 0) === 1 ? '' : 's'}
          </small>
        </span>
        <Icon name="arrow" size={16} />
      </a>
    {/each}
  </div>
{/if}

<Dialog title="New project" bind:open={showNew} onclose={() => (newError = null)}>
  <form onsubmit={createProject} novalidate>
    <label class="field">
      Project name
      <input bind:value={newName} required placeholder="Main website" />
      <small>Use a name your team will recognize.</small>
    </label>
    {#if newError}<p class="error" role="alert">{newError}</p>{/if}
    <button class="btn primary" type="submit" disabled={creating || !newName.trim()}>
      {creating ? 'Creating…' : 'Create project'}
    </button>
  </form>
</Dialog>

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
</style>
