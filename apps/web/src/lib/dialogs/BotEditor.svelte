<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { FolderOpen } from 'lucide-svelte'
  import {
    botCreateSchema, botPatchSchema, botSchema, botWriteResponseSchema, bridgeDriverSchema, localDriverSchema,
  } from '@chiorim/shared'
  import type {
    Bot, BotWriteResponse, Channel, CreateBotRequest, DriverName, LocalAgentStatus, LocalDriverName,
    PermissionMode, Provider, Workspace as FolderGroup,
  } from '@chiorim/shared'
  import { api, errorText, getLocalAgentStatus } from '$lib/api'
  import { shortPath } from '$lib/format'
  import type { BotTemplate } from '$lib/presets'
  import AvatarField from '$lib/components/AvatarField.svelte'
  import RoomIcon from '$lib/components/RoomIcon.svelte'

  type UiMode = 'local' | 'hermes' | 'bridge' | 'provider'

  let { initial, template, isAdmin = false, providers, folders, rooms, close, saved }: {
    initial?: Bot
    template?: BotTemplate
    isAdmin?: boolean
    providers: Provider[]
    folders: FolderGroup[]
    rooms: Channel[]
    close: () => void
    saved: (result: BotWriteResponse) => void
  } = $props()

  const defaultUiMode = untrack((): UiMode => {
    const rawMode = initial?.mode ?? template?.mode ?? 'provider'
    const rawDriver = initial?.driver_hint ?? template?.driver_hint
    if (rawMode === 'bridge' && rawDriver === 'hermes') return 'hermes'
    if (!initial && rawMode === 'local' && !isAdmin) return 'bridge'
    return rawMode
  })

  let uiMode = $state<UiMode>(defaultUiMode)
  let name = $state(untrack(() => initial?.user.display_name ?? template?.display_name ?? ''))
  let username = $state(untrack(() => initial?.user.username ?? template?.username ?? ''))
  let avatar = $state(untrack(() => initial?.user.avatar_url ?? template?.avatar_url ?? ''))
  let bio = $state(untrack(() => initial?.user.bio ?? template?.bio ?? ''))
  let trigger = $state<NonNullable<CreateBotRequest['trigger_policy']>>(untrack(() => initial?.trigger_policy ?? 'mention'))
  let provider = $state(untrack(() => initial?.provider_id ?? (providers[0]?.id ?? '')))
  let model = $state(untrack(() => initial?.model ?? (defaultUiMode === 'provider' ? (providers[0]?.models[0] ?? '') : '')))
  let prompt = $state(untrack(() => initial?.system_prompt ?? template?.system_prompt ?? ''))
  let temperature = $state<number | undefined>(untrack(() => initial?.temperature ?? 0.7))
  let context = $state<number | undefined>(untrack(() => initial?.context_limit ?? 20))
  let driver = $state<DriverName | ''>(untrack(() => {
    const initialDriver = initial?.driver_hint ?? template?.driver_hint ?? ''
    if (defaultUiMode === 'local') {
      return initialDriver === 'claude-code' || initialDriver === 'antigravity' ? initialDriver : 'codex'
    }
    if (defaultUiMode === 'hermes') return 'hermes'
    return initialDriver === 'hermes' ? '' : initialDriver
  }))
  let localCwd = $state(untrack(() => initial?.local_cwd ?? ''))
  let permissionMode = $state<PermissionMode>(untrack(() => initial?.permission_mode ?? 'default'))
  let roomIds = $state<string[]>(untrack(() => rooms.filter(room => room.type === 'public').map(room => room.id)))
  let localStatus = $state<LocalAgentStatus | null>(null)
  let error = $state('')
  let uploading = $state(false)
  let busy = $state(false)

  onMount(() => {
    void getLocalAgentStatus().then(status => { localStatus = status }).catch(() => {})
  })

  const apiMode = $derived<CreateBotRequest['mode']>(uiMode === 'hermes' ? 'bridge' : uiMode)
  const models = $derived(providers.find(item => item.id === provider)?.models ?? [])
  const localDriver = $derived<LocalDriverName>(
    driver === 'claude-code' || driver === 'antigravity' ? driver : 'codex',
  )
  const localDriverInfo = $derived(localStatus?.drivers[localDriver])
  const valid = $derived(
    uiMode === 'provider'
      ? Boolean(provider && model.trim())
      : uiMode === 'local'
        ? Boolean(isAdmin && (!localStatus || localStatus.enabled))
        : true,
  )

  const groupedRooms = $derived.by(() => {
    const known = new Set(folders.map(item => item.id))
    return folders.map((folder, index) => ({
      folder,
      items: rooms.filter(room => room.workspace_id === folder.id || (index === 0 && (!room.workspace_id || !known.has(room.workspace_id)))),
    })).filter(group => group.items.length > 0)
  })

  function onModeChange() {
    if (uiMode === 'local') {
      if (driver !== 'codex' && driver !== 'claude-code' && driver !== 'antigravity') driver = 'codex'
      if (!initial && providers.some(p => p.models.includes(model))) model = ''
    } else if (uiMode === 'hermes') {
      driver = 'hermes'
    } else if (uiMode === 'bridge') {
      if (driver === 'hermes') driver = ''
    } else if (uiMode === 'provider' && !model && providers.length) {
      model = providers.find(item => item.id === provider)?.models[0] ?? ''
    }
  }

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
      const settings = uiMode === 'provider'
        ? { provider_id: provider, model, system_prompt: prompt, temperature, context_limit: context }
        : uiMode === 'local'
          ? {
            driver_hint: localDriver,
            model: model.trim() || null,
            local_cwd: localCwd.trim() || null,
            permission_mode: permissionMode,
          }
          : uiMode === 'hermes'
            ? { driver_hint: 'hermes' as const }
            : { driver_hint: (driver && driver !== 'hermes' ? driver : null) }
      const bot = initial
        ? await api('/bots/' + initial.user_id, botSchema, 'PATCH', botPatchSchema.parse({ ...profile, ...settings }))
        : await api('/bots', botWriteResponseSchema, 'POST', botCreateSchema.parse({
          ...profile, ...settings, username: username.trim().toLowerCase(), mode: apiMode, channel_ids: roomIds,
        }))
      saved(bot)
    } catch (failure) { error = errorText(failure) } finally { busy = false }
  }
