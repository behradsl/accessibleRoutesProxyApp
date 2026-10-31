'use strict';

// Forwards a fixed list of Rahkaran mobile calls from the portal server.
// Day to day, edit config.json and routes.json, then recycle the IIS application pool.
// Edit this file only when the forwarding behavior itself is wrong.
// Functions you are most likely to touch: stripCookieDomain, rewriteLocation, classifyRequest.

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

const ROUTE_PATH = /^\/Services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\.svc\/[A-Za-z0-9]+$/i;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
]);
const UNAVAILABLE = 'The service is temporarily unavailable.';

function stripCookieDomain(cookie) {
  return String(cookie).replace(/;\s*Domain=[^;]*/ig, '');
}

function basePrefixLength(value, base) {
  const left = String(value);
  const right = String(base);
  if (left.length < right.length) return -1;
  if (left.slice(0, right.length).toLowerCase() !== right.toLowerCase()) return -1;
  const next = left.charAt(right.length);
  if (next !== '' && next !== '/' && next !== '?' && next !== '#') return -1;
  return right.length;
}

function rewriteLocation(value, erpBaseUrl, publicBaseUrl) {
  const length = basePrefixLength(value, erpBaseUrl);
  if (length < 0) return value;
  return publicBaseUrl + String(value).slice(length);
}

function readJson(filePath, label) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`${label} could not be read: ${err.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`${label} is not valid JSON: ${err.message}`);
  }
}

function normalizeBase(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be an http or https URL`);
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must be an http or https URL`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not include a user, query, or hash`);
  }
  if (/[?*\\]|\.\./.test(url.pathname)) {
    throw new Error(`${name} path is not allowed`);
  }
  if (url.pathname === '/' || url.pathname === '') return url.origin;
  return url.origin + url.pathname.replace(/\/$/, '');
}

function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config.json must be an object');
  }
  const erpBaseUrl = normalizeBase(config.erpBaseUrl, 'erpBaseUrl');
  const publicBaseUrl = normalizeBase(config.publicBaseUrl, 'publicBaseUrl');
  let publicPathPrefix = config.publicPathPrefix == null ? '' : String(config.publicPathPrefix);
  if (publicPathPrefix === '/') publicPathPrefix = '';
  if (publicPathPrefix) {
    if (!publicPathPrefix.startsWith('/') || publicPathPrefix.endsWith('/') || /[?*\\]|%|\.\./.test(publicPathPrefix)) {
      throw new Error('publicPathPrefix must look like /0407.4');
    }
  }
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error('timeoutMs must be a positive integer number of milliseconds');
  }
  if (!Number.isInteger(config.maxBodyBytes) || config.maxBodyBytes < 1) {
    throw new Error('maxBodyBytes must be a positive integer');
  }
  const maxLogBytes = config.maxLogBytes == null ? 5 * 1024 * 1024 : Number(config.maxLogBytes);
  if (!Number.isInteger(maxLogBytes) || maxLogBytes < 1024) {
    throw new Error('maxLogBytes must be an integer of at least 1024');
  }
  const listenHost = config.listenHost == null || config.listenHost === '' ? '127.0.0.1' : String(config.listenHost);
  if (!/^[A-Za-z0-9.\-:[\]]+$/.test(listenHost)) {
    throw new Error('listenHost must be an IP address');
  }
  const port = config.port == null ? null : Number(config.port);
  if (port != null && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('port must be a TCP port number');
  }
  return {
    erpBaseUrl,
    publicBaseUrl,
    publicPathPrefix,
    listenHost,
    port,
    timeoutMs: config.timeoutMs,
    maxBodyBytes: config.maxBodyBytes,
    maxLogBytes,
  };
}

