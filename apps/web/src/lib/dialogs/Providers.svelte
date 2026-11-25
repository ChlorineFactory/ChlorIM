<script lang="ts">
  import { onMount } from 'svelte'
  import { FlaskConical, Plus, Server, Trash2 } from 'lucide-svelte'
  import { providerCreateSchema, providerListSchema, providerPatchSchema, providerSchema, providerTestResponseSchema, providerTypeSchema } from '@chiorim/shared'
  import type { CreateProviderRequest, Provider } from '@chiorim/shared'
  import { api, errorText, remove } from '$lib/api'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace, admin }: { workspace: Workspace; admin: boolean } = $props()
  let providers = $state<Provider[]>([])
  let selected = $state<Provider | 'new' | null>(null)
  let type = $state<CreateProviderRequest['type']>('openai_compat')
  let name = $state('')
  let base = $state('')
  let key = $state('')
  let clearKey = $state(false)
  let models = $state('')
  let hermes = $state(false)
  let found = $state<string[]>([])
  let picked = $state<string[]>([])
  let busy = $state(false)
  let error = $state('')
  const parsedModels = $derived([...new Set(models.split(/[,\n]/).map(model => model.trim()).filter(Boolean))])

  async function action(task: () => Promise<unknown>) {
    busy = true
    error = ''
    try { await task() } catch (failure) { error = errorText(failure) } finally { busy = false }
  }

  onMount(() => { void action(async () => { providers = await api('/providers', providerListSchema) }) })

  function edit(provider: Provider | 'new' | null) {
    selected = provider
    const item = provider === 'new' ? null : provider
    type = item?.type ?? 'openai_compat'
    name = item?.name ?? ''
    base = item?.base_url ?? ''
    key = ''
    clearKey = false
    models = item?.models.join('\n') ?? ''
    hermes = item?.hermes_session_header ?? false
    found = []
    picked = []
    error = ''
  }

  async function save(event: SubmitEvent) {
    event.preventDefault()
    await action(async () => {
      const fields = {
        type, name, base_url: base.trim(), models: parsedModels, hermes_session_header: hermes,
        api_key: clearKey ? '' : key || undefined,
      }
      const existing = selected && selected !== 'new' ? selected : undefined
      const provider = existing
        ? await api('/providers/' + existing.id, providerSchema, 'PATCH', providerPatchSchema.parse(fields))
        : await api('/providers', providerSchema, 'POST', providerCreateSchema.parse(fields))
      providers = [...providers.filter(item => item.id !== provider.id), provider].sort((a, b) => a.name.localeCompare(b.name))
      edit(provider)
      workspace.toast('Provider 已保存', 'success')
    })
  }

  function testConnection() {
    if (!selected || selected === 'new') return
    const { id } = selected
    return action(async () => {
      const result = await api(`/providers/${id}/test`, providerTestResponseSchema, 'POST')
      found = [...new Set(result.models)]
      picked = found.filter(model => !parsedModels.includes(model))
      workspace.toast(found.length ? `连接成功，发现 ${found.length} 个模型` : '连接成功', 'success')
    })
  }

  function addModels() {
    models = [...new Set([...parsedModels, ...picked])].join('\n')
    picked = []
    workspace.toast('模型已加入表单，点「保存」生效', 'info')
  }

  async function deleteProvider(provider: Provider) {
    const ok = await workspace.confirm({
      title: `删除 ${provider.name}`,
      description: '使用该 Provider 的模型 Bot 将失去上游连接，需要重新绑定 Provider。',
      confirmLabel: '删除',
      danger: true,
    })
    if (!ok) return
    await action(async () => {
      await remove('/providers/' + provider.id)
      providers = providers.filter(item => item.id !== provider.id)
      edit(null)
      workspace.toast('Provider 已删除', 'info')
    })
  }
</script>

