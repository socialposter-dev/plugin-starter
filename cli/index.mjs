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
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDescribeMetadata } from './parse-describe.mjs';
import { verifyWasmModule } from './verify-wasm.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..');
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
  typescript: {
    label: 'TypeScript',
    hint: 'typescript/src/index.ts (extism-js)',
    sourceFile: join(ROOT_DIR, 'typescript', 'src', 'index.ts'),
    localTool: 'extism-js',
  },
  python: {
    label: 'Python',
    hint: 'python/plugin.py (extism-py)',
    sourceFile: join(ROOT_DIR, 'python', 'plugin.py'),
    localTool: 'extism-py',
  },
  c: {
    label: 'C',
    hint: 'c/plugin.c (clang + extism-pdk.h)',
    sourceFile: join(ROOT_DIR, 'c', 'plugin.c'),
    localTool: 'clang',
  },
};

function commandExists(cmd) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const res = spawnSync(probe, [cmd], { stdio: 'ignore' });
  return res.status === 0;
}

function runCommand(cmd, args, cwd = ROOT_DIR) {
  const res = spawnSync(cmd, args, {
    cwd,
    stdio: 'pipe',
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    const details = [res.stdout, res.stderr].filter(Boolean).join('\n').trim();
    throw new Error(details || `Command failed with exit code ${res.status}: ${cmd} ${args.join(' ')}`);
  }
  return res;
}

function hasRustWasiTarget() {
  if (!commandExists('rustup')) return false;
  const res = spawnSync('rustup', ['target', 'list', '--installed'], {
    encoding: 'utf8',
  });
  return res.status === 0 && res.stdout.includes('wasm32-wasip1');
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

function buildRust(outFile) {
  const rustDir = join(ROOT_DIR, 'rust');
  const builtWasm = join(
    rustDir,
    'target',
    'wasm32-wasip1',
    'release',
    'socialposter_example_plugin.wasm'
  );

  if (commandExists('cargo') && hasRustWasiTarget()) {
    runCommand('cargo', ['build', '--release', '--target', 'wasm32-wasip1'], rustDir);
    copyFileSync(builtWasm, outFile);
    return 'local (cargo)';
  }

  if (!commandExists('docker')) {
    throw new Error(
      'Local Rust wasm32-wasip1 toolchain not found and Docker is unavailable.'
    );
  }

  runCommand('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT_DIR}:/workspace`,
    '-w',
    '/workspace/rust',
    'rust:1-bookworm',
    'sh',
    '-c',
    'rustup target add wasm32-wasip1 && cargo build --release --target wasm32-wasip1',
  ]);
  copyFileSync(builtWasm, outFile);
  return 'Docker (rust:1-bookworm)';
}

function buildGo(outFile, outName) {
  const goDir = join(ROOT_DIR, 'go');

  if (commandExists('go') && commandExists('tinygo')) {
    runCommand(
      'tinygo',
      ['build', '-o', outFile, '-target', 'wasip1', '-buildmode=c-shared', '.'],
      goDir
    );
    return 'local (tinygo)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local Go/TinyGo toolchain not found and Docker is unavailable.');
  }

  // Use golang:1.24-bookworm with TinyGo installed or official tinygo image
  runCommand('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT_DIR}:/workspace`,
    '-w',
    '/workspace/go',
    'golang:1.24-bookworm',
    'sh',
    '-c',
    `ARCH=$(dpkg --print-architecture) && curl -fsSL https://github.com/tinygo-org/tinygo/releases/download/v0.35.0/tinygo_0.35.0_\${ARCH}.deb -o /tmp/tinygo.deb && dpkg -i /tmp/tinygo.deb && tinygo build -o /workspace/output/${outName} -target wasip1 -buildmode=c-shared .`,
  ]);
  return 'Docker (golang:1.24-bookworm + tinygo)';
}

