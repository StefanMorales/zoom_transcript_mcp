// Routes downloaded Zoom transcripts into a <domain>/<name>/meetings/ folder based on who
// was in the meeting and what it was called. "Domain" here just means a top-level folder —
// rename/restructure the three example ones (Clients/, Collaborators/, Pipeline-Development/)
// to whatever categories make sense for you.
//
// Matches on participant names and topic keywords against a hints file (see
// ROUTING_HINTS_FILE below and hints.example.json for the schema). Only auto-routes when
// exactly one entry matches; anything ambiguous (multiple matches) or unmatched (zero
// matches) is left in place in transcripts/ and reported instead of guessed — never files
// something it isn't confident about.

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = path.join(__dirname, 'transcripts');

// Both configurable via env vars since where you keep your folders and hints file is
// entirely up to you — these defaults assume nothing beyond "somewhere near this repo."
const WORKSPACE_DIR = process.env.ROUTING_WORKSPACE_DIR
  ? path.resolve(process.env.ROUTING_WORKSPACE_DIR)
  : path.resolve(__dirname, '..');
const HINTS_FILE = process.env.ROUTING_HINTS_FILE
  ? path.resolve(process.env.ROUTING_HINTS_FILE)
  : path.join(__dirname, 'hints.json');

const STATE_FILE = path.join(SOURCE_DIR, '.routed-state.json');

async function loadJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf-8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

async function findMetadataFiles(dir) {
  const results = [];
  let monthDirs;
  try {
    monthDirs = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return results;
    throw err;
  }
  for (const entry of monthDirs) {
    if (!entry.isDirectory()) continue;
    const metadataDir = path.join(dir, entry.name, 'metadata');
    let files;
    try {
      files = await fs.readdir(metadataDir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (f.endsWith('.json')) results.push(path.join(metadataDir, f));
    }
  }
  return results;
}

function scoreClient(metadata, hint) {
  let score = 0;
  const reasons = [];
  const topicLower = (metadata.topic || '').toLowerCase();
  const participantsLower = (metadata.participants || []).map((p) => p.toLowerCase());

  for (const name of hint.participant_names || []) {
    const nameLower = name.toLowerCase();
    const hit = participantsLower.some((p) => p.includes(nameLower) || nameLower.includes(p));
    if (hit) {
      score += 2;
      reasons.push(`participant match: "${name}"`);
    }
  }
  for (const kw of hint.topic_keywords || []) {
    if (topicLower.includes(kw.toLowerCase())) {
      score += 1;
      reasons.push(`topic keyword: "${kw}"`);
    }
  }
  return { score, reasons };
}

async function routeToEntry(domain, name, metadata, sourceMetaPath) {
  const destDir = path.join(WORKSPACE_DIR, domain, name, 'meetings');
  const destMetaDir = path.join(destDir, 'metadata');
  await fs.mkdir(destDir, { recursive: true });
  await fs.mkdir(destMetaDir, { recursive: true });

  const vttName = path.basename(metadata.filePath);
  const destVttPath = path.join(destDir, vttName);
  await fs.copyFile(metadata.filePath, destVttPath);

  const metaName = vttName.replace(/\.vtt$/, '.json');
  const destMetaPath = path.join(destMetaDir, metaName);
  await fs.writeFile(destMetaPath, JSON.stringify({ ...metadata, filePath: destVttPath }, null, 2));

  // Copy is confirmed written at this point — safe to remove the staging originals so a
  // recurring routine doesn't pile up stale duplicates in transcripts/ forever. Ambiguous
  // and unmatched items never reach this function, so they're untouched by design.
  await fs.unlink(metadata.filePath);
  await fs.unlink(sourceMetaPath);

  return destVttPath;
}

async function main() {
  await fs.mkdir(SOURCE_DIR, { recursive: true }); // may not exist if a prior run cleaned it up

  const hintsFile = await loadJson(HINTS_FILE, { entries: {} });
  const entries = hintsFile.entries || {};
  const entryNames = Object.keys(entries);

  if (entryNames.length === 0) {
    console.log(`No routing hints found in ${HINTS_FILE} — nothing to route against.`);
    return;
  }

  const state = await loadJson(STATE_FILE, { routed: {} });
  const metadataFiles = await findMetadataFiles(SOURCE_DIR);

  const routed = [];
  const ambiguous = [];
  const unmatched = [];
  let staleCleaned = 0;

  for (const metaPath of metadataFiles) {
    const metadata = await loadJson(metaPath, null);
    if (!metadata) continue;

    const key = metadata.id || metadata.meetingId;
    if (state.routed[key]) {
      // Already routed in a previous run — a re-download (e.g. an overlapping daily pull
      // window catching the same meeting twice) left a stale duplicate in staging with a
      // real destination already on record. Clean it up rather than leaving it to pile up.
      await fs.unlink(metadata.filePath).catch(() => {});
      await fs.unlink(metaPath).catch(() => {});
      staleCleaned++;
      continue;
    }

    const scored = entryNames
      .map((name) => ({ name, domain: entries[name].domain, ...scoreClient(metadata, entries[name]) }))
      .filter((c) => c.score > 0);

    if (scored.length === 1) {
      const { name, domain, reasons } = scored[0];
      const destPath = await routeToEntry(domain, name, metadata, metaPath);
      state.routed[key] = { domain, name, routedAt: new Date().toISOString(), destPath };
      routed.push({ topic: metadata.topic, domain, name, reasons, destPath });
    } else if (scored.length > 1) {
      ambiguous.push({ topic: metadata.topic, candidates: scored });
    } else {
      unmatched.push({ topic: metadata.topic, startTime: metadata.startTime, participants: metadata.participants });
    }
  }

  await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2));

  if (staleCleaned > 0) {
    console.log(`\nCleaned up ${staleCleaned} stale re-downloaded duplicate(s) of already-routed meetings.`);
  }

  console.log(`\n=== Routed (${routed.length}) ===`);
  for (const r of routed) {
    console.log(`- "${r.topic}" -> ${r.domain}/${r.name}/meetings/ (${r.reasons.join(', ')})`);
  }

  console.log(`\n=== Ambiguous — needs your call (${ambiguous.length}) ===`);
  for (const a of ambiguous) {
    console.log(`- "${a.topic}"`);
    for (const c of a.candidates) {
      console.log(`    ${c.name}: score ${c.score} (${c.reasons.join(', ')})`);
    }
  }

  console.log(`\n=== Unmatched — no client hint fired (${unmatched.length}) ===`);
  for (const u of unmatched) {
    console.log(`- "${u.topic}" (${u.startTime}) — participants: ${(u.participants || []).join(', ') || 'none captured'}`);
  }
  console.log(`\nUnmatched/ambiguous transcripts stay in ${SOURCE_DIR} and will be re-reported until hints.json is updated or they're handled manually.`);
}

main().catch((err) => {
  console.error('Routing failed:', err);
  process.exit(1);
});
