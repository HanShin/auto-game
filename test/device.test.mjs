import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDevice } from '../scripts/device.mjs';

// Test the HTTP boundary without a real device or local listening socket.
async function harness(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'starrail-device-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = join(directory, 'state');
  const calls = [], messages = [];
  await writeFile(join(directory, 'device.local.json'), JSON.stringify({
    udid: 'test-ipad', bundleId: 'test.game', teamId: 'test-team', wdaBundleId: 'test.wda',
  }));
  const transport = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body });
    let value;
    if (path === '/session') value = { sessionId: 'test-session' };
    else if (body?.script === 'mobile: activeAppInfo') value = { bundleId: overrides.bundleId ?? 'test.game' };
    else if (path.endsWith('/window/rect')) value = { x: 0, y: 0, width: 1200, height: 800 };
    else if (path.endsWith('/screenshot')) value = overrides.screenshot ?? 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6BqUAAAAASUVORK5CYII=';
    else if (options.method === 'DELETE' && overrides.expired) {
      return Response.json({ value: { error: 'invalid session id', message: 'Expired' } }, { status: 404 });
    } else value = null;
    return Response.json({ value });
  };
  return {
    calls, messages, directory, stateDirectory,
    run: argv => runDevice(argv, { directory, stateDirectory, transport, log: value => messages.push(value) }),
  };
}

test('attach preserves game data and disconnect does not request app termination', async t => {
  const h = await harness(t);
  await h.run(['connect']);
  const caps = h.calls[0].body.capabilities.alwaysMatch;
  assert.equal(caps['appium:noReset'], true);
  assert.equal(caps['appium:forceAppLaunch'], false);
  assert.equal(caps['appium:shouldTerminateApp'], false);
  await assert.rejects(h.run(['connect']), /기존 세션/);
  assert.equal(h.calls.length, 1);
  await h.run(['disconnect']);
  assert.equal(h.calls.at(-1).method, 'DELETE');
  await assert.rejects(readFile(join(h.stateDirectory, 'session.json')), { code: 'ENOENT' });
});

test('normalized input uses device coordinate size rather than screenshot pixels', async t => {
  const h = await harness(t);
  await h.run(['connect']);
  await h.run(['tap', '1', '1']);
  assert.deepEqual(h.calls.at(-1).body, { script: 'mobile: tap', args: [{ x: 1199, y: 799 }] });
  await h.run(['drag', '0', '1', '0.5', '0.5', '900']);
  const gestures = h.calls.at(-1).body.actions[0].actions;
  assert.equal(gestures[0].x, 0);
  assert.equal(gestures[0].y, 799);
  assert.equal(gestures[3].x, 600);
  assert.equal(gestures[3].y, 400);
  assert.deepEqual(gestures[4], { type: 'pause', duration: 900 });
  assert.equal(gestures.at(-1).type, 'pointerUp');
});

test('other foreground apps never receive touch inputs', async t => {
  const h = await harness(t, { bundleId: 'test.settings' });
  await h.run(['connect']);
  await assert.rejects(h.run(['tap', '0.5', '0.5']), /게임이 전면/);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.at(-1).body.script, 'mobile: activeAppInfo');
});

test('invalid coordinates and hold durations send no device requests', async t => {
  const h = await harness(t);
  for (const args of [
    ['tap', 'NaN', '0'], ['tap', '-0.1', '0'], ['tap', '1.1', '0'],
    ['drag', '0', '0', '1', '1', '10001'], ['drag', '0', '0', '1', '1', '-1'],
  ]) await assert.rejects(h.run(args));
  assert.equal(h.calls.length, 0);
});

test('capture persists a PNG and rejects non-image device responses', async t => {
  const h = await harness(t);
  await h.run(['connect']);
  await h.run(['capture']);
  const bytes = await readFile(h.messages.at(-1));
  assert.equal(bytes.readUInt32BE(16), 1);
  assert.equal(bytes.readUInt32BE(20), 1);
  const bad = await harness(t, { screenshot: Buffer.from('not an image').toString('base64') });
  await bad.run(['connect']);
  await assert.rejects(bad.run(['capture']), /PNG/);
});

test('an expired server session can be cleaned up locally', async t => {
  const h = await harness(t, { expired: true });
  await h.run(['connect']);
  await h.run(['disconnect']);
  await assert.rejects(readFile(join(h.stateDirectory, 'session.json')), { code: 'ENOENT' });
});
