import { spawnSync } from 'node:child_process';

const syntaxCheck = "import ast,pathlib; ast.parse(pathlib.Path('scripts/import_fineli.py').read_text(encoding='utf-8'))";
const commands = process.platform === 'win32'
  ? [['py', ['-3', '-c', syntaxCheck]], ['python', ['-c', syntaxCheck]]]
  : [['python3', ['-c', syntaxCheck]], ['python', ['-c', syntaxCheck]]];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (!result.error && result.status === 0) process.exit(0);
}

console.error('No usable Python interpreter was found for scripts/import_fineli.py.');
process.exit(1);
