// Downloads the monosplice binary built for this platform and parks it next to the
// launcher in bin/. npm is a fallback distribution channel for the Rust binary — the
// primary one is `curl … install.sh | sh` — so this file has no dependencies.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const { version } = require('./package.json');
const RELEASES = 'https://github.com/jakequist/monosplice/releases';

// The same mapping install.sh makes, and the triples src/commands/update.rs expects.
const TARGETS = {
  'linux x64': 'x86_64-unknown-linux-musl',
  'linux arm64': 'aarch64-unknown-linux-musl',
  'darwin x64': 'x86_64-apple-darwin',
  'darwin arm64': 'aarch64-apple-darwin',
  'win32 x64': 'x86_64-pc-windows-msvc',
};

const windows = process.platform === 'win32';
const exeName = windows ? 'monosplice.exe' : 'monosplice';
const nativeName = windows ? 'monosplice-native.exe' : 'monosplice-native';

function fail(message) {
  process.stderr.write(`monosplice: ${message}\n`);
  process.exit(1);
}

// Node's https does not follow redirects, and the release asset URL redirects to
// object storage — so follow them by hand rather than take a dependency.
function download(url, dest, hops) {
  return new Promise((resolve, reject) => {
    if (hops > 10) {
      reject(new Error(`too many redirects fetching ${url}`));
      return;
    }
    const request = https.get(
      url,
      { headers: { 'user-agent': `monosplice-npm-installer/${version}` } },
      (response) => {
        const status = response.statusCode;
        if (status >= 300 && status < 400 && response.headers.location) {
          response.resume();
          resolve(download(new URL(response.headers.location, url).toString(), dest, hops + 1));
          return;
        }
        if (status !== 200) {
          response.resume();
          reject(new Error(`GitHub answered HTTP ${status} for ${url}`));
          return;
        }
        const file = fs.createWriteStream(dest);
        file.on('error', reject);
        file.on('finish', () => file.close((err) => (err ? reject(err) : resolve())));
        response.on('error', reject);
        response.pipe(file);
      },
    );
    request.on('error', reject);
  });
}

async function main() {
  const target = TARGETS[`${process.platform} ${process.arch}`];
  if (!target) {
    fail(`there is no prebuilt monosplice binary for ${process.platform}/${process.arch}.
Browse the releases at ${RELEASES}, or build it yourself:
  cargo install monosplice`);
  }

  // The exact versioned asset, never "latest": this package's launcher must run the
  // binary its own version promises.
  const url = `${RELEASES}/download/v${version}/monosplice-${version}-${target}.tar.gz`;
  const binDir = path.join(__dirname, 'bin');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'monosplice-install-'));
  const tarball = path.join(work, 'monosplice.tar.gz');

  try {
    await download(url, tarball, 0);
    if (!fs.existsSync(tarball) || fs.statSync(tarball).size === 0) {
      throw new Error(`the download from ${url} was empty`);
    }
    // tar ships with macOS, every Linux, and Windows 10+ (as bsdtar).
    execFileSync('tar', ['-xzf', tarball, '-C', work], { stdio: 'ignore' });
    const unpacked = path.join(work, exeName);
    if (!fs.existsSync(unpacked)) {
      throw new Error(`that release archive holds no ${exeName}`);
    }
    fs.mkdirSync(binDir, { recursive: true });
    const installed = path.join(binDir, nativeName);
    fs.copyFileSync(unpacked, installed);
    fs.chmodSync(installed, 0o755);
    process.stdout.write(`monosplice ${version} (${target}) installed\n`);
  } catch (err) {
    fail(`could not install the monosplice ${version} binary.
${err.message}
Check your network and reinstall, or use the standalone installer:
  curl -fsSL ${RELEASES}/latest/download/install.sh | sh`);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main();
