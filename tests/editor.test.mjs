import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'vite';

async function browserConnection(browser, profile, url) {
  const child = spawn(browser, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-background-networking',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--window-size=1280,820', url], { windowsHide: true, stdio: 'ignore' });
  let startupError; child.on('error', error => { startupError = error; });
  let socket;
  try {
    const endpoint = join(profile, 'DevToolsActivePort');
    for (let attempt = 0; !existsSync(endpoint) && attempt < 100; attempt++) {
      if (startupError) throw startupError;
      if (child.exitCode !== null) throw new Error('Chromium exited before opening the test page.');
      await delay(100);
    }
    const port = Number(readFileSync(endpoint, 'utf8').split('\n')[0]);
    assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid local browser debugging port');
    let page;
    for (let attempt = 0; !page && attempt < 50; attempt++) {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = tabs.find(tab => tab.type === 'page' && tab.url === url); if (!page) await delay(100);
    }
    assert.ok(page, 'Chromium did not open the fixture');
    socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    let sequence = 0; const pending = new Map();
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data), request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timeout);
      if (message.error) request.reject(new Error(message.error.message)); else request.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Chromium connection closed.')); }
      pending.clear();
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++sequence, timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Chromium ${method} timed out.`)); }, 45000);
      pending.set(id, { resolve, reject, timeout }); socket.send(JSON.stringify({ id, method, params }));
    });
    return { call, async close() {
      try { await Promise.race([call('Browser.close'), delay(2000)]); }
      catch { /* Browser shutdown can close its connection before replying. */ }
      finally { socket.close(); if (child.exitCode === null) child.kill(); await delay(200); }
    } };
  } catch (error) { socket?.close(); child.kill(); throw error; }
}

for (const fixture of ['editor', 'finance']) test(`Chromium ${fixture} interactions preserve data through editing and reload`, { timeout: 60000 }, async t => {
  const browser = [process.env.NOTER_TEST_BROWSER,
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  ].find(path => path && existsSync(path));
  if (!browser) { t.skip('Install Chromium/Chrome/Edge or set NOTER_TEST_BROWSER to run interaction checks.'); return; }
  const temporary = mkdtempSync(join(tmpdir(), 'noter-editor-check-'));
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false,
    cacheDir: join(temporary, 'vite'), optimizeDeps: { noDiscovery: true, include: ['highlight.js/lib/common', 'highlight.js/lib/languages/powershell'] }, logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: true },
  });
  let connection;
  try {
    await server.listen();
    const address = server.httpServer.address();
    connection = await browserConnection(browser, join(temporary, 'profile'), `http://127.0.0.1:${address.port}/tests/${fixture}.html`);
    await connection.call('Page.enable'); await connection.call('Page.bringToFront');
    let ready = false;
    for (let attempt = 0; !ready && attempt < 100; attempt++) {
      try {
        const document = await connection.call('Runtime.evaluate', { returnByValue: true, expression: `document.readyState === 'complete' && document.body?.dataset.${fixture}Check !== undefined` });
        ready = document.result.value === true;
      } catch (error) { if (error.message !== 'Execution context was destroyed.') throw error; }
      if (!ready) await delay(100);
    }
    assert.ok(ready, 'Fixture page did not finish loading.');
    // Use real browser time: virtual-time dump-dom can finish before native dialog close events.
    const { result, exceptionDetails } = await connection.call('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise(resolve => {
      const started = Date.now(); const poll = () => {
        const state = document.body?.dataset.${fixture}Check;
        if (state === 'passed' || state === 'failed' || Date.now() - started > 40000) resolve({ state, text: document.getElementById('result')?.textContent || 'Pending fixture; active control: ' + document.activeElement?.getAttribute('aria-label') });
        else setTimeout(poll, 25);
      }; poll();
    })` });
    assert.equal(exceptionDetails, undefined, 'Fixture evaluation failed');
    assert.equal(result.value.state, 'passed', result.value.text || 'Interaction checks did not finish.');
    t.diagnostic(result.value.text);
    if (fixture === 'finance' && process.env.NOTER_FINANCE_SCREENSHOT) {
      const screenshot = await connection.call('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      writeFileSync(process.env.NOTER_FINANCE_SCREENSHOT, Buffer.from(screenshot.data, 'base64'));
    }
  } finally {
    await connection?.close();
    await server.close();
    const target = resolve(temporary);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && target.includes('noter-editor-check-'), 'Unexpected test cleanup path');
    rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
