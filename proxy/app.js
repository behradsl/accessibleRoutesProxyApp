'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createProxy,
  createRotatingLogger,
  listenPort,
  loadFiles,
  validateConfig,
  validateRoutes,
} = require('./proxy.js');

function appDirectory() {
  if (process.env.APP_DIR) return path.resolve(process.env.APP_DIR);
  if (process.pkg) return path.dirname(process.execPath);
  try {
    if (require('node:sea').isSea()) return path.dirname(process.execPath);
  } catch {
    // Running as a normal Node script.
  }
  return __dirname;
}

const rootDir = appDirectory();
const uiPort = Number(process.env.UI_PORT || 5090);

const state = {
  server: null,
  logger: null,
  address: '',
  error: '',
};

function status() {
  return {
    running: Boolean(state.server),
    address: state.address,
    logFile: state.logger ? state.logger.file() : '',
    lines: state.logger ? state.logger.lines() : [],
    error: state.error,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1000000) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function configPath() {
  return path.join(rootDir, 'config.json');
}

function routesPath() {
  return path.join(rootDir, 'routes.json');
}

function readStoredConfig() {
  const loaded = loadFiles(rootDir);
  return validateConfig(loaded.config);
}

async function startProxy() {
  if (state.server) return status();
  state.error = '';
  const loaded = loadFiles(rootDir);
  const config = validateConfig(loaded.config);
  const logger = createRotatingLogger({
    directory: path.join(rootDir, 'logs'),
    maxBytes: config.maxLogBytes,
  });
  logger.start();
  let created;
  try {
    created = createProxy({
      config: loaded.config,
      routes: loaded.routes,
      routesPath: routesPath(),
      log: logger.log,
    });
  } catch (err) {
    logger.stop();
    throw err;
  }
  const port = listenPort(config);
  await new Promise((resolve, reject) => {
    const onError = (err) => {
      logger.log('START', '-', err.message);
      logger.stop();
      reject(err);
    };
    created.server.once('error', onError);
    created.server.listen(port, config.listenHost, () => {
      created.server.removeListener('error', onError);
      state.server = created.server;
      state.logger = logger;
      state.address = `http://${config.listenHost}:${port}`;
      logger.log('START', '-', `listening on ${config.listenHost}:${port}`);
      resolve();
    });
  });
  return status();
}

function stopProxy() {
  if (!state.server) return status();
  const server = state.server;
  const logger = state.logger;
  state.server = null;
  state.address = '';
  if (logger) logger.log('STOP', '-', 'proxy stopped');
  server.close();
  server.closeAllConnections();
  if (logger) logger.stop();
  return status();
}

function saveConfig(input) {
  const current = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  const next = {
    ...current,
    erpBaseUrl: String(input.erpBaseUrl || '').trim(),
    publicBaseUrl: String(input.publicBaseUrl || '').trim(),
    publicPathPrefix: String(input.publicPathPrefix || '').trim(),
    listenHost: String(input.listenHost || '').trim(),
    port: Number(input.port),
    timeoutMs: Number(input.timeoutMs),
    maxBodyBytes: Number(input.maxBodyBytes),
    maxLogBytes: Number(input.maxLogBytes),
  };
  validateConfig(next);
  fs.writeFileSync(configPath(), `${JSON.stringify(next, null, 2)}\n`);
  return validateConfig(next);
}

function saveRoutes(routes) {
  validateRoutes(routes);
  fs.writeFileSync(routesPath(), `${JSON.stringify(routes, null, 2)}\n`);
  return routes;
}

const page = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>FAM mobile proxy</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: "Segoe UI", sans-serif; background: #f4f6f8; color: #1c2430; }
    header { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 16px 24px; background: #17324d; color: white; }
    h1 { margin: 0; font-size: 20px; font-weight: 650; }
    nav button, .actions button, form button { font: inherit; border: 0; border-radius: 6px; padding: 8px 14px; cursor: pointer; }
    nav button { background: transparent; color: white; }
    nav button.active { background: white; color: #17324d; }
    main { max-width: 980px; margin: 0 auto; padding: 20px; }
    section { display: none; }
    section.active { display: block; }
    .card { background: white; border-radius: 10px; padding: 16px; margin-bottom: 16px; box-shadow: 0 1px 2px rgba(0,0,0,.06); }
    .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    .status { font-weight: 650; }
    .status.running { color: #0b7a3b; }
    .status.stopped { color: #8a3b12; }
    button.start { background: #0b7a3b; color: white; }
    button.stop { background: #a33b32; color: white; }
    button.secondary { background: #e6ebf0; }
    button:disabled { opacity: .45; cursor: default; }
    pre { margin: 0; height: 420px; overflow: auto; background: #101820; color: #d7e2ea; padding: 12px; border-radius: 8px; font-family: Consolas, monospace; font-size: 13px; white-space: pre-wrap; }
    label { display: block; font-size: 13px; margin-bottom: 12px; }
    input, select { width: 100%; margin-top: 4px; padding: 8px; border: 1px solid #c5ced6; border-radius: 6px; font: inherit; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 4px; border-bottom: 1px solid #e6ebf0; font-size: 14px; }
    .error { color: #a33b32; min-height: 1.2em; }
    .hint { color: #526272; font-size: 13px; }
  </style>
</head>
<body>
  <header>
    <h1>FAM mobile proxy</h1>
    <nav>
      <button type="button" id="tab-run" class="active">Connection</button>
      <button type="button" id="tab-manage">Routes and settings</button>
    </nav>
  </header>
  <main>
    <section id="panel-run" class="active">
      <div class="card">
        <div class="row">
          <button type="button" class="start" id="start">Start</button>
          <button type="button" class="stop" id="stop">Stop</button>
          <span class="status stopped" id="status">Stopped</span>
        </div>
        <p class="hint" id="logfile"></p>
        <p class="error" id="run-error"></p>
      </div>
      <div class="card">
        <pre id="log"></pre>
      </div>
    </section>
    <section id="panel-manage">
      <div class="card">
        <h2>Settings</h2>
        <p class="hint">Address changes are used the next time you press Start. The phone uses the public address.</p>
        <form id="settings">
          <label>Rahkaran address<input name="erpBaseUrl" required></label>
          <label>Public address for the phone<input name="publicBaseUrl" required></label>
          <label>Path prefix<input name="publicPathPrefix" placeholder="/mobile"></label>
          <label>Listen address<input name="listenHost" required></label>
          <label>Port<input name="port" type="number" required></label>
          <label>Timeout (milliseconds)<input name="timeoutMs" type="number" required></label>
          <label>Largest request body (bytes)<input name="maxBodyBytes" type="number" required></label>
          <label>Largest log file (bytes)<input name="maxLogBytes" type="number" required></label>
          <button type="submit">Save settings</button>
          <p class="error" id="settings-error"></p>
        </form>
      </div>
      <div class="card">
        <h2>Routes</h2>
        <p class="hint">A route saved here is allowed on the next phone call. The path looks like /Services/FAM/EntranceService.svc/GetBranch.</p>
        <table>
          <thead><tr><th>Method</th><th>Path</th><th></th></tr></thead>
          <tbody id="routes"></tbody>
        </table>
        <form id="add-route" class="row" style="margin-top: 12px;">
          <select name="method" style="width: 110px;"><option>GET</option><option>POST</option></select>
          <input name="path" placeholder="/Services/FAM/Service.svc/Method" required style="flex: 1;">
          <button type="submit">Add route</button>
        </form>
        <p class="error" id="routes-error"></p>
      </div>
    </section>
  </main>
  <script>
    var routes = [];
    var stickToBottom = true;

    function showPanel(name) {
      document.getElementById('panel-run').className = name === 'run' ? 'active' : '';
      document.getElementById('panel-manage').className = name === 'manage' ? 'active' : '';
      document.getElementById('tab-run').className = name === 'run' ? 'active' : '';
      document.getElementById('tab-manage').className = name === 'manage' ? 'active' : '';
    }

    function setError(id, message) {
      document.getElementById(id).textContent = message || '';
    }

    async function api(url, options) {
      var response = await fetch(url, options);
      var body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Request failed');
      return body;
    }

    function drawStatus(body) {
      var status = document.getElementById('status');
      status.textContent = body.running ? 'Running at ' + body.address : 'Stopped';
      status.className = 'status ' + (body.running ? 'running' : 'stopped');
      document.getElementById('start').disabled = body.running;
      document.getElementById('stop').disabled = !body.running;
      document.getElementById('logfile').textContent = body.logFile ? 'Log file: ' + body.logFile : '';
      setError('run-error', body.error);
      var log = document.getElementById('log');
      var distance = log.scrollHeight - log.scrollTop - log.clientHeight;
      if (distance > 40) stickToBottom = false;
      log.textContent = (body.lines || []).join('\\n');
      if (stickToBottom) log.scrollTop = log.scrollHeight;
    }

    function drawRoutes() {
      var body = document.getElementById('routes');
      body.innerHTML = '';
      routes.forEach(function (route, index) {
        var row = document.createElement('tr');
        var method = document.createElement('td');
        method.textContent = route.method;
        var path = document.createElement('td');
        path.textContent = route.path;
        var action = document.createElement('td');
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'secondary';
        button.textContent = 'Remove';
        button.addEventListener('click', function () { removeRoute(index); });
        action.appendChild(button);
        row.appendChild(method);
        row.appendChild(path);
        row.appendChild(action);
        body.appendChild(row);
      });
    }

    async function refresh() {
      try {
        drawStatus(await api('/api/status'));
      } catch (err) {
        setError('run-error', err.message);
      }
    }

    async function loadSettings() {
      var config = await api('/api/config');
      var form = document.getElementById('settings');
      Object.keys(config).forEach(function (key) {
        if (form.elements[key]) form.elements[key].value = config[key] == null ? '' : config[key];
      });
      routes = await api('/api/routes');
      drawRoutes();
    }

    async function removeRoute(index) {
      var next = routes.filter(function (_, item) { return item !== index; });
      try {
        routes = await api('/api/routes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
        drawRoutes();
        setError('routes-error', '');
      } catch (err) {
        setError('routes-error', err.message);
      }
    }

    document.getElementById('tab-run').addEventListener('click', function () { showPanel('run'); });
    document.getElementById('tab-manage').addEventListener('click', function () { showPanel('manage'); });
    document.getElementById('log').addEventListener('scroll', function (event) {
      var log = event.currentTarget;
      stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    });
    document.getElementById('start').addEventListener('click', async function () {
      try {
        drawStatus(await api('/api/start', { method: 'POST' }));
      } catch (err) {
        setError('run-error', err.message);
      }
    });
    document.getElementById('stop').addEventListener('click', async function () {
      try {
        drawStatus(await api('/api/stop', { method: 'POST' }));
      } catch (err) {
        setError('run-error', err.message);
      }
    });
    document.getElementById('settings').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var payload = {
        erpBaseUrl: form.erpBaseUrl.value,
        publicBaseUrl: form.publicBaseUrl.value,
        publicPathPrefix: form.publicPathPrefix.value,
        listenHost: form.listenHost.value,
        port: Number(form.port.value),
        timeoutMs: Number(form.timeoutMs.value),
        maxBodyBytes: Number(form.maxBodyBytes.value),
        maxLogBytes: Number(form.maxLogBytes.value)
      };
      try {
        await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        setError('settings-error', 'Saved. Press Start again to use address changes.');
      } catch (err) {
        setError('settings-error', err.message);
      }
    });
    document.getElementById('add-route').addEventListener('submit', async function (event) {
      event.preventDefault();
      var form = event.currentTarget;
      var next = routes.concat([{ method: form.method.value, path: form.path.value.trim() }]);
      try {
        routes = await api('/api/routes', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
        form.path.value = '';
        drawRoutes();
        setError('routes-error', '');
      } catch (err) {
        setError('routes-error', err.message);
      }
    });

    loadSettings().catch(function (err) { setError('settings-error', err.message); });
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(page);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, status());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/start') {
      sendJson(res, 200, await startProxy());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/stop') {
      sendJson(res, 200, stopProxy());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      sendJson(res, 200, readStoredConfig());
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/config') {
      sendJson(res, 200, saveConfig(await readBody(req)));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/routes') {
      sendJson(res, 200, loadFiles(rootDir).routes);
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/routes') {
      sendJson(res, 200, saveRoutes(await readBody(req)));
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    state.error = err.message;
    sendJson(res, 400, { error: err.message });
  }
}

function openBrowser(url) {
  if (process.env.FAM_NO_BROWSER === '1') return;
  const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function main() {
  const ui = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, 500, { error: err.message });
    });
  });
  ui.listen(uiPort, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${uiPort}`;
    console.log(`FAM mobile proxy control page: ${url}`);
    openBrowser(url);
  });
  ui.on('error', (err) => {
    console.error(err.message);
    process.exit(1);
  });
}

if (require.main === module) main();

module.exports = { main, appDirectory };
