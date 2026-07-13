// Manually file specific staged transcripts to a known destination, bypassing the router's
// ambiguity check — for cases already confirmed by a human (Stefan), where the router's
// "exactly one candidate" rule can't resolve a genuine multi-hint overlap (e.g. a participant
// who legitimately spans two relationships) but the correct answer is already known.
// Mirrors route_transcripts.mjs's routeToEntry exactly, so .routed-state.json stays consistent.
//
// Usage:
//   node force_route.mjs <Domain> <name> <metadata-json-path> [<metadata-json-path> ...]
// Metadata paths are relative to server/transcripts/ or absolute.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..');
const SOURCE_DIR = path.join(__dirname, 'transcripts');
const STATE_FILE = path.join(SOURCE_DIR, '.routed-state.json');

async function main() {
  const [domain, name, ...metaPaths] = process.argv.slice(2);
  if (!domain || !name || metaPaths.length === 0) {
    console.error('Usage: node force_route.mjs <Domain> <name> <metadata-json-path> [...]');
    process.exit(1);
  }

  const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8').catch(() => '{"routed":{}}'));
  // A "name" can itself already end in a /meetings/<subfolder> path (nesting several
  // people's meetings under one shared folder's own meetings/ dir) — don't double-append.
  const combined = path.join(domain, name);
  const destDir = /(^|\/)meetings(\/|$)/.test(combined)
    ? path.join(WORKSPACE_DIR, combined)
    : path.join(WORKSPACE_DIR, combined, 'meetings');
  const destMetaDir = path.join(destDir, 'metadata');
  await fs.mkdir(destDir, { recursive: true });
  await fs.mkdir(destMetaDir, { recursive: true });

  for (const rawPath of metaPaths) {
    const metaPath = path.isAbsolute(rawPath) ? rawPath : path.join(SOURCE_DIR, rawPath);
    const metadata = JSON.parse(await fs.readFile(metaPath, 'utf-8'));

    const vttName = path.basename(metadata.filePath);
    const destVttPath = path.join(destDir, vttName);
    await fs.copyFile(metadata.filePath, destVttPath);

    const destMetaPath = path.join(destMetaDir, vttName.replace(/\.vtt$/, '.json'));
    await fs.writeFile(destMetaPath, JSON.stringify({ ...metadata, filePath: destVttPath }, null, 2));

    await fs.unlink(metadata.filePath);
    await fs.unlink(metaPath);

    const key = metadata.id || metadata.meetingId;
    state.routed[key] = { domain, name, routedAt: new Date().toISOString(), destPath: destVttPath };
    console.log(`Routed "${metadata.topic}" -> ${path.relative(WORKSPACE_DIR, destDir)}/`);
  }

  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
