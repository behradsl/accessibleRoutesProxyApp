'use strict';

const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const LIBRARY_FILES = ['vcruntime140.dll', 'vcruntime140_1.dll', 'msvcp140.dll'];
const VC_REDIST_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
const NODE_INDEX_URL = 'https://nodejs.org/dist/index.json';

function nodeIsNewEnough(versionText) {
  const match = /^v(\d+)\./.exec(String(versionText || '').trim());
  return Boolean(match) && Number(match[1]) >= 20;
}

function nodeMsiUrl(releases) {
  const match = (releases || []).find((item) => /^v22\.\d+\.\d+$/.test(item && item.version));
  if (!match) throw new Error('Could not find a Node.js 22 installer');
  return `https://nodejs.org/dist/${match.version}/node-${match.version}-x64.msi`;
}

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase();
  return host === 'nodejs.org'
    || host === 'aka.ms'
    || host === 'microsoft.com'
    || host === 'visualstudio.com'
    || host.endsWith('.microsoft.com')
    || host.endsWith('.visualstudio.com');
}

function redistExitOk(code) {
  return code === 0 || code === 1638 || code === 3010;
}

function msiExitOk(code) {
  return code === 0 || code === 3010;
}

function systemDirectory() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
}

function readCommandVersion(file, args) {
  try {
    return execFileSync(file, args, {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function installedNodeVersion() {
  const standard = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node.exe');
  if (!fs.existsSync(standard)) return '';
  return readCommandVersion(standard, ['-v']);
}

function inspectPrerequisites(options = {}) {
  const dir = options.systemDir || systemDirectory();
  const version = options.nodeVersion === undefined ? installedNodeVersion() : options.nodeVersion;
  const arch = options.arch || process.arch;
  const missingLibs = LIBRARY_FILES.filter((file) => !fs.existsSync(path.join(dir, file)));
  const bundled = bundledInstallerPaths();
  return {
    arch,
    supported: arch === 'x64',
    bundled: {
      vcredist: fs.existsSync(bundled.vcredist),
      node: fs.existsSync(bundled.node),
    },
    items: [
      {
        id: 'vcredist',
        label: 'Visual C++ 2015-2022 libraries',
        installed: missingLibs.length === 0,
        detail: missingLibs.length === 0 ? 'Installed' : `Missing ${missingLibs.join(', ')}`,
      },
      {
        id: 'node',
        label: 'Node.js 20 or newer',
        installed: nodeIsNewEnough(version),
        detail: version || 'Not installed',
      },
    ],
  };
}

function download(url, destination, redirectsLeft = 5, minimumBytes = 1000000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Download address is not valid'));
      return;
    }
    if (parsed.protocol !== 'https:' || !hostAllowed(parsed.hostname)) {
      reject(new Error('Refusing to download from this address'));
      return;
    }
    const request = https.get(url, { headers: { 'User-Agent': 'FAM-mobile-proxy' } }, (response) => {
      const status = response.statusCode || 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('Download was redirected too many times'));
          return;
        }
        resolve(download(new URL(response.headers.location, url).href, destination, redirectsLeft - 1, minimumBytes));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(`Download failed (${status})`));
        return;
      }
      const file = fs.createWriteStream(destination);
      response.pipe(file);
      file.on('error', reject);
      file.on('finish', () => {
        file.close(() => {
          const size = fs.statSync(destination).size;
          if (size < minimumBytes) {
            reject(new Error('Download was incomplete'));
            return;
          }
          resolve(destination);
        });
      });
    });
    request.on('error', reject);
  });
}

function runProcess(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { windowsHide: true });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code == null ? 1 : code));
  });
}

function bundledInstallerPaths() {
  return {
    vcredist: path.join(__dirname, 'vendor', 'vc_redist.x64.exe'),
    node: path.join(__dirname, 'vendor', 'node-x64.msi'),
  };
}

function stageInstaller(source, directory, name) {
  if (!source || !fs.existsSync(source)) return '';
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, name);
  if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
  return destination;
}

async function installVcRedist(directory) {
  let installer = stageInstaller(bundledInstallerPaths().vcredist, directory, 'vc_redist.x64.exe');
  if (!installer) {
    installer = path.join(directory, 'vc_redist.x64.exe');
    await download(VC_REDIST_URL, installer);
  }
  const code = await runProcess(installer, ['/install', '/quiet', '/norestart']);
  if (!redistExitOk(code)) throw new Error(`Visual C++ library install failed (${code})`);
}

async function installNode(directory) {
  let installer = stageInstaller(bundledInstallerPaths().node, directory, 'node-x64.msi');
  if (!installer) {
    const index = await download(NODE_INDEX_URL, path.join(directory, 'index.json'), 5, 1000);
    let releases;
    try {
      releases = JSON.parse(fs.readFileSync(index, 'utf8'));
    } catch {
      throw new Error('Could not read the Node.js download list');
    }
    installer = path.join(directory, 'node-x64.msi');
    await download(nodeMsiUrl(releases), installer);
  }
  const code = await runProcess(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'msiexec.exe'), [
    '/i',
    installer,
    '/quiet',
    '/norestart',
  ]);
  if (!msiExitOk(code)) throw new Error(`Node.js install failed (${code})`);
}

async function installMissingPrerequisites({ rootDir }) {
  const current = inspectPrerequisites();
  if (!current.supported) throw new Error('This installer supports 64-bit Windows.');
  if (current.items.every((item) => item.installed)) return inspectPrerequisites();
  const directory = path.join(rootDir, 'installers');
  fs.mkdirSync(directory, { recursive: true });
  const missing = new Set(current.items.filter((item) => !item.installed).map((item) => item.id));
  if (missing.has('vcredist')) await installVcRedist(directory);
  if (missing.has('node')) await installNode(directory);
  return inspectPrerequisites();
}

module.exports = {
  VC_REDIST_URL,
  NODE_INDEX_URL,
  bundledInstallerPaths,
  hostAllowed,
  inspectPrerequisites,
  installMissingPrerequisites,
  msiExitOk,
  nodeIsNewEnough,
  nodeMsiUrl,
  redistExitOk,
  stageInstaller,
};
