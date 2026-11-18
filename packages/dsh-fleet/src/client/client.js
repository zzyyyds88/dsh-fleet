/**
 * Browser half of `@greatbaby/dsh-fleet`.
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
 * @module @greatbaby/dsh-fleet/client
 */
window.__ModuleLoader__.load({
  // DSH requires this id to equal the package name: the module table is keyed by it.
  id: '@greatbaby/dsh-fleet',
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
          plugins: '插件同步',
          pluginsHint: '这里列出的是你自己装到这个桌面端的第三方插件，默认全部下发：装在这里、连了节点，就是同一个工作环境，而不是两台各跑一套的机器。关掉一个就只在这台机器上运行。中转插件与这个插件自身永远不会下发，因为节点再去控制别的节点、或者自己开一个入口，都不是要的东西。改动立即下发到已连接的节点，节点会在需要时重启常驻进程。',
          pluginLoaded: '本机已加载',
          pluginInstalledOnly: '本机已安装，但不在这台机器的组合里',
          pluginRows: rows => `${rows} 行`,
          pluginApplied: '已下发',
          pluginNodeFailed: '节点未接受',
          pluginNoNodes: '还没有连接任何节点；开关会记住，连接时生效',
          pluginsNone: '这台机器上没有装第三方插件。装了之后会自动下发到节点，也可以在这里逐个关掉。',
          pluginFailed: '插件列表还没准备好',
          pluginOnHint: '已下发到这个节点',
          pluginOffHint: '只在这台机器上运行',
          pickFolder: '选择工作区文件夹',
          machine: '在哪台机器上',
          thisMachine: '本机',
          up: '上一级',
          go: '打开',
          loading: '正在读取…',
          noFolders: '这个目录下没有子文件夹。',
          truncated: '只显示前 500 个文件夹；可以直接在上面输入完整路径。',
          newFolder: '新建文件夹',
          newFolderTitle: '新建文件夹',
          newFolderName: '文件夹名称',
          newFolderPlaceholder: '例如 my-project',
          newFolderCreate: '创建',
          newFolderFailed: '新建文件夹失败',
          drives: '磁盘',
          workspaceName: '工作区名称',
          workspaceNamePlaceholder: '留空则用文件夹名',
          createProject: '创建项目',
          projectName: '项目名称',
          projectNamePlaceholder: '新项目',
          device: '设备',
          addRemoteDevice: '添加远程设备…',
          sourceFolder: '源文件夹',
          chooseFolder: '选择文件夹',
          chooseFolderHint: 'Harness 可以读取和编辑这些文件夹',
          changeFolder: '更换',
          pickThisFolder: '选择此文件夹',
          back: '返回',
          create: '创建',
          existingOnDeviceHint: '这台设备上已有项目？',
          existingOnDeviceAction: '添加到侧栏',
          existingEmpty: '这台设备上还没有工作区。',
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
          plugins: 'Plugin sync',
          pluginsHint: 'These are the third-party plugins you installed into this desktop. They are sent by default: one installation, one working environment, rather than two machines that quietly differ. Switch one off and it stays on this machine only. The relay plugin and this plugin itself are never sent — a node that could manage other nodes, or that opened a second way in, is not what this is for. A change reaches connected nodes immediately and the node restarts its resident host when it has to.',
          pluginLoaded: 'loaded here',
          pluginInstalledOnly: 'installed here, not in this machine’s composition',
          pluginRows: rows => `${rows} row(s)`,
          pluginApplied: 'sent',
          pluginNodeFailed: 'the node did not take it',
          pluginNoNodes: 'No node is connected; the switch is remembered and applies on connect',
          pluginsNone: 'No third-party plugin is installed on this machine. Once one is, it is sent to nodes automatically and you can switch it off here.',
          pluginFailed: 'The plugin list is not composed yet',
          pickFolder: 'Choose a workspace folder',
          machine: 'On which machine',
          thisMachine: 'This machine',
          up: 'Up',
          go: 'Open',
          loading: 'Reading…',
          noFolders: 'No subfolders here.',
          truncated: 'Showing the first 500 folders; type a full path above to go anywhere.',
          newFolder: 'New folder',
          newFolderTitle: 'New folder',
          newFolderName: 'Folder name',
          newFolderPlaceholder: 'e.g. my-project',
          newFolderCreate: 'Create',
          newFolderFailed: 'Could not create the folder',
          drives: 'Drives',
          workspaceName: 'Workspace name',
          workspaceNamePlaceholder: 'Leave empty to use the folder name',
          createProject: 'Create project',
          projectName: 'Project name',
          projectNamePlaceholder: 'New project',
          device: 'Device',
          addRemoteDevice: 'Add remote device…',
          sourceFolder: 'Source folder',
          chooseFolder: 'Choose a folder',
          chooseFolderHint: 'Harness can read and edit these folders',
          changeFolder: 'Change',
          pickThisFolder: 'Use this folder',
          back: 'Back',
          create: 'Create',
          existingOnDeviceHint: 'A project already on this device?',
          existingOnDeviceAction: 'Add to sidebar',
          existingEmpty: 'This device has no workspaces yet.',
        }

    /** Token-driven styles so light and dark both work. */
    const styles = {
      /**
       * The page is its own scroll viewport.
       *
       * The shell renders a `main` slot inside `mainPanel` → `centerCol`, and `centerCol`
       * is `overflow: hidden`. A body taller than the frame is therefore **clipped with no
       * scrollbar anywhere**: measured on a real page, `mainPanel` was 1026 px tall with a
       * 10658 px `scrollHeight`, and neither it nor any ancestor scrolled. So the page
       * takes the frame's height and scrolls itself, which is the only place this plugin
       * can decide it — the shell's layout is not ours to change.
       */
      page: {
        padding: '24px 28px', maxWidth: 880, boxSizing: 'border-box',
        height: '100%', minHeight: 0, overflowY: 'auto', overflowX: 'hidden',
        display: 'flex', flexDirection: 'column', gap: 24,
      },
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

    /**
     * The project form the shell asks for when a workspace is added.
     *
     * The shell's own picker browses **this** machine, so it can never name `/root/project`
     * on a node. This replaces that dialog with one that first asks *which machine* and
     * then browses that machine's folders — which is the whole point: adding a folder on a
     * node has to feel like adding a folder here.
     *
     * It fills the same slot the shipped pickers fill, so the gesture is unchanged: the
     * plus button next to Workspaces, or a new Session, opens it. Picking a path is the
     * main thing this does; creating the workspace is the shell's job, which is why the
     * answer is `onPicked(path)` and not an API call. A remote path is routed to its node
     * by the Host half, so one callback covers both cases.
     *
     * Three things go beyond naming a directory, all because the shell cannot do them:
     * a folder can be **created** here (a new project usually has no folder yet), a
     * workspace can be **named** here (the shell derives the title from the folder name),
     * and an existing folder on the node can be **adopted** without re-browsing to it.
     *
     * The first screen is the form — name, device, source folder — and the browser is a
     * second page it opens. That order matters: opening a file browser as the first thing
     * reads as "operate a folder dialog", while asking for a name first reads as "create a
     * project", which is the thing the person actually came to do.
     */
    function WorkspaceFolderFlow(props) {
      const open = props.open === true
      // One dialog, two entry points. A new Session is creating a project; the sidebar is
      // adding a workspace to a list. Same fields, different words — and the words are
      // what make the same form read correctly in both places.
      const asProject = props.origin === 'conversation.hero.workspace.directoryFlow'
        || props.origin === 'workspace.picker.directoryFlow'
      const [nodes, setNodes] = useState([])
      const [nodeId, setNodeId] = useState('')
      /** `form` | `browse` | `device` | `existing` */
      const [page, setPage] = useState('form')
      const [title, setTitle] = useState('')
      /** The folder the person confirmed: `{ path, name }`, absent until they pick one. */
      const [chosen, setChosen] = useState(undefined)
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(undefined)
      const [listing, setListing] = useState(undefined)
      const [loading, setLoading] = useState(false)
      const [typed, setTyped] = useState('')
      const [makingFolder, setMakingFolder] = useState(false)
      const [newName, setNewName] = useState('')
      const [newError, setNewError] = useState(undefined)
      /** Workspaces already on the selected device, while the "add to sidebar" page is up. */
      const [existing, setExisting] = useState(undefined)

      // Load the machine list when the dialog opens, not on mount: this component stays
      // mounted for the whole Session, and polling a node list that nobody is looking at
      // would be a request every two seconds for nothing.
      const reloadNodes = useCallback(async () => {
        try {
          const body = await api('/nodes')
          setNodes((body.nodes ?? []).filter(node => node.id !== undefined))
        } catch {
          // A node list that cannot be read must not block picking a local folder.
        }
      }, [])

      useEffect(() => {
        if (!open) return
        void reloadNodes()
      }, [open, reloadNodes])

      const browse = useCallback(async (target, dir) => {
        setLoading(true)
        setError(undefined)
        try {
          const query = new URLSearchParams()
          if (target !== '') query.set('node', target)
          if (dir !== '') query.set('path', dir)
          const body = await api(`/browse?${query.toString()}`)
          setListing(body)
          setTyped('')
        } catch (failure) {
          setError(failure.message)
        } finally {
          setLoading(false)
        }
      }, [])

      // Opening the dialog starts on the form with nothing carried over, so a second visit
      // does not open on the folder the first visit happened to be looking at.
      useEffect(() => {
        if (!open) return
        setPage('form')
        setListing(undefined)
        setError(undefined)
        setMakingFolder(false)
        setNewName('')
        setNewError(undefined)
        setTitle('')
        setChosen(undefined)
        setExisting(undefined)
      }, [open])

      // The browser lands on the chosen machine's home directory: that is where a person's
      // projects are on either side, and asking them to type a path first would make the
      // remote case feel different from the local one again.
      useEffect(() => {
        if (!open || page !== 'browse') return
        setListing(undefined)
        void browse(nodeId, '')
      }, [open, page, nodeId, browse])

      if (!open) return null

      const current = listing?.path ?? ''
      const roots = listing?.roots ?? []

      /**
       * Commit the project form: name the workspace, then hand the folder to the shell.
       *
       * Without a name this is the cheap path the shell expects — it derives the title from
       * the folder name itself. With one, the workspace is created here first so the title
       * has somewhere to live; the shell then resolves that same row (create is
       * idempotent). A failure is reported in the form and nothing is handed over, because
       * a workspace that exists but is not selected looks like a lost click.
       */
      const commit = async () => {
        const folder = chosen?.path ?? ''
        if (folder.length === 0) return
        setError(undefined)
        setSaving(true)
        try {
          const wanted = title.trim()
          if (wanted.length === 0) {
            props.onPicked?.(folder)
            return
          }
          await api('/workspaces', {
            method: 'POST',
            body: JSON.stringify({
              ...(nodeId === '' ? {} : { nodeId }),
              path: folder,
              title: wanted,
            }),
          })
          props.onPicked?.(folder)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setSaving(false)
        }
      }

      const goTyped = event => {
        event.preventDefault()
        if (typed.trim().length === 0) return
        void browse(nodeId, typed.trim())
      }

      /** Create the folder being named, then stand inside it. */
      const createFolder = async event => {
        event.preventDefault()
        const name = newName.trim()
        if (name.length === 0 || current.length === 0) return
        setNewError(undefined)
        try {
          const body = await api('/browse', {
            method: 'POST',
            body: JSON.stringify({
              ...(nodeId === '' ? {} : { nodeId }),
              path: current,
              name,
            }),
          })
          setMakingFolder(false)
          setNewName('')
          await browse(nodeId, body.path)
        } catch (failure) {
          setNewError(failure.message)
        }
      }

      /** List what the selected device already has, so an existing folder need not be found again. */
      const openExisting = async () => {
        if (nodeId === '') return
        setError(undefined)
        setPage('existing')
        setExisting(undefined)
        try {
          const body = await api('/workspaces')
          const prefix = `fleet_${nodeId}_`
          const items = body.baseline?.items ?? []
          setExisting(items.filter(item => typeof item.workspaceId === 'string'
            && item.workspaceId.startsWith(prefix)))
        } catch (failure) {
          setError(failure.message)
          setExisting([])
        }
      }

      const nodeOptions = [{ id: '', label: T.thisMachine }, ...nodes.map(node => ({
        id: node.id,
        label: `${node.name} · ${node.host}`,
      }))]

      const overlay = {
        position: 'fixed', inset: 0, zIndex: 60, display: 'flex',
        alignItems: 'center', justifyContent: 'center',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-base) 62%, transparent)',
      }
      const dialog = {
        width: 'min(560px, calc(100vw - 32px))', maxHeight: 'min(620px, calc(100vh - 64px))',
        display: 'flex', flexDirection: 'column', gap: 12, padding: 18,
        background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12,
        boxShadow: 'var(--dsw-shadow-lg, 0 18px 48px rgba(0,0,0,0.28))',
      }
      const rowStyle = {
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', width: '100%',
        boxSizing: 'border-box', textAlign: 'left', cursor: 'pointer',
        appearance: 'none', background: 'transparent', border: 'none', borderRadius: 6,
        color: 'var(--dsw-alias-label-primary)', fontSize: 13,
      }
      // A native `<select>` keeps the platform's square frame no matter what the box
      // radius says, so the frame is drawn here and the arrow is our own glyph. Same for
      // the paths: the two pickers have to look like one control.
      const selectWrap = {
        position: 'relative', display: 'flex', alignItems: 'center',
        border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
      }
      const selectStyle = {
        appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
        flex: '1 1 auto', minWidth: 0, padding: '8px 30px 8px 10px', border: 'none',
        borderRadius: 8, background: 'transparent', outline: 'none',
        color: 'var(--dsw-alias-label-primary)', fontSize: 13, cursor: 'pointer',
      }
      const chipStyle = extra => ({
        ...styles.button, padding: '3px 9px', fontSize: 12, borderRadius: 999, ...extra,
      })
      /** The empty source-folder card: dashed, with the same wording the shipped form uses. */
      const folderSlot = {
        display: 'flex', alignItems: 'center', gap: 10, width: '100%', boxSizing: 'border-box',
        padding: '12px 14px', cursor: 'pointer', textAlign: 'left',
        appearance: 'none', borderRadius: 10, fontSize: 13,
        border: '1px dashed var(--dsw-alias-border-l2)',
        background: 'color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, transparent)',
        color: 'var(--dsw-alias-label-primary)',
      }
      const title2 = asProject ? T.createProject : T.pickFolder
      const commitLabel = asProject ? T.create : T.addWorkspace

      const header = (heading, withBack) => h('div', { style: { display: 'flex', alignItems: 'center', gap: 8 } },
        withBack
          ? h('button', {
              type: 'button',
              'aria-label': T.back,
              style: { ...styles.link, textDecoration: 'none', fontSize: 13 },
              onClick: () => { setPage('form') },
            }, `‹ ${T.back}`)
          : null,
        h('h2', { style: { margin: 0, fontSize: 15, fontWeight: 600 } }, heading),
        h('button', {
          type: 'button',
          style: { ...styles.link, marginLeft: 'auto' },
          onClick: () => props.onCancel?.(),
        }, T.cancel))

      // ---- adding a remote device, from inside the device list -----------------
      if (page === 'device') {
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.addRemoteDevice },
          h('div', { style: dialog },
            header(T.addRemoteDevice, true),
            h(NodeForm, {
              onSubmit: async draft => {
                await api('/nodes', { method: 'POST', body: JSON.stringify(draft) })
                await reloadNodes()
                setPage('form')
              },
              onCancel: () => setPage('form'),
            })))
      }

      // ---- adopt a folder the node already has ---------------------------------
      if (page === 'existing') {
        const rows = existing ?? []
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.existingOnDeviceAction },
          h('div', { style: dialog },
            header(T.existingOnDeviceAction, true),
            h('p', { style: { ...styles.groupHint, margin: 0 } }, T.existingOnDeviceHint),
            existing === undefined
              ? h('div', { style: styles.empty }, T.loading)
              : rows.length === 0
                ? h('div', { style: styles.empty }, T.existingEmpty)
                : h('div', {
                    style: {
                      flex: '1 1 auto', minHeight: 120, maxHeight: 320, overflowY: 'auto',
                      border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 4,
                    },
                  },
                  rows.map(row => h('button', {
                    key: row.workspaceId,
                    type: 'button',
                    style: rowStyle,
                    title: row.path,
                    onClick: () => { props.onPicked?.(row.path) },
                  }, h('span', { 'aria-hidden': true, style: { opacity: 0.6 } }, '📁'),
                    h('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
                      row.title ?? row.path)))),
            error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,
            h('div', { style: { ...styles.actions, marginTop: 'auto' } },
              h('button', { type: 'button', style: styles.button, onClick: () => setPage('form') }, T.back))))
      }

      // ---- browse the chosen machine's folders ----------------------------------
      if (page === 'browse') {
        return h('div', { style: overlay, role: 'dialog', 'aria-label': T.chooseFolder },
          h('div', { style: dialog },
            header(T.chooseFolder, true),

            // The machine stays switchable here: a person may realize mid-browse that the
            // folder is on the other side, and losing the name they typed to find that out
            // would be a worse trade than one extra control.
            h('label', { style: styles.field },
              h('span', { style: styles.label }, T.machine),
              h('span', { style: selectWrap },
                h('select', {
                  style: selectStyle,
                  value: nodeId,
                  disabled: loading,
                  onChange: event => setNodeId(event.target.value),
                }, nodeOptions.map(option => h('option', { key: option.id, value: option.id }, option.label))),
                h('span', {
                  'aria-hidden': true,
                  style: {
                    position: 'absolute', right: 11, pointerEvents: 'none',
                    color: 'var(--dsw-alias-label-secondary)', fontSize: 10, lineHeight: 1,
                  },
                }, '▼'))),

            h('form', { style: { display: 'flex', gap: 8 }, onSubmit: goTyped },
              h('button', {
                type: 'button',
                style: { ...styles.button, flex: '0 0 auto' },
                disabled: listing?.parent === undefined || loading,
                onClick: () => { if (listing?.parent !== undefined) void browse(nodeId, listing.parent) },
              }, T.up),
              h('input', {
                style: { ...styles.input, flex: '1 1 auto', fontFamily: 'var(--dsw-alias-font-code, ui-monospace, monospace)', fontSize: 12 },
                placeholder: current.length === 0 ? T.pathPlaceholder : current,
                value: typed,
                onChange: event => setTyped(event.target.value),
              }),
              h('button', { type: 'submit', style: { ...styles.button, flex: '0 0 auto' }, disabled: loading }, T.go)),

            // A drive is a root the home directory cannot reach: walking "up" from
            // `C:\Users\me` stops at `C:\`, so `D:\projects` needed a typed path. The
            // listing answers which roots exist, and they read as chips on one line.
            roots.length > 1
              ? h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
                  h('span', { style: styles.label }, T.drives),
                  roots.map(root => h('button', {
                    key: root,
                    type: 'button',
                    style: chipStyle(current === root ? { borderColor: 'var(--dsw-alias-brand-primary)' } : {}),
                    disabled: loading,
                    onClick: () => { void browse(nodeId, root) },
                  }, root)))
              : null,

            makingFolder
              ? h('form', {
                  style: { display: 'flex', gap: 8, alignItems: 'center' },
                  onSubmit: createFolder,
                },
                h('input', {
                  style: { ...styles.input, flex: '1 1 auto', fontSize: 12 },
                  placeholder: T.newFolderPlaceholder,
                  'aria-label': T.newFolderName,
                  value: newName,
                  autoFocus: true,
                  onChange: event => setNewName(event.target.value),
                }),
                h('button', {
                  type: 'submit',
                  style: { ...styles.buttonPrimary, ...(newName.trim().length === 0 ? styles.buttonDisabled : {}) },
                  disabled: newName.trim().length === 0,
                }, T.newFolderCreate),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  onClick: () => { setMakingFolder(false); setNewName(''); setNewError(undefined) },
                }, T.cancel))
              : h('div', { style: { display: 'flex', justifyContent: 'flex-start' } },
                  h('button', {
                    type: 'button',
                    style: styles.button,
                    disabled: current.length === 0 || loading,
                    onClick: () => { setMakingFolder(true); setNewError(undefined) },
                  }, `＋ ${T.newFolder}`)),

            newError !== undefined
              ? h('div', { style: { ...styles.errorBar, margin: 0 } }, `${T.newFolderFailed}: ${newError}`)
              : null,

            h('div', {
              style: {
                flex: '1 1 auto', minHeight: 120, maxHeight: 260, overflowY: 'auto',
                border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: 4,
              },
            },
            loading
              ? h('div', { style: styles.empty }, T.loading)
              : (listing?.entries ?? []).length === 0
                ? h('div', { style: styles.empty }, T.noFolders)
                : (listing?.entries ?? []).map(entry => h('button', {
                    key: entry.path,
                    type: 'button',
                    style: rowStyle,
                    title: entry.path,
                    onClick: () => void browse(nodeId, entry.path),
                  }, h('span', { 'aria-hidden': true, style: { opacity: 0.6 } }, '📁'), entry.name))),

            listing?.truncated === true ? h('p', { style: styles.groupHint }, T.truncated) : null,

            error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,

            h('div', { style: { ...styles.actions, marginTop: 'auto' } },
              h('button', { type: 'button', style: styles.button, onClick: () => setPage('form') }, T.cancel),
              h('button', {
                type: 'button',
                style: { ...styles.buttonPrimary, ...(current.length === 0 ? styles.buttonDisabled : {}) },
                disabled: current.length === 0 || loading,
                onClick: () => {
                  const leaf = current.split(/[\\/]/).filter(Boolean).pop() ?? current
                  setChosen({ path: current, name: leaf })
                  setPage('form')
                },
              }, T.pickThisFolder))))
      }

      // ---- the form itself: name → device → source folder -----------------------
      return h('div', { style: overlay, role: 'dialog', 'aria-label': title2 },
        h('div', { style: dialog },
          header(title2, false),

          h('label', { style: styles.field },
            h('span', { style: styles.label }, asProject ? T.projectName : T.workspaceName),
            h('input', {
              style: { ...styles.input, fontSize: 13 },
              placeholder: asProject ? T.projectNamePlaceholder : T.workspaceNamePlaceholder,
              value: title,
              onChange: event => setTitle(event.target.value),
            })),

          // Machine next, folder last: that is the one extra decision a remote workspace
          // needs, and it is why the local picker could not do this job.
          h('label', { style: styles.field },
            h('span', { style: styles.label }, asProject ? T.device : T.machine),
            h('span', { style: selectWrap },
              h('select', {
                style: selectStyle,
                value: nodeId,
                disabled: saving,
                onChange: event => {
                  if (event.target.value === '__add') setPage('device')
                  else setNodeId(event.target.value)
                },
              },
              nodeOptions.map(option => h('option', { key: option.id, value: option.id }, option.label)),
              h('option', { value: '__add' }, T.addRemoteDevice)),
              h('span', {
                'aria-hidden': true,
                style: {
                  position: 'absolute', right: 11, pointerEvents: 'none',
                  color: 'var(--dsw-alias-label-secondary)', fontSize: 10, lineHeight: 1,
                },
              }, '▼'))),

          // The shipped form offers this right under the device, only for a remote one: a
          // folder that already exists there should not have to be found again by hand.
          nodeId !== ''
            ? h('p', { style: { ...styles.groupHint, margin: 0 } },
                T.existingOnDeviceHint, ' ',
                h('button', {
                  type: 'button',
                  style: { ...styles.link, color: 'var(--dsw-alias-brand-primary)' },
                  onClick: () => { void openExisting() },
                }, `${T.existingOnDeviceAction} ›`))
            : null,

          h('div', { style: styles.field },
            h('span', { style: styles.label }, T.sourceFolder),
            chosen === undefined
              ? h('button', {
                  type: 'button',
                  style: folderSlot,
                  onClick: () => setPage('browse'),
                },
                h('span', { 'aria-hidden': true, style: { fontSize: 16, opacity: 0.7 } }, '📁'),
                h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: { fontWeight: 500 } }, T.chooseFolder),
                  h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, T.chooseFolderHint)))
              : h('div', {
                  style: {
                    display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px',
                    border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10,
                  },
                },
                h('span', { 'aria-hidden': true, style: { fontSize: 16, opacity: 0.7 } }, '📁'),
                h('span', { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                  h('span', { style: { fontSize: 13 } }, chosen.name),
                  h('span', { style: { ...styles.mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, chosen.path)),
                h('button', {
                  type: 'button',
                  style: styles.button,
                  onClick: () => setPage('browse'),
                }, T.changeFolder))),

          error !== undefined ? h('div', { style: { ...styles.errorBar, margin: 0 } }, error) : null,

          h('div', { style: { ...styles.actions, marginTop: 'auto' } },
            h('button', { type: 'button', style: styles.button, onClick: () => props.onCancel?.() }, T.cancel),
            h('button', {
              type: 'button',
              style: { ...styles.buttonPrimary, ...(chosen === undefined || saving ? styles.buttonDisabled : {}) },
              disabled: chosen === undefined || saving,
              onClick: () => { void commit() },
            }, commitLabel)),
        ))
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

    /**
     * A neutral tile for a plugin that ships no icon.
     *
     * Drawn rather than typed: an emoji here renders as a coloured glyph that competes
     * with the real icons beside it, so a bundle without one looks like a different kind
     * of thing instead of an unlabelled one.
     */
    function PluginGlyph({ size }) {
      const edge = size ?? 18
      return h('svg', {
        width: edge, height: edge, viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': true,
        style: { display: 'block' },
      },
      h('rect', { x: 3, y: 3, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 13, y: 3, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 3, y: 13, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }),
      h('rect', { x: 13, y: 13, width: 8, height: 8, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.6 }))
    }

    /**
     * Per-plugin "send to nodes" switches — one row per plugin you installed.
     *
     * The row is a **bundle**, because that is the unit both sides understand: this
     * desktop's profile lists bundles, and a node composes a bundle list. An earlier
     * version listed every internal row this desktop composes (207 of them), which
     * described the composition instead of offering a decision — no one installs
     * `tool-result-pruner`, they install a plugin.
     *
     * Two facts per row: the switch (what a node loads) and where it is on this machine
     * (loaded, or merely downloaded). The second is what makes "off" honest rather than
     * looking like a mistake.
     */
    function PluginSyncSection() {
      const [rows, setRows] = useState(undefined)
      const [error, setError] = useState(undefined)
      const [note, setNote] = useState(undefined)
      const [busy, setBusy] = useState(undefined)

      const load = useCallback(async () => {
        try {
          const body = await api('/plugins')
          setRows(body.rows ?? [])
          setError(undefined)
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const toggle = async row => {
        setBusy(row.bundle)
        setNote(undefined)
        try {
          const body = await api(`/plugins/${encodeURIComponent(row.bundle)}`, {
            method: 'POST',
            body: JSON.stringify({ sync: !row.sync }),
          })
          setRows(current => (current ?? []).map(entry => (entry.bundle === row.bundle ? body.row : entry)))
          setError(undefined)
          // The node's answer is the outcome, not the click: switching a plugin on installs
          // a package over SSH, and that can fail on the node's own registry. Reporting
          // "saved" while the node composes nothing is the bug this surface prevents.
          const reached = body.nodes ?? []
          const failed = reached.filter(report => report.error !== undefined
            || (report.plugins?.failed?.length ?? 0) > 0)
          if (failed.length > 0) {
            setError(failed.map(report => `${report.name}: ${report.error
              ?? report.plugins.failed.map(failure => `${failure.bundle} — ${failure.reason}`).join('; ')}`)
              .join('\n'))
          } else if (reached.length === 0) {
            setNote(T.pluginNoNodes)
          } else {
            setNote(`${T.pluginApplied}: ${reached.map(report => report.name).join(', ')}`)
          }
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(undefined)
        }
      }

      /**
       * One switch, drawn like the shipped toggle.
       *
       * This plugin cannot import another plugin's control, so the switch is local. It
       * keeps the same shape and the same `role="switch"` semantics so both pages read
       * as one product.
       */
      const switchStyle = on => ({
        position: 'relative', flex: '0 0 auto', width: 36, height: 20, padding: 0,
        appearance: 'none', border: 'none', borderRadius: 999, cursor: 'pointer',
        background: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)',
        transition: 'background 120ms ease',
      })
      const thumbStyle = on => ({
        position: 'absolute', top: 2, left: on ? 18 : 2, width: 16, height: 16,
        borderRadius: '50%', background: '#fff', transition: 'left 120ms ease',
        boxShadow: '0 1px 2px rgba(0,0,0,0.25)',
      })

      const detail = row => {
        const parts = []
        if (row.rows.length > 0) parts.push(T.pluginRows(row.rows.length))
        parts.push(row.loaded ? T.pluginLoaded : T.pluginInstalledOnly)
        return parts.join(' · ')
      }

      /**
       * The row's display text in the reader's language.
       *
       * The Host reads both dictionaries because it does not know which one this browser
       * wants; choosing here is what keeps the page from showing Chinese descriptions to
       * someone reading the English UI. Where a plugin ships only one language, that one
       * is shown — an untranslated sentence is more useful than a bare package name.
       */
      const metaText = row => {
        const meta = row.meta ?? {}
        const title = zh ? meta.title : (meta.titleEn ?? meta.title)
        const description = zh ? meta.description : (meta.descriptionEn ?? meta.description)
        return { title: title ?? row.bundle, description }
      }

      const rowNode = row => h('div', {
        key: row.bundle,
        style: { ...styles.workspaceRow, padding: '12px 14px', alignItems: 'flex-start', gap: 12 },
      },
      // The icon is the bundle's own, resolved the way DSH resolves it for its plugin
      // page; without one the row shows a neutral tile rather than a broken image.
      row.meta?.icon === undefined
        ? h('span', {
            style: {
              flex: '0 0 auto', width: 36, height: 36, borderRadius: 9,
              background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-border-l1))',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--dsw-alias-label-secondary)',
            },
            'aria-hidden': true,
          }, h(PluginGlyph, { size: 18 }))
        : h('img', {
            src: row.meta.icon,
            alt: '',
            style: { flex: '0 0 auto', width: 36, height: 36, borderRadius: 9, objectFit: 'cover' },
          }),
      h('div', { style: { ...styles.grow, display: 'flex', flexDirection: 'column', gap: 3 } },
        h('div', { style: { ...styles.name, fontWeight: 500 } }, metaText(row).title),
        metaText(row).description === undefined
          ? null
          : h('div', {
              style: {
                fontSize: 12, lineHeight: 1.45, color: 'var(--dsw-alias-label-secondary)',
                display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
              },
            }, metaText(row).description),
        // The identity and the local state stay readable, but they are the second line:
        // the title above is what a person recognizes.
        h('div', { style: styles.mono, title: detail(row) }, `${row.bundle} · ${detail(row)}`)),
      h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': row.sync === true,
        'aria-label': metaText(row).title,
        title: row.sync === true ? T.pluginOnHint : T.pluginOffHint,
        disabled: busy === row.bundle,
        style: {
          ...switchStyle(row.sync === true),
          ...(busy === row.bundle ? { opacity: 0.5, cursor: 'default' } : {}),
          marginTop: 2,
        },
        onClick: () => { void toggle(row) },
      }, h('span', { style: thumbStyle(row.sync === true), 'aria-hidden': true })))

      return h('section', null,
        h('div', { style: styles.groupHeader },
          h('h2', { style: styles.groupTitle }, T.plugins),
          h('p', { style: styles.groupHint }, T.pluginsHint)),
        error !== undefined
          ? h('div', { style: { ...styles.errorBar, margin: '0 0 10px' } }, error)
          : null,
        note !== undefined
          ? h('p', { style: { ...styles.groupHint, margin: '0 0 10px' } }, note)
          : null,
        rows === undefined
          ? h('div', { style: { ...styles.list, ...styles.empty } }, T.pluginFailed)
          : rows.length === 0
            ? h('div', { style: { ...styles.list, ...styles.empty } }, T.pluginsNone)
            : h('div', { style: styles.list },
                rows.map((row, index) => h('div', {
                  key: row.bundle,
                  style: { ...styles.row, ...(index === 0 ? styles.rowFirst : {}) },
                }, rowNode(row)))),
      )
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
        h(PluginSyncSection),
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

          // Occupying the shell's folder-picker slots is what makes a remote folder
          // reachable at all: the shipped pickers browse this machine only, so they can
          // never name a directory on a node. Registering here replaces the dialog for
          // every entry point at once — the sidebar's plus button, the new-Session flow,
          // and the workspace picker — without touching any of them.
          //
          // The slot is named on the props rather than read from context: the two entry
          // points ask for the same fields under different words (a new Session creates a
          // **project**, the sidebar adds a **workspace**), and a component that cannot
          // tell which one opened it would have to say one of them wrongly.
          for (const slot of [
            'sidebar.workspaces.directoryFlow',
            'conversation.hero.workspace.directoryFlow',
            'workspace.picker.directoryFlow',
          ]) {
            ctx.slots.inject(slot, () => ctx.slots.register({ name: slot },
              props => h(WorkspaceFolderFlow, { ...props, origin: slot })))
          }
        }
      },
    }
  },
})
