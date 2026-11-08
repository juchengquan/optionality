`shadcn add` output, kept exactly as it lands: 24 of the 55 names in here have no consumer outside
this directory, and they stay anyway — pruning them is what makes the next `shadcn add` or upgrade a
manual merge instead of a copy, which is the one property that makes vendored components cheap. A
sweep for unused exports should skip this directory rather than re-find them.