function validateRoutes(routes) {
  if (!Array.isArray(routes) || routes.length === 0) {
    throw new Error('routes.json must be a non-empty list');
  }
  const allowed = new Map();
  routes.forEach((route, index) => {
    const label = `routes.json entry ${index + 1}`;
    if (!route || typeof route !== 'object' || Array.isArray(route)) {
      throw new Error(`${label} must be an object with method and path`);
    }
    const method = String(route.method || '').toUpperCase();
    const routePath = route.path;
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(`${label}: method must be GET or POST`);
    }
    if (typeof routePath !== 'string' || !ROUTE_PATH.test(routePath) || /[?*\\]|%|\.\./.test(routePath)) {
      throw new Error(`${label}: path must look like /Services/Area/Name.svc/Method`);
    }
    const key = `${method} ${routePath.toLowerCase()}`;
    if (allowed.has(key)) throw new Error(`${label}: duplicate route ${method} ${routePath}`);
    allowed.set(key, routePath);
  });
  return allowed;
}

function loadFiles(dir) {
  return {
    config: readJson(path.join(dir, 'config.json'), 'config.json'),
    routes: readJson(path.join(dir, 'routes.json'), 'routes.json'),
  };
}

function routesMtime(routesPath) {
  try {
    return fs.statSync(routesPath).mtimeMs;
  } catch {
    return 0;
  }
}

function allowedRoutes(routeState, log) {
  if (!routeState.path) return routeState.allowed;
  const mtimeMs = routesMtime(routeState.path);
  if (mtimeMs === routeState.mtimeMs) return routeState.allowed;
  try {
    routeState.allowed = validateRoutes(readJson(routeState.path, 'routes.json'));
    routeState.mtimeMs = mtimeMs;
  } catch (err) {
    routeState.mtimeMs = mtimeMs;
    log('ROUTES', 'GET', err.message);
  }
  return routeState.allowed;
}

function oneLine(value) {
  return String(value).replace(/[\r\n]/g, ' ').slice(0, 500);
}

function formatLogLine(status, method, pathname, detail) {
  const parts = [new Date().toISOString(), String(status), method, oneLine(pathname)];
  if (detail) parts.push(oneLine(detail));
  return parts.join(' ');
}

function makeLogger(logPath) {
  return function log(status, method, pathname, detail) {
    const line = formatLogLine(status, method, pathname, detail);
    console.log(line);
    if (!logPath) return;
    try {
      fs.appendFileSync(logPath, `${line}\n`);
    } catch {
      console.error('Could not write proxy.log');
    }
  };
}

function fileStamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('-');
}

function createRotatingLogger({ directory, maxBytes }) {
  const limit = maxBytes;
  const recent = [];
  const usedNames = new Set();
  let filePath = null;
  let size = 0;
  let active = false;

  function openNew() {
    fs.mkdirSync(directory, { recursive: true });
    const stamp = fileStamp(new Date());
    let name = `${stamp}.txt`;
    let copy = 2;
    while (usedNames.has(name) || fs.existsSync(path.join(directory, name))) {
      name = `${stamp}-${copy}.txt`;
      copy += 1;
    }
    usedNames.add(name);
    filePath = path.join(directory, name);
    fs.closeSync(fs.openSync(filePath, 'a'));
    size = 0;
  }

  function log(status, method, pathname, detail) {
    if (!active) return;
    const line = formatLogLine(status, method, pathname, detail);
    console.log(line);
    const bytes = Buffer.byteLength(`${line}\n`);
    if (!filePath || (size > 0 && size + bytes > limit)) openNew();
    fs.appendFileSync(filePath, `${line}\n`);
    size += bytes;
    recent.push(line);
    if (recent.length > 400) recent.shift();
  }

  return {
    log,
    start() {
      recent.length = 0;
      active = true;
      openNew();
    },
    stop() {
      active = false;
    },
    lines() {
      return recent.slice();
    },
    file() {
      return filePath;
    },
  };
}

function classifyRequest(rawUrl, config) {
  const raw = rawUrl || '/';
  let parsed;
  try {
    parsed = new URL(raw, 'http://127.0.0.1');
  } catch {
    return { forwardPath: null, logPath: '/' };
  }
  const rawPath = raw.split('?')[0];
  const logPath = stripPrefix(parsed.pathname, config.publicPathPrefix);
  if (parsed.search || /[\\%]|\\.\\./.test(rawPath)) {
    return { forwardPath: null, logPath };
  }
  if (!ROUTE_PATH.test(logPath)) return { forwardPath: null, logPath };
  return { forwardPath: logPath, logPath };
}

