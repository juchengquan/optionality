/** PROTOTYPE — throwaway. Variant A: placeholder until its direction is built. */
import type { VariantProps } from "../types";

export const name = "placeholder";

export function VariantA({ book, mode }: VariantProps) {
  return <pre className="p-4 text-xs">{mode} · {book.candidates.length} candidates · {book.holdings.length} holdings</pre>;
}
