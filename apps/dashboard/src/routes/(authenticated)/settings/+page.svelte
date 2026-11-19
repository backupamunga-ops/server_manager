<script lang="ts">
  import { api, ApiError, type ServerInfo, type SessionRow } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import { PALETTES, palette, dark } from '$stores/prefs';
  import { toast } from '$stores/toast';
  import { goto } from '$app/navigation';

  /** Settings — appearance (palette/dark), server facts, active sessions. */
  let server = $state<ServerInfo | null>(null);
  let sessions = $state<SessionRow[]>([]);
  let error = $state<string | null>(null);

  $effect(() => {
    (async () => {
      try {
        server = await api.overview.serverInfo();
        sessions = await api.auth.sessions();
      } catch (err) {
        error = err instanceof ApiError ? err.message : 'Failed to load settings.';
      }
    })();
  });

  async function revoke(sessionId: string) {
    try {
      await api.auth.revokeSession(sessionId);
      sessions = await api.auth.sessions();
      toast('info', 'Session revoked.');
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not revoke the session.');
    }
  }

  function fmtUptime(s: number): string {
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    return d > 0 ? `${d}d ${h}h` : `${h}h ${Math.floor((s % 3600) / 60)}m`;
  }

  async function signOut() {
    try {
      await api.auth.logout();
    } finally {
      await goto('/login', { replaceState: true });
    }
  }
</script>

<header class="page-head">
  <div>
    <h1>Settings</h1>
    <p class="subtitle">Appearance, server facts and active sessions.</p>
  </div>
  <button class="btn secondary" type="button" onclick={signOut}>
    <Icon name="back" size={14} /> Sign out
  </button>
</header>

{#if error}
  <div class="callout" role="alert">
    <strong class="strong">Settings unavailable</strong>
    <p>{error}</p>
  </div>
{:else}
  <h2>Appearance</h2>
  <div class="card appearance">
    <label class="field">
      Color palette
      <select
        value={$palette}
        onchange={(e) => palette.set((e.currentTarget as HTMLSelectElement).value as never)}
      >
        {#each PALETTES as p (p.id)}
          <option value={p.id}>{p.label}</option>
        {/each}
      </select>
      <small>Five palette families, each with light and dark variants.</small>
    </label>
    <label class="check">
      <input type="checkbox" checked={$dark} onchange={(e) => dark.set((e.currentTarget as HTMLInputElement).checked)} />
      Dark mode
    </label>
  </div>

  <h2>Server</h2>
  {#if server}
    <div class="facts-grid">
      <div class="card fact">
        <span class="eyebrow">Version</span>
        <strong class="mono">{server.version}</strong>
      </div>
      <div class="card fact">
        <span class="eyebrow">Hostname</span>
        <strong class="mono">{server.hostname}</strong>
      </div>
      <div class="card fact">
        <span class="eyebrow">Platform</span>
        <strong>{server.platform}</strong>
      </div>
      <div class="card fact">
        <span class="eyebrow">Uptime</span>
        <strong class="tabular">{fmtUptime(server.uptimeSeconds)}</strong>
      </div>
      <div class="card fact">
        <span class="eyebrow">Memory</span>
        <strong class="tabular">
          {Math.round((server.memoryTotalMiB - server.memoryFreeMiB) / 1024 * 10) / 10} /
          {Math.round(server.memoryTotalMiB / 1024)} GB used
        </strong>
      </div>
      <div class="card fact">
        <span class="eyebrow">Node</span>
        <strong class="mono">{server.nodeVersion}</strong>
      </div>
    </div>
    <p class="subtitle quiet">
      SSH access to this host follows the guidance in Settings → Server of the installer output;
      the dashboard never exposes in-browser host shells.
    </p>
  {:else}
    <p class="subtitle">Loading server facts…</p>
  {/if}

  <h2>Active sessions</h2>
  {#if sessions.length === 0}
    <div class="card empty-state">
      <span class="icon-box"><Icon name="security" size={22} /></span>
      <h3>No other sessions</h3>
      <p class="subtitle">Sign-ins from other devices will be listed here.</p>
    </div>
  {:else}
    <div class="card table-card">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Device</th>
              <th scope="col">IP</th>
              <th scope="col">Last seen</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each sessions as s (s.sessionId)}
              <tr>
                <td>
                  <strong class="strong">{s.userAgent.slice(0, 60) || 'Unknown device'}</strong>
                  {#if s.current}<small>this session</small>{/if}
                </td>
                <td class="mono">{s.ip}</td>
                <td>{s.lastSeenAt ? new Date(s.lastSeenAt).toLocaleString() : '—'}</td>
                <td>
                  {#if !s.current}
                    <button class="btn danger small" type="button" onclick={() => revoke(s.sessionId)}>
                      Revoke
                    </button>
                  {:else}
                    <small class="quiet">—</small>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </div>
  {/if}
{/if}

<style>
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
  h2 {
    margin: 28px 0 12px;
  }
  .appearance {
    display: grid;
    gap: 16px;
    max-width: 420px;
  }
  .facts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 14px;
  }
  .fact {
    display: grid;
    gap: 6px;
    align-content: start;
    padding: 16px 18px;
  }
  .table-card {
    padding: 0;
  }
  td small {
    display: block;
    color: var(--muted);
  }
</style>
