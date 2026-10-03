import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/^<script>([\s\S]*?)^<\/script>/gm)].map(m => m[1]);

function makeContext() {
  const context = vm.createContext({
    console, TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
    Map, Set, JSON, RegExp, URL, Blob,
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
  });
  context.globalThis = context;
  context.window = context;
  context.self = context;
  vm.runInContext(scripts[0], context, { filename: 'index-core.js' });
  return context;
}

function fixture(name) {
  return JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));
}

function installDomStub(context) {
  const listeners = new Map();
  const elements = new Map();
  const makeElement = () => ({
      value: '', checked: false, disabled: false, innerHTML: '', textContent: '', onchange: null, open: false,
      style: {}, files: [], classList: { add() {}, remove() {}, toggle() {} },
      addEventListener(type, fn) { listeners.set(type, fn); },
      querySelectorAll() { return []; },
      querySelector() { return null; },
      setAttribute() {}, insertAdjacentHTML() {}, scrollIntoView() {}, click() {},
    });
  const getElement = selector => {
    if (!elements.has(selector)) elements.set(selector, makeElement());
    return elements.get(selector);
  };
  context.document = {
    querySelector(selector) { return getElement(selector); },
    createElement() { return makeElement(); },
    head: { appendChild() {} }, body: { appendChild() {} }, execCommand() { return true; },
  };
  context.navigator = { clipboard: { async writeText() {} } };
  context.alert = () => {};
  context.confirm = () => true;
  context.setTimeout = setTimeout;
  context.clearTimeout = clearTimeout;
  context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
  return { elements, getElement };
}

test('all inline scripts parse without rebuilding the OpenCC bundle', () => {
  for (const [i, source] of scripts.entries()) {
    assert.doesNotThrow(() => new vm.Script(source, { filename: `inline-${i}.js` }));
  }
  const marker = html.indexOf('OPENCC-BUNDLE:BEGIN');
  assert.notEqual(marker, -1);
  const actual = crypto.createHash('sha256').update(html.slice(marker)).digest('hex').toUpperCase();
  const expected = fs.readFileSync(path.join(here, 'opencc-bundle.sha256'), 'utf8').trim();
  assert.equal(actual, expected);
});

test('UI bridge initializes and loads a character-card fixture without a runtime exception', async () => {
  const context = makeContext();
  installDomStub(context);
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  vm.runInContext(scripts[1], context, { filename: 'index-ui.js' });
  const bytes = new TextEncoder().encode(JSON.stringify(fixture('character-card.json')));
  const file = { name: 'character-card.json', async arrayBuffer() { return bytes.buffer; } };
  await assert.doesNotReject(() => context.load(file));

  const worldbookBytes = new TextEncoder().encode(JSON.stringify(fixture('standalone-worldbook.json')));
  await assert.doesNotReject(() => context.load({ name: 'worldbook.json', async arrayBuffer() { return worldbookBytes.buffer; } }));

  const pngBytes = Buffer.from(fs.readFileSync(path.join(here, 'fixtures', 'card-with-character-book.png.b64'), 'utf8').trim(), 'base64');
  await assert.doesNotReject(() => context.load({
    name: 'card.png',
    async arrayBuffer() { return pngBytes.buffer.slice(pngBytes.byteOffset, pngBytes.byteOffset + pngBytes.byteLength); },
  }));

  const presetBytes = new TextEncoder().encode(JSON.stringify({ prompts: [], prompt_order: [], chat_completion_source: 'custom' }));
  await assert.doesNotReject(() => context.load({ name: 'preset.json', async arrayBuffer() { return presetBytes.buffer; } }));

  const regexBytes = new TextEncoder().encode(JSON.stringify([{ scriptName: '測試', findRegex: '/信息/g', replaceString: '資訊' }]));
  await assert.doesNotReject(() => context.load({ name: 'regex.json', async arrayBuffer() { return regexBytes.buffer; } }));
});

