import { test } from 'node:test';
import assert from 'node:assert/strict';
import { h, text, clear, setText, setChildren } from '../../omniwatch/web/js/dom.js';
import { FakeDocument } from './fake-dom.mjs';

test('h() builds an element with text children, never via innerHTML', () => {
  const doc = new FakeDocument();
  const el = h('div', { class: 'row' }, ['hello ', 'world'], doc);
  assert.equal(el.tagName, 'div');
  assert.equal(el.className, 'row');
  assert.equal(el.textContent, 'hello world');
  assert.equal(el.childNodes.length, 2);
  assert.equal(el.childNodes[0].nodeType, 3); // text node, not parsed markup
});

test('h() treats a malicious-looking string as literal text, not markup', () => {
  const doc = new FakeDocument();
  const evil = '<img src=x onerror=alert(1)>';
  const el = h('div', {}, [evil], doc);
  assert.equal(el.childNodes.length, 1);
  assert.equal(el.childNodes[0].nodeType, 3);
  assert.equal(el.childNodes[0].data, evil);
  assert.equal(el.textContent, evil);
});

test('h() sets aria/data/style/class array props without touching markup', () => {
  const doc = new FakeDocument();
  const el = h('div', {
    class: ['a', false && 'b', 'c'],
    'aria-selected': true,
    role: 'option',
    dataset: { uid: 'X1' },
    style: { color: 'red' },
    disabled: true,
    hidden: false,
  }, [], doc);
  assert.equal(el.className, 'a c');
  // aria-* booleans need the literal string "true"/"false" (unlike native
  // HTML boolean attributes like disabled/hidden, where bare presence is
  // enough and dom.js uses an empty-string value).
  assert.equal(el.getAttribute('aria-selected'), 'true');
  assert.equal(el.getAttribute('role'), 'option');
  assert.equal(el.dataset.uid, 'X1');
  assert.equal(el.style.getPropertyValue('color'), 'red');
  assert.equal(el.getAttribute('disabled'), '');
  assert.equal(el.hasAttribute('hidden'), false);
});

test('h() wires on* props as addEventListener, not inline handlers', () => {
  const doc = new FakeDocument();
  let clicked = 0;
  const el = h('button', { onClick: () => { clicked += 1; } }, [], doc);
  el.dispatch('click', {});
  assert.equal(clicked, 1);
  assert.equal(el.getAttribute('onclick'), null);
});

test('h() skips null/undefined/boolean children (conditional rendering)', () => {
  const doc = new FakeDocument();
  const el = h('div', {}, [null, undefined, false, true, 'x', 0], doc);
  // '0' and 'x' become text nodes; null/undefined/false/true are skipped.
  assert.equal(el.textContent, 'x0');
  assert.equal(el.childNodes.length, 2);
});

test('h() flattens nested arrays and appends nodes directly', () => {
  const doc = new FakeDocument();
  const child = h('span', {}, ['s'], doc);
  const el = h('div', {}, [['a', ['b', child]]], doc);
  assert.equal(el.childNodes.length, 3);
  assert.equal(el.childNodes[2], child);
});

test('clear() empties every child', () => {
  const doc = new FakeDocument();
  const el = h('div', {}, ['a', 'b', 'c'], doc);
  clear(el);
  assert.equal(el.childNodes.length, 0);
});

test('setText() replaces content with exactly one text node', () => {
  const doc = new FakeDocument();
  const el = h('div', {}, ['old'], doc);
  setText(el, 'new & <b>bold</b>', doc);
  assert.equal(el.childNodes.length, 1);
  assert.equal(el.textContent, 'new & <b>bold</b>');
});

test('setChildren() clears then appends new children', () => {
  const doc = new FakeDocument();
  const el = h('div', {}, ['old'], doc);
  setChildren(el, ['a', h('span', {}, [], doc)], doc);
  assert.equal(el.childNodes.length, 2);
});

test('text() returns a standalone text node', () => {
  const doc = new FakeDocument();
  const t = text('hi', doc);
  assert.equal(t.nodeType, 3);
  assert.equal(t.data, 'hi');
});

test('h() throws a clear error with no document available', () => {
  assert.throws(() => h('div'), /no document available/);
});