function stripPrefix(pathname, prefix) {
  if (!prefix) return pathname;
  const lowerPath = pathname.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (lowerPath === lowerPrefix) return '/';
  if (lowerPath.startsWith(`${lowerPrefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

function isAllowed(allowed, method, pathname) {
  return allowed.has(`${String(method).toUpperCase()} ${pathname.toLowerCase()}`);
}

function buildUpstream(erpBaseUrl, pathname) {
  const base = new URL(erpBaseUrl);
  const basePath = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
  const target = new URL(base.origin + basePath + pathname);
  if (target.origin !== base.origin || target.username || target.password || target.search || target.hash) {
    throw new Error('upstream URL is not allowed');
  }
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    throw new Error('upstream path escaped the ERP base');
  }
  return target;
}

function headerCount(rawHeaders, name) {
  let count = 0;
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() === name) count += 1;
  }
  return count;
}

function connectionTokens(rawHeaders) {
  const tokens = new Set();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (rawHeaders[i].toLowerCase() !== 'connection') continue;
    for (const part of String(rawHeaders[i + 1]).split(',')) {
      const token = part.trim().toLowerCase();
      if (token) tokens.add(token);
    }
  }
  return tokens;
}

function requestHeaders(req, host) {
  const drop = connectionTokens(req.rawHeaders);
  const headers = { Host: host };
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower === 'host' || HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    const value = req.rawHeaders[i + 1];
    if (headers[name] == null && headers[lower] == null) {
      headers[name] = value;
      continue;
    }
    const current = headers[name] ?? headers[lower];
    const key = headers[name] == null ? lower : name;
    headers[key] = lower === 'cookie' ? `${current}; ${value}` : `${current}, ${value}`;
  }
  return headers;
}

function publicBaseFor(req, config) {
  if (config.listenHost === '0.0.0.0') {
    const host = req.headers.host;
    if (typeof host === 'string' && /^[A-Za-z0-9.\-:[\]]+$/.test(host)) {
      const scheme = config.publicBaseUrl.startsWith('https:') ? 'https:' : 'http:';
      return `${scheme}//${host}`;
    }
  }
  return config.publicBaseUrl;
}

function responseHeaders(rawHeaders, config, publicBaseUrl) {
  const drop = connectionTokens(rawHeaders);
  const out = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = rawHeaders[i];
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower) || drop.has(lower)) continue;
    let value = rawHeaders[i + 1];
    if (lower === 'set-cookie') value = stripCookieDomain(value);
    else if (lower === 'location') value = rewriteLocation(value, config.erpBaseUrl, publicBaseUrl || config.publicBaseUrl);
    out.push(name, value);
  }
  return out;
}

function sendEmpty(res, status) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status);
  res.end();
}

function discard(req) {
  req.resume();
}

function sendUnavailable(res) {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(502, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(UNAVAILABLE),
  });
  res.end(UNAVAILABLE);
}

function declaredLength(req) {
  if (headerCount(req.rawHeaders, 'content-length') > 1) return { error: 400 };
  const declared = req.headers['content-length'];
  if (declared === undefined) return { length: null };
  if (!/^\d+$/.test(declared)) return { error: 400 };
  return { length: Number(declared) };
}

function cleanDeviceId(value) {
  const text = String(value).trim();
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(text)) return '';
  return text;
}

function deviceIdFromText(text) {
  const match = /"DeviceID"\s*:\s*(?:"([^"]*)"|(\d+))/i.exec(text);
  if (!match) return '';
  return cleanDeviceId(match[1] != null ? match[1] : match[2]);
}

function deviceIdFromHeaders(req) {
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = String(raw[i]).toLowerCase();
    if (name !== 'deviceid' && name !== 'x-device-id' && name !== 'x-deviceid') continue;
    const clean = cleanDeviceId(raw[i + 1]);
    if (clean) return clean;
  }
  return '';
}

function cookieKey(text) {
  const pair = String(text).split(';')[0].trim();
  const eq = pair.indexOf('=');
  if (eq <= 0) return '';
  const name = pair.slice(0, eq).trim().toLowerCase();
  const value = pair.slice(eq + 1).trim();
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) return '';
  if (!value || value.length > 512) return '';
  return `${name}=${value}`;
}

