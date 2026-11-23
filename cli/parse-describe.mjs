/**
 * Extracts `describe()` metadata from any of the five supported SocialPoster
 * plugin languages (Rust, Go, AssemblyScript, Zig, or C) without needing to
 * compile the plugin first.
 */

import { readFileSync } from 'node:fs';

function matchStringField(block, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pascal = field
    .split('_')
    .map((part) => (part === 'id' ? 'ID' : part === 'svg' ? 'SVG' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');

  const re = new RegExp(
    `(?:\\\\?"?\\.?${escaped}|${pascal})\\\\?"?\\s*(?::|=)\\s*\\\\?"([^"\\\\]+)\\\\?"`,
    'm'
  );
  const m = block.match(re);
  return m ? m[1] : null;
}

function matchIntField(block, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pascal = field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  const re = new RegExp(
    `(?:\\\\?"?\\.?${escaped}|${pascal})\\\\?"?\\s*(?::|=)\\s*(\\d+)`,
    'm'
  );
  const m = block.match(re);
  return m ? Number.parseInt(m[1], 10) : null;
}

function matchBoolField(block, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pascal = field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  const re = new RegExp(
    `(?:\\\\?"?\\.?${escaped}|${pascal})\\\\?"?\\s*(?::|=)\\s*(true|false|True|False)`,
    'm'
  );
  const m = block.match(re);
  return m ? m[1].toLowerCase() === 'true' : null;
}

function matchStringArray(block, field) {
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pascal = field
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  // Matches Rust vec![...], Go []string{...}, Zig &.{...}, AS/C [...]
  const re = new RegExp(
    `(?:\\\\?"?\\.?${escaped}|${pascal})\\\\?"?\\s*(?::|=)\\s*(?:vec!\\[|\\[\\]string\\{|&\\.\\{|\\[)([\\s\\S]*?)(?:\\]|\\})`,
    'm'
  );
  const m = block.match(re);
  if (!m) return [];

  const items = [];
  const itemRe = /\\?"([^"\\]+)\\?"/g;
  let im;
  while ((im = itemRe.exec(m[1])) !== null) {
    items.push(im[1]);
  }
  return items;
}

function matchAuthModes(block) {
  const startMatch = block.match(/(?:auth_modes|AuthModes)/);
  if (!startMatch) return [];

  const slice = block.slice(startMatch.index);
  const modes = [];
  const modeRe =
    /(?:id|ID|\.?id)\\?"?\s*(?::|=)\s*\\?"([^"\\]+)\\?"[\s\S]*?(?:label|Label|\.?label)\\?"?\s*(?::|=)\s*\\?"([^"\\]+)\\?"/g;

  let m;
  while ((m = modeRe.exec(slice)) !== null) {
    modes.push({ id: m[1], label: m[2] });
  }
  return modes;
}

function extractDescribeBlock(source, language) {
  let startIdx = -1;
  if (language === 'rust') {
    startIdx = source.indexOf('pub fn describe');
  } else if (language === 'go') {
    startIdx = source.indexOf('func describe');
  } else if (language === 'assemblyscript') {
    startIdx = source.indexOf('export function describe');
  } else if (language === 'zig') {
    startIdx = source.indexOf('export fn describe');
  } else if (language === 'c') {
    startIdx = source.indexOf('EXTISM_EXPORTED_FUNCTION(describe)');
  }

  if (startIdx === -1) {
    return source;
  }

  return source.slice(startIdx, startIdx + 6500);
}

/**
 * Parses `describe()` metadata from a plugin source file.
 */
export function parseDescribeMetadata(filePath, language) {
  const source = readFileSync(filePath, 'utf8');
  const block = extractDescribeBlock(source, language);

  return {
    id: matchStringField(block, 'id') ?? 'unknown-plugin',
    display_name: matchStringField(block, 'display_name') ?? 'Unknown Plugin',
    version: matchStringField(block, 'version') ?? '0.0.0',
    compatible_app_version: matchStringField(block, 'compatible_app_version') ?? '^1.0.0',
    brand_colour: matchStringField(block, 'brand_colour') ?? '#000000',
    max_characters: matchIntField(block, 'max_characters'),
    max_attachments: matchIntField(block, 'max_attachments'),
    supports_threads: matchBoolField(block, 'supports_threads'),
    supports_alt_text: matchBoolField(block, 'supports_alt_text'),
    supports_delete: matchBoolField(block, 'supports_delete'),
    allowed_domains: matchStringArray(block, 'allowed_domains'),
    auth_modes: matchAuthModes(block),
  };
}
