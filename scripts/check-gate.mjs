// Local gate validator: re-implements the competition's seven gate rows against an
// /output directory, so the entry can be checked before it is submitted.
//
//   node scripts/check-gate.mjs <output-dir> <snapshot.json>
//
// Exit 0 when all seven rows pass; exit 1 otherwise, naming each failed row.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const TEXT_MAX_BYTES = 65_536;

const out = process.argv[2];
const snapshotPath = process.argv[3];
if (!out || !snapshotPath) {
  process.stderr.write('usage: node scripts/check-gate.mjs <output-dir> <snapshot.json>\n');
  process.exit(2);
}

const results = [];
function row(name, pass, detail) {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Every regular file under a directory, paths relative to it. */
function walk(dir, rel = '') {
  const found = [];
  for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const p = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walk(dir, p));
    else if (entry.isFile()) found.push(p);
  }
  return found.sort();
}

/** PNG width/height from the IHDR chunk, or null when the bytes are not a whole PNG. */
function pngSize(bytes) {
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 33 || !magic.every((b, i) => bytes[i] === b)) return null;
  if (bytes.readUInt32BE(12) !== 0x49484452) return null; // IHDR
  const iend = bytes.subarray(bytes.length - 12);
  if (iend.readUInt32BE(0) !== 0 || iend.readUInt32BE(4) !== 0x49454e44) return null; // IEND
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

/** JPEG width/height from the first SOF marker, or null when the bytes are not a whole JPEG. */
function jpegSize(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  if (bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const len = bytes.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

// ---------------------------------------------------------------- dashboard_files
let dashDetail = '';
try {
  const files = walk(join(out, 'dashboard'));
  const totalBytes = files.reduce((n, f) => n + statSync(join(out, 'dashboard', f)).size, 0);
  const badName = files.find((f) => f.split('/').some((part) => !PLAIN_NAME.test(part)) || f.split('/').some((part) => part.startsWith('.')));
  const hasHtml = files.some((f) => f === 'index.html');
  const hasCss = files.some((f) => f.endsWith('.css'));
  const hasJs = files.some((f) => f.endsWith('.js'));
  let offender = null;
  for (const f of files) {
    const text = readFileSync(join(out, 'dashboard', f), 'utf8');
    if (f.endsWith('.html')) {
      const attrs = [...text.matchAll(/[\w-]+=(["'])(.*?)\1/g)].map((m) => m[2]);
      const styles = [...text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]);
      const inline = [...text.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      const hits = [...attrs, ...styles, ...inline].filter((v) => v.includes('http://') || v.includes('https://'));
      if (hits.length > 0) { offender = `${f}: ${hits[0].slice(0, 60)}`; break; }
    } else if (f.endsWith('.css')) {
      if (text.includes('http://') || text.includes('https://')) { offender = `${f}: URL in CSS`; break; }
    } else if (f.endsWith('.js')) {
      const specs = [
        ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g),
        ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]/g),
        ...text.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]/g),
        ...text.matchAll(/\bimport\s+['"]([^'"]+)['"]/g),
      ].map((m) => m[1]);
      const hit = specs.find((s) => s.startsWith('http://') || s.startsWith('https://'));
      if (hit) { offender = `${f}: network import ${hit}`; break; }
    }
  }
  const pass = files.length <= 400 && totalBytes <= 4_194_304 && !badName && hasHtml && hasCss && hasJs && !offender;
  dashDetail = `${files.length} files, ${totalBytes} bytes` + (badName ? `; bad name ${badName}` : '') + (!hasHtml ? '; no index.html' : '') + (!hasCss ? '; no .css' : '') + (!hasJs ? '; no .js' : '') + (offender ? `; ${offender}` : '');
  row('dashboard_files', pass, dashDetail);
} catch (err) {
  row('dashboard_files', false, String(err.message));
}

// ---------------------------------------------------------------- board_file + sorted + coverage + farm_steps
const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf8'));
const snapshotSlugs = new Set(snapshot.protocols.map((p) => p.slug));
let board;
try {
  const boardBytes = statSync(join(out, 'board.json')).size;
  const parsed = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
  board = Array.isArray(parsed) ? parsed : parsed.rows;
  let issue = null;
  if (!Array.isArray(board)) issue = 'rows is not an array';
  else if (board.length < 100 || board.length > 4000) issue = `${board.length} rows`;
  else if (boardBytes > 8_388_608) issue = `board.json is ${boardBytes} bytes`;
  else {
    const seen = new Set();
    for (const r of board) {
      if (typeof r.slug !== 'string' || !snapshotSlugs.has(r.slug)) { issue = `unknown slug ${String(r.slug)}`; break; }
      if (seen.has(r.slug)) { issue = `duplicate slug ${r.slug}`; break; }
      seen.add(r.slug);
      if (typeof r.name !== 'string' || r.name.length === 0) { issue = `${r.slug}: empty name`; break; }
      if (!Number.isSafeInteger(r.rank) || r.rank <= 0) { issue = `${r.slug}: rank ${r.rank}`; break; }
      if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) { issue = `${r.slug}: implied ${r.implied_value_usd}`; break; }
      if (!Array.isArray(r.farm_steps)) { issue = `${r.slug}: no farm_steps`; break; }
    }
  }
  row('board_file', issue === null, issue ?? `${board.length} rows, ${boardBytes} bytes`);
} catch (err) {
  row('board_file', false, String(err.message));
  board = null;
}

