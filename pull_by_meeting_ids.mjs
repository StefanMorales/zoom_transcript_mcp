// Pulls transcripts by directly querying known meeting IDs via past_meetings/{id}/instances,
// bypassing the Report API's bulk date-range listing (backfill_transcripts.mjs's approach) —
// confirmed empirically (2026-07-13) that the Report API silently drops some real, hosted,
// in-window meetings that this per-ID endpoint still returns correctly. Use this when you
// have specific meeting IDs (e.g. copied from Zoom's web portal "Recordings"/"Meetings" list)
// that the regular backfill missed.
//
// Usage:
//   node pull_by_meeting_ids.mjs <path-to-json-array-of-ids>
//
// The JSON file should be a plain array of meeting ID strings, e.g. ["86865991467", ...].
// Writes into the same transcripts/YYYY-MM/ + metadata/ convention as backfill_transcripts.mjs,
// and skips anything already in .routed-state.json so re-runs don't re-download duplicates.

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');
const STATE_FILE = path.join(TRANSCRIPTS_DIR, '.routed-state.json');

const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET } = process.env;

async function getToken() {
  const resp = await axios.post(
    'https://zoom.us/oauth/token', null,
    {
      params: { grant_type: 'account_credentials', account_id: ZOOM_ACCOUNT_ID },
      auth: { username: ZOOM_CLIENT_ID, password: ZOOM_CLIENT_SECRET },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }
  );
  return resp.data.access_token;
}

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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const idsFile = process.argv[2];
  if (!idsFile) {
    console.error('Usage: node pull_by_meeting_ids.mjs <path-to-json-array-of-ids>');
    process.exit(1);
  }
  const meetingIds = JSON.parse(await fs.readFile(path.resolve(idsFile), 'utf-8'));

  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf-8').catch(() => '{"routed":{}}'));
  const alreadyRouted = new Set(Object.keys(state.routed || {}));

  let downloaded = 0, skippedNoTranscript = 0, skippedAlreadyRouted = 0, failed = 0;
  const failures = [];

  for (const id of meetingIds) {
    let instances;
    try {
      const instResp = await axios.get(`https://api.zoom.us/v2/past_meetings/${id}/instances`, { headers });
      instances = instResp.data.meetings || [];
    } catch (err) {
      failed++;
      failures.push(`${id}: instances lookup failed — ${err.response?.status} ${err.response?.data?.message || err.message}`);
      await sleep(150);
      continue;
    }

    for (const instance of instances) {
      if (alreadyRouted.has(instance.uuid)) { skippedAlreadyRouted++; continue; }
      try {
        const encoded = instance.uuid.includes('/') || instance.uuid.startsWith('/')
          ? encodeURIComponent(encodeURIComponent(instance.uuid))
          : encodeURIComponent(instance.uuid);
        const infoResp = await axios.get(`https://api.zoom.us/v2/meetings/${encoded}/transcript`, { headers });
        const info = infoResp.data;
        if (!info.can_download) { skippedNoTranscript++; continue; }

        const vttResp = await axios.get(info.download_url, { headers, responseType: 'text' });
        const vtt = vttResp.data;
        const participants = extractParticipants(vtt);
        const topic = info.meeting_topic || `Meeting ${id}`;

        const startTime = new Date(instance.start_time);
        const monthDir = path.join(TRANSCRIPTS_DIR, `${startTime.getFullYear()}-${String(startTime.getMonth() + 1).padStart(2, '0')}`);
        const metaDir = path.join(monthDir, 'metadata');
        await fs.mkdir(metaDir, { recursive: true });

        const date = startTime.toISOString().split('T')[0];
        const time = startTime.toTimeString().split(' ')[0].replace(/:/g, '-');
        const fileName = `${date}_${time}_${sanitizeTopic(topic)}_${id}`;
        const vttPath = path.join(monthDir, `${fileName}.vtt`);
        const metaPath = path.join(metaDir, `${fileName}.json`);

        await fs.writeFile(vttPath, vtt);
        await fs.writeFile(metaPath, JSON.stringify({
          id: instance.uuid, meetingId: String(id), topic, startTime: instance.start_time,
          duration: null, participants, filePath: vttPath,
        }, null, 2));

        downloaded++;
        console.log(`OK: "${topic}" (${instance.start_time}) -> ${participants.join(', ') || 'no participants parsed'}`);
      } catch (err) {
        if (err.response?.status === 404) { skippedNoTranscript++; continue; }
        failed++;
        failures.push(`${id} / ${instance.uuid}: ${err.response?.status} ${err.response?.data?.message || err.message}`);
      }
      await sleep(150); // stay well under Zoom's rate limits across ~120 IDs x N instances
    }
    await sleep(150);
  }

  console.log(`\nDownloaded ${downloaded}, no-transcript ${skippedNoTranscript}, already-routed ${skippedAlreadyRouted}, failed ${failed}.`);
  if (failures.length) {
    console.log(`\nFailures:`);
    for (const f of failures) console.log(`  - ${f}`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
