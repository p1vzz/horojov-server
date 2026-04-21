import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('Usage: node scripts/run-quiet.mjs <command> [...args]');
  process.exit(1);
}

const startedAt = Date.now();
const [command, ...commandArgs] = args;
const displayCommand = args.join(' ');
const logDir = path.resolve(process.cwd(), '.cache', 'quiet-run');
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const safeName = args
  .join('-')
  .replace(/[^a-zA-Z0-9._-]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 72) || 'command';
const logPath = path.join(logDir, `${safeName}-${timestamp}.log`);
const tailLines = [];
const maxTailLines = 140;

fs.mkdirSync(logDir, { recursive: true });
const logStream = fs.createWriteStream(logPath, { flags: 'w' });

function record(chunk) {
  const text = chunk.toString();
  logStream.write(text);
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    tailLines.push(line);
    if (tailLines.length > maxTailLines) {
      tailLines.shift();
    }
  }
}

const child = spawn(command, commandArgs, {
  cwd: process.cwd(),
  env: process.env,
  shell: process.platform === 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
});

child.stdout.on('data', record);
child.stderr.on('data', record);

child.on('error', (error) => {
  logStream.end(() => {
    console.error(`[quiet] ${displayCommand} failed to start: ${error.message}`);
    console.error(`[quiet] Full log: ${path.relative(process.cwd(), logPath)}`);
    process.exit(1);
  });
});

child.on('close', (code, signal) => {
  const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  const relativeLogPath = path.relative(process.cwd(), logPath);

  logStream.end(() => {
    if (code === 0) {
      console.log(`[quiet] ${displayCommand} passed in ${durationSeconds}s`);
      console.log(`[quiet] Full log: ${relativeLogPath}`);
      return;
    }

    const exitLabel = signal ? `signal ${signal}` : `exit ${code ?? 1}`;
    console.error(`[quiet] ${displayCommand} failed with ${exitLabel} after ${durationSeconds}s`);
    console.error(`[quiet] Full log: ${relativeLogPath}`);
    console.error('[quiet] Last output lines:');
    console.error(tailLines.join('\n') || '(no output)');
    process.exit(code ?? 1);
  });
});
