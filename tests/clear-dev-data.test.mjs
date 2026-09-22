import test from 'node:test';
import assert from 'node:assert/strict';
import { managedRuntimePidsFromProcessList, processIdFromText, processIdsFromLines } from '../scripts/clear-dev-data.mjs';

test('development data cleanup recognizes only the managed QQ runtime executable', () => {
  const executable = '/repo/.dev-data/runtime/QQRuntime.app/Contents/MacOS/QQ';
  const processes = [
    ` 7859 /repo/.dev-data/runtime/QQRuntime.app/Contents/MacOS/QQ --disable-gpu`,
    ` 7875 /repo/.dev-data/runtime/QQRuntime.app/Contents/Frameworks/QQ Helper.app/Contents/MacOS/QQ Helper --type=utility`,
    ` 9000 /Applications/QQ.app/Contents/MacOS/QQ`,
    ` 9001 ${executable}-old --disable-gpu`,
  ].join('\n');

  assert.deepEqual(managedRuntimePidsFromProcessList(processes, executable), [7859]);
});

test('Windows process output ignores empty lines and invalid process identifiers', () => {
  assert.deepEqual(processIdsFromLines(''), []);
  assert.deepEqual(processIdsFromLines('\r\n 421 \r\nnot-a-pid\r\n0\r\n'), [421]);
});

test('the application PID marker accepts only a positive process identifier', () => {
  assert.equal(processIdFromText(' 421\n'), 421);
  assert.equal(processIdFromText(''), undefined);
  assert.equal(processIdFromText('not-a-pid'), undefined);
  assert.equal(processIdFromText('0'), undefined);
});
