const {
  MATCH_RETENTION_DAYS,
  MATCH_CLEANUP_BATCH_SIZE,
  getMatchRetentionCutoffIso,
  isMatchRetentionCleanupCandidate
} = require('./match-retention');

const BLACKLIST_MATCH_CHECK_INTERVAL_MS = 30 * 1000;
const MISSED_TIMEOUT_CHECK_INTERVAL_MS = 2 * 60 * 1000;
const SECURITY_MONITOR_INTERVAL_MS = 15 * 60 * 1000;
const FORTY_EIGHT_HOURS_MS = 48 * 60 * 60 * 1000;
const MATCH_CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const SECURITY_LOG_RETENTION_DAYS = 30;
const AUDIT_LOG_RETENTION_DAYS = 90;
const MAX_SECURITY_ACCOUNTS_PER_RUN = 25;

function createLockedInterval(intervals, intervalMs, state, key, task) {
  const timer = setInterval(async () => {
    if (state[key]) {
      return;
    }

    state[key] = true;
    try {
      await task();
    } finally {
      state[key] = false;
    }
  }, intervalMs);

  intervals.push(timer);
  return timer;
}

async function deleteOldRealtimeEntries(db, path, childKey, cutoffIso, limit) {
  const snapshot = await db.ref(path)
    .orderByChild(childKey)
    .endAt(cutoffIso)
    .limitToFirst(limit)
    .once('value');

  const updates = {};
  snapshot.forEach((child) => {
    updates[child.key] = null;
  });

  const deletedCount = Object.keys(updates).length;
  if (deletedCount > 0) {
    await db.ref(path).update(updates);
  }

  return deletedCount;
}

async function runBoundedSecurityMonitoring({
  db,
  logger,
  detectAccountAnomalies,
  checkAndFlagSuspiciousAccount
}) {
  logger.info('[SECURITY] Running bounded periodic security monitoring...');

  const users = (await db.ref('users').once('value')).val() || {};
  const now = Date.now();
  const oneDayAgo = now - (24 * 60 * 60 * 1000);

  const candidates = Object.entries(users)
    .filter(([, userData]) => {
      if (!userData || userData.flaggedForReview) return false;
      const lastActivity = userData.lastActivityAt ? new Date(userData.lastActivityAt).getTime() : 0;
      return lastActivity >= oneDayAgo;
    })
    .sort((a, b) => {
      const aTimestamp = new Date(a[1]?.lastActivityAt || 0).getTime();
      const bTimestamp = new Date(b[1]?.lastActivityAt || 0).getTime();
      return bTimestamp - aTimestamp;
    })
    .slice(0, MAX_SECURITY_ACCOUNTS_PER_RUN);

  let checkedCount = 0;
  let flaggedCount = 0;

  for (const [userId, userData] of candidates) {
    const activityCount = Array.isArray(userData.activityLog) ? userData.activityLog.length : 0;
    const ipCount = Array.isArray(userData.ipAddresses) ? new Set(userData.ipAddresses).size : 0;
    const hasRiskSignals = activityCount > 35 || ipCount > 3;
    if (!hasRiskSignals) continue;

    checkedCount += 1;
    const anomalyCheck = await detectAccountAnomalies(userId);
    if (anomalyCheck.suspicious && anomalyCheck.severity === 'high') {
      const flagCheck = await checkAndFlagSuspiciousAccount(userId);
      if (flagCheck.flagged) {
        flaggedCount += 1;
      }
    }
  }

  logger.info(`[SECURITY] Bounded check complete: candidates=${candidates.length}, deepChecked=${checkedCount}, flagged=${flaggedCount}`);
}

