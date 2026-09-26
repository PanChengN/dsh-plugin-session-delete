/**
 * 客户端半：向 `sidebar.workspaces.session.menu.item` 座位注册一行「删除会话」。
 *
 * 该座位由 `@deepseek-ai/dsh-client-ui-workspace` 声明，行组件收到的 props 来自
 * 两级 inject：座位声明的 `hooks.menuOpenState`（→ `useMenuOpenState`）、
 * 渲染时传入的 `sessionId` / `displayTitle`。
 *
 * 样式按宿主 `Menu.module.css` 的 `.item` / `.danger` 取值复制，只用主题 token，
 * 不 import 任何 Harness 客户端包。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-bundle-session-delete',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const SLOT = 'sidebar.workspaces.session.menu.item'
    const STYLE_ID = 'dsh-session-delete-style'
    const ENDPOINT = '/api/dsh-session-delete'

    /** `apply` 里的 Client Cordis 上下文，供菜单点击后定位会话列表服务。 */
    let pluginCtx = null

    // 取自 ui-primitives 的 Menu.module.css：`.item`、`.itemIcon`、`.itemLabel`、`.danger`。
    const CSS = [
      '.dsh-sd-wrap{position:relative}',
      '.dsh-sd-item{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;',
      'padding:6px 8px;border:none;border-radius:var(--dsw-radius-md);background:transparent;',
      'cursor:pointer;font-size:13px;line-height:20px;font-family:inherit;text-align:left;',
      'color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sd-item:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}',
      '.dsh-sd-item:focus-visible{background:var(--dsw-alias-interactive-bg-hover-danger);outline:none}',
      '.dsh-sd-icon{display:inline-flex;flex:none;width:14px;height:14px;align-items:center;',
      'justify-content:center;color:var(--dsw-alias-state-error-primary)}',
      '.dsh-sd-icon svg{width:14px;height:14px}',
      '.dsh-sd-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    ].join('')

    function TrashIcon() {
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          'aria-hidden': 'true',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        },
        h('path', { d: 'M3 4.6h10' }),
        h('path', { d: 'M6.4 4.6V3.3c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.3' }),
        h('path', { d: 'M5 4.6l.5 8.1c0 .4.3.7.7.7h3.6c.4 0 .7-.3.7-.7L11 4.6' }),
        h('path', { d: 'M6.8 7.1v4M9.2 7.1v4' }),
      )
    }

    async function removeSession(sessionId, title) {
      const label = typeof title === 'string' && title.length > 0 ? title : sessionId
      const confirmed = window.confirm(
        `删除会话「${label}」？\n\n会话记录、派生缓存与侧栏条目都会被永久删除，无法撤销。\n请勿删除当前正在进行中的对话。`,
      )
      if (!confirmed) return
      let payload = null
      try {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          cache: 'no-store',
          body: JSON.stringify({ sessionId }),
        })
        payload = await response.json().catch(() => null)
        if (!response.ok || payload === null || payload.ok !== true) {
          throw new Error((payload && payload.error) || `HTTP ${response.status}`)
        }
      } catch (error) {
        window.alert(`删除失败：${error instanceof Error ? error.message : String(error)}`)
        return
      }
      void settleRemovedRow(pluginCtx, sessionId)
    }

    /**
     * 删完之后让侧栏那一行安静地消失，不重载页面。
     *
     * 主机在删除成功后会发 `api-session/removed`，客户端 ClientSessions 收到就把该 id
     * 从列表快照里移除，侧栏对没有 summary 的 id 直接跳过 —— 正常情况下几百毫秒内行就没了。
     * 只有当这条通路没生效（该 id 仍在快照里）时，才退一步重新拉取一次列表基线。
     */
    async function settleRemovedRow(ctx, sessionId) {
      if (ctx === null || ctx === undefined) return
      const sessions = ctx.get('sessions')
      if (sessions === undefined || typeof sessions.list?.getSnapshot !== 'function') return
      const stillListed = () => {
        const snapshot = sessions.list.getSnapshot()
        return Array.isArray(snapshot?.ids) && snapshot.ids.includes(sessionId)
      }
      const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
      await sleep(400)
      if (!stillListed()) return
      try {
        await sessions.refresh?.()
      } catch {
        return
      }
      // 仍未消失时不强行重载：留给用户自己刷新，避免整页闪一下。
    }

    function DeleteSessionMenuItem(props) {
      const sessionId = props.sessionId
      const displayTitle = props.displayTitle
      const useMenuOpenState = props.useMenuOpenState
      const closeMenu = typeof useMenuOpenState === 'function' ? useMenuOpenState()[1] : () => {}
      return h(
        'div',
        { className: 'dsh-sd-wrap' },
        h(
          'button',
          {
            type: 'button',
            role: 'menuitem',
            className: 'dsh-sd-item',
            onClick: () => {
              closeMenu(false)
              void removeSession(sessionId, displayTitle)
            },
          },
          h('span', { className: 'dsh-sd-icon' }, h(TrashIcon)),
          h('span', { className: 'dsh-sd-label' }, '删除会话'),
        ),
      )
    }

    return {
      name: 'session-delete',
      // 只硬依赖 slots：菜单项必须在任何情况下都能出现。
      // `sessions` 服务改为点击时惰性获取，避免它对未就绪的服务形成阻塞依赖。
      inject: ['slots'],
      apply(ctx) {
        pluginCtx = ctx
        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = CSS
          document.head.append(style)
          return () => style.remove()
        })
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: 'session-delete',
              order: 500,
            },
            DeleteSessionMenuItem,
          ),
        )
      },
    }
  },
})