<div class="settings-section-stack">
  <div class="manager-toolbar">
    <span><Server size={16} /> 共 {providers.length} 个上游 Provider</span>
    {#if admin}
      <button class="button primary" type="button" disabled={busy} onclick={() => edit('new')}>
        <Plus size={15} /> 新增 Provider
      </button>
    {/if}
  </div>

  {#if error}<p class="form-error" role="alert">{error}</p>{/if}

  {#if selected && admin}
    <form class="stack-form editor-card" onsubmit={save}>
      <h3>{selected === 'new' ? '新增 Provider' : '编辑 ' + selected.name}</h3>
      <div class="form-row two">
        <label>名称<input bind:value={name} maxlength={100} required placeholder="例如：OpenRouter / 本地 Ollama / Hermes" /></label>
        <label>接口类型
          <select bind:value={type}>
            {#each providerTypeSchema.options as kind}<option value={kind}>{kind}</option>{/each}
          </select>
        </label>
      </div>
      <label>Base URL<input type="url" bind:value={base} placeholder="https://api.openai.com/v1" required /></label>
      <label>API Key
        <input type="password" bind:value={key} autocomplete="off" disabled={clearKey}
          placeholder={selected !== 'new' && selected.has_api_key ? '留空则保留现有密钥' : '按上游配置填写（本地 Ollama 可留空）'} />
      </label>
      {#if selected !== 'new' && selected.has_api_key}
        <label class="check-row"><input type="checkbox" bind:checked={clearKey} /> 清除已保存的密钥</label>
      {/if}
      <label class="check-row"><input type="checkbox" bind:checked={hermes} /> 附带 X-Hermes-Session-Id（接入 Hermes API Server 时开启）</label>
      <label>常用模型<textarea bind:value={models} rows="3" placeholder="每行一个模型 ID，保存后也可点击下方按钮自动拉取"></textarea></label>

      {#if found.length}
        <fieldset class="choice-list"><legend>拉取到的上游模型（{found.length}）</legend>
          {#each found as model (model)}
            <label class="check-row">
              <input type="checkbox" value={model} bind:group={picked} disabled={parsedModels.includes(model)} />
              <span>{model}</span>{#if parsedModels.includes(model)}<small>已加入</small>{/if}
            </label>
          {/each}
          <button class="button quiet compact" type="button" disabled={!picked.length} onclick={addModels}>加入已选模型</button>
        </fieldset>
      {/if}

      <div class="dialog-actions">
        {#if selected !== 'new'}
          <button class="button quiet push-right" type="button" disabled={busy} onclick={testConnection} title="测试已保存的配置">
            <FlaskConical size={15} /> 测试连接并拉取模型
          </button>
        {/if}
        <button class="button quiet" type="button" disabled={busy} onclick={() => edit(null)}>取消</button>
        <button class="button primary" type="submit" disabled={busy}>保存</button>
      </div>
    </form>
  {/if}

  <div class="manage-list">
    {#each providers as provider (provider.id)}
      <article class="manage-card">
        <div class="manage-card-top"><strong>{provider.name}</strong><code>{provider.type}</code></div>
        <p class="muted break-text">{provider.base_url}</p>
        <p class="muted">密钥：{provider.has_api_key ? provider.api_key_masked : '未配置'} · Hermes 会话头：{provider.hermes_session_header ? '开启' : '关闭'}</p>
        {#if provider.models.length}
          <div class="model-tags">{#each provider.models as model}<code>{model}</code>{/each}</div>
        {/if}
        {#if admin}
          <div class="row-actions">
            <button class="button quiet compact" type="button" disabled={busy} onclick={() => edit(provider)}>编辑</button>
            <button class="icon-button danger-on-hover" type="button" title="删除 Provider" aria-label={'删除 ' + provider.name}
              disabled={busy} onclick={() => void deleteProvider(provider)}><Trash2 size={15} /></button>
          </div>
        {/if}
      </article>
    {:else}
      <p class="muted">暂无 Provider。{admin ? '点击右上角添加一个模型提供商即可创建模型 Bot。' : '请联系管理员配置上游模型提供商。'}</p>
    {/each}
  </div>
</div>
