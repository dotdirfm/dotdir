import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level error boundary that catches React render errors
 * and shows a recoverable error overlay instead of crashing the app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      const { error } = this.state;
      return (
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 99999,
            background: "var(--bg, #1e1e2e)",
            color: "var(--fg, #cdd6f4)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            fontFamily: "system-ui, -apple-system, sans-serif",
            padding: 32,
          }}
        >
          <h2 style={{ margin: "0 0 12px", color: "var(--error-fg, #f38ba8)" }}>Something went wrong</h2>
          <pre
            style={{
              maxWidth: "80vw",
              maxHeight: "40vh",
              overflow: "auto",
              background: "rgba(0,0,0,.3)",
              padding: 16,
              borderRadius: 8,
              fontSize: 13,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {error.name}: {error.message}
            {error.stack && `\n\n${error.stack}`}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 20,
              padding: "8px 24px",
              fontSize: 14,
              background: "var(--accent, #89b4fa)",
              color: "#1e1e2e",
              border: "none",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Try to recover
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
