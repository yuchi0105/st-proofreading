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
  assert.equal(context.STProofreadingUI.getEditMode(), false);
  assert.match(context.STProofreadingUI.getDisplayedEntries()[0].content, /角色皮膚/);
  assert.match(context.STProofreadingUI.getWorkingEntries()[0].content, /角色皮肤/);
  assert.doesNotMatch(dom.getElement('#entries').innerHTML, /class="switch"/);
  context.STProofreadingUI.setEditMode(true);
  assert.equal(context.STProofreadingUI.getEditMode(), true);
  assert.match(dom.getElement('#entries').innerHTML, /class="switch"/);

  context.STProofreadingUI.editDisplayedEntry(0, { content: '  我手動修改繁體結果  \n{{user}} 😀' });
  context.STProofreadingUI.setDisplayedEntryEnabled(0, false);
  assert.equal(context.STProofreadingUI.getDisplayedEntries()[0].content, '  我手動修改繁體結果  \n{{user}} 😀');
  assert.equal(context.STProofreadingUI.getDisplayedEntries()[0].enabled, false);
  assert.match(context.STProofreadingUI.getWorkingEntries()[0].content, /角色皮肤/);
  assert.equal(context.STProofreadingUI.getWorkingEntries()[0].enabled, true);
});

test('export controls are placed above the workbench', () => {
  const exportAt = html.indexOf('class="top-exports hidden" id="outsec"');
  const workbenchAt = html.indexOf('<section id="entsec">');
  assert.ok(exportAt > 0);
  assert.ok(exportAt < workbenchAt);
});

test('preset workbench renders prompts and converts embedded regex_scripts when checked', async () => {
  const context = makeContext();
  const dom = installDomStub(context);
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  vm.runInContext(scripts[1], context, { filename: 'index-ui.js' });
  const preset = fixture('preset-with-regex.json');
  const bytes = new TextEncoder().encode(JSON.stringify(preset));
  await context.STProofreadingUI.load({ name: 'preset-with-regex.json', async arrayBuffer() { return bytes.buffer; } });

  assert.match(dom.getElement('#entries').innerHTML, /主要提示/);
  assert.match(dom.getElement('#entries').innerHTML, /Regex Scripts/);
  assert.equal(dom.getElement('#doRegex').checked, true);
  dom.getElement('#dir').value = 'cn2tw';
  await context.STProofreadingUI.run();

  const converted = context.STProofreadingUI.getDisplayedPreset();
  assert.match(converted.prompts[0].content, /角色皮膚/);
  assert.match(converted.extensions.regex_scripts[0].scriptName, /皮膚樣式/);
  assert.match(converted.extensions.regex_scripts[0].findRegex, /角色皮膚/);
  assert.match(converted.extensions.regex_scripts[0].replaceString, /皮膚/);
  assert.match(converted.extensions.regex_scripts[0].trimStrings.join('\n'), /角色皮膚/);
  assert.equal(converted.extensions.regex_scripts[0].id, 'rx-preset-1');
  assert.equal(converted.extensions.regex_scripts[0].unknown_regex_field, 'keep-regex');
  assert.equal(converted.extensions.unknown_extension.keep, true);
  assert.deepEqual(converted.unknown_preset_field, ['keep', 7]);
});

test('converted preset prompts and embedded regex remain editable for export', async () => {
  const context = makeContext();
  const dom = installDomStub(context);
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  vm.runInContext(scripts[1], context, { filename: 'index-ui.js' });
  const bytes = new TextEncoder().encode(JSON.stringify(fixture('preset-with-regex.json')));
  await context.STProofreadingUI.load({ name: 'preset-with-regex.json', async arrayBuffer() { return bytes.buffer; } });
  dom.getElement('#dir').value = 'cn2tw';
  await context.STProofreadingUI.run();

  context.STProofreadingUI.editPresetPrompt(0, { content: '  手動修改後的繁體 Prompt  \n{{user}}' });
  context.STProofreadingUI.setPresetPromptEnabled(0, false);
  context.STProofreadingUI.editRegexScript(0, 'regex_scripts', {
    scriptName: '自訂繁體正則',
    findRegex: '/繁體角色/g',
    replaceString: '<b>繁體內容</b>',
  });
  context.STProofreadingUI.setRegexEnabled(0, 'regex_scripts', false);

  const exported = context.STProofreadingUI.exportObject();
  assert.equal(exported.prompts[0].content, '  手動修改後的繁體 Prompt  \n{{user}}');
  assert.equal(exported.prompt_order[0].order[0].enabled, false);
  assert.equal(exported.extensions.regex_scripts[0].scriptName, '自訂繁體正則');
  assert.equal(exported.extensions.regex_scripts[0].findRegex, '/繁體角色/g');
  assert.equal(exported.extensions.regex_scripts[0].disabled, true);
  assert.equal(exported.prompts[0].identifier, 'main');
  assert.equal(exported.prompt_order[0].unknown_order_field, 'keep-order');
});

