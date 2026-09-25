// icons.js — inline SVG icon set (16×16, 1.5 px strokes, currentColor) and
// the session state glyphs (P-27). Built with dom.js `svg()` so nothing is
// parsed as markup; icons are decorative (`aria-hidden`) unless a title is
// given, in which case they get role="img" + <title>.

import { svg } from '../dom.js';

// Each entry: list of [tag, attrs] drawn inside a 16×16 viewBox.
const P = (d) => ['path', { d }];
const C = (cx, cy, r, extra = {}) => ['circle', { cx, cy, r, ...extra }];
const R = (x, y, w, h, rx = 1.5, extra = {}) => ['rect', { x, y, width: w, height: h, rx, ...extra }];

const ICONS = {
  search: [C(7, 7, 4.25), P('M10.25 10.25 13.5 13.5')],
  sort: [P('M5 3v10M2.5 10.5 5 13l2.5-2.5'), P('M11 13V3M8.5 5.5 11 3l2.5 2.5')],
  split: [R(2, 3, 12, 10), P('M6.5 3v10')],
  list: [P('M5.5 4.5h8M5.5 8h8M5.5 11.5h8'), C(2.75, 4.5, 0.6, { fill: 'currentColor' }), C(2.75, 8, 0.6, { fill: 'currentColor' }), C(2.75, 11.5, 0.6, { fill: 'currentColor' })],
  grid: [R(2.25, 2.25, 5, 5, 1.2), R(8.75, 2.25, 5, 5, 1.2), R(2.25, 8.75, 5, 5, 1.2), R(8.75, 8.75, 5, 5, 1.2)],
  gear: [C(8, 8, 2.1), P('M8 1.75v1.6M8 12.65v1.6M14.25 8h-1.6M3.35 8h-1.6M12.42 3.58l-1.13 1.13M4.71 11.29l-1.13 1.13M12.42 12.42l-1.13-1.13M4.71 4.71 3.58 3.58')],
  close: [P('M4 4l8 8M12 4l-8 8')],
  check: [P('M3.25 8.5 6.5 11.5 12.75 4.75')],
  chevronDown: [P('M4 6l4 4 4-4')],
  chevronUp: [P('M4 10l4-4 4 4')],
  chevronRight: [P('M6 4l4 4-4 4')],
  goto: [P('M6 3.5h6.5V10'), P('M12.5 3.5 4 12')],
  zoom: [P('M9.5 2.75h3.75V6.5M6.5 13.25H2.75V9.5M13.25 2.75 9 7M2.75 13.25 7 9')],
  more: [C(3.5, 8, 1, { fill: 'currentColor', stroke: 'none' }), C(8, 8, 1, { fill: 'currentColor', stroke: 'none' }), C(12.5, 8, 1, { fill: 'currentColor', stroke: 'none' })],
  refresh: [P('M13 8a5 5 0 1 1-1.46-3.54'), P('M13 2.75v3h-3')],
  pencil: [P('M10.5 2.75 13.25 5.5 5.75 13H3v-2.75z'), P('M9 4.25 11.75 7')],
  trash: [P('M2.75 4.25h10.5M6.25 4V2.75h3.5V4M4.25 4.25l.6 8.5c.05.6.55 1 1.15 1h4c.6 0 1.1-.4 1.15-1l.6-8.5')],
  keyboard: [R(1.75, 4, 12.5, 8, 1.5), P('M4.5 6.75h.01M7 6.75h.01M9.5 6.75h.01M12 6.75h.01M5 9.5h6')],
  command: [P('M6 6V4.25a1.75 1.75 0 1 0-1.75 1.75H6zm0 0h4m-4 0v4m4-4V4.25A1.75 1.75 0 1 1 11.75 6H10zm0 0v4m0 0h1.75A1.75 1.75 0 1 1 10 11.75V10zm0 0H6m0 0v1.75A1.75 1.75 0 1 1 4.25 10H6z')],
  bell: [P('M4 11.25V7.5a4 4 0 0 1 8 0v3.75l1.25 1.25H2.75z'), P('M6.5 14h3')],
  bellOff: [P('M4 11.25V7.5c0-.8.24-1.55.65-2.18M6 4.1A4 4 0 0 1 12 7.5v3.2M11.5 12.5H2.75L4 11.25'), P('M6.5 14h3'), P('M2 2l12 12')],
  pin: [P('M9.75 2.25 13.75 6.25 11.5 7.25 8.75 10v2.5l-5.25-5.25H6l2.75-2.75z'), P('M5.75 10.25 2.5 13.5')],
  dollar: [P('M8 1.75v12.5M11 4.5c-.5-.9-1.6-1.5-3-1.5-1.8 0-3 1-3 2.3 0 3.2 6.2 1.9 6.2 5 0 1.4-1.3 2.4-3.2 2.4-1.5 0-2.7-.6-3.2-1.6')],
  sun: [C(8, 8, 2.75), P('M8 1.5v1.25M8 13.25v1.25M14.5 8h-1.25M2.75 8H1.5M12.6 3.4l-.9.9M4.3 11.7l-.9.9M12.6 12.6l-.9-.9M4.3 4.3l-.9-.9')],
  moon: [P('M13.25 9.75A5.5 5.5 0 0 1 6.25 2.75a5.5 5.5 0 1 0 7 7z')],
  contrast: [C(8, 8, 5.75), ['path', { d: 'M8 2.25v11.5a5.75 5.75 0 0 0 0-11.5z', fill: 'currentColor', stroke: 'none' }]],
  monitor: [R(1.75, 2.75, 12.5, 8.5, 1.5), P('M5.5 13.75h5M8 11.25v2.5')],
  terminal: [R(1.75, 2.75, 12.5, 10.5, 1.75), P('M4.5 6.25 6.75 8.25 4.5 10.25M8.5 10.25h3')],
  shield: [P('M8 1.75 13.25 3.75v4c0 3.1-2.2 5.4-5.25 6.5C4.95 13.15 2.75 10.85 2.75 7.75v-4z'), P('M5.75 8 7.25 9.5 10.25 6.5')],
  palette: [P('M8 1.75a6.25 6.25 0 0 0 0 12.5c.9 0 1.25-.6 1.25-1.2 0-.9-.8-1.3-.8-2.05 0-.7.55-1.25 1.25-1.25h1.55a3 3 0 0 0 3-3c0-2.75-2.8-5-6.25-5z'), C(5, 6.75, 0.75, { fill: 'currentColor', stroke: 'none' }), C(8, 4.75, 0.75, { fill: 'currentColor', stroke: 'none' }), C(11, 6.75, 0.75, { fill: 'currentColor', stroke: 'none' })],
  plus: [P('M8 3v10M3 8h10')],
  send: [P('M2.25 7.75 13.75 2.25 10.25 13.75 7.75 8.25z'), P('M7.75 8.25 13.75 2.25')],
  alert: [P('M8 2.25 14.25 13.25H1.75z'), P('M8 6.5v3M8 11.5h.01')],
  info: [C(8, 8, 6), P('M8 7.25v3.75M8 5h.01')],
  sparkles: [P('M6.5 2.5 7.6 5.4 10.5 6.5 7.6 7.6 6.5 10.5 5.4 7.6 2.5 6.5 5.4 5.4z'), P('M11.75 9.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z')],
  gauge: [P('M2.25 11.5a5.75 5.75 0 1 1 11.5 0'), P('M8 11.5 10.75 6.75'), C(8, 11.5, 0.9, { fill: 'currentColor' })],
  folder: [P('M1.75 4.25c0-.55.45-1 1-1h3.1l1.4 1.5h6c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1z')],
  grip: [C(6, 4, 0.9, { fill: 'currentColor', stroke: 'none' }), C(10, 4, 0.9, { fill: 'currentColor', stroke: 'none' }), C(6, 8, 0.9, { fill: 'currentColor', stroke: 'none' }), C(10, 8, 0.9, { fill: 'currentColor', stroke: 'none' }), C(6, 12, 0.9, { fill: 'currentColor', stroke: 'none' }), C(10, 12, 0.9, { fill: 'currentColor', stroke: 'none' })],
  external: [P('M9 2.75h4.25V7M13.25 2.75 7.5 8.5'), P('M11.5 9.5v3c0 .4-.35.75-.75.75h-7c-.4 0-.75-.35-.75-.75v-7c0-.4.35-.75.75-.75h3')],
  arrowDown: [P('M8 3v10M4 9l4 4 4-4')],
  copy: [R(5.25, 5.25, 8, 8, 1.5), P('M10.75 5.25V3.5c0-.4-.35-.75-.75-.75H3.5c-.4 0-.75.35-.75.75V10c0 .4.35.75.75.75h1.75')],
  mail: [R(1.75, 3.25, 12.5, 9.5, 1.5), P('M2.25 4 8 8.5 13.75 4')],
  eye: [P('M1.5 8s2.5-4.75 6.5-4.75S14.5 8 14.5 8 12 12.75 8 12.75 1.5 8 1.5 8z'), C(8, 8, 2)],
  logo: [C(8, 8, 6.25), C(8, 8, 2.75, { fill: 'currentColor', stroke: 'none' })],
  play: [P('M5 3.25v9.5L12.5 8z')],
  tag: [P('M2.25 2.25h5.5l6 6-5.5 5.5-6-6z'), C(5.25, 5.25, 0.9, { fill: 'currentColor', stroke: 'none' })],
};