function createDeviceSessions() {
  const sessions = new Map();
  return {
    remember(deviceId, setCookies) {
      const id = cleanDeviceId(deviceId);
      if (!id || !setCookies) return;
      for (const header of setCookies) {
        if (/max-age\s*=\s*0/i.test(header)) continue;
        const key = cookieKey(header);
        if (!key) continue;
        if (sessions.has(key)) sessions.delete(key);
        sessions.set(key, id);
        while (sessions.size > 500) sessions.delete(sessions.keys().next().value);
      }
    },
    lookup(cookieHeader) {
      if (!cookieHeader) return '';
      for (const part of String(cookieHeader).split(';')) {
        const key = cookieKey(part);
        if (key && sessions.has(key)) return sessions.get(key);
      }
      return '';
    },
  };
}

function setCookieValues(rawHeaders) {
  const values = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === 'set-cookie') values.push(rawHeaders[i + 1]);
  }
  return values;
}

function logDetail(deviceId, extra) {
  const parts = [];
  if (deviceId) parts.push(`device ${deviceId}`);
  if (extra) parts.push(String(extra));
  return parts.join(' ');
}

function writeBody(req, upstreamReq, maxBodyBytes, onTooBig, onChunk) {
  let seen = 0;
  let stopped = false;
  req.on('data', (chunk) => {
    if (stopped) return;
    if (onChunk) onChunk(chunk);
    seen += chunk.length;
    if (seen > maxBodyBytes) {
      stopped = true;
      onTooBig();
      return;
    }
    if (!upstreamReq.write(chunk)) {
      req.pause();
      upstreamReq.once('drain', () => req.resume());
    }
  });
  req.on('end', () => {
    if (!stopped) upstreamReq.end();
  });
  req.on('error', () => {
    stopped = true;
    upstreamReq.destroy();
  });
  return () => {
    stopped = true;
  };
}

function forwardRequest(req, res, config, routeState, log, devices) {
  const allowed = allowedRoutes(routeState, log);
  const method = req.method || '';
  const classified = classifyRequest(req.url, config);
  let deviceId = devices.lookup(req.headers.cookie) || deviceIdFromHeaders(req);
  const detail = (extra) => logDetail(deviceId, extra);
  if (!classified.forwardPath || !isAllowed(allowed, method, classified.forwardPath)) {
    log('REJECT', method, classified.logPath, detail());
    sendEmpty(res, 404);
    discard(req);
    return;
  }

  const length = declaredLength(req);
  if (length.error) {
    log(length.error, method, classified.forwardPath, detail());
    sendEmpty(res, length.error);
    discard(req);
    return;
  }
  if (length.length != null && length.length > config.maxBodyBytes) {
    log(413, method, classified.forwardPath, detail());
    sendEmpty(res, 413);
    discard(req);
    return;
  }

  let target;
  try {
    target = buildUpstream(config.erpBaseUrl, classified.forwardPath);
  } catch {
    log('REJECT', method, classified.forwardPath, detail());
    sendEmpty(res, 404);
    discard(req);
    return;
  }

  const lib = target.protocol === 'https:' ? https : http;
  const requestOptions = {
    protocol: target.protocol,
    hostname: target.hostname,
    method,
    path: target.pathname,
    headers: requestHeaders(req, target.host),
    agent: target.protocol === 'https:' ? config.httpsAgent : config.httpAgent,
  };
  if (target.port) requestOptions.port = Number(target.port);
  const upstreamReq = lib.request(requestOptions);

  let settled = false;
  const bodyScan = [];
  let scanned = 0;
  let deviceFromBody = false;
  const stopBody = writeBody(req, upstreamReq, config.maxBodyBytes, () => {
    if (settled) return;
    settled = true;
    upstreamReq.destroy();
    log(413, method, classified.forwardPath, detail());
    sendEmpty(res, 413);
    discard(req);
  }, (chunk) => {
    if (deviceFromBody || scanned >= 8192) return;
    const take = chunk.subarray(0, 8192 - scanned);
    bodyScan.push(take);
    scanned += take.length;
    const found = deviceIdFromText(Buffer.concat(bodyScan).toString('utf8'));
    if (!found) return;
    deviceId = found;
    deviceFromBody = true;
  });

  function fail(err) {
    if (settled) {
      upstreamReq.destroy();
      return;
    }
    settled = true;
    stopBody();
    upstreamReq.destroy();
    const code = err && err.code ? err.code : 'UPSTREAM';
    log(502, method, classified.forwardPath, detail(code));
    sendUnavailable(res);
  }

  upstreamReq.on('error', fail);
  upstreamReq.setTimeout(config.timeoutMs, () => {
    const error = new Error('timeout');
    error.code = 'ETIMEDOUT';
    fail(error);
  });
  req.on('aborted', () => upstreamReq.destroy());
  res.on('close', () => {
    if (!res.writableEnded) upstreamReq.destroy();
  });

  upstreamReq.on('response', (upstreamRes) => {
    if (settled) {
      upstreamRes.destroy();
      return;
    }
    try {
      res.statusCode = upstreamRes.statusCode;
      const headers = responseHeaders(upstreamRes.rawHeaders, config, publicBaseFor(req, config));
      for (let i = 0; i < headers.length; i += 2) res.appendHeader(headers[i], headers[i + 1]);
    } catch (err) {
      upstreamRes.destroy();
      fail(err);
      return;
    }
    settled = true;
    if (/\/login$/i.test(classified.forwardPath)) {
      devices.remember(deviceId, setCookieValues(upstreamRes.rawHeaders));
    }
    log(upstreamRes.statusCode, method, classified.forwardPath, detail());
    upstreamRes.on('error', () => res.destroy());
    res.on('error', () => upstreamRes.destroy());
    upstreamRes.pipe(res);
  });
}

