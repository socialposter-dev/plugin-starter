#!/usr/bin/env node
/**
 * Verifies that a compiled WebAssembly module exports all four required
 * SocialPoster ABI functions (`describe`, `validate_auth`, `publish`, `delete_post`),
 * does not exceed the Hub's 1 MB (1,048,576 bytes) size limit, and reports its
 * file size and SHA-256 checksum.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_EXPORTS = [
  'describe',
  'validate_auth',
  'publish',
  'delete_post',
];

export const MAX_WASM_BYTES = 1_048_576; // 1 MB (1,024 KB)

/**
 * Inspects a compiled `.wasm` file and returns its size, SHA-256 hash,
 * exported function names, size-limit status, and any missing ABI exports.
 */
export function verifyWasmModule(wasmPath) {
  const absPath = resolve(wasmPath);
  const bytes = readFileSync(absPath);
  const { size } = statSync(absPath);
  const sha256 = createHash('sha256').update(bytes).digest('hex');

  const module = new WebAssembly.Module(bytes);
  const exportsList = WebAssembly.Module.exports(module);
  const exportedFunctions = exportsList
    .filter((entry) => entry.kind === 'function')
    .map((entry) => entry.name);

  const missing = REQUIRED_EXPORTS.filter(
    (name) => !exportedFunctions.includes(name)
  );
  const withinSizeLimit = size <= MAX_WASM_BYTES;

  return {
    path: absPath,
    size,
    sizeKb: (size / 1024).toFixed(2),
    sha256,
    exportedFunctions,
    missing,
    withinSizeLimit,
    ok: missing.length === 0 && withinSizeLimit,
  };
}

// Allow direct CLI execution in CI: `node cli/verify-wasm.mjs output/foo.wasm`
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const target = process.argv[2];
  if (!target) {
    console.error('Usage: node cli/verify-wasm.mjs <path-to-plugin.wasm>');
    process.exit(1);
  }

  const result = verifyWasmModule(target);
  console.log(`Artefact : ${result.path}`);
  console.log(`Size     : ${result.sizeKb} KB (${result.size.toLocaleString('en-GB')} bytes)`);
  console.log(`SHA-256  : ${result.sha256}`);
  console.log(`Exports  : ${result.exportedFunctions.join(', ')}`);

  if (result.missing.length > 0) {
    console.error(
      `Verification failed: missing required ABI export(s): ${result.missing.join(', ')}`
    );
    process.exit(1);
  }

  if (!result.withinSizeLimit) {
    console.error(
      `Verification failed: artefact size (${result.size.toLocaleString('en-GB')} bytes) exceeds the 1 MB (${MAX_WASM_BYTES.toLocaleString('en-GB')} bytes) Hub limit.`
    );
    process.exit(1);
  }

  console.log('Verification passed: all required SocialPoster ABI exports are present and size is within 1 MB.');
}
