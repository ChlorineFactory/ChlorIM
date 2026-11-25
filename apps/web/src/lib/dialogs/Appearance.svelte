<script lang="ts">
  import { Bell, Moon, Sun, Volume2 } from 'lucide-svelte'
  import type { Workspace } from '$lib/stores/workspace.svelte'

  let { workspace }: { workspace: Workspace } = $props()
  const supported = typeof Notification !== 'undefined'
  let permission = $state<NotificationPermission>(supported ? Notification.permission : 'denied')

  async function toggleDesktop(checked: boolean) {
    if (!supported) return
    if (checked && permission !== 'granted') {
      permission = await Notification.requestPermission()
      if (permission !== 'granted') {
        workspace.setNotifyPrefs(false, workspace.soundNotify)
        workspace.toast('浏览器未授予桌面通知权限', 'error')
        return
      }
    }
    workspace.setNotifyPrefs(checked, workspace.soundNotify)
    workspace.toast(checked ? '已开启桌面消息提醒' : '已关闭桌面消息提醒', 'info')
  }

  function toggleSound(checked: boolean) {
    workspace.setNotifyPrefs(workspace.desktopNotify, checked)
  }
</script>

<div class="settings-section-stack">
  <section class="settings-card">
    <div class="settings-card-head">
      <h3>界面主题</h3>
      <p class="muted">即时切换，自动保存在当前浏览器。</p>
    </div>
    <div class="theme-cards">
      <button type="button" class="theme-card" class:active={workspace.theme === 'dark'}
        onclick={() => workspace.setTheme('dark')}>
        <Moon size={16} />
        <strong>深色</strong>
      </button>
      <button type="button" class="theme-card" class:active={workspace.theme === 'light'}
        onclick={() => workspace.setTheme('light')}>
        <Sun size={16} />
        <strong>浅色</strong>
      </button>
    </div>
  </section>

  <section class="settings-card">
    <div class="settings-card-head">
      <h3>消息提醒</h3>
      <p class="muted">当标签页处于后台时，对未静音频道的新消息发出提醒。</p>
    </div>
    <div class="pref-list">
      <label class="toggle-row">
        <span class="toggle-label">
          <Bell size={16} />
          <span>
            <strong>浏览器桌面通知</strong>
            <small>{!supported ? '当前浏览器不支持桌面通知' : permission === 'denied' ? '已在浏览器设置中拒绝通知权限' : '切到其他标签页时弹出系统通知'}</small>
          </span>
        </span>
        <input type="checkbox" checked={workspace.desktopNotify} disabled={!supported || permission === 'denied'}
          onchange={(e) => void toggleDesktop(e.currentTarget.checked)} />
      </label>

      <label class="toggle-row">
        <span class="toggle-label">
          <Volume2 size={16} />
          <span>
            <strong>轻柔提示音</strong>
            <small>收到未静音频道的新消息时播放轻提示音</small>
          </span>
        </span>
        <input type="checkbox" checked={workspace.soundNotify} onchange={(e) => toggleSound(e.currentTarget.checked)} />
      </label>
    </div>
  </section>
</div>
