<script lang="ts">
  import { onMount } from 'svelte'
  import { CheckCircle2, Info, MessageSquare, OctagonAlert, X } from 'lucide-svelte'
  import Auth from '$lib/components/Auth.svelte'
  import ChatWorkspace from '$lib/components/ChatWorkspace.svelte'
  import Dialog from '$lib/components/Dialog.svelte'
  import { Workspace } from '$lib/stores/workspace.svelte'

  const workspace = new Workspace()
  const pageTitle = $derived(workspace.totalUnread > 0 ? `(${workspace.totalUnread > 99 ? '99+' : workspace.totalUnread}) ChiorIM` : 'ChiorIM')

  onMount(() => {
    void workspace.start()
    const onKey = (event: KeyboardEvent) => {
      if (workspace.phase !== 'workspace') return
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        if (workspace.searchOpen) workspace.searchOpen = false
        else workspace.openSearch()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      workspace.dispose()
    }
  })
</script>

<svelte:head>
  <title>{pageTitle}</title>
  <meta name="description" content="ChiorIM 自托管即时通讯与多 Agent 协作工作区" />
</svelte:head>

{#if workspace.phase === 'workspace'}
  <ChatWorkspace {workspace} />
{:else if workspace.phase === 'auth'}
  <Auth {workspace} />
{:else}
  <main class="auth-screen">
    <div class="auth-card status-card">
      <span class="brand-mark"><MessageSquare size={24} strokeWidth={2.2} /></span>
      <h1>ChiorIM</h1>
      {#if workspace.phase === 'error'}
        <p class="form-error" role="alert">{workspace.failure}</p>
        <button type="button" class="button primary" onclick={() => workspace.bootstrap()}>重新连接</button>
      {:else}
        <p class="muted" role="status"><span class="spinner"></span> 正在连接工作区…</p>
      {/if}
    </div>
  </main>
{/if}

{#if workspace.confirmState}
  <Dialog title={workspace.confirmState.title} close={() => workspace.answerConfirm(false)}>
    <p class="confirm-text">{workspace.confirmState.description}</p>
    <div class="dialog-actions">
      <button type="button" class="button quiet" onclick={() => workspace.answerConfirm(false)}>取消</button>
      <button type="button" class="button" class:danger={workspace.confirmState.danger} class:primary={!workspace.confirmState.danger}
        onclick={() => workspace.answerConfirm(true)}>
        {workspace.confirmState.confirmLabel ?? '确认'}
      </button>
    </div>
  </Dialog>
{/if}

{#if workspace.toasts.length}
  <div class="toast-stack" aria-live="polite">
    {#each workspace.toasts as item (item.id)}
      <div class="toast" class:success={item.kind === 'success'} class:error={item.kind === 'error'} role="status">
        {#if item.kind === 'success'}<CheckCircle2 size={15} />
        {:else if item.kind === 'error'}<OctagonAlert size={15} />
        {:else}<Info size={15} />{/if}
        <span>{item.text}</span>
        <button type="button" class="icon-button" aria-label="关闭通知" onclick={() => workspace.dismissToast(item.id)}><X size={13} /></button>
      </div>
    {/each}
  </div>
{/if}
