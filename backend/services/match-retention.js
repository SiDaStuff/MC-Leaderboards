const MATCH_RETENTION_DAYS = 60;
const MATCH_RETENTION_MS = MATCH_RETENTION_DAYS * 24 * 60 * 60 * 1000;
const MATCH_CLEANUP_BATCH_SIZE = 100;

function parseTimestampMs(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function getMatchRetentionCutoffDate(now = Date.now()) {
  return new Date(Number(now) - MATCH_RETENTION_MS);
}

function getMatchRetentionCutoffIso(now = Date.now()) {
  return getMatchRetentionCutoffDate(now).toISOString();
}

function isMatchRetentionCleanupCandidate(match = {}, now = Date.now()) {
  if (!match || typeof match !== 'object') {
    return false;
  }

  const cutoffMs = Number(now) - MATCH_RETENTION_MS;
  const status = String(match.status || '').toLowerCase();
  const finalizedLike = match.finalized === true
    || status === 'cancelled'
    || status === 'ended'
    || match.deletedDueToInactivity === true;

  if (finalizedLike) {
    const finalizedAtMs = parseTimestampMs(match.finalizedAt)
      ?? parseTimestampMs(match.endedAt)
      ?? parseTimestampMs(match.updatedAt)
      ?? parseTimestampMs(match.createdAt);
    return finalizedAtMs !== null && finalizedAtMs <= cutoffMs;
  }

  const createdAtMs = parseTimestampMs(match.createdAt);
  return createdAtMs !== null && createdAtMs <= cutoffMs;
}

module.exports = {
  MATCH_RETENTION_DAYS,
  MATCH_RETENTION_MS,
  MATCH_CLEANUP_BATCH_SIZE,
  getMatchRetentionCutoffDate,
  getMatchRetentionCutoffIso,
  isMatchRetentionCleanupCandidate
};
