<script lang="ts">
  import { api } from '$lib/api/client';
  import { installationStatus } from '$lib/stores/session';
  import { onMount } from 'svelte';

  let claimCode = '';
  let email = '';
  let password = '';
  let workspaceName = '';
  let mfaSecret = '';
  let mfaCode = '';
  let otpauthUrl = '';
  let claimToken = '';
  let factorId = '';
  let recoveryCodes: string[] = [];
  let step: 'claim' | 'owner' | 'mfa' | 'done' = 'claim';
  let error: string | null = null;
  let loading = false;

  onMount(async () => {
    const status = await api.installation.status();
    installationStatus.set(status.status);
    if (status.status !== 'unclaimed') {
      window.location.href = '/login';
    }
  });

  async function submitClaim() {
    loading = true; error = null;
    try {
      const result = await api.bootstrap.claim(claimCode);
      claimToken = result.token;
      step = 'owner';
    } catch (e) {
      error = (e as { error?: { message?: string } }).error?.message ?? 'Claim failed';
    } finally { loading = false; }
  }

  async function submitOwner() {
    loading = true; error = null;
    try {
      const result = await api.bootstrap.createOwner(
        { email, password, workspaceName, mfaType: 'totp' },
        claimToken,
      );
      mfaSecret = result.mfaEnrollment.secret;
      otpauthUrl = result.mfaEnrollment.otpauthUrl;
      factorId = result.mfaEnrollment.factorId;
      recoveryCodes = result.recoveryCodes;
      step = 'mfa';
    } catch (e) {
      error = (e as { error?: { message?: string } }).error?.message ?? 'Owner creation failed';
    } finally { loading = false; }
  }

  async function submitMfa() {
    loading = true; error = null;
    try {
      await api.bootstrap.verifyMfa(factorId, mfaCode);
      step = 'done';
      setTimeout(() => { window.location.href = '/'; }, 2000);
    } catch (e) {
      error = (e as { error?: { message?: string } }).error?.message ?? 'MFA verification failed';
    } finally { loading = false; }
  }
</script>

<div class="setup-container">
  <div class="setup-card">
    <h1>Claim your Cloudlane instance</h1>
    {#if error}<div class="error">{error}</div>{/if}

    {#if step === 'claim'}
      <p>Enter the claim code printed by the installer in your terminal.</p>
      <input bind:value={claimCode} placeholder="Claim code" autocomplete="off" />
      <button on:click={submitClaim} disabled={loading || !claimCode}>{loading ? 'Verifying…' : 'Verify claim'}</button>
    {:else if step === 'owner'}
      <h2>Create owner account</h2>
      <input bind:value={email} type="email" placeholder="Email" autocomplete="email" />
      <input bind:value={password} type="password" placeholder="Password (min 12 chars)" autocomplete="new-password" />
      <input bind:value={workspaceName} placeholder="Workspace name" />
      <button on:click={submitOwner} disabled={loading || !email || !password || !workspaceName}>{loading ? 'Creating…' : 'Create owner'}</button>
    {:else if step === 'mfa'}
      <h2>Set up MFA</h2>
      <p>Scan this OTP auth URL with your authenticator app:</p>
      <code class="secret">{otpauthUrl}</code>
      <p>Or enter this secret manually:</p>
      <code class="secret">{mfaSecret}</code>
      <h3>Save your recovery codes</h3>
      <ul class="recovery-codes">
        {#each recoveryCodes as code}<li><code>{code}</code></li>{/each}
      </ul>
      <p>Enter the 6-digit code from your authenticator:</p>
      <input bind:value={mfaCode} placeholder="123456" maxlength="6" />
      <button on:click={submitMfa} disabled={loading || mfaCode.length !== 6}>{loading ? 'Verifying…' : 'Verify MFA'}</button>
    {:else if step === 'done'}
      <h2>Setup complete</h2>
      <p>Redirecting to your dashboard…</p>
    {/if}
  </div>
</div>

<style>
  .setup-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); padding: 20px; }
  .setup-card { background: var(--raised); border: 1px solid var(--border); border-radius: 10px; padding: 32px; max-width: 480px; width: 100%; color: var(--text); }
  h1 { font-size: 24px; margin-bottom: 16px; color: var(--primary); }
  h2 { font-size: 18px; margin: 20px 0 12px; }
  h3 { font-size: 14px; margin: 16px 0 8px; }
  input { width: 100%; padding: 10px 12px; background: var(--overlay); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text); margin-bottom: 12px; }
  button { width: 100%; padding: 10px 16px; background: var(--primary); color: var(--palette-button-text, #fff); border: none; border-radius: 6px; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .error { background: var(--danger-bg); color: var(--danger); padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
  .secret { display: block; background: var(--sunken); padding: 8px 10px; border-radius: 4px; font-family: monospace; font-size: 12px; word-break: break-all; margin-bottom: 12px; }
  .recovery-codes { list-style: none; padding: 0; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; }
  .recovery-codes li { font-family: monospace; font-size: 11px; padding: 4px; background: var(--sunken); border-radius: 3px; }
</style>
