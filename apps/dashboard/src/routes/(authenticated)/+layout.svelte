<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import Icon from '$design/Icon.svelte';
  import { api, type SessionInfo } from '$api/client';
  import { PALETTES, palette, dark } from '$stores/prefs';

  /** AppShell — fixed 256px sidebar, 64px sticky topbar (design-system §Layout).
   *  ≤950px: sidebar becomes a drawer with backdrop; ≤600px topbar wraps. */
  let { data, children } = $props();
  const session = data.session as SessionInfo;

  let drawerOpen = $state(false);

  interface NavItem {
    href: string;
    icon: string;
    label: string;
  }
  interface NavGroup {
    label: string;
    items: NavItem[];
  }

  const groups: NavGroup[] = [
    {
      label: 'Workspace',
      items: [
        { href: '/overview', icon: 'overview', label: 'Overview' },
        { href: '/projects', icon: 'projects', label: 'Projects' },
        { href: '/domains', icon: 'domains', label: 'Domains' },
      ],
    },
    {
      label: 'Infrastructure',
      items: [{ href: '/activity', icon: 'activity', label: 'Activity & Logs' }],
    },
    {
      label: 'Preferences',
      items: [{ href: '/settings', icon: 'settings', label: 'Settings' }],
    },
  ];

  const isActive = (href: string) => page.url.pathname.startsWith(href);

  async function signOut() {
    try {
      await api.auth.logout();
    } finally {
      await goto('/login', { replaceState: true });
    }
  }

  function navigate(href: string) {
    drawerOpen = false;
    goto(href);
  }
</script>

<div class="shell">
  <aside class="sidebar" class:open={drawerOpen} aria-label="Workspace navigation">
    <div class="brand-row">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h7l2 2h9v12H3z"/></svg>
      </span>
      <span class="brand">cloudlane.</span>
    </div>
    <nav>
      {#each groups as group (group.label)}
        <span class="nav-section">{group.label}</span>
        {#each group.items as item (item.href)}
          <button
            class={isActive(item.href) ? 'active' : ''}
            aria-pressed={isActive(item.href)}
            onclick={() => navigate(item.href)}
          >
            <Icon name={item.icon} />
            {item.label}
          </button>
        {/each}
      {/each}
    </nav>
    <div class="side-foot">
      <small class="quiet">{session.email}</small>
      <button class="btn secondary small" type="button" onclick={signOut}>
        <Icon name="back" size={14} /> Sign out
      </button>
    </div>
  </aside>

  {#if drawerOpen}
    <button class="backdrop" type="button" aria-label="Close navigation" onclick={() => (drawerOpen = false)}></button>
  {/if}

  <div class="main-col">
    <header class="topbar">
      <button class="icon-btn menu-btn" type="button" aria-label="Open navigation" onclick={() => (drawerOpen = true)}>
        <Icon name="menu" />
      </button>
      <div class="topbar-title">
        <strong>{groups.flatMap((g) => g.items).find((i) => isActive(i.href))?.label ?? 'Cloudlane'}</strong>
      </div>
      <div class="topbar-actions">
        <label class="palette-select">
          <select
            value={$palette}
            aria-label="Color palette"
            onchange={(e) => palette.set((e.currentTarget as HTMLSelectElement).value as never)}
          >
            {#each PALETTES as p (p.id)}
              <option value={p.id}>{p.label}</option>
            {/each}
          </select>
        </label>
        <button
          class="icon-btn"
          type="button"
          aria-label={$dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onclick={() => dark.update((v) => !v)}
        >
          <Icon name={$dark ? 'sun' : 'moon'} />
        </button>
      </div>
    </header>
    <main class="main">
      {@render children()}
    </main>
  </div>
</div>

<style>
  .shell {
    display: flex;
    min-height: 100dvh;
  }
  .sidebar {
    width: 256px;
    flex-shrink: 0;
    background: var(--raised);
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    position: sticky;
    top: 0;
    height: 100dvh;
    overflow-y: auto;
  }
  .brand-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px 16px;
  }
  .brand-mark {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    background: var(--palette-button, var(--primary));
    color: var(--palette-button-text, #fff);
    display: inline-flex;
    align-items: center;
    justify-content: center;
  }
  .brand {
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.04em;
    color: var(--text);
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
  }
  nav button {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--secondary);
    font: inherit;
    font-weight: 500;
    padding: 9px 10px;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  nav button:hover {
    background: var(--sunken);
    color: var(--text);
  }
  nav button.active {
    background: var(--primary-tint);
    color: var(--palette-on-tint, var(--primary));
    font-weight: 600;
  }
  .side-foot {
    display: grid;
    gap: 8px;
    padding: 12px 8px 4px;
    border-top: 1px solid var(--border);
    margin-top: 12px;
  }
  .backdrop {
    position: fixed;
    inset: 0;
    background: rgb(2 6 23 / 0.55);
    border: 0;
    z-index: 40;
    cursor: pointer;
  }
  .main-col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .topbar {
    height: 64px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 24px;
    background: var(--bg);
    border-bottom: 1px solid var(--border);
    position: sticky;
    top: 0;
    z-index: 30;
  }
  .topbar-title strong {
    font-size: 15px;
    color: var(--text);
  }
  .topbar-actions {
    margin-left: auto;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .palette-select select {
    min-height: 36px;
    background: var(--overlay);
    color: var(--text);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    padding: 0 10px;
    font: inherit;
    font-size: 13px;
  }
  .menu-btn {
    display: none;
  }
  .main {
    flex: 1;
    padding: 32px 40px 72px;
    max-width: 1600px;
    width: 100%;
    margin: 0 auto;
  }

  @media (max-width: 1200px) {
    .main {
      padding: 28px 24px 64px;
    }
  }
  @media (max-width: 950px) {
    .sidebar {
      position: fixed;
      left: 0;
      top: 0;
      z-index: 50;
      transform: translateX(-100%);
      transition: transform 0.2s ease;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    .menu-btn {
      display: inline-flex;
    }
    .topbar {
      padding: 0 16px;
    }
    .main {
      padding: 24px 16px 56px;
    }
  }
  @media (max-width: 600px) {
    .palette-select select {
      max-width: 120px;
    }
    .main {
      padding: 24px 16px 56px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sidebar {
      transition: none;
    }
  }
</style>
