# Rebuilding the dashboard's controls on shadcn/ui

Six phases, a PR each. Reasoning and the trade-offs live in
[ADR 0007](../../adr/0007-shadcn-on-base-ui-for-the-controls.md).

The watchlist table is not in scope and does not move. Every phase lands something that
stands on its own, so the run can stop early without leaving the dashboard half-built.

## What was established before planning

- Base UI ships **no CSS at all** — verified: zero stylesheets in the package, no `style`
  entry, no CSS exports, nothing injected at runtime. It provides state attributes
  (`data-open`, `data-highlighted`, `data-disabled`) and geometry variables
  (`--anchor-width`, `--available-height`, `--transform-origin`).
- **shadcn/ui runs on Base UI by default** since July 2026, so it supplies the styling for
  the same primitives rather than competing with them.
- **`--muted` collides.** Ours is a text colour used by `.meta`, `.legs`, `.health` and
  `.pending`; shadcn's is a background, with `--muted-foreground` for text. Unhandled, those
  four rules paint near-white text on white.
- **jsdom is missing** `ResizeObserver`, `IntersectionObserver`, `matchMedia`,
  `element.animate` and `scrollIntoView`. Phase 0 established this does **not** matter — Base
  UI 1.8.0 handles their absence. The planned setup file was written, proven to guard nothing,
  and deleted.
- **The add-forms have no tests.** 21 tests cover the table, mutations and column pickers;
  `AddMonitor` and `AddCombo` — which hold nine of the selects being replaced — have none.
- **Bundle:** 210 KB today, 417 KB with React plus the seven components in scope.

---

## Phase 0 — Setup

Nothing user-visible. The phase exists so that every later phase starts from a working build.

- `@tailwindcss/vite` (v4 — a Vite plugin, not PostCSS) plus what `shadcn init -b base -p nova`
  installs: `@base-ui/react` at **1.8.0 stable** (`@base-ui-components/react` is deprecated and
  renamed — the plan named the dead package), `cn`, `class-variance-authority`, `lucide-react`,
  `tw-animate-css`, and `shadcn` itself, which is **not** only a CLI: `app.css` imports
  `shadcn/tailwind.css` from it, so removing it breaks the build.
- `shadcn init`, which writes `components.json` and wants `@/*` path aliases in
  `tsconfig.json` and `vite.config.ts`. Components land in `src/components/ui/` and are
  **committed** — they are source, not vendored dependency.
- `@testing-library/user-event` as a dev dependency. Clicking through a custom dropdown with
  raw `fireEvent` is possible and miserable.
- ~~A setup file stubbing the five missing jsdom APIs.~~ Written, found to guard nothing,
  deleted. `Setup.test.tsx` stays as a smoke test that user-event can drive a portalled popup —
  the toolchain every later phase rests on.
- Dark mode: shadcn's dark tokens go inside the existing `@media (prefers-color-scheme: dark)`
  rule. Do **not** add the `@custom-variant dark (&:is(.dark *))` line and do not add a
  ThemeProvider — Tailwind's `dark:` variant follows the system by default, which is the
  behaviour to keep.
- Rename `--muted` at its four use sites. **Not theoretical**: `shadcn init` appends its tokens
  into the existing `:root` and overwrote `--muted: #666` with `oklch(0.97 0 0)` on the way,
  turning the status strip, the meta line and every leg summary into near-white text on white.
  Ours became `--dim`; `--muted` went back to shadcn.
- Handle **preflight**. Tailwind's reset strips form controls and flattens headings; shadcn
  needs it, the current controls do not survive it. A marked temporary block in `app.css`
  `revert`s those elements, to be deleted in pieces by phases 2-4.
- Decline the `nova` preset's **Geist webfont**. It would change every figure in the table.
  Point `--font-sans` at the existing system stack and uninstall it.
- `.gitignore`'s Python `lib/` rule swallows `frontend/src/lib/`, which shadcn creates and its
  components import. Needs a negation or a fresh clone cannot build.

**Done when:** `make build-ui`, `make check-ui` and `make test-ui` all pass with the bundle
committed, and the dashboard looks exactly as it does today.

## Phase 1 — Cover the add-forms as they are

No production code changes. Tests only, against the current native controls.

Write tests for `AddMonitor` and `AddCombo` that assert **what reaches the server** — the
POST body, its legs, their signs, blank rows skipped, IV absent from the combo field list —
rather than how the form was operated. Interaction lines will have to change in phase 4;
assertions should not.

**Done when:** creating a monitor and a six-leg combo are both covered, and the tests fail if
the request body changes shape.

## Phase 2 — The two real defects

The only phase that fixes things that are actually wrong today.

- **`AlertDialog` before delete.** `RowActions` and `MutedTables` both call `onDelete`
  straight from `onClick`. A misclick deletes a monitor with no confirmation, in a system
  whose stated invariant is that nothing is ever deleted without intent.
- **`Toast` for errors.** Errors currently render as `String(e)` in a banner that persists
  until the next successful poll, so a failure from thirty seconds ago is still on screen.
  Toasts expire; the banner stays for the version-skew notice, which *should* persist.

The existing `fireEvent.click(screen.getByText("delete"))` test changes to click through the
confirmation. That is the behaviour changing, correctly.

**Done when:** delete asks first, errors fade, and the skew banner still behaves as it did.

## Phase 3 — The controls around the table

- **`Popover` for the column pickers**, replacing `<details>`. Gains focus management and
  dismiss-on-Escape, which `<details>` has never had.
- **`NumberField` for every numeric input** — threshold, strike, entry, total. Fixes the
  wheel-scroll-changes-the-value problem that bare `<input type="number">` has.

Watch the `EntryCell` tests here: they find inputs by displayed value
(`getByDisplayValue("2.87")`). `NumberField.Input` still renders a real input, so those
should survive — confirm rather than assume.

**Done when:** pickers open and close properly, and no numeric input changes on scroll.

## Phase 4 — The forms

The largest phase and the one with the mobile regression in it.

- **`Select`** for all nine native selects — option type, field, direction, compare, and the
  six leg sign/type pairs.
- **`Field` / `Form`** for labels and validation messages, replacing the browser's default
  bubbles.

Phase 1's assertions are the contract: the request bodies must not change. Only the lines
that operate the controls should need rewriting.

**Known regression:** on a phone, native selects open the OS picker and these will not. This
was accepted knowingly (ADR 0007), and phase 4 is the point at which it becomes real. If it
reads badly on the phone, phases 0-3 are already banked and this one can be reverted alone.

**Done when:** both add-forms are rebuilt and phase 1's tests still pass unchanged in their
assertions.

## Phase 5 — Cleanup

- Delete whatever in `app.css` no longer earns its place. Keep the table rules, the `--fill`
  gradient and the domain colours; they have no shadcn equivalent and never will.
- Reconcile the palette properly: one token system, with any deliberate override carrying a
  comment saying why.
- Re-read the gridline decision against the live dashboard **at night**. `--border` moving
  from `#aaaaaa` to `#e5e5e5` was taken on the understanding it is one variable to change
  back. This is the moment to decide whether to change it.

**Done when:** there is one palette, and the table has been looked at in the dark.

---

## Checklist — all six landed as PRs #49-#54


- [x] Phase 0 — deps, aliases, jsdom stubs, dark-mode wiring, `--muted` rename
- [x] Phase 1 — tests covering both add-forms as they are
- [x] Phase 2 — AlertDialog before delete, Toast for errors
- [x] Phase 3 — Popover pickers, NumberField inputs
- [x] Phase 4 — Select and Field across both forms
- [x] Phase 5 — palette reconciled, gridlines judged at night
