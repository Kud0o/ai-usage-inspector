// Provider-neutral cost primitives. Every provider's pricing module produces the
// same cost object — { input, output, cacheWrite, cacheRead, total } in USD — so
// the viewer's cards/charts work identically regardless of which AI tool the
// usage came from. Per-token rates and the usage-field mapping live in each
// provider's own pricing.mjs.

export const M = 1_000_000;

export function zeroCost() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addCost(a, b) {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}
