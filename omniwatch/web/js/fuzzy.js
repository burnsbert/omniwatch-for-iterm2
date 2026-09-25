// fuzzy.js — case-insensitive subsequence fuzzy match, ported verbatim
// from Ultrawatch's `ultrawatch_lib/ui/draw.py:fuzzy_match` (P-59), plus a
// scored/ranked variant for the command palette (§2.5: "matched characters
// highlighted", §5 JS-unit target "command palette ranking").

/**
 * True if every character of `needle` (case-insensitive) appears in
 * `haystack`, in order, not necessarily contiguous. An empty needle always
 * matches (parity with the TUI: an empty filter shows everything).
 */
export function fuzzyMatch(needle, haystack) {
  if (!needle) return true;
  const n = needle.toLowerCase();
  const h = (haystack || '').toLowerCase();
  let pos = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, pos);
    if (found < 0) return false;
    pos = found + 1;
  }
  return true;
}

/**
 * Like fuzzyMatch, but also returns the matched character indices (for
 * highlighting) and a score used to rank multiple matches. Matching is
 * greedy-earliest per fuzzyMatch (same semantics/compatibility), and the
 * score rewards: an earlier match start, contiguous runs, and matches at
 * word boundaries (after a space, '/', or the string start).
 *
 * @returns {{matched: boolean, score: number, indices: number[]}}
 */
export function fuzzyScore(needle, haystack) {
  if (!needle) return { matched: true, score: 0, indices: [] };
  const n = needle.toLowerCase();
  const h = (haystack || '').toLowerCase();
  const indices = [];
  let pos = 0;
  let score = 0;
  let prevIndex = -2;
  for (let i = 0; i < n.length; i += 1) {
    const found = h.indexOf(n[i], pos);
    if (found < 0) return { matched: false, score: -Infinity, indices: [] };
    indices.push(found);
    // Contiguous with the previous match char: strong bonus.
    if (found === prevIndex + 1) {
      score += 8;
    } else {
      score += 1;
    }
    // Boundary bonus: start of string, or right after a separator.
    if (found === 0 || ' /-_.'.includes(h[found - 1])) {
      score += 4;
    }
    prevIndex = found;
    pos = found + 1;
  }
  // Prefer matches that start earlier and are packed more tightly overall.
  const span = indices[indices.length - 1] - indices[0] + 1;
  score += Math.max(0, 20 - indices[0]); // earlier start is better
  score += Math.max(0, 20 - (span - n.length)); // less "spread out" is better
  return { matched: true, score, indices };
}

/**
 * Filter+rank `items` by fuzzy match against `getText(item)`, best first.
 * Non-matching items are dropped. Ties keep the original relative order
 * (stable sort).
 *
 * @template T
 * @param {string} needle
 * @param {T[]} items
 * @param {(item: T) => string} getText
 * @returns {{item: T, score: number, indices: number[]}[]}
 */
export function rankFuzzyMatches(needle, items, getText) {
  const scored = [];
  items.forEach((item, order) => {
    const { matched, score, indices } = fuzzyScore(needle, getText(item));
    if (matched) scored.push({ item, score, indices, order });
  });
  scored.sort((a, b) => (b.score - a.score) || (a.order - b.order));
  return scored.map(({ item, score, indices }) => ({ item, score, indices }));
}
