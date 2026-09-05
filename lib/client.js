window.__ModuleLoader__.load({
	id: "@lim324/dsh-surface",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
// dsh-surface — client SOURCE (runs inside factory(require)).
// The loader wraps this body in window.__ModuleLoader__.load({ id, factory }),
// where `require` resolves React and the dsh client service table. This file is
// a build input; `lib/build.mjs` bundles it into lib/client.js.
const React = require('react')
const { Tooltip, IconNewChatOutline16 } = require('@deepseek-ai/dsh-client-ui-primitives')
const NS = 'surface'

// Keep the button visually identical to the chat's native icon action button
// (MessageIconActions `.action`): a 28×28 circular icon button with a hover
// background, so the surface action sits alongside the fork/branch icons.
const ACTION_CSS = '.dsh-surface-action{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:6px;border:none;border-radius:28px;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer}.dsh-surface-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}'

/** Inject the scoped action-button CSS once (mirrors the worktree-panel pattern). */
function ensureSurfaceCss() {
  if (typeof document === 'undefined') return
  if (document.querySelector('style[data-dsh-surface]') !== null) return
  const tag = document.createElement('style')
  tag.dataset.dshSurface = ''
  tag.textContent = ACTION_CSS
  document.head.appendChild(tag)
}

/** Icon button: "surface fork from this message's turn" (distinct from branch/fork). */
function SurfaceForkAction({ messageId, sessionId, surfaceFork, t }) {
  const label = t ? t('action') : '从此处继续新会话 (surface fork)'
  return React.createElement(
    Tooltip,
    { label, side: 'bottom' },
    React.createElement(
      'button',
      {
        type: 'button',
        className: 'dsh-surface-action',
        'aria-label': label,
        onClick: () => surfaceFork(sessionId, messageId),
        // Inline-lock the exact box the fork/branch button uses (28×28, padding 6,
        // no border, 28px radius) so the icon renders at the same size even if the
        // injected stylesheet has not applied. The class still supplies the
        // background/hover.
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: '28px',
          height: '28px',
          padding: '6px',
          border: 'none',
          borderRadius: '28px',
        },
      },
      React.createElement(IconNewChatOutline16, { size: 16 }),
    ),
  )
}

function apply(ctx) {
  ensureSurfaceCss()
  ctx.locale?.register(NS, {
    zh: {
      action: '从此处继续新会话 (surface fork)',
      label: 'surface',
      err: 'surface fork 失败：该会话尚未压缩',
    },
    en: {
      action: 'Continue this conversation in a new session (surface fork)',
      label: 'surface',
      err: 'surface fork failed: this conversation has not been compacted yet',
    },
  })

  const surfaceFork = async (sessionId, messageId) => {
    const res = await fetch('/api/dsh-surface/fork', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId, messageId }),
    })
    const data = await res.json()
    if (!res.ok || !data.ok) {
      const message = data?.message ?? 'surface fork failed'
      if (typeof window !== 'undefined') window.alert(message)
      throw new Error(message)
    }
    ctx.sessions.open(data.childId)
    return data.childId
  }

  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions',
    id: 'surface',
    order: 20,
    locale: NS,
    inject: () => ({ surfaceFork }),
  }, SurfaceForkAction))
}

module.exports = { name: 'dsh-surface', inject: ['slots', 'sessions', 'locale'], apply }

		return module.exports;
	}
});