test('converted entries stay editable without mutating the pre-conversion working copy', async () => {
  const context = makeContext();
  const dom = installDomStub(context);
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  vm.runInContext(scripts[1], context, { filename: 'index-ui.js' });
  const bytes = new TextEncoder().encode(JSON.stringify(fixture('character-card.json')));
  await context.STProofreadingUI.load({ name: 'character-card.json', async arrayBuffer() { return bytes.buffer; } });
  dom.getElement('#dir').value = 'cn2tw';

  assert.match(context.STProofreadingUI.getWorkingEntries()[0].content, /角色皮肤/);
  await context.STProofreadingUI.run();
  assert.equal(context.STProofreadingUI.getViewMode(), 'output');
  assert.match(context.STProofreadingUI.getDisplayedEntries()[0].content, /角色皮膚/);
  assert.match(context.STProofreadingUI.getWorkingEntries()[0].content, /角色皮肤/);

  context.STProofreadingUI.editDisplayedEntry(0, { content: '  我手動修改繁體結果  \n{{user}} 😀' });
  context.STProofreadingUI.setDisplayedEntryEnabled(0, false);
  assert.equal(context.STProofreadingUI.getDisplayedEntries()[0].content, '  我手動修改繁體結果  \n{{user}} 😀');
  assert.equal(context.STProofreadingUI.getDisplayedEntries()[0].enabled, false);
  assert.match(context.STProofreadingUI.getWorkingEntries()[0].content, /角色皮肤/);
  assert.equal(context.STProofreadingUI.getWorkingEntries()[0].enabled, true);
});

test('standalone worldbook keeps disable semantics and every unknown field', () => {
  const { STProofreadingCore: core } = makeContext();
  const original = fixture('standalone-worldbook.json');
  const wrapped = core.wrapWorldbook(structuredClone(original));
  const entries = wrapped.pseudo.data.character_book.entries;

  assert.equal(core.detectEntryEnabledField(entries[0], 'worldbook'), 'disable');
  assert.equal(core.readEntryEnabled(entries[0], 'disable'), true);
  assert.equal(core.readEntryEnabled(entries[1], 'disable'), false);
  core.writeEntryEnabled(entries[1], 'disable', true);

  const exported = core.unwrapWorldbook(original, wrapped.pseudo, wrapped.uids);
  assert.equal(exported.entries['205'].disable, false);
  assert.equal('enabled' in exported.entries['205'], false);
  assert.equal(exported.entries['101'].uid, 101);
  assert.equal(exported.entries['101'].order, 30);
  assert.equal(exported.entries['101'].probability, 75);
  assert.equal(exported.entries['101'].extensions.vendor_flag, 'keep-me');
  assert.deepEqual(Object.keys(exported.entries), ['101', '205']);
  assert.equal(exported.custom_book_field, 'must-survive');
});

test('embedded character_book keeps enabled semantics and exact edited content', () => {
  const { STProofreadingCore: core } = makeContext();
  const card = fixture('character-card.json');
  const entries = card.data.character_book.entries;
  assert.equal(core.detectEntryEnabledField(entries[0], 'card'), 'enabled');
  assert.equal(core.readEntryEnabled(entries[1], 'enabled'), false);
  core.writeEntryEnabled(entries[1], 'enabled', true);
  entries[0].content = '  首尾空白不 trim  \n{{user}}\n<script>const x = "繁體";</script>\n😀';
  assert.equal(entries[0].content, '  首尾空白不 trim  \n{{user}}\n<script>const x = "繁體";</script>\n😀');
  assert.equal(entries[0].id, 1);
  assert.equal(entries[0].extensions.unknown, 'keep');
  assert.equal(card.data.extensions.unknown_extension.value, true);
  assert.equal('disable' in entries[1], false);
});

test('old entries without optional fields default to the container-native status field', () => {
  const { STProofreadingCore: core } = makeContext();
  const worldbook = fixture('legacy-worldbook.json');
  const entry = worldbook.entries['0'];
  assert.equal(core.detectEntryEnabledField(entry, 'worldbook'), 'disable');
  core.writeEntryEnabled(entry, 'disable', false);
  assert.equal(entry.disable, true);
  assert.equal(entry.unknown, 'still-here');
});

