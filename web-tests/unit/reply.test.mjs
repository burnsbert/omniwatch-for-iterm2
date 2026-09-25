import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  singleLine, replyModel, validateReplyText, replyErrorMessage, normalizeLabel, normalizeProjectName, MAX_REPLY_CHARS, MAX_LABEL_CHARS,
} from '../../omniwatch/web/js/reply.js';

const fixture = JSON.parse(readFileSync(new URL('../fixtures/state.json', import.meta.url), 'utf8'));
const waiting = fixture.sessions.find((s) => s.tab_label === '1.2');
const codex = fixture.sessions.find((s) => s.tab_label === '2.1');

test('reply bar only for waiting agent sessions with quick reply on (§3 P0)', () => {
  const m = replyModel(waiting, fixture.prefs, fixture.capabilities);
  assert.equal(m.uid, waiting.uid);
  assert.equal(m.hash, waiting.screen_hash);
  assert.equal(m.question, 'Do you want to proceed?');
  assert.deepEqual(m.options.map((o) => [o.index, o.key, o.shortcut, o.selected]), [[1, '1', '⌥1', true], [2, '2', '⌥2', false], [3, '3', '⌥3', false]]);
  assert.equal(replyModel(null, fixture.prefs, fixture.capabilities), null);
  assert.equal(replyModel({ ...waiting, state: 'busy' }, fixture.prefs, fixture.capabilities), null);
  assert.equal(replyModel({ ...waiting, agent: null }, fixture.prefs, fixture.capabilities), null);
  assert.equal(replyModel(waiting, { quick_reply: false }, fixture.capabilities), null);
  assert.equal(replyModel(waiting, fixture.prefs, { reply: false }), null);
  assert.ok(replyModel(waiting, null, null));
});

test('Codex y/n options map to their keys; no prompt still allows free text', () => {
  const m = replyModel(codex, fixture.prefs, fixture.capabilities);
  assert.deepEqual(m.options.map((o) => o.key), codex.prompt.options.map((o) => o.key));
  const bare = replyModel({ ...waiting, prompt: null, screen_hash: undefined }, fixture.prefs, fixture.capabilities);
  assert.deepEqual([bare.options, bare.question, bare.hash, bare.freeText], [[], '', '', true]);
  const ft = replyModel({ ...waiting, prompt: { question: 'q', options: [{ key: 'y' }], free_text: true } }, {}, {});
  assert.equal(ft.freeTextHint, 'Type a reply…');
  assert.equal(ft.options[0].label, 'y');
  const many = replyModel({ ...waiting, prompt: { options: Array.from({ length: 12 }, (_, i) => ({ key: String(i) })) } }, {}, {});
  assert.equal(many.options.length, 9, 'at most ⌥1–⌥9');
});

test('free-text validation mirrors the server rules', () => {
  assert.deepEqual(validateReplyText('yes'), { ok: true, text: 'yes' });
  assert.equal(validateReplyText('a\nb').ok, false, 'one line only (API.md 422 multiline_reply)');
  assert.match(validateReplyText('a\rb').error, /one line/);
  assert.equal(validateReplyText('  ').ok, false);
  assert.equal(validateReplyText(null).ok, false);
  assert.equal(validateReplyText('x'.repeat(MAX_REPLY_CHARS + 1)).ok, false);
  assert.equal(validateReplyText('a\u0007b').error, 'Reply contains control characters');
  assert.equal(validateReplyText('a\tb').ok, false);
});

test('reply error messages (409 stale, 422 not waiting, 503)', () => {
  assert.match(replyErrorMessage({ code: 'stale_screen', status: 409 }), /screen changed/);
  assert.match(replyErrorMessage({ status: 409 }), /screen changed/);
  assert.match(replyErrorMessage({ code: 'invalid', status: 422 }), /no longer waiting/);
  assert.match(replyErrorMessage({ status: 503 }), /iTerm2 is unavailable/);
  assert.equal(replyErrorMessage({ message: 'boom' }), 'reply failed: boom');
  assert.equal(replyErrorMessage(null), 'reply failed: unknown error');
  assert.match(replyErrorMessage({ code: 'multiline_reply', status: 422 }), /one line/);
});

test('label and project normalization (P-61: stripped, Unicode, ≤80)', () => {
  assert.equal(normalizeLabel('  deploy-fix  '), 'deploy-fix');
  assert.equal(normalizeLabel('ünïcødé ✨'), 'ünïcødé ✨');
  assert.equal(normalizeLabel('a\u0000b\nc'), 'abc');
  assert.equal(normalizeLabel('😀'.repeat(100)).length, MAX_LABEL_CHARS * 2, '80 code points, not code units');
  assert.equal(normalizeLabel(undefined), '');
  assert.equal(normalizeProjectName(' api '), 'api');
  assert.equal(normalizeProjectName(null), '');
  assert.equal(normalizeProjectName('x'.repeat(60)).length, 40);
});

test('singleLine flattens pasted line breaks to single spaces', () => {
  assert.equal(singleLine('run it\n  with --watch\r\nplease'), 'run it with --watch please');
  assert.equal(singleLine('one line'), 'one line');
  assert.equal(singleLine(null), '');
});
