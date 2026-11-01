'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RULE_POOL = 'FAM-mobile-proxy';

function forwardingPlan(config, port) {
  const prefix = String(config.publicPathPrefix || '').trim();
  if (!prefix) return null;
  if (!/^\/[A-Za-z0-9._~-]+$/.test(prefix)) {
    throw new Error('Path prefix must be one segment, such as /FAMmobileService.');
  }
  const url = new URL(config.publicBaseUrl);
  const alias = prefix.slice(1);
  const listenPort = Number(port);
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error('port must be a TCP port number');
  }
  return {
    host: url.hostname,
    protocol: url.protocol,
    alias,
    port: listenPort,
    rewriteUrl: `http://127.0.0.1:${listenPort}/${alias}/{R:0}`,
  };
}

function buildWebConfig(plan) {
  return `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="${RULE_POOL}" stopProcessing="true">
          <match url=".*" />
          <action type="Rewrite" url="${plan.rewriteUrl}" appendQueryString="true" />
        </rule>
      </rules>
    </rewrite>
  </system.webServer>
</configuration>
`;
}

function selectSite(sites, host) {
  const wanted = String(host || '').toLowerCase();
  const exact = [];
  const blank = [];
  for (const site of sites || []) {
    for (const binding of site.bindings || []) {
      const bindingHost = String(binding.host || '').toLowerCase();
      if (bindingHost === wanted) exact.push(site.name);
      else if (!bindingHost) blank.push(site.name);
    }
  }
  const unique = (names) => [...new Set(names)];
  const exactNames = unique(exact);
  if (exactNames.length === 1) return exactNames[0];
  if (exactNames.length > 1) throw new Error(`More than one IIS site has ${host}.`);
  const blankNames = unique(blank);
  if (blankNames.length === 1) return blankNames[0];
  if (blankNames.length > 1) throw new Error(`More than one IIS site could receive ${host}.`);
  throw new Error(`No IIS site is bound to ${host}.`);
}

function readScript() {
  return fs.readFileSync(path.join(__dirname, 'iis-forward.ps1'));
}

function runPowershell(args, elevated) {
  const script = path.join(__dirname, 'iis-forward.ps1');
  const resultPath = args.resultPath;
  const ps = powershellPath();
  const fileArgs = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-Action', args.action,
    '-HostName', args.host || '',
    '-Alias', args.alias || '',
    '-Port', String(args.port || 0),
    '-PhysicalPath', args.physicalPath || '',
    '-ResultPath', resultPath,
  ];
  if (!elevated) return spawnCollected(ps, fileArgs);
  const argumentList = fileArgs.map((value) => quote(value)).join(',');
  const command = `Start-Process -FilePath ${quote(ps)} -ArgumentList ${argumentList} -Verb RunAs -Wait`;
  return spawnCollected(ps, ['-NoProfile', '-Command', command]).then(() => readResult(resultPath));
}

function powershellPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

function quote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function spawnCollected(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => err.push(chunk));
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve({
        code: code == null ? 1 : code,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}

function readResult(resultPath) {
  if (!fs.existsSync(resultPath)) {
    return { code: 1, stdout: '', stderr: 'Administrator approval was cancelled.' };
  }
  const text = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '');
  return { code: 0, stdout: text, stderr: '' };
}

function parseResult(run) {
  const text = String(run.stdout || '').replace(/^\uFEFF/, '').trim();
  const line = text.split(/\r?\n/).filter(Boolean).pop() || '';
  try {
    const parsed = JSON.parse(line);
    if (!parsed.ok) throw new Error(parsed.message || 'IIS configuration failed.');
    return parsed;
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(run.stderr.trim() || line || 'IIS configuration failed.');
    }
    throw err;
  }
}

function resultText(run, resultPath) {
  const stdout = String(run.stdout || '').replace(/^\uFEFF/, '').trim();
  if (stdout) return stdout;
  if (resultPath && fs.existsSync(resultPath)) return fs.readFileSync(resultPath, 'utf8');
  return run.stderr || '';
}

async function configureIis(action, plan, physicalPath, elevated) {
  const resultPath = path.join(physicalPath, 'result.json');
  fs.rmSync(resultPath, { force: true });
  const run = await runPowershell({
    action,
    host: plan.host,
    alias: plan.alias,
    port: plan.port,
    physicalPath,
    resultPath,
  }, elevated);
  if (!elevated && run.code !== 0) {
    const message = `${run.stdout}\n${run.stderr}`;
    if (/Access is denied|0x80070005|requires elevation/i.test(message)) {
      return configureIis(action, plan, physicalPath, true);
    }
  }
  return parseResult({ ...run, stdout: resultText(run, resultPath) });
}

async function applyIisForwarding(config, port, physicalPath, options = {}) {
  const plan = forwardingPlan(config, port);
  if (!plan) return null;
  fs.mkdirSync(physicalPath, { recursive: true });
  fs.writeFileSync(path.join(physicalPath, 'web.config'), buildWebConfig(plan));
  if (options.skip) return { ...plan, site: '', skipped: true };
  const result = await configureIis('add', plan, physicalPath, Boolean(options.elevated));
  const applied = { ...plan, site: result.site || '' };
  fs.writeFileSync(path.join(physicalPath, 'applied.json'), `${JSON.stringify(applied)}\n`);
  return applied;
}

async function removeIisForwarding(physicalPath, options = {}) {
  const appliedPath = path.join(physicalPath, 'applied.json');
  if (!fs.existsSync(appliedPath)) return null;
  const applied = JSON.parse(fs.readFileSync(appliedPath, 'utf8'));
  if (options.skip) return applied;
  await configureIis('remove', applied, physicalPath, Boolean(options.elevated));
  fs.rmSync(appliedPath, { force: true });
  return applied;
}

module.exports = {
  RULE_POOL,
  applyIisForwarding,
  buildWebConfig,
  forwardingPlan,
  readScript,
  removeIisForwarding,
  selectSite,
};
