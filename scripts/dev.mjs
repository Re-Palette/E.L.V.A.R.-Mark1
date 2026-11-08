// Cross-platform "run server + web dev server together" (the old `a & b` script does not work on Windows).
import { spawn } from 'node:child_process';

const run = (cmd, args) => spawn(cmd, args, { stdio: 'inherit', shell: true });
const procs = [
  run('node', ['--env-file-if-exists=.env', 'server/index.js']),
  run('npx', ['vite', 'web', '--host']),
];
const stop = () => { for (const p of procs) { try { p.kill(); } catch {} } };
for (const p of procs) p.on('exit', (code) => { stop(); process.exit(code ?? 0); });
process.on('SIGINT', () => { stop(); process.exit(0); });
process.on('SIGTERM', () => { stop(); process.exit(0); });
