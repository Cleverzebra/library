import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus, formatWhen, formatUntil, listTitles } from '../../docs/js/format.js';

process.env.TZ = 'America/New_York';
const NOW = new Date(2026, 8, 26, 14, 30).getTime(); // Sep 26 2026, 2:30 PM local
const at = (h, m = 0, day = 26) => new Date(2026, 8, day, h, m).toISOString();
const base = { lastSuccessAt: null, lastAttemptAt: null, retryAt: null, last: null };
const titles = { 'repo:1': 'Garden Planner', 'repo:2': 'Recipes' };
const say = (checks, extra = {}) => describeStatus({ checks: { ...base, ...checks }, nowMs: NOW, titleFor: (k) => titles[k] ?? k, locale: 'en-US', ...extra });

test('dates read naturally', () => {
  assert.match(formatWhen(at(9, 41), NOW, 'en-US'), /^today at 9:41\sAM$/);
  assert.match(formatWhen(at(18, 2, 25), NOW, 'en-US'), /^yesterday at 6:02\sPM$/);
  assert.match(formatWhen(at(8, 15, 20), NOW, 'en-US'), /^on Sep 20 at 8:15\sAM$/);
  assert.match(formatWhen(new Date(2025, 11, 31, 8, 0).toISOString(), NOW, 'en-US'), /^on Dec 31, 2025 at 8:00\sAM$/);
  assert.match(formatUntil(at(15, 15), NOW, 'en-US'), /^3:15\sPM$/);
  assert.match(formatUntil(at(9, 0, 27), NOW, 'en-US'), /^tomorrow at 9:00\sAM$/);
});

test('a successful check that found nothing says so', () => {
  const s = say({ lastSuccessAt: at(14), last: { at: at(14), outcome: 'complete', added: [], removed: [], unconfirmed: 0 } });
  assert.equal(s.tone, 'ok');
  assert.match(s.text, /^Last checked for new sites today at 2:00\sPM\. No new sites\.$/);
});

test('a successful check that found sites names them', () => {
  const s = say({ lastSuccessAt: at(14), last: { at: at(14), outcome: 'complete', added: ['repo:1', 'repo:2'], removed: [], unconfirmed: 1 } });
  assert.match(s.text, /Found 2 new sites: Garden Planner and Recipes\./);
  assert.match(s.text, /1 possible new site couldn’t be confirmed yet and will be checked again\./);
});

test('a check that could not complete is clearly different', () => {
  const s = say({
    lastSuccessAt: at(9, 5),
    retryAt: at(15, 15),
    last: { at: at(14), outcome: 'failed', reason: 'rate-limited', retryAt: at(15, 15), added: [], removed: [], unconfirmed: 0 },
  });
  assert.equal(s.tone, 'warn');
  assert.match(s.text, /^Couldn’t check for new sites \(GitHub asked the library to wait until 3:15\sPM\)\. Showing your saved library, last checked today at 9:05\sAM\.$/);
});

test('an unfinished check says nothing was removed', () => {
  const s = say({ lastSuccessAt: at(9), last: { at: at(14), outcome: 'partial', reason: 'server-error', added: ['repo:1'], removed: [], unconfirmed: 0 } });
  assert.match(s.text, /^The last check for new sites didn’t finish \(GitHub had a problem answering\)\. Nothing was removed\. Found 1 new site: Garden Planner\./);
});

test('offline and first-run states', () => {
  assert.match(say({}, { online: false }).text, /^You’re offline\./);
  assert.equal(say({}).text, 'Not checked for new sites yet.');
  assert.equal(say({}, { checking: true }).text, 'Checking for new sites');
  const failedOffline = say({ last: { at: at(14), outcome: 'failed', reason: 'network', added: [], removed: [], unconfirmed: 0 } }, { online: false });
  assert.match(failedOffline.text, /Showing your saved library\. You’re offline now\.$/);
});

test('long lists of new sites are shortened', () => {
  assert.equal(listTitles(['A']), 'A');
  assert.equal(listTitles(['A', 'B', 'C']), 'A, B, and C');
  assert.equal(listTitles(['A', 'B', 'C', 'D', 'E']), 'A, B, C, and 2 more');
});