test('ambiguity decisions are occurrence-specific and unresolved terms avoid semantic replacement', () => {
  const { STProofreadingCore: core } = makeContext();
  const card = fixture('character-card.json');
  const entries = card.data.character_book.entries;
  const found = core.scanEntryAmbiguities(entries, value => value === '皮肤' ? '皮膚' : value);
  assert.ok(found.length >= 10);

  const cold = found.filter(x => x.ruleId === 'cold-face-noodle' && x.field === 'content');
  assert.equal(cold.length, 3); // two prose occurrences and one script occurrence
  assert.notEqual(cold[0].id, cold[1].id);

  const decisions = new Map([
    [cold[0].id, { action: 'keep', value: '冷面' }],
    [cold[1].id, { action: 'candidate', value: '冷麵' }],
  ]);
  const stash = core.protectEntryAmbiguities(card, decisions, value => value === '皮肤' ? '皮膚' : value);
  card.data.character_book.entries[0].content = card.data.character_book.entries[0].content.replaceAll('冷面', '冷麵');
  core.restoreEntryAmbiguities(card, stash);
  const content = card.data.character_book.entries[0].content;
  assert.match(content, /冷著一張冷面/);
  assert.match(content, /去吃冷麵/);
  assert.match(content, /角色皮膚很蒼白/);
  assert.match(content, /市中心的酒店/);
});

test('embedded OpenCC converts disabled entries while protected ambiguity occurrences stay independent', () => {
  const context = makeContext();
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  const core = context.STProofreadingCore;
  const original = fixture('standalone-worldbook.json');
  const wrapped = core.wrapWorldbook(structuredClone(original));
  const card = wrapped.pseudo;
  const entries = card.data.character_book.entries;
  const found = core.scanEntryAmbiguities(entries, value => value);
  const cold = found.filter(x => x.ruleId === 'cold-face-noodle');
  const decisions = new Map([[cold[1].id, { action: 'candidate', value: '冷麵' }]]);
  const convert = context.OpenCC.Converter({ from: 'cn', to: 'tw' });
  const stash = core.protectEntryAmbiguities(card, decisions, convert);
  const converted = core.convertCard(card, { convert, kindOf: () => 'prompt' }).card;
  core.restoreEntryAmbiguities(converted, stash);

  assert.equal(converted.data.character_book.entries[1].disable, true);
  assert.match(converted.data.character_book.entries[1].content, /系統返回錯誤信息/);
  assert.match(converted.data.character_book.entries[1].content, /冷著一張冷面/);
  assert.match(converted.data.character_book.entries[1].content, /去吃冷麵/);
  assert.equal(converted.data.character_book.entries[0].extensions.vendor_flag, 'keep-me');
});

test('PNG character-card payload round-trips with embedded character_book', () => {
  const { STProofreadingCore: core } = makeContext();
  const fixtureB64 = fs.readFileSync(path.join(here, 'fixtures', 'card-with-character-book.png.b64'), 'utf8').trim();
  const png = Buffer.from(fixtureB64, 'base64');
  const parsed = core.extractCard(png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
  assert.equal(parsed.card.data.character_book.entries[1].enabled, false);
  assert.match(parsed.card.data.character_book.entries[0].content, /冷面/);
  assert.equal(parsed.card.data.character_book.entries[0].extensions.unknown, 'keep');

  parsed.card.data.character_book.entries[0].content += '\n編輯後';
  const rebuilt = core.buildPng(parsed.chunks, parsed.card, parsed.hadCcv3);
  const reparsed = core.extractCard(rebuilt.buffer.slice(rebuilt.byteOffset, rebuilt.byteOffset + rebuilt.byteLength));
  assert.match(reparsed.card.data.character_book.entries[0].content, /編輯後$/);
});
