'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  classifyRequest,
  createProxy,
  createRotatingLogger,
  loadFiles,
  rewriteLocation,
  stripCookieDomain,
  validateConfig,
  validateRoutes,
} = require('./proxy.js');

const DOCUMENTED = [
  { method: 'POST', path: '/Services/FAM/TransactionProcessingService.svc/login' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/GetAcquisitionReceiptList' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/GetAcquisitionReceiptItems' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/GetFixedAssetParts' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/GetCounterParts' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/AssetGroupSuggestionPerPart' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/SaveAcquisitionReceipt' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/AssignPlaqueNumber' },
  { method: 'GET', path: '/Services/FAM/TransactionProcessingService.svc/GetAssetGroup' },
  { method: 'GET', path: '/Services/FAM/TransactionProcessingService.svc/GetBranch' },
  { method: 'GET', path: '/Services/FAM/TransactionProcessingService.svc/GetCollector' },
  { method: 'GET', path: '/Services/FAM/EntranceService.svc/GetDepreciationMethodList' },
  { method: 'POST', path: '/Services/FAM/EntranceService.svc/DeleteAcquisitionReceipt' },
  { method: 'GET', path: '/Services/FAM/TransactionProcessingService.svc/GetCostCenter' },
  { method: 'GET', path: '/Services/FAM/TransactionProcessingService.svc/GetDeliverer' },
  { method: 'GET', path: '/Services/FAM/TransactionProcessingService.svc/GetSettlementPlace' },
  { method: 'POST', path: '/Services/FAM/TransactionProcessingService.svc/GetAssetInventoryList' },
];

const LOGIN = '/Services/FAM/TransactionProcessingService.svc/login';
const ASSIGN = '/Services/FAM/EntranceService.svc/AssignPlaqueNumber';
const PARTS = '/Services/FAM/EntranceService.svc/GetFixedAssetParts';
const GROUPS = '/Services/FAM/TransactionProcessingService.svc/GetAssetGroup';

function sampleConfig(erpBaseUrl, overrides = {}) {
  return {
    erpBaseUrl,
    publicBaseUrl: 'https://portal.example.com/0407.4',
    publicPathPrefix: '/0407.4',
    timeoutMs: 180000,
    maxBodyBytes: 20971520,
    ...overrides,
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stop(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

function call(port, options) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method: options.method,
      path: options.path,
      headers: options.headers || {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    if (options.body == null) req.end();
    else req.end(options.body);
  });
}

function logFile() {
  return path.join(os.tmpdir(), `fam-proxy-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.log`);
}

async function withProxy(handler, fn, overrides = {}) {
  const requests = [];
  let connections = 0;
  const erp = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const recorded = {
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      };
      requests.push(recorded);
      handler(req, res, recorded);
    });
  });
  erp.on('connection', () => {
    connections += 1;
  });
  erp.on('clientError', (_err, socket) => socket.destroy());
  const erpPort = await listen(erp);
  const logPath = logFile();
  const created = createProxy({
    config: sampleConfig(`http://127.0.0.1:${erpPort}/0407.4`, overrides),
    routes: loadFiles(__dirname).routes,
    logPath,
  });
  const proxyPort = await listen(created.server);
  try {
    await fn({
      requests,
      connections: () => connections,
      proxyPort,
      erpPort,
      logPath,
    });
  } finally {
    await stop(created.server);
    await stop(erp);
    fs.rmSync(logPath, { force: true });
  }
}

