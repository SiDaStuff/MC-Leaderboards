const admin = require('firebase-admin');

const AUTH_SESSION_COOKIE_NAME = 'mclb_session';
const AUTH_SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000;

function normalizeEmailAddress(email) {
  return String(email || '').trim().toLowerCase();
}

function getAltWhitelistEmailKey(email) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) return null;
  const encoded = Buffer.from(normalizedEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `email_${encoded}`;
}

function getFirestoreDb() {
  try {
    return admin.apps.length ? admin.firestore() : null;
  } catch (_error) {
    return null;
  }
}

function getFreshnessTimestamp(record) {
  if (!record || typeof record !== 'object') return 0;
  const candidates = [record.updatedAt, record.lastLoginAt, record.createdAt];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const asDate = new Date(candidate).getTime();
    if (!Number.isNaN(asDate) && asDate > 0) return asDate;
  }
  return 0;
}

async function getStoredUserProfile(db, userId) {
  const realtimeSnap = await db.ref(`users/${userId}`).once('value').catch(() => null);
  return realtimeSnap?.val?.() || null;
}

async function setStoredUserProfile(db, userId, profile) {
  const firestore = getFirestoreDb();
  const writes = [
    db.ref(`users/${userId}`).set(profile)
  ];

  if (firestore) {
    writes.push(firestore.collection('users').doc(userId).set(profile));
  }

  await Promise.allSettled(writes);
}

async function listStoredUsers(db) {
  const realtimeSnap = await db.ref('users').once('value').catch(() => null);
  return realtimeSnap?.val?.() || {};
}

async function isAltWhitelistedForEmail(db, email) {
  const normalizedEmail = normalizeEmailAddress(email);
  if (!normalizedEmail) return false;

  const emailKey = getAltWhitelistEmailKey(normalizedEmail);
  if (emailKey) {
    const directSnapshot = await db.ref(`altWhitelist/${emailKey}`).once('value').catch(() => null);
    if (directSnapshot?.exists?.()) return true;
  }

  const whitelistSnapshot = await db.ref('altWhitelist').once('value').catch(() => null);
  const whitelist = whitelistSnapshot?.val?.() || {};
  return Object.values(whitelist).some((entry) => normalizeEmailAddress(entry?.email) === normalizedEmail);
}

async function ensureUserProfileExists(db, user, {
  clientIP = 'unknown',
  existingProfile = null
} = {}) {
  if (!user?.uid) {
    throw new Error('Authenticated user is required to ensure a profile exists');
  }

  if (existingProfile) {
    return existingProfile;
  }

  const storedProfile = await getStoredUserProfile(db, user.uid);
  if (storedProfile) {
    return storedProfile;
  }

  const now = new Date().toISOString();
  const safeClientIP = clientIP || 'unknown';
  const profile = {
    email: user.email || null,
    firebaseUid: user.uid,
    createdAt: now,
    updatedAt: now,
    minecraftUsername: null,
    minecraftVerified: false,
    onboardingCompleted: false,
    stayInQueueAfterMatch: false,
    ipAddresses: safeClientIP === 'unknown' ? [] : [safeClientIP],
    lastLoginAt: now,
    lastLoginIP: safeClientIP,
    securitySettings: {
      requireVerifiedEmailForSensitiveActions: false,
      requireVerifiedEmailForLogin: false
    }
  };

  await setStoredUserProfile(db, user.uid, profile);
  return profile;
}

async function assertRegistrationAllowed(db, {
  firebaseUid = null,
  email = null,
  clientIP = 'unknown',
  age = null
} = {}) {
  if (!age || typeof age !== 'number' || age < 13) {
    const error = new Error('You must be at least 13 years old to use this service');
    error.status = 400;
    error.code = 'AGE_VERIFICATION_FAILED';
    throw error;
  }

  const uidWhitelisted = firebaseUid
    ? (await db.ref(`altWhitelist/${firebaseUid}`).once('value').catch(() => null))?.exists?.() === true
    : false;
  const emailWhitelisted = await isAltWhitelistedForEmail(db, email);
  if (uidWhitelisted || emailWhitelisted) {
    return;
  }

  if (clientIP && clientIP !== 'unknown') {
    const allUsersData = await listStoredUsers(db);
    for (const [existingUid, userData] of Object.entries(allUsersData)) {
      if (firebaseUid && existingUid === firebaseUid) continue;
      const userIPs = Array.isArray(userData.ipAddresses) ? userData.ipAddresses : [];
      if (userIPs.includes(clientIP)) {
        const error = new Error('An account is already registered from this network. Multiple accounts are not permitted.');
        error.status = 409;
        error.code = 'DUPLICATE_IP_DETECTED';
        throw error;
      }
    }
  }
}

function setAuthSessionCookie(res, sessionCookie, { nodeEnv = 'development' } = {}) {
  const isProduction = nodeEnv === 'production';
  res.cookie(AUTH_SESSION_COOKIE_NAME, sessionCookie, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: AUTH_SESSION_DURATION_MS
  });
}

function clearAuthSessionCookie(res, { nodeEnv = 'development' } = {}) {
  const isProduction = nodeEnv === 'production';
  res.clearCookie(AUTH_SESSION_COOKIE_NAME, {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/'
  });
}

module.exports = {
  AUTH_SESSION_COOKIE_NAME,
  AUTH_SESSION_DURATION_MS,
  normalizeEmailAddress,
  getAltWhitelistEmailKey,
  isAltWhitelistedForEmail,
  ensureUserProfileExists,
  assertRegistrationAllowed,
  setAuthSessionCookie,
  clearAuthSessionCookie
};
