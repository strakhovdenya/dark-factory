const test = require('node:test');
const assert = require('node:assert');
const { buildTaskRules } = require('./prompts');
const { hasDelRalphMarker } = require('./workspace');

const promptMarkerExamples = () => {
  const rules = buildTaskRules(150, []).join('\n');
  const spans = [...rules.matchAll(/`([^`\n]*DEL_RALPH:[^`\n]*)`/g)];
  return spans.map((match) => match[1]);
};

test('prompt still documents at least one marker example', () => {
  assert.ok(promptMarkerExamples().length > 0);
});

test('every marker example from the prompt is detected as a first-line marker', () => {
  for (const example of promptMarkerExamples()) {
    assert.ok(hasDelRalphMarker(`${example}\nconst a = 1;\n`), example);
  }
});

test('detects the bare form and every allowed comment prefix', () => {
  const prefixes = ['', '// ', '//', '# ', '/* ', '<!-- ', '-- ', '  // '];
  for (const prefix of prefixes) {
    const head = `${prefix}DEL_RALPH: migrated\nrest`;
    assert.ok(hasDelRalphMarker(head), JSON.stringify(prefix));
  }
});

test('handles CRLF, BOM and a marker-only file', () => {
  assert.ok(hasDelRalphMarker('// DEL_RALPH: x\r\nrest'));
  assert.ok(hasDelRalphMarker('﻿// DEL_RALPH: x\nrest'));
  assert.ok(hasDelRalphMarker('DEL_RALPH: x'));
});

test('ignores a marker that is not on the first line', () => {
  assert.strictEqual(hasDelRalphMarker('const a = 1;\n// DEL_RALPH: x\n'), false);
  assert.strictEqual(hasDelRalphMarker('\n// DEL_RALPH: x\n'), false);
});

test('ignores mentions of the marker inside other text', () => {
  assert.strictEqual(hasDelRalphMarker('// see DEL_RALPH: docs\n'), false);
  assert.strictEqual(hasDelRalphMarker('const s = "DEL_RALPH: x";\n'), false);
  assert.strictEqual(hasDelRalphMarker(''), false);
});

// --- permission profiles and project gate (issue #398) ---

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  writeAgentPermissions,
  writeReviewerPermissions,
  writeCodeReviewPermissions,
  runProjectGate,
} = require('./workspace');

const withTempDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ralph-workspace-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

const readSettings = (dir) =>
  JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8')).permissions;

const PROFILES = {
  agent: writeAgentPermissions,
  reviewer: writeReviewerPermissions,
  codeReview: writeCodeReviewPermissions,
};

test('no profile allows npm run or bare npx; checks are an explicit npx list', () => {
  for (const [name, write] of Object.entries(PROFILES)) {
    withTempDir((dir) => {
      write(dir);
      const { allow, deny } = readSettings(dir);
      assert.ok(!allow.some((rule) => rule.startsWith('Bash(npm run')), name);
      assert.ok(!allow.includes('Bash(npx *)'), name);
      for (const tool of ['tsc', 'jest', 'eslint', 'vitest']) {
        assert.ok(allow.includes(`Bash(npx ${tool} *)`), `${name}: ${tool}`);
      }
      assert.ok(allow.every((rule) => !rule.startsWith('Bash(npx') || /^Bash\(npx (tsc|jest|eslint|vitest)( \*)?\)$/.test(rule)), name);
      assert.ok(deny.includes('Bash(npx prisma migrate reset*)'), name);
      assert.ok(deny.includes('Bash(npx prisma db push*)'), name);
    });
  }
});

test('reviewer and code-review profiles deny every Edit and Write', () => {
  for (const write of [writeReviewerPermissions, writeCodeReviewPermissions]) {
    withTempDir((dir) => {
      write(dir);
      const { allow, deny } = readSettings(dir);
      assert.ok(deny.includes('Edit(**)'));
      assert.ok(deny.includes('Write(**)'));
      assert.ok(!allow.some((rule) => /^(Edit|Write)\b/.test(rule)));
    });
  }
  withTempDir((dir) => {
    writeCodeReviewPermissions(dir);
    assert.ok(readSettings(dir).allow.includes('Skill(code-review)'));
  });
});

