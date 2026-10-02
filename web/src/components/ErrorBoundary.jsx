import React from 'react';

/**
 * Bryntum's trial components throw when the trial has run out in this browser (it keeps its start date in localStorage).
 * Without a boundary that blanks the whole page, so the board and calendar sit behind one and the rest of the app carries on.
 */
export default class ErrorBoundary extends React.Component {
  state = { failed: false, message: '' };
  static getDerivedStateFromError(error) { return { failed: true, message: String(error?.message ?? error).slice(0, 160) }; }
  componentDidCatch(error) { console.warn('Bryntum component failed to start:', error?.message); }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="fallback" role="alert">
        <h3>The {this.props.what} could not start</h3>
        <p>The Bryntum trial licence in this browser has probably run out, or the component hit an error. Nothing is lost: every case, block and deadline is still on the server.</p>
        {this.props.alternative}
        <p className="muted small">To bring it back, clear this site's data in the browser settings, which resets the trial clock, or install licensed Bryntum packages (see the README). Detail: {this.state.message}</p>
      </div>
    );
  }
}
