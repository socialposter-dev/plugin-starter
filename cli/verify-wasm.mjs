#!/usr/bin/env node
/**
 * Verifies that a compiled WebAssembly module exports all four required
 * SocialPoster ABI functions (`describe`, `validate_auth`, `publish`, `delete_post`)
 * and reports its file size and SHA-256 checksum.
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

/**
 * Inspects a compiled `.wasm` file and returns its size, SHA-256 hash,
 * exported function names, and any missing required ABI exports.
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

  return {
    path: absPath,
    size,
    sha256,
    exportedFunctions,
    missing,
    ok: missing.length === 0,
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
  console.log(`Size     : ${result.size.toLocaleString('en-GB')} bytes`);
  console.log(`SHA-256  : ${result.sha256}`);
  console.log(`Exports  : ${result.exportedFunctions.join(', ')}`);

  if (!result.ok) {
    console.error(
      `Verification failed: missing required ABI export(s): ${result.missing.join(', ')}`
    );
    process.exit(1);
  }

  console.log('Verification passed: all required SocialPoster ABI exports are present.');
}
