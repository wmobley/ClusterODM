const assert = require('assert');
const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

const launcher = fs.readFileSync(path.join(__dirname, '..', 'run-clusterodm-tapis.sh'), 'utf8');

assert.ok(launcher.includes('TAPIS_TOKEN_FILE'), 'launcher should support a mounted token file');
assert.ok(launcher.includes('TAPIS_TOKEN'), 'launcher should support a runtime token environment variable');
assert.ok(!/WORKING_TOKEN\s*=/.test(launcher), 'launcher must not define a source-controlled token');
assert.ok(!/"token"\s*:\s*"\$TAPIS_TOKEN"/.test(launcher), 'generated config must not persist the token');
assert.ok(launcher.includes("trap 'unset TAPIS_TOKEN TAPIS_TOKEN_FILE' EXIT"), 'launcher should clear secret variables on exit');
assert.ok(launcher.includes('relying on WebODM per-request authentication'), 'launcher should allow request-scoped authentication without a startup token');

const trackedSources = [
    path.join(__dirname, '..', 'libs', 'classes', 'TapisNode.js'),
    path.join(__dirname, '..', 'libs', 'proxy.js'),
    path.join(__dirname, '..', 'libs', 'taskNew.js')
].map(file => fs.readFileSync(file, 'utf8')).join('\n');

assert.ok(!/logger\.[a-z]+\([^\n]*(?:token=|token\s*=|substring\(0,\s*8\))/.test(trackedSources),
    'tracked Tapis logging must not include bearer tokens or token prefixes');

const trackedFiles = childProcess.execFileSync('git', ['ls-files', '-z'], {
    cwd: path.join(__dirname, '..')
}).toString().split('\0').filter(Boolean);
const jwtPattern = /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/;
for (const file of trackedFiles) {
    const absolutePath = path.join(__dirname, '..', file);
    if (!fs.statSync(absolutePath).isFile()) continue;
    const contents = fs.readFileSync(absolutePath, 'utf8');
    assert.ok(!jwtPattern.test(contents), `tracked file contains a JWT literal: ${file}`);
}

console.log('TAPIS SECRET HYGIENE TEST PASSED');
