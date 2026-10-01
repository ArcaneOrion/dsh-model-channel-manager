/** Own the temporary profile/server and browser run, then release both. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcm-browser-'));
  const env = { ...process.env, MCM_PREVIEW_FILE: path.join(dir, 'url') };
  const server = spawn(process.execPath, ['tests/browser/preview.cjs'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Preview startup timed out')), 15000);
      server.stdout.on('data', chunk => { if (String(chunk).includes('Preview ready')) { clearTimeout(timer); resolve(); } });
      server.once('exit', code => { clearTimeout(timer); reject(new Error('Preview exited: ' + code)); });
      server.once('error', reject);
    });
    const browser = spawn('uv', ['run', '--with', 'playwright', 'python', 'tests/browser/e2e.py'], { env, stdio: 'inherit' });
    const [code] = await once(browser, 'exit');
    process.exitCode = code ?? 1;
  } finally {
    if (server.exitCode === null) { server.kill('SIGTERM'); await once(server, 'exit'); }
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