test('standalone worldbook shows editable entries before and after conversion', async () => {
  const context = makeContext();
  const dom = installDomStub(context);
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  vm.runInContext(scripts[1], context, { filename: 'index-ui.js' });
  const bytes = new TextEncoder().encode(JSON.stringify(fixture('standalone-worldbook.json')));
  await context.STProofreadingUI.load({ name: 'worldbook.json', async arrayBuffer() { return bytes.buffer; } });
  assert.match(dom.getElement('#entries').innerHTML, /城市資料/);
  assert.match(dom.getElement('#entries').innerHTML, /停用但仍須校對/);
  dom.getElement('#dir').value = 'cn2tw';
  await context.STProofreadingUI.run();
  context.STProofreadingUI.editDisplayedEntry(0, { content: '  繁體世界書內容  \n{{user}}' });
  context.STProofreadingUI.setDisplayedEntryEnabled(0, false);
  const exported = context.STProofreadingUI.exportObject();
  assert.equal(exported.entries['101'].content, '  繁體世界書內容  \n{{user}}');
  assert.equal(exported.entries['101'].disable, true);
  assert.equal(exported.entries['101'].uid, 101);
  assert.equal(exported.entries['101'].extensions.vendor_flag, 'keep-me');
  assert.equal(exported.custom_book_field, 'must-survive');
});

