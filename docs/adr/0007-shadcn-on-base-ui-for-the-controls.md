---
status: accepted
---

# shadcn/ui on Base UI for the dashboard's controls

The frontend has no dependencies beyond React — 950 lines, one dense table, a handful of
forms. It takes on Tailwind, a component library and roughly fifteen copied component files.
That is a large change to a small thing, and the reasoning should survive the decision.

## What was actually chosen

Not a design system. **Base UI** is headless: behaviour, focus management, keyboard handling,
ARIA and popup positioning, with no styling whatsoever — no stylesheets in the package, no
`style` entry, nothing injected at runtime. It hands back state attributes (`data-open`,
`data-highlighted`) and geometry variables (`--anchor-width`, `--available-height`) and leaves
every pixel to the author.

The alternative considered first was **Base Web**, Uber's design system, which is also widely
called "BaseUI". It was declined because it restyles everything, including the watchlist table,
and the table is the one screen that is read rather than operated. Two previous attempts to
make that screen denser or cleverer were rejected for the same reason.

**shadcn/ui** then arrived as a question rather than an alternative: since July 2026 it ships
on Base UI by default. So the real choice was never "Base UI or shadcn" but "write the styling
or start from theirs". Headless components are not cheap to style — one select is eleven parts,
a dialog is ten — and the estimate for styling this scope by hand was 400-600 lines of CSS.
That CSS *is* the work; the React changes around it are mechanical. shadcn supplies it written,
as source copied into the repo rather than a dependency resolved at install time, which is the
same instinct that already keeps the built bundle committed.

One correction worth recording, because it changed the outcome: Tailwind was first argued
against here as "a PostCSS step in a build that has none". That was wrong. Tailwind v4 ships
a first-party Vite plugin and needs no PostCSS. The objection was weaker than it was made to
sound, and the decision was revisited once that was checked.

## What this costs

- **Dependencies, from zero.** Tailwind, `clsx`, `tailwind-merge`, `lucide-react`, and Base UI
  itself. The components live in the tree; the rest do not.
- **Bundle roughly doubles**, 210 KB to 417 KB (+68 KB gzipped). Irrelevant over a tailnet with
  immutable asset caching; the real effect is that each frontend commit carries a larger file.
- **Native selects are lost.** Nine of them. On a phone a native `<select>` opens the OS picker
  and a custom listbox does not. This is a real regression for mobile use, accepted knowingly.
- **Base UI is at `1.8.0`, stable.** Corrected during phase 0: the package researched while
  planning, `@base-ui-components/react`, is deprecated and renamed to `@base-ui/react`. The
  plan named the dead package and called it a release candidate. It is neither, and the risk
  recorded here was imaginary.

## Two decisions inside it that will look arbitrary later

**The palette collapses onto shadcn's tokens, gridlines included.** The dashboard's own
`--muted` was a *text* colour; shadcn's `--muted` is a *background*, with `--muted-foreground`
for text. Left alone, four rules — the status strip, the meta line, every combo's leg summary —
would have painted near-white text on white. Rather than keep two palettes, one system is
adopted wholesale. The knowing cost is the table's gridlines going from `#aaaaaa` to `#e5e5e5`,
which on a dense bordered grid is the difference between structure and suggestion. Taken on the
understanding that it is one variable to override if it reads badly at night.

**Dark mode stays automatic.** shadcn's documented setup is a ThemeProvider, a localStorage key,
a class on the root element and a Light/Dark/System dropdown. The dashboard's is four lines of
CSS and no JavaScript, following the system. The dark tokens go into the existing
`prefers-color-scheme` rule and the provider is skipped; Tailwind's `dark:` variant defaults to
the media query, and only shadcn's setup switches it to the class, so the switch is simply not
made. No toggle, because there is no one to disagree with the system setting.

## Consequences

- The watchlist table gains no component. Nothing in the library applies to a grid of numbers,
  and it keeps its structure — only its colours move.
- Every interaction test that drives a `<select>` or clicks `delete` has to be rewritten: a
  custom dropdown is not a control you set a value on, and `delete` now opens a dialog first.
- The test environment needs **no** stubs, contrary to what was planned here. jsdom does lack
  `ResizeObserver`, `IntersectionObserver`, `matchMedia`, `element.animate` and
  `scrollIntoView`, and inferring that Base UI would therefore crash was reasonable and wrong:
  1.8.0 guards their absence itself. Verified in phase 0 by running Select, Popover and
  AlertDialog with the stubs removed. They were deleted rather than shipped dead.
- Tailwind's **preflight** is not optional and is not invisible. It strips form controls back
  to nothing and flattens headings to body text. shadcn's components require it; the controls
  still on screen do not survive it. `app.css` carries a temporary `revert` block to be
  removed in pieces as phases 2-4 replace those elements.

## Outcome

All six phases landed. Every control on the dashboard is a shadcn component; the watchlist
table kept its structure and changed only its colours, as intended.

**The selects stayed native.** This ADR recorded losing the phone's OS picker as a knowing
cost, on the author's account that it was unavoidable. It was not: shadcn ships
`native-select`, a real `<select>` wearing the same styling. The regression was designed out
in phase 4 rather than accepted. What a headless listbox would have bought — styling the open
list — is worth nothing here, where the longest list is six field names in plain text.

**Two of this ADR's stated risks were imaginary**, both from research rather than from doing.
The package named while planning is deprecated and renamed, and is stable rather than a
release candidate. The jsdom stubs called essential guard nothing, verified by running the
components without them.

**The real costs were the ones nobody wrote down.** Tailwind's preflight is neither optional
nor invisible and needed a temporary compatibility layer for four phases. `shadcn init`
overwrote `--muted` on its way past, silently turning four rules near-white on white.
`.gitignore`'s Python `lib/` rule swallowed the directory shadcn creates. None of those
appear in the plan; all three would have broken something.

**A regression was introduced and found by audit, not by tests.** The poll's guard against
reloading mid-edit named `details`, and phase 4 retired that element — so the column pickers
silently stopped being protected. It is a tested function now. The lesson generalises: a
list of selectors describing "the controls" rots the moment a control is replaced, and
nothing about replacing it makes a test fail.

**Bundle:** 210 KB to 417 KB of JavaScript, 2.4 KB to 54.5 KB of CSS. Predicted at roughly
double; came in slightly over that.

**Still open:** the table's gridlines went from `#aaaaaa` to `#e5e5e5` in light and from
`#383d46` to a translucent white near `#232323` in dark. Taken deliberately, on the
understanding that it is one variable per block to put back. It wants judging against live
data at night before it counts as settled.
