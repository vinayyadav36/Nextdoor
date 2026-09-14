import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
  message: string
}

export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(err: unknown): State {
    return {
      hasError: true,
      message: err instanceof Error ? err.message : String(err),
    }
  }

  componentDidCatch(error: unknown, info: unknown) {
    console.error('[ErrorBoundary] Caught:', error, info)
  }

  render() {
    if (!this.state.hasError) return this.props.children

    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          minHeight: '100vh',
          padding: '24px',
          fontFamily: 'system-ui, -apple-system, sans-serif',
          textAlign: 'center',
          backgroundColor: '#f8fafc',
          color: '#0f172a',
        }}
      >
        <div
          style={{
            maxWidth: '460px',
            width: '100%',
            padding: '28px',
            borderRadius: '16px',
            backgroundColor: '#ffffff',
            boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)',
            border: '1px solid #e2e8f0',
          }}
        >
          <div style={{ fontSize: '40px', marginBottom: '12px' }}>🚧</div>
          <h2 style={{ fontSize: '20px', fontWeight: 'bold', color: '#e11d48', margin: '0 0 12px 0' }}>
            Something went wrong
          </h2>
          <pre
            style={{
              fontSize: '12px',
              backgroundColor: '#f1f5f9',
              padding: '12px',
              borderRadius: '8px',
              fontFamily: 'monospace',
              textAlign: 'left',
              color: '#334155',
              border: '1px solid #cbd5e1',
              margin: '0 0 16px 0',
              overflowX: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {this.state.message}
          </pre>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            style={{
              backgroundColor: '#4f46e5',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              padding: '10px 18px',
              fontSize: '13px',
              fontWeight: '700',
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </div>
      </div>
    )
  }
}