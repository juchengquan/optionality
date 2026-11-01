/** The four JavaScript behaviours a port has to reproduce, named so they can be cased (ADR 0017).
 *
 *  Wrapping `Math.round` in a module looks redundant for a second and then does not. The Python's
 *  `_js.py` reimplements these by hand, with the divergences written in its docstring — and a
 *  docstring is not a check. Measured against real JavaScript on 2026-11-01 it differed five ways
 *  (`Number(null)`, `Number("0x10")`, `Number([])`, `truthy([])`, and `Math.round(-0.5)`), and
 *  every one was unreachable only because all six call sites guard null before calling `number`.
 *  The port was correct because its callers were disciplined, not because it was right.
 *
 *  So these four are stated as part of the contract, where the case machinery can hold them: the
 *  directory is the fact, so `domain/js.ts` existing is what demands the cases and the port.
 *
 *  They are not used by the service — `Math.round` and `Number` are written directly wherever the
 *  TypeScript needs them, because in TypeScript they ARE the language. This module exists to be
 *  compared against, which is why it is the one domain module with no caller.
 */

/** Ties toward +Infinity, where Python's `round` ties to even: 12.5 is 13 and -2.5 is -2. */
export const mathRound = (x: number): number => Math.round(x);

/** Rounds the EXACT binary value and ties away from zero, where Python's `round` ties to even:
 *  0.03125 to four places is 0.0313 here and 0.0312 under `round`. Returned as a number, which is
 *  how every caller uses it — `Number(x.toFixed(d))`, never the string. */
export const toFixed = (x: number, digits: number): number => Number(x.toFixed(digits));

/** `Number(v)`: what a quote field becomes when it is read as a figure. moomoo can send a string,
 *  so this is reached with text, and JavaScript's string rules are wider than Python's `float` —
 *  hex, binary and octal literals, `Infinity`, and the empty string, which is 0 rather than an
 *  error. `null` is 0; an object is NaN; an array is its join, so `[]` is 0 and `[5]` is 5. */
export const number = (value: unknown): number => Number(value);

/** `if (v)`: JavaScript's truthiness, which differs from Python's on NaN (falsy in both, but
 *  Python reaches it by a different route) and on containers — `[]` and `{}` are TRUTHY here and
 *  falsy in Python, and `"0"` is truthy in both. */
export const truthy = (value: unknown): boolean => Boolean(value);
