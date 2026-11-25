<script lang="ts">
  import { untrack } from 'svelte'
  import { FolderOpen } from 'lucide-svelte'
  import { botCreateSchema, botPatchSchema, botSchema, botWriteResponseSchema, driverSchema } from '@chiorim/shared'
  import type { Bot, BotWriteResponse, Channel, CreateBotRequest, DriverName, Provider, Workspace as FolderGroup } from '@chiorim/shared'
  import { api, errorText } from '$lib/api'
  import { shortPath } from '$lib/format'
  import type { BotTemplate } from '$lib/presets'
  import AvatarField from '$lib/components/AvatarField.svelte'
  import RoomIcon from '$lib/components/RoomIcon.svelte'

  let { initial, template, providers, folders, rooms, close, saved }: {
    initial?: Bot
    template?: BotTemplate
    providers: Provider[]
    folders: FolderGroup[]
    rooms: Channel[]
    close: () => void
    saved: (result: BotWriteResponse) => void
  } = $props()

  let mode = $state<CreateBotRequest['mode']>(untrack(() => initial?.mode ?? template?.mode ?? 'provider'))
  let name = $state(untrack(() => initial?.user.display_name ?? template?.display_name ?? ''))
  let username = $state(untrack(() => initial?.user.username ?? template?.username ?? ''))
  let avatar = $state(untrack(() => initial?.user.avatar_url ?? template?.avatar_url ?? ''))
  let bio = $state(untrack(() => initial?.user.bio ?? template?.bio ?? ''))
  let trigger = $state<NonNullable<CreateBotRequest['trigger_policy']>>(untrack(() => initial?.trigger_policy ?? 'mention'))
  let provider = $state(untrack(() => initial?.provider_id ?? (providers[0]?.id ?? '')))
  let model = $state(untrack(() => initial?.model ?? (providers[0]?.models[0] ?? '')))
  let prompt = $state(untrack(() => initial?.system_prompt ?? template?.system_prompt ?? ''))
  let temperature = $state<number | undefined>(untrack(() => initial?.temperature ?? 0.7))
  let context = $state<number | undefined>(untrack(() => initial?.context_limit ?? 20))
  let driver = $state<DriverName | ''>(untrack(() => initial?.driver_hint ?? template?.driver_hint ?? ''))
  let roomIds = $state<string[]>(untrack(() => rooms.filter(room => room.type === 'public').map(room => room.id)))
  let error = $state('')
  let uploading = $state(false)
  let busy = $state(false)

  const models = $derived(providers.find(item => item.id === provider)?.models ?? [])
  const valid = $derived(mode === 'provider' ? Boolean(provider && model.trim()) : true)

  const groupedRooms = $derived.by(() => {
    const known = new Set(folders.map(item => item.id))
    return folders.map((folder, index) => ({
      folder,
      items: rooms.filter(room => room.workspace_id === folder.id || (index === 0 && (!room.workspace_id || !known.has(room.workspace_id)))),
    })).filter(group => group.items.length > 0)
  })

  function groupCheckedState(items: Channel[]) {
    const selected = items.filter(item => roomIds.includes(item.id)).length
    return { all: selected === items.length && items.length > 0, partial: selected > 0 && selected < items.length }
  }

  function toggleGroup(items: Channel[]) {
    const ids = items.map(item => item.id)
    const { all } = groupCheckedState(items)
    if (all) roomIds = roomIds.filter(id => !ids.includes(id))
    else roomIds = [...new Set([...roomIds, ...ids])]
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    busy = true
    error = ''
    try {
      const profile = { display_name: name, avatar_url: avatar.trim() || null, bio, trigger_policy: trigger }
      const settings = mode === 'provider'
        ? { provider_id: provider, model, system_prompt: prompt, temperature, context_limit: context }
        : { driver_hint: driver || null }
      const bot = initial
        ? await api('/bots/' + initial.user_id, botSchema, 'PATCH', botPatchSchema.parse({ ...profile, ...settings }))
        : await api('/bots', botWriteResponseSchema, 'POST', botCreateSchema.parse({
          ...profile, ...settings, username: username.trim().toLowerCase(), mode, channel_ids: roomIds,
        }))
      saved(bot)
    } catch (failure) { error = errorText(failure) } finally { busy = false }
  }
</script>

