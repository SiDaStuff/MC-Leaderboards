// MC Leaderboards - Cleanup Old Matches Script
// Removes matches older than the shared retention window
// Runs every 2 weeks

const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('../config');
const {
  MATCH_RETENTION_DAYS,
  isMatchRetentionCleanupCandidate
} = require('../services/match-retention');

const CLEANUP_INTERVAL_MS = 14 * 24 * 60 * 60 * 1000;

const { serviceAccount, config } = loadRuntimeConfig();

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: config.databaseURL
});

const db = admin.database();

function isCredentialMisconfigurationError(error) {
  const message = String(error?.message || '').toLowerCase();
  return message.includes('invalid') && message.includes('credential')
    || message.includes('permission_denied')
    || message.includes('unauthorized')
    || message.includes('auth');
}

async function verifyFirebaseAccess() {
  try {
    // Lightweight read to validate credential/databaseURL pairing before scheduling loops.
    await db.ref('.info/connected').once('value');
  } catch (error) {
    if (isCredentialMisconfigurationError(error)) {
      throw new Error(
        `Firebase authentication failed for cleanup job. Verify FIREBASE_SERVICE_ACCOUNT_PATH/key.json belongs to the same project as DATABASE_URL. Original error: ${error.message}`
      );
    }
    throw error;
  }
}

async function cleanupMatches() {
  console.log(`Starting cleanup of matches older than ${MATCH_RETENTION_DAYS} days...`);

  try {
    const matchesRef = db.ref('matches');
    const matches = (await matchesRef.once('value')).val() || {};
    let cleaned = 0;

    for (const [matchId, match] of Object.entries(matches)) {
      if (!isMatchRetentionCleanupCandidate(match)) {
        continue;
      }

      await matchesRef.child(matchId).remove();
      cleaned += 1;
      console.log(`  Removed match: ${matchId} (${match?.status || 'unknown'})`);
    }

    console.log(`Cleanup completed. Removed ${cleaned} matches past ${MATCH_RETENTION_DAYS} days.`);
    return cleaned;
  } catch (error) {
    console.error('Error cleaning up matches:', error);
    throw error;
  }
}

async function cleanupExpiredTesterAvailabilities() {
  console.log('Starting cleanup of expired tier tester availabilities...');

  try {
    const availabilityRef = db.ref('testerAvailability');
    const availabilities = (await availabilityRef.once('value')).val() || {};
    const now = new Date();
    let cleaned = 0;

    for (const [userId, availability] of Object.entries(availabilities)) {
      if (!availability?.timeoutAt) {
        continue;
      }

      const timeoutAt = new Date(availability.timeoutAt);
      if (timeoutAt >= now) {
        continue;
      }

      await availabilityRef.child(userId).remove();
      cleaned += 1;
      console.log(`  Removed expired availability for user: ${userId} (timed out at: ${availability.timeoutAt})`);
    }

    console.log(`Tester availability cleanup completed. Removed ${cleaned} expired availabilities.`);
    return cleaned;
  } catch (error) {
    console.error('Error cleaning up tester availabilities:', error);
    throw error;
  }
}

async function runCleanupPass() {
  await cleanupMatches();
  await cleanupExpiredTesterAvailabilities();
}

async function startScheduledCleanup() {
  console.log(`Starting scheduled match cleanup (match retention: ${MATCH_RETENTION_DAYS} days, runs every 2 weeks)...`);

  await verifyFirebaseAccess();

  try {
    await runCleanupPass();
  } catch (error) {
    console.error('Initial cleanup failed:', error);
  }

  setInterval(async () => {
    console.log(`Running scheduled cleanup at ${new Date().toISOString()}`);
    try {
      await runCleanupPass();
    } catch (error) {
      console.error('Scheduled cleanup failed:', error);
      if (isCredentialMisconfigurationError(error)) {
        console.error('Fatal Firebase credential/databaseURL mismatch detected. Exiting cleanup process.');
        process.exit(1);
      }
    }
  }, CLEANUP_INTERVAL_MS);

  console.log(`Scheduled cleanup initialized. Next run in ${Math.round(CLEANUP_INTERVAL_MS / (1000 * 60 * 60))} hours.`);
}

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

startScheduledCleanup().catch((error) => {
  console.error('Failed to start scheduled cleanup:', error);
  process.exit(1);
});
