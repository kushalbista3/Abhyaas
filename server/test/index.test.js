import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = fileURLToPath(new URL('../src/index.js', import.meta.url));

// Runs `node src/index.js` with a throwaway DB. Env vars win over the root .env.
function startServer(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abhyaas-index-'));
  const child = spawn(process.execPath, [INDEX], {
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'test.db') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  const cleanup = async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { child, exited, cleanup, out: () => stdout, err: () => stderr };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(25);
  }
  return null;
}

test('the server keeps running after startup and answers /api/health', async () => {
  const s = startServer(0);
  try {
    const port = await waitFor(() => s.out().match(/http:\/\/0\.0\.0\.0:(\d+)/)?.[1]);
    assert.ok(port, `no startup banner. stdout: ${s.out()} stderr: ${s.err()}`);
    await sleep(500);
    assert.equal(s.child.exitCode, null, 'process exited after startup');
    assert.match(s.out(), new RegExp(`LAPTOP_URL=http://[\\d.]+:${port} node gateway\\.mjs|No LAN address`));
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).ok, true);
    assert.equal(s.child.exitCode, null, 'still running after a request');
  } finally {
    await s.cleanup();
  }
});

test('a port that is already taken fails loudly with exit code 1, no banner', async () => {
  const blocker = net.createServer().listen(0, '0.0.0.0');
  await new Promise((r) => blocker.once('listening', r));
  const s = startServer(blocker.address().port);
  try {
    const code = await Promise.race([s.exited, sleep(5000).then(() => 'timeout')]);
    assert.equal(code, 1);
    assert.match(s.err(), /already in use/);
    assert.doesNotMatch(s.out(), /Abhyaas server on/);
  } finally {
    await s.cleanup();
    blocker.close();
  }
});
