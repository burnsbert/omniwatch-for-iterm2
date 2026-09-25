// dom.js — safe DOM element builder.
//
// Rule: never assign to `innerHTML` (or `outerHTML`) with dynamic text.
// Session/agent text always comes from the backend and is untrusted for
// markup purposes (CSP forbids inline scripts anyway, but this also blocks
// HTML-injection via crafted session names/labels/screen text). Every
// string value passed to these helpers becomes a text node or an attribute
// value, never parsed as markup.
//
// Every function takes an optional trailing `doc` (a Document-like object)
// so this module has no hard dependency on a global `document` and can be
// unit-tested in Node with a minimal fake. In a real browser, omit `doc`
// and the global `document` is used.

function resolveDoc(doc) {
  if (doc) return doc;
  if (typeof document !== 'undefined') return document;
  throw new Error('dom.js: no document available; pass one explicitly');
}

const BOOLEAN_ATTRS = new Set([
  'disabled', 'checked', 'selected', 'readonly', 'required', 'multiple',
  'hidden', 'autofocus', 'open',
]);

/**
 * Append a child value to `el`. Strings/numbers become text nodes. Nodes
 * are appended as-is. null/undefined/false/true are skipped (so
 * `cond && h(...)` works as a conditional child). Arrays are flattened.
 */
function appendChild(el, child, doc) {
  if (child === null || child === undefined || child === false || child === true) {
    return;
  }
  if (Array.isArray(child)) {
    for (const c of child) appendChild(el, c, doc);
    return;
  }
  if (typeof child === 'string' || typeof child === 'number') {
    el.appendChild(doc.createTextNode(String(child)));
    return;
  }
  // Assume it's already a Node (Element, Text, DocumentFragment, ...).
  el.appendChild(child);
}

/**
 * Set a single property/attribute on `el`. See `h()` for the supported
 * keys. Never touches innerHTML/outerHTML.
 */
function applyProp(el, key, value) {
  if (value === undefined) return;
  if (key === 'class' || key === 'className') {
    const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
    if (cls) el.className = cls;
    return;
  }
  if (key === 'style') {
    if (typeof value === 'string') {
      el.setAttribute('style', value);
    } else if (value && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) {
        if (v === undefined || v === null) continue;
        el.style.setProperty(prop, String(v));
      }
    }
    return;
  }
  if (key === 'dataset') {
    if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) {
        if (v === undefined || v === null) continue;
        el.dataset[k] = String(v);
      }
    }
    return;
  }
  if (key.startsWith('on') && key.length > 2 && typeof value === 'function') {
    const evt = key[2].toLowerCase() + key.slice(3);
    el.addEventListener(evt, value);
    return;
  }
  if (value === null || value === false) {
    el.removeAttribute(key);
    return;
  }
  if (value === true) {
    // Boolean attribute (e.g. disabled, checked) — presence-only.
    el.setAttribute(key, BOOLEAN_ATTRS.has(key) ? '' : 'true');
    return;
  }
  el.setAttribute(key, String(value));
}

/**
 * Build a DOM element without ever touching innerHTML.
 *
 *   h('div', {class: 'row', 'aria-selected': true}, ['hello ', nameNode])
 *   h('button', {onClick: fn, class: ['btn', active && 'btn-active']}, 'Go')
 *
 * @param {string} tag
 * @param {object} [props]
 * @param {Array|string|Node} [children]
 * @param {Document} [doc]
 */
export function h(tag, props = {}, children = [], doc) {
  const d = resolveDoc(doc);
  const el = d.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    applyProp(el, key, value);
  }
  appendChild(el, children, d);
  return el;
}

/** Build an element in the SVG namespace (for icons.svg-based state glyphs). */
export function svg(tag, props = {}, children = [], doc) {
  const d = resolveDoc(doc);
  const el = d.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    el.setAttribute(key, value === true ? '' : String(value));
  }
  appendChild(el, children, d);
  return el;
}

/** A standalone text node — the only safe way to insert dynamic text. */
export function text(str, doc) {
  const d = resolveDoc(doc);
  return d.createTextNode(String(str));
}

/** Remove every child of `el` (no innerHTML = '' anywhere). */
export function clear(el) {
  while (el.firstChild) {
    el.removeChild(el.firstChild);
  }
}

/** Replace `el`'s content with a single text node, safely. */
export function setText(el, str, doc) {
  clear(el);
  el.appendChild(text(str, doc || (el.ownerDocument || undefined)));
}

/** Replace `el`'s children with `children` (array/string/Node), safely. */
export function setChildren(el, children, doc) {
  clear(el);
  appendChild(el, children, doc || el.ownerDocument || resolveDoc(doc));
}
