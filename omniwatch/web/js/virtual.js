// virtual.js — windowing math for the virtualized session list (§2.1:
// "virtualized over 200 rows"). Pure: given item heights and the scroll
// viewport, which slice to render and where it sits.

export const VIRTUALIZE_OVER = 200;

/** Prefix offsets: offsets[i] = top of item i; offsets[n] = total height. */
export function offsetsFor(heights) {
  const out = new Array(heights.length + 1);
  out[0] = 0;
  for (let i = 0; i < heights.length; i += 1) out[i + 1] = out[i] + heights[i];
  return out;
}

/** First index whose bottom edge is below `y` (binary search over offsets). */
export function indexAt(offsets, y) {
  let lo = 0;
  let hi = offsets.length - 2;
  if (hi < 0) return 0;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1] <= y) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * @param {number[]} heights
 * @param {number} scrollTop
 * @param {number} viewport
 * @param {{overscan?: number, threshold?: number, keep?: number}} [opts]
 *   keep: an index that must be rendered (the selection, for aria-activedescendant)
 * @returns {{start:number, end:number, padTop:number, padBottom:number, total:number, virtual:boolean}}
 */
export function windowFor(heights, scrollTop, viewport, { overscan = 8, threshold = VIRTUALIZE_OVER, keep = -1 } = {}) {
  const n = heights.length;
  const offsets = offsetsFor(heights);
  const total = offsets[n];
  if (n <= threshold) return { start: 0, end: n, padTop: 0, padBottom: 0, total, virtual: false };
  let start = Math.max(0, indexAt(offsets, Math.max(0, scrollTop)) - overscan);
  let end = Math.min(n, indexAt(offsets, scrollTop + Math.max(0, viewport)) + 1 + overscan);
  if (keep >= 0 && keep < n) {
    if (keep < start) start = keep;
    if (keep >= end) end = keep + 1;
  }
  return { start, end, padTop: offsets[start], padBottom: total - offsets[end], total, virtual: true };
}

/** scrollTop that brings item `i` fully into view (or null if already visible). */
export function scrollToReveal(offsets, i, scrollTop, viewport) {
  if (i < 0 || i >= offsets.length - 1) return null;
  const top = offsets[i];
  const bottom = offsets[i + 1];
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewport) return bottom - viewport;
  return null;
}
