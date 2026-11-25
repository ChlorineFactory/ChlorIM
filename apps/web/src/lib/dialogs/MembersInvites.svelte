<script lang="ts">
  import { onMount } from 'svelte'
  import { Copy, KeyRound, Link2, Plus, Shield, ShieldOff, Trash2, UserCheck, UserX } from 'lucide-svelte'
  import {
    adminResetPasswordSchema, adminUserPatchSchema, inviteCreateSchema, inviteListSchema,
    inviteSchema, memberSchema, okResponseSchema,
  } from '@chiorim/shared'
  import type { Invite, Member } from '@chiorim/shared'
  import { api, copyText, errorText, remove } from '$lib/api'
  import { formatStamp } from '$lib/format'
  import Avatar from '$lib/components/Avatar.svelte'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace }: { workspace: Workspace } = $props()

  let invites = $state<Invite[]>([])
  let maxUses = $state<number | undefined>(5)
  let expiry = $state('')
  let busy = $state(false)
  let error = $state('')

  let resetTarget = $state<Member | null>(null)
  let resetPassword = $state('')

  const humans = $derived(workspace.allMembers.filter(member => member.kind === 'human'))

  async function action(task: () => Promise<unknown>) {
    busy = true
    error = ''
    try { await task() } catch (failure) { error = errorText(failure) } finally { busy = false }
  }

  onMount(() => { void action(async () => { invites = await api('/invites', inviteListSchema) }) })

  async function createInvite(event: SubmitEvent) {
    event.preventDefault()
    await action(async () => {
      const input = inviteCreateSchema.parse({ max_uses: maxUses, expires_at: expiry ? new Date(expiry).valueOf() : null })
      const invite = await api('/invites', inviteSchema, 'POST', input)
      invites = [invite, ...invites]
      workspace.toast('已生成邀请码', 'success')
    })
  }

  async function copyInvite(invite: Invite, link: boolean) {
    const url = new URL('/', location.origin)
    url.searchParams.set('invite', invite.code)
    await copyText(link ? url.href : invite.code)
    workspace.toast(link ? '注册链接已复制' : '邀请码已复制', 'success')
  }

  async function revokeInvite(invite: Invite) {
    const ok = await workspace.confirm({
      title: '撤销邀请码',
      description: '撤销后该邀请码将无法再用于注册新成员。',
      confirmLabel: '撤销',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await remove('/invites/' + invite.code)
      invites = invites.filter(item => item.code !== invite.code)
    })
  }

  async function patchMember(member: Member, patch: { is_admin?: boolean; disabled?: boolean }) {
    const ok = await workspace.confirm({
      title: patch.disabled !== undefined ? (patch.disabled ? `停用 ${member.display_name}` : `恢复 ${member.display_name}`)
        : (patch.is_admin ? `设为管理员` : `取消管理员权限`),
      description: patch.disabled ? '停用后该账号会立即被踢下线且无法登录。' : '确定更新该成员的权限状态吗？',
      confirmLabel: '确认',
      danger: Boolean(patch.disabled),
    })
    if (!ok) return
    await action(async () => {
      const updated = await api(`/admin/users/${member.id}`, memberSchema, 'PATCH', adminUserPatchSchema.parse(patch))
      workspace.directory[updated.id] = updated
      workspace.toast('成员状态已更新', 'success')
    })
  }

  async function submitReset(event: SubmitEvent) {
    event.preventDefault()
    if (!resetTarget) return
    await action(async () => {
      await api(`/admin/users/${resetTarget!.id}/reset-password`, okResponseSchema, 'POST',
        adminResetPasswordSchema.parse({ new_password: resetPassword }))
      workspace.toast(`已重置 ${resetTarget!.display_name} 的密码并下线旧设备`, 'success')
      resetTarget = null
      resetPassword = ''
    })
  }
</script>

