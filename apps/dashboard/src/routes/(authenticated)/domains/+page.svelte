<script lang="ts">
  import { api, ApiError, type DomainInfo } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import Dialog from '$design/Dialog.svelte';
  import { toast } from '$stores/toast';

  /** Domains (master guide §06): one-field Add Domain; the rest lives in
   *  per-domain tabs; DNS mode changes only under Settings. */
  let domains = $state<DomainInfo[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  let newHost = $state('');
  let adding = $state(false);
  let addError = $state<string | null>(null);

  let selectedId = $state('');
  const selected = $derived(domains.find((d) => d.id === selectedId) ?? null);
  let detail = $state<DomainInfo | null>(null);
  let tab = $state<'Overview' | 'DNS Records' | 'SSL' | 'Settings'>('Overview');

  let removeOpen = $state(false);
  let verifying = $state(false);

  async function refresh(keepSelection = true) {
    try {
      domains = (await api.domains.list()).items;
      if (keepSelection && selectedId && domains.some((d) => d.id === selectedId)) {
        await select(selectedId);
      } else if (domains.length > 0) {
        await select(domains[0].id);
      } else {
        selectedId = '';
        detail = null;
      }
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Failed to load domains.';
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    refresh(false);
  });

  async function select(id: string) {
    selectedId = id;
    tab = 'Overview';
    try {
      detail = await api.domains.get(id);
    } catch {
      detail = null;
    }
  }

  async function addDomain(e: SubmitEvent) {
    e.preventDefault();
    addError = null;
    adding = true;
    try {
      const created = await api.domains.add(newHost.trim().toLowerCase());
      toast('success', `${created.host} added — publish the challenge record to verify.`);
      newHost = '';
      await refresh();
      await select(created.id);
      tab = 'DNS Records';
    } catch (err) {
      addError = err instanceof ApiError ? err.message : 'Could not add the domain.';
    } finally {
      adding = false;
    }
  }

  async function verify() {
    if (!selectedId) return;
    verifying = true;
    try {
      const res = await api.domains.verify(selectedId);
      if (res.status === 'VERIFIED') {
        toast('success', `${res.host} verified.`);
      } else {
        toast('error', res.lastError || 'Verification failed — publish the TXT record first.');
      }
      await refresh();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Verification failed.');
    } finally {
      verifying = false;
    }
  }

  async function setMode(mode: 'MANUAL' | 'MANAGED') {
    if (!selectedId) return;
    try {
      await api.domains.setDnsMode(selectedId, mode);
      toast('success', `DNS mode set to ${mode.toLowerCase()}.`);
      await refresh();
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not set DNS mode.');
    }
  }

  async function removeDomain() {
    if (!selectedId) return;
    try {
      await api.domains.remove(selectedId);
      toast('info', 'Domain removed.');
      removeOpen = false;
      selectedId = '';
      await refresh(false);
    } catch (err) {
      toast('error', err instanceof ApiError ? err.message : 'Could not remove the domain.');
    }
  }

  function copy(value: string, what: string) {
    navigator.clipboard.writeText(value).then(
      () => toast('info', `${what} copied.`),
      () => toast('error', 'Copy failed.'),
    );
  }

  function pill(d: DomainInfo): { cls: string; label: string } {
    if (d.status === 'VERIFIED') return { cls: 'success', label: 'Verified' };
    if (d.status === 'FAILED') return { cls: 'warning', label: 'Failed' };
    return { cls: '', label: 'Pending' };
  }
</script>

<header class="page-head">
  <div>
    <h1>Domains</h1>
    <p class="subtitle">One name field is all it takes — verification is a separate step.</p>
  </div>
</header>

<form class="add-domain" onsubmit={addDomain} novalidate>
  <input
    type="text"
    bind:value={newHost}
    placeholder="example.com"
    aria-label="Domain name"
    spellcheck="false"
    autocapitalize="off"
  />
  <button class="btn primary" type="submit" disabled={adding || !newHost.trim()}>
    <Icon name="plus" size={16} /> {adding ? 'Adding…' : 'Add domain'}
  </button>
</form>
{#if addError}<p class="error" role="alert">{addError}</p>{/if}

{#if loading}
  <p class="subtitle">Loading domains…</p>
{:else if error}
  <div class="callout" role="alert">
    <strong class="strong">Domains unavailable</strong>
    <p>{error}</p>
  </div>
{:else if domains.length === 0}
  <div class="card empty-state">
    <span class="icon-box"><Icon name="domains" size={22} /></span>
    <h3>No domains attached</h3>
    <p class="subtitle">Add a domain above; default app URLs keep working without one.</p>
  </div>
{:else}
  <div class="domain-layout">
    <aside class="domain-list card" aria-label="Attached domains">
      {#each domains as d (d.id)}
        <button
          class="domain-item"
          class:active={d.id === selectedId}
          type="button"
          aria-pressed={d.id === selectedId}
          onclick={() => select(d.id)}
        >
          <span class="host mono">{d.host}</span>
          <span class="pill {pill(d).cls}"><span class="dot" aria-hidden="true"></span>{pill(d).label}</span>
        </button>
      {/each}
    </aside>

    {#if detail}
      <section class="domain-detail">
        <div class="tabs" role="tablist" aria-label="Domain sections">
          {#each ['Overview', 'DNS Records', 'SSL', 'Settings'] as t, i (t)}
            <button
              class="tab"
              class:active={tab === t}
              role="tab"
              aria-selected={tab === t}
              type="button"
              onclick={() => (tab = t as typeof tab)}
            >
              {t}
            </button>
          {/each}
        </div>

        {#if tab === 'Overview'}
          <div class="facts-grid">
            <div class="card fact">
              <span class="eyebrow">Status</span>
              <span class="pill {pill(detail).cls}"><span class="dot" aria-hidden="true"></span>{pill(detail).label}</span>
            </div>
            <div class="card fact">
              <span class="eyebrow">DNS mode</span>
              <strong>{detail.dnsMode}</strong>
            </div>
            <div class="card fact">
              <span class="eyebrow">Last check</span>
              <strong>{detail.lastCheckedAt ? new Date(detail.lastCheckedAt).toLocaleString() : '—'}</strong>
            </div>
          </div>
          {#if detail.status === 'FAILED' && detail.lastError}
            <div class="callout" style="border-color: var(--danger);" role="alert">
              <strong class="strong">Last verification failed</strong>
              <p>{detail.lastError}</p>
            </div>
          {/if}
          <div class="row wrap">
            <button class="btn primary" type="button" disabled={verifying} onclick={verify}>
              {verifying ? 'Checking DNS…' : 'Verify now'}
            </button>
            <button class="btn danger" type="button" onclick={() => (removeOpen = true)}>
              Remove domain
            </button>
          </div>
        {:else if tab === 'DNS Records'}
          <p class="subtitle">
            Publish these records at your DNS provider, then run Verify. The TXT challenge proves
            control of the domain.
          </p>
          {#if detail.dnsInstructions}
            <div class="card record">
              <div class="record-head">
                <span class="pill"><span class="dot" aria-hidden="true"></span>{detail.dnsInstructions.challenge.type}</span>
                <code class="mono name">{detail.dnsInstructions.challenge.name}</code>
                <button class="icon-btn" type="button" aria-label="Copy challenge record name" onclick={() => copy(detail.dnsInstructions!.challenge.name, 'Record name')}>
                  <Icon name="copy" size={16} />
                </button>
              </div>
              <div class="record-value mono">{detail.dnsInstructions.challenge.value}</div>
              <button class="link-btn" type="button" onclick={() => copy(detail!.dnsInstructions!.challenge.value, 'Challenge value')}>
                Copy value
              </button>
              <small class="quiet">{detail.dnsInstructions.challenge.purpose}</small>
            </div>
            <div class="card record">
              <div class="record-head">
                <span class="pill"><span class="dot" aria-hidden="true"></span>{detail.dnsInstructions.apex.type}</span>
                <code class="mono name">@ (root)</code>
              </div>
              <p class="subtitle" style="margin: 6px 0 0;">
                Point the hostname at this installation's IPv4 address once routing for custom
                hostnames ships (Phase 4). Value placeholder:
                <code class="mono">{detail.dnsInstructions.apex.value}</code>
              </p>
            </div>
          {/if}
        {:else if tab === 'SSL'}
          <div class="callout">
            <strong class="strong">Certificate status</strong>
            <p>
              {#if detail.status === 'VERIFIED'}
                Ownership verified. TLS for custom hostnames is issued when hostname routing
                ships in Phase 4 — the panel itself is already served over HTTPS.
              {:else}
                Certificate issuance starts after domain verification.
              {/if}
            </p>
          </div>
        {:else}
          <label class="field">
            DNS mode
            <select
              value={detail.dnsMode}
              onchange={(e) => setMode((e.currentTarget as HTMLSelectElement).value as 'MANUAL' | 'MANAGED')}
            >
              <option value="MANUAL">Manual DNS (default — you manage records)</option>
              <option value="MANAGED">Cloudlane Managed DNS (staged migration)</option>
            </select>
            <small>
              Mode changes are staged and verified — they never take effect immediately.
              Managed DNS is optional infrastructure coming with Phase 4.
            </small>
          </label>
        {/if}
      </section>
    {/if}
  </div>
{/if}

<Dialog title="Remove domain" bind:open={removeOpen}>
  <p>
    Remove <strong class="mono">{detail?.host}</strong> from this installation? The hostname
    stays at your DNS provider; only the Cloudlane record is deleted.
  </p>
  {#snippet footer()}
    <button class="btn" type="button" onclick={() => (removeOpen = false)}>Cancel</button>
    <button class="btn danger" type="button" onclick={removeDomain}>Remove</button>
  {/snippet}
</Dialog>

<style>
  .page-head {
    margin-bottom: 20px;
  }
  h1 {
    margin: 0 0 4px;
  }
  .add-domain {
    display: flex;
    gap: 8px;
    max-width: 480px;
    margin-bottom: 8px;
  }
  .add-domain input {
    flex: 1;
    min-height: 40px;
    padding: 10px 12px;
    background: var(--overlay);
    color: var(--text);
    border: 1px solid var(--border-default);
    border-radius: 6px;
    font: inherit;
  }
  .domain-layout {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 16px;
    margin-top: 16px;
  }
  @media (max-width: 900px) {
    .domain-layout {
      grid-template-columns: 1fr;
    }
  }
  .domain-list {
    padding: 8px;
    display: grid;
    gap: 4px;
    align-content: start;
  }
  .domain-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    width: 100%;
    border: 0;
    background: transparent;
    color: var(--secondary);
    font: inherit;
    padding: 10px;
    border-radius: 6px;
    cursor: pointer;
    text-align: left;
  }
  .domain-item:hover {
    background: var(--sunken);
  }
  .domain-item.active {
    background: var(--primary-tint);
    color: var(--palette-on-tint, var(--primary));
  }
  .domain-item .host {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
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
  .record {
    display: grid;
    gap: 8px;
    margin-bottom: 12px;
  }
  .record-head {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .record-head .name {
    flex: 1;
    word-break: break-all;
  }
  .record-value {
    background: var(--sunken);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 10px;
    word-break: break-all;
    font-size: 13px;
  }
</style>
