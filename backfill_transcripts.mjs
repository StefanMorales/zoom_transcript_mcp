// Downloads every transcript-bearing meeting instance in a trailing window, directly by
// instance UUID, so recurring meetings (same meeting ID, multiple occurrences) aren't
// silently collapsed to "latest only" the way the MCP tool's download_transcript is.
//
// Usage: node backfill_transcripts.mjs [daysBack]
//   No argument -> full 6-month sweep (Zoom Report API's hard lookback limit). Use for a
//   one-time backfill.
//   e.g. `node backfill_transcripts.mjs 2` -> last 2 days. Use for a recurring daily pull —
//   cheap, and safe to overlap days since already-downloaded files just get overwritten with
//   identical content (routing has already removed anything previously filed, so overlap
//   doesn't create duplicates downstream).
//
// Writes into the same transcripts/YYYY-MM/ + metadata/ convention as the MCP server,
// so route_transcripts.mjs can process the results identically afterward.

import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.join(__dirname, 'transcripts');

const { ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET, ZOOM_USER_EMAIL } = process.env;

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

async function listAllInstances(headers, daysBack) {
  const to = new Date();
  const from = new Date(to);
  if (daysBack) {
    from.setDate(from.getDate() - daysBack);
  } else {
    from.setMonth(from.getMonth() - 6); // Zoom Report API's hard lookback limit
  }
  const fmt = (d) => d.toISOString().split('T')[0];

  const meetings = [];
  let nextPageToken;
  do {
    const resp = await axios.get(`https://api.zoom.us/v2/report/users/${encodeURIComponent(ZOOM_USER_EMAIL)}/meetings`, {
      headers,
      params: { from: fmt(from), to: fmt(to), page_size: 300, next_page_token: nextPageToken },
    });
    meetings.push(...(resp.data.meetings || []));
    nextPageToken = resp.data.next_page_token || undefined;
  } while (nextPageToken);
  return meetings;
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

async function main() {
  const daysBack = process.argv[2] ? parseInt(process.argv[2], 10) : undefined;
  const token = await getToken();
  const headers = { Authorization: `Bearer ${token}` };

  const instances = await listAllInstances(headers, daysBack);
  console.log(`Found ${instances.length} meeting instances in the last ${daysBack ? daysBack + ' day(s)' : '6 months'}.\n`);

  let downloaded = 0, skipped = 0, failed = 0;

  for (const m of instances) {
    try {
      const encoded = m.uuid.includes('/') || m.uuid.startsWith('/')
        ? encodeURIComponent(encodeURIComponent(m.uuid))
        : encodeURIComponent(m.uuid);
      const infoResp = await axios.get(`https://api.zoom.us/v2/meetings/${encoded}/transcript`, { headers });
      const info = infoResp.data;
      if (!info.can_download) { skipped++; console.log(`SKIP (no transcript): "${m.topic}" (${m.start_time})`); continue; }

      const vttResp = await axios.get(info.download_url, { headers, responseType: 'text' });
      const vtt = vttResp.data;
      const participants = extractParticipants(vtt);

      const startTime = new Date(m.start_time);
      const monthDir = path.join(TRANSCRIPTS_DIR, `${startTime.getFullYear()}-${String(startTime.getMonth() + 1).padStart(2, '0')}`);
      const metaDir = path.join(monthDir, 'metadata');
      await fs.mkdir(metaDir, { recursive: true });

      const date = startTime.toISOString().split('T')[0];
      const time = startTime.toTimeString().split(' ')[0].replace(/:/g, '-');
      const fileName = `${date}_${time}_${sanitizeTopic(m.topic)}_${m.id}`;
      const vttPath = path.join(monthDir, `${fileName}.vtt`);
      const metaPath = path.join(metaDir, `${fileName}.json`);

      await fs.writeFile(vttPath, vtt);
      await fs.writeFile(metaPath, JSON.stringify({
        id: m.uuid, meetingId: String(m.id), topic: m.topic, startTime: m.start_time,
        duration: m.duration, participants, filePath: vttPath,
      }, null, 2));

      downloaded++;
      console.log(`OK: "${m.topic}" (${m.start_time}) -> ${participants.join(', ') || 'no participants parsed'}`);
    } catch (err) {
      failed++;
      console.log(`FAIL: "${m.topic}" (${m.start_time}): ${err.response?.status} ${err.response?.data?.message || err.message}`);
    }
  }

  console.log(`\nDownloaded ${downloaded}, skipped ${skipped} (no transcript), failed ${failed}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
