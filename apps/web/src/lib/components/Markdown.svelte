<script lang="ts">
  import { renderMarkdown } from '$lib/markdown'
  import { copyText } from '$lib/api'
  let { content }: { content: string } = $props()
  const html = $derived(renderMarkdown(content))

  function copyCode(node: HTMLDivElement) {
    const click = async (event: MouseEvent) => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>('.code-copy')
      const code = target?.closest('.code-frame')?.querySelector('code')
      if (!target || !code) return
      try {
        await copyText(code.textContent ?? '')
        target.textContent = '已复制'
      } catch { target.textContent = '复制失败' }
      setTimeout(() => { if (target.isConnected) target.textContent = '复制' }, 1500)
    }
    node.addEventListener('click', click)
    return { destroy: () => node.removeEventListener('click', click) }
  }
</script>

<div class="prose-message" use:copyCode>{@html html}</div>
