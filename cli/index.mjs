#!/usr/bin/env node
/**
 * Interactive SocialPoster WebAssembly Plugin Builder.
 *
 * Guides contributors through selecting a language implementation, reviewing
 * the extracted `describe()` metadata, compiling to `.wasm` (with automatic
 * Docker fallback when local toolchains are absent), and verifying all four
 * required ABI exports.
 */

import * as p from '@clack/prompts';
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDescribeMetadata } from './parse-describe.mjs';
import { verifyWasmModule } from './verify-wasm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..').replace(/[\\/]+$/, '');
const OUTPUT_DIR = join(ROOT_DIR, 'output');

const LANGUAGES = {
  rust: {
    label: 'Rust',
    hint: 'rust/src/lib.rs (extism-pdk)',
    sourceFile: join(ROOT_DIR, 'rust', 'src', 'lib.rs'),
    localTool: 'cargo',
  },
  go: {
    label: 'Go',
    hint: 'go/main.go (TinyGo + go-pdk)',
    sourceFile: join(ROOT_DIR, 'go', 'main.go'),
    localTool: 'tinygo',
  },
  assemblyscript: {
    label: 'AssemblyScript',
    hint: 'assemblyscript/assembly/index.ts (@extism/as-pdk)',
    sourceFile: join(ROOT_DIR, 'assemblyscript', 'assembly', 'index.ts'),
    localTool: 'node',
  },
  zig: {
    label: 'Zig',
    hint: 'zig/src/main.zig (extism/zig-pdk)',
    sourceFile: join(ROOT_DIR, 'zig', 'src', 'main.zig'),
    localTool: 'zig',
  },
  c: {
    label: 'C',
    hint: 'c/plugin.c (clang + extism-pdk.h)',
    sourceFile: join(ROOT_DIR, 'c', 'plugin.c'),
    localTool: 'clang',
  },
};

const STAGES = [
  { minPct: 10, maxPct: 24, label: 'Checking local toolchain / starting container' },
  { minPct: 25, maxPct: 44, label: 'Pulling Docker image layers' },
  { minPct: 45, maxPct: 69, label: 'Installing toolchain & packages' },
  { minPct: 70, maxPct: 89, label: 'Compiling WebAssembly module' },
  { minPct: 90, maxPct: 99, label: 'Verifying ABI exports' },
  { minPct: 100, maxPct: 100, label: 'Build complete' },
];

function commandExists(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, [cmd], { stdio: 'ignore', shell: false });
  return res.status === 0;
}

