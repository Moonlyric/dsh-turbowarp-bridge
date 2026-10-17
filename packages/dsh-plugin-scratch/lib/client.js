// dsh-plugin-scratch —— 浏览器半侧（插件页里那一行「配置」）
//
// 为什么是这种「怪格式」：dsh 的客户端插件不是被 import 的 ESM 源码，而是由
// `window.__ModuleLoader__` 注册的惰性 CJS factory（见 @deepseek-ai/dsh-client-modules
// 的「构建要求」：宿主只提供已构建的 bundle）。所以这个文件不用打包、不用 JSX、
// 不 require 任何本地模块 —— 手写即可，靠 require('react') 拿外壳共享模块表里的依赖。
//
// 它做的事只有一件：往 `plugins.row.config` 这个 keyed slot 注册一页配置表单，
// 键是 `<包名>#<行 id>`。表单数据来自 dsh-settings 的 ConfigForm（props.form），
// 保存写回 profile 的 cordis.patch.yml，热生效（host 半侧读的是 volatile 引用）。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-scratch',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')
    const h = react.createElement

    const NS = 'dsh-plugin-scratch'
    const ROW_ID = 'scratch'

    // 表单一行的描述。key 必须与 index.js 的 Config 字段一一对应。
    const FIELDS = [
      {
        key: 'safety', label: '写操作档位', kind: 'select',
        options: [
          ['preview', 'preview —— 先给 diff，等确认再落盘（默认）'],
          ['auto', 'auto —— 直接落盘，适合批量任务'],
          ['suggest', 'suggest —— 只给建议，不动项目'],
        ],
      },
      { key: 'bridgePort', label: '桥监听端口', kind: 'number', help: '浏览器扩展连这个端口。改完约 2 秒自动重绑，不用重启' },
      { key: 'desktopDebugPort', label: '桌面版调试端口', kind: 'number', help: '与仓库里的「启动TurboWarp(AI可接管).cmd」保持一致（默认 31821）' },
      { key: 'desktopPath', label: 'TurboWarp Desktop 路径', kind: 'text', help: '留空 = 自动在常见目录里找', wide: true },
      { key: 'browserPath', label: '浏览器路径（网页版用）', kind: 'text', help: '留空 = 系统默认浏览器；Windows 下也接受 .cmd/.bat 包装脚本', wide: true },
      { key: 'snapshotsDir', label: '快照目录', kind: 'text', help: '留空 = 系统临时目录。大项目别堆在系统盘', wide: true },
      { key: 'maxSnapshots', label: '快照份数上限', kind: 'number' },
      { key: 'maxSnapshotMemMb', label: '快照内存上限（MB）', kind: 'number' },
      { key: 'maxSnapshotDiskMb', label: '快照落盘上限（MB）', kind: 'number' },
      { key: 'skillsEnabled', label: 'Skill 经验库', kind: 'boolean', help: '关掉后 scratch_skills 只回 disabled，工具本体不受影响' },
    ]

    const muted = { color: 'var(--dsw-alias-label-tertiary, #888)', fontSize: 12, lineHeight: '18px', margin: 0 }
    const labelStyle = { color: 'var(--dsw-alias-label-secondary, #555)', fontSize: 12, fontWeight: 500, lineHeight: '18px' }
    const inputStyle = {
      width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 13, lineHeight: '20px',
      color: 'var(--dsw-alias-label-primary, #111)', background: 'var(--dsw-alias-bg-l1, #fff)',
      border: '1px solid var(--dsw-alias-border-l2, #ddd)', borderRadius: 6, outline: 'none',
    }

    /** 取当前配置值（缺省字段按空串/0/false 处理，避免受控组件变成非受控） */
    function valueOf(state, key, kind) {
      const v = state && state.value ? state.value[key] : undefined
      if (v === undefined || v === null) return kind === 'boolean' ? false : ''
      if (kind === 'boolean') return v === true
      return v
    }

    /** 把快照里的值抄成可编辑草稿 */
    function draftOf(state) {
      const draft = {}
      for (const f of FIELDS) draft[f.key] = valueOf(state, f.key, f.kind)
      return draft
    }

    function Row(props) {
      const { field, value, disabled, onChange } = props
      let control
      if (field.kind === 'select') {
        control = h('select', {
          value: String(value ?? ''),
          disabled,
          style: inputStyle,
          onChange: (e) => onChange(e.target.value),
        }, field.options.map(([v, text]) => h('option', { key: v, value: v }, text)))
      } else if (field.kind === 'boolean') {
        control = h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer' } }, [
          h('input', {
            key: 'cb', type: 'checkbox', checked: value === true, disabled,
            onChange: (e) => onChange(e.target.checked),
          }),
          h('span', { key: 'txt', style: { fontSize: 13 } }, value === true ? '开启' : '关闭'),
        ])
      } else {
        control = h('input', {
          type: field.kind === 'number' ? 'number' : 'text',
          value: value === undefined || value === null ? '' : String(value),
          disabled,
          style: inputStyle,
          onChange: (e) => {
            const raw = e.target.value
            onChange(field.kind === 'number' ? (raw === '' ? '' : Number(raw)) : raw)
          },
        })
      }
      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, gridColumn: field.wide ? '1 / -1' : 'auto' } }, [
        h('span', { key: 'l', style: labelStyle }, field.label),
        control,
        field.help ? h('span', { key: 'h', style: muted }, field.help) : null,
      ])
    }

    /** 整页配置表单：读 props.form 的快照，改完一次 mutate 全部写回 */
    function ConfigPage(props) {
      const form = props.form
      const view = props.view
      const snapshot = form && form.state ? form.state : undefined
      const ready = Boolean(snapshot && snapshot.status === 'ready')
      const writable = Boolean(snapshot && snapshot.writable)

      const [draft, setDraft] = react.useState(() => draftOf(snapshot))
      const [note, setNote] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const revision = snapshot ? snapshot.revision : undefined

      // Host 上的值变了（首次加载完成、保存成功后回读）就同步草稿；不让本地脏草稿被覆盖。
      const baseSignature = ready ? JSON.stringify(draftOf(snapshot)) : ''
      react.useEffect(() => {
        if (!ready) return
        setDraft(draftOf(snapshot))
        setNote('')
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [baseSignature, revision])

      if (view === 'summary') {
        if (!ready) return h('span', { style: muted }, '配置加载中…')
        return h('span', { style: muted },
          `${snapshot.value && snapshot.value.safety ? snapshot.value.safety : 'preview'} · :${snapshot.value && snapshot.value.bridgePort ? snapshot.value.bridgePort : '?'}`)
      }

      if (!snapshot) {
        return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, padding: '4px 0' } }, [
          h('p', { key: 'a', style: muted }, '这个插件行没有可在线编辑的配置（Host 没有为它提供设置表单）。'),
          h('p', { key: 'b', style: muted }, '可以直接改 profile 的 cordis.patch.yml 里 id: scratch 那一段。'),
        ])
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { style: muted }, 'Host 暂时没有提供该插件的设置文档（插件没在运行？）。')
      }
      if (!ready) {
        return h('p', { style: muted }, '配置加载中…')
      }

      const dirty = FIELDS.some((f) => String(draft[f.key]) !== String(valueOf(snapshot, f.key, f.kind)))

      async function save() {
        setBusy(true)
        setNote('')
        try {
          const ops = []
          for (const f of FIELDS) {
            const next = draft[f.key]
            const prev = valueOf(snapshot, f.key, f.kind)
            if (String(next) === String(prev)) continue
            ops.push({ op: 'set', path: [f.key], value: f.kind === 'number' ? Number(next) : next })
          }
          if (ops.length === 0) {
            setNote('没有改动')
            return
          }
          const ok = await form.mutate(ops, revision)
          setNote(ok ? `已保存（${ops.length} 项），立即生效` : '保存被 Host 拒绝：可能是值不合法，或配置文件在别处被改过')
        } catch (e) {
          setNote('保存失败：' + String((e && e.message) || e))
        } finally {
          setBusy(false)
        }
      }

      const head = h('div', { key: 'head', style: { display: 'flex', flexDirection: 'column', gap: 2 } }, [
        h('p', { key: 't', style: { margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--dsw-alias-label-primary, #111)' } }, 'TurboWarp 桥'),
        h('p', { key: 'd', style: muted }, '改完点保存即写入当前 profile 的 cordis.patch.yml，并立刻生效（端口除外，约 2 秒自动重绑）。'),
      ])

      const grid = h('div', {
        key: 'grid',
        style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px 16px', maxWidth: 720 },
      }, FIELDS.map((f) => h(Row, {
        key: f.key,
        field: f,
        value: draft[f.key],
        disabled: !writable || busy,
        onChange: (v) => setDraft((d) => Object.assign({}, d, { [f.key]: v })),
      })))

      const foot = h('div', { key: 'foot', style: { display: 'flex', alignItems: 'center', gap: 10 } }, [
        h('button', {
          key: 'save',
          type: 'button',
          disabled: !writable || busy || !dirty,
          onClick: save,
          style: {
            padding: '6px 14px', fontSize: 13, fontWeight: 500, borderRadius: 6, cursor: (!writable || busy || !dirty) ? 'default' : 'pointer',
            color: '#fff', border: 'none',
            background: (!writable || busy || !dirty) ? 'var(--dsw-alias-label-quaternary, #bbb)' : 'var(--dsw-alias-state-business-primary, #3b6cf6)',
          },
        }, busy ? '保存中…' : '保存'),
        note ? h('span', { key: 'n', style: muted }, note) : null,
        !writable ? h('span', { key: 'ro', style: muted }, '当前 profile 只读，不能在此修改') : null,
      ])

      return h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } }, [head, grid, foot])
    }

    /**
     * 挂载浏览器半侧：只注册「某一行的配置页」。
     * key = `<包名>#<行 id>`，与 host 半侧 cordis.patch.yml 里的 insert id 对应。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
        name: 'plugins.row.config',
        key: `${NS}#${ROW_ID}`,
      }, ConfigPage)), 'dsh-plugin-scratch: row config page')
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
