import React from "react";

interface State {
  error: Error | null;
  info: React.ErrorInfo | null;
}

/**
 * Catches render-time exceptions anywhere in the tree and shows the message +
 * stack instead of a blank window. Without this, an uncaught error unmounts the
 * React root and the user sees only the dark background ("black screen of
 * death") with no signal about what failed.
 */
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, info: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    this.setState({ error, info });
    // Surface to the console too so it shows up in dev tooling.
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    const { error, info } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          position: "fixed",
          inset: 0,
          overflow: "auto",
          padding: "24px",
          background: "#1a1010",
          color: "#ffd9d9",
          font: "12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace",
          zIndex: 99999,
        }}
      >
        <div style={{ color: "#ff6b6b", fontWeight: 700, fontSize: "14px", marginBottom: "12px" }}>
          Something crashed
        </div>
        <div style={{ whiteSpace: "pre-wrap", marginBottom: "16px" }}>{String(error.message || error)}</div>
        {error.stack && (
          <pre style={{ whiteSpace: "pre-wrap", color: "#e0a0a0", margin: 0 }}>{error.stack}</pre>
        )}
        {info?.componentStack && (
          <pre style={{ whiteSpace: "pre-wrap", color: "#a08080", marginTop: "12px" }}>
            {info.componentStack}
          </pre>
        )}
      </div>
    );
  }
}
