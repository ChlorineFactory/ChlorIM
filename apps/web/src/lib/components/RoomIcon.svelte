<script lang="ts">
  import { Hash, LockKeyhole, Pin, MessageCircle } from 'lucide-svelte'
  import type { Channel } from '@chiorim/shared'
  let { type, size = 17 }: { type: Channel['type']; size?: number } = $props()
  const Icon = $derived({ public: Hash, private: LockKeyhole, board: Pin, dm: MessageCircle }[type])
</script>

<Icon {size} strokeWidth={1.9} />
