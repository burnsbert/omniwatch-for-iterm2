// reply.js — quick-reply model and input validation (DESIGN.md §3 P0,
// §4.4 `POST /sessions/{uid}/reply`). Pure: decides whether the reply bar
// shows, which options become buttons (⌥1–⌥9), and whether a free-text
// reply is acceptable before it is sent with the `screen_hash` guard.

export const MAX_REPLY_CHARS = 2000;

/**
 * Reply bar model for a session, or null when quick reply doesn't apply:
 * only agent sessions currently `waiting`, with quick reply enabled in
 * prefs and supported by the backend (`capabilities.reply`).
 */
export function replyModel(session, prefs, capabilities) {
  if (!session || session.state !== 'waiting' || !session.agent) return null;
  if (prefs && prefs.quick_reply === false) return null;
  if (capabilities && capabilities.reply === false) return null;
  const prompt = session.prompt || null;
  const options = ((prompt && prompt.options) || []).slice(0, 9).map((o, i) => ({
    index: i + 1,
    key: String(o.key),
    label: o.label || String(o.key),
    selected: !!o.selected,
    shortcut: `⌥${i + 1}`,
  }));
  return {
    uid: session.uid,
    hash: session.screen_hash || '',
    question: (prompt && prompt.question) || '',
    options,
    freeText: true,
    freeTextHint: prompt && prompt.free_text ? 'Type a reply…' : 'Type a reply and press ⏎…',
  };
}

/**
 * Validate free text before sending (mirrors the server's rules so the user
 * gets an immediate message): non-empty, ≤2000 chars, and no control
 * characters except newline.
 * @returns {{ok:true, text:string}|{ok:false, error:string}}
 */
export function validateReplyText(text) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return { ok: false, error: 'Reply is empty' };
  if (t.length > MAX_REPLY_CHARS) return { ok: false, error: `Reply is longer than ${MAX_REPLY_CHARS} characters` };
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0009\u000b-\u001f\u007f]/.test(t)) return { ok: false, error: 'Reply contains control characters' };
  return { ok: true, text: t };
}

/** User-facing message for a failed reply (409 stale screen, 422 not waiting, …). */
export function replyErrorMessage(err) {
  const code = err && err.code;
  const status = err && err.status;
  if (code === 'stale_screen' || status === 409) {
    return 'The screen changed before the reply was sent — check the prompt and try again';
  }
  if (code === 'invalid' || status === 422) return 'That session is no longer waiting for a reply';
  if (code === 'iterm_unavailable' || status === 503) return 'iTerm2 is unavailable — reply not sent';
  return `reply failed: ${(err && err.message) || 'unknown error'}`;
}

/** Label validation for inline edits (P-61: stripped, Unicode, max 80). */
export const MAX_LABEL_CHARS = 80;

export function normalizeLabel(text) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(cleaned).slice(0, MAX_LABEL_CHARS).join('');
}

export const MAX_PROJECT_CHARS = 40;

export function normalizeProjectName(text) {
  // eslint-disable-next-line no-control-regex
  const cleaned = String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return Array.from(cleaned).slice(0, MAX_PROJECT_CHARS).join('');
}