/**
 * @param {string} name
 * @param {{size?:number, cls?:string, title?:string}} [opts]
 */
export function icon(name, { size = 16, cls = '', title = '' } = {}) {
  const shapes = ICONS[name] || ICONS.info;
  const children = shapes.map(([tag, attrs]) => svg(tag, attrs));
  if (title) children.unshift(svg('title', {}, title));
  return svg('svg', {
    class: `ow-icon ow-icon-${name}${cls ? ` ${cls}` : ''}`,
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': 1.5,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': title ? undefined : 'true',
    role: title ? 'img' : undefined,
    focusable: 'false',
  }, children);
}

export const ICON_NAMES = Object.freeze(Object.keys(ICONS));

/**
 * State glyph (P-27): distinct shapes, not just colors — ◉ waiting (ring +
 * dot), busy (spinning arc; static under reduced motion), ○ idle (ring),
 * · output (small dot), quiet (dim dash), unknown (dashed ring).
 */
export function stateIcon(state, { size = 14, muted = false } = {}) {
  let shapes;
  switch (state) {
    case 'waiting':
      shapes = [svg('circle', { cx: 8, cy: 8, r: 6, 'stroke-width': 1.75 }), svg('circle', { cx: 8, cy: 8, r: 2.75, fill: 'currentColor', stroke: 'none' })];
      break;
    case 'busy':
      shapes = [
        svg('circle', { cx: 8, cy: 8, r: 5.75, 'stroke-width': 2, opacity: 0.22 }),
        svg('path', { d: 'M8 2.25a5.75 5.75 0 0 1 5.75 5.75', 'stroke-width': 2, class: 'ow-spin-arc' }),
      ];
      break;
    case 'idle':
      shapes = [svg('circle', { cx: 8, cy: 8, r: 5.25, 'stroke-width': 1.75 })];
      break;
    case 'active':
      shapes = [svg('circle', { cx: 8, cy: 8, r: 2.75, fill: 'currentColor', stroke: 'none' })];
      break;
    case 'quiet':
      shapes = [svg('path', { d: 'M5 8h6', 'stroke-width': 1.75 })];
      break;
    default:
      shapes = [svg('circle', { cx: 8, cy: 8, r: 5.25, 'stroke-dasharray': '2 2.2' })];
  }
  return svg('svg', {
    class: `ow-state ow-state-${state || 'unknown'}${muted ? ' is-muted' : ''}`,
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-linecap': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
  }, shapes);
}