<div class="settings-section-stack">
  {#if error}<p class="form-error" role="alert">{error}</p>{/if}

  <section class="settings-card">
    <div class="settings-card-head">
      <h3>邀请好友加入</h3>
      <p class="muted">生成邀请码或直接发注册链接给朋友，点开即可自动填入邀请码。</p>
    </div>
    <form class="stack-form" onsubmit={createInvite}>
      <div class="form-row two">
        <label>可用次数<input type="number" bind:value={maxUses} min="1" max="1000" step="1" required /></label>
        <label>过期时间（可选）<input type="datetime-local" bind:value={expiry} /></label>
      </div>
      <button class="button primary self-start" type="submit" disabled={busy}><Plus size={15} /> 生成邀请码</button>
    </form>

    <div class="manage-list">
      {#each invites as invite (invite.code)}
        <article class="manage-card">
          <div class="manage-card-top">
            <code title={invite.code}>{invite.code}</code>
            <small>已用 {invite.used_count} / {invite.max_uses}</small>
          </div>
          <div class="row-between">
            <small>{invite.expires_at ? '到期 ' + formatStamp(invite.expires_at) : '长期有效'}</small>
            <div class="row-actions">
              <button class="button quiet compact" type="button" onclick={() => void copyInvite(invite, false)}><Copy size={13} /> 邀请码</button>
              <button class="button quiet compact" type="button" onclick={() => void copyInvite(invite, true)}><Link2 size={13} /> 注册链接</button>
              <button class="icon-button danger-on-hover" type="button" title="撤销" aria-label="撤销邀请码" disabled={busy}
                onclick={() => void revokeInvite(invite)}><Trash2 size={15} /></button>
            </div>
          </div>
        </article>
      {:else}
        <p class="muted">暂无邀请码。</p>
      {/each}
    </div>
  </section>

  <section class="settings-card">
    <div class="settings-card-head">
      <h3>人类成员管理（{humans.length}）</h3>
      <p class="muted">支持升降管理员、停用/恢复账号，以及帮忘密码的好友重置密码。</p>
    </div>

    {#if resetTarget}
      <form class="editor-card stack-form" onsubmit={submitReset}>
        <h3>为 {resetTarget.display_name}（@{resetTarget.username}）设置新密码</h3>
        <label>新密码（至少 8 位）
          <input type="password" bind:value={resetPassword} required minlength={8} maxlength={256} autocomplete="new-password" />
        </label>
        <div class="dialog-actions">
          <button type="button" class="button quiet" onclick={() => { resetTarget = null; resetPassword = '' }}>取消</button>
          <button type="submit" class="button primary" disabled={busy}>确认重置</button>
        </div>
      </form>
    {/if}

    <div class="manage-list">
      {#each humans as person (person.id)}
        {@const isSelf = person.id === workspace.user?.id}
        <article class="manage-card">
          <div class="manage-card-top">
            <div class="member-identity">
              <Avatar user={person} size={32} online={person.online} status={person.presence_status} />
              <span>
                <strong>
                  {person.display_name}
                  {#if person.is_admin}<span class="bot-tag admin-tag">ADMIN</span>{/if}
                  {#if person.disabled}<span class="archived-tag">已停用</span>{/if}
                </strong>
                <small>@{person.username}</small>
              </span>
            </div>
            {#if !isSelf}
              <div class="row-actions">
                <button type="button" class="button quiet compact" disabled={busy}
                  onclick={() => { resetTarget = person; resetPassword = '' }}>
                  <KeyRound size={13} /> 重置密码
                </button>
                <button type="button" class="button quiet compact" disabled={busy}
                  onclick={() => void patchMember(person, { is_admin: !person.is_admin })}>
                  {#if person.is_admin}<ShieldOff size={13} /> 取消管理{:else}<Shield size={13} /> 设为管理{/if}
                </button>
                <button type="button" class="button quiet compact" class:danger-on-hover={!person.disabled} disabled={busy}
                  onclick={() => void patchMember(person, { disabled: !person.disabled })}>
                  {#if person.disabled}<UserCheck size={13} /> 恢复{:else}<UserX size={13} /> 停用{/if}
                </button>
              </div>
            {:else}
              <small class="muted">当前账号</small>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  </section>
</div>