function sanitiseText(str) {
  return str
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderProgressBar(percent, width = 20) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${clamped}%`;
}

function truncateToWidth(text, maxWidth) {
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return text.slice(0, Math.max(0, maxWidth));
  return `${text.slice(0, maxWidth - 3)}...`;
}

/**
 * Tracks build milestones, elapsed time, and rolling single-line log previews.
 * Decouples stream `data` events from terminal writes so `@clack/prompts`
 * updates cleanly in-place on a single line at most every 250ms.
 */
class BuildProgressTracker {
  constructor(spinner) {
    this.spinner = spinner;
    this.isTTY = Boolean(process.stdout.isTTY);
    this.startTime = Date.now();
    this.stageIndex = 0;
    this.percent = STAGES[0].minPct;
    this.lastLine = '';
    this.lastAdvanceAt = Date.now();
    this.lastRenderedText = '';
    this.loggedStages = new Set();
    this.timer = null;
  }

  start() {
    if (!this.isTTY) {
      this.logStageOnce(this.stageIndex);
      return;
    }
    this.render();
    this.timer = setInterval(() => {
      const now = Date.now();
      const stage = STAGES[this.stageIndex];
      if (this.percent < stage.maxPct && now - this.lastAdvanceAt >= 1500) {
        this.percent += 1;
        this.lastAdvanceAt = now;
      }
      this.render();
    }, 250);
  }

  logStageOnce(index) {
    if (this.isTTY || this.loggedStages.has(index)) return;
    this.loggedStages.add(index);
    const stage = STAGES[index];
    p.log.step(`[${stage.minPct}%] ${stage.label}`);
  }

  setStage(index, customLine) {
    if (index > this.stageIndex && index < STAGES.length) {
      this.stageIndex = index;
      this.percent = Math.max(this.percent, STAGES[index].minPct);
      this.lastAdvanceAt = Date.now();
      this.logStageOnce(index);
    }
    if (customLine) {
      this.lastLine = sanitiseText(customLine);
    }
  }

  ingestLine(rawLine) {
    const clean = sanitiseText(rawLine);
    if (!clean) return;
    this.lastLine = clean;

    const detected = this.detectStage(clean);
    if (detected > this.stageIndex) {
      this.stageIndex = detected;
      this.percent = Math.max(this.percent, STAGES[detected].minPct);
      this.lastAdvanceAt = Date.now();
      this.logStageOnce(detected);
    }
  }

  detectStage(line) {
    // Check in descending priority so compilation milestones take precedence
    if (/\b(Compiling|asc|zig build|tinygo|clang)\b/i.test(line)) {
      return 3;
    }
    if (
      /\b(apt-get|added|go: downloading|Fetching)\b/i.test(line) ||
      (/Downloading/i.test(line) && !/Pulling/i.test(line) && this.stageIndex >= 2)
    ) {
      return 2;
    }
    if (/(Pulling from|Pulling fs layer|Downloading|Extracting)/i.test(line)) {
      return 1;
    }
    return this.stageIndex;
  }

  render() {
    if (!this.isTTY) return;
    const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
    const stage = STAGES[this.stageIndex];
    const bar = renderProgressBar(this.percent, 20);
    const maxCols = Math.max(40, (process.stdout.columns || 80) - 8);

    const base = `${bar} • ${stage.label} (${elapsedSec}s)`;
    let nextText = base;
    if (this.lastLine && base.length + 4 < maxCols) {
      nextText = `${base} — ${this.lastLine}`;
    }
    nextText = truncateToWidth(nextText, maxCols);

    if (nextText !== this.lastRenderedText) {
      this.lastRenderedText = nextText;
      this.spinner.message(nextText);
    }
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function formatCommandFailure(cmd, args, code, signal, stdout, stderr, procErr) {
  const exitLabel = code !== null && code !== undefined ? code : signal || 'unknown';
  const sections = [`Command failed (exit code ${exitLabel}): ${cmd} ${args.join(' ')}`];
  if (procErr) {
    sections.push(`Process error: ${procErr.message}`);
  }
  if (stdout && stdout.trim()) {
    sections.push(`--- stdout ---\n${stdout.trim()}`);
  }
  if (stderr && stderr.trim()) {
    sections.push(`--- stderr ---\n${stderr.trim()}`);
  }
  return sections.join('\n\n');
}

function runCommandAsync(cmd, args, cwd = ROOT_DIR, tracker = null, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });

    const stdoutChunks = [];
    const stderrChunks = [];
    let partial = '';

    const handleChunk = (chunk, targetChunks) => {
      const text = chunk.toString('utf-8');
      targetChunks.push(text);
      if (!tracker) return;

      partial += text;
      const lines = partial.split(/\r?\n|\r/);
      partial = lines.pop() ?? '';
      for (const line of lines) {
        tracker.ingestLine(line);
      }
    };

    child.stdout.on('data', (chunk) => handleChunk(chunk, stdoutChunks));
    child.stderr.on('data', (chunk) => handleChunk(chunk, stderrChunks));

    child.on('error', (err) => {
      rejectPromise(
        new Error(
          formatCommandFailure(
            cmd,
            args,
            null,
            null,
            stdoutChunks.join(''),
            stderrChunks.join(''),
            err
          )
        )
      );
    });

    child.on('close', (code, signal) => {
      if (tracker && partial.trim()) {
        tracker.ingestLine(partial);
      }
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      if (code !== 0) {
        rejectPromise(
          new Error(formatCommandFailure(cmd, args, code, signal, stdout, stderr, null))
        );
        return;
      }
      resolvePromise({ stdout, stderr });
    });
  });
}

function runNpmAsync(args, cwd, tracker) {
  if (process.platform === 'win32') {
    return runCommandAsync('cmd.exe', ['/c', 'npm', ...args], cwd, tracker);
  }
  return runCommandAsync('npm', args, cwd, tracker);
}

/**
 * Runs a build inside an official Docker container.
 * Uses `shell: false` with unquoted array elements so Windows paths containing
 * spaces or backslashes are passed verbatim to `docker.exe` via CreateProcess.
 */
function runDockerAsync(langDirName, image, containerCmdArgs, tracker) {
  const resolvedRepoRoot = resolve(ROOT_DIR).replace(/[\\/]+$/, '');
  const dockerArgs = [
    'run',
    '--rm',
    '-v',
    `${resolvedRepoRoot}:/work`,
    '-w',
    `/work/${langDirName}`,
    image,
    ...containerCmdArgs,
  ];
  return runCommandAsync('docker', dockerArgs, ROOT_DIR, tracker);
}

function formatSummaryBox(meta, langLabel) {
  const credLines =
    meta.credential_fields.length > 0
      ? meta.credential_fields
          .map(
            (f) =>
              `  - ${f.key} ("${f.label}") [${f.required ? 'required' : 'optional'}, ${
                f.secret ? 'secret' : 'plain text'
              }]`
          )
          .join('\n')
      : '  (none)';

  return [
    `Language           : ${langLabel}`,
    `Plugin ID          : ${meta.id}`,
    `Display Name       : ${meta.display_name}`,
    `Version            : ${meta.version}`,
    `Brand Colour       : ${meta.brand_colour}`,
    `Max Characters     : ${meta.max_characters ?? 'N/A'}`,
    `Max Attachments    : ${meta.max_attachments ?? 'N/A'}`,
    `Supports Threads   : ${meta.supports_threads}`,
    `Supports Alt-Text  : ${meta.supports_alt_text}`,
    `Supports Delete    : ${meta.supports_delete}`,
    `Allowed Domains    : ${meta.allowed_domains.join(', ') || '(none)'}`,
    `Credential Fields  :\n${credLines}`,
  ].join('\n');
}

async function buildRust(outFile, tracker) {
  const rustDir = join(ROOT_DIR, 'rust');
  const builtWasm = join(
    rustDir,
    'target',
    'wasm32-unknown-unknown',
    'release',
    'socialposter_example_plugin.wasm'
  );

  if (commandExists('cargo')) {
    if (commandExists('rustup')) {
      tracker.setStage(2, 'Ensuring wasm32-unknown-unknown target is installed...');
      await runCommandAsync(
        'rustup',
        ['target', 'add', 'wasm32-unknown-unknown'],
        rustDir,
        tracker
      );
    }
    tracker.setStage(3, 'Running cargo build --release --target wasm32-unknown-unknown...');
    await runCommandAsync(
      'cargo',
      ['build', '--release', '--target', 'wasm32-unknown-unknown'],
      rustDir,
      tracker
    );
    copyFileSync(builtWasm, outFile);
    return 'local (cargo)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local cargo toolchain not found and Docker is unavailable.');
  }

  await runDockerAsync(
    'rust',
    'rust:1-bookworm',
    [
      'sh',
      '-c',
      'rustup target add wasm32-unknown-unknown && cargo build --release --target wasm32-unknown-unknown',
    ],
    tracker
  );
  copyFileSync(builtWasm, outFile);
  return 'Docker (rust:1-bookworm)';
}

async function buildGo(outFile, outName, tracker) {
  const goDir = join(ROOT_DIR, 'go');

  if (commandExists('go') && commandExists('tinygo')) {
    tracker.setStage(2, 'Running go mod tidy...');
    await runCommandAsync('go', ['mod', 'tidy'], goDir, tracker);
    tracker.setStage(3, 'Running tinygo build...');
    // Disable VCS stamping so Git ownership differences never break builds
    await runCommandAsync(
      'tinygo',
      ['build', '-o', outFile, '-target', 'wasip1', '-buildmode=c-shared', '.'],
      goDir,
      tracker,
      { GOFLAGS: '-buildvcs=false' }
    );
    return 'local (tinygo)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local Go/TinyGo toolchain not found and Docker is unavailable.');
  }

  await runDockerAsync(
    'go',
    'tinygo/tinygo:0.34.0',
    [
      'sh',
      '-c',
      `go mod tidy && GOFLAGS="-buildvcs=false" tinygo build -o /work/output/${outName} -target wasip1 -buildmode=c-shared .`,
    ],
    tracker
  );
  return 'Docker (tinygo/tinygo:0.34.0)';
}

async function buildAssemblyScript(outFile, _outName, tracker) {
  const asDir = join(ROOT_DIR, 'assemblyscript');
  const defaultOut = join(OUTPUT_DIR, 'example-social-assemblyscript.wasm');

  if (commandExists('node') && commandExists('npm')) {
    if (!existsSync(join(asDir, 'node_modules'))) {
      tracker.setStage(2, 'Installing npm dependencies...');
      await runNpmAsync(['ci'], asDir, tracker);
    }
    tracker.setStage(3, 'Running npm run build (asc)...');
    await runNpmAsync(['run', 'build'], asDir, tracker);
    if (outFile !== defaultOut && existsSync(defaultOut)) {
      copyFileSync(defaultOut, outFile);
    }
    return 'local (asc)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local Node.js/npm toolchain not found and Docker is unavailable.');
  }

  await runDockerAsync(
    'assemblyscript',
    'node:22-bookworm',
    ['sh', '-c', 'npm ci && npm run build'],
    tracker
  );
  if (outFile !== defaultOut && existsSync(defaultOut)) {
    copyFileSync(defaultOut, outFile);
  }
  return 'Docker (node:22-bookworm + asc)';
}

async function buildZig(outFile, _outName, tracker) {
  const zigDir = join(ROOT_DIR, 'zig');
  const defaultOut = join(OUTPUT_DIR, 'example-social-zig.wasm');
  const pdkUrl = 'https://github.com/extism/zig-pdk/archive/refs/tags/v1.2.1.tar.gz';

  if (commandExists('zig')) {
    tracker.setStage(2, 'Fetching extism/zig-pdk...');
    await runCommandAsync('zig', ['fetch', '--save=extism_pdk', pdkUrl], zigDir, tracker);
    tracker.setStage(3, 'Running zig build -Doptimize=ReleaseSmall...');
    await runCommandAsync('zig', ['build', '-Doptimize=ReleaseSmall'], zigDir, tracker);
    if (outFile !== defaultOut && existsSync(defaultOut)) {
      copyFileSync(defaultOut, outFile);
    }
    return 'local (zig)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local Zig compiler not found and Docker is unavailable.');
  }

  await runDockerAsync(
    'zig',
    'ubuntu:24.04',
    [
      'sh',
      '-c',
      [
        'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl xz-utils ca-certificates >/dev/null',
        'curl -fsSL https://ziglang.org/download/0.13.0/zig-linux-x86_64-0.13.0.tar.xz -o /tmp/zig.tar.xz',
        'tar -xf /tmp/zig.tar.xz -C /opt && ln -sf /opt/zig-linux-x86_64-0.13.0/zig /usr/local/bin/zig',
        `zig fetch --save=extism_pdk ${pdkUrl}`,
        'zig build -Doptimize=ReleaseSmall',
      ].join(' && '),
    ],
    tracker
  );
  if (outFile !== defaultOut && existsSync(defaultOut)) {
    copyFileSync(defaultOut, outFile);
  }
  return 'Docker (ubuntu:24.04 + zig 0.13.0)';
}

async function buildC(outFile, outName, tracker) {
  const cDir = join(ROOT_DIR, 'c');

  if (commandExists('clang')) {
    try {
      tracker.setStage(3, 'Compiling with local clang...');
      await runCommandAsync(
        'clang',
        ['-O2', '-Wall', '-Wextra', '-mexec-model=reactor', '--target=wasm32-wasi', '-o', outFile, 'plugin.c'],
        cDir,
        tracker
      );
      return 'local (clang)';
    } catch {
      // Fall through to Docker container if host clang lacks WASI sysroot.
    }
  }

  if (!commandExists('docker')) {
    throw new Error('Local WASI-capable clang not found and Docker is unavailable.');
  }

  await runDockerAsync(
    'c',
    'ubuntu:24.04',
    [
      'sh',
      '-c',
      [
        'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates make >/dev/null',
        'curl -fsSL https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-25/wasi-sdk-25.0-x86_64-linux.tar.gz -o /tmp/wasi-sdk.tar.gz',
        'tar -xzf /tmp/wasi-sdk.tar.gz -C /tmp',
        `make CC=/tmp/wasi-sdk-25.0-x86_64-linux/bin/clang OUT=/work/output/${outName}`,
      ].join(' && '),
    ],
    tracker
  );
  return 'Docker (ubuntu:24.04 + wasi-sdk-25)';
}

async function main() {
  p.intro('SocialPoster WebAssembly Plugin Builder');

  const selectedLang = await p.select({
    message: 'Select the plugin language you would like to build:',
    options: Object.entries(LANGUAGES).map(([value, cfg]) => ({
      value,
      label: cfg.label,
      hint: cfg.hint,
    })),
  });

  if (p.isCancel(selectedLang)) {
    p.cancel('Build cancelled.');
    process.exit(0);
  }

  const langCfg = LANGUAGES[selectedLang];
  const meta = parseDescribeMetadata(langCfg.sourceFile, selectedLang);

  p.note(formatSummaryBox(meta, langCfg.label), 'Extracted describe() Configuration');

  const confirmed = await p.confirm({
    message: 'Is this plugin configuration correct?',
    active: 'Yes',
    inactive: 'No',
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.log.info(
      `You can edit your describe() configuration in:\n  ${langCfg.sourceFile}`
    );
    p.outro('Build aborted without compiling.');
    process.exit(0);
  }

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const outName = meta.id.endsWith(`-${selectedLang}`)
    ? `${meta.id}.wasm`
    : `${meta.id}-${selectedLang}.wasm`;
  const outFile = join(OUTPUT_DIR, outName);

  const isTTY = Boolean(process.stdout.isTTY);
  const spin = p.spinner();
  if (isTTY) {
    spin.start(`Initialising ${langCfg.label} build...`);
  }
  const tracker = new BuildProgressTracker(spin);
  tracker.start();

  let toolchainUsed = '';
  let verification;
  try {
    if (selectedLang === 'rust') {
      toolchainUsed = await buildRust(outFile, tracker);
    } else if (selectedLang === 'go') {
      toolchainUsed = await buildGo(outFile, outName, tracker);
    } else if (selectedLang === 'assemblyscript') {
      toolchainUsed = await buildAssemblyScript(outFile, outName, tracker);
    } else if (selectedLang === 'zig') {
      toolchainUsed = await buildZig(outFile, outName, tracker);
    } else if (selectedLang === 'c') {
      toolchainUsed = await buildC(outFile, outName, tracker);
    }

    tracker.setStage(4, `Inspecting output/${outName}...`);
    verification = verifyWasmModule(outFile);
    tracker.setStage(5, `Ready via ${toolchainUsed}`);
    tracker.stop();
    if (isTTY) {
      spin.stop(`Compiled successfully via ${toolchainUsed}.`);
    } else {
      p.log.success(`Compiled successfully via ${toolchainUsed}.`);
    }
  } catch (err) {
    tracker.stop();
    if (isTTY) {
      spin.stop('Compilation failed.');
    } else {
      p.log.error('Compilation failed.');
    }
    const details = err instanceof Error ? err.message : String(err);
    console.error(`\n${details}\n`);
    process.exit(1);
  }

  p.note(
    [
      `Artefact : output/${outName}`,
      `Size     : ${verification.sizeKb} KB (${verification.size.toLocaleString('en-GB')} bytes)`,
      `SHA-256  : ${verification.sha256}`,
      `Exports  : ${verification.exportedFunctions.join(', ')}`,
    ].join('\n'),
    'WebAssembly Artefact & ABI Verification'
  );

  if (verification.missing.length > 0) {
    p.log.error(
      `Verification failed: missing required ABI export(s): ${verification.missing.join(', ')}`
    );
    process.exit(1);
  }

  if (!verification.withinSizeLimit) {
    p.log.error(
      `Verification failed: artefact size (${verification.sizeKb} KB) exceeds the 1 MB (1,024 KB) Hub limit.`
    );
    process.exit(1);
  }

  p.outro(`All four ABI exports verified (${verification.sizeKb} KB). Ready to publish!`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
