<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Bot, KeyRound, LogOut, Palette, Server, Shield, Terminal, UserRound, X,
  } from 'lucide-svelte'
  import type { SettingsTab, Workspace } from '$lib/stores/workspace.svelte'
  import Profile from './Profile.svelte'
  import Security from './Security.svelte'
  import Appearance from './Appearance.svelte'
  import Bots from './Bots.svelte'
  import Providers from './Providers.svelte'
  import MembersInvites from './MembersInvites.svelte'
  import BridgeGuide from './BridgeGuide.svelte'

  let { workspace, close }: { workspace: Workspace; close: () => void } = $props()
  let dialog: HTMLDialogElement
  let leaving = $state(false)

  const active = $derived(workspace.settingsTab ?? 'profile')
  const isAdmin = $derived(workspace.user?.is_admin ?? false)

  onMount(() => {
    dialog.showModal()
    return () => dialog.close()
  })

  function pick(tab: SettingsTab) {
    workspace.settingsTab = tab
  }

  async function logout() {
    const ok = await workspace.confirm({
      title: '退出登录',
      description: '确定要退出当前账号吗？',
      confirmLabel: '退出登录',
      danger: true,
    })
    if (!ok) return
    leaving = true
    try {
      close()
      await workspace.logout()
    } catch (error) { workspace.report(error) }
    finally { leaving = false }
  }
</script>

<dialog bind:this={dialog} class="settings-dialog" aria-label="设置中心" oncancel={(event) => { event.preventDefault(); close() }}>
  <div class="settings-shell">
    <nav class="settings-nav" aria-label="设置分类">
      <div class="settings-nav-group">
        <h3>个人设置</h3>
        <button type="button" class:active={active === 'profile'} onclick={() => pick('profile')}>
          <UserRound size={15} /> 个人资料与状态
        </button>
        <button type="button" class:active={active === 'security'} onclick={() => pick('security')}>
          <Shield size={15} /> 账号与安全
        </button>
        <button type="button" class:active={active === 'appearance'} onclick={() => pick('appearance')}>
          <Palette size={15} /> 外观与提醒
        </button>
      </div>

      <div class="settings-nav-group">
        <h3>工作区与 Agent</h3>
        <button type="button" class:active={active === 'bots'} onclick={() => pick('bots')}>
          <Bot size={15} /> Bots &amp; Agents
        </button>
        <button type="button" class:active={active === 'providers'} onclick={() => pick('providers')}>
          <Server size={15} /> 模型 Providers
        </button>
        {#if isAdmin}
          <button type="button" class:active={active === 'members'} onclick={() => pick('members')}>
            <KeyRound size={15} /> 成员与邀请码
          </button>
        {/if}
        <button type="button" class:active={active === 'bridge'} onclick={() => pick('bridge')}>
          <Terminal size={15} /> Bridge &amp; MCP 指南
        </button>
      </div>

      <div class="settings-nav-foot">
        <button type="button" class="danger-nav" disabled={leaving} onclick={() => void logout()}>
          <LogOut size={15} /> 退出登录
        </button>
      </div>
    </nav>

    <section class="settings-content">
      <header class="settings-header">
        <h2>
          {active === 'profile' ? '个人资料与状态'
            : active === 'security' ? '账号与安全'
            : active === 'appearance' ? '外观与提醒'
            : active === 'bots' ? 'Bots & Agents'
            : active === 'providers' ? '模型 Providers'
            : active === 'members' ? '成员与邀请码'
            : 'Bridge & MCP 接入指南'}
        </h2>
        <button type="button" class="icon-button" aria-label="关闭设置中心" title="关闭 (Esc)" onclick={close}><X size={19} /></button>
      </header>

      <div class="settings-pane">
        {#if active === 'profile' && workspace.user}
          <Profile {workspace} user={workspace.user} />
        {:else if active === 'security'}
          <Security {workspace} />
        {:else if active === 'appearance'}
          <Appearance {workspace} />
        {:else if active === 'bots'}
          <Bots {workspace} />
        {:else if active === 'providers'}
          <Providers {workspace} admin={isAdmin} />
        {:else if active === 'members' && isAdmin}
          <MembersInvites {workspace} />
        {:else if active === 'bridge'}
          <BridgeGuide {workspace} />
        {/if}
      </div>
    </section>
  </div>
</dialog>
