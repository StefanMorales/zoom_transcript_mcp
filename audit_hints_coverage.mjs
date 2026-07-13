// For every hints.json entry, scans all already-filed metadata in that folder and reports
// participant names that appear in real filed meetings but aren't yet covered by that entry's
// own participant_names — i.e. people who currently only route there via a topic keyword or
// another participant's match, not their own name. Read-only: prints findings, changes nothing.
//
// Usage: node audit_hints_coverage.mjs

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_DIR = path.resolve(__dirname, '..', '..', '..');
const HINTS_FILE = path.join(__dirname, '..', '..', '..', 'Clients', '_routing', 'hints.json');

const IGNORE_NAMES = new Set([
  'your name (he/they)', 'iphone', 'iphone 17 air', "someone's iphone", "someone's iphone (2)",
]);

// Unicode-aware — see the matching note in route_transcripts.mjs's containsAsWholeName.
function containsAsWholeName(haystack, needle) {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(haystack);
}

async function findAllMetadataFiles(dir) {
  const results = [];
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await findAllMetadataFiles(full)));
    } else if (entry.name.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

const MIN_OCCURRENCES = 2;

async function main() {
  const hintsData = JSON.parse(await fs.readFile(HINTS_FILE, 'utf-8'));
  const entries = hintsData.entries;

  // Build a global index: lowercase name -> list of hint entry names already using it,
  // so we can flag when a suggestion would create a new cross-folder collision.
  const globalUsage = new Map();
  for (const [name, hint] of Object.entries(entries)) {
    for (const p of hint.participant_names || []) {
      const lower = p.toLowerCase();
      if (!globalUsage.has(lower)) globalUsage.set(lower, []);
      globalUsage.get(lower).push(name);
    }
  }

  for (const [name, hint] of Object.entries(entries)) {
    const combined = path.join(hint.domain, name);
    const destDir = /(^|\/)meetings(\/|$)/.test(combined)
      ? path.join(WORKSPACE_DIR, combined)
      : path.join(WORKSPACE_DIR, combined, 'meetings');

    const metaFiles = (await findAllMetadataFiles(destDir)).filter((f) => path.basename(path.dirname(f)) === 'metadata');
    if (metaFiles.length === 0) continue;

    const counts = new Map(); // lowercase -> { original, count }
    for (const f of metaFiles) {
      let metadata;
      try { metadata = JSON.parse(await fs.readFile(f, 'utf-8')); } catch { continue; }
      for (const p of metadata.participants || []) {
        const lower = p.toLowerCase().trim();
        if (!lower || IGNORE_NAMES.has(lower)) continue;
        const entry = counts.get(lower) || { original: p, count: 0 };
        entry.count++;
        counts.set(lower, entry);
      }
    }

    const knownNames = (hint.participant_names || []).map((n) => n.toLowerCase());
    const recurring = [];
    for (const [lower, { original, count }] of counts) {
      if (count < MIN_OCCURRENCES) continue;
      const covered = knownNames.some((k) => containsAsWholeName(lower, k) || containsAsWholeName(k, lower));
      if (!covered) recurring.push({ original, count });
    }

    if (recurring.length > 0) {
      console.log(`\n=== ${name} (${metaFiles.length} meetings) ===`);
      console.log(`Already known: ${(hint.participant_names || []).join(', ') || '(none)'}`);
      console.log(`Recurring (${MIN_OCCURRENCES}+) participants not yet in this hint:`);
      for (const { original, count } of recurring.sort((a, b) => b.count - a.count)) {
        const elsewhere = globalUsage.get(original.toLowerCase());
        const flag = elsewhere ? `  [!] already a hint for: ${elsewhere.join(', ')}` : '';
        console.log(`  - ${original} (seen ${count}x)${flag}`);
      }
    }
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
