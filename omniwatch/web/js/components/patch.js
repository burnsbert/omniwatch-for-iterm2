// patch.js — tiny DOM patching helpers so components can update in place
// (keeping focus, hover and scroll) instead of rebuilding on every frame.
// Text always goes in as text nodes (dom.js rule: no innerHTML).

import { setText } from '../dom.js';

/** Set an element's text only when it changed. */
export function text(el, value) {
  const v = value == null ? '' : String(value);
  if (el.__owText === v) return;
  el.__owText = v;
  setText(el, v);
}

/** Set (or remove, for null/false/undefined) an attribute only when it changed. */
export function attr(el, name, value) {
  if (value === null || value === undefined || value === false) {
    if (el.hasAttribute(name)) el.removeAttribute(name);
    return;
  }
  const v = value === true ? '' : String(value);
  if (el.getAttribute(name) !== v) el.setAttribute(name, v);
}

export function cls(el, name, on) {
  el.classList.toggle(name, !!on);
}

export function show(el, visible) {
  if (visible) {
    if (el.hidden) el.hidden = false;
  } else if (!el.hidden) {
    el.hidden = true;
  }
}

/** CSSOM custom property (allowed under the page's CSP, unlike style="…"). */
export function cssVar(el, name, value) {
  const v = value == null ? '' : String(value);
  if (el.style.getPropertyValue(name) !== v) el.style.setProperty(name, v);
}

/**
 * Keyed reconciliation: make `parent`'s managed children match `items`, in
 * order, reusing elements by key. `create(item)` builds an element,
 * `update(el, item)` patches it. Children in `parent` not created here
 * (e.g. spacers passed as `before`) are left alone.
 */
export function reconcile(parent, items, keyOf, create, update, { before = null } = {}) {
  if (!parent.__owKeyed) parent.__owKeyed = new Map();
  const map = parent.__owKeyed;
  const seen = new Set();
  let cursor = null; // the element that should come right before the next one
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let el = map.get(key);
    if (!el) {
      el = create(item);
      el.__owKey = key;
      map.set(key, el);
    }
    update(el, item);
    const expectedNext = cursor ? cursor.nextSibling : firstManaged(parent, before);
    if (el !== expectedNext) parent.insertBefore(el, expectedNext || before);
    cursor = el;
  }
  for (const [key, el] of map) {
    if (!seen.has(key)) {
      if (el.parentNode === parent) parent.removeChild(el);
      map.delete(key);
    }
  }
}

function firstManaged(parent, before) {
  // Managed children start at the first child that isn't a leading spacer.
  let n = parent.firstChild;
  while (n && n.__owSpacer) n = n.nextSibling;
  return n === before ? before : n;
}
