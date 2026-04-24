const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('../config');

const { serviceAccount, config } = loadRuntimeConfig();

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.databaseURL
  });
}

const rtdb = admin.database();
const firestore = admin.firestore();

const args = new Set(process.argv.slice(2));
const shouldExecute = args.has('--execute');
const shouldIncludeMatchHistory = !args.has('--skip-match-history');
const MAX_BATCH_WRITES = 450;

function sanitizeForFirestore(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((accumulator, [key, nestedValue]) => {
      if (nestedValue !== undefined) {
        accumulator[key] = sanitizeForFirestore(nestedValue);
      }
      return accumulator;
    }, {});
  }
  return value;
}

function getDocRef(docPath) {
  const segments = String(docPath || '').split('/').filter(Boolean);
  if (segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error(`Invalid Firestore document path: ${docPath}`);
  }

  let ref = firestore.collection(segments[0]).doc(segments[1]);
  for (let index = 2; index < segments.length; index += 2) {
    ref = ref.collection(segments[index]).doc(segments[index + 1]);
  }
  return ref;
}

class BatchWriter {
  constructor({ execute = false } = {}) {
    this.execute = execute;
    this.batch = firestore.batch();
    this.pendingWrites = 0;
    this.totalWrites = 0;
  }

  async set(docPath, data, options = {}) {
    this.totalWrites += 1;
    if (!this.execute) return;

    const ref = getDocRef(docPath);
    this.batch.set(ref, sanitizeForFirestore(data), { merge: options.merge === true });
    this.pendingWrites += 1;

    if (this.pendingWrites >= MAX_BATCH_WRITES) {
      await this.flush();
    }
  }

  async flush() {
    if (!this.execute || this.pendingWrites === 0) return;
    await this.batch.commit();
    this.batch = firestore.batch();
    this.pendingWrites = 0;
  }
}

async function readRtdbPath(path) {
  const snapshot = await rtdb.ref(path).once('value');
  return snapshot.val() || {};
}

function isArchivedMatch(match) {
  const status = String(match?.status || '').trim().toLowerCase();
  return status === 'finalized' || Boolean(match?.finalizedAt) || Boolean(match?.completedAt);
}

function logSection(title) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
}

async function migrateFlatCollection({ sourcePath, targetCollection = sourcePath, writer, summary }) {
  const source = await readRtdbPath(sourcePath);
  const entries = Object.entries(source || {});

  for (const [docId, value] of entries) {
    await writer.set(`${targetCollection}/${docId}`, value, { merge: false });
  }

  summary.push({
    label: sourcePath,
    target: `${targetCollection}/{docId}`,
    count: entries.length
  });
}

async function migrateUsers(writer, summary) {
  const users = await readRtdbPath('users');
  let userCount = 0;
  let moderationHistoryCount = 0;

  for (const [userId, userData] of Object.entries(users || {})) {
    const normalizedUser = userData && typeof userData === 'object' ? userData : {};
    const moderationHistory = normalizedUser.moderationHistory && typeof normalizedUser.moderationHistory === 'object'
      ? normalizedUser.moderationHistory
      : {};
    const { moderationHistory: _ignored, ...userDoc } = normalizedUser;

    await writer.set(`users/${userId}`, userDoc, { merge: false });
    userCount += 1;

    for (const [entryId, historyEntry] of Object.entries(moderationHistory)) {
      await writer.set(`users/${userId}/moderationHistory/${entryId}`, historyEntry, { merge: false });
      moderationHistoryCount += 1;
    }
  }

  summary.push({
    label: 'users',
    target: 'users/{uid}',
    count: userCount
  });
  summary.push({
    label: 'users/*/moderationHistory',
    target: 'users/{uid}/moderationHistory/{entryId}',
    count: moderationHistoryCount
  });
}

async function migrateAdminNotes(writer, summary) {
  const notesByUser = await readRtdbPath('adminNotes');
  let noteCount = 0;

  for (const [userId, notes] of Object.entries(notesByUser || {})) {
    for (const [noteId, note] of Object.entries(notes || {})) {
      await writer.set(`users/${userId}/adminNotes/${noteId}`, note, { merge: false });
      noteCount += 1;
    }
  }

  summary.push({
    label: 'adminNotes',
    target: 'users/{uid}/adminNotes/{noteId}',
    count: noteCount
  });
}