</script>

<form class="stack-form editor-card" onsubmit={submit}>
  <h3>{initial ? '编辑 ' + initial.user.display_name : template ? `创建 · ${template.label}` : '创建 Bot'}</h3>

  <label>模式
    <select bind:value={uiMode} disabled={Boolean(initial)} onchange={onModeChange}>
      <option value="local" disabled={!isAdmin || Boolean(localStatus && !localStatus.enabled)}>
        本机直连 Agent（免装 Bridge，直接调用服务器本机 codex / claude / agy）{!isAdmin ? ' · 仅管理员' : localStatus && !localStatus.enabled ? ' · 已关闭' : ''}
      </option>
      <option value="hermes">Hermes 原生接入（独立平台适配器，直接在 Hermes 中配置 Token 接入）</option>
      <option value="bridge">远程设备 Agent（通过 chior-bridge 从其他电脑或 Docker 宿主机接入）</option>
      <option value="provider">托管模型 Bot（通过 Provider API 调用）</option>
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

  {#if uiMode === 'provider'}
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
  {:else if uiMode === 'local'}
    <div class="form-row two">
      <label>本机 CLI 驱动
        <select bind:value={driver}>
          {#each localDriverSchema.options as item}
            {@const info = localStatus?.drivers[item]}
            <option value={item}>
              {item}{info ? (info.available ? ' · ✓ 已就绪' : ` · 未检测到 ${info.binary}`) : ''}
            </option>
          {/each}
        </select>
      </label>
      <label>执行权限模式
        <select bind:value={permissionMode}>
          <option value="default">default（默认工作区权限）</option>
          <option value="auto">auto（自动批准编辑与命令）</option>
          <option value="readonly">readonly（只读分析，禁止写入）</option>
        </select>
      </label>
    </div>

    {#if localStatus && localDriverInfo && !localDriverInfo.available}
      <p class="form-error" role="status">
        当前服务进程未检测到 <code>{localDriverInfo.binary}</code>（已自动扫描 PATH、<code>~/.local/bin</code>、<code>~/.bun/bin</code>、nvm 等目录）。如果 ChlorIM 运行在 <strong>Docker 容器</strong>中，容器看不到宿主机 CLI——请改用宿主机直跑 <code>chiorim-server</code> 二进制，或选择「远程设备 Agent」。
      </p>
    {:else if localStatus}
      <p class="muted break-text">
        服务端将在 <code>{localStatus.hostname}</code> 直接调用 <code>{localDriverInfo?.path ?? localDriverInfo?.binary ?? localDriver}</code>，无需安装 <code>chior-bridge</code>。
      </p>
    {/if}

    <div class="form-row two">
      <label>默认工作目录（可选）
        <input bind:value={localCwd} maxlength={4096} spellcheck={false}
          placeholder={localStatus?.default_cwd ?? '留空使用服务端默认目录'} />
      </label>
      <label>指定模型（可选）
        <input bind:value={model} maxlength={256} spellcheck={false} placeholder="留空使用 CLI 默认模型" />
      </label>
    </div>
  {:else if uiMode === 'hermes'}
    <p class="muted">
      Hermes 使用独立的原生平台插件（<code>packages/hermes-adapter</code>）接入，<strong>无需安装 <code>chior-bridge</code></strong>。创建后会签发一次性 <code>CHLORIM_BOT_TOKEN</code>，填进 <code>~/.hermes/.env</code> 并启用插件即可双向收发、流式回复与 Cron 主动推送。
    </p>
  {:else}
    <label>远程设备驱动类型
      <select bind:value={driver}>
        <option value="">默认（codex）</option>
        {#each bridgeDriverSchema.options as item}<option value={item}>{item}</option>{/each}
      </select>
    </label>
    <p class="muted">创建后会生成一次性 Token 与 <code>chior-bridge</code> 连接命令，适合接入另一台电脑或 Docker 宿主机上的 CLI Agent。</p>
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