test('agent profile keeps Edit/Write but denies protected paths', () => {
  withTempDir((dir) => {
    writeAgentPermissions(dir);
    const { allow, deny } = readSettings(dir);
    assert.ok(allow.includes('Edit') && allow.includes('Write'));
    for (const pattern of ['.claude/**', 'scripts/**', '.github/**', '.husky/**', '.git/**', 'apps/api/prisma/prompts/**', 'apps/api/knowledge-sources/**']) {
      assert.ok(deny.includes(`Edit(${pattern})`), pattern);
      assert.ok(deny.includes(`Write(${pattern})`), pattern);
    }
  });
});

const initRepo = (dir) => {
  const run = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
  run('init', '-q');
  fs.mkdirSync(path.join(dir, 'apps', 'api'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'apps', 'api', 'a.ts'), 'export {};\n');
  run('add', '-A');
  run('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
};

test('project gate runs fixed tool binaries without npm run', () => {
  withTempDir((dir) => {
    initRepo(dir);
    const calls = [];
    const result = runProjectGate(dir, ['apps/api', 'apps/web'], (cwd, script, args) => {
      calls.push([path.relative(dir, cwd).replace(/\\/g, '/'), script, ...args].join(' '));
      return 'ok';
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(calls, [
      'apps/api node_modules/typescript/bin/tsc --noEmit',
      'apps/api node_modules/eslint/bin/eslint.js --fix-dry-run {src,libs,test}/**/*.ts',
      'apps/api node_modules/jest/bin/jest.js',
      'apps/web node_modules/typescript/bin/tsc --noEmit',
      'apps/web node_modules/eslint/bin/eslint.js .',
      'apps/web node_modules/vitest/vitest.mjs run',
    ]);
    assert.ok(calls.every((call) => !call.split(' ').includes('--fix') && !call.includes('npm')));
  });
});

test('project gate fails when a check changes the working tree', () => {
  withTempDir((dir) => {
    initRepo(dir);
    const result = runProjectGate(dir, ['apps/api'], (cwd, script) => {
      if (script.includes('jest')) fs.writeFileSync(path.join(dir, 'apps', 'api', 'a.ts'), 'changed\n');
      return 'ok';
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.output, /git status changed while the gate was running/);
  });
});

test('project gate stops at the first failing check', () => {
  withTempDir((dir) => {
    initRepo(dir);
    const result = runProjectGate(dir, ['apps/api'], (cwd, script) => {
      if (script.includes('eslint')) throw Object.assign(new Error('lint failed'), { stdout: 'x.ts: error' });
      return 'ok';
    });
    assert.strictEqual(result.ok, false);
    assert.match(result.output, /x\.ts: error/);
    assert.doesNotMatch(result.output, /jest/);
  });
});

// --- sandbox (issue #506): claude config, gate and installs run in Docker ---

const crypto = require('crypto');
const sandbox = require('./sandbox');
const {
  prepareAgentSessionDir,
  createSandboxGateRunner,
  installDependencies,
  syncLockfileIfPackageJsonChanged,
} = require('./workspace');

const SANDBOX_CONFIG = sandbox.validateSandboxConfig(require('./config.example.json').sandbox);
const BOX = { image: SANDBOX_CONFIG.image, rootKey: `test${crypto.randomBytes(4).toString('hex')}`, runLabel: 'issue-test' };

// Mounted dirs must be outside the operator's home (INV-10); on Windows os.tmpdir() is inside it.
const SCRATCH_FALLBACK = path.join(__dirname, '..', '..', '.ralph-sandbox-tmp');
const withScratchOutsideHome = async (fn) => {
  const root = [os.tmpdir(), SCRATCH_FALLBACK].find((dir) => !sandbox.isInsideHome(dir));
  assert.ok(root, 'no scratch directory outside the operator home');
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'ralph-ws-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

let imageReady = false;
const ensureImage = () => {
  if (imageReady) return;
  sandbox.assertAvailable();
  sandbox.buildImage(SANDBOX_CONFIG, { stdio: 'ignore' });
  imageReady = true;
};

test.after(() => {
  if (imageReady) sandbox.removeLeftovers(BOX.rootKey);
});

const commitAll = (dir, message) => {
  execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', message], { cwd: dir, stdio: 'ignore' });
};

test('sandbox claude config trusts run dir', () => {
  withTempDir((sessionsRoot) => {
    const first = prepareAgentSessionDir(sessionsRoot, '01-implement');
    const config = JSON.parse(fs.readFileSync(path.join(first, '.claude.json'), 'utf8'));
    assert.strictEqual(config.projects[sandbox.CONTAINER_WORKDIR].hasTrustDialogAccepted, true);
    // One fresh dir per agent call: nothing the implementer left in its own dir (settings, hooks)
    // reaches a later pass, and a reused label starts empty again.
    fs.writeFileSync(path.join(first, 'settings.json'), '{"hooks":{}}');
    const second = prepareAgentSessionDir(sessionsRoot, '02-self-review');
    assert.notStrictEqual(second, first);
    assert.deepStrictEqual(fs.readdirSync(second), ['.claude.json']);
    const reused = prepareAgentSessionDir(sessionsRoot, '01-implement');
    assert.deepStrictEqual(fs.readdirSync(reused), ['.claude.json']);
  });
});

test('sandbox mode does not write operator claude config', () => {
  withTempDir((fakeHome) => {
    const operatorConfig = path.join(fakeHome, '.claude.json');
    const original = '{"projects":{}}\n';
    fs.writeFileSync(operatorConfig, original);
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      assert.strictEqual(os.homedir(), fakeHome);
      withTempDir((sessionsRoot) => prepareAgentSessionDir(sessionsRoot, '01-implement'));
      assert.strictEqual(fs.readFileSync(operatorConfig, 'utf8'), original);
      assert.strictEqual(require('./workspace').trustRunDir, undefined);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

// Each fake tool fails unless it runs in a container with no network interface but loopback.
const SANDBOX_PROBE_TOOL = [
  "const fs = require('fs');",
  "const inContainer = fs.existsSync('/.dockerenv');",
  "const interfaces = fs.existsSync('/sys/class/net') ? fs.readdirSync('/sys/class/net') : [];",
  "if (!inContainer || interfaces.join() !== 'lo') { console.error('not sandboxed: ' + interfaces.join()); process.exitCode = 1; }",
  "else console.log('sandboxed ' + process.argv.slice(2).join(' '));",
].join('\n');

test('runProjectGate runs inside sandbox without network', async () => {
  ensureImage();
  await withScratchOutsideHome((dir) => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    commitAll(dir, 'ignore');
    const tools = ['node_modules/typescript/bin/tsc', 'node_modules/eslint/bin/eslint.js', 'node_modules/jest/bin/jest.js'];
    for (const script of tools) {
      const file = path.join(dir, 'apps', 'api', script);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, SANDBOX_PROBE_TOOL);
    }
    const result = runProjectGate(dir, ['apps/api'], createSandboxGateRunner(dir, BOX));
    assert.strictEqual(result.ok, true, result.output);
    assert.match(result.output, /sandboxed --noEmit/);
    assert.strictEqual((result.output.match(/✅/g) || []).length, 3);
    // The host is not a sandbox: the same probe fails when run directly.
    const onHost = spawnSync(process.execPath, [path.join(dir, 'apps', 'api', tools[0])], { encoding: 'utf8' });
    assert.notStrictEqual(onHost.status, 0);
  });
});

const { spawnSync } = require('child_process');

// is-number: tiny, dependency-free package from the public registry, reached through the proxy.
const PREINSTALL_PROBE = [
  "const fs = require('fs');",
  "const where = { container: fs.existsSync('/.dockerenv'), proxy: process.env.HTTPS_PROXY || null, installEnv: process.env.RALPH_TEST_INSTALL_ENV || null };",
  "fs.writeFileSync('where.json', JSON.stringify(where));",
].join(' ');

const appPackageJson = (dependencies) =>
  JSON.stringify({ name: 'sandbox-install-probe', version: '1.0.0', private: true, scripts: { preinstall: 'node probe.js' }, dependencies }, null, 2) + '\n';

const writeApp = (dir, dependencies) => {
  const app = path.join(dir, 'apps', 'api');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, 'probe.js'), PREINSTALL_PROBE);
  fs.writeFileSync(path.join(app, 'package.json'), appPackageJson(dependencies));
};

test('dependency install runs inside sandbox', async () => {
  ensureImage();
  const proxy = sandbox.startProxy({ ...BOX, allowedHosts: SANDBOX_CONFIG.allowedHosts });
  try {
    await withScratchOutsideHome((root) => {
      const dir = path.join(root, 'issue-1');
      fs.mkdirSync(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\nwhere.json\n');
      writeApp(dir, { 'is-number': '7.0.0' });
      const box = {
        ...BOX,
        network: proxy.network,
        proxyUrl: proxy.proxyUrl,
        installEnv: { RALPH_TEST_INSTALL_ENV: 'from-config' },
        logsDir: path.join(root, 'issue-1-sessions'),
      };
      installDependencies(dir, box);
      assert.ok(fs.existsSync(path.join(dir, 'apps', 'api', 'node_modules', 'is-number', 'package.json')));
      const where = JSON.parse(fs.readFileSync(path.join(dir, 'apps', 'api', 'where.json'), 'utf8'));
      assert.deepStrictEqual(where, { container: true, proxy: proxy.proxyUrl, installEnv: 'from-config' });
      assert.ok(fs.readdirSync(box.logsDir).some((file) => file.startsWith('install-apps_api-')));

      commitAll(dir, 'init');
      writeApp(dir, { 'is-number': '6.0.0' });
      const sync = syncLockfileIfPackageJsonChanged(dir, box);
      assert.deepStrictEqual(sync, { ok: true, ran: true });
      const lock = JSON.parse(fs.readFileSync(path.join(dir, 'apps', 'api', 'package-lock.json'), 'utf8'));
      assert.strictEqual(lock.packages['node_modules/is-number'].version, '6.0.0');
    });
  } finally {
    proxy.stop();
  }
});

test('a failed sandbox install keeps its full output in a log named in the error', async () => {
  ensureImage();
  const proxy = sandbox.startProxy({ ...BOX, allowedHosts: SANDBOX_CONFIG.allowedHosts });
  try {
    await withScratchOutsideHome((root) => {
      const dir = path.join(root, 'issue-1');
      fs.mkdirSync(dir);
      execFileSync('git', ['init', '-q'], { cwd: dir });
      writeApp(dir, {});
      commitAll(dir, 'init');
      const missing = `ralph-no-such-package-${crypto.randomBytes(4).toString('hex')}`;
      writeApp(dir, { [missing]: '1.0.0' });
      const box = { ...BOX, network: proxy.network, proxyUrl: proxy.proxyUrl, installEnv: {}, logsDir: path.join(root, 'issue-1-sessions') };
      const sync = syncLockfileIfPackageJsonChanged(dir, box);
      assert.strictEqual(sync.ok, false);
      assert.ok(sync.logPath.startsWith(box.logsDir));
      assert.ok(sync.error.includes(sync.logPath));
      const log = fs.readFileSync(sync.logPath, 'utf8');
      assert.ok(log.includes('E404') && log.includes(missing), 'the npm error is in the log');
      assert.throws(() => installDependencies(dir, box), (error) => error.message.includes(box.logsDir));
    });
  } finally {
    proxy.stop();
  }
});

test('a gate check cannot plant anything in .git', async () => {
  ensureImage();
  await withScratchOutsideHome((dir) => {
    initRepo(dir);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
    commitAll(dir, 'ignore');
    const tool = path.join(dir, 'apps', 'api', 'node_modules/typescript/bin/tsc');
    fs.mkdirSync(path.dirname(tool), { recursive: true });
    fs.writeFileSync(tool, "require('fs').writeFileSync('/workspace/.git/hooks/pre-commit', '#!/bin/sh\\necho planted\\n');");
    const result = runProjectGate(dir, ['apps/api'], createSandboxGateRunner(dir, BOX));
    assert.strictEqual(result.ok, false);
    assert.strictEqual(fs.existsSync(path.join(dir, '.git', 'hooks', 'pre-commit')), false);
  });
});

test('each run of an issue gets its own sessions dir', () => {
  const { runSessionsDirFor, sessionsRootFor } = require('./workspace');
  const root = path.join(os.tmpdir(), 'runs');
  const first = runSessionsDirFor(root, 7, new Date('2026-10-09T10:00:00.000Z'));
  const second = runSessionsDirFor(root, 7, new Date('2026-10-09T11:30:00.000Z'));
  assert.notStrictEqual(first, second);
  for (const dir of [first, second]) assert.strictEqual(path.dirname(dir), sessionsRootFor(root, 7));
  assert.ok(!/[:]/.test(path.basename(first)), 'the run folder name is valid on Windows');
});

// --- review fixes: the clone is untrusted input for host-side actions ---

test('host git status ignores an fsmonitor planted in the clone', () => {
  withTempDir((dir) => {
    initRepo(dir);
    const marker = path.join(dir, 'fsmonitor-ran');
    const script = path.join(dir, 'monitor.js');
    fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x');`);
    execFileSync('git', ['config', 'core.fsmonitor', `"${process.execPath.replace(/\\/g, '/')}" "${script.replace(/\\/g, '/')}"`], { cwd: dir });
    require('./workspace').gitStatusZ(dir);
    assert.strictEqual(fs.existsSync(marker), false);
  });
});

test('agent settings are never written through a link', () => {
  withTempDir((outside) => {
    withTempDir((dir) => {
      const victim = path.join(outside, 'victim.txt');
      fs.writeFileSync(victim, 'operator file\n');
      fs.mkdirSync(path.join(dir, '.claude'));
      const settings = path.join(dir, '.claude', 'settings.local.json');
      let fileLinkCreated = true;
      try {
        fs.symlinkSync(victim, settings, 'file');
      } catch (error) {
        // Windows without the symlink privilege: the directory-link case below still runs.
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
        fileLinkCreated = false;
      }
      if (fileLinkCreated) {
        writeReviewerPermissions(dir);
        assert.strictEqual(fs.readFileSync(victim, 'utf8'), 'operator file\n');
        assert.strictEqual(fs.lstatSync(settings).isSymbolicLink(), false);
      }
      fs.rmSync(path.join(dir, '.claude'), { recursive: true, force: true });
      fs.symlinkSync(outside, path.join(dir, '.claude'), process.platform === 'win32' ? 'junction' : 'dir');
      try {
        assert.throws(() => writeCodeReviewPermissions(dir), /outside the clone/);
        assert.strictEqual(fs.existsSync(path.join(outside, 'settings.local.json')), false);
      } finally {
        fs.unlinkSync(path.join(dir, '.claude'));
      }
    });
  });
});

test('project gate announces each command and reports its duration', () => {
  withTempDir((dir) => {
    initRepo(dir);
    const lines = [];
    const result = runProjectGate(
      dir,
      ['apps/api'],
      (cwd, script) => {
        if (script.includes('jest')) throw Object.assign(new Error('tests failed'), { stdout: 'FAIL' });
        return 'ok';
      },
      (line) => lines.push(line),
    );
    assert.strictEqual(result.ok, false);
    assert.match(lines[0], /⏳ apps\/api: node node_modules\/typescript\/bin\/tsc --noEmit\.\.\./);
    assert.match(lines[1], /✅ apps\/api: node node_modules\/typescript\/bin\/tsc --noEmit — \d+s$/);
    assert.match(lines[lines.length - 1], /❌ apps\/api: node node_modules\/jest\/bin\/jest\.js — \d+s$/);
    assert.strictEqual(lines.length, 6);
  });
});

test('allow list covers every skill required by the skill gate', () => {
  const { APPS, requiredSkillsFor } = require('../../scripts/required-skills');
  withTempDir((dir) => {
    writeAgentPermissions(dir);
    const { allow } = readSettings(dir);
    for (const app of APPS) {
      for (const skill of requiredSkillsFor(`## Affects\n- \`${app.dir}/file.js\`\n`)) {
        assert.ok(allow.includes(`Skill(${skill})`), `${app.dir}: ${skill}`);
      }
    }
    assert.ok(!allow.includes('Skill(code-review)'));
  });
});
