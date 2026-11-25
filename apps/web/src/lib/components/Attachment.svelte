<script lang="ts">
  import { Download, FileText } from 'lucide-svelte'
  import type { Attachment } from '@chiorim/shared'
  import { formatSize, imageMime } from '$lib/format'
  let { file, preview }: { file: Attachment; preview: (file: Attachment) => void } = $props()
</script>

{#if imageMime(file.mime)}
  <button class="image-attachment" type="button" title={file.name} onclick={() => preview(file)}>
    <img src={file.url} alt={file.name} loading="lazy" />
  </button>
{:else}
  <a href={file.url} download={file.name} class="file-attachment">
    <FileText size={20} />
    <span><strong>{file.name}</strong><small>{formatSize(file.size)}</small></span>
    <Download size={16} />
  </a>
{/if}