test('standalone regex scripts are visible, converted, editable, and keep unknown fields', async () => {
  const context = makeContext();
  const dom = installDomStub(context);
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  vm.runInContext(scripts[1], context, { filename: 'index-ui.js' });
  const source = [{
    id: 'standalone-rx', scriptName: '皮肤样式', findRegex: '/角色皮肤/g',
    replaceString: '<i>皮肤信息</i>', trimStrings: ['错误信息'], disabled: false,
    placement: [2], unknown: 'keep',
  }];
  const bytes = new TextEncoder().encode(JSON.stringify(source));
  await context.STProofreadingUI.load({ name: 'regex.json', async arrayBuffer() { return bytes.buffer; } });
  assert.match(dom.getElement('#entries').innerHTML, /皮肤样式/);
  dom.getElement('#dir').value = 'cn2tw';
  await context.STProofreadingUI.run();
  assert.match(context.STProofreadingUI.getDisplayedRegex()[0].findRegex, /角色皮膚/);
  context.STProofreadingUI.editRegexScript(0, '', { replaceString: '<i>自訂繁體</i>' });
  context.STProofreadingUI.setRegexEnabled(0, '', false);
  const exported = context.STProofreadingUI.exportObject();
  assert.equal(exported[0].replaceString, '<i>自訂繁體</i>');
  assert.equal(exported[0].disabled, true);
  assert.equal(exported[0].unknown, 'keep');
  assert.deepEqual(exported[0].placement, [2]);
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

test('entry conversion covers memo/name fields, string keywords, narrative content, and regex trimStrings', () => {
  const context = makeContext();
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  const core = context.STProofreadingCore;
  const convert = context.OpenCC.Converter({ from: 'cn', to: 'tw' });
  const card = {
    data: {
      character_book: {
        entries: [
          {
            comment: '',
            memo: '简体条目名称',
            content: '这里是简体内容，按钮在后台。\n请使用简体中文（zh-CN）输出。\n不要使用简体中文（zh-CN）。\nPlease respond in Simplified Chinese (zh-CN).\nDo not use Simplified Chinese (zh-CN).\n<div class="button">显示文字</div>\n{{user}}',
            key: '触发词,  备用关键词  ',
            enabled: true,
          },
          {
            comment: '手机-基本设置',
            content: '备注=这里是简体说明\n类型=角色\n程序之外的后台按钮说明',
            enabled: false,
          },
        ],
      },
      extensions: {
        regex_scripts: [{
          scriptName: '皮肤规则', findRegex: '/角色皮肤/g', replaceString: '简体内容',
          trimStrings: ['错误信息', '角色皮肤'], disabled: false,
        }],
      },
    },
  };
  const converted = core.convertCard(card, {
    convert, doRegex: true, languageTarget: 'traditional',
    kindOf: (_entry, i) => i === 1 ? 'data' : 'prompt',
  }).card;
  const [prompt, data] = converted.data.character_book.entries;
  assert.equal(prompt.memo, '簡體條目名稱');
  assert.match(prompt.content, /這裡是簡體內容/);
  assert.match(prompt.content, /請使用繁體中文（zh-TW）輸出/);
  assert.match(prompt.content, /不要使用簡體中文（zh-CN）/);
  assert.match(prompt.content, /Please respond in Traditional Chinese \(zh-TW\)/);
  assert.match(prompt.content, /Do not use Simplified Chinese \(zh-CN\)/);
  assert.match(prompt.content, />顯示文字<\/div>/);
  assert.equal(prompt.key, '觸發詞,  備用關鍵詞  ');
  assert.match(data.content, /^备注=這裡是簡體說明/m);
  assert.match(data.content, /^类型=角色/m);
  assert.match(data.content, /程序之外的後臺按鈕說明/);
  assert.equal(data.comment, '手机-基本设置');
  assert.match(converted.data.extensions.regex_scripts[0].trimStrings.join('\n'), /角色皮膚/);
});

test('preset prompts retarget output-language directives without reversing negative instructions', () => {
  const context = makeContext();
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  const core = context.STProofreadingCore;
  const convert = context.OpenCC.Converter({ from: 'cn', to: 'tw' });
  const preset = {
    system_prompt: '请以 zh-CN 输出内容。不要使用简体中文。',
    prompts: [{ name: '语言规则', content: 'Always reply in Simplified Chinese (zh-CN).' }],
  };
  const converted = core.convertPreset(preset, { convert, languageTarget: 'traditional' }).preset;

  assert.equal(converted.system_prompt, '請以 zh-TW 輸出內容。不要使用簡體中文。');
  assert.equal(converted.prompts[0].content, 'Always reply in Traditional Chinese (zh-TW).');
});

test('multiline setvar values and all known variable references convert together', () => {
  const context = makeContext();
  vm.runInContext(scripts[2], context, { filename: 'opencc-bundle.js' });
  const core = context.STProofreadingCore;
  const convert = context.OpenCC.Converter({ from: 'cn', to: 'tw' });
  const source = [
    '{{setvar::简体变量::',
    '### [日常氛围]',
    '编织温暖与幸运的经纬，使用简体中文（zh-CN）输出。',
    '{{user}}与角色保持羁绊。',
    '}}',
    '{{getvar::简体变量}}',
    '{{addvar::简体变量::风格加值}}',
    '{{incvar::简体变量}}',
    '{{setglobalvar::禁果风格::简体正文}}',
    '{{getglobalvar::禁果风格}}',
    '{{custom::禁果风格}}',
  ].join('\n');
  const preset = { prompts: [{ name: '巨集测试', content: source }] };
  const converted = core.convertPreset(preset, { convert, languageTarget: 'traditional' }).preset;
  const content = converted.prompts[0].content;

  assert.match(content, /^\{\{setvar::簡體變量::/);
  assert.match(content, /### \[日常氛圍\]/);
  assert.match(content, /編織溫暖與幸運的經緯，使用繁體中文（zh-TW）輸出/);
  assert.match(content, /\{\{user\}\}與角色保持羈絆/);
  assert.match(content, /\n\}\}\n\{\{getvar::簡體變量\}\}/);
  assert.match(content, /\{\{addvar::簡體變量::風格加值\}\}/);
  assert.match(content, /\{\{incvar::簡體變量\}\}/);
  assert.match(content, /\{\{setglobalvar::禁果風格::簡體正文\}\}/);
  assert.match(content, /\{\{getglobalvar::禁果風格\}\}/);
  assert.match(content, /\{\{custom::禁果风格\}\}$/);
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
