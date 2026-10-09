// Read-only project inspection. No game input, process control or network calls.
import { access, readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 20 || (major === 20 && minor < 19)) {
  console.error('Node.js 20.19 이상이 필요합니다.');
  process.exitCode = 1;
} else {
  try {
    const session = JSON.parse(await readFile(new URL('data/langrisser/current-session.json', root), 'utf8'));
    const paths = ['AGENTS.md', 'docs/LANGRISSER-OTHER-PC.md', 'docs/LANGRISSER-GRID-EXECUTION.md',
      'scripts/langrisser-grid-reference.mjs', session.lastCompleted.playbook,
      session.lastCompleted.verification, session.lastCompleted.screenshot];
    for (const path of paths) {
      if (typeof path !== 'string' || path.startsWith('/') || path.includes('..') || path.includes(':') || path.includes('\\')) {
        throw new Error(`저장소 상대 경로가 아닙니다: ${path}`);
      }
      await access(new URL(path, root));
    }
    const playbooks = (await readdir(new URL('docs/langrisser-playbooks/', root))).filter(p => p.endsWith('.md'));
    console.log(JSON.stringify({
      ok: true,
      root: fileURLToPath(root),
      platform: process.platform,
      node: process.versions.node,
      playbookDocuments: playbooks.length,
      lastCompleted: session.lastCompleted,
      stopped: session.stopped,
      gameConnectionVerified: false,
      note: '자료 파일 검사 완료. 이 명령은 게임 연결이나 입력을 하지 않습니다. 새 PC의 연결·클릭·드래그는 별도 검증해야 합니다.'
    }, null, 2));
  } catch (error) {
    console.error(`자료 검사 실패: ${error.message}`);
    process.exitCode = 1;
  }
}
