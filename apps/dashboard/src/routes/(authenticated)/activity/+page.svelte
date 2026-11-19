<script lang="ts">
  import { api, ApiError, type AuditEventInfo } from '$api/client';
  import Icon from '$design/Icon.svelte';

  /** Activity & Logs — audit events with keyset pagination (build plan §4.6). */
  let items = $state<AuditEventInfo[]>([]);
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let resourceFilter = $state('');

  async function load(reset = true) {
    loading = true;
    error = null;
    try {
      const res = await api.audit.list({
        cursor: reset ? undefined : nextCursor ?? undefined,
        limit: 50,
        resourceType: resourceFilter || undefined,
      });
      items = reset ? res.items : [...items, ...res.items];
      nextCursor = res.nextCursor;
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Failed to load activity.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    load(true);
  });

  function timeAgo(iso: string): string {
    const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString();
  }
</script>

<header class="page-head">
  <div>
    <h1>Activity & Logs</h1>
    <p class="subtitle">Every state-changing action writes an audit event — allowed and denied.</p>
  </div>
  <label class="field filter">
    <select bind:value={resourceFilter} onchange={() => load(true)}>
      <option value="">All resources</option>
      <option value="deployment">Deployments</option>
      <option value="service">Services</option>
      <option value="domain">Domains</option>
      <option value="project">Projects</option>
      <option value="user">Authentication</option>
    </select>
  </label>
</header>

{#if loading && items.length === 0}
  <p class="subtitle">Loading activity…</p>
{:else if error}
  <div class="callout" role="alert">
    <strong class="strong">Activity unavailable</strong>
    <p>{error}</p>
  </div>
{:else if items.length === 0}
  <div class="card empty-state">
    <span class="icon-box"><Icon name="activity" size={22} /></span>
    <h3>No recorded activity</h3>
    <p class="subtitle">Audit events will appear here as you use the platform.</p>
  </div>
{:else}
  <div class="card table-card">
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th scope="col">Action</th>
            <th scope="col">Result</th>
            <th scope="col">Resource</th>
            <th scope="col">When</th>
          </tr>
        </thead>
        <tbody>
          {#each items as ev (ev.id)}
            <tr>
              <td><strong class="strong">{ev.action.replaceAll('_', ' ').toLowerCase()}</strong></td>
              <td>
                <span class="pill {ev.status === 'success' ? 'success' : ev.status === 'error' ? 'warning' : ''}">
                  <span class="dot" aria-hidden="true"></span>
                  {ev.status}
                </span>
              </td>
              <td>
                {ev.resourceType ?? '—'}
                {#if ev.resourceId}<small class="mono">{ev.resourceId.slice(0, 8)}</small>{/if}
              </td>
              <td>{timeAgo(ev.createdAt)}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </div>
  {#if nextCursor}
    <div class="row" style="justify-content: center; margin-top: 14px;">
      <button class="btn secondary" type="button" disabled={loading} onclick={() => load(false)}>
        {loading ? 'Loading…' : 'Load more'}
      </button>
    </div>
  {/if}
{/if}

<style>
  .page-head {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 24px;
  }
  h1 {
    margin: 0 0 4px;
  }
  .filter {
    min-width: 180px;
  }
  .table-card {
    padding: 0;
  }
  td small {
    display: block;
    color: var(--muted);
  }
</style>
