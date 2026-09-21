import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readArticleTitle, InformationTitleReader } from '../electron/core/processing/information-titles';
import { shareCardMaterials } from '../electron/core/materials/material-title';
import { normalizeMessage } from '../electron/core/archive/store';
import { sample } from './fixtures';
import type { RecruitingInformationStore } from '../electron/core/processing/recruiting-information';

test('title-only reads prefer the article heading, never fetch posters, and reject challenge titles', async () => {
  const requested: string[] = [];
  const title = await readArticleTitle('https://mp.weixin.qq.com/s/synthetic', new AbortController().signal, async url => {
    requested.push(url);
    return { url, contentType: 'text/html', bytes: Buffer.from('<title>微信公众平台</title><h1 id="activity-name">星河研究院 &amp; 校园招聘</h1><div id="js_content"><img src="https://example.com/poster.png"></div>') };
  });
  assert.equal(title, '星河研究院 & 校园招聘'); assert.equal(requested.length, 1);
  assert.equal(await readArticleTitle('https://mp.weixin.qq.com/s/restricted', new AbortController().signal, async url => ({
    url, contentType: 'text/html', bytes: Buffer.from('<title>安全验证</title><body>完成验证后继续</body>'),
  })), undefined);
  assert.equal(await readArticleTitle('https://example.com', new AbortController().signal, async () => { throw new Error('unexpected'); }), undefined);
});

test('share card titles are paired only with their own destination', () => {
  const message = normalizeMessage({ ...sample(1, ''), message: [{ type: 'json', data: { data: JSON.stringify({
    meta: { news: { title: '星河校园招聘公告', jumpUrl: 'https://mp.weixin.qq.com/s/card' }, unrelated: { title: '不匹配的标题' } },
    title: '顶层广告', other: 'https://example.com/unrelated',
  }) } }] }, 'a');
  assert.deepEqual(shareCardMaterials(message), [{ title: '星河校园招聘公告', kind: 'page', url: 'https://mp.weixin.qq.com/s/card' }]);
});

test('visible-card title enrichment limits concurrency and caches unsuccessful reads without model calls', async () => {
  const targets = Array.from({ length: 5 }, (_, index) => ({ messageKey: String(index), hash: 'h', url: `https://mp.weixin.qq.com/s/${index}` }));
  const pending: (() => void)[] = [];
  let calls = 0, active = 0, peak = 0, emits = 0;
  const store = { titleRequests: () => targets, applyTitle: () => false } as unknown as RecruitingInformationStore;
  const reader = new InformationTitleReader(store, () => 'a', () => emits++, async url => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise<void>(resolve => pending.push(resolve)); active--;
    return { url, contentType: 'text/html', bytes: Buffer.from('<title>安全验证</title><body>完成验证后继续</body>') };
  });
  try {
    reader.request('a', targets.map(target => target.messageKey));
    for (let round = 0; round < 5; round++) { pending.splice(0).forEach(resolve => resolve()); await new Promise(resolve => setTimeout(resolve, 5)); }
    assert.equal(calls, 5); assert.equal(peak, 2);
    reader.request('a', targets.map(target => target.messageKey));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(calls, 5); assert.equal(emits, 0);
  } finally { reader.close(); }
});