function respond(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

test('shipped routes are the documented FAM calls', () => {
  const loaded = loadFiles(__dirname);
  assert.deepEqual(loaded.routes, DOCUMENTED);
  assert.equal(validateRoutes(loaded.routes).size, DOCUMENTED.length);
  validateConfig(loaded.config);
});

test('routes.json rejects wildcards, incomplete paths, and other methods', () => {
  const login = { method: 'POST', path: LOGIN };
  assert.throws(() => validateRoutes([{ ...login, path: '/Services/*' }]), /path must look like/);
  assert.throws(() => validateRoutes([{ ...login, path: '/Services/FAM/EntranceService.svc' }]), /path must look like/);
  assert.throws(() => validateRoutes([{ method: 'PUT', path: LOGIN }]), /GET or POST/);
  assert.throws(() => validateRoutes([{ ...login, path: '/Services/../FAM/EntranceService.svc/login' }]), /path must look like/);
  assert.throws(() => validateRoutes([]), /non-empty/);
});

test('config.json rejects users, queries, and wildcard prefixes', () => {
  const good = sampleConfig('http://10.1.1.20/0407.4');
  assert.throws(() => validateConfig({ ...good, erpBaseUrl: 'http://10.1.1.20/0407.4?x=1' }));
  assert.throws(() => validateConfig({ ...good, erpBaseUrl: 'http://user:pass@10.1.1.20/0407.4' }));
  assert.throws(() => validateConfig({ ...good, publicPathPrefix: '/0407.4/*' }));
});

test('stripCookieDomain removes Domain and leaves the rest of the cookie', () => {
  assert.equal(
    stripCookieDomain('sg=1; Domain=erp.internal; Path=/0407.4; HttpOnly'),
    'sg=1; Path=/0407.4; HttpOnly',
  );
  assert.equal(
    stripCookieDomain('b=2; Path=/; Domain=erp.internal'),
    'b=2; Path=/',
  );
});

test('rewriteLocation rewrites only an absolute ERP address', () => {
  const erp = 'http://10.0.0.1/0407.4';
  const pub = 'https://portal.example.com/0407.4';
  assert.equal(rewriteLocation(`${erp}/next`, erp, pub), `${pub}/next`);
  assert.equal(rewriteLocation('/0407.4/next', erp, pub), '/0407.4/next');
  assert.equal(rewriteLocation('http://10.0.0.1/0407.40/next', erp, pub), 'http://10.0.0.1/0407.40/next');
  assert.equal(rewriteLocation('https://other.example/next', erp, pub), 'https://other.example/next');
});

test('classifyRequest strips the public prefix and rejects unsafe paths', () => {
  const config = { publicPathPrefix: '/0407.4' };
  assert.equal(
    classifyRequest(`/0407.4${ASSIGN}`, config).forwardPath,
    ASSIGN,
  );
  assert.equal(classifyRequest(GROUPS, config).forwardPath, GROUPS);
  assert.equal(classifyRequest(`${LOGIN}?wsdl`, config).forwardPath, null);
  assert.equal(classifyRequest('/0407.4/Services/FAM/../EntranceService.svc/login', config).forwardPath, null);
  assert.equal(classifyRequest(`${LOGIN}/extra`, config).forwardPath, null);
  assert.equal(classifyRequest(`${LOGIN}%2fextra`, config).forwardPath, null);
});

test('a raw numeric body and a JSON body are forwarded unchanged', async () => {
  await withProxy((_req, res, recorded) => {
    respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, recorded.body);
  }, async ({ requests, proxyPort, erpPort }) => {
    const plaque = await call(proxyPort, {
      method: 'POST',
      path: `/0407.4${ASSIGN}`,
      headers: { 'Content-Type': 'application/json' },
      body: '845',
    });
    assert.equal(plaque.status, 200);
    assert.equal(plaque.body.toString(), '845');
    assert.equal(requests[0].url, `/0407.4${ASSIGN}`);
    assert.equal(requests[0].headers.host, `127.0.0.1:${erpPort}`);
    assert.equal(requests[0].body.toString(), '845');

    const payload = Buffer.from('{"Title":"رسید تحصیل","ID":0}', 'utf8');
    const saved = await call(proxyPort, {
      method: 'POST',
      path: '/Services/FAM/EntranceService.svc/SaveAcquisitionReceipt',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: payload,
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, payload);
    assert.equal(requests.length, 2);
  });
});

test('an allowed GET is forwarded once', async () => {
  const payload = Buffer.from('{"Data":"رسید"}', 'utf8');
  await withProxy((_req, res) => {
    respond(res, 200, { 'Content-Type': 'application/json; charset=utf-8' }, payload);
  }, async ({ requests, proxyPort }) => {
    const response = await call(proxyPort, { method: 'GET', path: `/0407.4${GROUPS}` });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, payload);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].url, `/0407.4${GROUPS}`);
  });
});

test('the path match is case-insensitive and the client path is preserved', async () => {
  await withProxy((_req, res) => {
    respond(res, 200, { 'Content-Type': 'text/plain' }, 'ok');
  }, async ({ requests, proxyPort }) => {
    const response = await call(proxyPort, {
      method: 'POST',
      path: '/0407.4/services/fam/entranceService.svc/GetFixedAssetParts',
      body: '[]',
    });
    assert.equal(response.status, 200);
    assert.equal(requests[0].url, '/0407.4/services/fam/entranceService.svc/GetFixedAssetParts');
  });
});

