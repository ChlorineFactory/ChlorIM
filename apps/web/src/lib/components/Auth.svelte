<script lang="ts">
  import { replaceState } from '$app/navigation'
  import { onMount } from 'svelte'
  import { Moon, Sun } from 'lucide-svelte'
  import { loginSchema, registerSchema } from '@chiorim/shared'
  import { errorText } from '$lib/api'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace }: { workspace: Workspace } = $props()
  let form = $state<'login' | 'register'>('login')
  const mode = $derived(workspace.initialized ? form : 'register')
  let username = $state('')
  let displayName = $state('')
  let password = $state('')
  let confirmPassword = $state('')
  let invite = $state('')
  let busy = $state(false)
  let error = $state('')

  onMount(() => {
    const code = new URLSearchParams(location.search).get('invite')
    if (code && workspace.initialized) { form = 'register'; invite = code }
  })

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    error = ''
    const cleanUser = username.trim().toLowerCase()
    if (mode === 'register' && password !== confirmPassword) {
      error = '两次输入的密码不一致。'
      return
    }
    busy = true
    try {
      const credentials = { username: cleanUser, password }
      const details = {
        ...credentials,
        display_name: displayName.trim(),
        invite_code: workspace.initialized ? invite.trim() : undefined,
      }
      if (mode === 'register') registerSchema.parse(details)
      else loginSchema.parse(credentials)
      await workspace.authenticate(mode, details)
      if (new URLSearchParams(location.search).has('invite')) {
        const url = new URL(location.href)
        url.searchParams.delete('invite')
        replaceState(url, {})
      }
    } catch (failure) { error = errorText(failure) }
    finally { busy = false }
  }
</script>

<main class="auth-screen">
  <button class="icon-button auth-theme" type="button" aria-label="切换主题" title="切换主题"
    onclick={() => workspace.setTheme(workspace.theme === 'dark' ? 'light' : 'dark')}>
    {#if workspace.theme === 'dark'}<Sun size={18} />{:else}<Moon size={18} />{/if}
  </button>

  <div class="auth-card">
    <div class="auth-brand">
      <img src="/icon.svg" alt="" width="24" height="24" />
      <strong>ChiorIM</strong>
    </div>

    {#if !workspace.initialized}
      <h1>创建管理员账号</h1>
      <p class="muted">首次启动需先初始化管理员。</p>
    {:else}
      <h1>{mode === 'login' ? '登录' : '注册'}</h1>
      <div class="segments" aria-label="登录方式">
        <button type="button" aria-pressed={mode === 'login'} class:active={mode === 'login'}
          onclick={() => { form = 'login'; error = '' }}>登录</button>
        <button type="button" aria-pressed={mode === 'register'} class:active={mode === 'register'}
          onclick={() => { form = 'register'; error = '' }}>邀请码注册</button>
      </div>
    {/if}

    <form class="stack-form" onsubmit={submit}>
      {#if mode === 'register'}
        <label>显示名称
          <input bind:value={displayName} required maxlength={100} autocomplete="nickname" />
        </label>
      {/if}
      <label>用户名
        <input bind:value={username} required minlength={2} maxlength={32}
          autocomplete="username" autocapitalize="none" spellcheck={false} placeholder="a-z, 0-9, _, -" />
      </label>
      <label>密码
        <input type="password" bind:value={password} required minlength={8} maxlength={256}
          autocomplete={mode === 'login' ? 'current-password' : 'new-password'} placeholder="至少 8 位" />
      </label>
      {#if mode === 'register'}
        <label>确认密码
          <input type="password" bind:value={confirmPassword} required minlength={8} maxlength={256}
            autocomplete="new-password" />
        </label>
      {/if}
      {#if workspace.initialized && mode === 'register'}
        <label>邀请码
          <input bind:value={invite} required maxlength={128} spellcheck={false} autocomplete="off" />
        </label>
      {/if}
      {#if error}<p class="form-error" role="alert">{error}</p>{/if}
      <button type="submit" class="button primary auth-submit" disabled={busy}>
        {busy ? '提交中…' : !workspace.initialized ? '创建并进入' : mode === 'login' ? '登录' : '注册'}
      </button>
    </form>
  </div>
</main>
