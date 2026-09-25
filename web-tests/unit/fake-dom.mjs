// A minimal fake DOM (Document/Element/Text) for testing dom.js in Node,
// where no real `document` global exists. Only implements what dom.js and
// its tests touch — not a general-purpose DOM shim.

class FakeClassList {
  constructor() { this._set = new Set(); }
  add(...names) { names.forEach((n) => n && this._set.add(n)); }
  remove(...names) { names.forEach((n) => this._set.delete(n)); }
  contains(n) { return this._set.has(n); }
  toString() { return [...this._set].join(' '); }
}

class FakeStyle {
  constructor() { this._props = {}; }
  setProperty(name, value) { this._props[name] = value; }
  getPropertyValue(name) { return this._props[name] || ''; }
}

class FakeNode {
  constructor() {
    this.childNodes = [];
    this.parentNode = null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
}

class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.nodeType = 3;
    this.data = String(data);
  }
  get textContent() { return this.data; }
}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super();
    this.nodeType = 1;
    this.tagName = tagName;
    this.ownerDocument = ownerDocument;
    this.attributes = {};
    this._listeners = {};
    this.classList = new FakeClassList();
    this.style = new FakeStyle();
    this.dataset = {};
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name); }
  addEventListener(type, fn) {
    (this._listeners[type] = this._listeners[type] || []).push(fn);
  }
  dispatch(type, evt) {
    (this._listeners[type] || []).forEach((fn) => fn(evt));
  }
  get className() { return this.classList.toString(); }
  set className(v) {
    this.classList = new FakeClassList();
    String(v).split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
  }
  get textContent() {
    return this.childNodes.map((c) => (c.nodeType === 3 ? c.data : c.textContent)).join('');
  }
}

export class FakeDocument {
  createElement(tag) { return new FakeElement(tag, this); }
  createElementNS(_ns, tag) { return new FakeElement(tag, this); }
  createTextNode(data) { return new FakeText(data); }
}
