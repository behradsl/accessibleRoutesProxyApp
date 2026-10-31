'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  hostAllowed,
  inspectPrerequisites,
  msiExitOk,
  nodeIsNewEnough,
  nodeMsiUrl,
  redistExitOk,
  stageInstaller,
} = require('./prerequisites.js');

test('Node 20 and newer count as installed', () => {
  assert.equal(nodeIsNewEnough('v22.17.1'), true);
  assert.equal(nodeIsNewEnough('v20.11.0'), true);
  assert.equal(nodeIsNewEnough('v18.20.0'), false);
  assert.equal(nodeIsNewEnough(''), false);
});

test('the Node installer address is the newest 22 x64 package', () => {
  const url = nodeMsiUrl([
    { version: 'v24.1.0' },
    { version: 'v22.21.0' },
    { version: 'v22.17.1' },
  ]);
  assert.equal(url, 'https://nodejs.org/dist/v22.21.0/node-v22.21.0-x64.msi');
  assert.throws(() => nodeMsiUrl([{ version: 'v24.1.0' }]), /Node\.js 22/);
});

test('downloads are limited to Node and Microsoft hosts', () => {
  assert.equal(hostAllowed('nodejs.org'), true);
  assert.equal(hostAllowed('aka.ms'), true);
  assert.equal(hostAllowed('download.visualstudio.microsoft.com'), true);
  assert.equal(hostAllowed('evilnodejs.org'), false);
  assert.equal(hostAllowed('microsoft.com.example'), false);
});

test('installer success includes the reboot and already-installed codes', () => {
  assert.equal(redistExitOk(0), true);
  assert.equal(redistExitOk(1638), true);
  assert.equal(redistExitOk(3010), true);
  assert.equal(redistExitOk(1603), false);
  assert.equal(msiExitOk(0), true);
  assert.equal(msiExitOk(3010), true);
  assert.equal(msiExitOk(1603), false);
});

test('a machine is ready only when the libraries and Node are present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-prereq-'));
  try {
    const missing = inspectPrerequisites({ systemDir: dir, nodeVersion: '', arch: 'x64' });
    assert.equal(missing.supported, true);
    assert.equal(missing.items.find((item) => item.id === 'vcredist').installed, false);
    assert.equal(missing.items.find((item) => item.id === 'node').installed, false);
    for (const file of ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll']) {
      fs.writeFileSync(path.join(dir, file), '');
    }
    const ready = inspectPrerequisites({ systemDir: dir, nodeVersion: 'v22.17.1', arch: 'x64' });
    assert.equal(ready.items.every((item) => item.installed), true);
    const oldNode = inspectPrerequisites({ systemDir: dir, nodeVersion: 'v18.0.0', arch: 'ia32' });
    assert.equal(oldNode.supported, false);
    assert.equal(oldNode.items.find((item) => item.id === 'node').installed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a bundled installer is copied to a normal file before it can be run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fam-stage-'));
  try {
    const sourceDir = path.join(dir, 'vendor');
    fs.mkdirSync(sourceDir);
    const source = path.join(sourceDir, 'node-x64.msi');
    fs.writeFileSync(source, 'installer-bytes');
    const staged = stageInstaller(source, path.join(dir, 'out'), 'node-x64.msi');
    assert.equal(fs.readFileSync(staged, 'utf8'), 'installer-bytes');
    assert.equal(stageInstaller(path.join(sourceDir, 'missing.msi'), path.join(dir, 'out'), 'missing.msi'), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
