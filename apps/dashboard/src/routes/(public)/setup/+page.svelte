<script lang="ts">
  import { goto } from '$app/navigation';
  import { api, ApiError } from '$api/client';
  import Icon from '$design/Icon.svelte';
  import { toast } from '$stores/toast';

  /**
   * First-run onboarding (master guide §3 First-run UI pages):
   * 1 Claim this installation → 2 Create owner → 3 Protect account (TOTP)
   * → 4 Recovery codes (shown once, acknowledgement required) → done.
   * Progress uses the Drevanta .steps / .step-icon pattern.
   */
  const STEPS = ['Claim', 'Owner', 'MFA', 'Recovery'] as const;
  let step = $state(0);

  // step 1
  let claimCode = $state('');
  let claimToken = $state('');

  // step 2
  let email = $state('');
  let password = $state('');
  let confirm = $state('');
  let otpauthUrl = $state('');
  let mfaSecret = $state('');

  // step 3
  let mfaCode = $state('');

  // step 4
  let recoveryCodes = $state<string[]>([]);
  let acknowledged = $state(false);

  let error = $state<string | null>(null);
  let loading = $state(false);

  function friendly(err: unknown, fallback: string): string {
    if (err instanceof ApiError) {
      if (err.status === 409) return 'This installation has already been claimed. Sign in instead.';
      if (err.status === 429) return 'Too many attempts. Wait a minute and try again.';
      if (err.status === 410) return 'This claim code has expired. Run the installer to issue a new one.';
      return err.message;
    }
    return fallback;
  }

  async function submitClaim(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    loading = true;
    try {
      const res = await api.bootstrap.claim(claimCode.trim());
      claimToken = res.claimToken;
      step = 1;
    } catch (err) {
      error = friendly(err, 'Claim failed. Check the code printed by the installer.');
    } finally {
      loading = false;
    }
  }

  async function submitOwner(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    if (password !== confirm) {
      error = 'Passwords do not match.';
      return;
    }
    loading = true;
    try {
      const res = await api.bootstrap.owner(claimToken, { email, password, mfaType: 'totp' });
      otpauthUrl = res.otpauthUrl ?? '';
      mfaSecret = res.mfaEnrollmentSecret ?? '';
      recoveryCodes = res.recoveryCodes ?? [];
      step = 2;
    } catch (err) {
      error = friendly(err, 'Owner creation failed.');
    } finally {
      loading = false;
    }
  }

  async function submitMfa(e: SubmitEvent) {
    e.preventDefault();
    error = null;
    loading = true;
    try {
      await api.bootstrap.mfaVerify(claimToken, mfaCode);
      step = 3;
    } catch (err) {
      error = friendly(err, 'That code is not valid. Try the next one.');
    } finally {
      loading = false;
    }
  }

  async function finish() {
    await toast('success', 'Workspace ready — welcome to Cloudlane.');
    await goto('/overview', { replaceState: true });
  }

  function copyCodes() {
    navigator.clipboard.writeText(recoveryCodes.join('\n')).then(
      () => toast('info', 'Recovery codes copied to the clipboard.'),
      () => toast('error', 'Copy failed — select the codes manually.'),
    );
  }

  function downloadCodes() {
    const blob = new Blob([recoveryCodes.join('\n')], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'cloudlane-recovery-codes.txt';
    a.click();
    URL.revokeObjectURL(a.href);
  }
</script>

<section class="card auth-card">
  <nav class="steps" aria-label="Onboarding progress">
    {#each STEPS as label, i}
      <span
        class="step-icon"
        class:complete={i < step}
        class:current={i === step}
        aria-current={i === step ? 'step' : undefined}
      >
        {i < step ? '✓' : i + 1}
      </span>
      <small class:done={i < step}>{label}</small>
    {/each}
  </nav>

  {#if step === 0}
    <h1>Claim this installation</h1>
    <p class="subtitle">
      Enter the claim code printed by the installer in your terminal. It expires after 60 minutes
      and allows a limited number of attempts.
    </p>
    <form onsubmit={submitClaim} novalidate>
      <label class="field">
        Claim code
        <input
          bind:value={claimCode}
          required
          placeholder="e.g. 7f3c-…-9a21"
          autocomplete="off"
          class="mono"
          spellcheck="false"
        />
        <small>Lost the code? Re-run <code class="mono">cloudlane installer claim</code> on the server.</small>
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button class="btn primary full" type="submit" disabled={loading || !claimCode}>
        {loading ? 'Claiming…' : 'Continue'}
      </button>
    </form>
  {:else if step === 1}
    <h1>Create the owner account</h1>
    <p class="subtitle">This account owns the workspace and every infrastructure action.</p>
    <form onsubmit={submitOwner} novalidate>
      <label class="field">
        Email
        <input type="email" bind:value={email} autocomplete="username" required placeholder="you@example.com" />
      </label>
      <label class="field">
        Password
        <input type="password" bind:value={password} autocomplete="new-password" required minlength={12} placeholder="At least 12 characters" />
        <small>Use a password manager — 12+ characters. A password with uncommon words works well.</small>
      </label>
      <label class="field">
        Confirm password
        <input type="password" bind:value={confirm} autocomplete="new-password" required placeholder="Repeat the password" />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button class="btn primary full" type="submit" disabled={loading || !email || password.length < 12 || password !== confirm}>
        {loading ? 'Creating…' : 'Continue'}
      </button>
    </form>
  {:else if step === 2}
    <h1>Protect your account</h1>
    <p class="subtitle">Add a two-factor authenticator (TOTP). You must verify one code to finish setup.</p>
    <div class="well">
      <ol class="enroll">
        <li>
          Add your account to an authenticator app
          {#if otpauthUrl}
            — <a href={otpauthUrl}>open the one-tap link</a>
          {/if}
        </li>
        <li>
          Or enter this secret manually:
          <div class="secret-row">
            <code class="mono">{mfaSecret}</code>
            <button
              class="icon-btn"
              type="button"
              aria-label="Copy MFA secret"
              onclick={() => {
                navigator.clipboard.writeText(mfaSecret);
                toast('info', 'Secret copied.');
              }}
            >
              <Icon name="copy" size={16} />
            </button>
          </div>
        </li>
        <li>Enter the current 6-digit code below.</li>
      </ol>
    </div>
    <form onsubmit={submitMfa} novalidate>
      <label class="field">
        Authentication code
        <input bind:value={mfaCode} inputmode="numeric" maxlength={6} required placeholder="123456" class="mono code-input" autocomplete="one-time-code" />
      </label>
      {#if error}<p class="error" role="alert">{error}</p>{/if}
      <button class="btn primary full" type="submit" disabled={loading || mfaCode.length < 6}>
        {loading ? 'Verifying…' : 'Verify and finish'}
      </button>
    </form>
  {:else}
    <h1>Save your recovery codes</h1>
    <div class="callout">
      <strong class="strong">These codes are shown once.</strong>
      <p>
        Each code works exactly once to sign in without your authenticator. Store them somewhere
        safe — they cannot be recovered from the server.
      </p>
    </div>
    <div class="codes mono" role="list">
      {#each recoveryCodes as code (code)}
        <code role="listitem">{code}</code>
      {/each}
    </div>
    <div class="row wrap">
      <button class="btn secondary small" type="button" onclick={copyCodes}>
        <Icon name="copy" size={14} /> Copy all
      </button>
      <button class="btn secondary small" type="button" onclick={downloadCodes}>
        <Icon name="download" size={14} /> Download .txt
      </button>
    </div>
    <label class="check">
      <input type="checkbox" bind:checked={acknowledged} />
      I saved my recovery codes in a safe place
    </label>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    <button class="btn primary full" type="button" disabled={!acknowledged} onclick={finish}>
      Go to Overview
    </button>
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
  .steps {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
    flex-wrap: wrap;
  }
  .steps small {
    color: var(--muted);
    margin-right: 6px;
  }
  .steps small.done {
    color: var(--success);
  }
  .step-icon.current {
    border-color: var(--primary);
    color: var(--primary);
  }
  .enroll {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: 8px;
    font-size: 14px;
  }
  .secret-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .secret-row code {
    word-break: break-all;
    background: var(--sunken);
    padding: 6px 8px;
    border-radius: 6px;
    flex: 1;
  }
  .code-input {
    font-size: 20px;
    letter-spacing: 0.35em;
    text-align: center;
  }
  .codes {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .codes code {
    background: var(--sunken);
    border: 1px solid var(--border);
    padding: 8px 10px;
    border-radius: 6px;
    text-align: center;
  }
  .callout p {
    margin: 4px 0 0;
  }
</style>
