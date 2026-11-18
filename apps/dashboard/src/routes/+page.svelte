<script lang="ts">
  import { onMount } from 'svelte';
  import { api } from '$lib/api/client';
  import { session } from '$lib/stores/session';
  import type { ProjectSummary } from '@cloudlane/contracts';

  let projects: ProjectSummary[] = [];
  let loading = true;
  let error: string | null = null;
  let showCreate = false;
  let newName = '';

  onMount(async () => {
    await loadProjects();
  });

  async function loadProjects() {
    loading = true;
    try {
      const result = await api.projects.list();
      projects = result.items;
    } catch (e) {
      error = (e as { error?: { message?: string } }).error?.message ?? 'Failed to load projects';
    } finally {
      loading = false;
    }
  }

  async function createProject() {
    if (!newName) return;
    try {
      await api.projects.create(newName);
      newName = '';
      showCreate = false;
      await loadProjects();
    } catch (e) {
      error = (e as { error?: { message?: string } }).error?.message ?? 'Failed to create project';
    }
  }

  async function logout() {
    await api.auth.logout();
    session.set(null);
    window.location.href = '/login';
  }

  $: user = $session;
</script>

<div class="dashboard">
  <header class="topbar">
    <div class="brand">cloudlane<span class="dot">.</span></div>
    <div class="spacer"></div>
    <span class="user">{user?.email}</span>
    <button class="logout" on:click={logout}>Sign out</button>
  </header>

  <div class="content">
    <div class="heading">
      <p class="eyebrow">YOUR INFRASTRUCTURE</p>
      <h1>Overview</h1>
      <p class="subtitle">Everything you need to deploy, run and manage your services.</p>
    </div>

    <div class="stats">
      <div class="stat"><div class="stat-label">Projects</div><div class="stat-number">{projects.length}</div></div>
      <div class="stat"><div class="stat-label">Live apps</div><div class="stat-number">0</div></div>
      <div class="stat"><div class="stat-label">Databases</div><div class="stat-number">0</div></div>
      <div class="stat"><div class="stat-label">Cron jobs</div><div class="stat-number">0</div></div>
    </div>

    <div class="section-head">
      <h2>Your projects</h2>
      <button on:click={() => (showCreate = !showCreate)}>New project</button>
    </div>

    {#if showCreate}
      <div class="create-form">
        <input bind:value={newName} placeholder="Project name" />
        <button on:click={createProject} disabled={!newName}>Create</button>
      </div>
    {/if}

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if error}
      <div class="error">{error}</div>
    {:else if projects.length === 0}
      <div class="empty"><h3>No projects yet</h3><p>Create your first project to get started.</p></div>
    {:else}
      <div class="project-grid">
        {#each projects as p}
          <div class="project-card">
            <h3>{p.name}</h3>
            <div class="muted">{p.serviceCount} service{p.serviceCount === 1 ? '' : 's'}</div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .dashboard { min-height: 100vh; background: var(--bg); color: var(--text); }
  .topbar {
    height: 64px; display: flex; align-items: center; padding: 0 32px;
    border-bottom: 1px solid var(--border); background: var(--raised);
  }
  .brand { font-size: 19px; font-weight: 700; letter-spacing: -0.04em; }
  .dot { color: var(--primary); }
  .spacer { flex: 1; }
  .user { color: var(--muted); font-size: 12px; margin-right: 12px; }
  .logout {
    background: transparent; border: 1px solid var(--border-default); color: var(--text);
    padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 12px;
  }
  .content { max-width: 1400px; margin: 0 auto; padding: 28px 32px 72px; }
  .heading { margin-bottom: 24px; }
  .eyebrow { font-size: 11px; letter-spacing: 0.08em; color: var(--primary); font-weight: 600; margin: 0 0 8px; }
  h1 { font-size: 32px; margin: 0 0 6px; font-weight: 700; letter-spacing: -0.04em; }
  .subtitle { color: var(--muted); font-size: 14px; margin: 0; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
  .stat { background: var(--raised); border: 1px solid var(--border); border-radius: 8px; padding: 20px; }
  .stat-label { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .stat-number { font-size: 30px; font-weight: 700; }
  .section-head { display: flex; justify-content: space-between; align-items: center; margin: 28px 0 16px; }
  h2 { font-size: 20px; margin: 0; }
  .section-head button {
    background: var(--primary); color: var(--palette-button-text, #fff); border: none;
    padding: 8px 16px; border-radius: 6px; cursor: pointer; font-weight: 600;
  }
  .create-form { display: flex; gap: 12px; margin-bottom: 16px; }
  .create-form input {
    flex: 1; padding: 10px 12px; background: var(--overlay); border: 1px solid var(--border-default);
    border-radius: 6px; color: var(--text);
  }
  .create-form button {
    background: var(--primary); color: var(--palette-button-text, #fff); border: none;
    padding: 10px 16px; border-radius: 6px; cursor: pointer;
  }
  .project-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }
  .project-card {
    background: var(--raised); border: 1px solid var(--border); border-radius: 8px;
    padding: 20px; cursor: pointer;
  }
  .project-card:hover { border-color: var(--primary); }
  .project-card h3 { margin: 0 0 6px; font-size: 16px; }
  .muted { color: var(--muted); font-size: 13px; }
  .empty {
    background: var(--raised); border: 1px solid var(--border); border-radius: 8px;
    padding: 40px; text-align: center;
  }
  .empty h3 { margin: 0 0 8px; }
  .empty p { color: var(--muted); font-size: 13px; margin: 0; }
  .error {
    background: var(--danger-bg); color: var(--danger); padding: 10px 12px;
    border-radius: 6px; font-size: 13px;
  }
  @media (max-width: 950px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .project-grid { grid-template-columns: 1fr; }
  }
</style>
