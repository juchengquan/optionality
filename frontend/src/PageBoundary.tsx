import { Component, type ReactNode } from "react";

import { RawDetails } from "./shared/ErrorWords";

/** The whole page, drawn so that an error nothing nearer caught says so instead of leaving a blank
 *  screen. `DetailBoundary` keeps one holding's or one rule's detail from taking the page with it
 *  (#337); anything else that throws while rendering — the book, the header, a sheet — unmounted
 *  everything React had drawn, and the owner saw an empty page with no word of why.
 *
 *  It says so in plain words and offers a reload, which is all a page that cannot draw itself can do:
 *  the service is untouched, and every alarm still goes out by Telegram. The error's own text is kept
 *  as detail, folded under the sentence, for whoever reports it. */
export class PageBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: string } {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: unknown): void {
    console.error("the page could not be drawn:", error);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div className="nx-page-failed" role="alert" style={{ padding: "1rem", fontFamily: "system-ui, sans-serif" }}>
        <p>The page hit an error — reload to continue. The service and its alarms are not affected.</p>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
        {/* what was thrown, one tap away (part N, `ErrorWords`) */}
        <RawDetails plain="" raw={this.state.error} />
      </div>
    );
  }
}
