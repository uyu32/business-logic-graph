import { Component, type ReactNode } from 'react'
import { AlertTriangle } from 'lucide-react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** 顶层错误边界：渲染异常时展示友好错误提示而不是空白页 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    // 在开发环境保留 console，方便排查
    console.error('[BLG] 渲染异常:', error, info)
  }

  reset = () => {
    this.setState({ error: null })
    location.reload()
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="flex h-full w-full items-center justify-center px-6 text-[var(--color-fg)]">
        <div className="flex w-full max-w-lg flex-col gap-3 rounded-2xl border border-[var(--color-border)] bg-[var(--color-bg-1)] px-6 py-6 shadow-[0_1px_2px_oklch(0_0_0/0.04)]">
          <div className="flex items-center gap-2">
            <span
              className="flex h-8 w-8 items-center justify-center rounded-lg"
              style={{ background: 'var(--color-bg-sunken)', color: 'var(--color-accent-strong)' }}
            >
              <AlertTriangle size={16} />
            </span>
            <h2 className="text-[14px] font-medium">画布渲染出错</h2>
          </div>
          <p className="text-[12px] leading-relaxed text-[var(--color-fg-muted)]">
            Viewer 遇到了无法渲染的业务图数据。请先校验 graph.json 的结构和引用关系。
          </p>
          <p className="text-[11.5px] leading-relaxed text-[var(--color-fg-muted)]">
            建议：在插件目录里运行{' '}
            <code className="rounded bg-[var(--color-bg-2)] px-1 font-mono text-[11px]">
              node scripts/blg.mjs validate &lt;graph.json&gt;
            </code>{' '}
            按报错修复后重新加载。
          </p>
          <pre className="max-h-32 overflow-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-sunken)] p-2 font-mono text-[10.5px] text-[var(--color-fg-muted)]">
            {error.message}
          </pre>
          <div className="flex justify-end">
            <button
              onClick={this.reset}
              className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg-2)] px-3 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg-sunken)]"
            >
              重新加载
            </button>
          </div>
        </div>
      </div>
    )
  }
}
