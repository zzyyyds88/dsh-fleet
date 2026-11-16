/**
 * Browser half of `@local/dsh-fleet`.
 *
 * It adds two surfaces and nothing else:
 *
 * - **Settings › Remote nodes** — a full section page that lists this machine and
 *   every configured remote node, and owns the add/edit form.
 * - **A Remote nodes panel** — a sidebar panel icon plus its main-column page, so
 *   the fleet is reachable without opening Settings.
 *
 * What it deliberately does *not* do is present remote machines as separate
 * places to visit. A connected node's workspaces and sessions are merged into the
 * ordinary sidebar by the Host half, so opening a remote project is the same
 * gesture as opening a local one. This surface only manages the connections.
 *
 * @module @local/dsh-fleet/client
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-fleet',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Where the Host half answers management calls. */
    const API = 'fleet/api'

    /** Bilingual copy chosen once from the document language. */
    const zh = (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase().startsWith('zh')
    const T = zh
      ? {
          title: '远程节点',
          sectionTitle: '远程节点',
          subtitle: '在另一台机器上运行 DeepSeek Harness。已连接节点的工作区会直接出现在侧栏里。',
          local: '本机',
          localHint: '你正在使用的这一个 Harness。它的会话、工作区与工具都留在本地。',
          remote: '远程',
          remoteHint: '每个节点运行自己的 Harness。会话、文件与工具执行都在那台机器上。',
          add: '添加节点',
          edit: '编辑',
          remove: '移除',
          cancel: '取消',
          save: '保存',
          connect: '连接',
          disconnect: '断开',
          retry: '重试',
          connecting: '连接中',
          connected: '已连接',
          idle: '未连接',
          failed: '连接失败',
          name: '名称',
          host: '主机',
          port: '端口',
          username: '用户名',
          auth: '认证方式',
          password: '密码',
          privateKey: '私钥',
          privateKeyHint: '粘贴 OpenSSH 私钥，以 -----BEGIN 开头。',
          passphrase: '私钥口令（可选）',
          advanced: '高级选项',
          remoteRoot: '远端安装目录',
          autoConnect: '应用启动时自动连接',
          empty: '还没有远程节点。点「添加节点」接入一台机器。',
          errorTitle: '无法连接',
          removeConfirm: '移除这个节点？它在那台机器上的会话不会被删除。',
          workspaces: '工作区',
          workspacesHint: '已连接的节点把它自己的工作区并入左侧列表，不需要单独打开。',
          noWorkspaces: '这个节点还没有工作区。在下面填一个它上面的绝对路径即可加入。',
          addWorkspace: '加入工作区',
          pathPlaceholder: '这个节点上的绝对路径，例如 /root/project',
          phases: {
            probe: '正在识别远端环境',
            install: '正在安装远端 Harness',
            provision: '正在下发模型与凭据',
            start: '正在启动远端服务',
            verify: '正在验证远端会话通道',
          },
          missingSecret: '还没有保存密码或私钥。',
        }
      : {
          title: 'Remote nodes',
          sectionTitle: 'Remote nodes',
          subtitle: 'Run DeepSeek Harness on another machine. A connected node\'s workspaces appear in the sidebar itself.',
          local: 'This machine',
          localHint: 'The Harness you are using right now. Its sessions, workspaces and tools stay local.',
          remote: 'Remote',
          remoteHint: 'Each node runs its own Harness. Its sessions, files and tool execution live on that machine.',
          add: 'Add node',
          edit: 'Edit',
          remove: 'Remove',
          cancel: 'Cancel',
          save: 'Save',
          connect: 'Connect',
          disconnect: 'Disconnect',
          retry: 'Retry',
          connecting: 'Connecting',
          connected: 'Connected',
          idle: 'Not connected',
          failed: 'Connection failed',
          name: 'Name',
          host: 'Host',
          port: 'Port',
          username: 'Username',
          auth: 'Authentication',
          password: 'Password',
          privateKey: 'Private key',
          privateKeyHint: 'Paste the OpenSSH private key, beginning with -----BEGIN.',
          passphrase: 'Passphrase (optional)',
          advanced: 'Advanced options',
          remoteRoot: 'Remote install directory',
          autoConnect: 'Connect automatically when the app starts',
          empty: 'No remote nodes yet. Add one to connect a machine.',
          errorTitle: 'Could not connect',
          removeConfirm: 'Remove this node? Its sessions on the remote machine are not deleted.',
          workspaces: 'Workspaces',
          workspacesHint: 'A connected node merges its own workspaces into the left list; there is nothing to open separately.',
          noWorkspaces: 'This node has no workspaces yet. Enter an absolute path on it below to add one.',
          addWorkspace: 'Add workspace',
          pathPlaceholder: 'An absolute path on this node, e.g. /root/project',
          phases: {
            probe: 'Identifying the remote environment',
            install: 'Installing the remote Harness',
            provision: 'Sending models and credentials',
            start: 'Starting the remote service',
            verify: 'Verifying the remote session channel',
          },
          missingSecret: 'No password or private key is stored yet.',
        }

    /** Token-driven styles so light and dark both work. */
    const styles = {
      page: { padding: '24px 28px', maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 24 },
      h1: { fontSize: 20, fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
      subtitle: { margin: '6px 0 0', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      groupHeader: { display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 8 },
      groupTitle: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)', margin: 0 },
      groupHint: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', margin: 0 },
      list: { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, overflow: 'hidden' },
      row: {
        display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', minHeight: 52,
        borderTop: '1px solid var(--dsw-alias-border-l1)',
      },
      rowFirst: { borderTop: 'none' },
      dot: size => ({ width: size ?? 8, height: size ?? 8, borderRadius: '50%', flex: '0 0 auto' }),
      name: { fontSize: 14, color: 'var(--dsw-alias-label-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      meta: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      grow: { flex: '1 1 auto', minWidth: 0 },
      button: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        background: 'transparent', color: 'var(--dsw-alias-label-primary)', fontSize: 12,
        padding: '5px 12px', cursor: 'pointer', lineHeight: 1.4,
      },
      buttonPrimary: {
        appearance: 'none', border: '1px solid transparent', borderRadius: 8,
        background: 'var(--dsw-alias-brand-primary)', color: '#fff', fontSize: 12,
        padding: '5px 12px', cursor: 'pointer', lineHeight: 1.4,
      },
      buttonDanger: {
        appearance: 'none', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8,
        background: 'transparent', color: 'var(--dsw-alias-state-error-primary)', fontSize: 12,
        padding: '5px 12px', cursor: 'pointer', lineHeight: 1.4,
      },
      buttonDisabled: { opacity: 0.55, cursor: 'default' },
      errorBar: {
        margin: '0 14px 10px', padding: '8px 10px', borderRadius: 8,
        background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent)',
        color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
      },
      form: { display: 'flex', flexDirection: 'column', gap: 14, padding: 16, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 6 },
      label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      input: {
        width: '100%', boxSizing: 'border-box', padding: '7px 10px', fontSize: 13,
        color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, outline: 'none',
      },
      rowFields: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 96px', gap: 10 },
      actions: { display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' },
      link: {
        appearance: 'none', border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
        fontSize: 12, color: 'var(--dsw-alias-label-secondary)', textDecoration: 'underline',
      },
      phases: { display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 0 10px 26px' },
      phase: active => ({
        fontSize: 12, color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
        fontWeight: active ? 600 : 400,
      }),
      empty: { padding: '18px 14px', fontSize: 13, color: 'var(--dsw-alias-label-secondary)' },
      workspaceRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      addWorkspace: { display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px', borderTop: '1px solid var(--dsw-alias-border-l1)' },
      mono: { fontFamily: 'var(--dsw-alias-font-code, ui-monospace, monospace)', fontSize: 11, color: 'var(--dsw-alias-label-secondary)' },
    }

    /** Fetch JSON from the fleet API, surfacing the server's routable error. */
    async function api(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      })
      const text = await response.text()
      const body = text.length === 0 ? {} : JSON.parse(text)
      if (!response.ok || body.ok === false) {
        throw Object.assign(new Error(body.error ?? `HTTP ${String(response.status)}`), {
          code: body.code ?? 'fleet-failed',
        })
      }
      return body
    }

    const STATE_COLOR = {
      connected: 'var(--dsw-alias-state-success-primary)',
      connecting: 'var(--dsw-alias-brand-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      idle: 'var(--dsw-alias-state-idle-primary)',
    }

    function stateLabel(node) {
      if (node.state === 'connected') return T.connected
      if (node.state === 'connecting') return T.connecting
      if (node.state === 'failed') return T.failed
      return T.idle
    }

    /** One phase timeline while a node connects. */
    function PhaseList({ phase }) {
      const order = ['probe', 'install', 'provision', 'start', 'verify']
      const at = order.indexOf(phase ?? '')
      return h('div', { style: styles.phases },
        order.map((id, index) => h('div', { key: id, style: styles.phase(index === at) }, T.phases[id] ?? id)))
    }

    /** Add one directory on a node as a workspace. */
    function AddWorkspace({ nodeId, onAdded }) {
      const [path, setPath] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(undefined)
      const submit = async event => {
        event.preventDefault()
        if (path.trim().length === 0) return
        setBusy(true)
        setError(undefined)
        try {
          await api('/workspaces', { method: 'POST', body: JSON.stringify({ nodeId, path: path.trim() }) })
          setPath('')
          await onAdded()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }
      return h('form', { style: styles.addWorkspace, onSubmit: submit },
        h('input', {
          style: { ...styles.input, flex: '1 1 auto' },
          placeholder: T.pathPlaceholder,
          value: path,
          onChange: event => setPath(event.target.value),
        }),
        h('button', {
          type: 'submit',
          style: { ...styles.buttonPrimary, ...(busy ? styles.buttonDisabled : {}) },
          disabled: busy,
        }, T.addWorkspace),
        error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0, width: '100%' } }, error) : null)
    }

    /** The remote workspaces one node currently contributes. */
    function NodeWorkspaces({ nodeId, workspaces, onAdded }) {
      return h('div', null,
        workspaces.length === 0
          ? h('div', { style: styles.workspaceRow }, h('span', { style: styles.meta }, T.noWorkspaces))
          : workspaces.map((workspace, index) => h('div', {
              key: workspace.workspaceId,
              style: { ...styles.workspaceRow, ...(index === 0 ? { borderTop: 'none' } : {}) },
            },
            h('span', { style: { ...styles.dot(6), background: 'var(--dsw-alias-brand-primary)' }, 'aria-hidden': true }),
            h('div', { style: styles.grow },
              h('div', { style: styles.name }, workspace.title ?? workspace.path),
              h('div', { style: styles.mono }, workspace.path)))),
        h(AddWorkspace, { nodeId, onAdded }))
    }

    /** One remote node row. */
    function NodeRow({ node, first, workspaces, onAction, onEdit, onRefresh }) {
      const [busy, setBusy] = useState(false)
      const [confirming, setConfirming] = useState(false)
      const [expanded, setExpanded] = useState(false)
      const connected = node.state === 'connected'
      const connecting = node.state === 'connecting'
      const run = async action => {
        setBusy(true)
        try {
          await onAction(node.id, action)
        } finally {
          setBusy(false)
        }
      }
      return h('div', { style: first ? styles.rowFirst : undefined },
        h('div', { style: { ...styles.list, width: '100%', border: 'none', borderRadius: 0 } },
          h('div', { style: { ...styles.row, ...(first ? styles.rowFirst : {}) } },
            h('span', {
              style: { ...styles.dot(9), background: STATE_COLOR[node.state] ?? STATE_COLOR.idle },
              'aria-hidden': true,
            }),
            h('div', { style: styles.grow },
              h('div', { style: styles.name }, node.name),
              h('div', { style: styles.meta },
                `${node.username}@${node.host}:${String(node.port)} · ${stateLabel(node)}`)),
            connecting
              ? h('span', { style: styles.meta }, T.connecting)
              : connected
                ? h('button', {
                    style: styles.button,
                    onClick: () => setExpanded(current => !current),
                  }, `${T.workspaces} (${String(workspaces.length)})`)
                : h('button', {
                    style: { ...styles.button, ...(busy ? styles.buttonDisabled : {}) },
                    disabled: busy,
                    onClick: () => { run('connect').catch(() => undefined) },
                  }, node.state === 'failed' ? T.retry : T.connect),
            connected
              ? h('button', {
                  style: { ...styles.button, ...(busy ? styles.buttonDisabled : {}) },
                  disabled: busy,
                  onClick: () => { run('disconnect').catch(() => undefined) },
                }, T.disconnect)
              : null,
            h('button', { style: styles.link, onClick: () => onEdit(node) }, T.edit),
            confirming
              ? h(React.Fragment, null,
                  h('span', { style: styles.meta }, T.removeConfirm),
                  h('button', { style: styles.buttonDanger, onClick: () => { onAction(node.id, 'remove').catch(() => undefined) } }, T.remove),
                  h('button', { style: styles.link, onClick: () => setConfirming(false) }, T.cancel))
              : h('button', { style: styles.link, onClick: () => setConfirming(true) }, T.remove),
          ),
          connecting && node.phase !== undefined ? h(PhaseList, { phase: node.phase }) : null,
          expanded && connected
            ? h(NodeWorkspaces, { nodeId: node.id, workspaces, onAdded: onAction === undefined ? undefined : onRefresh })
            : null,
          node.error !== undefined
            ? h('div', { style: styles.errorBar },
                h('div', null, h('strong', null, `${T.errorTitle}: `), node.error))
            : null,
        ))
    }

    /** The add/edit form for one node. */
    function NodeForm({ initial, onSubmit, onCancel }) {
      const seed = initial ?? {}
      const [draft, setDraft] = useState({
        name: seed.name ?? '',
        host: seed.host ?? '',
        port: String(seed.port ?? 22),
        username: seed.username ?? 'root',
        authKind: seed.authKind ?? 'password',
        password: '',
        privateKey: '',
        passphrase: '',
        remoteRoot: seed.remoteRoot ?? '~/.dsh-fleet',
        enabled: seed.enabled !== false,
      })
      const [submitting, setSubmitting] = useState(false)
      const [error, setError] = useState(undefined)
      const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))

      const submit = async event => {
        event.preventDefault()
        setSubmitting(true)
        setError(undefined)
        try {
          const node = {
            name: draft.name.trim(),
            host: draft.host.trim(),
            port: Number(draft.port),
            username: draft.username.trim(),
            auth: { kind: draft.authKind },
            remoteRoot: draft.remoteRoot.trim(),
            enabled: draft.enabled,
            ...(initial?.id === undefined ? {} : { id: initial.id }),
            ...(draft.password.length > 0 ? { password: draft.password } : {}),
            ...(draft.privateKey.length > 0 ? { privateKey: draft.privateKey } : {}),
            ...(draft.passphrase.length > 0 ? { passphrase: draft.passphrase } : {}),
          }
          await onSubmit(node)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSubmitting(false)
        }
      }

      return h('form', { style: styles.form, onSubmit: submit },
        h('div', { style: styles.field },
          h('label', { style: styles.label }, T.name),
          h('input', {
            style: styles.input, value: draft.name, required: true,
            onChange: event => set('name', event.target.value),
          })),
        h('div', { style: styles.rowFields },
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.host),
            h('input', {
              style: styles.input, value: draft.host, required: true,
              onChange: event => set('host', event.target.value),
            })),
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.port),
            h('input', {
              style: styles.input, value: draft.port, inputMode: 'numeric',
              onChange: event => set('port', event.target.value),
            }))),
        h('div', { style: styles.rowFields },
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.username),
            h('input', {
              style: styles.input, value: draft.username, required: true,
              onChange: event => set('username', event.target.value),
            })),
          h('div', { style: styles.field },
            h('label', { style: styles.label }, T.auth),
            h('select', {
              style: styles.input, value: draft.authKind,
              onChange: event => set('authKind', event.target.value),
            },
            h('option', { value: 'password' }, T.password),
            h('option', { value: 'key' }, T.privateKey)))),
        draft.authKind === 'password'
          ? h('div', { style: styles.field },
              h('label', { style: styles.label }, T.password),
              h('input', {
                style: styles.input, type: 'password', value: draft.password,
                onChange: event => set('password', event.target.value),
              }))
          : h(React.Fragment, null,
              h('div', { style: styles.field },
                h('label', { style: styles.label }, T.privateKey),
                h('textarea', {
                  style: { ...styles.input, minHeight: 120, fontFamily: 'ui-monospace, monospace', resize: 'vertical' },
                  value: draft.privateKey, placeholder: T.privateKeyHint,
                  onChange: event => set('privateKey', event.target.value),
                })),
              h('div', { style: styles.field },
                h('label', { style: styles.label }, T.passphrase),
                h('input', {
                  style: styles.input, type: 'password', value: draft.passphrase,
                  onChange: event => set('passphrase', event.target.value),
                }))),
        h('details', null,
          h('summary', { style: styles.link }, T.advanced),
          h('div', { style: { ...styles.field, marginTop: 10 } },
            h('label', { style: styles.label }, T.remoteRoot),
            h('input', {
              style: styles.input, value: draft.remoteRoot,
              onChange: event => set('remoteRoot', event.target.value),
            })),
          h('label', { style: { ...styles.label, display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 } },
            h('input', {
              type: 'checkbox', checked: draft.enabled,
              onChange: event => set('enabled', event.target.checked),
            }),
            T.autoConnect)),
        error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,
        h('div', { style: styles.actions },
          h('button', { type: 'button', style: styles.button, onClick: onCancel }, T.cancel),
          h('button', {
            type: 'submit',
            style: { ...styles.buttonPrimary, ...(submitting ? styles.buttonDisabled : {}) },
            disabled: submitting,
          }, T.save)),
      )
    }

    /** Shared fleet state: one poll loop per mounted surface. */
    function useFleet() {
      const [state, setState] = useState({ loading: true, error: undefined, nodes: [], version: '', workspaces: [] })
      const timer = useRef()
      const load = useCallback(async () => {
        try {
          const [body, merged] = await Promise.all([api('/nodes'), api('/workspaces')])
          setState({
            loading: false,
            error: undefined,
            nodes: body.nodes ?? [],
            version: body.version ?? '',
            workspaces: merged.baseline?.items ?? [],
          })
        } catch (error) {
          setState(current => ({ ...current, loading: false, error: error.message }))
        }
      }, [])
      useEffect(() => {
        let cancelled = false
        const tick = async () => {
          if (cancelled) return
          await load()
          timer.current = setTimeout(tick, 2000)
        }
        tick()
        return () => {
          cancelled = true
          if (timer.current !== undefined) clearTimeout(timer.current)
        }
      }, [load])
      const action = useCallback(async (id, verb) => {
        if (verb === 'remove') await api(`/nodes/${id}`, { method: 'DELETE' })
        else await api(`/nodes/${id}/${verb}`, { method: 'POST' })
        await load()
      }, [load])
      const save = useCallback(async draft => {
        await api('/nodes', { method: 'POST', body: JSON.stringify(draft) })
        await load()
      }, [load])
      return { ...state, reload: load, action, save }
    }

    /** Workspaces belonging to one node, recognised by their wrapped identity. */
    function workspacesOf(all, nodeId) {
      const prefix = `fleet_${nodeId}_`
      return all.filter(workspace => typeof workspace.workspaceId === 'string'
        && workspace.workspaceId.startsWith(prefix))
    }

    /** The full node list with its add/edit form. */
    function FleetBody({ compact }) {
      const fleet = useFleet()
      const [editing, setEditing] = useState(undefined)
      const remote = useMemo(() => fleet.nodes.filter(node => node.id !== undefined), [fleet.nodes])
      return h('div', { style: compact ? { padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 18 } : { display: 'contents' } },
        h('section', null,
          h('div', { style: styles.groupHeader },
            h('h2', { style: styles.groupTitle }, T.local),
            h('p', { style: styles.groupHint }, T.localHint)),
          h('div', { style: styles.list },
            h('div', { style: { ...styles.row, ...styles.rowFirst } },
              h('span', { style: { ...styles.dot(9), background: 'var(--dsw-alias-state-success-primary)' }, 'aria-hidden': true }),
              h('div', { style: styles.grow },
                h('div', { style: styles.name }, zh ? '本机 Harness' : 'This Harness'),
                h('div', { style: styles.meta }, fleet.version === '' ? '' : `DSH ${fleet.version}`)),
            )),
        ),
        h('section', null,
          h('div', { style: styles.groupHeader },
            h('h2', { style: styles.groupTitle }, T.remote),
            h('p', { style: styles.groupHint }, T.remoteHint),
            h('button', {
              style: { ...styles.buttonPrimary, marginLeft: 'auto' },
              onClick: () => setEditing({ next: true }),
            }, T.add)),
          editing !== undefined && editing.next === true
            ? h(NodeForm, {
                onSubmit: async draft => {
                  await fleet.save(draft)
                  setEditing(undefined)
                },
                onCancel: () => setEditing(undefined),
              })
            : null,
          editing !== undefined && editing.next !== true
            ? h(NodeForm, {
                initial: editing,
                onSubmit: async draft => {
                  await fleet.save(draft)
                  setEditing(undefined)
                },
                onCancel: () => setEditing(undefined),
              })
            : null,
          remote.length === 0
            ? h('div', { style: { ...styles.list, ...styles.empty } }, T.empty)
            : h('div', { style: styles.list },
                remote.map((node, index) => h(NodeRow, {
                  key: node.id,
                  node,
                  first: index === 0,
                  workspaces: workspacesOf(fleet.workspaces, node.id),
                  onAction: fleet.action,
                  onEdit: setEditing,
                  onRefresh: fleet.reload,
                }))),
          fleet.error !== undefined
            ? h('div', { style: { ...styles.errorBar, margin: 0, marginTop: 10 } }, fleet.error)
            : null,
        ),
        remote.length > 0
          ? h('section', null,
              h('div', { style: styles.groupHeader },
                h('h2', { style: styles.groupTitle }, T.workspaces),
                h('p', { style: styles.groupHint }, T.workspacesHint)))
          : null,
      )
    }

    /** Settings section page. */
    function SettingsSection() {
      return h('div', { style: styles.page },
        h('header', null,
          h('h1', { style: styles.h1 }, T.sectionTitle),
          h('p', { style: styles.subtitle }, T.subtitle)),
        h(FleetBody, { compact: false }),
      )
    }

    /** Main-column panel page. */
    function PanelPage() {
      return h('div', { style: styles.page },
        h('header', null,
          h('h1', { style: styles.h1 }, T.title),
          h('p', { style: styles.subtitle }, T.subtitle)),
        h(FleetBody, { compact: false }),
      )
    }

    /** Sidebar panel icon: a console joined to a server. */
    function PanelIcon({ size, active }) {
      const edge = size ?? 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { display: 'block', opacity: active === false ? 0.7 : 1 },
      },
      h('rect', { x: 2, y: 5, width: 9, height: 6, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M2 15h9', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('path', { d: 'M11 8h3', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('rect', { x: 15, y: 3, width: 7, height: 7, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 15, y: 14, width: 7, height: 7, rx: 1.4, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('path', { d: 'M14 7h1M14 17h1', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // The settings page lives on the section ledger, so the shipped shell
        // owns its navigation chrome and this plugin owns only the body.
        if (ctx.slots !== undefined) {
          ctx.slots.inject('settings.section', () => ctx.slots.register({
            name: 'settings.section',
            id: 'dsh-fleet',
            order: 40,
            label: () => T.sectionTitle,
          }, SettingsSection))

          // A sidebar panel icon plus its main-column page: connection management
          // is reachable without opening Settings. Remote workspaces themselves are
          // NOT shown here — they are merged into the ordinary sidebar by the Host.
          ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
            name: 'sidebar.panellist',
            id: 'fleet',
            order: 30,
            label: () => T.title,
          }, PanelIcon))
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main',
            key: 'fleet',
          }, PanelPage))
        }
      },
    }
  },
})
