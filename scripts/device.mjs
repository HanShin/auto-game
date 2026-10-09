import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, runtime } from './environment.mjs';

const help = `아이패드 연결 / 입력 검증 도구 (자동 완주 기능은 아직 없음)

npm run device -- connect
npm run device -- capture
npm run device -- tap X Y
npm run device -- drag FROM_X FROM_Y TO_X TO_Y HOLD_MS
npm run device -- lock
npm run device -- disconnect

좌표는 현재 가로/세로 화면 기준 0~1 비율입니다. 예: 화면 중앙 = 0.5 0.5
drag는 시작점에서 끝점으로 움직인 뒤 HOLD_MS 동안 누르고 있다가 놓습니다.
device.example.json을 device.local.json으로 복사하고 기기/서명 정보를 설정하세요.`;

function requester(transport) {
 return async function request(base, method, path, body, timeout = 30000) {
  const response = await transport(`${base.replace(/\/$/, '')}${path}`, {
    method, headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const payload = await response.json();
  if (!response.ok || payload.value?.error) {
    const error = new Error(payload.value?.message || `Appium HTTP ${response.status}`);
    error.code = payload.value?.error;
    throw error;
  }
  return payload.value;
 };
}

function fraction(value) {
  const number = Number(value);
  if (value === undefined || value === '' || !Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error('좌표는 0~1 사이 숫자로 입력하세요.');
  }
  return number;
}

export async function runDevice(argv, {
  directory = root, stateDirectory = runtime, transport = fetch, log = console.log,
} = {}) {
  const sessionPath = resolve(stateDirectory, 'session.json');
  const request = requester(transport);
  const [command, ...args] = argv;
  if (!command || command === '--help') return log(help);
  if (!['connect', 'capture', 'tap', 'drag', 'lock', 'disconnect'].includes(command)) {
    throw new Error(`알 수 없는 명령: ${command}\n${help}`);
  }
  // Validate inputs before starting any device operations.
  let coordinates, hold;
  if (command === 'tap' || command === 'drag') {
    if (args.length !== (command === 'tap' ? 2 : 5)) throw new Error(help);
    coordinates = args.slice(0, command === 'tap' ? 2 : 4).map(fraction);
    if (command === 'drag') {
      hold = Number(args[4]);
      if (!Number.isInteger(hold) || hold < 0 || hold > 10000) throw new Error('HOLD_MS 범위: 정수 0~10000');
    }
  }
  await mkdir(stateDirectory, { recursive: true });
  if (command === 'connect') {
    try {
      await readFile(sessionPath);
      throw new Error('기존 세션 기록이 있습니다. 먼저 disconnect를 실행하세요.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    let config;
    try { config = JSON.parse(await readFile(resolve(directory, 'device.local.json'), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('device.local.json이 필요합니다. device.example.json을 참고하세요.');
      throw error;
    }
    if (!config.udid || !config.bundleId) throw new Error('device.local.json에 udid와 실제 게임 bundleId를 입력하세요.');
    if (!config.webDriverAgentUrl && (!config.teamId || !config.wdaBundleId)) {
      throw new Error('WDA 서명용 teamId와 wdaBundleId가 필요합니다.');
    }
    const base = config.serverUrl || 'http://127.0.0.1:4723';
    const capabilities = {
      platformName: 'iOS', 'appium:automationName': 'XCUITest',
      'appium:udid': config.udid, 'appium:bundleId': config.bundleId,
      'appium:noReset': true, 'appium:shouldTerminateApp': false,
      'appium:forceAppLaunch': false, 'appium:newCommandTimeout': 3600,
      'appium:waitForIdleTimeout': 0,
      'appium:derivedDataPath': resolve(stateDirectory, 'DerivedData'),
      'appium:showXcodeLog': true,
    };
    if (config.platformVersion) capabilities['appium:platformVersion'] = config.platformVersion;
    if (config.allowProvisioningDeviceRegistration === true) {
      capabilities['appium:allowProvisioningDeviceRegistration'] = true;
    }
    if (config.webDriverAgentUrl) capabilities['appium:webDriverAgentUrl'] = config.webDriverAgentUrl;
    else Object.assign(capabilities, {
      'appium:xcodeOrgId': config.teamId,
      'appium:xcodeSigningId': 'Apple Development',
      'appium:updatedWDABundleId': config.wdaBundleId,
    });
    const session = await request(base, 'POST', '/session', {
      capabilities: { alwaysMatch: capabilities, firstMatch: [{}] },
    }, 300000);
    if (!session?.sessionId) throw new Error('Appium이 세션 ID를 반환하지 않았습니다. 서버 로그를 확인하세요.');
    await writeFile(sessionPath, JSON.stringify({ base, id: session.sessionId, bundleId: config.bundleId }, null, 2));
    log('연결됐습니다. npm run device -- capture로 실제 게임 화면을 확인하세요.');
    return;
  }
  let session;
  try { session = JSON.parse(await readFile(sessionPath, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('연결된 세션이 없습니다. 먼저 connect를 실행하세요.');
    throw error;
  }
  const call = (method, path, body) => request(session.base, method, `/session/${session.id}${path}`, body);
  if (command === 'lock') {
    await call('POST', '/appium/device/lock', { seconds: 0 });
    const locked = await call('POST', '/appium/device/is_locked', {});
    if (locked !== true) throw new Error('잠금 요청을 보냈지만 기기 잠금 상태가 확인되지 않았습니다.');
    log('아이패드 잠금을 확인했습니다. 자동으로 잠금을 해제하지 않습니다.');
    return;
  }
  if (command === 'disconnect') {
    try { await call('DELETE', ''); }
    catch (error) {
      // An expired session needs no server-side cleanup.
      if (error.code !== 'invalid session id') throw error;
    }
    await unlink(sessionPath);
    log('제어 세션을 종료했습니다.');
    return;
  }
  if (command === 'capture') {
    const data = await call('GET', '/screenshot');
    const bytes = Buffer.from(data, 'base64');
    if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('기기에서 PNG 화면 캡처를 받지 못했습니다.');
    }
    const path = resolve(stateDirectory, `screen-${Date.now()}.png`);
    await writeFile(path, bytes);
    log(path);
    return;
  }
  const active = await call('POST', '/execute/sync', { script: 'mobile: activeAppInfo', args: [{}] });
  if (active?.bundleId !== session.bundleId) throw new Error('게임이 전면에 없습니다. 게임을 연 뒤 다시 실행하세요.');
  const { width, height } = await call('GET', '/window/rect');
  if (!(width > 0 && height > 0)) throw new Error('유효한 화면 크기를 받지 못했습니다.');
  const x = value => Math.round(value * (width - 1));
  const y = value => Math.round(value * (height - 1));
  const [fromX, fromY, toX, toY] = coordinates;
  if (command === 'tap') {
    await call('POST', '/execute/sync', { script: 'mobile: tap', args: [{ x: x(fromX), y: y(fromY) }] });
  } else {
    await call('POST', '/actions', { actions: [{
      type: 'pointer', id: 'finger', parameters: { pointerType: 'touch' },
      actions: [
        { type: 'pointerMove', duration: 0, origin: 'viewport', x: x(fromX), y: y(fromY) },
        { type: 'pointerDown', button: 0 },
        { type: 'pause', duration: 100 },
        { type: 'pointerMove', duration: 200, origin: 'viewport', x: x(toX), y: y(toY) },
        { type: 'pause', duration: hold },
        { type: 'pointerUp', button: 0 },
      ],
    }] });
  }
  log('입력을 보냈습니다. capture로 결과를 확인하세요.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runDevice(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
