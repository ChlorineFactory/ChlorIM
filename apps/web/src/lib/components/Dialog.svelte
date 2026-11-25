<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { X } from 'lucide-svelte'
  let { title, children, close, wide = false }: { title: string; children: Snippet; close: () => void; wide?: boolean } = $props()
  let dialog: HTMLDialogElement
  onMount(() => {
    dialog.showModal()
    return () => dialog.close()
  })
</script>

<dialog bind:this={dialog} class:wide aria-label={title} oncancel={(event) => { event.preventDefault(); close() }}>
  <div class="dialog-header">
    <h2>{title}</h2>
    <button class="icon-button" type="button" title="关闭" aria-label="关闭" onclick={close}><X size={19} /></button>
  </div>
  <div class="dialog-body">{@render children()}</div>
</dialog>
