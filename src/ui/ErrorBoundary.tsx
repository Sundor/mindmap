// The last line of defence: an error thrown while the viewer draws would otherwise leave an
// empty page with nothing to read and nothing to click.

import { Component, type ReactNode } from 'react';

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly message?: string;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = {};

  static getDerivedStateFromError(error: unknown): State {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  override render(): ReactNode {
    const { message } = this.state;
    if (message === undefined) return this.props.children;
    return (
      <div id="viewer-error" className="empty-state" role="alert">
        <h2>The viewer stopped</h2>
        <p>Something went wrong while drawing the map: {message}</p>
        <p>
          <button type="button" className="primary" onClick={() => window.location.reload()}>
            Reload
          </button>
        </p>
        <p className="hint">
          If it happens again with the same data, the data file is the likely cause.
        </p>
      </div>
    );
  }
}
