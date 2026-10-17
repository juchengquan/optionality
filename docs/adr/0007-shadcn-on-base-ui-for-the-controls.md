# 7. shadcn/ui on Base UI for the dashboard's controls

Date: 2026-09-24

## Status

Accepted.

## Decision

The controls are **shadcn/ui** components on **Base UI**: headless behaviour — focus, keyboard,
ARIA, popup positioning — with every pixel styled in this repo. Since July 2026 shadcn ships on
Base UI by default, so the real choice was "write the styling or start from theirs"; styling this
scope by hand was estimated at 400-600 lines of CSS, and shadcn supplies it as source copied into
the repo rather than a dependency resolved at install, the same instinct that commits the bundle.
Tailwind v4 comes with it through its first-party Vite plugin (no PostCSS).

**Base Web**, Uber's design system and also called "BaseUI", was declined: it restyles everything,
including the watchlist table, and that table is the one screen that is read rather than operated.

## Two decisions inside it that will look arbitrary later

- **One palette: shadcn's tokens, gridlines included.** The dashboard's own `--muted` was a text
  colour; shadcn's is a background. Keeping two palettes would paint near-white text on white, so
  one system is adopted wholesale. The knowing cost is the table's gridlines going from `#aaaaaa`
  to `#e5e5e5` (dark: `#383d46` to a translucent white) — one variable per block to put back if it
  reads badly against live data at night, which is still to be judged.
- **Dark mode follows the system, with no toggle.** shadcn's setup is a ThemeProvider, a
  localStorage key and a root class; this is the `prefers-color-scheme` rule and no JavaScript.
  There is no one to disagree with the system setting.

## Consequences

- The watchlist table gains no component; it keeps its structure and only its colours move.
- **Selects stay native** (shadcn's `native-select`), so a phone opens its OS picker. Losing that
  was first accepted as a cost; it turned out not to be necessary.
- Tailwind, `clsx`, `tailwind-merge`, `lucide-react` and Base UI become dependencies, and the
  bundle roughly doubled (210 KB to 417 KB of JavaScript) — irrelevant over a tailnet.
