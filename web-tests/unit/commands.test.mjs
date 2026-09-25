import { test } from 'node:test';
import assert from 'node:assert/strict';
import { COMMANDS, CATEGORIES, getCommand, paletteCommands, commandsByCategory } from '../../omniwatch/web/js/commands.js';

test('every command has a unique id and a category from CATEGORIES', () => {
  const ids = new Set();
  for (const cmd of COMMANDS) {
    assert.equal(ids.has(cmd.id), false, `duplicate command id: ${cmd.id}`);
    ids.add(cmd.id);
    assert.ok(CATEGORIES.includes(cmd.category), `${cmd.id} has an unknown category "${cmd.category}"`);
    assert.equal(typeof cmd.title, 'string');
    assert.ok(cmd.title.length > 0);
  }
});

test('getCommand() looks up by id', () => {
  assert.equal(getCommand('sort.cycle').title, 'Cycle sort');
  assert.equal(getCommand('does.not.exist'), undefined);
});

test('paletteCommands() excludes nothing yet marked paletteHidden, but honors the flag if set', () => {
  const all = paletteCommands();
  assert.equal(all.length, COMMANDS.filter((c) => !c.paletteHidden).length);
});

test('commandsByCategory() groups every command under Navigate/Act/View/System', () => {
  const groups = commandsByCategory();
  assert.deepEqual([...groups.keys()], CATEGORIES);
  let total = 0;
  for (const [category, cmds] of groups) {
    for (const cmd of cmds) assert.equal(cmd.category, category);
    total += cmds.length;
  }
  assert.equal(total, COMMANDS.length);
});

test('"unwind" is the escape-hatch command and allows firing from within a text field', () => {
  assert.equal(getCommand('unwind').allowInTextField, true);
});
