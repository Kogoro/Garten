import { Component, type ErrorInfo, type ReactNode } from 'react';

/** A crash in one screen must not leave a blank page: say what happened, what is safe, and how to go on. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error('screen crashed:', error, info.componentStack); }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="crash" role="alert">
        <h1>Something went wrong on this screen</h1>
        <p>Your work is safe: everything you wrote is stored on this device and is sent with the next sync. Reload to continue; if it happens again, tell your administrator and include the text below.</p>
        <pre tabIndex={0} aria-label="Error details">{String(this.state.error?.message ?? this.state.error).slice(0, 500)}</pre>
        <div className="btns"><button type="button" className="btn primary" onClick={() => location.reload()}>Reload</button><button type="button" className="btn" onClick={() => { location.hash = '#/'; this.setState({ error: null }); }}>Back to Specs</button></div>
      </main>
    );
  }
}
