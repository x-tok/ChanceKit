import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessage } from '../electron/core/store';
import { canTryMessageFirst, isPlainJobAdvertisement, reviewActivities, supportedActivity } from '../electron/core/activity-review';
import type { ActivityInput } from '../src/schedule';
import { sample } from './fixtures';

const text = '星河科技2027届校园招聘宣讲会，时间2026年9月24日14:30-16:00，地点九龙湖校区教二404，欢迎同学携带简历参加，现场进行岗位介绍与交流。';
const message = (value = text) => normalizeMessage({ ...sample(1, value), time: Date.parse('2026-09-20T09:00:00+08:00') / 1000 }, 'review');
const activity: ActivityInput = {
  title: '星河科技宣讲会', type: '宣讲会', organizer: '星河科技', startDate: '2026-09-24', endDate: null,
  startTime: '14:30', endTime: '16:00', location: '九龙湖校区教二404', evidence: '时间2026年9月24日14:30-16:00',
  description: '', audience: '', registrationUrl: null, deadline: null,
};
const ad = '星河银行2027届校园招聘正式启动，多个职位开放投递，面向理学、管理学和经济学等专业，提供导师培养及轮岗机会，欢迎通过岗位入口投递简历：https://jobs.example.com/#/position/campus/';

test('only standalone text job promotions bypass extraction; unknown sources, deadlines and events do not', () => {
  assert.equal(isPlainJobAdvertisement(message(ad)), true);
  for (const value of ['', 'https://example.com/article', ad + '截止9月30日', ad + '详见附件', text, ad + '时间另行通知', ad + '另有宣讲会']) {
    assert.equal(isPlainJobAdvertisement(message(value)), false, value);
  }
  const withImage = message(ad);
  withImage.segments.push({ type: 'image', data: { url: 'https://example.com/a.png' } });
  assert.equal(isPlainJobAdvertisement(withImage), false);
  assert.equal(isPlainJobAdvertisement(message(ad.replace('https://jobs.example.com/#/position/campus/', 'https://example.com/article'))), false);
});

test('fast path requires grounded dates, clocks, location and quoted evidence', () => {
  assert.equal(canTryMessageFirst(message()), true);
  assert.equal(supportedActivity(activity, text, message().time), true);
  for (const update of [{ startDate: '2027-09-24' }, { startTime: '15:30' }, { endTime: '17:00' }, { location: '体育馆' }, { evidence: '根据来源推测该活动安排' }]) {
    assert.equal(supportedActivity({ ...activity, ...update }, text, message().time), false);
  }
  assert.equal(supportedActivity({ ...activity, location: '示例大学九龙湖校区教二404' }, text, message().time), false);
  assert.equal(supportedActivity({ ...activity, location: '示例大学九龙湖校区教二404', evidence: activity.evidence + '；其他来源中的报名说明' }, text, message().time, '示例大学就业群'), true);
  assert.equal(canTryMessageFirst(message(text + '更多场次详见附件')), false);
});

test('relative dates follow original message time and explicit different years are not overwritten', () => {
  assert.equal(supportedActivity({ ...activity, startDate: '2026-09-20', evidence: '今天14:30-16:00，地点九龙湖校区教二404' },
    '宣讲会今天14:30-16:00，地点九龙湖校区教二404', message().time), true);
  assert.equal(supportedActivity(activity, text.replace('2026年', '2025年'), message().time), false);
});

test('supplementary failures remain diagnostic only with supported facts; unknown content stays actionable', () => {
  assert.deepEqual(reviewActivities(message(), [activity], ['部分图片无法辨认']), []);
  assert.deepEqual(reviewActivities(message(ad), [], ['页面没有静态正文']), []);
  assert.ok(reviewActivities(message('https://example.com/article'), [], ['图片未读取']).length);
  assert.ok(reviewActivities(message(text + '其他场次详见附件'), [activity], ['附件未读取']).length);
  assert.ok(reviewActivities(message(), [{ ...activity, startTime: null }], ['图片未读取']).length);
});
