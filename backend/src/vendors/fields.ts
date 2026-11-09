/** Every vendor's PURE field mapping, behind a door of its own.
 *
 *  What a vendor said, turned into the service's names. These functions open no connection and
 *  hold no state, and they are canonical: `yahooFields.toRecord` decides which Yahoo number
 *  becomes the figure a Reference shows, and `ibkrFields.greekFields` decides that IBKR's implied
 *  volatility changes units. `cases.test.ts` cases none of it, because it holds its module list to
 *  the `domain/` DIRECTORY and these are not in it — so `testdata/vendors/` does, through here.
 *
 *  ## Why this is a second door rather than part of `index.ts`
 *
 *  Measured, after trying it the other way. Re-exporting these from `index.ts` typechecks the
 *  WHOLE vendor graph into whatever imports it: `index.ts` reaches `opend/vendor.ts`, which reaches
 *  `opend/client.ts`, which needs the moomoo SDK's declarations. The case generator then failed to
 *  typecheck for want of `moomoo-api` types — a corpus of pure arithmetic, held up by an SDK it
 *  never calls.
 *
 *  So the widening happens here instead, in a file whose only job is to say which parts are pure.
 *  It imports nothing but the two `fields.ts` modules, so nothing that reaches for the mapping
 *  pulls a socket or an SDK behind it. `check-seams` lists it as a door; `never` still forbids a
 *  `client.ts` or a `vendor.ts` from ever becoming one.
 */
export * as ibkrFields from "./ibkr/fields.ts";
export * as yahooFields from "./yahoo/fields.ts";
