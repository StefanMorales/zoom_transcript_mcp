// Manually import .vtt transcript(s) downloaded by hand from Zoom's web portal (e.g. older
// than the Report API's 6-month backfill window) so route_transcripts.mjs can process them
// exactly like a normal pull. Writes into the same transcripts/YYYY-MM/ + metadata/
// convention as backfill_transcripts.mjs, reusing its participant-extraction logic.
//
// Single file, explicit topic/time:
//   node import_transcript.mjs <path-to-vtt> "<topic>" <startTimeISO> [durationMinutes]
//
// Whole folder, auto-guessing topic (from filename) and start time (from Zoom's GMT-prefixed
// filename convention, or the file's modified time as a fallback) for every .vtt inside:
//   node import_transcript.mjs <folder-of-vtts>
//
// Auto-guessed topic/time are clearly flagged in the output — participant matching (the
// primary routing signal) doesn't depend on either being exact, but check the printed guesses
// and edit the written metadata .json by hand if a topic/date looks wrong before routing.

import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');

function extractParticipants(vtt) {
  const participants = new Set();
  const lines = vtt.replace(/\r\n/g, '\n').split('\n');
  let inCue = false, isFirst = false;
  for (const line of lines) {
    if (line.includes('-->')) { inCue = true; isFirst = true; continue; }
    if (line.trim() === '') { inCue = false; continue; }
    if (!inCue) continue;
    if (isFirst) {
      const m = line.match(/^([^:]{2,60}):\s(.*)$/);
      if (m) participants.add(m[1].trim());
    }
    isFirst = false;
  }
  return Array.from(participants);
}

function sanitizeTopic(topic) {
  return (topic || 'Untitled').replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').substring(0, 50);
}

// Zoom's default cloud-recording download filename embeds the start time as
// GMT<YYYYMMDD>-<HHMMSS>. Not every export follows this (custom recording names vary), so
// this is a best-effort guess, not something to trust blindly.
function guessStartTimeFromFilename(filename) {
  const m = filename.match(/GMT(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function guessTopicFromFilename(filename) {
  const stripped = filename
    .replace(/\.vtt$/i, '')
    .replace(/\.transcript$/i, '')
    .replace(/GMT\d{8}-\d{6}_?/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return stripped || 'Untitled';
}

async function importOne(srcPath, topic, startTime, duration, { guessedTopic = false, guessedTime = false } = {}) {
  const vtt = await fs.readFile(srcPath, 'utf-8');
  const participants = extractParticipants(vtt);

  const monthDir = path.join(TRANSCRIPTS_DIR, `${startTime.getFullYear()}-${String(startTime.getMonth() + 1).padStart(2, '0')}`);
  const metaDir = path.join(monthDir, 'metadata');
  await fs.mkdir(metaDir, { recursive: true });

  const id = `manual-${crypto.randomUUID()}`;
  const date = startTime.toISOString().split('T')[0];
  const time = startTime.toTimeString().split(' ')[0].replace(/:/g, '-');
  const fileName = `${date}_${time}_${sanitizeTopic(topic)}_${id}`;
  const vttPath = path.join(monthDir, `${fileName}.vtt`);
  const metaPath = path.join(metaDir, `${fileName}.json`);

  await fs.writeFile(vttPath, vtt);
  await fs.writeFile(metaPath, JSON.stringify({
    id, meetingId: id, topic, startTime: startTime.toISOString(),
    duration: duration ?? null, participants, filePath: vttPath,
  }, null, 2));

  const flags = [guessedTopic && 'topic guessed', guessedTime && 'time guessed'].filter(Boolean);
  console.log(`Imported "${topic}" (${startTime.toISOString()})${flags.length ? ` [${flags.join(', ')}]` : ''}`);
  console.log(`  -> ${vttPath}`);
  console.log(`  Participants: ${participants.join(', ') || '(none found)'}`);
}

async function main() {
  const [srcArg, topicArg, startTimeArg, durationArg] = process.argv.slice(2);
  if (!srcArg) {
    console.error('Usage: node import_transcript.mjs <path-to-vtt-or-folder> ["<topic>"] [startTimeISO] [durationMinutes]');
    process.exit(1);
  }

  const resolvedSrc = path.resolve(srcArg);
  const stat = await fs.stat(resolvedSrc);

  if (stat.isDirectory()) {
    const files = (await fs.readdir(resolvedSrc)).filter((f) => f.toLowerCase().endsWith('.vtt'));
    if (files.length === 0) {
      console.log(`No .vtt files found in ${resolvedSrc}`);
      return;
    }
    console.log(`Found ${files.length} .vtt file(s) in ${resolvedSrc}\n`);
    for (const file of files) {
      const filePath = path.join(resolvedSrc, file);
      const fileStat = await fs.stat(filePath);
      const guessedTime = guessStartTimeFromFilename(file);
      const startTime = guessedTime || fileStat.mtime;
      const topic = guessTopicFromFilename(file);
      await importOne(filePath, topic, startTime, null, { guessedTopic: true, guessedTime: true });
    }
    console.log(`\nGuessed topics/times from filenames — check the metadata .json files and edit by hand if any look wrong.`);
    console.log(`Then run 'node --env-file=.env route_transcripts.mjs' to route everything imported.`);
    return;
  }

  if (!topicArg || !startTimeArg) {
    console.error('For a single file, both "<topic>" and startTimeISO are required.');
    console.error('Usage: node import_transcript.mjs <path-to-vtt> "<topic>" <startTimeISO> [durationMinutes]');
    process.exit(1);
  }
  const startTime = new Date(startTimeArg);
  if (isNaN(startTime.getTime())) {
    console.error(`Could not parse start time: "${startTimeArg}" — use an ISO date like 2025-11-03T16:00:00Z`);
    process.exit(1);
  }
  await importOne(resolvedSrc, topicArg, startTime, durationArg ? parseInt(durationArg, 10) : null);
  console.log(`\nRun 'node --env-file=.env route_transcripts.mjs' to route it.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