<form class="stack-form editor-card" onsubmit={submit}>
  <h3>{initial ? '编辑 ' + initial.user.display_name : template ? `创建 · ${template.label}` : '创建 Bot'}</h3>

  <label>模式
    <select bind:value={mode} disabled={Boolean(initial)}>
      <option value="provider">托管模型 Bot（通过 Provider API 调用）</option>
      <option value="bridge">本地 Agent Bot（通过 chior-bridge 后台服务接入）</option>
    </select>
  </label>

  <AvatarField bind:value={avatar} {name} kind="bot" onbusy={(value) => { uploading = value }} />

  <div class="form-row two">
    <label>显示名称<input bind:value={name} required maxlength={100} placeholder="例如：Codex" /></label>
    <label>用户名（@提及用）<input bind:value={username} readonly={Boolean(initial)} required minlength={2} maxlength={32}
      placeholder="小写字母、数字、_ 或 -" autocapitalize="none" spellcheck={false} /></label>
  </div>

  <label>简介<textarea bind:value={bio} rows="2" maxlength={2000} placeholder="介绍这个 Bot 擅长做什么"></textarea></label>

  <label>触发策略
    <select bind:value={trigger}>
      <option value="mention">仅 @提及（推荐，防刷屏）</option>
      <option value="always">频道内每条消息都响应</option>
      <option value="dm_only">仅私聊响应</option>
    </select>
  </label>

  {#if mode === 'provider'}
    <div class="form-row two">
      <label>Provider
        <select bind:value={provider} required>
          <option value="">选择 Provider</option>
          {#each providers as item (item.id)}<option value={item.id}>{item.name}</option>{/each}
        </select>
      </label>
      <label>Model
        <input bind:value={model} list="chior-bot-models" placeholder="选择或手动输入模型 ID" required maxlength={256} />
        <datalist id="chior-bot-models">{#each models as item (item)}<option value={item}></option>{/each}</datalist>
      </label>
    </div>
    {#if !providers.length}<p class="muted">请先在左侧「模型 Providers」添加一个上游提供商。</p>{/if}
    <label>System Prompt<textarea bind:value={prompt} rows="3" maxlength={60000} placeholder="可选：给这个 Bot 设定角色与回复风格"></textarea></label>
    <div class="form-row two">
      <label>Temperature<input type="number" bind:value={temperature} min="0" max="2" step="0.01" required /></label>
      <label>上下文条数<input type="number" bind:value={context} min="1" max="100" step="1" required /></label>
    </div>
  {:else}
    <label>驱动类型
      <select bind:value={driver}>
        <option value="">默认（codex）</option>
        {#each driverSchema.options as item}<option value={item}>{item}</option>{/each}
      </select>
    </label>
  {/if}

  {#if !initial && rooms.length}
    <fieldset class="choice-list grouped-choices">
      <legend>初始加入频道（{roomIds.length}/{rooms.length}）</legend>
      <div class="choice-toolbar">
        <button type="button" class="choice-quick" onclick={() => { roomIds = rooms.map(r => r.id) }}>全选</button>
        <button type="button" class="choice-quick" onclick={() => { roomIds = rooms.filter(r => r.type === 'public').map(r => r.id) }}>仅公开频道</button>
        <button type="button" class="choice-quick" onclick={() => { roomIds = [] }}>清空</button>
      </div>
      <div class="choice-scroll">
        {#each groupedRooms as { folder, items } (folder.id)}
          {@const state = groupCheckedState(items)}
          <div class="choice-folder-group">
            <label class="check-row choice-folder-head">
              <input type="checkbox" checked={state.all} indeterminate={state.partial} onchange={() => toggleGroup(items)} />
              {#if folder.work_dir}<FolderOpen size={13} class="choice-folder-icon" />{/if}
              <strong>{folder.name}</strong>
              {#if folder.work_dir}<code class="choice-path">{shortPath(folder.work_dir)}</code>{/if}
            </label>
            <div class="choice-folder-rooms">
              {#each items as room (room.id)}
                <label class="check-row">
                  <input type="checkbox" value={room.id} bind:group={roomIds} />
                  <RoomIcon type={room.type} size={13} />
                  <span>{room.name}</span>
                  {#if room.work_dir}<code class="choice-subpath">{room.work_dir}</code>{/if}
                </label>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </fieldset>
  {/if}

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}

  <div class="dialog-actions">
    <button class="button quiet" type="button" onclick={close}>取消</button>
    <button class="button primary" type="submit" disabled={busy || uploading || !valid}>{initial ? '保存修改' : '创建 Bot'}</button>
  </div>
</form>