test('Set-Cookie Domain is removed and an internal redirect is rewritten', async () => {
  await withProxy((req, res) => {
    res.writeHead(302, [
      'Location', `http://${req.headers.host}/0407.4/next`,
      'Set-Cookie', 'sg=1; Domain=erp.internal; Path=/0407.4; HttpOnly',
      'Set-Cookie', 'b=2; Path=/; Domain=erp.internal',
    ]);
    res.end();
  }, async ({ proxyPort }) => {
    const response = await call(proxyPort, {
      method: 'POST',
      path: `/0407.4${LOGIN}`,
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, 'https://portal.example.com/0407.4/next');
    const cookies = response.headers['set-cookie'];
    assert.ok(Array.isArray(cookies));
    assert.equal(cookies.length, 2);
    assert.equal(cookies.some((cookie) => /domain=/i.test(cookie)), false);
    assert.ok(cookies.some((cookie) => cookie.includes('sg=1') && cookie.includes('Path=/0407.4') && cookie.includes('HttpOnly')));
    assert.ok(cookies.some((cookie) => cookie.includes('b=2') && cookie.includes('Path=/')));
  });
});

test('relative and foreign Location values are left unchanged', async () => {
  await withProxy((_req, res) => {
    respond(res, 302, { Location: '/0407.4/stay' }, '');
  }, async ({ proxyPort }) => {
    const relative = await call(proxyPort, { method: 'GET', path: GROUPS });
    assert.equal(relative.status, 302);
    assert.equal(relative.headers.location, '/0407.4/stay');
  });
  await withProxy((_req, res) => {
    respond(res, 302, { Location: 'https://other.example/stay' }, '');
  }, async ({ proxyPort }) => {
    const foreign = await call(proxyPort, { method: 'GET', path: GROUPS });
    assert.equal(foreign.headers.location, 'https://other.example/stay');
  });
});

test('an ERP error body is passed through', async () => {
  const payload = Buffer.from('{"Errors":"نمی توان حذف کرد"}', 'utf8');
  await withProxy((_req, res) => {
    respond(res, 500, { 'Content-Type': 'application/json; charset=utf-8' }, payload);
  }, async ({ proxyPort }) => {
    const response = await call(proxyPort, {
      method: 'POST',
      path: '/Services/FAM/EntranceService.svc/DeleteAcquisitionReceipt',
      body: '861',
    });
    assert.equal(response.status, 500);
    assert.deepEqual(response.body, payload);
  });
});

test('rejected paths do not open a connection to the ERP', async () => {
  await withProxy((_req, res) => {
    respond(res, 200, {}, 'nope');
  }, async ({ requests, connections, proxyPort, logPath }) => {
    const wrongMethod = await call(proxyPort, { method: 'GET', path: LOGIN });
    const missing = await call(proxyPort, {
      method: 'POST',
      path: '/Services/FAM/EntranceService.svc/NotARealMethod',
    });
    const wsdl = await call(proxyPort, { method: 'POST', path: `${PARTS}?wsdl` });
    const extra = await call(proxyPort, { method: 'POST', path: `${ASSIGN}/extra` });
    const parent = await call(proxyPort, {
      method: 'POST',
      path: '/Services/FAM/../EntranceService.svc/AssignPlaqueNumber',
    });
    for (const response of [wrongMethod, missing, wsdl, extra, parent]) {
      assert.equal(response.status, 404);
      assert.equal(response.body.length, 0);
    }
    assert.equal(requests.length, 0);
    assert.equal(connections(), 0);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /REJECT GET \/Services\/FAM\/TransactionProcessingService\.svc\/login/);
    assert.equal(log.includes('wsdl'), false);
    assert.equal(log.includes('nope'), false);
  });
});

test('the log stores the status and path, not the login body or Authorization header', async () => {
  await withProxy((_req, res, recorded) => {
    respond(res, 200, { 'Content-Type': 'application/json' }, recorded.body);
  }, async ({ requests, proxyPort, logPath }) => {
    const secret = 'YWRtaW4=';
    const token = 'SECRETVALUE';
    await call(proxyPort, {
      method: 'POST',
      path: `/0407.4${LOGIN}`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ UserName: 'admin', Password: secret, DeviceID: '1' }),
    });
    assert.equal(requests[0].headers.authorization, `Bearer ${token}`);
    assert.equal(requests[0].body.includes(secret), true);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /200 POST \/Services\/FAM\/TransactionProcessingService\.svc\/login device 1$/m);
    assert.equal(log.includes(secret), false);
    assert.equal(log.includes(token), false);
    assert.equal(log.includes('admin'), false);
  });
});