function createProxy({ config, routes, logPath, routesPath, log }) {
  const normalized = validateConfig(config);
  const routeState = {
    allowed: validateRoutes(routes),
    path: routesPath || null,
    mtimeMs: routesPath ? routesMtime(routesPath) : 0,
  };
  const httpAgent = new http.Agent({ keepAlive: true });
  const httpsAgent = new https.Agent({ keepAlive: true });
  normalized.httpAgent = httpAgent;
  normalized.httpsAgent = httpsAgent;
  const writeLog = typeof log === 'function' ? log : makeLogger(logPath);
  const devices = createDeviceSessions();
  const server = http.createServer((req, res) => {
    try {
      forwardRequest(req, res, normalized, routeState, writeLog, devices);
    } catch (err) {
      writeLog(502, req.method || '', req.url || '/', err && err.code ? err.code : 'UPSTREAM');
      sendUnavailable(res);
    }
  });
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });
  server.on('close', () => {
    httpAgent.destroy();
    httpsAgent.destroy();
  });
  return { server, config: normalized, allowed: routeState.allowed };
}

function warnIfSample(config) {
  const erpHost = new URL(config.erpBaseUrl).hostname;
  const publicHost = new URL(config.publicBaseUrl).hostname;
  if (erpHost === '10.0.0.1' || publicHost === 'portal.example.com') {
    console.warn('config.json still has the sample address. Set erpBaseUrl and publicBaseUrl, then recycle the application pool.');
  }
}

function listenPort(config) {
  const port = Number(process.env.PORT || (config && config.port) || 5080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be a TCP port number');
  }
  return port;
}

if (require.main === module) {
  try {
    const loaded = loadFiles(__dirname);
    const { server, config } = createProxy({
      config: loaded.config,
      routes: loaded.routes,
      logPath: path.join(__dirname, 'proxy.log'),
      routesPath: path.join(__dirname, 'routes.json'),
    });
    warnIfSample(config);
    const port = listenPort(config);
    server.listen(port, config.listenHost, () => {
      console.log(`FAM mobile proxy listening on ${config.listenHost}:${port}`);
    });
    server.on('error', (err) => {
      console.error(err.message);
      process.exit(1);
    });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = {
  createProxy,
  loadFiles,
  validateConfig,
  validateRoutes,
  stripCookieDomain,
  rewriteLocation,
  classifyRequest,
  createRotatingLogger,
  listenPort,
};
