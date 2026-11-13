import { Component, type ReactNode } from "react";

/** One holding's or one rule's detail — the desk's inspector, the phone's sheet — drawn so that if
 *  it throws, it alone says so and the page stays up. Without it a single row the page could not
 *  draw unmounted the whole of `/opt/next`: React drops a tree that throws while rendering and,
 *  with no boundary above, that tree is the page (#337, found as a row with no `spx` at all).
 *
 *  Keyed by the row at each place it is used, so the next row selected is drawn afresh. */
export class DetailBoundary extends Component<{ what: "holding" | "rule"; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error(`a ${this.props.what}'s detail could not be drawn:`, error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <p className="nx-meta nx-detail-failed" role="alert">{`this ${this.props.what} could not be drawn`}</p>;
  }
}
