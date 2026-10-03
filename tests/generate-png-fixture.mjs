import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.resolve(here, '..', 'index.html'), 'utf8');
const coreSource = [...html.matchAll(/^<script>([\s\S]*?)^<\/script>/gm)][0][1];
const context = vm.createContext({
  TextEncoder, TextDecoder, Uint8Array, Uint32Array, ArrayBuffer, DataView,
  Map, Set, JSON, RegExp, URL, Blob,
  atob: value => Buffer.from(value, 'base64').toString('binary'),
  btoa: value => Buffer.from(value, 'binary').toString('base64'),
});
context.globalThis = context;
vm.runInContext(coreSource, context);

const card = {
  spec: 'chara_card_v3',
  data: {
    name: 'PNG 測試卡',
    character_book: {
      entries: [
        { id: 11, comment: '啟用', content: '晚上吃冷面 😀\n{{user}}', enabled: true, extensions: { unknown: 'keep' } },
        { id: 12, comment: '停用', content: '<b>酒店</b>', enabled: false, unknown: 7 },
      ],
    },
  },
};
const payload = Buffer.from(JSON.stringify(card), 'utf8').toString('base64');
const text = Buffer.from(`chara\0${payload}`, 'binary');
const chunks = [
  { type: 'IHDR', data: new Uint8Array(13) },
  { type: 'tEXt', data: new Uint8Array(text) },
  { type: 'IEND', data: new Uint8Array() },
];
const png = context.STProofreadingCore.buildPng(chunks, card, false);
process.stdout.write(Buffer.from(png).toString('base64'));
