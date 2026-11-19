<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$api/client';
  import Icon from '$design/Icon.svelte';

  /**
   * Sign in — two steps: credentials, then TOTP if required.
   * Same message for unknown user / wrong password (no enumeration);
   * rate-limit feedback surfaces the API message verbatim.
   */
  let step: 'credentials' | 'mfa' = $state('credentials');
  let email = $state('');
  let password = $state('');
  let mfaCode = $state('');
  let mfaChallengeId = $state('');
  let error = $state<string | null>(null);
  let loading = $state(false);

  async function submitCredentials(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    loading = true;
    try {
      const res = await api.auth.login(email, password);
      if (res.requiresMfa && res.mfaChallengeId) {
        mfaChallengeId = res.mfaChallengeId;
        step = 'mfa';
      } else {
        await goto('/overview', { replaceState: true });
      }
    } catch (err) {
      error = err instanceof ApiError ? err.message : 'Sign-in failed. Try again.';
    } finally {
      loading = false;
    }
  }

  async function submitMfa(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    loading = true;
    try {
      await api.auth.mfaVerify(mfaChallengeId, mfaCode);
      await goto('/overview', { replaceState: true });
    } catch (err) {
      error =
        err instanceof ApiError
          ? err.status === 401
            ? 'That code is not valid. Codes rotate every 30 seconds — try the next one.'
            : err.message
          : 'Verification failed. Try again.';
    } finally {
      loading = false;
    }
  }
</script>

<section class="card auth-card">
  <h1>Sign in</h1>
  <p class="subtitle">Manage your projects, domains and deployments.</p>

  {#if step === 'credentials'}
    <form onsubmit={submitCredentials} novalidate>
      <label class="field">
        Email
        <input
          type="email"
          name="email"
          bind:value={email}
          autocomplete="username"
          required
          placeholder="you@example.com"
        />
      </label>
      <label class="field">
        Password
        <input
          type="password"
          name="password"
          bind:value={password}
          autocomplete="current-password"
          required
          placeholder="Your password"
        />
      </label>
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
      <button class="btn primary full" type="submit" disabled={loading || !email || !password}>
        {loading ? 'Signing in…' : 'Continue'}
      </button>
    </form>
  {:else}
    <form onsubmit={submitMfa} novalidate>
      <div class="mfa-head">
        <span class="step-icon complete"><Icon name="security" size={16} /></span>
        <div>
          <strong class="strong">Two-factor authentication</strong>
          <small>Enter the 6-digit code from your authenticator app.</small>
        </div>
      </div>
      <label class="field">
        Authentication code
        <input
          type="text"
          bind:value={mfaCode}
          inputmode="numeric"
          pattern="[0-9]*"
          maxlength={6}
          autocomplete="one-time-code"
          required
          placeholder="123456"
          class="mono code-input"
        />
      </label>
      {#if error}
        <p class="error" role="alert">{error}</p>
      {/if}
      <button class="btn primary full" type="submit" disabled={loading || mfaCode.length < 6}>
        {loading ? 'Verifying…' : 'Verify and sign in'}
      </button>
      <button class="link-btn" type="button" onclick={() => (step = 'credentials')}>
        Use a different account
      </button>
    </form>
  {/if}
</section>

<style>
  .auth-card {
    padding: 28px;
    display: grid;
    gap: 14px;
  }
  h1 {
    margin: 0;
  }
  .full {
    width: 100%;
  }
  .mfa-head {
    display: flex;
    gap: 10px;
    align-items: flex-start;
  }
  .mfa-head small {
    display: block;
    color: var(--muted);
  }
  .code-input {
    font-size: 20px;
    letter-spacing: 0.35em;
    text-align: center;
  }
</style>