async function migratePlayers(writer, summary) {
  const players = await readRtdbPath('players');
  const entries = Object.entries(players || {});

  for (const [playerId, playerData] of entries) {
    await writer.set(`players/${playerId}`, playerData, { merge: false });
  }

  summary.push({
    label: 'players',
    target: 'players/{playerId}',
    count: entries.length
  });
}

async function migrateSupportData(writer, summary) {
  const tickets = await readRtdbPath('supportTickets');
  const messagesByTicket = await readRtdbPath('supportMessages');
  let ticketCount = 0;
  let messageCount = 0;

  for (const [ticketId, ticket] of Object.entries(tickets || {})) {
    await writer.set(`supportTickets/${ticketId}`, ticket, { merge: false });
    ticketCount += 1;
  }

  for (const [ticketId, messages] of Object.entries(messagesByTicket || {})) {
    for (const [messageId, message] of Object.entries(messages || {})) {
      await writer.set(`supportTickets/${ticketId}/messages/${messageId}`, message, { merge: false });
      messageCount += 1;
    }
  }

  summary.push({
    label: 'supportTickets',
    target: 'supportTickets/{ticketId}',
    count: ticketCount
  });
  summary.push({
    label: 'supportMessages',
    target: 'supportTickets/{ticketId}/messages/{messageId}',
    count: messageCount
  });
}

async function migrateStaffRoles(writer, summary) {
  const settingsRoles = await readRtdbPath('settings/staffRoles');
  const rootRoles = await readRtdbPath('staffRoles');
  const mergedRoles = {
    ...(rootRoles || {}),
    ...(settingsRoles || {})
  };

  for (const [roleId, roleData] of Object.entries(mergedRoles)) {
    await writer.set(`staffRoles/${roleId}`, roleData, { merge: false });
  }

  summary.push({
    label: 'settings/staffRoles + staffRoles',
    target: 'staffRoles/{roleId}',
    count: Object.keys(mergedRoles).length
  });
}

async function migrateArchivedMatches(writer, summary) {
  const matches = await readRtdbPath('matches');
  let archivedCount = 0;

  for (const [matchId, matchData] of Object.entries(matches || {})) {
    if (!isArchivedMatch(matchData)) continue;
    await writer.set(`matchHistory/${matchId}`, matchData, { merge: false });
    archivedCount += 1;
  }

  summary.push({
    label: 'matches (finalized only)',
    target: 'matchHistory/{matchId}',
    count: archivedCount
  });
}

async function main() {
  const writer = new BatchWriter({ execute: shouldExecute });
  const summary = [];

  console.log(`RTDB -> Firestore migration mode: ${shouldExecute ? 'EXECUTE' : 'DRY RUN'}`);
  console.log('This script copies long-lived data into Firestore. It does not delete anything from Realtime Database.');
  console.log('Realtime-only paths intentionally excluded: queue, active matches, inbox, notifications, pendingVerifications.');

  await migrateUsers(writer, summary);
  await migratePlayers(writer, summary);
  await migrateAdminNotes(writer, summary);
  await migrateSupportData(writer, summary);
  await migrateFlatCollection({ sourcePath: 'applications', writer, summary });
  await migrateFlatCollection({ sourcePath: 'blacklist', writer, summary });
  await migrateFlatCollection({ sourcePath: 'banWaves', writer, summary });
  await migrateFlatCollection({ sourcePath: 'altReports', writer, summary });
  await migrateFlatCollection({ sourcePath: 'judgmentDay', writer, summary });
  await migrateFlatCollection({ sourcePath: 'whitelistedServers', writer, summary });
  await migrateFlatCollection({ sourcePath: 'adminAuditLog', writer, summary });
  await migrateFlatCollection({ sourcePath: 'securityLogs', writer, summary });
  await migrateFlatCollection({ sourcePath: 'securityScores', writer, summary });
  await migrateStaffRoles(writer, summary);

  if (shouldIncludeMatchHistory) {
    await migrateArchivedMatches(writer, summary);
  }

  await writer.flush();

  logSection('Migration Summary');
  summary.forEach((entry) => {
    console.log(`${entry.label} -> ${entry.target}: ${entry.count}`);
  });

  console.log(`\nPlanned Firestore writes: ${writer.totalWrites}`);
  console.log(shouldExecute
    ? 'Firestore copy completed.'
    : 'Dry run complete. Re-run with --execute to perform the copy.');
}

main().catch((error) => {
  console.error('Migration failed:', error);
  process.exitCode = 1;
});
