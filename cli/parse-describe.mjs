/**
 * Extracts `describe()` metadata from any of the five supported SocialPoster
 * plugin languages (Rust, Go, TypeScript, Python, or C) without needing to
 * compile the plugin first.
 */

import { readFileSync } from 'node:fs';

function matchStringField(block, field) {
  // Matches `"field": "val"`, `field: "val"`, `Field: "val"`, `\"field\":\"val\"`
  const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pascal = field
    .split('_')
    .map((part) => (part === 'id' ? 'ID' : part === 'svg' ? 'SVG' : part.charAt(0).toUpperCase() + part.slice(1)))
    .join('');

  const re = new RegExp(
    `(?:\\\\?"?(?:${escaped}|${pascal})\\\\?"?\\s*:\\s*\\\\?"([^"\\\\]+)\\\\?")`,
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

  const re = new RegExp(`(?:\\\\?"?(?:${escaped}|${pascal})\\\\?"?\\s*:\\s*(\\d+))`, 'm');
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
    `(?:\\\\?"?(?:${escaped}|${pascal})\\\\?"?\\s*:\\s*(true|false|True|False))`,
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

  // Matches Rust vec![...], Go []string{...}, TS/Python/C [...]
  const re = new RegExp(
    `(?:\\\\?"?(?:${escaped}|${pascal})\\\\?"?\\s*:\\s*(?:vec!\\[|\\[\\]string\\{|\\[)([\\s\\S]*?)(?:\\]|\\}))`,
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

function matchCredentialFields(block) {
  const startMatch = block.match(/(?:credential_fields|CredentialFields)/);
  if (!startMatch) return [];

  const slice = block.slice(startMatch.index);
  // Extract individual field structs/objects by matching key, label, secret, required
  const fields = [];
  const objRe =
    /(?:key|Key)\\?"?\s*:\s*\\?"([^"\\]+)\\?"[\s\S]*?(?:label|Label)\\?"?\s*:\s*\\?"([^"\\]+)\\?"[\s\S]*?(?:secret|Secret)\\?"?\s*:\s*(true|false|True|False)[\s\S]*?(?:required|Required)\\?"?\s*:\s*(true|false|True|False)/g;

  let m;
  while ((m = objRe.exec(slice)) !== null) {
    fields.push({
      key: m[1],
      label: m[2],
      secret: m[3].toLowerCase() === 'true',
      required: m[4].toLowerCase() === 'true',
    });
  }
  return fields;
}

function extractDescribeBlock(source, language) {
  let startIdx = -1;
  if (language === 'rust') {
    startIdx = source.indexOf('pub fn describe');
  } else if (language === 'go') {
    startIdx = source.indexOf('func describe');
  } else if (language === 'typescript') {
    startIdx = source.indexOf('export function describe');
  } else if (language === 'python') {
    startIdx = source.indexOf('def describe');
  } else if (language === 'c') {
    startIdx = source.indexOf('EXTISM_EXPORTED_FUNCTION(describe)');
  }

  if (startIdx === -1) {
    return source;
  }

  // Limit search to the describe() function body (next 4500 chars is ample)
  return source.slice(startIdx, startIdx + 4500);
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
    brand_colour: matchStringField(block, 'brand_colour') ?? '#000000',
    max_characters: matchIntField(block, 'max_characters'),
    max_attachments: matchIntField(block, 'max_attachments'),
    supports_threads: matchBoolField(block, 'supports_threads'),
    supports_alt_text: matchBoolField(block, 'supports_alt_text'),
    supports_delete: matchBoolField(block, 'supports_delete'),
    allowed_domains: matchStringArray(block, 'allowed_domains'),
    credential_fields: matchCredentialFields(block),
  };
}
