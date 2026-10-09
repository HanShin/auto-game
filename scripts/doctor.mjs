import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { developerEnvironment, root, runtime } from './environment.mjs';

const env = developerEnvironment();
let failed = false;
function check(label, command, args) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: 25000 });
  console.log(`\n[${result.status === 0 ? 'OK' : '준비 필요'}] ${label}`);
  console.log((result.stdout || result.stderr || result.error?.message || '').trim());
  if (result.status !== 0) failed = true;
  return result.status === 0;
}

console.log(`Node ${process.version}`);
console.log(`Xcode 경로: ${env.DEVELOPER_DIR || '(xcode-select 기본값)'}`);
check('Xcode 버전', 'xcodebuild', ['-version']);
const ready = check('Xcode 초기 설정', 'xcodebuild', ['-checkFirstLaunchStatus']);
if (ready) {
  mkdirSync(runtime, { recursive: true });
  const path = resolve(runtime, `devices-${Date.now()}.json`);
  if (check('연결된 기기', 'xcrun', ['devicectl', 'list', 'devices', '--json-output', path])) {
    const devices = JSON.parse(readFileSync(path, 'utf8')).result?.devices ?? [];
    if (devices.length === 0) {
      failed = true;
      console.log('아이패드를 USB로 연결하고 잠금을 해제한 뒤 이 컴퓨터를 신뢰해 주세요.');
    } else {
      let readyIpads = 0;
      for (const device of devices) {
        const properties = device.properties ?? {};
        const hardware = properties.hardware ?? device.hardwareProperties ?? {};
        if (hardware.deviceType !== 'iPad') continue;
        const connection = properties.connection ?? device.connectionProperties ?? {};
        const legacy = device.deviceProperties ?? {};
        const mode = properties.state?.developerModeStatus;
        const developerMode = typeof mode === 'object' && mode !== null
          ? Object.keys(mode)[0] : mode ?? legacy.developerModeStatus;
        const connected = (connection.state ?? connection.tunnelState) === 'connected';
        const name = properties.state?.name ?? legacy.name ?? 'iPad';
        console.log(`${name}: 연결 ${connected ? '확인' : '안 됨'}, 개발자 모드 ${developerMode ?? '확인 불가'}`);
        if (connected && developerMode === 'enabled') readyIpads++;
        if (developerMode === 'disabled') {
          console.log('아이패드 설정 → 개인정보 보호 및 보안 → 개발자 모드를 켜고 재시동 후 활성화를 확인하세요.');
        }
      }
      if (readyIpads === 0) failed = true;
    }
  }
} else {
  console.log('Xcode를 열어 약관과 최초 실행 설정을 완료해야 기기를 확인할 수 있습니다.');
}
for (const name of ['appium', 'appium-xcuitest-driver']) {
  const path = resolve(root, 'node_modules', name, 'package.json');
  if (existsSync(path)) console.log(`[OK] ${name} ${JSON.parse(readFileSync(path, 'utf8')).version}`);
  else { failed = true; console.log(`[준비 필요] ${name}: npm install 실행`); }
}
console.log('\n이 점검은 기기 조작이나 게임 완주 검증을 대신하지 않습니다.');
process.exitCode = failed ? 1 : 0;
