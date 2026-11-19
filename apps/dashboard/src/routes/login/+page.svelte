<script lang="ts">
import { api } from '$lib/api/client';
import { onMount } from 'svelte';

let email = '';
let password = '';
let mfaCode = '';
let mfaChallengeId = '';
let step: 'credentials' | 'mfa' = 'credentials';
let error: string | null = null;
let loading = false;

onMount(async () => {
  try {
    const sess = await api.auth.session();
    if (sess) window.location.href = '/';
  } catch {
    /* not logged in */
  }
});

async function submitLogin() {
  loading = true;
  error = null;
  try {
    const result = await api.auth.login(email, password);
    mfaChallengeId = result.mfaChallengeId;
    step = 'mfa';
  } catch (e) {
    error = (e as { error?: { message?: string } }).error?.message ?? 'Login failed';
  } finally {
    loading = false;
  }
}

async function submitMfa() {
  loading = true;
  error = null;
  try {
    await api.auth.verifyMfa(mfaChallengeId, mfaCode);
    window.location.href = '/';
  } catch (e) {
    error = (e as { error?: { message?: string } }).error?.message ?? 'MFA verification failed';
  } finally {
    loading = false;
  }
}
</script>

<div class="login-container">
  <div class="login-card">
    <h1>Cloudlane</h1>
    <p class="subtitle">Sign in to your workspace</p>
    {#if error}<div class="error">{error}</div>{/if}

    {#if step === 'credentials'}
      <input bind:value={email} type="email" placeholder="Email" autocomplete="email" />
      <input bind:value={password} type="password" placeholder="Password" autocomplete="current-password" />
      <button on:click={submitLogin} disabled={loading || !email || !password}>{loading ? 'Signing in…' : 'Continue'}</button>
    {:else if step === 'mfa'}
      <p>Enter the 6-digit code from your authenticator.</p>
      <input bind:value={mfaCode} placeholder="123456" maxlength="6" autocomplete="one-time-code" />
      <button on:click={submitMfa} disabled={loading || mfaCode.length !== 6}>{loading ? 'Verifying…' : 'Verify'}</button>
      <button class="link" on:click={() => { step = 'credentials'; mfaCode = ''; }}>Back</button>
    {/if}
  </div>
</div>

<style>
  .login-container { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: var(--bg); padding: 20px; }
  .login-card { background: var(--raised); border: 1px solid var(--border); border-radius: 10px; padding: 32px; max-width: 380px; width: 100%; color: var(--text); }
  h1 { font-size: 28px; color: var(--primary); margin: 0 0 4px; letter-spacing: -1px; }
  .subtitle { color: var(--muted); font-size: 13px; margin: 0 0 20px; }
  input { width: 100%; padding: 10px 12px; background: var(--overlay); border: 1px solid var(--border-default); border-radius: 6px; color: var(--text); margin-bottom: 12px; }
  button { width: 100%; padding: 10px 16px; background: var(--primary); color: var(--palette-button-text, #fff); border: none; border-radius: 6px; font-weight: 600; cursor: pointer; margin-bottom: 8px; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  button.link { background: transparent; color: var(--muted); font-size: 12px; }
  .error { background: var(--danger-bg); color: var(--danger); padding: 10px 12px; border-radius: 6px; margin-bottom: 12px; font-size: 13px; }
</style>
