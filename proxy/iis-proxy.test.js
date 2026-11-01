'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { buildWebConfig, forwardingPlan, scriptOnDisk, selectSite, stageFiles } = require('./iis-proxy.js');

function decodeCommandText(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ''));
  const utf16 = (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE)
    || (buffer.length >= 4 && buffer[1] === 0 && buffer[3] === 0);
  return (utf16 ? buffer.toString('utf16le') : buffer.toString('utf8')).replace(/^\uFEFF/, '');
}

const config = {
  publicBaseUrl: 'https://rahkaran.nahavandcement.com/FAMmobileService',
  publicPathPrefix: '/FAMmobileService',
};

test('a path prefix plans one IIS application and one forwarded prefix', () => {
  const plan = forwardingPlan(config, 5080);
  assert.equal(plan.host, 'rahkaran.nahavandcement.com');
  assert.equal(plan.alias, 'FAMmobileService');
  assert.equal(plan.rewriteUrl, 'http://127.0.0.1:5080/FAMmobileService/{R:0}');
  const xml = buildWebConfig(plan);
  assert.equal(xml.includes('/FAMmobileService/FAMmobileService'), false);
  assert.equal(xml.includes('http://127.0.0.1:5080/FAMmobileService/{R:0}'), true);
});

test('an empty path prefix does not change IIS', () => {
  assert.equal(forwardingPlan({ ...config, publicPathPrefix: '' }, 5080), null);
});

test('a prefix with more than one segment is refused', () => {
  assert.throws(
    () => forwardingPlan({ ...config, publicPathPrefix: '/FAMmobileService/extra' }, 5080),
    /one segment/,
  );
});

test('the IIS script is written to a normal folder before PowerShell runs it', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-iis-script-'));
  try {
    const script = scriptOnDisk(dir);
    assert.equal(path.dirname(script), dir);
    assert.equal(script.includes(`${path.sep}snapshot${path.sep}`), false);
    const text = fs.readFileSync(script, 'utf8');
    assert.equal(text.includes('param('), true);
    assert.equal(text.includes('Install-BundledModule'), true);
    assert.equal(text.includes('ProcessStartInfo'), true);
    assert.equal(text.includes("ArgumentList @('/i'"), false);
    const source = path.join(dir, 'rewrite_amd64_en-US.msi');
    fs.writeFileSync(source, 'rewrite-bytes');
    const staged = stageFiles(path.join(dir, 'out'), [{ name: 'rewrite_amd64_en-US.msi', source }]);
    assert.equal(fs.readFileSync(staged['rewrite_amd64_en-US.msi'], 'utf8'), 'rewrite-bytes');
    assert.equal(staged['rewrite_amd64_en-US.msi'].includes(`${path.sep}snapshot${path.sep}`), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Windows Installer accepts a package path that contains spaces', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam msi '));
  const installer = path.join(dir, 'fake package.msi');
  fs.writeFileSync(installer, 'not a package');
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const run = spawnSync(powershell, [
      '-NoProfile',
      '-File',
      path.join(__dirname, 'iis-forward.ps1'),
      '-Action',
      'probe-installer',
      '-RewriteInstaller',
      installer,
    ], { timeout: 30000, windowsHide: true });
    assert.equal(run.error, undefined);
    const output = Buffer.isBuffer(run.stdout) ? run.stdout : Buffer.from(String(run.stdout || ''));
    const text = decodeCommandText(output).trim();
    const code = Number(text);
    assert.equal(code === 1639, false);
    assert.equal(code === 1619 || code === 1620, true);
    const logText = decodeCommandText(fs.readFileSync(`${installer}.log`));
    assert.equal(logText.includes('Verbose logging started'), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the site is chosen by the public host name', () => {
  const sites = [
    { name: 'Default Web Site', bindings: [{ host: '' }] },
    { name: 'Portal', bindings: [{ host: 'rahkaran.nahavandcement.com' }] },
    { name: 'Other', bindings: [{ host: 'sales.example.com' }] },
  ];
  assert.equal(selectSite(sites, 'rahkaran.nahavandcement.com'), 'Portal');
  assert.equal(selectSite([{ name: 'Default Web Site', bindings: [{ host: '' }] }], 'rahkaran.nahavandcement.com'), 'Default Web Site');
  assert.throws(
    () => selectSite([
      { name: 'A', bindings: [{ host: '' }] },
      { name: 'B', bindings: [{ host: '' }] },
    ], 'rahkaran.nahavandcement.com'),
    /More than one IIS site/,
  );
});
