<script lang="ts">
  import { onMount } from 'svelte'
  import { KeyRound, Laptop, LogOut, ShieldAlert, Trash2 } from 'lucide-svelte'
  import { changePasswordSchema, okResponseSchema } from '@chiorim/shared'
  import type { SessionInfo } from '@chiorim/shared'
  import { api, errorText, listSessions, remove, revokeOtherSessions } from '$lib/api'
  import { formatStamp } from '$lib/format'
  import { summarizeUserAgent } from '$lib/presets'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace }: { workspace: Workspace } = $props()

  let currentPassword = $state('')
  let newPassword = $state('')
  let confirmPassword = $state('')
  let revokeOthers = $state(true)
  let pwBusy = $state(false)
  let pwError = $state('')

  let sessions = $state<SessionInfo[]>([])
  let sessionsBusy = $state(false)
  let sessionsError = $state('')

  async function loadSessions() {
    sessionsBusy = true
    sessionsError = ''
    try { sessions = await listSessions() }
    catch (failure) { sessionsError = errorText(failure) }
    finally { sessionsBusy = false }
  }

  onMount(() => { void loadSessions() })

  async function submitPassword(event: SubmitEvent) {
    event.preventDefault()
    pwError = ''
    if (newPassword !== confirmPassword) { pwError = '两次输入的新密码不一致。'; return }
    pwBusy = true
    try {
      const payload = changePasswordSchema.parse({
        current_password: currentPassword,
        new_password: newPassword,
        revoke_others: revokeOthers,
      })
      await api('/auth/change-password', okResponseSchema, 'POST', payload)
      currentPassword = ''
      newPassword = ''
      confirmPassword = ''
      workspace.toast('密码已更新', 'success')
      await loadSessions()
    } catch (failure) { pwError = errorText(failure) }
    finally { pwBusy = false }
  }

  async function revokeOne(session: SessionInfo) {
    const ok = await workspace.confirm({
      title: '下线此设备',
      description: session.current ? '这是你当前正在使用的设备，撤销后将立即退出登录。' : '确定强制下线这台设备吗？',
      confirmLabel: '确认下线',
      danger: true,
    })
    if (!ok) return
    sessionsBusy = true
    try {
      await remove('/auth/sessions/' + session.id)
      if (session.current) {
        workspace.settingsTab = null
        await workspace.bootstrap()
        return
      }
      sessions = sessions.filter(item => item.id !== session.id)
      workspace.toast('设备已下线', 'info')
    } catch (failure) { sessionsError = errorText(failure) }
    finally { sessionsBusy = false }
  }

  async function revokeAllOthers() {
    const ok = await workspace.confirm({
      title: '下线其他全部设备',
      description: '除当前浏览器外的所有登录会话和 WebSocket 将立即断开。',
      confirmLabel: '全部下线',
      danger: true,
    })
    if (!ok) return
    sessionsBusy = true
    try {
      await revokeOtherSessions()
      await loadSessions()
      workspace.toast('其他设备已全部下线', 'success')
    } catch (failure) { sessionsError = errorText(failure) }
    finally { sessionsBusy = false }
  }
</script>

<div class="settings-section-stack">
  <section class="settings-card">
    <div class="settings-card-head">
      <h3><KeyRound size={15} /> 修改密码</h3>
      <p class="muted">密码长度 8–256 个字符，建议开启「下线其他设备」。</p>
    </div>
    <form class="stack-form" onsubmit={submitPassword}>
      <label>当前密码
        <input type="password" bind:value={currentPassword} required minlength={8} autocomplete="current-password" />
      </label>
      <div class="form-row two">
        <label>新密码
          <input type="password" bind:value={newPassword} required minlength={8} maxlength={256} autocomplete="new-password" />
        </label>
        <label>确认新密码
          <input type="password" bind:value={confirmPassword} required minlength={8} maxlength={256} autocomplete="new-password" />
        </label>
      </div>
      <label class="check-row"><input type="checkbox" bind:checked={revokeOthers} /> 修改成功后自动下线其他全部设备</label>
      {#if pwError}<p class="form-error" role="alert">{pwError}</p>{/if}
      <div class="dialog-actions">
        <button type="submit" class="button primary" disabled={pwBusy}>{pwBusy ? '提交中…' : '更新密码'}</button>
      </div>
    </form>
  </section>

  <section class="settings-card">
    <div class="settings-card-head row-between">
      <div>
        <h3><Laptop size={15} /> 活跃登录设备（{sessions.length}）</h3>
        <p class="muted">会话 30 天滑动续期，随时可撤销不认识的设备。</p>
      </div>
      {#if sessions.length > 1}
        <button type="button" class="button quiet danger-on-hover" disabled={sessionsBusy} onclick={() => void revokeAllOthers()}>
          <LogOut size={14} /> 下线其他设备
        </button>
      {/if}
    </div>
    {#if sessionsError}<p class="form-error" role="alert">{sessionsError}</p>{/if}
    <div class="manage-list">
      {#each sessions as item (item.id)}
        <article class="manage-card session-card">
          <div class="manage-card-top">
            <div class="session-title">
              <strong>{summarizeUserAgent(item.user_agent)}</strong>
              {#if item.current}<span class="bot-tag current-tag">当前设备</span>{/if}
            </div>
            <button type="button" class="icon-button danger-on-hover" title="下线设备" aria-label="下线设备"
              disabled={sessionsBusy} onclick={() => void revokeOne(item)}>
              <Trash2 size={15} />
            </button>
          </div>
          <p class="muted">IP：{item.ip_address || '本机'} · 最近活跃：{formatStamp(item.last_active_at || item.created_at)}</p>
          <p class="muted">登录于：{formatStamp(item.created_at)}</p>
        </article>
      {:else}
        <p class="muted">{sessionsBusy ? '正在加载会话…' : '暂无活跃会话。'}</p>
      {/each}
    </div>
    <p class="hint-line"><ShieldAlert size={13} /> 登录和注册均已启用滑动窗口限流保护。</p>
  </section>
</div>