function buildTypeScript(outFile, outName) {
  const tsDir = join(ROOT_DIR, 'typescript');

  if (commandExists('extism-js')) {
    if (!existsSync(join(tsDir, 'node_modules'))) {
      runCommand('npm', ['install'], tsDir);
    }
    runCommand('npm', ['run', 'typecheck'], tsDir);
    runCommand('npm', ['run', 'bundle'], tsDir);
    runCommand(
      'extism-js',
      ['dist/plugin.js', '-i', 'src/plugin.d.ts', '-o', outFile],
      tsDir
    );
    return 'local (extism-js)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local extism-js compiler not found and Docker is unavailable.');
  }

  runCommand('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT_DIR}:/workspace`,
    '-w',
    '/workspace/typescript',
    'node:22-bookworm',
    'sh',
    '-c',
    `npm ci && npm run typecheck && npm run bundle && curl -fsSL https://get.extism.org/js -o /tmp/install-extism-js.sh && sh /tmp/install-extism-js.sh && extism-js dist/plugin.js -i src/plugin.d.ts -o /workspace/output/${outName}`,
  ]);
  return 'Docker (node:22-bookworm + extism-js)';
}

function buildPython(outFile, outName) {
  const pyDir = join(ROOT_DIR, 'python');

  if (commandExists('extism-py')) {
    runCommand('extism-py', ['plugin.py', '-o', outFile], pyDir);
    return 'local (extism-py)';
  }

  if (!commandExists('docker')) {
    throw new Error('Local extism-py compiler not found and Docker is unavailable.');
  }

  runCommand('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT_DIR}:/workspace`,
    '-w',
    '/workspace/python',
    'python:3.12-bookworm',
    'sh',
    '-c',
    `apt-get update -qq && apt-get install -y -qq binaryen curl >/dev/null && pip install --no-cache-dir -q extism-py && extism-py plugin.py -o /workspace/output/${outName}`,
  ]);
  return 'Docker (python:3.12-bookworm + extism-py)';
}

function buildC(outFile, outName) {
  const cDir = join(ROOT_DIR, 'c');

  if (commandExists('clang')) {
    try {
      runCommand(
        'clang',
        ['-O2', '-Wall', '-Wextra', '-mexec-model=reactor', '--target=wasm32-wasi', '-o', outFile, 'plugin.c'],
        cDir
      );
      return 'local (clang)';
    } catch {
      // Fall through to Docker WASI SDK if host clang lacks WASI sysroot.
    }
  }

  if (!commandExists('docker')) {
    throw new Error('Local WASI-capable clang not found and Docker is unavailable.');
  }

  runCommand('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT_DIR}:/workspace`,
    '-w',
    '/workspace/c',
    'ghcr.io/webassembly/wasi-sdk:latest',
    'make',
    `OUT=/workspace/output/${outName}`,
  ]);
  return 'Docker (wasi-sdk)';
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
  const outName = `${meta.id}-${selectedLang}.wasm`;
  const outFile = join(OUTPUT_DIR, outName);

  const spin = p.spinner();
  spin.start(`Compiling ${langCfg.label} plugin to output/${outName}...`);

  let toolchainUsed = '';
  try {
    if (selectedLang === 'rust') {
      toolchainUsed = buildRust(outFile);
    } else if (selectedLang === 'go') {
      toolchainUsed = buildGo(outFile, outName);
    } else if (selectedLang === 'typescript') {
      toolchainUsed = buildTypeScript(outFile, outName);
    } else if (selectedLang === 'python') {
      toolchainUsed = buildPython(outFile, outName);
    } else if (selectedLang === 'c') {
      toolchainUsed = buildC(outFile, outName);
    }
    spin.stop(`Compiled successfully via ${toolchainUsed}.`);
  } catch (err) {
    spin.stop('Compilation failed.');
    p.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const verification = verifyWasmModule(outFile);
  p.note(
    [
      `Artefact : output/${outName}`,
      `Size     : ${verification.size.toLocaleString('en-GB')} bytes`,
      `SHA-256  : ${verification.sha256}`,
      `Exports  : ${verification.exportedFunctions.join(', ')}`,
    ].join('\n'),
    'WebAssembly Artefact & ABI Verification'
  );

  if (!verification.ok) {
    p.log.error(
      `Verification failed: missing required ABI export(s): ${verification.missing.join(', ')}`
    );
    process.exit(1);
  }

  p.outro('All four required SocialPoster ABI exports verified. Ready to publish!');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