if (board) {
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  let issue = null;
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) { issue = `rank ${i + 1} is ${ranks[i]}`; break; }
  if (!issue) for (let i = 1; i < board.length; i++) if (board[i].implied_value_usd > board[i - 1].implied_value_usd) { issue = `row ${i + 1} outranks row ${i}`; break; }
  if (!issue && board.length >= 2 && board[0].implied_value_usd === board[board.length - 1].implied_value_usd) issue = 'all rows share one implied value';
  row('sorted_by_value', issue === null, issue ?? `${board.length} rows, ranks 1..${board.length}, implied non-increasing`);

  const have = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !have.has(s));
  row('coverage', missing.length === 0, missing.length === 0 ? `${snapshot.watchlist.length}/${snapshot.watchlist.length} watchlist slugs` : `missing ${missing.slice(0, 5).join(', ')}`);

  let farmIssue = null;
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) { farmIssue = `${r.slug}: ${r.farm_steps.length} steps`; break; }
    for (const s of r.farm_steps) {
      const len = s.trim().length;
      if (len < 20 || len > 600) { farmIssue = `${r.slug}: a step of ${len} characters`; break; }
    }
    if (farmIssue) break;
  }
  row('farm_steps', farmIssue === null, farmIssue ?? `all ${board.length} rows carry 6 steps of 20–600 chars`);
} else {
  row('sorted_by_value', false, 'no board to sort');
  row('coverage', false, 'no board to cover');
  row('farm_steps', false, 'no board to check');
}

// ---------------------------------------------------------------- screenshots
try {
  const names = readdirSync(join(out, 'screenshots')).filter((n) => !n.startsWith('.')).sort();
  let issue = null;
  if (names.length < 3 || names.length > 4) issue = `${names.length} images`;
  else {
    for (const name of names) {
      const bytes = readFileSync(join(out, 'screenshots', name));
      if (bytes.length > 524_288) { issue = `${name} is ${bytes.length} bytes`; break; }
      const size = pngSize(bytes) ?? jpegSize(bytes);
      if (!size) { issue = `${name} is not a whole PNG or JPEG`; break; }
      const longSide = Math.max(size.w, size.h);
      const shortSide = Math.min(size.w, size.h);
      if (longSide > 1440 || shortSide < 800) { issue = `${name} is ${size.w}x${size.h}`; break; }
    }
  }
  const sizes = names.map((n) => `${n} ${statSync(join(out, 'screenshots', n)).size}B`).join(', ');
  row('screenshots', issue === null, issue ?? sizes);
} catch (err) {
  row('screenshots', false, String(err.message));
}

// ---------------------------------------------------------------- dossier_matches
try {
  const written = readFileSync(join(out, 'dossier.json'));
  const rebuilt = buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } });
  const same = Buffer.compare(written, Buffer.from(rebuilt)) === 0;
  row('dossier_matches', same, same ? `byte-identical, ${written.length} bytes` : `written ${written.length} bytes, rebuilt ${rebuilt.length} bytes`);
} catch (err) {
  row('dossier_matches', false, String(err.message));
}

const failed = results.filter((r) => !r.pass).length;
console.log(failed === 0 ? `gate: ${results.length}/${results.length} rows pass` : `gate: ${failed} row${failed === 1 ? '' : 's'} fail`);
process.exit(failed === 0 ? 0 : 1);