async function runLightweightMaintenance({
  db,
  logger,
  cleanupRetiredNotificationData,
  createRealtimeDatabaseFirestoreBackup
}) {
  logger.info('[MAINTENANCE] Running lightweight 48h Firebase maintenance...');
  await cleanupRetiredNotificationData();

  const backupResult = await createRealtimeDatabaseFirestoreBackup('scheduled');
  logger.info(`[MAINTENANCE] RTDB backup stored in Firestore as ${backupResult.backupId}`);

  try {
    const securityLogCutoffIso = new Date(Date.now() - SECURITY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prunedSecurityLogs = await deleteOldRealtimeEntries(db, 'securityLogs', 'detectedAt', securityLogCutoffIso, 500);
    if (prunedSecurityLogs > 0) {
      logger.info(`[MAINTENANCE] Pruned ${prunedSecurityLogs} old security logs`);
    }
  } catch (error) {
    logger.error('[MAINTENANCE] Security log cleanup error:', error);
  }

  try {
    const auditLogCutoffIso = new Date(Date.now() - AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const prunedAuditLogs = await deleteOldRealtimeEntries(db, 'adminAuditLog', 'timestamp', auditLogCutoffIso, 500);
    if (prunedAuditLogs > 0) {
      logger.info(`[MAINTENANCE] Pruned ${prunedAuditLogs} old audit logs`);
    }
  } catch (error) {
    logger.error('[MAINTENANCE] Audit log cleanup error:', error);
  }
}

async function cleanupRetainedMatches({ db, logger }) {
  const retentionCutoffIso = getMatchRetentionCutoffIso();
  const matches = (await db.ref('matches')
    .orderByChild('finalizedAt')
    .endAt(retentionCutoffIso)
    .limitToFirst(MATCH_CLEANUP_BATCH_SIZE)
    .once('value'))
    .val() || {};

  let deletedCount = 0;
  for (const [matchId, match] of Object.entries(matches)) {
    if (!isMatchRetentionCleanupCandidate(match)) {
      continue;
    }

    await db.ref(`matches/${matchId}`).remove();
    deletedCount += 1;
  }

  if (deletedCount > 0) {
    logger.info(`[CLEANUP] Deleted ${deletedCount} matches older than ${MATCH_RETENTION_DAYS} days`);
  }
}

function registerMaintenanceJobs({
  db,
  logger,
  checkMissedTimeouts,
  checkAndTerminateBlacklistedMatches,
  detectAccountAnomalies,
  checkAndFlagSuspiciousAccount,
  cleanupExpiredPlusSubscriptions,
  cleanupRetiredNotificationData,
  createRealtimeDatabaseFirestoreBackup
}) {
  const intervals = [];
  const jobState = {
    blacklistMatches: false,
    missedTimeouts: false,
    securityMonitor: false,
    maintenance: false
  };

  createLockedInterval(intervals, BLACKLIST_MATCH_CHECK_INTERVAL_MS, jobState, 'blacklistMatches', async () => {
    try {
      await checkAndTerminateBlacklistedMatches();
    } catch (error) {
      logger.error('Error in periodic blacklist match check:', error);
    }
  });

  createLockedInterval(intervals, MISSED_TIMEOUT_CHECK_INTERVAL_MS, jobState, 'missedTimeouts', async () => {
    try {
      await checkMissedTimeouts();
    } catch (error) {
      logger.error('Error in periodic timeout check:', error);
    }
  });

  createLockedInterval(intervals, SECURITY_MONITOR_INTERVAL_MS, jobState, 'securityMonitor', async () => {
    try {
      await runBoundedSecurityMonitoring({
        db,
        logger,
        detectAccountAnomalies,
        checkAndFlagSuspiciousAccount
      });
    } catch (error) {
      logger.error('Error in periodic account security monitoring:', error);
    }
  });

  intervals.push(setInterval(async () => {
    try {
      logger.info('[PLUS] Running 48h expiry cleanup...');
      await cleanupExpiredPlusSubscriptions();
    } catch (error) {
      logger.error('Error in Plus expiry cleanup:', error);
    }
  }, FORTY_EIGHT_HOURS_MS));

  createLockedInterval(intervals, FORTY_EIGHT_HOURS_MS, jobState, 'maintenance', async () => {
    try {
      await runLightweightMaintenance({
        db,
        logger,
        cleanupRetiredNotificationData,
        createRealtimeDatabaseFirestoreBackup
      });
    } catch (error) {
      logger.error('Error in 48h Firebase maintenance:', error);
    }
  });

  intervals.push(setInterval(async () => {
    try {
      await cleanupRetainedMatches({ db, logger });
    } catch (error) {
      logger.error('Error in match cleanup:', error);
    }
  }, MATCH_CLEANUP_INTERVAL_MS));

  return intervals;
}

module.exports = {
  registerMaintenanceJobs
};
