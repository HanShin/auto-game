import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, runtime } from '../../scripts/environment.mjs';

export async function buildBridge() {
  if (process.env.GAME_BRIDGE_BINARY) return process.env.GAME_BRIDGE_BINARY;
  const source = resolve(root, 'native/GameBridge.swift');
  const binary = resolve(runtime, 'game-bridge');
  const sourceStat = await stat(source);
  const built = await stat(binary).catch(() => null);
  if (built && built.mtimeMs >= sourceStat.mtimeMs) return binary;
  await mkdir(runtime, { recursive: true });
  await new Promise((yes, no) => {
    const p = spawn('xcrun', ['swiftc', '-parse-as-library', source, '-o', binary, '-module-cache-path', resolve(runtime, 'swift-module-cache')], { stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    p.stderr.on('data', b => { error += b; });
    p.on('error', no);
    p.on('exit', code => code === 0 ? yes() : no(new Error(`Swift 빌드 실패 (${code}): ${error}`)));
  });
  return binary;
}

export class NativeBridge {
  constructor(binary) {
    this.nextId = 0;
    this.pending = new Map();
    this.process = spawn(binary, ['--bridge'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.errors = '';
    this.process.stderr.on('data', b => { this.errors = (this.errors + b).slice(-4000); });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let reply;
      try { reply = JSON.parse(line); } catch { return this.fail(new Error(`잘못된 브리지 응답: ${line}`)); }
      const request = this.pending.get(reply.id);
      if (!request) return;
      this.pending.delete(reply.id);
      clearTimeout(request.timer);
      reply.ok ? request.resolve(reply.result) : request.reject(new Error(reply.error));
    });
    this.process.on('error', e => this.fail(e));
    this.process.stdin.on('error', e => this.fail(e));
    this.process.on('exit', code => this.fail(new Error(`브리지 종료 (${code}): ${this.errors}`)));
  }
  fail(error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  request(command, args = {}) {
    if (this.process.exitCode !== null || this.process.killed) return Promise.reject(new Error('브리지가 종료되었습니다.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`브리지 시간 초과: ${command}. ${this.errors}`));
        this.process.kill();
      }, command === 'capture' ? 120000 : 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.process.stdin.write(JSON.stringify({ ...args, id, command }) + '\n', error => {
        if (error) this.fail(error);
      });
    });
  }
  close() { this.process.stdin.end(); }
}
