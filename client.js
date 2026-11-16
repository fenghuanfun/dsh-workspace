/**
 * Browser half of the `dsh-workspace` bundle.
 *
 * Adds one row to a workspace's "..." / right-click menu that opens a dialog for
 * adding and removing the workspace's additional source directories. The Host
 * owns validation and durability; this module only keeps the open dialog's
 * draft list and talks to the two fenced routes.
 */

window.__ModuleLoader__.load({
  id: 'dsh-workspace',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    const NS = 'dsh-workspace'
    const LIST_ROUTE = 'dsh-workspace/list'
    const SET_ROUTE = 'dsh-workspace/set'
    const MENU_KEY = 'dsh-workspace.edit'
    const OVERLAY_ID = 'dsh-workspace.dialog'

    const zh = {
      'menu.edit': '源目录',
      'dialog.note': '与原目录同权限',
      'dialog.add': '添加',
      'dialog.remove': '移除',
      'dialog.empty': '尚无其他源目录',
      'dialog.loading': '读取中…',
      'dialog.retry': '重试',
      'dialog.saving': '保存中…',
      'dialog.saved': '已保存',
      'dialog.saved.empty': '已清空',
      'dialog.duplicate': '已在列表中',
      'dialog.cancel': '取消',
      'dialog.save': '保存',
      'dialog.unavailable': '已不存在',
      'dialog.failed.load': '读取失败',
      'dialog.failed.save': '保存失败',
      'dialog.failed.pick': '选择失败',
    }
    const en = {
      'menu.edit': 'Source directories',
      'dialog.note': 'Same permissions as the workspace directory',
      'dialog.add': 'Add',
      'dialog.remove': 'Remove',
      'dialog.empty': 'No extra source directories',
      'dialog.loading': 'Reading…',
      'dialog.retry': 'Retry',
      'dialog.saving': 'Saving…',
      'dialog.saved': 'Saved',
      'dialog.saved.empty': 'Cleared',
      'dialog.duplicate': 'Already listed',
      'dialog.cancel': 'Cancel',
      'dialog.save': 'Save',
      'dialog.unavailable': 'Missing',
      'dialog.failed.load': 'Read failed',
      'dialog.failed.save': 'Save failed',
      'dialog.failed.pick': 'Pick failed',
    }

    const CSS = `
.dsw-layer{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;pointer-events:none}
.dsw-backdrop{position:absolute;inset:0;background:rgba(12,15,20,.38);pointer-events:auto}
.dsw-card{position:relative;pointer-events:auto;display:flex;flex-direction:column;width:min(560px,calc(100vw - 48px));max-height:min(72vh,560px);background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:14px;box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden;font-size:13px;line-height:1.5}
.dsw-card:focus{outline:none}
.dsw-head{padding:16px 18px 10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsw-title{margin:0;font-size:14px;font-weight:600}
.dsw-sub{margin:4px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px;word-break:break-all}
.dsw-note{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsw-body{flex:1 1 auto;min-height:56px;overflow-y:auto;padding:8px 10px}
.dsw-empty{margin:14px 8px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsw-row{display:flex;align-items:center;gap:10px;padding:7px 8px;border-radius:8px}
.dsw-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dsw-info{min-width:0;flex:1 1 auto}
.dsw-name{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-path{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsw-warn{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.dsw-btn{font:inherit;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:0 10px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}
.dsw-btn:hover{background:var(--dsw-alias-bg-layer-2)}
.dsw-btn:disabled{opacity:.5;cursor:default}
.dsw-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dsw-btn-quiet{color:var(--dsw-alias-label-secondary)}
.dsw-btn-outline{border-color:var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.dsw-btn-primary{background:var(--dsw-alias-brand-primary);color:#fff}
.dsw-btn-primary:hover{background:var(--dsw-alias-brand-primary);filter:brightness(1.06)}
.dsw-btn-danger{color:var(--dsw-alias-state-error-primary)}
.dsw-foot{display:flex;align-items:center;gap:8px;padding:10px 18px 14px;border-top:1px solid var(--dsw-alias-border-l1)}
.dsw-spacer{flex:1 1 auto}
.dsw-error{display:flex;align-items:center;gap:8px;padding:8px 18px 0;color:var(--dsw-alias-state-error-primary);font-size:12px}
.dsw-status{padding:0 18px 6px;color:var(--dsw-alias-label-secondary);font-size:12px}
`

    /** Base name of an absolute path, used as the row label. */
    function baseName(path) {
      const parts = path.split('/').filter(Boolean)
      return parts.length === 0 ? path : parts[parts.length - 1]
    }

    /** Two path lists are equal when they hold the same order of the same paths. */
    function samePaths(left, right) {
      return left.length === right.length && left.every((path, index) => path === right[index])
    }

    /** The dialog's single source of truth, shared by the menu action and the overlay entry. */
    function createDialogStore() {
      let state = {
        open: false,
        workspace: null,
        loading: false,
        loaded: false,
        picking: false,
        busy: false,
        dirs: [],
        draft: [],
        error: null,
      }
      const listeners = new Set()
      return {
        get: () => state,
        set(patch) {
          state = { ...state, ...patch }
          for (const listener of [...listeners]) listener()
        },
        subscribe(listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
      }
    }

    /** Read one route; refuses with the Host's own reason. */
    async function requestJson(path, init) {
      const response = await fetch(path, init)
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.message ?? `HTTP ${String(response.status)}`)
      return payload
    }

    /** Normalize one route's directory rows. */
    function toRows(payload) {
      if (!Array.isArray(payload?.dirs)) return null
      return payload.dirs
        .filter(entry => typeof entry?.path === 'string' && entry.path !== '')
        .map(entry => ({ path: entry.path, available: entry.available !== false }))
    }

    /** Subscribe a component to the dialog store. */
    function useDialog(store) {
      const [, bump] = useState(0)
      useEffect(() => store.subscribe(() => bump(value => value + 1)), [store])
      return store.get()
    }

    /** Re-render on a locale change so every visible label follows the active language. */
    function useLocale(locale) {
      const [, bump] = useState(0)
      useEffect(() => {
        const dispose = locale.subscribe(() => bump(value => value + 1))
        return typeof dispose === 'function' ? dispose : () => {}
      }, [locale])
    }

    return {
      inject: ['slots', 'locale', 'contextMenus', 'uiWorkspace'],
      apply(ctx) {
        const store = createDialogStore()
        const t = ctx.locale.bind(NS)
        const translate = (key) => t(key)
        let restoreFocus = null
        /** Request generation: a stale answer never overwrites a newer workspace. */
        let loadEpoch = 0
        let loadAbort = null

        const fail = (prefix, error) => `${t(prefix)}: ${error instanceof Error ? error.message : String(error)}`

        const load = async (workspace) => {
          const epoch = ++loadEpoch
          if (loadAbort !== null) loadAbort.abort()
          const controller = new AbortController()
          loadAbort = controller
          store.set({ loading: true, loaded: false, error: null })
          try {
            const payload = await requestJson(`${LIST_ROUTE}?workspace=${encodeURIComponent(workspace)}`, {
              headers: { accept: 'application/json' },
              signal: controller.signal,
            })
            if (epoch !== loadEpoch) return
            const dirs = toRows(payload)
            if (dirs === null) throw new Error('the response holds no directory list')
            store.set({
              loading: false,
              loaded: true,
              workspace: typeof payload?.workspace === 'string' ? payload.workspace : workspace,
              dirs,
              draft: dirs.map(entry => entry.path),
            })
          } catch (error) {
            if (epoch !== loadEpoch || controller.signal.aborted) return
            store.set({ loading: false, loaded: false, error: fail('dialog.failed.load', error) })
          }
        }

        const openDialog = (workspacePath) => {
          restoreFocus = typeof document === 'undefined' ? null : document.activeElement
          store.set({
            open: true,
            workspace: workspacePath,
            loading: true,
            loaded: false,
            picking: false,
            busy: false,
            dirs: [],
            draft: [],
            error: null,
          })
          void load(workspacePath)
        }

        const closeDialog = () => {
          if (store.get().busy) return
          loadEpoch += 1
          if (loadAbort !== null) {
            loadAbort.abort()
            loadAbort = null
          }
          store.set({ open: false, picking: false, error: null })
          if (restoreFocus instanceof HTMLElement) restoreFocus.focus()
          restoreFocus = null
        }

        /** Append one picked directory to the draft list. */
        const add = async () => {
          const before = store.get()
          if (before.busy || before.picking || before.loading || !before.loaded) return
          store.set({ picking: true, error: null })
          let picked
          try {
            picked = await ctx.uiWorkspace.pickDirectory()
          } catch (error) {
            store.set({ picking: false, error: fail('dialog.failed.pick', error) })
            return
          }
          const after = store.get()
          if (!after.open || after.workspace !== before.workspace) {
            store.set({ picking: false })
            return
          }
          store.set({ picking: false })
          if (typeof picked !== 'string' || picked === '') return
          if (after.draft.includes(picked)) {
            store.set({ error: t('dialog.duplicate') })
            return
          }
          store.set({ draft: [...after.draft, picked] })
        }

        const removeAt = (index) => {
          const current = store.get()
          if (current.busy || current.picking) return
          const draft = [...current.draft]
          draft.splice(index, 1)
          store.set({ draft, error: null })
        }

        const save = async () => {
          const current = store.get()
          if (current.busy || current.picking || current.loading || !current.loaded) return
          if (current.workspace === null) return
          if (samePaths(current.draft, current.dirs.map(entry => entry.path))) return
          store.set({ busy: true, error: null })
          try {
            const payload = await requestJson(SET_ROUTE, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ workspace: current.workspace, dirs: current.draft }),
            })
            const dirs = toRows(payload) ?? []
            store.set({ busy: false, open: false, loaded: true, dirs, draft: dirs.map(entry => entry.path) })
            if (typeof ctx.contextMenus.notify === 'function') {
              ctx.contextMenus.notify(dirs.length === 0 ? t('dialog.saved.empty') : t('dialog.saved'), true)
            }
            if (restoreFocus instanceof HTMLElement) restoreFocus.focus()
            restoreFocus = null
          } catch (error) {
            store.set({ busy: false, error: fail('dialog.failed.save', error) })
          }
        }

        /** Small pencil glyph rendered inside the shared context-menu icon cell. */
        function MenuIcon() {
          return h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, focusable: 'false' },
            h('path', {
              d: 'M2 4.5A1.5 1.5 0 0 1 3.5 3h3a.75.75 0 0 1 0 1.5h-3v8h8v-3a.75.75 0 0 1 1.5 0v3A1.5 1.5 0 0 1 11.5 14h-8A1.5 1.5 0 0 1 2 12.5v-8Z',
              fill: 'currentColor',
            }),
            h('path', {
              d: 'M12.4 1.9a1.9 1.9 0 0 1 2.7 2.7l-5.6 5.6-3 .6.6-3 5.3-5.9Z',
              fill: 'currentColor',
            }))
        }

        /** The management dialog: one row per additional source directory. */
        function SourceDirsDialog() {
          const state = useDialog(store)
          useLocale(ctx.locale)
          const cardRef = useRef(null)

          useEffect(() => {
            if (!state.open) return undefined
            const onKeyDown = (event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                closeDialog()
                return
              }
              if (event.key !== 'Tab') return
              const card = cardRef.current
              if (card === null) return
              const focusable = [...card.querySelectorAll('button:not([disabled]),[href],input,select,textarea')]
              if (focusable.length === 0) {
                // Every control is disabled while saving: keep the focus inside
                // the dialog instead of letting Tab reach the page behind it.
                event.preventDefault()
                card.focus()
                return
              }
              const first = focusable[0]
              const last = focusable[focusable.length - 1]
              if (event.shiftKey && (document.activeElement === first || document.activeElement === card)) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }
            document.addEventListener('keydown', onKeyDown, true)
            return () => { document.removeEventListener('keydown', onKeyDown, true) }
          }, [state.open])

          // Land on the dialog once per opening; a later load never steals focus.
          useEffect(() => {
            if (!state.open) return
            const card = cardRef.current
            if (card !== null) card.focus()
          }, [state.open])

          if (!state.open) return null

          const blocked = state.busy || state.picking || state.loading || !state.loaded
          const dirty = !samePaths(state.draft, state.dirs.map(entry => entry.path))

          const rows = state.draft.map((path, index) => {
            const known = state.dirs.find(entry => entry.path === path)
            const unavailable = known !== undefined && known.available === false
            const name = baseName(path)
            return h('div', { className: 'dsw-row', key: `${String(index)}:${path}` },
              h('div', { className: 'dsw-info' },
                h('div', { className: 'dsw-name' }, name),
                h('div', { className: 'dsw-path', title: path }, path),
                unavailable && h('div', { className: 'dsw-warn' }, t('dialog.unavailable'))),
              h('button', {
                type: 'button',
                className: 'dsw-btn dsw-btn-quiet dsw-btn-danger',
                disabled: blocked,
                'aria-label': `${t('dialog.remove')}: ${name}`,
                onClick: () => { removeAt(index) },
              }, t('dialog.remove')))
          })

          const head = h('div', { className: 'dsw-head', key: 'head' },
            h('h2', { className: 'dsw-title' }, translate('menu.edit')),
            h('p', { className: 'dsw-sub' }, state.workspace ?? ''),
            h('p', { className: 'dsw-note' }, t('dialog.note')))

          const errorLine = state.error === null ? null : h('div', { className: 'dsw-error', role: 'alert', key: 'error' },
            h('span', null, state.error),
            state.loaded === false && !state.loading && state.workspace !== null && h('button', {
              type: 'button',
              className: 'dsw-btn dsw-btn-quiet',
              onClick: () => { void load(state.workspace) },
            }, t('dialog.retry')))

          const loadingLine = state.loading
            ? h('div', { className: 'dsw-status', role: 'status', key: 'loading' }, t('dialog.loading'))
            : null

          const body = h('div', { className: 'dsw-body', key: 'body' },
            state.loaded && state.draft.length === 0
              ? h('p', { className: 'dsw-empty' }, t('dialog.empty'))
              : rows)

          const foot = h('div', { className: 'dsw-foot', key: 'foot' },
            h('button', {
              type: 'button',
              className: 'dsw-btn dsw-btn-outline',
              disabled: blocked,
              onClick: () => { void add() },
            }, t('dialog.add')),
            h('div', { className: 'dsw-spacer' }),
            h('button', {
              type: 'button',
              className: 'dsw-btn',
              disabled: state.busy,
              onClick: closeDialog,
            }, t('dialog.cancel')),
            h('button', {
              type: 'button',
              className: 'dsw-btn dsw-btn-primary',
              disabled: blocked || !dirty,
              onClick: () => { void save() },
            }, t('dialog.save')))

          const card = h('div', {
            key: 'card',
            className: 'dsw-card',
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': translate('menu.edit'),
            'aria-busy': state.busy,
            tabIndex: -1,
            ref: cardRef,
          }, [
            head,
            errorLine,
            loadingLine,
            body,
            state.busy && h('div', { className: 'dsw-status', role: 'status', key: 'saving' }, t('dialog.saving')),
            foot,
          ])

          return h('div', { className: 'dsw-layer' }, [
            h('style', { key: 'style' }, CSS),
            h('div', { className: 'dsw-backdrop', onClick: closeDialog, key: 'backdrop' }),
            card,
          ])
        }

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-workspace: dictionaries')

        ctx.effect(() => ctx.contextMenus.register({
          id: 'dsh-workspace',
          target: 'workspace',
          order: 200,
          resolve: ({ path }) => [{
            id: 'source-directories',
            label: translate('menu.edit'),
            icon: { key: MENU_KEY },
            run: () => { openDialog(path) },
          }],
        }), 'dsh-workspace: workspace menu action')

        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon', key: MENU_KEY,
        }, MenuIcon))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay', id: OVERLAY_ID, order: 60,
        }, SourceDirsDialog))

        ctx.effect(() => () => {
          loadEpoch += 1
          if (loadAbort !== null) loadAbort.abort()
          loadAbort = null
          store.set({ open: false, picking: false })
          restoreFocus = null
        }, 'dsh-workspace: dialog teardown')
      },
    }
  },
})
