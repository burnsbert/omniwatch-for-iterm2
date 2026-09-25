// sparkline.js — SVG path geometry for usage sparklines (API.md §5
// UsageHistory `points: [[epoch, pct], …]`). Pure; the component draws the
// returned path strings with dom.js `svg()`.

/**
 * @param {[number, number][]} points oldest first
 * @param {{width:number, height:number, from?:number, to?:number, max?:number, pad?:number}} opts
 * @returns {{line:string, area:string, last:{x:number,y:number,pct:number}|null, min:number, max:number}|null}
 */
export function sparkGeometry(points, { width, height, from, to, max = 100, pad = 1.5 } = {}) {
  const pts = (points || []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < 2) return null;
  const t0 = from != null ? from : pts[0][0];
  const t1 = to != null ? to : pts[pts.length - 1][0];
  const span = Math.max(1, t1 - t0);
  const top = Math.max(max, ...pts.map((p) => p[1]));
  const x = (t) => pad + ((t - t0) / span) * (width - 2 * pad);
  const y = (v) => pad + (1 - Math.max(0, v) / top) * (height - 2 * pad);
  const coords = pts.map(([t, v]) => [round(x(t)), round(y(v))]);
  const line = coords.map(([a, b], i) => `${i ? 'L' : 'M'}${a} ${b}`).join(' ');
  const base = round(height - pad);
  const area = `${line} L${coords[coords.length - 1][0]} ${base} L${coords[0][0]} ${base} Z`;
  const lastP = pts[pts.length - 1];
  return {
    line,
    area,
    last: { x: coords[coords.length - 1][0], y: coords[coords.length - 1][1], pct: lastP[1] },
    min: Math.min(...pts.map((p) => p[1])),
    max: Math.max(...pts.map((p) => p[1])),
  };
}

function round(v) {
  return Math.round(v * 10) / 10;
}

/** Keep only points inside [from, to] (for a strip that shows the last N hours). */
export function windowPoints(points, from, to) {
  return (points || []).filter((p) => p[0] >= from && p[0] <= to);
}
