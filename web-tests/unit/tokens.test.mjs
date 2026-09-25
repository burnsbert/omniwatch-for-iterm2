// tokens.test.mjs — WCAG AA (4.5:1) contrast check for every text-ish
// token against --ow-surface, in every theme (DESIGN.md §2.6: "Contrast
// target: WCAG AA (4.5:1) for text tokens on --ow-surface in both
// themes"). This parses omniwatch/web/css/tokens.css directly (a tiny,
// deliberately narrow CSS-custom-property extractor — not a general CSS
// parser) so the test fails the moment the token values drift, without
// needing a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../../omniwatch/web/css/tokens.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

// Text-ish tokens that are ever used to color text directly (waiting/fresh/
// busy/warn/danger text, agent chip labels, body/muted copy) — per §2.6's
// contrast target. Background-only tokens (*-bg, --ow-border,
// --ow-selection, --ow-focus-ring) are excluded on purpose: they're never
// text color.
const TEXT_TOKENS = [
  '--ow-text', '--ow-text-muted', '--ow-claude', '--ow-codex',
  '--ow-attention', '--ow-fresh', '--ow-busy', '--ow-warn', '--ow-danger',
];

/** Extract every `--name: value;` declaration inside a single `{...}` rule body. */
function parseDeclarations(body) {
  const out = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

/**
 * Find the token declarations for a given selector, by locating the
 * selector text and parsing the body of its immediately-following
 * `{...}` block. Only handles the flat, single-level rules this file
 * uses (no nested rules within the selector's own block).
 */
function rules(selectorRe) {
  const out = [];
  const re = new RegExp(`${selectorRe}\\s*\\{([^}]*)\\}`, 'gs');
  let m;
  while ((m = re.exec(css))) {
    out.push(parseDeclarations(m[1]));
  }
  return out;
}

function mergeAll(dictList) {
  return Object.assign({}, ...dictList);
}

// Base (:root) tokens apply to every theme unless overridden.
const rootTokens = mergeAll(rules(String.raw`:root(?:,\s*\[data-theme="dark"\])?`));
const darkTokens = { ...rootTokens, ...mergeAll(rules(String.raw`\[data-theme="dark"\]`)) };
const lightTokens = { ...rootTokens, ...mergeAll(rules(String.raw`\[data-theme="light"\]`)) };
const highContrastTokens = { ...rootTokens, ...mergeAll(rules(String.raw`\[data-theme="high-contrast"\]`)) };

function isHex(v) {
  return /^#[0-9a-fA-F]{6}$/.test(v);
}

function hexToRgb(hex) {
  const n = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
}

function srgbToLinear(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]) {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

function contrastRatio(hexA, hexB) {
  const la = relativeLuminance(hexToRgb(hexA));
  const lb = relativeLuminance(hexToRgb(hexB));
  const [lighter, darker] = la > lb ? [la, lb] : [lb, la];
  return (lighter + 0.05) / (darker + 0.05);
}

const AA_NORMAL_TEXT = 4.5;

const THEMES = {
  dark: darkTokens,
  light: lightTokens,
  'high-contrast': highContrastTokens,
};

test('every theme defines --ow-surface as a resolvable hex color', () => {
  for (const [name, tokens] of Object.entries(THEMES)) {
    assert.ok(tokens['--ow-surface'], `${name} theme is missing --ow-surface`);
    assert.ok(isHex(tokens['--ow-surface']), `${name} theme's --ow-surface (${tokens['--ow-surface']}) isn't a plain #rrggbb hex color`);
  }
});

for (const [themeName, tokens] of Object.entries(THEMES)) {
  for (const tokenName of TEXT_TOKENS) {
    test(`${themeName}: ${tokenName} on --ow-surface meets WCAG AA (>=4.5:1)`, () => {
      const value = tokens[tokenName];
      assert.ok(value, `${themeName} theme is missing ${tokenName}`);
      assert.ok(isHex(value), `${tokenName} (${value}) in ${themeName} isn't a plain #rrggbb hex color`);
      const ratio = contrastRatio(value, tokens['--ow-surface']);
      assert.ok(
        ratio >= AA_NORMAL_TEXT,
        `${themeName} ${tokenName} (${value}) vs surface (${tokens['--ow-surface']}) is only ${ratio.toFixed(2)}:1, below AA's 4.5:1`,
      );
    });
  }
}

test('data-theme="system" defaults to dark (inherits :root) until prefers-color-scheme:light matches', () => {
  // [data-theme="system"]'s own (non-media) rule body is intentionally
  // empty, so it falls through to :root's dark values.
  assert.equal(rootTokens['--ow-surface'], darkTokens['--ow-surface']);
});

test('data-theme="system" switches to the light palette inside @media (prefers-color-scheme: light)', () => {
  const lightMediaMatch = css.match(/@media \(prefers-color-scheme: light\)\s*\{([\s\S]*?)\n\}\n/);
  assert.ok(lightMediaMatch, 'no @media (prefers-color-scheme: light) block found in tokens.css');
  const inner = mergeAll(
    [...lightMediaMatch[1].matchAll(/\[data-theme="system"\]\s*\{([^}]*)\}/gs)].map((m) => parseDeclarations(m[1])),
  );
  assert.equal(inner['--ow-surface'], lightTokens['--ow-surface']);
  assert.equal(inner['--ow-attention'], lightTokens['--ow-attention']);
});