test('later calls from the same login are logged with that device id', async () => {
  const cookie = 'sg-auth=SESSIONSECRETVALUE';
  await withProxy((_req, res, recorded) => {
    if (recorded.url.toLowerCase().endsWith('/login')) {
      respond(res, 200, { 'Set-Cookie': `${cookie}; Path=/; HttpOnly`, 'Content-Type': 'application/json' }, '{"Data":{}}');
      return;
    }
    respond(res, 200, {}, 'ok');
  }, async ({ requests, proxyPort, logPath }) => {
    const secret = 'YWRtaW4=';
    await call(proxyPort, {
      method: 'POST',
      path: LOGIN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ UserName: 'admin', Password: secret, DeviceID: 'handset-9' }),
    });
    await call(proxyPort, {
      method: 'GET',
      path: GROUPS,
      headers: { Cookie: cookie },
    });
    assert.equal(requests[1].headers.cookie, cookie);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /200 POST \/Services\/FAM\/TransactionProcessingService\.svc\/login device handset-9/);
    assert.match(log, /200 GET \/Services\/FAM\/TransactionProcessingService\.svc\/GetAssetGroup device handset-9/);
    assert.equal(log.includes(secret), false);
    assert.equal(log.includes('SESSIONSECRETVALUE'), false);
    assert.equal(log.includes('admin'), false);
  });
});

test('a device id that is not a plain id is left out of the log', async () => {
  await withProxy((_req, res) => {
    respond(res, 200, {}, 'ok');
  }, async ({ proxyPort, logPath }) => {
    const secret = 'YWRtaW4=';
    await call(proxyPort, {
      method: 'POST',
      path: LOGIN,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ Password: secret, DeviceID: secret }),
    });
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /200 POST \/Services\/FAM\/TransactionProcessingService\.svc\/login$/m);
    assert.equal(log.includes('device'), false);
    assert.equal(log.includes(secret), false);
  });
});

test('a body larger than maxBodyBytes is refused before calling the ERP', async () => {
  await withProxy((_req, res) => {
    respond(res, 200, {}, 'ok');
  }, async ({ requests, connections, proxyPort }) => {
    const response = await call(proxyPort, {
      method: 'POST',
      path: ASSIGN,
      headers: { 'Content-Type': 'application/json', 'Content-Length': '100' },
      body: '12345',
    });
    assert.equal(response.status, 413);
    assert.equal(requests.length, 0);
    assert.equal(connections(), 0);
  }, { maxBodyBytes: 8 });
});

test('an unreachable ERP returns a generic 502', async () => {
  const closed = http.createServer();
  const closedPort = await listen(closed);
  await stop(closed);
  const logPath = logFile();
  const created = createProxy({
    config: sampleConfig(`http://127.0.0.1:${closedPort}/0407.4`, { timeoutMs: 2000 }),
    routes: loadFiles(__dirname).routes,
    logPath,
  });
  const proxyPort = await listen(created.server);
  try {
    const response = await call(proxyPort, {
      method: 'POST',
      path: ASSIGN,
      body: '845',
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.toString(), 'The service is temporarily unavailable.');
    assert.equal(response.body.includes(String(closedPort)), false);
    assert.equal(response.body.includes('127.0.0.1'), false);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /502 POST \/Services\/FAM\/EntranceService\.svc\/AssignPlaqueNumber ECONNREFUSED/);
  } finally {
    await stop(created.server);
    fs.rmSync(logPath, { force: true });
  }
});

test('each start opens a dated log file and a full file opens another', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-proxy-logs-'));
  const logger = createRotatingLogger({ directory, maxBytes: 120 });
  logger.start();
  const first = path.basename(logger.file());
  assert.match(first, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?\.txt$/);
  logger.log('200', 'GET', '/Services/FAM/TransactionProcessingService.svc/GetAssetGroup');
  logger.log('200', 'GET', '/Services/FAM/TransactionProcessingService.svc/GetAssetGroup');
  logger.log('200', 'GET', '/Services/FAM/TransactionProcessingService.svc/GetAssetGroup');
  logger.stop();
  const names = fs.readdirSync(directory);
  assert.ok(names.length >= 2);
  names.forEach((name) => assert.match(name, /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:-\d+)?\.txt$/));
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a stalled ERP returns a generic 502', async () => {
  await withProxy(() => {}, async ({ proxyPort }) => {
    const response = await call(proxyPort, {
      method: 'GET',
      path: '/Services/FAM/EntranceService.svc/GetDepreciationMethodList',
    });
    assert.equal(response.status, 502);
    assert.equal(response.body.toString(), 'The service is temporarily unavailable.');
    assert.equal(response.body.includes('127.0.0.1'), false);
  }, { timeoutMs: 400 });
});
