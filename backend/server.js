// MC Leaderboards - Backend Server
// Express.js API server with Firebase Admin SDK

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');
const slowDown = require('express-slow-down');
const compression = require('compression');
const https = require('https');
const util = require('util');
const crypto = require('crypto');

// Initialize Firebase Admin
const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('./config');
const logger = require('./logger');
const {
  AUTH_SESSION_COOKIE_NAME,
  ensureUserProfileExists: baseEnsureUserProfileExists,
  getAltWhitelistEmailKey,
  isAltWhitelistedForEmail,
  setAuthSessionCookie: applyAuthSessionCookie,
  clearAuthSessionCookie: removeAuthSessionCookie
} = require('./services/auth-service');
const { registerMaintenanceJobs } = require('./services/maintenance-service');
const { registerAuthRoutes } = require('./routes/auth-routes');

// Server-side configuration
const CONFIG = {
  GAMEMODES: [
    { id: 'overall', name: 'Overall', icon: 'assets/overall.svg' },
    { id: 'vanilla', name: 'Vanilla', icon: 'assets/vanilla.svg' },
    { id: 'uhc', name: 'UHC', icon: 'assets/uhc.svg' },
    { id: 'pot', name: 'Pot', icon: 'assets/pot.svg' },
    { id: 'nethop', name: 'NethOP', icon: 'assets/nethop.svg' },
    { id: 'smp', name: 'SMP', icon: 'assets/smp.svg' },
    { id: 'sword', name: 'Sword', icon: 'assets/sword.svg' },
    { id: 'axe', name: 'Axe', icon: 'assets/axe.svg' },
    { id: 'mace', name: 'Mace', icon: 'assets/mace.svg' }
  ],
  TITLES: [
    { minRating: 0, title: 'Rookie', color: '#6c7178', icon: 'assets/badgeicons/rookie.svg' },
    { minRating: 300, title: 'Combat Novice', color: '#9291d9', icon: 'assets/badgeicons/combat_novice.svg' },
    { minRating: 500, title: 'Combat Cadet', color: '#9291d9', icon: 'assets/badgeicons/combat_cadet.svg' },
    { minRating: 1000, title: 'Combat Specialist', color: '#ad78d8', icon: 'assets/badgeicons/combat_specialist.svg' },
    { minRating: 1300, title: 'Combat Ace', color: '#cd285c', icon: 'assets/badgeicons/combat_ace.svg' },
    { minRating: 1500, title: 'Combat Master', color: '#FF5722', icon: 'assets/badgeicons/combat_master.webp' },
    { minRating: 2000, title: 'Combat Grandmaster', color: '#FFD700', icon: 'assets/badgeicons/combat_grandmaster.webp' }
  ],
  // First-to values for each gamemode
  FIRST_TO: {
    sword: 6,
    axe: 10,
    nethop: 3,
    pot: 5,
    smp: 2,
    uhc: 4,
    vanilla: 3,
    mace: 3
  }
};

function getFirstToForGamemode(gamemode) {
  return CONFIG.FIRST_TO[gamemode] || 3;
}

let runtimeConfig;

try {
  runtimeConfig = loadRuntimeConfig();
} catch (error) {
  logger.error('Backend configuration is invalid', { error });
  process.exit(1);
}

const { serviceAccount, config, credentialsSource } = runtimeConfig;
const PLUGIN_API_KEY = config.pluginApiKey;
const RECAPTCHA_TRUST_COOKIE = 'mclb_recaptcha_trust';
const RECAPTCHA_TRUST_WINDOW_MS = 24 * 60 * 60 * 1000;

function getRecaptchaTrustSecret() {
  return String(config.recaptchaSecretKey || config.jwtSecret || 'mclb-recaptcha-trust-development-secret');
}

function signRecaptchaTrustExpiry(expiresAtMs) {
  return crypto
    .createHmac('sha256', getRecaptchaTrustSecret())
    .update(String(expiresAtMs))
    .digest('base64url');
}

function buildRecaptchaTrustCookieValue(expiresAtMs) {
  return `${expiresAtMs}.${signRecaptchaTrustExpiry(expiresAtMs)}`;
}

function getTrustedRecaptchaExpiry(req) {
  const value = String(parseRequestCookies(req)[RECAPTCHA_TRUST_COOKIE] || '').trim();
  const [expiresRaw, signature] = value.split('.');
  const expiresAtMs = Number(expiresRaw);
  if (!Number.isFinite(expiresAtMs) || !signature || expiresAtMs <= Date.now()) {
    return 0;
  }

  const expectedSignature = signRecaptchaTrustExpiry(expiresAtMs);
  const left = Buffer.from(signature);
  const right = Buffer.from(expectedSignature);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
    return 0;
  }
  return expiresAtMs;
}

function setRecaptchaTrustCookie(res) {
  const expiresAtMs = Date.now() + RECAPTCHA_TRUST_WINDOW_MS;
  const cookieValue = buildRecaptchaTrustCookieValue(expiresAtMs);
  const maxAge = Math.floor(RECAPTCHA_TRUST_WINDOW_MS / 1000);
  const secure = config.nodeEnv === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${RECAPTCHA_TRUST_COOKIE}=${encodeURIComponent(cookieValue)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`);
  res.setHeader('X-Recaptcha-Trusted-Until', String(expiresAtMs));
}

function formatLegacyLogArgs(args) {
  return args.map((value) => {
    if (typeof value === 'string') {
      return value;
    }

    return util.inspect(value, { depth: 4, breakLength: Infinity, compact: true });
  }).join(' ');
}

if (!PLUGIN_API_KEY) {
  logger.error('Plugin API key is not configured', {
    expectedSources: ['PLUGIN_API_KEY', 'plugin_api_key']
  });
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.databaseURL
  });
  logger.info('Firebase Admin initialized', {
    projectId: serviceAccount.project_id,
    databaseURL: config.databaseURL,
    credentialsSource
  });
} catch (error) {
  logger.error('Failed to initialize Firebase Admin SDK', { error });
  process.exit(1);
}

console.log = (...args) => logger.info(formatLegacyLogArgs(args));
console.warn = (...args) => logger.warn(formatLegacyLogArgs(args));
console.error = (...args) => logger.error(formatLegacyLogArgs(args));

const db = admin.database();
const realtimeDbRef = db.ref.bind(db);

function ensureUserProfileExists(user, options = {}) {
  return baseEnsureUserProfileExists(db, user, options);
}

// Initialize Firestore for scalable/large storage (security scores, match metrics)
let fsdb = null;
try {
  fsdb = admin.firestore();
  logger.info('Firestore initialized');
} catch (err) {
  logger.warn('Firestore initialization failed; security features will use RTDB fallback', { error: err });
}

/**
 * Safe Firestore write wrapper – never throws, logs on failure
 */
async function fsWrite(docPath, data, merge = true) {
  if (!fsdb) return false;
  try {
    const docRef = getFirestoreDocRef(docPath);
    if (merge) {
      await docRef.set(sanitizeFirebaseValue(data), { merge: true });
    } else {
      await docRef.set(sanitizeFirebaseValue(data));
    }
    return true;
  } catch (err) {
    logger.error('Firestore write failed', { docPath, error: err });
    return false;
  }
}

/**
 * Safe Firestore read wrapper – returns null on failure
 */
async function fsRead(docPath) {
  if (!fsdb) return null;
  try {
    const snap = await getFirestoreDocRef(docPath).get();
    return snap.exists ? snap.data() : null;
  } catch (err) {
    logger.error('Firestore read failed', { docPath, error: err });
    return null;
  }
}

function getFirestoreDocRef(docPath) {
  if (!fsdb) throw new Error('Firestore not initialized');
  const segments = String(docPath || '').split('/').filter(Boolean);
  if (segments.length < 2 || segments.length % 2 !== 0) {
    throw new Error(`Invalid Firestore document path: ${docPath}`);
  }

  let ref = fsdb.collection(segments[0]).doc(segments[1]);
  for (let index = 2; index < segments.length; index += 2) {
    ref = ref.collection(segments[index]).doc(segments[index + 1]);
  }
  return ref;
}

function getFirestoreCollectionRef(collectionPath) {
  if (!fsdb) throw new Error('Firestore not initialized');
  const segments = String(collectionPath || '').split('/').filter(Boolean);
  if (segments.length < 1 || segments.length % 2 === 0) {
    throw new Error(`Invalid Firestore collection path: ${collectionPath}`);
  }

  let ref = fsdb.collection(segments[0]);
  for (let index = 1; index < segments.length; index += 2) {
    ref = ref.doc(segments[index]).collection(segments[index + 1]);
  }
  return ref;
}

async function fsDelete(docPath) {
  if (!fsdb) return false;
  try {
    await getFirestoreDocRef(docPath).delete();
    return true;
  } catch (err) {
    logger.error('Firestore delete failed', { docPath, error: err });
    return false;
  }
}

async function fsList(collectionPath, { filters = [], orderByField = null, direction = 'asc', limit = null } = {}) {
  if (!fsdb) return [];
  try {
    let query = getFirestoreCollectionRef(collectionPath);

    filters.forEach((filter) => {
      if (!filter || !filter.field) return;
      query = query.where(filter.field, filter.op || '==', filter.value);
    });

    if (orderByField) {
      query = query.orderBy(orderByField, direction);
    }

    if (Number.isFinite(limit) && limit > 0) {
      query = query.limit(limit);
    }

    const snapshot = await query.get();
    return snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (err) {
    logger.error('Firestore collection read failed', { collectionPath, error: err });
    return [];
  }
}

async function fsCreate(collectionPath, data, preferredId = null) {
  if (!fsdb) return null;
  try {
    const collectionRef = getFirestoreCollectionRef(collectionPath);
    const docRef = preferredId ? collectionRef.doc(preferredId) : collectionRef.doc();
    const payload = sanitizeFirebaseValue({
      ...(data || {}),
      id: preferredId || data?.id || docRef.id
    });
    await docRef.set(payload);
    return payload;
  } catch (err) {
    logger.error('Firestore create failed', { collectionPath, error: err });
    return null;
  }
}

async function deleteFirestoreCollection(collectionPath) {
  if (!fsdb) return false;
  try {
    const docs = await getFirestoreCollectionRef(collectionPath).get();
    if (docs.empty) return true;

    let batch = fsdb.batch();
    let operations = 0;

    for (const doc of docs.docs) {
      batch.delete(doc.ref);
      operations += 1;
      if (operations >= 400) {
        await batch.commit();
        batch = fsdb.batch();
        operations = 0;
      }
    }

    if (operations > 0) {
      await batch.commit();
    }
    return true;
  } catch (err) {
    logger.error('Firestore subcollection delete failed', { collectionPath, error: err });
    return false;
  }
}

function getRecordFreshnessTimestamp(record) {
  if (!record || typeof record !== 'object') return 0;
  const candidates = [
    record.updatedAt,
    record.lastMessageAt,
    record.lastComputed,
    record.detectedAt,
    record.timestamp,
    record.at,
    record.closedAt,
    record.createdAt,
    record.warnedAt
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    const asDate = new Date(candidate).getTime();
    if (!Number.isNaN(asDate) && asDate > 0) return asDate;
    if (typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0) return candidate;
  }

  return 0;
}

function chooseFresherRecord(firestoreRecord, realtimeRecord) {
  if (firestoreRecord && !realtimeRecord) return { source: 'firestore', record: firestoreRecord };
  if (!firestoreRecord && realtimeRecord) return { source: 'rtdb', record: realtimeRecord };
  if (!firestoreRecord && !realtimeRecord) return { source: null, record: null };

  const firestoreTimestamp = getRecordFreshnessTimestamp(firestoreRecord);
  const realtimeTimestamp = getRecordFreshnessTimestamp(realtimeRecord);
  return realtimeTimestamp > firestoreTimestamp
    ? { source: 'rtdb', record: realtimeRecord }
    : { source: 'firestore', record: firestoreRecord };
}

async function getStoredUserProfile(userId, { syncFallback = false } = {}) {
  if (!userId) return null;

  if (!global.__mclbUserProfileCache) {
    global.__mclbUserProfileCache = new Map();
  }

  const USER_PROFILE_TTL_MS = 10000;
  const now = Date.now();
  const cachedEntry = global.__mclbUserProfileCache.get(userId);

  if (cachedEntry?.value !== undefined && (now - cachedEntry.updatedAt) < USER_PROFILE_TTL_MS) {
    return cloneStoredPlayersValue(cachedEntry.value) || null;
  }

  if (cachedEntry?.promise) {
    return cloneStoredPlayersValue(await cachedEntry.promise) || null;
  }

  const loadPromise = realtimeDbRef(`users/${userId}`).once('value')
    .then((snapshot) => sanitizeFirebaseValue(snapshot?.val?.() || null))
    .catch(() => null);

  global.__mclbUserProfileCache.set(userId, {
    value: cachedEntry?.value,
    updatedAt: cachedEntry?.updatedAt || 0,
    promise: loadPromise
  });

  try {
    const profile = await loadPromise;
    global.__mclbUserProfileCache.set(userId, {
      value: profile,
      updatedAt: Date.now(),
      promise: null
    });

    if (syncFallback && profile && fsdb) {
      void fsWrite(`users/${userId}`, profile, false);
    }

    return cloneStoredPlayersValue(profile) || null;
  } finally {
    const latest = global.__mclbUserProfileCache.get(userId);
    if (latest?.promise === loadPromise) {
      global.__mclbUserProfileCache.set(userId, {
        value: latest.value,
        updatedAt: latest.updatedAt,
        promise: null
      });
    }
  }
}

async function setStoredUserProfile(userId, profile, { merge = false } = {}) {
  if (!userId) return false;
  const safeProfile = sanitizeFirebaseValue(profile || {});
  const writes = [
    merge ? db.ref(`users/${userId}`).update(safeProfile) : db.ref(`users/${userId}`).set(safeProfile)
  ];

  if (fsdb) {
    writes.push(fsWrite(`users/${userId}`, safeProfile, merge));
  }

  const results = await Promise.allSettled(writes);
  if (global.__mclbUserProfileCache) {
    global.__mclbUserProfileCache.delete(userId);
  }
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function deleteStoredUserProfile(userId) {
  if (!userId) return false;
  const results = await Promise.allSettled([
    db.ref(`users/${userId}`).remove(),
    fsDelete(`users/${userId}`)
  ]);
  if (global.__mclbUserProfileCache) {
    global.__mclbUserProfileCache.delete(userId);
  }
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

const storedPlayersState = {
  map: null,
  updatedAt: 0,
  promise: null,
  TTL: 5000
};

function cloneStoredPlayersValue(value) {
  if (value === undefined) return undefined;
  return sanitizeFirebaseValue(value);
}

function hasSnapshotValue(value) {
  if (value === null || value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function createStoredPlayersSnapshot(value) {
  return {
    val: () => cloneStoredPlayersValue(value),
    exists: () => hasSnapshotValue(value)
  };
}

function getPlayerFieldValue(player, fieldPath) {
  return String(fieldPath || '')
    .split('.')
    .filter(Boolean)
    .reduce((currentValue, segment) => (currentValue == null ? undefined : currentValue[segment]), player);
}

function setNestedPlayerValue(target, segments, value) {
  if (!segments.length) return;
  let cursor = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!cursor[segment] || typeof cursor[segment] !== 'object' || Array.isArray(cursor[segment])) {
      cursor[segment] = {};
    }
    cursor = cursor[segment];
  }
  cursor[segments[segments.length - 1]] = value;
}

function invalidateStoredPlayersState() {
  storedPlayersState.map = null;
  storedPlayersState.updatedAt = 0;
  storedPlayersState.promise = null;
}

function invalidatePlayersCache() {
  invalidateStoredPlayersState();
  playersCache.data = null;
  playersCache.updatedAt = 0;
}

async function getFirestorePlayersMap() {
  if (!fsdb) return {};
  const players = await fsList('players');
  return players.reduce((accumulator, entry) => {
    if (!entry?.id) return accumulator;
    const { id, ...playerData } = entry;
    accumulator[id] = playerData;
    return accumulator;
  }, {});
}

function mergeStoredPlayersMaps(firestorePlayers, realtimePlayers) {
  const merged = {};
  const playerIds = new Set([
    ...Object.keys(firestorePlayers || {}),
    ...Object.keys(realtimePlayers || {})
  ]);

  playerIds.forEach((playerId) => {
    const selected = chooseFresherRecord(firestorePlayers?.[playerId] || null, realtimePlayers?.[playerId] || null);
    if (selected.record) {
      merged[playerId] = selected.record;
    }
  });

  return merged;
}

async function loadStoredPlayersMap({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && storedPlayersState.map && (now - storedPlayersState.updatedAt) < storedPlayersState.TTL) {
    return cloneStoredPlayersValue(storedPlayersState.map) || {};
  }

  if (!forceRefresh && storedPlayersState.promise) {
    const pendingPlayers = await storedPlayersState.promise;
    return cloneStoredPlayersValue(pendingPlayers) || {};
  }

  storedPlayersState.promise = (async () => {
    const realtimeSnapshot = await realtimeDbRef('players').once('value').catch(() => null);
    const realtimePlayers = realtimeSnapshot?.val?.() || {};
    storedPlayersState.map = realtimePlayers;
    storedPlayersState.updatedAt = Date.now();
    return realtimePlayers;
  })();

  try {
    const players = await storedPlayersState.promise;
    return cloneStoredPlayersValue(players) || {};
  } finally {
    storedPlayersState.promise = null;
  }
}

async function getStoredPlayerById(playerId, { syncFallback = false } = {}) {
  if (!playerId) return null;
  const realtimeSnapshot = await realtimeDbRef(`players/${playerId}`).once('value').catch(() => null);
  const realtimePlayer = realtimeSnapshot?.val?.() || null;

  if (syncFallback && realtimePlayer && fsdb) {
    void fsWrite(`players/${playerId}`, realtimePlayer, false);
  }

  return realtimePlayer ? sanitizeFirebaseValue(realtimePlayer) : null;
}

async function setStoredPlayerById(playerId, player, { merge = false } = {}) {
  if (!playerId) return false;
  const safePlayer = sanitizeFirebaseValue(player || {});
  const writes = [
    merge ? realtimeDbRef(`players/${playerId}`).update(safePlayer) : realtimeDbRef(`players/${playerId}`).set(safePlayer)
  ];

  if (fsdb) {
    writes.push(fsWrite(`players/${playerId}`, safePlayer, merge));
  }

  const results = await Promise.allSettled(writes);
  invalidatePlayersCache();
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function deleteStoredPlayerById(playerId) {
  if (!playerId) return false;
  const results = await Promise.allSettled([
    realtimeDbRef(`players/${playerId}`).remove(),
    fsDelete(`players/${playerId}`)
  ]);
  invalidatePlayersCache();
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function updateStoredPlayersBatch(updates = {}) {
  const safeUpdates = sanitizeFirebaseValue(updates || {});
  const groupedUpdates = new Map();

  Object.entries(safeUpdates).forEach(([path, value]) => {
    const segments = String(path || '').split('/').filter(Boolean);
    const [playerId, ...nestedPath] = segments;
    if (!playerId) return;

    if (!groupedUpdates.has(playerId)) {
      groupedUpdates.set(playerId, {});
    }

    if (nestedPath.length === 0) {
      groupedUpdates.set(playerId, value);
      return;
    }

    const currentValue = groupedUpdates.get(playerId);
    if (!currentValue || typeof currentValue !== 'object' || Array.isArray(currentValue)) {
      groupedUpdates.set(playerId, {});
    }
    setNestedPlayerValue(groupedUpdates.get(playerId), nestedPath, value);
  });

  const operations = Array.from(groupedUpdates.entries()).map(([playerId, value]) => (
    value === null
      ? deleteStoredPlayerById(playerId)
      : setStoredPlayerById(playerId, value, { merge: true })
  ));

  await Promise.all(operations);
  return true;
}

function attachPromiseToPlayerRef(ref, promise) {
  ref.then = promise.then.bind(promise);
  ref.catch = promise.catch.bind(promise);
  ref.finally = promise.finally.bind(promise);
  return ref;
}

class StoredPlayersRef {
  constructor({ playerId = null, orderByField = null, equalToValue = undefined, limitToFirstValue = null } = {}) {
    this.playerId = playerId;
    this.orderByField = orderByField;
    this.equalToValue = equalToValue;
    this.limitToFirstValue = limitToFirstValue;
  }

  get key() {
    return this.playerId || null;
  }

  child(playerId) {
    return new StoredPlayersRef({ playerId });
  }

  orderByChild(field) {
    return new StoredPlayersRef({
      playerId: this.playerId,
      orderByField: field,
      equalToValue: this.equalToValue,
      limitToFirstValue: this.limitToFirstValue
    });
  }

  equalTo(value) {
    return new StoredPlayersRef({
      playerId: this.playerId,
      orderByField: this.orderByField,
      equalToValue: value,
      limitToFirstValue: this.limitToFirstValue
    });
  }

  limitToFirst(limit) {
    return new StoredPlayersRef({
      playerId: this.playerId,
      orderByField: this.orderByField,
      equalToValue: this.equalToValue,
      limitToFirstValue: limit
    });
  }

  async once(eventType = 'value') {
    if (eventType !== 'value') {
      throw new Error(`StoredPlayersRef only supports once('value'), received "${eventType}"`);
    }

    if (this.playerId) {
      const player = await getStoredPlayerById(this.playerId);
      return createStoredPlayersSnapshot(player);
    }

    if (this.orderByField && this.equalToValue !== undefined) {
      let query = realtimeDbRef('players').orderByChild(this.orderByField).equalTo(this.equalToValue);
      if (Number.isFinite(this.limitToFirstValue) && this.limitToFirstValue > 0) {
        query = query.limitToFirst(this.limitToFirstValue);
      }
      const snapshot = await query.once('value').catch(() => null);
      return createStoredPlayersSnapshot(snapshot?.val?.() || null);
    }

    let entries = Object.entries(await loadStoredPlayersMap());

    if (this.orderByField) {
      entries = entries.sort(([leftId, leftPlayer], [rightId, rightPlayer]) => {
        const leftValue = getPlayerFieldValue(leftPlayer, this.orderByField);
        const rightValue = getPlayerFieldValue(rightPlayer, this.orderByField);
        if (leftValue === rightValue) return String(leftId).localeCompare(String(rightId));
        if (leftValue === undefined || leftValue === null) return 1;
        if (rightValue === undefined || rightValue === null) return -1;
        if (typeof leftValue === 'number' && typeof rightValue === 'number') return leftValue - rightValue;
        return String(leftValue).localeCompare(String(rightValue), undefined, { sensitivity: 'base' });
      });
    }

    if (this.equalToValue !== undefined && this.orderByField) {
      entries = entries.filter(([, player]) => getPlayerFieldValue(player, this.orderByField) === this.equalToValue);
    }

    if (Number.isFinite(this.limitToFirstValue) && this.limitToFirstValue > 0) {
      entries = entries.slice(0, this.limitToFirstValue);
    }

    return createStoredPlayersSnapshot(Object.fromEntries(entries));
  }

  async set(value) {
    if (!this.playerId) throw new Error('set() is only supported on individual player refs');
    return setStoredPlayerById(this.playerId, value, { merge: false });
  }

  async update(value) {
    if (this.playerId) {
      return setStoredPlayerById(this.playerId, value, { merge: true });
    }
    return updateStoredPlayersBatch(value);
  }

  async remove() {
    if (!this.playerId) throw new Error('remove() is only supported on individual player refs');
    return deleteStoredPlayerById(this.playerId);
  }

  push(value) {
    if (this.playerId) throw new Error('push() is only supported on the players collection root');
    const generatedKey = fsdb ? getFirestoreCollectionRef('players').doc().id : realtimeDbRef('players').push().key;
    const childRef = this.child(generatedKey);
    if (value === undefined) {
      return childRef;
    }
    const writePromise = childRef.set(value).then(() => childRef);
    return attachPromiseToPlayerRef(childRef, writePromise);
  }
}

function getPlayersStoreRef() {
  return new StoredPlayersRef();
}

db.ref = function patchedDatabaseRef(path) {
  const normalizedPath = String(path || '').replace(/^\/+/, '');
  if (normalizedPath === 'players') {
    return getPlayersStoreRef();
  }

  const playerPathMatch = normalizedPath.match(/^players\/([^/]+)$/);
  if (playerPathMatch) {
    return getPlayersStoreRef().child(playerPathMatch[1]);
  }

  return realtimeDbRef(path);
};

async function addUserModerationHistoryEntry(userId, entry) {
  if (!userId) return null;
  const historyId = fsdb
    ? getFirestoreCollectionRef(`users/${userId}/moderationHistory`).doc().id
    : db.ref(`users/${userId}/moderationHistory`).push().key;
  const payload = sanitizeFirebaseValue({ id: historyId, ...(entry || {}) });
  await Promise.allSettled([
    db.ref(`users/${userId}/moderationHistory/${historyId}`).set(payload),
    fsWrite(`users/${userId}/moderationHistory/${historyId}`, payload, false)
  ]);
  return payload;
}

async function listUserModerationHistoryEntries(userId) {
  if (!userId) return [];
  const [firestoreEntries, realtimeSnapshot] = await Promise.all([
    fsList(`users/${userId}/moderationHistory`),
    db.ref(`users/${userId}/moderationHistory`).once('value').catch(() => null)
  ]);

  const merged = new Map();
  firestoreEntries.forEach((entry) => merged.set(entry.id, entry));
  Object.entries(realtimeSnapshot?.val?.() || {}).forEach(([id, entry]) => {
    const selected = chooseFresherRecord(merged.get(id) || null, { id, ...(entry || {}) });
    if (selected.record) {
      merged.set(id, selected.record);
    }
  });

  return Array.from(merged.values());
}

async function deleteUserModerationHistoryEntries(userId) {
  if (!userId) return false;
  const results = await Promise.allSettled([
    db.ref(`users/${userId}/moderationHistory`).remove(),
    deleteFirestoreCollection(`users/${userId}/moderationHistory`)
  ]);
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function addAdminNoteEntry(userId, noteEntry) {
  if (!userId) return null;
  const noteId = fsdb
    ? getFirestoreCollectionRef(`users/${userId}/adminNotes`).doc().id
    : db.ref(`adminNotes/${userId}`).push().key;
  const payload = sanitizeFirebaseValue({ id: noteId, ...(noteEntry || {}) });
  await Promise.allSettled([
    db.ref(`adminNotes/${userId}/${noteId}`).set(payload),
    fsWrite(`users/${userId}/adminNotes/${noteId}`, payload, false)
  ]);
  return payload;
}

async function listAdminNoteEntries(userId) {
  if (!userId) return [];
  const [firestoreNotes, realtimeSnapshot] = await Promise.all([
    fsList(`users/${userId}/adminNotes`),
    db.ref(`adminNotes/${userId}`).once('value').catch(() => null)
  ]);

  const merged = new Map();
  firestoreNotes.forEach((note) => merged.set(note.id, note));
  Object.entries(realtimeSnapshot?.val?.() || {}).forEach(([id, note]) => {
    const selected = chooseFresherRecord(merged.get(id) || null, { id, ...(note || {}) });
    if (selected.record) {
      merged.set(id, selected.record);
    }
  });

  return Array.from(merged.values());
}

async function deleteAdminNoteEntries(userId) {
  if (!userId) return false;
  const results = await Promise.allSettled([
    db.ref(`adminNotes/${userId}`).remove(),
    deleteFirestoreCollection(`users/${userId}/adminNotes`)
  ]);
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function writeAuditLogEntry(entry) {
  const logId = String(entry?.id || Date.now());
  const payload = sanitizeFirebaseValue({ ...(entry || {}), id: logId });
  await Promise.allSettled([
    db.ref(`adminAuditLog/${logId}`).set(payload),
    fsWrite(`adminAuditLog/${logId}`, payload, false)
  ]);
  return payload;
}

async function listAuditLogEntries({ limit = 200 } = {}) {
  const [firestoreLogs, realtimeSnapshot] = await Promise.all([
    fsList('adminAuditLog', { orderByField: 'timestamp', direction: 'desc', limit }),
    db.ref('adminAuditLog').orderByChild('timestamp').limitToLast(limit).once('value').catch(() => null)
  ]);

  const merged = new Map();
  firestoreLogs.forEach((log) => merged.set(log.id, log));
  Object.entries(realtimeSnapshot?.val?.() || {}).forEach(([id, log]) => {
    const selected = chooseFresherRecord(merged.get(id) || null, { id, ...(log || {}) });
    if (selected.record) {
      merged.set(id, selected.record);
    }
  });

  return Array.from(merged.values()).sort((left, right) => parseDateToMs(right.timestamp) - parseDateToMs(left.timestamp));
}

async function addSecurityLogEntry(entry) {
  const logId = fsdb ? getFirestoreCollectionRef('securityLogs').doc().id : db.ref('securityLogs').push().key;
  const payload = sanitizeFirebaseValue({ id: logId, ...(entry || {}) });
  await Promise.allSettled([
    db.ref(`securityLogs/${logId}`).set(payload),
    fsWrite(`securityLogs/${logId}`, payload, false)
  ]);
  return payload;
}

async function listSecurityLogEntries({ limit = 100, userId = null } = {}) {
  const fetchLimit = Math.max(1, Number(limit) || 100);
  const firestoreLogs = userId
    ? await fsList('securityLogs', { filters: [{ field: 'userId', value: userId }], limit: Math.max(fetchLimit, 25) })
    : await fsList('securityLogs', { orderByField: 'detectedAt', direction: 'desc', limit: fetchLimit });
  const realtimeSnapshot = userId
    ? await db.ref('securityLogs').orderByChild('userId').equalTo(userId).once('value').catch(() => null)
    : await db.ref('securityLogs').orderByChild('detectedAt').limitToLast(fetchLimit).once('value').catch(() => null);

  const merged = new Map();
  firestoreLogs.forEach((log) => merged.set(log.id, log));
  Object.entries(realtimeSnapshot?.val?.() || {}).forEach(([id, log]) => {
    const selected = chooseFresherRecord(merged.get(id) || null, { id, ...(log || {}) });
    if (selected.record) {
      merged.set(id, selected.record);
    }
  });

  return Array.from(merged.values()).sort((left, right) => parseDateToMs(right.detectedAt) - parseDateToMs(left.detectedAt));
}

async function deleteSecurityLogEntry(logId) {
  if (!logId) return false;
  const results = await Promise.allSettled([
    db.ref(`securityLogs/${logId}`).remove(),
    fsDelete(`securityLogs/${logId}`)
  ]);
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function createSupportTicketRecord(ticket, initialMessage) {
  const ticketId = db.ref('supportTickets').push().key
    || (fsdb ? getFirestoreCollectionRef('supportTickets').doc().id : crypto.randomUUID());
  const messageId = db.ref(`supportMessages/${ticketId}`).push().key
    || (fsdb ? getFirestoreCollectionRef(`supportTickets/${ticketId}/messages`).doc().id : crypto.randomUUID());
  const normalizedTicket = sanitizeFirebaseValue({
    ...(ticket || {}),
    id: ticketId
  });
  const normalizedMessage = sanitizeFirebaseValue({
    ...(initialMessage || {}),
    id: messageId,
    ticketId
  });

  await Promise.all([
    db.ref(`supportTickets/${ticketId}`).set(normalizedTicket),
    db.ref(`supportMessages/${ticketId}/${messageId}`).set(normalizedMessage)
  ]);

  if (fsdb) {
    const mirrorResults = await Promise.allSettled([
      fsWrite(`supportTickets/${ticketId}`, normalizedTicket, false),
      fsWrite(`supportTickets/${ticketId}/messages/${messageId}`, normalizedMessage, false)
    ]);

    mirrorResults.forEach((result, index) => {
      if (result.status === 'rejected' || result.value === false) {
        logger.warn('Support ticket Firestore mirror write failed', {
          ticketId,
          target: index === 0 ? 'ticket' : 'message',
          error: result.reason || null
        });
      }
    });
  }

  return {
    ticket: normalizedTicket,
    message: normalizedMessage
  };
}

async function getSupportTicketRecord(ticketId) {
  const firestoreTicket = await fsRead(`supportTickets/${ticketId}`);
  if (firestoreTicket) {
    return { id: ticketId, ...firestoreTicket };
  }

  const realtimeSnapshot = await db.ref(`supportTickets/${ticketId}`).once('value').catch(() => null);
  const realtimeTicket = realtimeSnapshot?.val?.() || null;
  if (realtimeTicket) {
    void fsWrite(`supportTickets/${ticketId}`, realtimeTicket, false);
    return { id: ticketId, ...realtimeTicket };
  }
  return null;
}

async function listSupportTicketRecords({ userId = null, limit = 100 } = {}) {
  const [firestoreTickets, realtimeSnapshot] = await Promise.all([
    userId
      ? fsList('supportTickets', { filters: [{ field: 'userId', value: userId }], limit: Math.max(limit, 50) })
      : fsList('supportTickets', { orderByField: 'updatedAt', direction: 'desc', limit }),
    userId
      ? db.ref('supportTickets').orderByChild('userId').equalTo(userId).once('value').catch(() => null)
      : db.ref('supportTickets').once('value').catch(() => null)
  ]);
  const merged = new Map();
  firestoreTickets.forEach((ticket) => merged.set(String(ticket.id), ticket));
  const realtimeTickets = Object.entries(realtimeSnapshot?.val?.() || {}).map(([id, ticket]) => ({ id, ...(ticket || {}) }));
  realtimeTickets.forEach((ticket) => {
    const { id, ...data } = ticket;
    const selected = chooseFresherRecord(merged.get(id) || null, ticket);
    if (selected.record) {
      merged.set(id, selected.record);
    }
    void fsWrite(`supportTickets/${id}`, data, false);
  });
  return Array.from(merged.values())
    .sort((left, right) => parseDateToMs(right.updatedAt || right.createdAt) - parseDateToMs(left.updatedAt || left.createdAt))
    .slice(0, Math.max(1, Number(limit) || 100));
}

async function listSupportTicketMessages(ticketId) {
  const [firestoreMessages, realtimeSnapshot] = await Promise.all([
    fsList(`supportTickets/${ticketId}/messages`, {
      orderByField: 'createdAt',
      direction: 'asc',
      limit: 500
    }),
    db.ref(`supportMessages/${ticketId}`).once('value').catch(() => null)
  ]);
  const merged = new Map();
  firestoreMessages.forEach((message) => merged.set(String(message.id), message));
  const realtimeMessages = Object.entries(realtimeSnapshot?.val?.() || {}).map(([id, message]) => ({ id, ...(message || {}) }));
  realtimeMessages.forEach((message) => {
    const { id, ...data } = message;
    const selected = chooseFresherRecord(merged.get(id) || null, message);
    if (selected.record) {
      merged.set(id, selected.record);
    }
    void fsWrite(`supportTickets/${ticketId}/messages/${id}`, data, false);
  });
  return Array.from(merged.values()).sort((left, right) => parseDateToMs(left.createdAt) - parseDateToMs(right.createdAt));
}

async function addSupportTicketMessage(ticketId, message) {
  if (!ticketId) return null;
  const messageRef = db.ref(`supportMessages/${ticketId}`).push();
  const fallbackId = fsdb ? getFirestoreCollectionRef(`supportTickets/${ticketId}/messages`).doc().id : crypto.randomUUID();
  const messageId = messageRef.key || fallbackId;
  const payload = sanitizeFirebaseValue({
    ...(message || {}),
    ticketId,
    id: messageId
  });

  await db.ref(`supportMessages/${ticketId}/${messageId}`).set(payload);

  if (fsdb) {
    const mirrored = await fsWrite(`supportTickets/${ticketId}/messages/${messageId}`, payload, false);
    if (mirrored === false) {
      logger.warn('Support ticket message Firestore mirror write failed', { ticketId, messageId });
    }
  }

  return payload;
}

async function updateSupportTicketRecord(ticketId, updates) {
  if (!ticketId) return false;
  const payload = sanitizeFirebaseValue(updates);
  const realtimeRef = db.ref(`supportTickets/${ticketId}`);
  const realtimeSnapshot = await realtimeRef.once('value').catch(() => null);

  if (realtimeSnapshot?.exists?.()) {
    await realtimeRef.update(payload);
  } else {
    const firestoreTicket = await fsRead(`supportTickets/${ticketId}`);
    await realtimeRef.set(sanitizeFirebaseValue({
      ...(firestoreTicket || {}),
      id: ticketId,
      ...payload
    }));
  }

  if (fsdb) {
    const mirrored = await fsWrite(`supportTickets/${ticketId}`, payload, true);
    if (mirrored === false) {
      logger.warn('Support ticket Firestore mirror update failed', { ticketId });
    }
  }
  return true;
}

async function listStoredMatchHistoryForUsername(normalizedUsername, player = null) {
  const [firestoreMatches, realtimeSnapshot] = await Promise.all([
    fsList('matchHistory', {
      orderByField: 'finalizedAt',
      direction: 'desc',
      limit: 500
    }),
    db.ref('matches').once('value')
  ]);

  const merged = new Map();
  firestoreMatches.forEach((match) => {
    merged.set(match.matchId || match.id, { ...match, matchId: match.matchId || match.id });
  });

  Object.entries(realtimeSnapshot.val() || {})
    .map(([matchId, match]) => ({ matchId, ...(match || {}) }))
    .filter((match) => match && match.status === 'ended' && match.finalized)
    .filter((match) => {
      const byUserId = player?.userId && (match.playerId === player.userId || match.testerId === player.userId);
      const byUsername = normalizeMinecraftUsername(match.playerUsername) === normalizedUsername
        || normalizeMinecraftUsername(match.testerUsername) === normalizedUsername;
      return Boolean(byUserId || byUsername);
    })
    .forEach((match) => {
      const existing = merged.get(match.matchId || match.id);
      const selected = chooseFresherRecord(existing || null, match);
      if (selected.record) {
        merged.set(match.matchId || match.id, selected.record);
      }
    });

  return Array.from(merged.values()).filter((match) => {
    const byUserId = player?.userId && (match.playerId === player.userId || match.testerId === player.userId);
    const byUsername = normalizeMinecraftUsername(match.playerUsername) === normalizedUsername
      || normalizeMinecraftUsername(match.testerUsername) === normalizedUsername;
    return Boolean(byUserId || byUsername);
  });
}

async function listStoredMatchHistoryForUserId(userId) {
  if (!userId) return [];

  const [firestoreMatches, playerMatchesSnapshot, testerMatchesSnapshot] = await Promise.all([
    fsList('matchHistory', {
      orderByField: 'finalizedAt',
      direction: 'desc',
      limit: 500
    }),
    db.ref('matches').orderByChild('playerId').equalTo(userId).once('value'),
    db.ref('matches').orderByChild('testerId').equalTo(userId).once('value')
  ]);

  const merged = new Map();
  firestoreMatches
    .filter((match) => match.playerId === userId || match.testerId === userId)
    .forEach((match) => {
      merged.set(match.matchId || match.id, { ...match, matchId: match.matchId || match.id });
    });

  Object.entries(playerMatchesSnapshot.val() || {}).forEach(([matchId, match]) => {
    merged.set(matchId, { matchId, ...(match || {}) });
  });
  Object.entries(testerMatchesSnapshot.val() || {}).forEach(([matchId, match]) => {
    const selected = chooseFresherRecord(merged.get(matchId) || null, { matchId, ...(match || {}) });
    if (selected.record) {
      merged.set(matchId, selected.record);
    }
  });

  return Array.from(merged.values()).filter((match) => match && match.status === 'ended' && match.finalized);
}

async function readStoredSecurityScore(userId) {
  if (!userId) return null;

  const firestoreScore = await fsRead(`securityScores/${userId}`);
  if (firestoreScore) {
    return firestoreScore;
  }

  try {
    const snapshot = await db.ref(`securityScores/${userId}`).once('value');
    return snapshot.val() || null;
  } catch (err) {
    logger.error('RTDB security score read failed', { userId, error: err });
    return null;
  }
}

async function writeStoredSecurityScore(userId, scoreData) {
  if (!userId || !scoreData) return false;

  const safeScoreData = sanitizeFirebaseValue(scoreData);
  const writes = [
    db.ref(`securityScores/${userId}`).set(safeScoreData)
  ];

  if (fsdb) {
    writes.push(fsWrite(`securityScores/${userId}`, safeScoreData, false));
  }

  const results = await Promise.allSettled(writes);
  return results.some((result) => result.status === 'fulfilled' && result.value !== false);
}

async function listStoredSecurityScores({ limit = 50, riskLevel = null, startAfter = null } = {}) {
  try {
    const snapshot = await db.ref('securityScores').once('value');
    const scoreMap = snapshot.val() || {};
    let scores = Object.entries(scoreMap).map(([userId, score]) => ({
      userId,
      ...(score || {})
    }));

    if (riskLevel) {
      scores = scores.filter((score) => score?.riskLevel === riskLevel);
    }

    scores.sort((a, b) => {
      const scoreDiff = Number(b?.score || 0) - Number(a?.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return new Date(b?.lastComputed || 0).getTime() - new Date(a?.lastComputed || 0).getTime();
    });

    if (Number.isFinite(startAfter)) {
      scores = scores.filter((score) => Number(score?.score || 0) < startAfter);
    }

    return scores.slice(0, limit);
  } catch (err) {
    logger.error('RTDB security score list failed', { error: err });
    return [];
  }
}

const RTDB_BACKUP_COLLECTION = 'realtimeDatabaseBackups';
const RTDB_BACKUP_CHUNK_SIZE = 900000;

function normalizeMinecraftUUID(uuid) {
  const normalized = String(uuid || '').trim().replace(/-/g, '').toLowerCase();
  return /^[0-9a-f]{32}$/.test(normalized) ? normalized : null;
}

function fetchJsonOverHttps(url) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      let data = '';

      response.on('data', (chunk) => {
        data += chunk;
      });

      response.on('end', () => {
        resolve({ statusCode: response.statusCode || 0, body: data });
      });
    });

    request.setTimeout(5000, () => {
      request.destroy(new Error('HTTPS request timed out'));
    });

    request.on('error', reject);
  });
}

async function fetchMojangProfile(username) {
  const trimmedUsername = String(username || '').trim();
  if (!trimmedUsername) return null;

  const mojangApiUrl = `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(trimmedUsername)}`;
  const response = await fetchJsonOverHttps(mojangApiUrl);

  if (response.statusCode === 204 || response.statusCode === 404) {
    return null;
  }

  if (response.statusCode !== 200) {
    throw new Error(`Mojang API returned status ${response.statusCode}`);
  }

  const profile = JSON.parse(response.body || '{}');
  const uuid = normalizeMinecraftUUID(profile.id);
  if (!profile.name || !uuid) {
    throw new Error('Invalid Mojang API response');
  }

  return {
    username: profile.name,
    uuid
  };
}

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

async function deleteFirestoreBackupDoc(docId) {
  if (!fsdb || !docId) return;
  const backupRef = fsdb.collection(RTDB_BACKUP_COLLECTION).doc(docId);
  const chunkSnapshot = await backupRef.collection('chunks').get();
  const batch = fsdb.batch();
  chunkSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(backupRef);
  await batch.commit();
}

async function createRealtimeDatabaseFirestoreBackup(reason = 'scheduled') {
  if (!fsdb) {
    throw new Error('Firestore not configured');
  }

  const snapshot = await db.ref('/').once('value');
  const payload = JSON.stringify(snapshot.val() || {});
  const chunks = chunkString(payload, RTDB_BACKUP_CHUNK_SIZE);
  const backupId = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRef = fsdb.collection(RTDB_BACKUP_COLLECTION).doc(backupId);

  await backupRef.set({
    backupId,
    reason,
    createdAt: new Date().toISOString(),
    chunkCount: chunks.length,
    payloadLength: payload.length
  });

  for (let index = 0; index < chunks.length; index++) {
    await backupRef.collection('chunks').doc(String(index).padStart(6, '0')).set({
      order: index,
      content: chunks[index]
    });
  }

  const existingBackups = await fsdb.collection(RTDB_BACKUP_COLLECTION).orderBy('createdAt', 'desc').get();
  const staleDocs = existingBackups.docs.slice(1);
  for (const staleDoc of staleDocs) {
    await deleteFirestoreBackupDoc(staleDoc.id);
  }

  return { backupId, chunkCount: chunks.length };
}

async function cleanupRetiredNotificationData() {
  await Promise.allSettled([
    db.ref('notifications').remove(),
    db.ref('adminNotifications').remove()
  ]);
}

function sanitizeFirebaseValue(value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (Array.isArray(value)) {
    const sanitizedArray = value
      .map((item) => sanitizeFirebaseValue(item))
      .filter((item) => item !== undefined);
    return sanitizedArray;
  }
  if (typeof value === 'object') {
    const output = {};
    for (const [key, nested] of Object.entries(value)) {
      const sanitizedNested = sanitizeFirebaseValue(nested);
      if (sanitizedNested !== undefined) {
        output[key] = sanitizedNested;
      }
    }
    return output;
  }
  return value;
}

function normalizeSuspiciousAccountsList(accounts) {
  const input = Array.isArray(accounts) ? accounts : [];
  const byUid = new Map();

  input.forEach((rawAccount) => {
    const safeAccount = sanitizeFirebaseValue(rawAccount || {});
    const uid = String(safeAccount?.uid || '').trim();
    if (!uid) return;

    byUid.set(uid, {
      uid,
      email: safeAccount.email || null,
      minecraftUsername: safeAccount.minecraftUsername || null,
      reason: safeAccount.reason || 'Suspicious account',
      confidence: safeAccount.confidence || 'low'
    });
  });

  return Array.from(byUid.values());
}

// Initialize Express app
const app = express();
const PORT = config.port;

// ===== Performance Caching =====
// In-memory cache for frequently accessed data with TTL
const cache = {
  whitelist: { data: null, timestamp: null, ttl: 60000 }, // 60 seconds
  tierTesterApps: { data: null, timestamp: null, ttl: 30000 }, // 30 seconds
  
  get(key) {
    const item = this[key];
    if (!item || !item.data) return null;
    if (Date.now() - item.timestamp > item.ttl) {
      item.data = null;
      return null;
    }
    return item.data;
  },
  
  set(key, data) {
    if (this[key]) {
      this[key].data = data;
      this[key].timestamp = Date.now();
    }
  },
  
  invalidate(key) {
    if (this[key]) {
      this[key].data = null;
      this[key].timestamp = null;
    }
  }
};

// ===== Middleware =====

// Trust proxy - Required when behind Nginx reverse proxy
// This allows Express to trust X-Forwarded-* headers from the proxy
app.set('trust proxy', true);

// Compression - reduce response sizes by 70-90%
app.use(compression({
  level: 6, // Balance between compression and CPU usage
  filter: (req, res) => {
    // Don't compress if client doesn't support it
    if (req.headers['x-no-compression']) {
      return false;
    }
    // Event streams should stay unbuffered and uncompressed through proxies.
    if ((req.headers.accept || '').includes('text/event-stream')) {
      return false;
    }
    // Use compression for all other requests
    return compression.filter(req, res);
  }
}));

// Security
// Allow auth popups (Firebase signInWithPopup) to interact with opener without COOP errors.
app.use(helmet({
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));

// CORS
// In production, Nginx proxies requests, so we can allow same-origin.
// For development, allow localhost origins and direct file:// testing (Origin: null).
const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients / same-origin (no Origin header)
    if (!origin) return callback(null, true);

    const normalizedOrigin = String(origin).trim();
    const devAllowed = new Set([
      'null',
      'http://localhost:3000',
      'http://127.0.0.1:3000',
      'http://127.0.0.1:5500',
      'http://localhost:5500',
      'http://127.0.0.1:8000',
      'http://localhost:8000'
    ]);

    // Allow both apex and www (and optional :443) for production site
    // Example origins: https://mcleaderboards.org, https://www.mcleaderboards.org
    const prodOriginRegex = /^https:\/\/(www\.)?mcleaderboards\.org(?::443)?$/i;
    if (prodOriginRegex.test(normalizedOrigin)) return callback(null, true);

    // Only allow localhost-style origins in non-production
    if (config.nodeEnv !== 'production' && devAllowed.has(normalizedOrigin)) {
      return callback(null, true);
    }

    // Disallowed origin: don't throw (which becomes a 500); just don't set CORS headers.
    return callback(null, false);
  },
  credentials: true,
  optionsSuccessStatus: 204
};

app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));

// Body parsing - Memory optimization: Reduce payload limits for 1GB RAM server
app.use(express.json({ limit: '1mb' })); // Reduced from default 100kb to 1mb (reasonable limit)
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Logging
app.use(morgan((tokens, req, res) => JSON.stringify({
  timestamp: new Date().toISOString(),
  level: 'info',
  message: 'HTTP request',
  meta: {
    method: tokens.method(req, res),
    path: tokens.url(req, res),
    status: Number(tokens.status(req, res)),
    responseTimeMs: Number(tokens['response-time'](req, res)),
    contentLength: tokens.res(req, res, 'content-length') || '0',
    ipAddress: getClientIP(req)
  }
})));

const SLOW_API_REQUEST_THRESHOLD_MS = 1000;

app.use('/api/', (req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const durationMs = Date.now() - start;
    if (durationMs < SLOW_API_REQUEST_THRESHOLD_MS) {
      return;
    }

    logger.warn('Slow API request detected', {
      method: req.method,
      path: req.originalUrl || req.url || req.path,
      status: res.statusCode,
      durationMs,
      userId: req.user?.uid,
      ipAddress: getClientIP(req)
    });
  });

  next();
});

// Rate limiting - configured for proxy environment
const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  // Use a custom key generator that properly handles proxy headers
  keyGenerator: (req) => {
    // Get the real client IP from proxy headers or fallback to direct IP
    const clientIP = getClientIP(req);
    return clientIP;
  }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per 15 minutes
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientIP = getClientIP(req);
    return clientIP;
  }
});

// More lenient rate limiting for username verification (users might make typos)
const usernameVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per 15 minutes
  message: 'Too many username verification attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientIP = getClientIP(req);
    return clientIP;
  }
});

// Stricter rate limiting for admin operations
const adminLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 admin write requests per minute
  message: 'Too many admin requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    const clientIP = getClientIP(req);
    return clientIP;
  }
});

const adminSearchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 240, // Admin search can fire multiple requests per interaction
  message: 'Too many admin search requests. Please wait a moment and try again.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.uid || getClientIP(req);
  }
});

// Rate limiting for queue operations (prevent queue manipulation)
const queueLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // 5 queue operations per minute
  message: 'Too many queue operations. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Use user ID if authenticated, otherwise IP
    return req.user?.uid || getClientIP(req);
  }
});

// Rate limiting for match operations
const matchLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 match operations per minute
  message: 'Too many match operations. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.uid || getClientIP(req);
  }
});

// Rate limiting for messaging
const messageLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30, // 30 messages per minute
  message: 'You are sending messages too quickly. Please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.uid || getClientIP(req);
  }
});

const supportTicketLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 8, // Ticket creation and support actions should be deliberate
  message: 'Too many support requests. Please wait a few minutes and try again.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => {
    return req.user?.uid || getClientIP(req);
  }
});

app.use('/api/', (req, res, next) => {
  if (req.path.startsWith('/admin/')) {
    return next();
  }
  if (req.method === 'GET' && req.path.startsWith('/users/me')) {
    return next();
  }
  return limiter(req, res, next);
});
// Apply auth limiter to most auth endpoints, but allow more frequent calls for verification and cleanup
app.use('/api/auth/', (req, res, next) => {
  // Allow more frequent calls for endpoints that may be called repeatedly by normal auth flows
  if (
    req.path === '/check-ban' ||
    req.path === '/verification-code' ||
    req.path === '/cleanup-minecraft' ||
    req.path === '/login' ||
    req.path === '/session'
  ) {
    return limiter(req, res, next); // Use general limiter (100 req/min)
  }
  return authLimiter(req, res, next); // Use strict auth limiter (5 req/15min) for others
});

// Slow down middleware should be scoped to sensitive endpoints only.
// Applying it globally can make normal dashboard polling feel slower over time.
const authSlowDown = slowDown({
  windowMs: 15 * 60 * 1000, // 15 minutes
  delayAfter: 20, // Plenty for normal auth flows, slows brute-force attempts
  delayMs: (used, req) => {
    const threshold = req.slowDown?.limit || 20;
    return Math.min((used - threshold) * 250, 4000);
  },
  keyGenerator: (req) => getClientIP(req),
  validate: {
    delayMs: false
  }
});

const adminSlowDown = slowDown({
  windowMs: 5 * 60 * 1000, // 5 minutes
  delayAfter: 30,
  delayMs: (used, req) => {
    const threshold = req.slowDown?.limit || 30;
    return Math.min((used - threshold) * 150, 3000);
  },
  keyGenerator: (req) => req.user?.uid || getClientIP(req),
  validate: {
    delayMs: false
  }
});

app.use('/api/auth/', authSlowDown);
app.use('/api/admin/', adminSlowDown);

const ADMIN_CAPABILITY_MATRIX = {
  owner: ['*'],
  lead_admin: [
    'users:view',
    'users:manage',
    'blacklist:view',
    'blacklist:manage',
    'audit:view',
    'matches:view',
    'matches:manage',
    'reports:manage',
    'disputes:manage',
    'queue:inspect',
    'settings:manage'
  ],
  moderator: [
    'users:view',
    'blacklist:view',
    'blacklist:manage',
    'audit:view',
    'matches:view',
    'reports:manage',
    'disputes:manage',
    'messages:send',
    'security_scores:view',
    'applications:manage'
  ],
  senior_moderator: [
    'users:view',
    'blacklist:view',
    'blacklist:manage',
    'audit:view',
    'matches:view',
    'reports:manage',
    'disputes:manage',
    'messages:send',
    'security_scores:view',
    'applications:manage',
    'bans:manage'
  ],
  support: [
    'users:view',
    'audit:view',
    'matches:view'
  ]
};

const STAFF_ROLE_ICON_PRESETS = {
  shield: { label: 'Shield', iconClass: 'fas fa-shield-alt' },
  star: { label: 'Star', iconClass: 'fas fa-star' },
  crown: { label: 'Crown', iconClass: 'fas fa-crown' },
  gavel: { label: 'Gavel', iconClass: 'fas fa-gavel' },
  bolt: { label: 'Bolt', iconClass: 'fas fa-bolt' },
  eye: { label: 'Eye', iconClass: 'fas fa-eye' }
};

const LEGACY_STAFF_ROLE_PRESET_MAP = {
  'rookie.svg': 'shield',
  'combat_novice.svg': 'shield',
  'combat_cadet.svg': 'shield',
  'combat_specialist.svg': 'shield',
  'combat_ace.svg': 'star',
  'combat_master.webp': 'crown',
  'combat_grandmaster.webp': 'gavel',
  'mace.svg': 'bolt',
  'nethop.svg': 'bolt',
  'pot.svg': 'star',
  'smp.svg': 'shield',
  'sword.svg': 'shield',
  'uhc.svg': 'star',
  'vanilla.svg': 'crown',
  'axe.svg': 'gavel'
};

const STAFF_DASHBOARD_ACTION_DEFINITIONS = {
  open_admin_management: { label: 'User Management', icon: 'fa-users-cog' },
  open_admin_moderation: { label: 'Blacklist & Applications', icon: 'fa-ban' },
  open_admin_reports: { label: 'Reports Review', icon: 'fa-flag' },
  open_admin_matches: { label: 'Match Manager', icon: 'fa-gamepad' },
  open_admin_operations: { label: 'Queue & Match Ops', icon: 'fa-diagram-project' },
  open_admin_security_scores: { label: 'Security Scores', icon: 'fa-shield-alt' },
  open_admin_support: { label: 'Support Tickets', icon: 'fa-life-ring' },
  open_admin_ban_waves: { label: 'Ban Waves', icon: 'fa-wave-square' },
  open_admin_banned: { label: 'Bans', icon: 'fa-ban' },
  open_admin_send_message: { label: 'Send Message', icon: 'fa-envelope' },
  open_admin_punish: { label: 'Punish', icon: 'fa-gavel' },
  open_admin_servers: { label: 'Whitelisted Servers', icon: 'fa-server' },
  open_admin_staff_roles: { label: 'Roles', icon: 'fa-user-shield' },
  open_admin_contact_requests: { label: 'Admin Requests', icon: 'fa-inbox' },
  open_moderation_chat: { label: 'Chat Reports', icon: 'fa-comments' },
  open_leaderboard_moderation: { label: 'Leaderboard Filters', icon: 'fa-filter' },
  queue_open: { label: 'Join Queue', icon: 'fa-play', legacy: true },
  queue_leave: { label: 'Leave Queue', icon: 'fa-sign-out-alt', legacy: true },
  queue_refresh: { label: 'Refresh Queue', icon: 'fa-sync-alt', legacy: true },
  load_activity: { label: 'Load Activity', icon: 'fa-chart-line', legacy: true },
  load_cooldowns: { label: 'Load Cooldowns', icon: 'fa-clock', legacy: true },
  open_reports_page: { label: 'Open Reports', icon: 'fa-flag', legacy: true },
  open_support_page: { label: 'Open Support', icon: 'fa-life-ring', legacy: true },
  open_testing_page: { label: 'Open Testing', icon: 'fa-flask', legacy: true }
};

const STAFF_DASHBOARD_ACTIONS = new Set(Object.keys(STAFF_DASHBOARD_ACTION_DEFINITIONS));
const SPECIAL_STAFF_ROLE_DEFINITIONS = {
  moderator: {
    label: 'Moderator',
    badgeVariant: 'moderator',
    color: '#facc15',
    iconClass: 'fas fa-shield-alt',
    capabilities: ['moderation:chat_reports:view', 'moderation:chat:block', 'moderation:contact_admins'],
    dashboardActions: ['open_moderation_chat', 'open_admin_send_message', 'open_admin_security_scores', 'open_admin_moderation'],
    adminCapabilities: ['messages:send', 'security_scores:view', 'applications:manage']
  },
  'leaderboard-moderator': {
    label: 'Leaderboard Moderator',
    badgeVariant: 'leaderboard-moderator',
    color: '#60a5fa',
    iconClass: 'fas fa-filter',
    capabilities: ['leaderboard:filters:manage', 'moderation:contact_admins'],
    dashboardActions: ['open_leaderboard_moderation']
  },
  'senior-moderator': {
    label: 'Senior Moderator',
    badgeVariant: 'senior-moderator',
    color: '#ef4444',
    iconClass: 'fas fa-shield-alt',
    capabilities: ['moderation:chat_reports:view', 'moderation:chat:block', 'leaderboard:filters:manage', 'moderation:contact_admins'],
    dashboardActions: [
      'open_moderation_chat',
      'open_leaderboard_moderation',
      'open_admin_support',
      'open_admin_reports',
      'open_admin_moderation',
      'open_admin_ban_waves',
      'open_admin_banned',
      'open_admin_security_scores',
      'open_admin_send_message',
      'open_admin_punish'
    ],
    adminRole: 'senior_moderator',
    adminCapabilities: ADMIN_CAPABILITY_MATRIX.senior_moderator
  }
};
const BUILTIN_STAFF_ROLE_IDS = new Set(Object.keys(SPECIAL_STAFF_ROLE_DEFINITIONS));

const STAFF_ROLE_ACTION_CAPABILITY_MAP = {
  open_moderation_chat: ['moderation:chat_reports:view', 'moderation:chat:block'],
  open_leaderboard_moderation: ['leaderboard:filters:manage'],
  open_admin_send_message: ['moderation:contact_admins']
};

function normalizeStaffRoleIconPreset(value) {
  const raw = String(value || '').trim();
  if (STAFF_ROLE_ICON_PRESETS[raw]) {
    return raw;
  }
  if (LEGACY_STAFF_ROLE_PRESET_MAP[raw]) {
    return LEGACY_STAFF_ROLE_PRESET_MAP[raw];
  }
  return 'shield';
}

function sanitizeStaffRoleId(value) {
  const raw = String(value || '').trim().toLowerCase();
  const slug = raw
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return slug.slice(0, 48);
}

function sanitizeStaffRolePayload(input = {}) {
  const name = String(input.name || '').trim().slice(0, 32);
  const colorRaw = String(input.color || '').trim();
  const color = /^#([0-9a-fA-F]{6})$/.test(colorRaw) ? colorRaw : '#38bdf8';
  const iconPreset = normalizeStaffRoleIconPreset(input.iconPreset);
  const iconUrlRaw = String(input.iconUrl || '').trim();
  const dashboardActions = Array.isArray(input.dashboardActions)
    ? [...new Set(input.dashboardActions.map((action) => String(action || '').trim()).filter((action) => STAFF_DASHBOARD_ACTIONS.has(action)))]
    : [];

  let iconType = 'preset';
  let iconValue = 'shield';

  if (iconUrlRaw) {
    try {
      const parsed = new URL(iconUrlRaw);
      if ((parsed.protocol === 'https:' || parsed.protocol === 'http:') && iconUrlRaw.length <= 300) {
        iconType = 'url';
        iconValue = iconUrlRaw;
      }
    } catch (_) {
      // ignore invalid URL and fall back to preset
    }
  }

  if (iconType !== 'url') {
    const fallbackPreset = normalizeStaffRoleIconPreset(iconPreset);
    iconType = 'preset';
    iconValue = fallbackPreset;
  }

  return {
    valid: name.length >= 2,
    data: {
      name,
      color,
      iconType,
      iconValue,
      dashboardActions
    }
  };
}

function resolveSpecialStaffRoleDefinition(roleId, roleName = '') {
  const candidateKeys = [
    sanitizeStaffRoleId(roleId),
    sanitizeStaffRoleId(roleName),
    sanitizeStaffRoleId(String(roleName || '').replace(/\s+/g, '-'))
  ].filter(Boolean);

  for (const key of candidateKeys) {
    if (SPECIAL_STAFF_ROLE_DEFINITIONS[key]) {
      return SPECIAL_STAFF_ROLE_DEFINITIONS[key];
    }
  }

  return null;
}

function deriveStaffRoleCapabilities(roleId, role = {}) {
  const capabilitySet = new Set();
  const specialRole = resolveSpecialStaffRoleDefinition(roleId, role.name || roleId);

  (specialRole?.capabilities || []).forEach((capability) => capabilitySet.add(capability));
  (Array.isArray(role.capabilities) ? role.capabilities : []).forEach((capability) => capabilitySet.add(capability));
  (Array.isArray(role.dashboardActions) ? role.dashboardActions : []).forEach((actionId) => {
    (STAFF_ROLE_ACTION_CAPABILITY_MAP[actionId] || []).forEach((capability) => capabilitySet.add(capability));
  });

  return [...capabilitySet];
}

function deriveStaffRoleAdminCapabilities(roleId, role = {}) {
  const capabilitySet = new Set();
  const specialRole = resolveSpecialStaffRoleDefinition(roleId, role.name || roleId);

  (specialRole?.adminCapabilities || []).forEach((capability) => capabilitySet.add(capability));
  (Array.isArray(role.adminCapabilities) ? role.adminCapabilities : []).forEach((capability) => capabilitySet.add(capability));

  return [...capabilitySet];
}

function buildStaffRoleSpecialBadges(roleId, role = {}, capabilities = null) {
  const capabilityList = Array.isArray(capabilities) ? capabilities : deriveStaffRoleCapabilities(roleId, role);
  const capabilitySet = new Set(capabilityList);
  const badges = [];

  const roleSpecial = resolveSpecialStaffRoleDefinition(roleId, role.name || roleId);
  if (roleSpecial?.badgeVariant === 'senior-moderator') {
    const definition = SPECIAL_STAFF_ROLE_DEFINITIONS['senior-moderator'];
    badges.push({
      id: 'senior-moderator',
      label: definition.label,
      badgeVariant: definition.badgeVariant,
      color: definition.color,
      iconClass: definition.iconClass
    });
    return badges;
  }

  if (capabilitySet.has('moderation:chat_reports:view') || capabilitySet.has('moderation:chat:block')) {
    const definition = SPECIAL_STAFF_ROLE_DEFINITIONS.moderator;
    badges.push({
      id: 'moderator',
      label: definition.label,
      badgeVariant: definition.badgeVariant,
      color: definition.color,
      iconClass: definition.iconClass
    });
  }

  if (capabilitySet.has('leaderboard:filters:manage')) {
    const definition = SPECIAL_STAFF_ROLE_DEFINITIONS['leaderboard-moderator'];
    badges.push({
      id: 'leaderboard-moderator',
      label: definition.label,
      badgeVariant: definition.badgeVariant,
      color: definition.color,
      iconClass: definition.iconClass
    });
  }

  return badges;
}

function buildStaffRoleIconConfig(role = {}) {
  if (role.iconType === 'url' && typeof role.iconValue === 'string' && role.iconValue.trim()) {
    return {
      iconType: 'url',
      iconValue: role.iconValue,
      iconUrl: role.iconValue,
      iconClass: null,
      iconLabel: 'Custom icon'
    };
  }
  const preset = normalizeStaffRoleIconPreset(role.iconValue || role.iconPreset);
  const presetMeta = STAFF_ROLE_ICON_PRESETS[preset] || STAFF_ROLE_ICON_PRESETS.shield;
  return {
    iconType: 'preset',
    iconValue: preset,
    iconUrl: null,
    iconClass: presetMeta.iconClass,
    iconLabel: presetMeta.label
  };
}

function getBuiltinStaffRoleIds(profile = {}) {
  const roleIds = new Set();
  const legacyRoleId = sanitizeStaffRoleId(profile.staffRoleId);
  if (legacyRoleId && BUILTIN_STAFF_ROLE_IDS.has(legacyRoleId)) {
    roleIds.add(legacyRoleId);
  }

  const storedRoleIds = Array.isArray(profile.builtinStaffRoleIds)
    ? profile.builtinStaffRoleIds
    : [];
  storedRoleIds.forEach((value) => {
    const roleId = sanitizeStaffRoleId(value);
    if (roleId && BUILTIN_STAFF_ROLE_IDS.has(roleId)) {
      roleIds.add(roleId);
    }
  });

  return [...roleIds];
}

function getAssignedStaffRoleIds(profile = {}) {
  const roleIds = [];
  const seen = new Set();
  const primaryRoleId = sanitizeStaffRoleId(profile.staffRoleId);

  if (primaryRoleId && !BUILTIN_STAFF_ROLE_IDS.has(primaryRoleId)) {
    seen.add(primaryRoleId);
    roleIds.push(primaryRoleId);
  }

  getBuiltinStaffRoleIds(profile).forEach((roleId) => {
    if (!seen.has(roleId)) {
      seen.add(roleId);
      roleIds.push(roleId);
    }
  });

  return roleIds;
}

const staffRolesCache = { data: null, updatedAt: 0, ttl: 30000 }; // 30s TTL

async function getAllStaffRoles() {
  const now = Date.now();
  if (staffRolesCache.data && (now - staffRolesCache.updatedAt) < staffRolesCache.ttl) {
    return staffRolesCache.data;
  }

  const snapshot = await db.ref('settings/staffRoles').once('value');
  const storedRoles = snapshot.val() || {};
  const roles = { ...storedRoles };
  Object.entries(SPECIAL_STAFF_ROLE_DEFINITIONS).forEach(([roleId, definition]) => {
    if (!roles[roleId]) {
      roles[roleId] = {
        name: definition.label,
        color: definition.color,
        iconType: 'preset',
        iconValue: 'shield',
        dashboardActions: definition.dashboardActions
      };
    }
  });
  staffRolesCache.data = roles;
  staffRolesCache.updatedAt = now;
  return roles;
}

function resolveStaffRoleForProfile(profile = {}, roleMap = {}) {
  const assignedRoleIds = getAssignedStaffRoleIds(profile)
    .filter((roleId) => roleMap[roleId] || SPECIAL_STAFF_ROLE_DEFINITIONS[roleId]);
  if (!assignedRoleIds.length) return null;

  const primaryRoleId = assignedRoleIds.find((roleId) => !BUILTIN_STAFF_ROLE_IDS.has(roleId)) || assignedRoleIds[0];
  const role = roleMap[primaryRoleId] || {};
  const iconConfig = buildStaffRoleIconConfig(role);
  const specialRole = resolveSpecialStaffRoleDefinition(primaryRoleId, role.name || primaryRoleId);
  const capabilitySet = new Set();
  const adminCapabilitySet = new Set();
  const dashboardActions = new Set();
  const specialBadgeKeys = new Set();
  const specialBadges = [];
  let resolvedStaffAdminRole = specialRole?.adminRole || null;

  assignedRoleIds.forEach((roleId) => {
    const resolvedRole = roleMap[roleId] || {};
    const resolvedSpecialRole = resolveSpecialStaffRoleDefinition(roleId, resolvedRole.name || roleId);
    if (!resolvedStaffAdminRole && resolvedSpecialRole?.adminRole) {
      resolvedStaffAdminRole = resolvedSpecialRole.adminRole;
    }
    const capabilities = deriveStaffRoleCapabilities(roleId, resolvedRole);
    capabilities.forEach((capability) => capabilitySet.add(capability));
    deriveStaffRoleAdminCapabilities(roleId, resolvedRole).forEach((capability) => adminCapabilitySet.add(capability));
    (Array.isArray(resolvedRole.dashboardActions) ? resolvedRole.dashboardActions : []).forEach((actionId) => dashboardActions.add(actionId));
    (resolvedSpecialRole?.dashboardActions || []).forEach((actionId) => dashboardActions.add(actionId));
    buildStaffRoleSpecialBadges(roleId, resolvedRole, capabilities).forEach((badge) => {
      const badgeKey = String(badge?.id || badge?.badgeVariant || '').trim();
      if (!badgeKey || specialBadgeKeys.has(badgeKey)) {
        return;
      }
      specialBadgeKeys.add(badgeKey);
      specialBadges.push(badge);
    });
  });

  return {
    id: assignedRoleIds.length === 1 ? primaryRoleId : `composite:${assignedRoleIds.join('+')}`,
    roleIds: assignedRoleIds,
    builtinRoleIds: assignedRoleIds.filter((roleId) => BUILTIN_STAFF_ROLE_IDS.has(roleId)),
    primaryRoleId,
    name: specialRole?.label || role.name || primaryRoleId,
    color: specialRole?.color || role.color || '#38bdf8',
    iconType: iconConfig.iconType,
    iconValue: iconConfig.iconValue,
    iconUrl: iconConfig.iconUrl,
    iconClass: specialRole?.iconClass || iconConfig.iconClass,
    iconLabel: specialRole?.label || iconConfig.iconLabel,
    badgeVariant: specialBadges[0]?.badgeVariant || specialRole?.badgeVariant || null,
    capabilities: [...capabilitySet],
    adminRole: resolvedStaffAdminRole,
    adminCapabilities: [...adminCapabilitySet],
    specialBadges,
    dashboardActions: [...dashboardActions]
  };
}

function buildBlacklistEntryResponse(id, entry = {}) {
  const addedAtMs = parseDateToMs(entry.addedAt);
  const expiresAtMs = parseDateToMs(entry.expiresAt);

  return {
    id,
    username: entry.username || null,
    userId: entry.userId || null,
    minecraftUUID: entry.minecraftUUID || null,
    reason: entry.reason || 'No reason provided',
    addedAt: entry.addedAt || null,
    expiresAt: entry.expiresAt || null,
    active: isBlacklistEntryActive(entry),
    temporary: Boolean(expiresAtMs),
    expired: Boolean(expiresAtMs && expiresAtMs <= Date.now()),
    addedAtMs,
    expiresAtMs
  };
}

function buildBlacklistEntries(blacklist = {}) {
  return Object.entries(blacklist)
    .map(([id, entry]) => buildBlacklistEntryResponse(id, entry || {}))
    .sort((a, b) => (b.addedAtMs || 0) - (a.addedAtMs || 0));
}

function getAdminRole(profile = {}, email = '') {
  if (config.adminBypassEmail && email === config.adminBypassEmail) return 'owner';
  if (typeof profile.adminRole === 'string' && ADMIN_CAPABILITY_MATRIX[profile.adminRole]) {
    return profile.adminRole;
  }
  // Backward-compat: old boolean admin becomes lead_admin by default.
  if (profile.admin === true) return 'lead_admin';
  return null;
}

function getAdminCapabilities(role) {
  return ADMIN_CAPABILITY_MATRIX[role] || [];
}

function resolveStaffAdminContext(staffRole = null) {
  const capabilities = Array.isArray(staffRole?.adminCapabilities) ? staffRole.adminCapabilities : [];
  if (!capabilities.length) return null;
  return {
    role: staffRole.adminRole || staffRole.primaryRoleId || staffRole.id || 'staff',
    capabilities
  };
}

function adminHasCapability(req, capability) {
  const capabilities = req.adminContext?.capabilities || [];
  return capabilities.includes('*') || capabilities.includes(capability);
}

function toBoundedInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(n, max));
}

function parseBooleanParam(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return fallback;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function sanitizeSearchQuery(value, maxLength = 120) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLength);
}

function parsePaginationParams(query = {}, defaultLimit = 25, maxLimit = 200) {
  const limit = toBoundedInt(query.limit, defaultLimit, 1, maxLimit);
  const page = toBoundedInt(query.page, 1, 1, 100000);
  const parsedOffset = parseInt(query.offset, 10);
  const offset = Number.isFinite(parsedOffset) ? Math.max(0, parsedOffset) : (page - 1) * limit;
  return { page, limit, offset };
}

function hasAdminAccess(profile = {}, email = '') {
  return Boolean(getAdminRole(profile, email));
}

/**
 * Strip sensitive/internal fields from a match object before returning to non-admin clients.
 * Admins receive the full raw match object.
 */
function sanitizeMatchForClient(match, matchId) {
  if (!match) return null;
  const {
    playerEmail,
    testerEmail,
    ...safe
  } = match;
  if (matchId !== undefined) safe.matchId = matchId;
  return safe;
}

async function enrichMatchForClient(match, matchId) {
  const safeMatch = sanitizeMatchForClient(match, matchId);
  if (!safeMatch) return null;

  const participantIds = [safeMatch.playerId, safeMatch.testerId].filter(Boolean);
  if (!participantIds.length) {
    return safeMatch;
  }

  const staffRoles = await getAllStaffRoles().catch(() => ({}));
  const participantProfiles = await Promise.all(participantIds.map((userId) => getStoredUserProfile(userId).catch(() => null)));
  const metaById = {};
  participantIds.forEach((userId, index) => {
    const profile = participantProfiles[index];
    metaById[userId] = profile ? buildPublicUserMeta(profile, staffRoles) : null;
  });

  return {
    ...safeMatch,
    playerMeta: safeMatch.playerId ? (metaById[safeMatch.playerId] || null) : null,
    testerMeta: safeMatch.testerId ? (metaById[safeMatch.testerId] || null) : null
  };
}

// Fields that normal users are allowed to update on their own profile
const ALLOWED_PROFILE_UPDATE_FIELDS = [
  'displayName',
  'bio',
  'region',
  'gamemodes',
  'gamemodeSkillLevels',
  'profilePicture',
  'onboardingCompleted',
  'retiredGamemodes',
  'notificationSettings',
  'notificationPreferences',
  'privacySettings',
  'securitySettings',
  'stayInQueueAfterMatch',
];

const CURRENT_USER_PROFILE_RESPONSE_FIELDS = [
  'uid',
  'userId',
  'firebaseUid',
  'email',
  'displayName',
  'bio',
  'region',
  'gamemodes',
  'gamemodeSkillLevels',
  'gamemodePreferences',
  'profilePicture',
  'minecraftUsername',
  'minecraftUUID',
  'minecraftVerified',
  'onboardingCompleted',
  'createdAt',
  'updatedAt',
  'lastLoginAt',
  'stayInQueueAfterMatch',
  'notificationSettings',
  'notificationPreferences',
  'privacySettings',
  'securitySettings',
  'plus',
  'retiredGamemodes',
  'retirementHistory',
  'tester',
  'testerSince',
  'testerApprovedAt',
  'pendingTesterApplication',
  'lastApplicationSubmitted',
  'testerApplicationDenied',
  'testerDenialReason',
  'admin',
  'adminRole',
  'staffRoleId',
  'builtinStaffRoleIds',
  'lastQueueJoins',
  'lastTestCompletions',
  'banned',
  'banReason',
  'banExpires'
];

function pickCurrentUserProfileFields(profile = {}) {
  return CURRENT_USER_PROFILE_RESPONSE_FIELDS.reduce((safeProfile, field) => {
    if (profile[field] !== undefined) {
      safeProfile[field] = profile[field];
    }
    return safeProfile;
  }, {});
}

function buildCurrentUserProfileResponse(profile = {}, {
  user = null,
  playerData = null,
  moderation = {},
  staffRole = null,
  adminRole = null,
  adminCapabilities = [],
  activeWarnings = []
} = {}) {
  return {
    ...pickCurrentUserProfileFields(profile),
    uid: user?.uid || profile.uid || profile.firebaseUid || null,
    userId: user?.uid || profile.userId || profile.firebaseUid || null,
    firebaseUid: profile.firebaseUid || user?.uid || null,
    email: profile.email || user?.email || null,
    emailVerified: user?.emailVerified === true,
    adminContext: adminRole ? {
      role: adminRole,
      capabilities: adminCapabilities,
      isOwner: adminCapabilities.includes('*')
    } : null,
    staffRole,
    gamemodeRatings: playerData?.gamemodeRatings || profile.gamemodeRatings || {},
    overallRating: playerData?.overallRating ?? profile.overallRating ?? 0,
    blacklisted: moderation.blacklisted === true,
    warnings: activeWarnings,
    moderation: {
      blacklisted: moderation.blacklisted === true,
      blacklistEntry: moderation.blacklistEntry || null,
      restrictions: moderation.restrictions || {},
      standing: {
        activeWarningCount: activeWarnings.length,
        activeRestrictionCount: Object.values(moderation.restrictions || {}).filter(r => r?.active).length
      }
    }
  };
}

// ===== Authentication Middleware =====

function parseRequestCookies(req) {
  const rawCookieHeader = req.headers?.cookie;
  if (!rawCookieHeader) return {};

  return rawCookieHeader.split(';').reduce((cookies, pair) => {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex === -1) return cookies;

    const key = pair.slice(0, separatorIndex).trim();
    const value = pair.slice(separatorIndex + 1).trim();
    if (!key) return cookies;

    cookies[key] = decodeURIComponent(value);
    return cookies;
  }, {});
}

function setAuthSessionCookie(res, sessionCookie) {
  return applyAuthSessionCookie(res, sessionCookie, { nodeEnv: config.nodeEnv });
}

function clearAuthSessionCookie(res) {
  return removeAuthSessionCookie(res, { nodeEnv: config.nodeEnv });
}

/**
 * Verify Firebase ID token
 */
async function verifyAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    const sessionCookie = parseRequestCookies(req)[AUTH_SESSION_COOKIE_NAME];

    let decodedToken;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      decodedToken = await admin.auth().verifyIdToken(token);
    } else if (sessionCookie) {
      decodedToken = await admin.auth().verifySessionCookie(sessionCookie, true);
    } else {
      return res.status(401).json({
        error: true,
        code: 'AUTH_REQUIRED',
        message: 'Authentication required'
      });
    }
    
    req.user = {
      uid: decodedToken.uid,
      email: decodedToken.email,
      emailVerified: decodedToken.email_verified === true
    };

    // Load profile once so downstream middleware/routes can reuse it.
    const profile = await getStoredUserProfile(decodedToken.uid);
    req.userProfile = profile;

    if (profile?.securitySettings?.requireVerifiedEmailForSensitiveActions === true
      || profile?.securitySettings?.requireVerifiedEmailForLogin === true) {
      req.userProfile = {
        ...profile,
        securitySettings: {
          ...(profile.securitySettings || {}),
          requireVerifiedEmailForSensitiveActions: false,
          requireVerifiedEmailForLogin: false
        }
      };

      setStoredUserProfile(decodedToken.uid, {
        securitySettings: {
          requireVerifiedEmailForSensitiveActions: false,
          requireVerifiedEmailForLogin: false
        }
      }, { merge: true }).catch((error) => {
        logger.warn('Failed to clear deprecated email-verification settings', {
          userId: decodedToken.uid,
          error
        });
      });
    }

    const isReadOnlyRequest = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
    if (!isReadOnlyRequest && !hasAdminAccess(profile || {}, decodedToken.email)) {
      const moderationState = await getUserModerationState(decodedToken.uid, profile);

      if (moderationState.blacklisted) {
        return res.status(403).json({
          error: true,
          code: 'ACCOUNT_BLACKLISTED',
          message: 'Your account is blacklisted and cannot perform this action.',
          moderation: {
            blacklisted: true,
            reason: moderationState.blacklistEntry?.reason || 'Blacklisted',
            expiresAt: moderationState.blacklistEntry?.expiresAt || null
          }
        });
      }

      const restrictionKeys = getRestrictionKeysForRequest(req.path, req.method);
      const activeRestrictionKey = restrictionKeys.find((restrictionKey) => moderationState.restrictions?.[restrictionKey]?.active);
      const activeRestriction = activeRestrictionKey ? moderationState.restrictions?.[activeRestrictionKey] : null;
      if (activeRestriction?.active) {
        return res.status(403).json({
          error: true,
          code: 'FEATURE_RESTRICTED',
          message: `This feature is temporarily disabled for your account (${activeRestrictionKey}).`,
          moderation: {
            restriction: activeRestrictionKey,
            reason: activeRestriction.reason || 'Restricted by admin',
            expiresAt: activeRestriction.expiresAt || null
          }
        });
      }
    }

    next();
  } catch (error) {
    logger.warn('Authentication verification failed', {
      path: req.path,
      method: req.method,
      error
    });
    return res.status(401).json({
      error: true,
      code: 'AUTH_INVALID',
      message: 'Invalid or expired token'
    });
  }
}

/**
 * Combined auth and ban check
 */
async function verifyAuthAndNotBanned(req, res, next) {
  await verifyAuth(req, res, (err) => {
    if (err || res.headersSent) return;
    checkBanned(req, res, next);
  });
}

/**
 * Verify admin or tester role
 */
async function verifyAdminOrTester(req, res, next) {
  try {
    const profile = req.userProfile || await getStoredUserProfile(req.user.uid);

    const role = getAdminRole(profile || {}, req.user.email);
    const isRoleAdmin = Boolean(role);

    if (!profile || (!isRoleAdmin && !profile.tester)) {
      logger.warn('Admin/tester access denied', { userId: req.user.uid, path: req.path });
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Admin or tester access required'
      });
    }

    req.userProfile = profile;
    next();
  } catch (error) {
    logger.error('Admin/tester verification failed', { userId: req.user?.uid, error });
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Verification error'
    });
  }
}

/**
 * Verify admin role
 */
async function verifyAdmin(req, res, next) {
  try {
    const profile = req.userProfile || await getStoredUserProfile(req.user.uid);
    const role = getAdminRole(profile || {}, req.user.email);
    let capabilities = role ? getAdminCapabilities(role) : [];
    let resolvedRole = role;

    if (!resolvedRole && profile) {
      const roleMap = await getAllStaffRoles().catch(() => ({}));
      const staffRole = resolveStaffRoleForProfile(profile, roleMap);
      const staffAdminContext = resolveStaffAdminContext(staffRole);
      if (staffAdminContext) {
        resolvedRole = staffAdminContext.role;
        capabilities = staffAdminContext.capabilities;
        req.staffRoleContext = staffRole;
      }
    }

    if (!profile || !resolvedRole) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Admin access required'
      });
    }

    req.adminContext = {
      role: resolvedRole,
      capabilities
    };
    req.userProfile = profile;
    next();
  } catch (error) {
    logger.error('Admin verification failed', { userId: req.user?.uid, error });
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error verifying admin status'
    });
  }
}

/**
 * Verify tester role
 */
async function verifyTester(req, res, next) {
  try {
    const profile = req.userProfile || await getStoredUserProfile(req.user.uid);
    const isRoleAdmin = hasAdminAccess(profile || {}, req.user.email);
    
    if (!profile || (!profile.tester && !isRoleAdmin)) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Tester access required'
      });
    }
    
    req.userProfile = profile;
    next();
  } catch (error) {
    logger.error('Tester verification failed', { userId: req.user?.uid, error });
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error verifying tier tester status'
    });
  }
}

function getRecaptchaVerificationInput(req) {
  const token = String(
    req.headers['x-recaptcha-token']
    || req.body?.recaptchaToken
    || req.body?.captchaToken
    || ''
  ).trim();

  const action = String(
    req.headers['x-recaptcha-action']
    || req.body?.recaptchaAction
    || req.body?.captchaAction
    || ''
  ).trim();

  return { token, action };
}

async function verifyRecaptchaToken({ token, remoteIp }) {
  const payload = new URLSearchParams({
    secret: config.recaptchaSecretKey,
    response: token
  });

  if (remoteIp) {
    payload.set('remoteip', remoteIp);
  }

  const response = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: payload.toString()
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('reCAPTCHA verification request failed');
    error.response = result;
    throw error;
  }

  return result;
}

async function requireRecaptcha(req, res, next) {
  if (!config.recaptchaSecretKey) {
    if (config.nodeEnv === 'production') {
      logger.error('reCAPTCHA is required in production but CAPTCHA_SECRET is not configured');
    }
    return next();
  }

  const trustedUntil = getTrustedRecaptchaExpiry(req);
  if (trustedUntil > Date.now()) {
    req.recaptcha = {
      action: 'trusted_cookie',
      score: null,
      hostname: null,
      trustedUntil
    };
    return next();
  }

  const { token, action } = getRecaptchaVerificationInput(req);
  if (!token) {
    return res.status(400).json({
      error: true,
      code: 'CAPTCHA_REQUIRED',
      message: 'Verification is required before this action can continue.'
    });
  }

  try {
    const verification = await verifyRecaptchaToken({
      token,
      remoteIp: getClientIP(req)
    });

    const verifiedAction = String(verification?.action || '').trim();
    const score = Number(verification?.score);
    const minimumScore = 0.5;

    if (!verification?.success) {
      logger.warn('reCAPTCHA verification rejected request', {
        path: req.path,
        errors: verification?.['error-codes'] || [],
        score: Number.isFinite(score) ? score : null
      });
      return res.status(403).json({
        error: true,
        code: 'CAPTCHA_FAILED',
        message: 'Verification failed. Please refresh and try again.'
      });
    }

    if (action && verifiedAction && action !== verifiedAction) {
      logger.warn('reCAPTCHA action mismatch', {
        path: req.path,
        expectedAction: action,
        verifiedAction
      });
      return res.status(403).json({
        error: true,
        code: 'CAPTCHA_ACTION_MISMATCH',
        message: 'Verification did not match this action. Please try again.'
      });
    }

    if (Number.isFinite(score) && score < minimumScore) {
      logger.warn('reCAPTCHA score below threshold', {
        path: req.path,
        action: verifiedAction || action || null,
        score
      });
      return res.status(403).json({
        error: true,
        code: 'CAPTCHA_SCORE_TOO_LOW',
        message: 'This request could not be verified. Please try again later.'
      });
    }

    req.recaptcha = {
      action: verifiedAction || action || null,
      score: Number.isFinite(score) ? score : null,
      hostname: verification?.hostname || null
    };
    setRecaptchaTrustCookie(res);
    return next();
  } catch (error) {
    logger.error('reCAPTCHA verification failed unexpectedly', {
      path: req.path,
      error
    });
    return res.status(503).json({
      error: true,
      code: 'CAPTCHA_UNAVAILABLE',
      message: 'Verification is temporarily unavailable. Please try again shortly.'
    });
  }
}

function parseDateToMs(value) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

function getRestrictionKeysForRequest(reqPath, method) {
  const m = String(method || 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return [];

  const restrictionKeys = [];

  if (reqPath === '/api/queue/join') {
    restrictionKeys.push('queue_join', 'queue');
  } else if (reqPath === '/api/queue/leave') {
    restrictionKeys.push('queue_leave', 'queue');
  } else if (reqPath.startsWith('/api/queue/')) {
    restrictionKeys.push('queue');
  }

  if (reqPath.startsWith('/api/tier-tester/apply')) {
    restrictionKeys.push('applications_submit', 'applications');
  }

  if (reqPath === '/api/submit-player-report') {
    restrictionKeys.push('report_submit', 'reports');
  } else if (reqPath.startsWith('/api/reports') || reqPath.startsWith('/api/report')) {
    restrictionKeys.push('reports');
  }

  if (reqPath.includes('/chat') || reqPath.includes('/messages')) {
    restrictionKeys.push('chat');
  }

  if (reqPath.startsWith('/api/support/tickets/') && reqPath.endsWith('/messages')) {
    restrictionKeys.push('support_messages');
  }

  if (reqPath.startsWith('/api/users/me') || reqPath.startsWith('/api/account/') || reqPath.startsWith('/api/plus/')) {
    restrictionKeys.push('account_changes');
  }

  return [...new Set(restrictionKeys)];
}

function isUserRetiredFromGamemode(profile, gamemode) {
  if (!profile || !gamemode) return false;
  return profile.retiredGamemodes?.[gamemode] === true;
}

const ALLOWED_REGIONS = new Set(['NA', 'EU', 'AS', 'SA', 'AU']);

function normalizeAvailabilitySelections(body = {}) {
  const rawGamemodes = Array.isArray(body.gamemodes)
    ? body.gamemodes
    : (body.gamemode ? [body.gamemode] : []);
  const rawRegions = Array.isArray(body.regions)
    ? body.regions
    : (body.region ? [body.region] : []);

  const gamemodes = [...new Set(rawGamemodes.map((value) => String(value || '').trim()).filter(Boolean))];
  const regions = [...new Set(rawRegions.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];

  return { gamemodes, regions };
}

function normalizeQueueSelections(body = {}) {
  const rawGamemodes = Array.isArray(body.gamemodes)
    ? body.gamemodes
    : (body.gamemode ? [body.gamemode] : []);
  const rawRegions = Array.isArray(body.regions)
    ? body.regions
    : (body.region ? [body.region] : []);

  const gamemodes = [...new Set(rawGamemodes.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
  const regions = [...new Set(rawRegions.map((value) => String(value || '').trim().toUpperCase()).filter(Boolean))];

  return { gamemodes, regions };
}

async function getCanonicalWhitelistedServerIP(serverIP) {
  const sanitizedServerIP = String(serverIP || '').trim();
  if (!sanitizedServerIP) {
    return null;
  }

  const whitelistedServersSnapshot = await db.ref('whitelistedServers').once('value');
  const whitelistedServers = whitelistedServersSnapshot.val() || {};
  const matchingServer = Object.values(whitelistedServers).find((server) => (
    server?.ip && String(server.ip).trim().toLowerCase() === sanitizedServerIP.toLowerCase()
  ));

  return matchingServer?.ip ? String(matchingServer.ip).trim() : null;
}

async function getUserPreferredServerIP(userId, fallbackServerIP = null) {
  if (userId) {
    const queueSnapshot = await db.ref('queue').orderByChild('userId').equalTo(userId).once('value');
    const queueEntries = Object.values(queueSnapshot.val() || {}).filter((entry) => entry?.serverIP);
    const preferredEntry = queueEntries.find((entry) => getQueueRolePreference(entry) === 'player') || queueEntries[0];
    const preferredServerIP = await getCanonicalWhitelistedServerIP(preferredEntry?.serverIP);
    if (preferredServerIP) {
      return {
        serverIP: preferredServerIP,
        source: 'player_queue'
      };
    }
  }

  const fallbackResolved = await getCanonicalWhitelistedServerIP(fallbackServerIP);
  return {
    serverIP: fallbackResolved,
    source: fallbackResolved ? 'request' : null
  };
}

const QUEUE_COOLDOWN_MS = 30 * 60 * 1000;

function getQueueCooldownState(userProfile = {}, gamemode) {
  if (!gamemode) {
    return { allowed: true };
  }

  const normalizedGamemode = String(gamemode).trim().toLowerCase();
  const lastTestCompletions = userProfile.lastTestCompletions || {};
  const lastQueueJoins = userProfile.lastQueueJoins || {};
  const nowMs = Date.now();

  const lastTestCompletion = lastTestCompletions[normalizedGamemode];
  if (lastTestCompletion) {
    const completedAtMs = new Date(lastTestCompletion).getTime();
    if (Number.isFinite(completedAtMs)) {
      const remainingMs = QUEUE_COOLDOWN_MS - (nowMs - completedAtMs);
      if (remainingMs > 0) {
        return {
          allowed: false,
          remainingMs,
          type: 'testing',
          startedAt: lastTestCompletion,
          reason: 'You were recently tested in this gamemode. Please wait before queuing again.'
        };
      }
    }
  }

  const lastQueueJoin = lastQueueJoins[normalizedGamemode];
  if (lastQueueJoin) {
    const joinedAtMs = new Date(lastQueueJoin).getTime();
    if (Number.isFinite(joinedAtMs)) {
      const remainingMs = QUEUE_COOLDOWN_MS - (nowMs - joinedAtMs);
      if (remainingMs > 0) {
        return {
          allowed: false,
          remainingMs,
          type: 'queue',
          startedAt: lastQueueJoin,
          reason: 'You recently completed a match in this gamemode.'
        };
      }
    }
  }

  return { allowed: true };
}

function getQueueGamemodeList(entry = {}) {
  if (Array.isArray(entry.gamemodes) && entry.gamemodes.length > 0) {
    return entry.gamemodes.filter(Boolean);
  }
  return entry.gamemode ? [entry.gamemode] : [];
}

function getQueueRegionList(entry = {}) {
  if (Array.isArray(entry.regions) && entry.regions.length > 0) {
    return entry.regions.filter(Boolean);
  }
  return entry.region ? [entry.region] : [];
}

function hasTierTesterQueueRole(profile = {}) {
  return Boolean(
    profile?.tester === true
    || profile?.tierTester === true
    || profile?.admin === true
    || profile?.adminRole
  );
}

function getQueueRolePreference(entry = {}) {
  return entry?.queueRolePreference === 'tester' ? 'tester' : 'player';
}

function isQueueEntryExpired(entry = {}) {
  return Boolean(entry?.timeoutAt && parseDateToMs(entry.timeoutAt) <= Date.now());
}

function isQueueEntryTesterEligible(entry = {}, profile = null) {
  if (typeof entry?.testerEligible === 'boolean') {
    return entry.testerEligible === true;
  }
  if (getQueueRolePreference(entry) === 'tester') {
    return true;
  }
  return hasTierTesterQueueRole(profile || {});
}

function buildQueueEntry({
  queueId,
  userId,
  minecraftUsername,
  gamemodes,
  regions,
  serverIP,
  rolePreference = 'player',
  testerEligible = false,
  source = 'player_queue',
  joinedAt = new Date().toISOString(),
  timeoutAt = null
}) {
  return {
    queueId,
    userId,
    minecraftUsername,
    gamemode: gamemodes[0] || null,
    region: regions[0] || null,
    gamemodes,
    regions,
    serverIP: serverIP || null,
    status: 'waiting',
    joinedAt,
    queueRolePreference: rolePreference === 'tester' ? 'tester' : 'player',
    testerEligible: testerEligible === true,
    queueSource: source,
    timeoutAt: timeoutAt || null
  };
}

function queueEntriesShareCompatibility(entryA = {}, entryB = {}) {
  const gamemodesA = getQueueGamemodeList(entryA);
  const gamemodesB = getQueueGamemodeList(entryB);
  const regionsA = getQueueRegionList(entryA);
  const regionsB = getQueueRegionList(entryB);

  const sharedGamemode = gamemodesA.some((gamemode) => gamemodesB.includes(gamemode));
  const sharedRegion = regionsA.some((region) => regionsB.includes(region));
  return sharedGamemode && sharedRegion;
}

async function buildQueueStatusSummary(currentEntry = {}, currentUserId = null, prefetched = {}) {
  const [queueSnapshot, activeMatchesSnapshot] = await Promise.all([
    prefetched.queueEntries ? null : db.ref('queue').once('value'),
    prefetched.activeMatches ? null : db.ref('matches').orderByChild('status').equalTo('active').once('value')
  ]);

  const queueEntries = prefetched.queueEntries || queueSnapshot?.val?.() || {};
  const activeMatches = prefetched.activeMatches || activeMatchesSnapshot?.val?.() || {};
  const busyUserIds = new Set();

  Object.values(activeMatches).forEach((match) => {
    if (!match || match.finalized) return;
    if (match.playerId) busyUserIds.add(match.playerId);
    if (match.testerId) busyUserIds.add(match.testerId);
  });

  const queueList = Object.values(queueEntries).filter((entry) => (
    entry?.userId
    && !busyUserIds.has(entry.userId)
    && getQueueGamemodeList(entry).length > 0
    && getQueueRegionList(entry).length > 0
    && !isQueueEntryExpired(entry)
  ));

  const compatibleEntries = queueList.filter((entry) => queueEntriesShareCompatibility(currentEntry, entry));
  const compatiblePlayers = compatibleEntries.filter((entry) => getQueueRolePreference(entry) !== 'tester');
  const compatibleTesters = compatibleEntries.filter((entry) => getQueueRolePreference(entry) === 'tester');
  const currentRolePreference = getQueueRolePreference(currentEntry);
  const sameRoleEntries = (currentRolePreference === 'tester' ? compatibleTesters : compatiblePlayers)
    .slice()
    .sort((entryA, entryB) => parseDateToMs(entryA?.joinedAt) - parseDateToMs(entryB?.joinedAt));

  const currentEntryIndex = sameRoleEntries.findIndex((entry) => (
    entry?.queueId === currentEntry?.queueId
    || (entry?.userId === currentUserId && parseDateToMs(entry?.joinedAt) === parseDateToMs(currentEntry?.joinedAt))
  ));
  const yourPosition = currentEntryIndex >= 0 ? currentEntryIndex + 1 : 1;

  let estimatedWaitMinutes = null;
  if (currentRolePreference === 'tester') {
    if (compatiblePlayers.length > 0) {
      estimatedWaitMinutes = Math.max(1, Math.ceil(yourPosition / compatiblePlayers.length) * 2);
    }
  } else if (compatibleTesters.length > 0) {
    estimatedWaitMinutes = Math.max(1, Math.ceil(yourPosition / compatibleTesters.length) * 2);
  }

  return {
    rolePreference: currentRolePreference,
    compatiblePlayers: compatiblePlayers.length,
    compatibleTesters: compatibleTesters.length,
    yourPosition,
    estimatedWaitMinutes
  };
}

function canUserBeAssignedPlayer(profile = {}, gamemode) {
  return getQueueCooldownState(profile, gamemode).allowed;
}

function resolveQueuedRoleAssignment(entryA, entryB, profileA = {}, profileB = {}, gamemode = null) {
  const entryAEligible = isQueueEntryTesterEligible(entryA, profileA);
  const entryBEligible = isQueueEntryTesterEligible(entryB, profileB);
  const entryACanBePlayer = canUserBeAssignedPlayer(profileA, gamemode);
  const entryBCanBePlayer = canUserBeAssignedPlayer(profileB, gamemode);
  const gamemodeLabel = String(gamemode || 'this gamemode').trim().toUpperCase();

  if (!entryAEligible && !entryBEligible) {
    return null;
  }

  if (entryAEligible && !entryBEligible) {
    if (!entryBCanBePlayer) {
      return null;
    }

    return {
      player: entryB,
      tester: entryA,
      assignmentType: 'single_tier_tester',
      explanation: `${entryA.minecraftUsername || 'The assigned tester'} was chosen as the tier tester because only they have the Tier Tester role.`,
      playerReason: `${entryB.minecraftUsername || 'This player'} stayed in the player slot because the other queued participant is the only Tier Tester.`,
      testerReason: `${entryA.minecraftUsername || 'This player'} was assigned as the tier tester because they are the only Tier Tester in this pairing.`
    };
  }

  if (!entryAEligible && entryBEligible) {
    if (!entryACanBePlayer) {
      return null;
    }

    return {
      player: entryA,
      tester: entryB,
      assignmentType: 'single_tier_tester',
      explanation: `${entryB.minecraftUsername || 'The assigned tester'} was chosen as the tier tester because only they have the Tier Tester role.`,
      playerReason: `${entryA.minecraftUsername || 'This player'} stayed in the player slot because the other queued participant is the only Tier Tester.`,
      testerReason: `${entryB.minecraftUsername || 'This player'} was assigned as the tier tester because they are the only Tier Tester in this pairing.`
    };
  }

  if (!entryACanBePlayer && !entryBCanBePlayer) {
    return null;
  }

  if (!entryACanBePlayer && entryBCanBePlayer) {
    return {
      player: entryB,
      tester: entryA,
      assignmentType: 'dual_tier_tester_cooldown_priority',
      explanation: `${entryA.minecraftUsername || 'One queued user'} was kept as the tier tester because they are on ${gamemodeLabel} cooldown, so ${entryB.minecraftUsername || 'the other queued user'} must take the player slot.`,
      playerReason: `${entryB.minecraftUsername || 'This player'} was assigned as the player because the other queued Tier Tester is still on ${gamemodeLabel} cooldown.`,
      testerReason: `${entryA.minecraftUsername || 'This player'} was assigned as the tier tester because they are still on ${gamemodeLabel} cooldown and cannot take the player slot.`
    };
  }

  if (entryACanBePlayer && !entryBCanBePlayer) {
    return {
      player: entryA,
      tester: entryB,
      assignmentType: 'dual_tier_tester_cooldown_priority',
      explanation: `${entryB.minecraftUsername || 'One queued user'} was kept as the tier tester because they are on ${gamemodeLabel} cooldown, so ${entryA.minecraftUsername || 'the other queued user'} must take the player slot.`,
      playerReason: `${entryA.minecraftUsername || 'This player'} was assigned as the player because the other queued Tier Tester is still on ${gamemodeLabel} cooldown.`,
      testerReason: `${entryB.minecraftUsername || 'This player'} was assigned as the tier tester because they are still on ${gamemodeLabel} cooldown and cannot take the player slot.`
    };
  }

  const randomizeEntryAAsTester = Math.random() >= 0.5;
  const tester = randomizeEntryAAsTester ? entryA : entryB;
  const player = randomizeEntryAAsTester ? entryB : entryA;

  return {
    player,
    tester,
    assignmentType: 'dual_tier_tester_random',
    explanation: 'Both queued players have the Tier Tester role, so the system randomly assigned one as tester and one as player.',
    playerReason: `${player.minecraftUsername || 'This player'} was randomly assigned as the player because both queued users are Tier Testers.`,
    testerReason: `${tester.minecraftUsername || 'This player'} was randomly assigned as the tester because both queued users are Tier Testers.`,
    randomized: true
  };
}

function getSharedQueueSelections(entryA = {}, entryB = {}) {
  const gamemodesA = getQueueGamemodeList(entryA);
  const gamemodesB = new Set(getQueueGamemodeList(entryB));
  const regionsA = getQueueRegionList(entryA);
  const regionsB = new Set(getQueueRegionList(entryB));
  const sharedSelections = [];

  for (const gamemode of gamemodesA) {
    if (!gamemodesB.has(gamemode)) continue;
    for (const region of regionsA) {
      if (regionsB.has(region)) {
        sharedSelections.push({ gamemode, region });
      }
    }
  }

  return sharedSelections;
}

async function clearUserQueueEntries(userId) {
  if (!userId) return 0;

  const queueRef = db.ref('queue');
  const queueSnapshot = await queueRef.orderByChild('userId').equalTo(userId).once('value');
  if (!queueSnapshot.exists()) return 0;

  const updates = {};
  let removedCount = 0;
  queueSnapshot.forEach((child) => {
    updates[child.key] = null;
    removedCount++;
  });

  await queueRef.update(updates);
  return removedCount;
}

function isFeatureTemporarilyUnblocked(tempUnblock, restrictionKey) {
  if (!tempUnblock || !restrictionKey) return false;
  const now = Date.now();

  if (parseDateToMs(tempUnblock.expiresAt) > now || parseDateToMs(tempUnblock.allUntil) > now) {
    return true;
  }

  const featureUntil = tempUnblock.features?.[restrictionKey];
  if (featureUntil && parseDateToMs(featureUntil) > now) {
    return true;
  }

  return false;
}

function isBlacklistEntryActive(entry) {
  if (!entry) return false;
  const expiresAtMs = parseDateToMs(entry.expiresAt);
  return !expiresAtMs || expiresAtMs > Date.now();
}

function normalizeRestrictions(rawRestrictions = {}) {
  const normalized = {};
  Object.entries(rawRestrictions || {}).forEach(([key, value]) => {
    if (value === true) {
      normalized[key] = { active: true, reason: 'Restricted by admin', expiresAt: null, source: 'user' };
      return;
    }
    if (value && typeof value === 'object') {
      const expiresAt = value.expiresAt || null;
      const active = value.active !== false && (!expiresAt || parseDateToMs(expiresAt) > Date.now());
      normalized[key] = {
        active,
        reason: value.reason || 'Restricted by admin',
        expiresAt,
        source: value.source || 'user'
      };
    }
  });
  return normalized;
}

function blacklistEntryMatchesIdentity(entry, identity = {}) {
  if (!entry || !identity) return false;

  const entryUserId = String(entry.userId || '').trim();
  const entryUsername = normalizeMinecraftUsername(entry.username);
  const entryUuid = normalizeMinecraftUUID(entry.minecraftUUID || entry.uuid);
  const identityUserId = String(identity.userId || '').trim();
  const identityUsername = normalizeMinecraftUsername(identity.username);
  const identityUuid = normalizeMinecraftUUID(identity.uuid || identity.minecraftUUID);

  return Boolean(
    (entryUserId && identityUserId && entryUserId === identityUserId) ||
    (entryUsername && identityUsername && entryUsername === identityUsername) ||
    (entryUuid && identityUuid && entryUuid === identityUuid)
  );
}

async function findActiveBlacklistEntry(identity = {}) {
  const blacklistSnapshot = await db.ref('blacklist').once('value');
  const blacklist = blacklistSnapshot.val() || {};

  for (const [id, entry] of Object.entries(blacklist)) {
    if (!isBlacklistEntryActive(entry)) continue;
    if (!blacklistEntryMatchesIdentity(entry, identity)) continue;
    return { id, ...entry };
  }

  return null;
}

async function ensureMinecraftUuidLinkedForUser(userId, profileInput = null) {
  try {
    if (!userId) return profileInput || null;

    const userRef = db.ref(`users/${userId}`);
    const profile = profileInput || (await userRef.once('value')).val() || null;
    if (!profile) return null;

    const currentUsername = String(profile.minecraftUsername || '').trim();
    const currentUuid = normalizeMinecraftUUID(profile.minecraftUUID);
    if (!currentUsername || currentUuid) {
      return profile;
    }

    const mojangProfile = await fetchMojangProfile(currentUsername).catch(() => null);
    if (!mojangProfile?.uuid) {
      return profile;
    }

    const resolvedUuid = normalizeMinecraftUUID(mojangProfile.uuid);
    if (!resolvedUuid) {
      return profile;
    }

    const canonicalUsername = mojangProfile.username || currentUsername;
    const updates = {
      minecraftUUID: resolvedUuid,
      pendingMinecraftUUID: null,
      updatedAt: new Date().toISOString()
    };

    if (canonicalUsername !== currentUsername) {
      updates.minecraftUsername = canonicalUsername;
    }

    await userRef.update(updates);

    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.once('value');
    const players = playersSnapshot.val() || {};
    const normalizedCurrent = normalizeMinecraftUsername(currentUsername);
    const normalizedCanonical = normalizeMinecraftUsername(canonicalUsername);

    const batchUpdates = {};

    for (const [playerId, player] of Object.entries(players)) {
      const normalizedPlayerUsername = normalizeMinecraftUsername(player?.username);
      const matchesUser = (player?.userId && player.userId === userId)
        || (normalizedPlayerUsername && (normalizedPlayerUsername === normalizedCurrent || normalizedPlayerUsername === normalizedCanonical));

      if (!matchesUser) continue;

      batchUpdates[`${playerId}/minecraftUUID`] = resolvedUuid;
      batchUpdates[`${playerId}/updatedAt`] = new Date().toISOString();

      if (canonicalUsername && player?.username !== canonicalUsername) {
        batchUpdates[`${playerId}/username`] = canonicalUsername;
      }
    }

    if (Object.keys(batchUpdates).length > 0) {
      await playersRef.update(batchUpdates);
    }

    return {
      ...profile,
      ...updates,
      minecraftUsername: canonicalUsername
    };
  } catch (error) {
    console.warn('Unable to auto-link Minecraft UUID for user:', userId, error?.message || error);
    return profileInput || null;
  }
}

const pendingMinecraftUuidLinkLookups = new Map();

function shouldEnrichMinecraftUuid(profile = {}) {
  const currentUsername = String(profile?.minecraftUsername || '').trim();
  const currentUuid = normalizeMinecraftUUID(profile?.minecraftUUID);
  return Boolean(currentUsername) && !currentUuid;
}

function triggerMinecraftUuidLinkForUser(userId, profileInput = null) {
  if (!userId || !shouldEnrichMinecraftUuid(profileInput || {})) {
    return Promise.resolve(profileInput || null);
  }

  if (pendingMinecraftUuidLinkLookups.has(userId)) {
    return pendingMinecraftUuidLinkLookups.get(userId);
  }

  const promise = ensureMinecraftUuidLinkedForUser(userId, profileInput)
    .catch((error) => {
      console.warn('Deferred Minecraft UUID linking failed:', userId, error?.message || error);
      return profileInput || null;
    })
    .finally(() => {
      pendingMinecraftUuidLinkLookups.delete(userId);
    });

  pendingMinecraftUuidLinkLookups.set(userId, promise);
  return promise;
}

// Cache blacklist data for getUserModerationState to avoid reloading per-request
const blacklistCache = { data: null, updatedAt: 0, ttl: 10000 }; // 10s TTL

async function getBlacklistCached() {
  const now = Date.now();
  if (blacklistCache.data && (now - blacklistCache.updatedAt) < blacklistCache.ttl) {
    return blacklistCache.data;
  }
  const snapshot = await db.ref('blacklist').once('value');
  blacklistCache.data = snapshot.val() || {};
  blacklistCache.updatedAt = now;
  return blacklistCache.data;
}

async function getUserModerationState(userId, profileInput = null) {
  try {
    if (!userId) {
      return {
        blacklisted: false,
        blacklistEntry: null,
        restrictions: {}
      };
    }

    const profile = profileInput || (await getStoredUserProfile(userId)) || {};
    const username = String(profile.minecraftUsername || '').toLowerCase();
  const minecraftUUID = normalizeMinecraftUUID(profile.minecraftUUID);

    const [blacklist, tempUnblockSnapshot] = await Promise.all([
      getBlacklistCached(),
      db.ref(`tempUnblocks/${userId}`).once('value')
    ]);

    // blacklist is already an object from cache
    const tempUnblock = tempUnblockSnapshot.val() || null;

    let activeBlacklistEntry = null;
    for (const [id, entry] of Object.entries(blacklist)) {
      const matchesUser = blacklistEntryMatchesIdentity(entry, {
        userId,
        username,
        uuid: minecraftUUID
      });
      if (!matchesUser || !isBlacklistEntryActive(entry)) continue;
      activeBlacklistEntry = { id, ...entry };
      break;
    }

    const userRestrictions = normalizeRestrictions(profile.functionRestrictions || {});

    if (activeBlacklistEntry?.disabledFunctions && typeof activeBlacklistEntry.disabledFunctions === 'object') {
      Object.entries(activeBlacklistEntry.disabledFunctions).forEach(([key, enabled]) => {
        if (enabled !== true) return;
        userRestrictions[key] = {
          active: true,
          reason: activeBlacklistEntry.reason || 'Restricted by blacklist',
          expiresAt: activeBlacklistEntry.expiresAt || null,
          source: 'blacklist'
        };
      });
    }

    Object.keys(userRestrictions).forEach((restrictionKey) => {
      if (isFeatureTemporarilyUnblocked(tempUnblock, restrictionKey)) {
        userRestrictions[restrictionKey] = {
          ...userRestrictions[restrictionKey],
          active: false,
          temporarilyUnblocked: true
        };
      }
    });

    const blacklistTemporarilyUnblocked = isFeatureTemporarilyUnblocked(tempUnblock, 'all') || isFeatureTemporarilyUnblocked(tempUnblock, 'blacklist');

    return {
      blacklisted: Boolean(activeBlacklistEntry) && !blacklistTemporarilyUnblocked,
      blacklistEntry: activeBlacklistEntry,
      restrictions: userRestrictions,
      temporaryUnblock: tempUnblock,
      blacklistTemporarilyUnblocked
    };
  } catch (error) {
    console.error('Error building moderation state:', error);
    return {
      blacklisted: false,
      blacklistEntry: null,
      restrictions: {}
    };
  }
}

/**
 * Check if a username is blacklisted
 */
async function isUsernameBlacklisted(username) {
  try {
    const entry = await findActiveBlacklistEntry({ username });
    return Boolean(entry);
  } catch (error) {
    console.error('Error checking blacklist:', error);
    return false;
  }
}

/**
 * Detect rating manipulation patterns
 * ToS Section 5: Detect and prevent rating manipulation
 */
async function detectRatingManipulation(userId, gamemode, matchResult) {
  try {
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('userId').equalTo(userId).once('value');
    const players = playerSnapshot.val() || {};
    const playerData = Object.values(players).find(p => p.userId === userId);
    
    if (!playerData) return { suspicious: false };

    const matchesRef = db.ref('matches');
    const matchesSnapshot = await matchesRef
      .orderByChild('playerId')
      .equalTo(userId)
      .limitToLast(100)
      .once('value');
    
    const allMatches = matchesSnapshot.val() || {};
    const gamemodeMatches = Object.values(allMatches).filter(m => 
      m.gamemode === gamemode && m.finalized && m.status === 'ended'
    );

    if (gamemodeMatches.length < 5) return { suspicious: false }; // Need at least 5 matches

    // Check for suspicious patterns
    const suspiciousPatterns = [];

    // Pattern 1: Unusually consistent win/loss streaks
    const recentMatches = gamemodeMatches.slice(-10).reverse();
    let winStreak = 0;
    let lossStreak = 0;
    let maxWinStreak = 0;
    let maxLossStreak = 0;
    
    for (const match of recentMatches) {
      const playerWon = match.finalizationData?.playerScore > match.finalizationData?.testerScore;
      if (playerWon) {
        winStreak++;
        lossStreak = 0;
        maxWinStreak = Math.max(maxWinStreak, winStreak);
      } else {
        lossStreak++;
        winStreak = 0;
        maxLossStreak = Math.max(maxLossStreak, lossStreak);
      }
    }

    // Suspicious if win/loss streaks are too consistent (possible rigging)
    if (maxWinStreak >= 8 || maxLossStreak >= 8) {
      suspiciousPatterns.push({
        type: 'suspicious_streak',
        severity: 'high',
        description: `Unusually consistent ${maxWinStreak >= 8 ? 'win' : 'loss'} streak of ${Math.max(maxWinStreak, maxLossStreak)} matches`
      });
    }

    // Pattern 2: Rapid rating changes (possible manipulation)
    const ratingChanges = recentMatches.map(m => {
      const change = m.finalizationData?.ratingChanges?.playerRatingChange || 0;
      return Math.abs(change);
    });
    const avgRatingChange = ratingChanges.reduce((a, b) => a + b, 0) / ratingChanges.length;
    
    if (avgRatingChange > 50 && recentMatches.length >= 5) {
      suspiciousPatterns.push({
        type: 'rapid_rating_changes',
        severity: 'medium',
        description: `Average rating change of ${avgRatingChange.toFixed(1)} points per match (unusually high)`
      });
    }

    // Pattern 3: Playing same opponent repeatedly (possible collusion)
    const opponentCounts = {};
    for (const match of recentMatches) {
      const opponentId = match.testerId;
      opponentCounts[opponentId] = (opponentCounts[opponentId] || 0) + 1;
    }
    
    const maxOpponentMatches = Math.max(...Object.values(opponentCounts));
    if (maxOpponentMatches >= 5 && recentMatches.length >= 7) {
      suspiciousPatterns.push({
        type: 'repeated_opponents',
        severity: 'high',
        description: `Played the same opponent ${maxOpponentMatches} times in recent matches (possible collusion)`
      });
    }

    // Pattern 4: Unusual match timing patterns (bot detection)
    const matchTimes = recentMatches.map(m => new Date(m.createdAt).getTime()).sort((a, b) => a - b);
    const timeDifferences = [];
    for (let i = 1; i < matchTimes.length; i++) {
      timeDifferences.push(matchTimes[i] - matchTimes[i - 1]);
    }
    
    if (timeDifferences.length > 0) {
      const avgTimeDiff = timeDifferences.reduce((a, b) => a + b, 0) / timeDifferences.length;
      const variance = timeDifferences.reduce((sum, diff) => sum + Math.pow(diff - avgTimeDiff, 2), 0) / timeDifferences.length;
      const stdDev = Math.sqrt(variance);
      
      // Very consistent timing suggests automation
      if (stdDev < 60000 && avgTimeDiff < 300000) { // Less than 1 min variance, less than 5 min average
        suspiciousPatterns.push({
          type: 'automated_timing',
          severity: 'high',
          description: 'Matches occur at suspiciously consistent intervals (possible bot/automation)'
        });
      }
    }

    if (suspiciousPatterns.length > 0) {
      // Log suspicious activity
      await addSecurityLogEntry({
        userId,
        gamemode,
        type: 'rating_manipulation',
        patterns: suspiciousPatterns,
        matchCount: gamemodeMatches.length,
        detectedAt: new Date().toISOString(),
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      });

      return {
        suspicious: true,
        patterns: suspiciousPatterns,
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      };
    }

    return { suspicious: false };
  } catch (error) {
    console.error('Error detecting rating manipulation:', error);
    return { suspicious: false };
  }
}

/**
 * Detect bot/automated tool usage
 * ToS Section 4: Prohibit automated tools or bots
 */
async function detectBotActivity(userId, action, metadata = {}) {
  try {
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};

    // Track activity patterns
    const activityLog = userData.activityLog || [];
    const now = Date.now();
    
    // Add current activity
    activityLog.push({
      action,
      timestamp: now,
      metadata
    });

    // Keep only last 100 activities
    const recentActivities = activityLog.slice(-100);

    const suspiciousPatterns = [];

    // Pattern 1: Too many actions in short time (rate limiting bypass)
    const lastMinute = recentActivities.filter(a => now - a.timestamp < 60000);
    if (lastMinute.length > 30) {
      suspiciousPatterns.push({
        type: 'excessive_actions',
        severity: 'high',
        description: `${lastMinute.length} actions in the last minute (possible automation)`
      });
    }

    // Pattern 2: Perfectly consistent timing (bot signature)
    if (recentActivities.length >= 10) {
      const timeDiffs = [];
      for (let i = 1; i < recentActivities.length; i++) {
        timeDiffs.push(recentActivities[i].timestamp - recentActivities[i - 1].timestamp);
      }
      
      if (timeDiffs.length > 0) {
        const avgDiff = timeDiffs.reduce((a, b) => a + b, 0) / timeDiffs.length;
        const variance = timeDiffs.reduce((sum, diff) => sum + Math.pow(diff - avgDiff, 2), 0) / timeDiffs.length;
        const stdDev = Math.sqrt(variance);
        
        // Very low variance suggests automation
        if (stdDev < 100 && avgDiff < 5000) { // Less than 100ms variance
          suspiciousPatterns.push({
            type: 'consistent_timing',
            severity: 'high',
            description: 'Actions occur at suspiciously consistent intervals (bot signature)'
          });
        }
      }
    }

    // Pattern 3: Same action repeated rapidly
    const sameActionCount = recentActivities.filter(a => a.action === action).length;
    if (sameActionCount > 20 && recentActivities.length >= 20) {
      suspiciousPatterns.push({
        type: 'repetitive_actions',
        severity: 'medium',
        description: `Same action (${action}) repeated ${sameActionCount} times rapidly`
      });
    }

    // Update activity log
    await userRef.update({
      activityLog: recentActivities,
      lastActivityAt: new Date().toISOString()
    });

    if (suspiciousPatterns.length > 0) {
      // Log bot activity
      await addSecurityLogEntry({
        userId,
        type: 'bot_activity',
        patterns: suspiciousPatterns,
        action,
        detectedAt: new Date().toISOString(),
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      });

      return {
        suspicious: true,
        patterns: suspiciousPatterns,
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      };
    }

    return { suspicious: false };
  } catch (error) {
    console.error('Error detecting bot activity:', error);
    return { suspicious: false };
  }
}

/**
 * Detect spam in messages
 * ToS Section 6: Prohibit spam or excessive messaging
 */
async function detectSpam(userId, messageText) {
  try {
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};

    const messageLog = userData.messageLog || [];
    const now = Date.now();
    
    // Add current message
    messageLog.push({
      text: messageText,
      timestamp: now
    });

    // Keep only last 50 messages
    const recentMessages = messageLog.slice(-50);

    const suspiciousPatterns = [];

    // Pattern 1: Too many messages in short time
    const lastMinute = recentMessages.filter(m => now - m.timestamp < 60000);
    if (lastMinute.length > 10) {
      suspiciousPatterns.push({
        type: 'message_flood',
        severity: 'high',
        description: `${lastMinute.length} messages in the last minute`
      });
    }

    // Pattern 2: Identical or very similar messages (spam)
    const identicalCount = recentMessages.filter(m => 
      m.text.toLowerCase().trim() === messageText.toLowerCase().trim()
    ).length;
    
    if (identicalCount > 5) {
      suspiciousPatterns.push({
        type: 'repeated_messages',
        severity: 'medium',
        description: `Same message sent ${identicalCount} times`
      });
    }

    // Pattern 3: Very short messages sent rapidly (possible bot)
    if (messageText.length < 5 && recentMessages.length >= 10) {
      const shortMessages = recentMessages.filter(m => m.text.length < 5);
      if (shortMessages.length > 8) {
        suspiciousPatterns.push({
          type: 'short_message_spam',
          severity: 'medium',
          description: 'Many very short messages sent rapidly'
        });
      }
    }

    // Update message log
    await userRef.update({
      messageLog: recentMessages,
      lastMessageAt: new Date().toISOString()
    });

    if (suspiciousPatterns.length > 0) {
      // Log spam activity
      await addSecurityLogEntry({
        userId,
        type: 'spam_detection',
        patterns: suspiciousPatterns,
        messageText: messageText.substring(0, 100), // Store first 100 chars
        detectedAt: new Date().toISOString(),
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      });

      return {
        suspicious: true,
        patterns: suspiciousPatterns,
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      };
    }

    return { suspicious: false };
  } catch (error) {
    console.error('Error detecting spam:', error);
    return { suspicious: false };
  }
}

/**
 * Detect match rigging/collusion
 * ToS Section 4: Prohibit manipulating matches
 */
async function detectMatchRigging(match, result) {
  try {
    const matchesRef = db.ref('matches');
    
    // Check for previous matches between these two users
    const previousMatchesSnapshot = await matchesRef
      .orderByChild('playerId')
      .equalTo(match.playerId)
      .once('value');
    
    const allMatches = previousMatchesSnapshot.val() || {};
    const previousMatches = Object.values(allMatches).filter(m => 
      m.testerId === match.testerId && 
      m.finalized && 
      m.matchId !== match.matchId
    );

    if (previousMatches.length === 0) return { suspicious: false };

    const suspiciousPatterns = [];

    // Pattern 1: Always same winner (possible rigging)
    const playerWins = previousMatches.filter(m => {
      const playerScore = m.finalizationData?.playerScore || m.result?.playerScore || 0;
      const testerScore = m.finalizationData?.testerScore || m.result?.testerScore || 0;
      return playerScore > testerScore;
    }).length;

    const currentPlayerWon = result.playerScore > result.testerScore;
    const totalMatches = previousMatches.length + 1;
    const winRate = currentPlayerWon ? (playerWins + 1) / totalMatches : playerWins / totalMatches;

    // If one player always wins (100% or 0% win rate), suspicious
    if (winRate === 1.0 || winRate === 0.0) {
      suspiciousPatterns.push({
        type: 'consistent_winner',
        severity: 'high',
        description: `One player wins ${(winRate * 100).toFixed(0)}% of matches (${totalMatches} total) - possible rigging`
      });
    }

    // Pattern 2: Suspiciously similar scores (possible pre-arranged)
    const scorePatterns = previousMatches.map(m => {
      const ps = m.finalizationData?.playerScore || m.result?.playerScore || 0;
      const ts = m.finalizationData?.testerScore || m.result?.testerScore || 0;
      return `${ps}-${ts}`;
    });
    
    const currentScorePattern = `${result.playerScore}-${result.testerScore}`;
    const sameScoreCount = scorePatterns.filter(p => p === currentScorePattern).length;
    
    if (sameScoreCount >= 3 && previousMatches.length >= 5) {
      suspiciousPatterns.push({
        type: 'repeated_scores',
        severity: 'medium',
        description: `Same score pattern (${currentScorePattern}) appears ${sameScoreCount + 1} times`
      });
    }

    // Pattern 3: Rapid match completion (possible throw)
    const matchDuration = new Date(match.finalizedAt || new Date()) - new Date(match.createdAt);
    const avgDuration = previousMatches.reduce((sum, m) => {
      const duration = new Date(m.finalizedAt || m.createdAt) - new Date(m.createdAt);
      return sum + duration;
    }, 0) / previousMatches.length;

    // If current match is much shorter than average, suspicious
    if (matchDuration < avgDuration * 0.3 && avgDuration > 300000) { // Less than 30% of average, and average > 5 min
      suspiciousPatterns.push({
        type: 'rapid_completion',
        severity: 'medium',
        description: `Match completed in ${(matchDuration / 1000 / 60).toFixed(1)} minutes (avg: ${(avgDuration / 1000 / 60).toFixed(1)} min) - possible throw`
      });
    }

    if (suspiciousPatterns.length > 0) {
      // Log suspicious match
      await addSecurityLogEntry({
        matchId: match.matchId,
        playerId: match.playerId,
        testerId: match.testerId,
        type: 'match_rigging',
        patterns: suspiciousPatterns,
        result,
        previousMatchesCount: previousMatches.length,
        detectedAt: new Date().toISOString(),
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      });

      return {
        suspicious: true,
        patterns: suspiciousPatterns,
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 'medium'
      };
    }

    return { suspicious: false };
  } catch (error) {
    console.error('Error detecting match rigging:', error);
    return { suspicious: false };
  }
}

/**
 * Detect impersonation attempts
 * ToS Section 4: Prohibit impersonation
 */
async function detectImpersonation(userId, username, minecraftUsername) {
  try {
    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.limitToFirst(1000).once('value');
    const players = playersSnapshot.val() || {};

    const suspiciousPatterns = [];

    // Check for similar usernames (possible impersonation)
    const normalizedInput = (minecraftUsername || username || '').toLowerCase();
    
    for (const [key, player] of Object.entries(players)) {
      if (player.userId === userId) continue; // Skip own account
      
      const normalizedExisting = (player.username || '').toLowerCase();
      
      // Check for very similar usernames (Levenshtein distance)
      if (normalizedInput && normalizedExisting) {
        const similarity = calculateStringSimilarity(normalizedInput, normalizedExisting);
        
        if (similarity > 0.85 && similarity < 1.0) { // Very similar but not identical
          suspiciousPatterns.push({
            type: 'similar_username',
            severity: 'medium',
            description: `Username "${minecraftUsername || username}" is very similar to existing "${player.username}" (${(similarity * 100).toFixed(1)}% similar)`
          });
        }
      }
    }

    // Check for suspicious patterns in username (e.g., adding numbers/symbols to known usernames)
    const knownUsernames = Object.values(players).map(p => p.username?.toLowerCase()).filter(Boolean);
    for (const known of knownUsernames) {
      if (normalizedInput.includes(known) || known.includes(normalizedInput)) {
        if (normalizedInput !== known) {
          suspiciousPatterns.push({
            type: 'username_variation',
            severity: 'low',
            description: `Username appears to be a variation of existing username "${known}"`
          });
        }
      }
    }

    if (suspiciousPatterns.length > 0) {
      // Log impersonation attempt
      await addSecurityLogEntry({
        userId,
        type: 'impersonation_attempt',
        patterns: suspiciousPatterns,
        username: minecraftUsername || username,
        detectedAt: new Date().toISOString(),
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 
                  suspiciousPatterns.some(p => p.severity === 'medium') ? 'medium' : 'low'
      });

      return {
        suspicious: true,
        patterns: suspiciousPatterns,
        severity: suspiciousPatterns.some(p => p.severity === 'high') ? 'high' : 
                  suspiciousPatterns.some(p => p.severity === 'medium') ? 'medium' : 'low'
      };
    }

    return { suspicious: false };
  } catch (error) {
    console.error('Error detecting impersonation:', error);
    return { suspicious: false };
  }
}

/**
 * Detect account activity anomalies
 * Advanced algorithm to detect unusual account behavior patterns
 */
async function detectAccountAnomalies(userId) {
  try {
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};

    const anomalies = [];
    const now = Date.now();

    // Check login patterns
    const lastLoginAt = userData.lastLoginAt ? new Date(userData.lastLoginAt).getTime() : null;
    const createdAt = userData.createdAt ? new Date(userData.createdAt).getTime() : null;
    
    if (lastLoginAt && createdAt) {
      const accountAge = now - createdAt;
      const timeSinceLastLogin = now - lastLoginAt;
      
      // Anomaly: Very new account with high activity
      if (accountAge < 3600000 && userData.activityLog && userData.activityLog.length > 20) { // < 1 hour old, > 20 activities
        anomalies.push({
          type: 'new_account_high_activity',
          severity: 'medium',
          description: 'New account with unusually high activity'
        });
      }

      // Anomaly: Account created but never logged in again
      if (accountAge > 86400000 && timeSinceLastLogin > 86400000 && !userData.minecraftVerified) { // > 1 day old, never logged back in
        anomalies.push({
          type: 'abandoned_account',
          severity: 'low',
          description: 'Account created but never verified or used'
        });
      }
    }

    // Check for rapid rating changes across gamemodes
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('userId').equalTo(userId).once('value');
    const players = playerSnapshot.val() || {};
    const playerData = Object.values(players).find(p => p.userId === userId);
    
    if (playerData && playerData.gamemodeRatings) {
      const ratings = Object.values(playerData.gamemodeRatings);
      const avgRating = ratings.reduce((a, b) => a + b, 0) / ratings.length;
      const ratingVariance = ratings.reduce((sum, rating) => sum + Math.pow(rating - avgRating, 2), 0) / ratings.length;
      
      // Anomaly: Very inconsistent ratings across gamemodes (possible manipulation)
      if (ratingVariance > 100000 && ratings.length > 3) { // High variance
        anomalies.push({
          type: 'inconsistent_ratings',
          severity: 'medium',
          description: 'Unusually inconsistent ratings across gamemodes'
        });
      }
    }

    // Check match participation patterns
    const matchesRef = db.ref('matches');
    const playerMatchesSnapshot = await matchesRef
      .orderByChild('playerId')
      .equalTo(userId)
      .once('value');
    const testerMatchesSnapshot = await matchesRef
      .orderByChild('testerId')
      .equalTo(userId)
      .once('value');
    
    const playerMatches = Object.values(playerMatchesSnapshot.val() || {});
    const testerMatches = Object.values(testerMatchesSnapshot.val() || {});
    const totalMatches = playerMatches.length + testerMatches.length;

    // Anomaly: Very high match participation rate
    if (createdAt) {
      const accountAgeHours = (now - createdAt) / (1000 * 60 * 60);
      const matchesPerHour = totalMatches / accountAgeHours;
      
      if (matchesPerHour > 2 && accountAgeHours > 1) { // More than 2 matches per hour
        anomalies.push({
          type: 'excessive_match_participation',
          severity: 'medium',
          description: `Unusually high match participation rate: ${matchesPerHour.toFixed(2)} matches/hour`
        });
      }
    }

    if (anomalies.length > 0) {
      // Log anomalies
      await addSecurityLogEntry({
        userId,
        type: 'account_anomaly',
        anomalies,
        detectedAt: new Date().toISOString(),
        severity: anomalies.some(a => a.severity === 'high') ? 'high' : 
                  anomalies.some(a => a.severity === 'medium') ? 'medium' : 'low'
      });

      return {
        suspicious: true,
        anomalies,
        severity: anomalies.some(a => a.severity === 'high') ? 'high' : 
                  anomalies.some(a => a.severity === 'medium') ? 'medium' : 'low'
      };
    }

    return { suspicious: false };
  } catch (error) {
    console.error('Error detecting account anomalies:', error);
    return { suspicious: false };
  }
}

/**
 * Automatic flagging system for suspicious accounts
 * Flags accounts that accumulate multiple security violations
 */
async function checkAndFlagSuspiciousAccount(userId) {
  try {
    const logs = await listSecurityLogEntries({ limit: 250, userId });
    
    if (logs.length === 0) return { flagged: false };

    // Count violations by severity
    const highSeverityCount = logs.filter(log => log.severity === 'high').length;
    const mediumSeverityCount = logs.filter(log => log.severity === 'medium').length;
    const totalCount = logs.length;

    // Flag if: 3+ high severity OR 5+ medium severity OR 10+ total violations
    const shouldFlag = highSeverityCount >= 3 || mediumSeverityCount >= 5 || totalCount >= 10;

    if (shouldFlag) {
      const userRef = db.ref(`users/${userId}`);
      const userSnapshot = await userRef.once('value');
      const userData = userSnapshot.val() || {};

      // Check if already flagged
      if (userData.flaggedForReview) {
        return {
          flagged: true,
          alreadyFlagged: true,
          reason: userData.flagReason || 'already flagged for review'
        };
      }

      // Flag account for admin review
      await userRef.update({
        flaggedForReview: true,
        flaggedAt: new Date().toISOString(),
        flagReason: `Multiple security violations detected: ${highSeverityCount} high, ${mediumSeverityCount} medium, ${totalCount} total`,
        flagCount: totalCount
      });

      // Create admin notification
      const notificationsRef = db.ref('adminNotifications').push();
      await notificationsRef.set({
        type: 'suspicious_account_flagged',
        userId,
        username: userData.minecraftUsername || userData.email,
        reason: `Account flagged due to ${totalCount} security violations`,
        severity: highSeverityCount >= 3 ? 'high' : 'medium',
        flaggedAt: new Date().toISOString(),
        violationCounts: {
          high: highSeverityCount,
          medium: mediumSeverityCount,
          total: totalCount
        }
      });

      return {
        flagged: true,
        reason: `Account flagged: ${highSeverityCount} high, ${mediumSeverityCount} medium, ${totalCount} total violations`
      };
    }

    return { flagged: false };
  } catch (error) {
    console.error('Error checking suspicious account:', error);
    return { flagged: false };
  }
}

/**
 * Calculate string similarity using Levenshtein distance
 */
function calculateStringSimilarity(str1, str2) {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j - 1] + 1
        );
      }
    }
  }

  const distance = matrix[len1][len2];
  const maxLen = Math.max(len1, len2);
  return 1 - (distance / maxLen);
}

/**
 * Check and terminate matches for blacklisted users
 */
async function checkAndTerminateBlacklistedMatches() {
  try {
    const matchesRef = db.ref('matches');
    const matchesSnapshot = await matchesRef
      .orderByChild('status')
      .equalTo('active')
      .once('value');
    
    const matches = matchesSnapshot.val() || {};
    const blacklistRef = db.ref('blacklist');
    const blacklistSnapshot = await blacklistRef.once('value');
    const blacklist = blacklistSnapshot.val() || {};
    const blacklistedUsernames = new Set(
      Object.values(blacklist)
        .filter(entry => isBlacklistEntryActive(entry))
        .map(entry => entry.username?.toLowerCase())
        .filter(Boolean)
    );
    
    const judgmentDayRef = db.ref('judgmentDay');
    const judgmentDaySnapshot = await judgmentDayRef.once('value');
    const judgmentDay = judgmentDaySnapshot.val() || {};
    const judgmentDayUserIds = new Set();
    Object.values(judgmentDay).forEach(entry => {
      if (entry.primaryAccount) judgmentDayUserIds.add(entry.primaryAccount);
      if (entry.suspiciousAccounts) {
        entry.suspiciousAccounts.forEach(acc => {
          if (acc.uid) judgmentDayUserIds.add(acc.uid);
        });
      }
    });

    // Batch-load involved users once to avoid per-match roundtrips.
    const involvedUserIds = new Set();
    for (const match of Object.values(matches)) {
      if (match?.playerId) involvedUserIds.add(match.playerId);
      if (match?.testerId) involvedUserIds.add(match.testerId);
    }
    const involvedUserIdsArray = Array.from(involvedUserIds);
    const userSnapshots = await Promise.all(
      involvedUserIdsArray.map(uid => db.ref(`users/${uid}`).once('value'))
    );
    const usersById = new Map();
    for (let i = 0; i < involvedUserIdsArray.length; i++) {
      usersById.set(involvedUserIdsArray[i], userSnapshots[i].val() || {});
    }

    for (const [matchId, match] of Object.entries(matches)) {
      if (match.status !== 'active' || match.finalized) continue;

      const playerUser = usersById.get(match.playerId) || {};
      const testerUser = usersById.get(match.testerId) || {};

      const playerBlacklisted = blacklistedUsernames.has(playerUser.minecraftUsername?.toLowerCase()) || 
                                 judgmentDayUserIds.has(match.playerId);
      const testerBlacklisted = blacklistedUsernames.has(testerUser.minecraftUsername?.toLowerCase()) || 
                                judgmentDayUserIds.has(match.testerId);

      if (playerBlacklisted || testerBlacklisted) {
        const matchRef = db.ref(`matches/${matchId}`);
        
        if (playerBlacklisted && testerBlacklisted) {
          // Both blacklisted - finalize with 0-0
          console.log(`Match ${matchId}: Both players blacklisted, finalizing with 0-0`);
          await matchRef.update({
            status: 'ended',
            finalized: true,
            finalizedAt: new Date().toISOString(),
            result: { playerScore: 0, testerScore: 0 },
            reason: 'Both players blacklisted',
            finalizationData: {
              type: 'blacklist',
              playerScore: 0,
              testerScore: 0,
              reason: 'Both players blacklisted'
            }
          });
        } else if (playerBlacklisted) {
          const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
          console.log(`Match ${matchId}: Player blacklisted, finalizing with tester win (0-${firstTo})`);
          const ratingChanges = await handleManualFinalization(match, { playerScore: 0, testerScore: firstTo });
          await matchRef.update({
            status: 'ended',
            finalized: true,
            finalizedAt: new Date().toISOString(),
            result: { playerScore: 0, testerScore: firstTo },
            reason: 'Player blacklisted',
            finalizationData: {
              type: 'blacklist',
              playerScore: 0,
              testerScore: firstTo,
              ratingChanges,
              playerUsername: match.playerUsername,
              gamemode: match.gamemode,
              autoFinalized: true,
              reason: 'Opponent was blacklisted — you have been awarded the win'
            }
          });
          // Notify the non-blacklisted tester
          await createNotification(match.testerId, {
            type: 'match_finalized',
            title: 'Match Auto-Finalized',
            message: `Your ${match.gamemode} match was auto-finalized because your opponent was blacklisted. You have been awarded the win. Rating: ${ratingChanges?.testerNewRating ?? 'N/A'} (${(ratingChanges?.testerRatingChange ?? 0) >= 0 ? '+' : ''}${ratingChanges?.testerRatingChange ?? 0})`,
            matchId,
            gamemode: match.gamemode
          });
        } else {
          const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
          console.log(`Match ${matchId}: Tester blacklisted, finalizing with player win (${firstTo}-0)`);
          const ratingChanges = await handleManualFinalization(match, { playerScore: firstTo, testerScore: 0 });
          await matchRef.update({
            status: 'ended',
            finalized: true,
            finalizedAt: new Date().toISOString(),
            result: { playerScore: firstTo, testerScore: 0 },
            reason: 'Tester blacklisted',
            finalizationData: {
              type: 'blacklist',
              playerScore: firstTo,
              testerScore: 0,
              ratingChanges,
              playerUsername: match.playerUsername,
              gamemode: match.gamemode,
              autoFinalized: true,
              reason: 'Opponent was blacklisted — you have been awarded the win'
            }
          });
          // Notify the non-blacklisted player
          await createNotification(match.playerId, {
            type: 'match_finalized',
            title: 'Match Auto-Finalized',
            message: `Your ${match.gamemode} match was auto-finalized because your opponent was blacklisted. You have been awarded the win. Rating: ${ratingChanges?.playerNewRating ?? 'N/A'} (${(ratingChanges?.playerRatingChange ?? 0) >= 0 ? '+' : ''}${ratingChanges?.playerRatingChange ?? 0})`,
            matchId,
            gamemode: match.gamemode
          });
        }
      }
    }
  } catch (error) {
    console.error('Error checking blacklisted matches:', error);
  }
}

/**
 * Generate a unique group ID for related accounts
 */
function generateAltGroupId(primaryAccount, suspiciousAccounts) {
  // Create a consistent group ID based on all account UIDs
  const allUids = [
    String(primaryAccount || '').trim(),
    ...normalizeSuspiciousAccountsList(suspiciousAccounts).map(acc => acc.uid)
  ].filter(Boolean).sort();
  return allUids.join('_');
}

/**
 * Create or update consolidated alt report
 */
async function createConsolidatedAltReport(primaryAccount, suspiciousAccounts, clientIP, detectionReason, type) {
  try {
    const normalizedPrimaryAccount = String(primaryAccount || '').trim();
    const normalizedSuspiciousAccounts = normalizeSuspiciousAccountsList(suspiciousAccounts);
    const groupId = generateAltGroupId(normalizedPrimaryAccount, normalizedSuspiciousAccounts);

    if (!normalizedPrimaryAccount || !groupId) {
      return null;
    }

    // Check if report already exists for this group
    const reportsRef = db.ref('altReports');
    const existingReportsSnapshot = await reportsRef.orderByChild('groupId').equalTo(groupId).once('value');
    const existingReports = existingReportsSnapshot.val();

    let reportRef;
    let reportData;

    if (existingReports) {
      // Update existing report
      const reportId = Object.keys(existingReports)[0];
      reportRef = db.ref(`altReports/${reportId}`);

      const existingReport = existingReports[reportId];
      const existingSuspicious = normalizeSuspiciousAccountsList(existingReport.suspiciousAccounts);
      const mergedSuspicious = normalizeSuspiciousAccountsList([...existingSuspicious, ...normalizedSuspiciousAccounts]);
      reportData = {
        ...existingReport,
        suspiciousAccounts: mergedSuspicious,
        flagCount: (existingReport.flagCount || 1) + 1,
        lastFlaggedAt: new Date().toISOString(),
        lastDetectionReason: detectionReason,
        lastClientIP: clientIP,
        updatedAt: new Date().toISOString()
      };
    } else {
      // Create new consolidated report
      reportRef = db.ref('altReports').push();
      reportData = {
        groupId,
        primaryAccount: normalizedPrimaryAccount,
        suspiciousAccounts: normalizedSuspiciousAccounts,
        flagCount: 1,
        detectionReason,
        clientIP,
        reportedAt: new Date().toISOString(),
        status: 'reported',
        type,
        lastFlaggedAt: new Date().toISOString(),
        lastDetectionReason: detectionReason,
        lastClientIP: clientIP
      };
    }

    await reportRef.set(sanitizeFirebaseValue(reportData));
    return { reportId: reportRef.key, isNew: !existingReports, flagCount: reportData.flagCount };

  } catch (error) {
    console.error('Error creating consolidated alt report:', error);
    return null;
  }
}

/**
 * Get client IP address
 */
function getClientIP(req) {
  // Check for forwarded headers (when behind proxy/load balancer)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return forwarded.split(',')[0].trim();
  }

  // Check for real IP header
  const realIP = req.headers['x-real-ip'];
  if (realIP) {
    return realIP;
  }

  // Fallback to connection remote address
  return req.connection.remoteAddress || req.socket.remoteAddress || req.ip || 'unknown';
}

/**
 * Alt account detection algorithm
 */
async function detectAltAccount(email, clientIP, minecraftUsername = null) {
  try {
    const [usersSnapshot, staffRoles] = await Promise.all([
      db.ref('users').once('value'),
      getAllStaffRoles().catch(() => ({}))
    ]);
    const allUsers = usersSnapshot.val() || {};

    const suspiciousAccounts = [];
    const whitelistRef = db.ref('altWhitelist');
    const whitelistSnapshot = await whitelistRef.once('value');
    const whitelist = whitelistSnapshot.val() || {};
    const normalizedEmail = String(email || '').trim().toLowerCase();

    // Check if this account is whitelisted
    if (await isAltWhitelistedForEmail(db, normalizedEmail)) {
      return { isAlt: false, reason: 'Email is whitelisted' };
    }

    for (const [uid, userData] of Object.entries(allUsers)) {
      if ((userData.email === email || userData.firebaseUid === email) && whitelist[uid]) {
        return { isAlt: false, reason: 'Account is whitelisted' };
      }
    }

    // Check IP-based detection
    for (const [uid, userData] of Object.entries(allUsers)) {
      if (!userData.ipAddresses) continue;

      const userIPs = Array.isArray(userData.ipAddresses) ? userData.ipAddresses : [userData.ipAddresses];

      // Exact IP match (strong evidence)
      if (userIPs.includes(clientIP)) {
        if (userData.email !== email && uid !== email) {
          suspiciousAccounts.push({
            uid,
            email: userData.email,
            minecraftUsername: userData.minecraftUsername,
            reason: `Same IP address: ${clientIP}`,
            confidence: 'high'
          });
        }
      }

      // Check for IP ranges (subnet matching - medium evidence)
      const clientIPParts = clientIP.split('.');
      for (const userIP of userIPs) {
        const userIPParts = userIP.split('.');
        if (clientIPParts.length === 4 && userIPParts.length === 4) {
          // Match first 3 octets (same subnet)
          if (clientIPParts[0] === userIPParts[0] &&
              clientIPParts[1] === userIPParts[1] &&
              clientIPParts[2] === userIPParts[2] &&
              clientIPParts[3] !== userIPParts[3]) {
            if (userData.email !== email && uid !== email) {
              suspiciousAccounts.push({
                uid,
                email: userData.email,
                minecraftUsername: userData.minecraftUsername,
                reason: `Same subnet: ${clientIPParts[0]}.${clientIPParts[1]}.${clientIPParts[2]}.x`,
                confidence: 'medium'
              });
            }
          }
        }
      }
    }

    // Minecraft username patterns (if provided)
    if (minecraftUsername) {
      const usernamePatterns = [
        minecraftUsername.toLowerCase(),
        minecraftUsername.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
        minecraftUsername.replace(/[0-9]/g, '').toLowerCase()
      ];

      for (const [uid, userData] of Object.entries(allUsers)) {
        if (!userData.minecraftUsername) continue;

        const existingUsername = userData.minecraftUsername.toLowerCase();
        const existingClean = userData.minecraftUsername.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const existingNoNumbers = userData.minecraftUsername.replace(/[0-9]/g, '').toLowerCase();

        for (const pattern of usernamePatterns) {
          // Check for similar usernames
          if (existingUsername.includes(pattern) ||
              existingClean.includes(pattern) ||
              existingNoNumbers.includes(pattern) ||
              pattern.includes(existingClean) ||
              pattern.includes(existingNoNumbers)) {

            if (Math.abs(pattern.length - existingClean.length) <= 2) {
              if (userData.email !== email && uid !== email) {
                suspiciousAccounts.push({
                  uid,
                  email: userData.email,
                  minecraftUsername: userData.minecraftUsername,
                  reason: `Similar Minecraft username: ${userData.minecraftUsername}`,
                  confidence: 'medium'
                });
              }
            }
          }
        }
      }
    }

    // Remove duplicates and filter by confidence
    const uniqueSuspicious = suspiciousAccounts.filter((account, index, self) =>
      index === self.findIndex(a => a.uid === account.uid)
    );

    const highConfidence = uniqueSuspicious.filter(acc => acc.confidence === 'high');
    const totalSuspicious = uniqueSuspicious.length;

    // Decision logic - VERY AGGRESSIVE: Flag on ANY suspicion
    if (totalSuspicious > 0) {
      const confidenceLevels = uniqueSuspicious.map(acc => acc.confidence).join(', ');
      return {
        isAlt: true,
        reason: `Suspicious activity detected (${totalSuspicious} account(s), confidence: ${confidenceLevels}): ${uniqueSuspicious.map(acc => acc.reason).join('; ')}`,
        suspiciousAccounts: uniqueSuspicious
      };
    }

    // Even if no direct matches, check for basic patterns that should be reported
    // This makes the system extremely sensitive to any potential alt activity
    if (minecraftUsername) {
      // Check if this username has been seen before in any context
      for (const [uid, userData] of Object.entries(allUsers)) {
        if (userData.minecraftUsername?.toLowerCase().includes(minecraftUsername.toLowerCase().substring(0, 3)) ||
            minecraftUsername.toLowerCase().includes(userData.minecraftUsername?.toLowerCase().substring(0, 3))) {
          return {
            isAlt: true,
            reason: `Potential alt account - similar username patterns detected`,
            suspiciousAccounts: [{
              uid,
              email: userData.email,
              minecraftUsername: userData.minecraftUsername,
              reason: `Similar username pattern`,
              confidence: 'low'
            }]
          };
        }
      }
    }

    // Additional aggressive checks - report on any account with similar email patterns
    const emailParts = email.toLowerCase().split('@');
    if (emailParts.length === 2) {
      const [localPart, domain] = emailParts;

      for (const [uid, userData] of Object.entries(allUsers)) {
        if (userData.email && userData.email !== email) {
          const existingEmail = userData.email.toLowerCase();
          // Check for similar local parts (e.g., john1 vs john2)
          if (existingEmail.includes(domain) &&
              (localPart.includes(existingEmail.split('@')[0].substring(0, 4)) ||
               existingEmail.split('@')[0].includes(localPart.substring(0, 4)))) {
            return {
              isAlt: true,
              reason: `Potential alt account - similar email pattern detected`,
              suspiciousAccounts: [{
                uid,
                email: userData.email,
                minecraftUsername: userData.minecraftUsername,
                reason: `Similar email pattern`,
                confidence: 'low'
              }]
            };
          }
        }
      }
    }

    return { isAlt: false, suspiciousAccounts: uniqueSuspicious };

  } catch (error) {
    console.error('Error in alt detection:', error);
    return { isAlt: false, error: error.message };
  }
}

async function isUserAltWhitelisted(userId) {
  if (!userId) return false;
  try {
    const snapshot = await db.ref(`altWhitelist/${userId}`).once('value');
    return snapshot.exists();
  } catch (error) {
    console.error('Error checking alt whitelist:', error);
    return false;
  }
}

async function enforceTrustedTierListAccess(userId, { profile = null, clientIP = null } = {}) {
  if (!userId) {
    return {
      allowed: false,
      code: 'INVALID_USER',
      message: 'User ID is required for competitive access.'
    };
  }

  const resolvedProfile = profile || await getStoredUserProfile(userId);
  if (!resolvedProfile) {
    return {
      allowed: false,
      code: 'PROFILE_NOT_FOUND',
      message: 'User profile not found.'
    };
  }

  const adminBypass = hasAdminAccess(resolvedProfile, resolvedProfile.email);
  if (adminBypass) {
    return { allowed: true, reason: 'admin_bypass' };
  }

  const whitelisted = await isUserAltWhitelisted(userId);
  const emailWhitelisted = await isAltWhitelistedForEmail(db, resolvedProfile.email);
  if (whitelisted || emailWhitelisted) {
    return { allowed: true, reason: 'alt_whitelist' };
  }

  if (resolvedProfile.flaggedForReview === true) {
    return {
      allowed: false,
      code: 'COMPETITIVE_ACCESS_RESTRICTED',
      message: 'This account is under security review and cannot affect the tier list until an admin clears or whitelists it.'
    };
  }

  const email = String(resolvedProfile.email || '').trim();
  const minecraftUsername = String(resolvedProfile.minecraftUsername || '').trim();
  if (email && clientIP) {
    const altCheck = await detectAltAccount(email, clientIP, minecraftUsername || null);
    if (altCheck?.isAlt) {
      return {
        allowed: false,
        code: 'ALT_DETECTION_RESTRICTED',
        message: 'Competitive access is restricted because this account matched alt-detection checks. Ask an admin to whitelist the account if it is legitimate.'
      };
    }
  }

  return { allowed: true, reason: 'trusted' };
}

/**
 * Check if user is banned
 */
async function checkBanned(req, res, next) {
  try {
    const profile = req.userProfile || await getStoredUserProfile(req.user.uid);

    // Allow access to profile and onboarding endpoints for users with unverified accounts
    const isProfileOrOnboardingEndpoint = req.path.startsWith('/api/users/me') && req.method === 'GET';
    const isOnboardingStatusEndpoint = req.path === '/api/onboarding/status';

    // Check if user has an expired pending verification (treat as banned)
    if (profile && profile.minecraftUsername && profile.minecraftVerified === false) {
      // Check if there's an expired pending verification for this user
      const pendingVerificationsRef = db.ref('pendingVerifications');
      const pendingSnapshot = await pendingVerificationsRef.once('value');
      const pendingVerifications = pendingSnapshot.val() || {};

      let hasExpiredVerification = false;
      const now = Date.now();

      // Check if user has any expired pending verifications
      for (const [key, verification] of Object.entries(pendingVerifications)) {
        if (verification.userId === req.user.uid && verification.expiresAt < now) {
          hasExpiredVerification = true;
          break;
        }
      }

      // Only block if they have an expired pending verification AND it's not a profile/onboarding endpoint
      if (hasExpiredVerification && !isProfileOrOnboardingEndpoint && !isOnboardingStatusEndpoint) {
        return res.status(403).json({
          error: true,
          code: 'VERIFICATION_EXPIRED',
          message: 'Your Minecraft account verification has expired. Please restart the linking process.',
          banExpires: null,
          timeRemaining: null,
          isPermanent: false,
          isVerificationExpired: true
        });
      }
    }

    if (profile && profile.banned) {
      // Check if ban has expired
      if (profile.banExpires && profile.banExpires !== 'permanent') {
        const banExpires = new Date(profile.banExpires);
        const now = new Date();

        if (banExpires <= now) {
          // Ban has expired, remove ban fields
          console.log('Auto-unbanning expired ban for user:', req.user.uid);
          await db.ref(`users/${req.user.uid}`).update({
            banned: null,
            bannedAt: null,
            bannedBy: null,
            banExpires: null,
            banReason: null
          });
          next();
          return;
        }
      }

      // User is still banned - calculate time remaining
      let timeRemaining = null;
      if (profile.banExpires && profile.banExpires !== 'permanent') {
        const banExpires = new Date(profile.banExpires);
        const now = new Date();
        timeRemaining = Math.max(0, banExpires - now);
      }

      return res.status(403).json({
        error: true,
        code: 'ACCOUNT_BANNED',
        message: profile.banReason || 'Your account has been banned',
        bannedAt: profile.bannedAt || null,
        banExpires: profile.banExpires,
        timeRemaining: timeRemaining,
        isPermanent: profile.banExpires === 'permanent'
      });
    }

    next();
  } catch (error) {
    console.error('Ban check error:', error);
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error checking account status'
    });
  }
}

// ===== API Routes =====

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ===== Real-time User SSE Endpoint =====
/**
 * Generalized SSE endpoint for user/dashboard real-time events
 * Streams: match entry, cooldowns, chat, timers, notifications, onboarding, etc.
 * Endpoint: /api/user/:userId/stream
 */
app.get('/api/user/:userId/stream', verifyAuth, async (req, res) => {
  try {
    // Only allow the user to connect to their own stream (or admin)
    const { userId } = req.params;
    const authedUserId = req.user?.uid;
    const isAdmin = hasAdminAccess(req.userProfile || {}, req.user?.email);
    if (userId !== authedUserId && !isAdmin) {
      return res.status(403).json({ error: true, message: 'Forbidden' });
    }

    // SSE headers
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.flushHeaders();
    res.socket?.setKeepAlive?.(true, 30000);

    let closed = false;
    req.on('close', () => { closed = true; cleanup(); });

    // Helper to send SSE event
    function sendEvent(event, data) {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => sendEvent('ping', { ts: Date.now() }), 25000);

    // Firebase listeners
    const listeners = [];
    const dbUserRef = db.ref(`users/${userId}`);
    const dbQueueRef = db.ref('queue');
    const dbNotificationsRef = db.ref(`notifications/${userId}`);
    const dbOnboardingRef = db.ref(`users/${userId}/onboardingCompleted`);
    const dbMatchesRef = db.ref('matches');
    const dbInboxUnreadRef = realtimeDbRef(`inboxMeta/${userId}/unreadCount`);

    let latestProfile = req.userProfile || {};

    async function emitGamemodeStats(regionOverride = null) {
      try {
        const region = typeof regionOverride === 'string'
          ? regionOverride
          : String(latestProfile?.region || '').trim().toUpperCase();
        const statsSnapshot = await getDashboardGamemodeStatsSnapshot(region);
        sendEvent('gamemodeStats', {
          region: statsSnapshot.region,
          statsByGamemode: statsSnapshot.statsByGamemode,
          generatedAt: statsSnapshot.generatedAt
        });
      } catch (statsError) {
        console.warn('Failed to emit realtime gamemode stats:', statsError.message);
      }
    }

    // User profile changes (region, cooldowns, etc.)
    listeners.push(dbUserRef.on('value', async (snap) => {
      const profile = snap.val() || {};
      latestProfile = profile;
      try {
        const [moderation, staffRoles] = await Promise.all([
          getUserModerationState(userId, profile),
          getAllStaffRoles().catch(() => ({}))
        ]);
        const staffRole = resolveStaffRoleForProfile(profile, staffRoles);
        const adminRole = getAdminRole(profile, req.user.email || profile.email || '');
        const adminCapabilities = adminRole ? getAdminCapabilities(adminRole) : [];
        const warnings = Array.isArray(profile.warnings) ? profile.warnings : [];
        const activeWarnings = warnings.filter(w => w && w.acknowledged !== true);
        sendEvent('profile', {
          profile: buildCurrentUserProfileResponse(profile, {
            user: req.user,
            moderation,
            staffRole,
            adminRole,
            adminCapabilities,
            activeWarnings
          })
        });
      } catch (profileEventError) {
        console.warn('Failed to sanitize realtime profile event:', profileEventError.message);
        sendEvent('profile', { profile: pickCurrentUserProfileFields(profile) });
      }
      emitGamemodeStats(profile.region || '');
    }));

    // Queue entry + compatible queue status. Watch all queue changes so counts/ETA
    // update when other compatible players or testers join/leave.
    listeners.push(dbQueueRef.on('value', async (snap) => {
      const entries = snap.val() || {};
      const ownEntries = Object.values(entries).filter((entry) => entry?.userId === userId);
      const firstEntry = ownEntries[0] || null;
      if (!firstEntry) {
        sendEvent('queue', { inQueue: false, queueEntry: null, queueSummary: null });
      } else {
        const queueSummary = await buildQueueStatusSummary(firstEntry, userId, { queueEntries: entries }).catch(() => null);
        sendEvent('queue', { inQueue: true, queueEntry: firstEntry, queueSummary });
      }
      emitGamemodeStats();
    }));

    // Notifications (new notifications)
    listeners.push(dbNotificationsRef.on('value', (snap) => {
      const notifications = snap.val() || {};
      sendEvent('notifications', { notifications });
    }));

    listeners.push(dbInboxUnreadRef.on('value', (snap) => {
      const unreadCount = Number(snap.val());
      sendEvent('inboxUnreadCount', {
        unreadCount: Number.isFinite(unreadCount) && unreadCount >= 0 ? unreadCount : 0
      });
    }));

    // Onboarding verification status
    listeners.push(dbOnboardingRef.on('value', (snap) => {
      sendEvent('onboarding', { completed: !!snap.val() });
    }));

    // Active matches, cooldowns, timers, chat, etc.
    let playerSideMatches = {};
    let testerSideMatches = {};

    const emitActiveMatchState = async () => {
      const combinedMatches = { ...playerSideMatches, ...testerSideMatches };
      const activeMatch = Object.entries(combinedMatches).find(([, match]) => (
        match && !match.finalized && match.status === 'active'
      ));

      if (!activeMatch) {
        sendEvent('matchState', { hasMatch: false, match: null });
      } else {
        const [matchId, match] = activeMatch;
        sendEvent('matchState', {
          hasMatch: true,
          match: await enrichMatchForClient(match, matchId)
        });
      }

      emitGamemodeStats();
    };

    listeners.push(dbMatchesRef.orderByChild('playerId').equalTo(userId).on('value', (snap) => {
      playerSideMatches = snap.val() || {};
      emitActiveMatchState().catch((matchStateError) => {
        console.warn('Failed to emit player match state:', matchStateError.message);
      });
    }));
    listeners.push(dbMatchesRef.orderByChild('testerId').equalTo(userId).on('value', (snap) => {
      testerSideMatches = snap.val() || {};
      emitActiveMatchState().catch((matchStateError) => {
        console.warn('Failed to emit tester match state:', matchStateError.message);
      });
    }));

    emitGamemodeStats();

    // Cleanup listeners
    function cleanup() {
      clearInterval(heartbeat);
      dbUserRef.off();
      dbQueueRef.off();
      dbNotificationsRef.off();
      dbOnboardingRef.off();
      dbMatchesRef.off();
      dbInboxUnreadRef.off();
    }
  } catch (err) {
    logger.error('SSE user stream error', { error: err });
    if (!res.headersSent) res.status(500).json({ error: true, message: 'SSE error' });
    try { res.end(); } catch (_) {}
  }
});

// ===== User Routes =====

/**
 * GET /api/users/me - Get current user profile
 */
app.get('/api/users/me', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const profile = await ensureUserProfileExists(req.user, {
      clientIP: getClientIP(req),
      existingProfile: req.userProfile || null
    });

    // Keep the hot profile endpoint fast; enrich UUID in the background when needed.
    void triggerMinecraftUuidLinkForUser(req.user.uid, profile);
    const resolvedProfile = profile;
    
    let playerData = null;
    try {
      const playersRef = db.ref('players');
      let playerSnapshot = await playersRef
        .orderByChild('userId')
        .equalTo(req.user.uid)
        .limitToFirst(1)
        .once('value');

      if (!playerSnapshot.exists() && resolvedProfile.minecraftUsername) {
        playerSnapshot = await playersRef
          .orderByChild('username')
          .equalTo(resolvedProfile.minecraftUsername)
          .limitToFirst(1)
          .once('value');
      }

      if (playerSnapshot.exists()) {
        const players = playerSnapshot.val();
        const firstPlayerKey = Object.keys(players)[0];
        playerData = players[firstPlayerKey] || null;
      }
    } catch (playerLookupError) {
      console.warn('Could not enrich /api/users/me with player ratings:', playerLookupError.message);
    }

    const [moderation, staffRoles] = await Promise.all([
      getUserModerationState(req.user.uid, resolvedProfile),
      getAllStaffRoles().catch(() => ({}))
    ]);
    const staffRole = resolveStaffRoleForProfile(resolvedProfile, staffRoles);
    const adminRole = getAdminRole(resolvedProfile, req.user.email || resolvedProfile.email || '');
    const adminCapabilities = adminRole ? getAdminCapabilities(adminRole) : [];
    const warnings = Array.isArray(resolvedProfile.warnings) ? resolvedProfile.warnings : [];
    const activeWarnings = warnings.filter(w => w && w.acknowledged !== true);

    res.json(buildCurrentUserProfileResponse(resolvedProfile, {
      user: req.user,
      playerData,
      moderation,
      staffRole,
      adminRole,
      adminCapabilities,
      activeWarnings
    }));
  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching user profile'
    });
  }
});

/**
 * GET /api/users/me/standing - Moderation standing for current user
 */
app.get('/api/users/me/standing', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const profile = req.userProfile || (await getStoredUserProfile(req.user.uid)) || {};
    const moderation = await getUserModerationState(req.user.uid, profile);
    const warnings = (Array.isArray(profile.warnings) ? profile.warnings : []).slice().sort((a, b) => {
      return parseDateToMs(b?.warnedAt) - parseDateToMs(a?.warnedAt);
    });

    res.json({
      success: true,
      standing: {
        blacklisted: moderation.blacklisted,
        blacklistEntry: moderation.blacklistEntry,
        warnings,
        restrictions: moderation.restrictions || {}
      }
    });
  } catch (error) {
    console.error('Error fetching user standing:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching user standing'
    });
  }
});

/**
 * POST /api/admin/check-blacklist-status - Check if current user is blacklisted (for real-time monitoring)
 */
app.post('/api/admin/check-blacklist-status', verifyAuth, async (req, res) => {
  try {
    const userId = req.user.uid;
    const email = req.user.email;
    const blacklistSnapshot = await db.ref('blacklist').once('value');
    const blacklist = blacklistSnapshot.val() || {};

    // Check if user's email or any username is blacklisted
    for (const [entryId, entry] of Object.entries(blacklist)) {
      if (!entry) continue;

      // Check if expired
      if (entry.expiresAt) {
        const expiresAt = new Date(entry.expiresAt);
        if (expiresAt <= new Date()) {
          continue; // Skip expired entries
        }
      }

      // Check if it matches this user
      const matchesEmail = entry.email && entry.email.toLowerCase() === email.toLowerCase();
      const matchesUserId = entry.userId === userId;
      const matchesMcUsername = email && entry.username && entry.username.toLowerCase() === email.split('@')[0].toLowerCase();

      if (matchesEmail || matchesUserId || matchesMcUsername) {
        return res.json({
          success: true,
          isBlacklisted: true,
          reason: entry.reason || 'Your account has been blacklisted',
          expiresAt: entry.expiresAt || null,
          entryId: entryId
        });
      }
    }

    res.json({
      success: true,
      isBlacklisted: false
    });
  } catch (error) {
    console.error('Error checking blacklist status:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error checking blacklist status'
    });
  }
});

// ==================== REAL-TIME UPDATES SYSTEM ====================
// Global registry of connected clients and their subscriptions
global.realtimeClients = new Map(); // userId -> Set of { res, subscriptions }

/**
 * GET /api/realtime/updates - Server-Sent Events stream for real-time updates
 * Subscribe to updates: user profile, matches, queue status, stats, etc.
 */
app.get('/api/realtime/updates', verifyAuth, (req, res) => {
  const userId = req.user.uid;
  const subscriptions = new Set((req.query.subscribe || '').split(',').filter(Boolean));

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Send initial connection message
  res.write(`data: ${JSON.stringify({ type: 'connected', userId, subscriptions: Array.from(subscriptions) })}\n\n`);

  // Register this connection
  const clientInfo = { res, userId, subscriptions, connectedAt: Date.now() };
  if (!global.realtimeClients.has(userId)) {
    global.realtimeClients.set(userId, new Set());
  }
  global.realtimeClients.get(userId).add(clientInfo);

  // Keepalive pings every 30 seconds to maintain connection through proxies
  const keepaliveInterval = setInterval(() => {
    res.write(`:keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepaliveInterval);
    const clients = global.realtimeClients.get(userId);
    if (clients) {
      clients.delete(clientInfo);
      if (clients.size === 0) {
        global.realtimeClients.delete(userId);
      }
    }
  });
});

/**
 * GET /api/admin/ban-status-stream - Server-Sent Events stream for real-time ban/blacklist status
 */
app.get('/api/admin/ban-status-stream', verifyAuth, (req, res) => {
  const userId = req.user.uid;
  const email = req.user.email;

  // Set up SSE (Server-Sent Events) headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable proxying buffering (for nginx)
  res.flushHeaders?.();
  res.socket?.setKeepAlive?.(true, 30000);

  // Send initial connection message
  res.write(`data: {"connected":true,"userId":"${userId}"}\n\n`);

  // Track this connection
  if (!global.banStatusConnections) global.banStatusConnections = new Set();
  global.banStatusConnections.add({ res, userId, email, startTime: Date.now() });

  // Periodic keepalive to keep connection alive (every 30 seconds)
  const keepaliveInterval = setInterval(() => {
    res.write(`:keepalive\n\n`);
  }, 30000);

  // Cleanup on disconnect
  req.on('close', () => {
    clearInterval(keepaliveInterval);
    if (global.banStatusConnections) {
      for (const conn of global.banStatusConnections) {
        if (conn.res === res) {
          global.banStatusConnections.delete(conn);
          break;
        }
      }
    }
  });

  // Check initial status
  (async () => {
    try {
      const status = await checkBanStatus(userId, email);
      if (status.isBanned || status.isBlacklisted) {
        res.write(`data: ${JSON.stringify(status)}

`);
      }
    } catch (err) {
      console.error('Error checking initial ban status:', err);
    }
  })();
});

/**
 * Helper function to check ban/blacklist status
 */
async function checkBanStatus(userId, email) {
  const result = {
    userId,
    isBanned: false,
    isBlacklisted: false,
    timestamp: new Date().toISOString()
  };

  try {
    // Check Firebase account ban
    const userSnapshot = await db.ref(`users/${userId}`).once('value');
    const userProfile = userSnapshot.val() || {};

    if (userProfile.banned) {
      if (userProfile.banExpires && userProfile.banExpires !== 'permanent') {
        const banExpires = new Date(userProfile.banExpires);
        if (banExpires <= new Date()) {
          // Ban expired
          return result;
        }
      }

      result.isBanned = true;
      result.banReason = userProfile.banReason || 'Violation of terms of service';
      result.banExpires = userProfile.banExpires;
      return result;
    }

    // Check blacklist
    const blacklistSnapshot = await db.ref('blacklist').once('value');
    const blacklist = blacklistSnapshot.val() || {};

    for (const [entryId, entry] of Object.entries(blacklist)) {
      if (!entry) continue;

      if (entry.expiresAt) {
        const expiresAt = new Date(entry.expiresAt);
        if (expiresAt <= new Date()) continue;
      }

      const matchesEmail = entry.email && entry.email.toLowerCase() === email.toLowerCase();
      const matchesUserId = entry.userId === userId;
      const matchesMcUsername = email && entry.username && entry.username.toLowerCase() === email.split('@')[0].toLowerCase();

      if (matchesEmail || matchesUserId || matchesMcUsername) {
        result.isBlacklisted = true;
        result.blacklistReason = entry.reason || 'Your account has been blacklisted';
        result.blacklistExpires = entry.expiresAt || null;
        result.entryId = entryId;
        return result;
      }
    }
  } catch (err) {
    console.error('Error checking ban status:', err);
  }

  return result;
}

/**
 * PUT /api/users/me - Update user profile
 */
app.put('/api/users/me', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const updates = req.body;
    const existing = await getStoredUserProfile(req.user.uid);
    const isNewProfile = !existing;

    // Only allow whitelisted fields to prevent privilege escalation
    const sanitizedUpdates = {};
    for (const key of Object.keys(updates)) {
      if (ALLOWED_PROFILE_UPDATE_FIELDS.includes(key)) {
        sanitizedUpdates[key] = updates[key];
      }
    }

    if (Object.keys(sanitizedUpdates).length === 0) {
      if (!isNewProfile) {
        return res.status(400).json({
          error: true,
          code: 'VALIDATION_ERROR',
          message: 'No valid fields to update'
        });
      }
    }
    
    // Merge updates
    const updated = {
      ...(isNewProfile ? {
        email: req.user.email || null,
        firebaseUid: req.user.uid,
        createdAt: new Date().toISOString(),
        minecraftUsername: null,
        minecraftVerified: false,
        onboardingCompleted: false,
        stayInQueueAfterMatch: false,
        securitySettings: {
          requireVerifiedEmailForSensitiveActions: false,
          requireVerifiedEmailForLogin: false
        }
      } : existing),
      ...(existing || {}),
      ...sanitizedUpdates,
      updatedAt: new Date().toISOString()
    };
    
    await setStoredUserProfile(req.user.uid, updated);

    const [moderation, staffRoles] = await Promise.all([
      getUserModerationState(req.user.uid, updated),
      getAllStaffRoles().catch(() => ({}))
    ]);
    const staffRole = resolveStaffRoleForProfile(updated, staffRoles);
    const adminRole = getAdminRole(updated, req.user.email || updated.email || '');
    const adminCapabilities = adminRole ? getAdminCapabilities(adminRole) : [];
    const warnings = Array.isArray(updated.warnings) ? updated.warnings : [];
    const activeWarnings = warnings.filter(w => w && w.acknowledged !== true);

    res.json(buildCurrentUserProfileResponse(updated, {
      user: req.user,
      moderation,
      staffRole,
      adminRole,
      adminCapabilities,
      activeWarnings
    }));
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating user profile'
    });
  }
});

/**
 * GET /api/users/:userId/retirement-status - Get retirement status for a user (public endpoint)
 */
app.get('/api/users/:userId/retirement-status', async (req, res) => {
  try {
    const { userId } = req.params;

    if (!userId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'User ID is required'
      });
    }

    const userProfile = await getStoredUserProfile(userId);

    if (!userProfile) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    // Return only retirement status (public information)
    res.json({
      retiredGamemodes: userProfile.retiredGamemodes || {}
    });
  } catch (error) {
    console.error('Error fetching retirement status:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching retirement status'
    });
  }
});

/**
 * GET /api/users/me/recent-matches - Get recent matches for current user
 */
app.get('/api/users/me/recent-matches', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 5;

    const allMatches = (await listStoredMatchHistoryForUserId(req.user.uid)).map((match) => {
      const asPlayer = match.playerId === req.user.uid;
      return {
        ...match,
        matchId: match.matchId || match.id || match.matchId,
        userRole: asPlayer ? 'player' : 'tester',
        opponentName: asPlayer ? match.testerUsername : match.playerUsername,
        userScore: asPlayer ? (match.finalizationData?.playerScore || 0) : (match.finalizationData?.testerScore || 0),
        opponentScore: asPlayer ? (match.finalizationData?.testerScore || 0) : (match.finalizationData?.playerScore || 0)
      };
    });

    // Sort by most recent first and limit
    allMatches.sort((a, b) => new Date(b.finalizedAt || b.createdAt) - new Date(a.finalizedAt || a.createdAt));
    const recentMatches = allMatches.slice(0, limit).map(m => sanitizeMatchForClient(m));

    res.json({ matches: recentMatches });
  } catch (error) {
    console.error('Error fetching recent matches:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching recent matches'
    });
  }
});

/**
 * POST /api/users/me/minecraft - Initiate Minecraft username linking (creates pending verification)
 */
app.post('/api/users/me/minecraft', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const { username, region } = req.body;
    
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Minecraft username is required'
      });
    }
    
    // Check for profanity in username
    try {
      const hasProfanity = await containsProfanity(username.trim());
      if (hasProfanity) {
        return res.status(400).json({
          error: true,
          code: 'PROFANITY_DETECTED',
          message: 'Username contains inappropriate language and cannot be used'
        });
      }
    } catch (error) {
      // If profanity filter is unavailable, block the request
      return res.status(503).json({
        error: true,
        code: 'FILTER_UNAVAILABLE',
        message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
      });
    }

    const mojangProfile = await fetchMojangProfile(username.trim()).catch((error) => {
      throw Object.assign(new Error('Could not verify username with Mojang API. Please try again later.'), {
        statusCode: 503,
        errorCode: 'MOJANG_API_UNAVAILABLE',
        cause: error
      });
    });

    if (!mojangProfile) {
      return res.status(404).json({
        error: true,
        code: 'USERNAME_NOT_FOUND',
        message: 'Minecraft username was not found through the Mojang API.'
      });
    }

    const normalizedUsername = normalizeMinecraftUsername(mojangProfile.username);
    const mojangUuid = normalizeMinecraftUUID(mojangProfile.uuid);
    const blacklistEntry = await findActiveBlacklistEntry({
      userId: req.user.uid,
      username: mojangProfile.username,
      uuid: mojangUuid
    });
    if (blacklistEntry) {
      return res.status(403).json({
        error: true,
        code: 'USERNAME_BLACKLISTED',
        message: 'This Minecraft account is blacklisted and cannot be linked to an account.'
      });
    }

    if (!region || typeof region !== 'string' || region.trim().length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Region selection is required'
      });
    }

    // Check if user already has a verified Minecraft account (unless user is admin)
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val() || {};

    if (userProfile.minecraftVerified && userProfile.minecraftUsername && !userProfile.admin) {
      return res.status(403).json({
        error: true,
        code: 'USERNAME_ALREADY_VERIFIED',
        message: 'You already have a verified Minecraft account. Contact an administrator to change your linked username.'
      });
    }

    // Clean up any expired pending verifications for this user
    const pendingVerificationsRef = db.ref('pendingVerifications');
    const allPendingSnapshot = await pendingVerificationsRef.once('value');
    const allPending = allPendingSnapshot.val() || {};
    const now = Date.now();

    const expiredVerifications = [];
    for (const [key, verification] of Object.entries(allPending)) {
      if (verification.userId === req.user.uid && verification.expiresAt < now) {
        expiredVerifications.push(key);
      }
    }

    // Remove expired verifications
    if (expiredVerifications.length > 0) {
      console.log('Cleaning up', expiredVerifications.length, 'expired verifications for user', req.user.uid);
      for (const key of expiredVerifications) {
        await pendingVerificationsRef.child(key).remove();
      }
    }

    // Check for impersonation (ToS Section 4)
    const impersonationCheck = await detectImpersonation(req.user.uid, null, username);
    if (impersonationCheck.suspicious && impersonationCheck.severity === 'high') {
      return res.status(400).json({
        error: true,
        code: 'IMPERSONATION_DETECTED',
        message: 'This username appears to be an impersonation attempt. Please choose a different username.'
      });
    }

    // Check if username is already linked to another verified account
    const playersRef = db.ref('players');
    const existingPlayersSnapshot = await playersRef.once('value');
    const existingPlayers = existingPlayersSnapshot.val() || {};

    for (const [key, player] of Object.entries(existingPlayers)) {
      const playerUuid = normalizeMinecraftUUID(player.minecraftUUID);
      if (((player.username?.toLowerCase() === normalizedUsername) || (playerUuid && playerUuid === mojangUuid)) && player.userId && player.userId !== req.user.uid) {
        return res.status(409).json({
          error: true,
          code: 'USERNAME_ALREADY_LINKED',
          message: 'This Minecraft account is already linked to another account. Each Minecraft account can only be linked once.'
        });
      }
    }

    const usersSnapshot = await db.ref('users').once('value');
    const allUsers = usersSnapshot.val() || {};
    for (const [otherUserId, otherUser] of Object.entries(allUsers)) {
      if (otherUserId === req.user.uid) continue;
      const otherUsername = normalizeMinecraftUsername(otherUser?.minecraftUsername);
      const otherUuid = normalizeMinecraftUUID(otherUser?.minecraftUUID || otherUser?.pendingMinecraftUUID);
      if ((otherUsername && otherUsername === normalizedUsername) || (otherUuid && otherUuid === mojangUuid)) {
        return res.status(409).json({
          error: true,
          code: 'USERNAME_ALREADY_LINKED',
          message: 'This Minecraft account is already linked to another account. Each Minecraft account can only be linked once.'
        });
      }
    }

    // Update user profile with pending verification
    await userRef.update({
      minecraftUsername: mojangProfile.username,
      region: region.trim(),
      minecraftVerified: false,
      pendingMinecraftUUID: mojangUuid,
      updatedAt: new Date().toISOString()
    });
    
    // Generate 6-digit verification code
    const verificationCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Create pending verification entry (reuse existing pendingVerificationsRef)
    const verificationData = {
      userId: req.user.uid,
      expectedUsername: mojangProfile.username,
      expectedUUID: mojangUuid,
      region: region.trim(),
      verificationCode: verificationCode,
      playerUUID: null, // Will be set when player runs /link command
      createdAt: Date.now(),
      expiresAt: Date.now() + (15 * 60 * 1000) // 15 minutes expiry
    };

    await pendingVerificationsRef.push(verificationData);

    res.json({
      success: true,
      message: 'Minecraft username linking initiated. Please join any server with the MCLeaderboardsAuth plugin and run /link with your verification code to complete verification.',
      verificationCode: verificationCode,
      username: mojangProfile.username,
      uuid: mojangUuid,
      instructions: `Join one of our active servers (mc.sidastuff.com or spectorsmp.pineserver.xyz) and run the /link ${verificationCode} command to verify your account.`
    });
  } catch (error) {
    console.error('Error initiating Minecraft username linking:', error);
    res.status(error.statusCode || 500).json({
      error: true,
      code: error.errorCode || 'SERVER_ERROR',
      message: error.message || 'Error initiating Minecraft username linking'
    });
  }
});


// ===== Player Routes =====

// Cache for players endpoint (15 second TTL for high traffic)
const playersCache = {
  data: null,
  updatedAt: 0,
  TTL: 15000, // 15 seconds - reduced DB load significantly
  blacklist: null,
  blacklistUpdatedAt: 0,
  blacklistTTL: 30000, // 30 seconds for blacklist
  users: null,
  usersUpdatedAt: 0,
  usersTTL: 15000 // 15 seconds for users cache
};

const publicUserMetaCache = {
  map: new Map(),
  ttl: 15000
};

function buildPublicUserMeta(profile = {}, staffRoles = {}) {
  const verifiedAdminRole = getAdminRole(profile, profile.email || '');
  return {
    retiredGamemodes: profile.retiredGamemodes || {},
    verifiedRoles: {
      admin: Boolean(verifiedAdminRole),
      tester: Boolean(profile.tester === true)
    },
    verifiedAdminRole,
    plus: profile.plus || null,
    verifiedStaffRole: resolveStaffRoleForProfile(profile, staffRoles) || null
  };
}

async function getPublicUserMetaBatch(userIds = [], staffRoles = {}) {
  const now = Date.now();
  const uniqueUserIds = [...new Set(userIds.map((userId) => String(userId || '').trim()).filter(Boolean))];
  const result = {};
  const missingUserIds = [];

  uniqueUserIds.forEach((userId) => {
    const cachedEntry = publicUserMetaCache.map.get(userId);
    if (cachedEntry && (now - cachedEntry.updatedAt) < publicUserMetaCache.ttl) {
      result[userId] = cachedEntry.value;
      return;
    }
    missingUserIds.push(userId);
  });

  if (missingUserIds.length > 0) {
    const snapshots = await Promise.all(
      missingUserIds.map((userId) => realtimeDbRef(`users/${userId}`).once('value').catch(() => null))
    );

    missingUserIds.forEach((userId, index) => {
      const profile = snapshots[index]?.val?.() || {};
      const value = buildPublicUserMeta(profile, staffRoles);
      publicUserMetaCache.map.set(userId, {
        value,
        updatedAt: now
      });
      result[userId] = value;
    });
  }

  return result;
}

let matchmakingJobRunning = false;

// Memory optimization: Limit cache size and clear old entries
setInterval(() => {
  const now = Date.now();
  // Clear expired player cache
  if (playersCache.data && (now - playersCache.updatedAt) > playersCache.TTL * 2) {
    playersCache.data = null;
  }
  // Clear expired users cache
  if (playersCache.users && (now - playersCache.usersUpdatedAt) > playersCache.usersTTL * 2) {
    playersCache.users = null;
  }
  for (const [userId, entry] of publicUserMetaCache.map.entries()) {
    if ((now - entry.updatedAt) > publicUserMetaCache.ttl * 2) {
      publicUserMetaCache.map.delete(userId);
    }
  }
  // Clear expired blacklist cache
  if (playersCache.blacklist && (now - playersCache.blacklistUpdatedAt) > playersCache.blacklistTTL * 2) {
    playersCache.blacklist = null;
  }
  // Clear expired moderation blacklist cache
  if (blacklistCache.data && (now - blacklistCache.updatedAt) > blacklistCache.ttl * 2) {
    blacklistCache.data = null;
  }
  // Clear expired dashboard stats cache
  for (const key in dashboardGamemodeStatsCache) {
    if (dashboardGamemodeStatsCache[key].data && 
        (now - dashboardGamemodeStatsCache[key].updatedAtMs) > DASHBOARD_GAMEMODE_STATS_TTL_MS * 2) {
      delete dashboardGamemodeStatsCache[key];
    }
  }
}, 30000); // Run every 30 seconds instead of 60

/**
 * GET /api/players - Get all players (optimized with caching and pagination)
 */
function shouldHidePlayerFromLeaderboard(player = {}, visibilityMap = {}, { gamemode = '', search = '' } = {}) {
  if (!player?.userId || search) {
    return false;
  }

  const entry = normalizeLeaderboardVisibilityEntry(player.userId, visibilityMap?.[player.userId] || {});
  if (entry.globalHidden) {
    return true;
  }

  const normalizedGamemode = String(gamemode || '').trim().toLowerCase();
  if (normalizedGamemode && normalizedGamemode !== 'overall' && entry.hiddenGamemodes?.[normalizedGamemode] === true) {
    return true;
  }

  return false;
}

app.get('/api/players', async (req, res) => {
  try {
    const {
      gamemode,
      limit,
      offset,
      showProvisional,
      region,
      search
    } = req.query;
    const includeProvisional = showProvisional === 'true';
    const now = Date.now();
    const requestedGamemode = typeof gamemode === 'string' ? gamemode.trim().toLowerCase() : '';
    const requestedRegion = typeof region === 'string' ? region.trim().toUpperCase() : '';
    const searchTerm = typeof search === 'string' ? search.trim().toLowerCase() : '';
    const isOverallLeaderboard = !requestedGamemode || requestedGamemode === 'overall';
    const start = parseInt(offset, 10) || 0;
    const requestedLimit = parseInt(limit, 10);
    
    // Check cache first (only for non-filtered requests or when cache is fresh)
    if (!gamemode && !region && !search && playersCache.data && (now - playersCache.updatedAt) < playersCache.TTL) {
      const playersArray = playersCache.data;
      const visibilityMap = searchTerm ? {} : ((await db.ref('leaderboardVisibility').once('value')).val() || {});
      const visiblePlayers = playersArray.filter((player) => !shouldHidePlayerFromLeaderboard(player, visibilityMap, {
        gamemode: requestedGamemode,
        search: searchTerm
      }));
      const total = visiblePlayers.length;
      const pageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : total;
      const staffRoles = await getAllStaffRoles().catch(() => ({}));
      const paginated = visiblePlayers.slice(start, start + pageLimit);
      const userMetaById = await getPublicUserMetaBatch(
        paginated.map((player) => player.userId).filter(Boolean),
        staffRoles
      );
      const enriched = paginated.map((player) => {
        const userMeta = player.userId ? userMetaById[player.userId] : null;
        return {
          ...player,
          plus: userMeta?.plus ?? player.plus ?? null,
          retiredGamemodes: userMeta?.retiredGamemodes ?? player.retiredGamemodes ?? {},
          verifiedAdminRole: userMeta?.verifiedAdminRole || player.verifiedAdminRole || null,
          verifiedRoles: {
            admin: Boolean(player.verifiedRoles?.admin === true || userMeta?.verifiedRoles?.admin === true),
            tester: Boolean(player.verifiedRoles?.tester === true || userMeta?.verifiedRoles?.tester === true)
          },
          verifiedStaffRole: userMeta?.verifiedStaffRole || player.verifiedStaffRole || null
        };
      });
      
      return res.json({ 
        players: enriched,
        total,
        limit: pageLimit,
        offset: start,
        hasMore: (start + pageLimit) < total,
        cached: true
      });
    }
    
    // Batch database queries in parallel
    const [playersSnapshot, blacklistSnapshot] = await Promise.all([
      db.ref('players').once('value'),
      // Check blacklist cache
      (now - playersCache.blacklistUpdatedAt) < playersCache.blacklistTTL && playersCache.blacklist
        ? Promise.resolve({ val: () => playersCache.blacklist })
        : db.ref('blacklist').once('value').then(snap => {
            playersCache.blacklist = snap.val() || {};
            playersCache.blacklistUpdatedAt = now;
            return snap;
          })
    ]);
    
    const players = playersSnapshot.val() || {};
    const blacklist = blacklistSnapshot.val() || {};
    
    const blacklistedUsernames = new Set(
      Object.values(blacklist)
        .filter(entry => isBlacklistEntryActive(entry))
        .map(entry => entry.username?.toLowerCase())
        .filter(Boolean)
    );
    
    // Process players efficiently
    let playersArray = Object.keys(players).map(key => {
      const player = players[key];
      const isBlacklisted = player.username && blacklistedUsernames.has(player.username.toLowerCase());
      
      // Calculate overallRating if missing
      let overallRating = player.overallRating;
      if (overallRating === undefined || overallRating === null) {
        if (isBlacklisted) {
          overallRating = 0;
        } else if (player.gamemodeRatings && Object.keys(player.gamemodeRatings).length > 0) {
          overallRating = calculateOverallRating(player.gamemodeRatings);
        } else {
          overallRating = 1000;
        }
      }
      
      return {
        id: key,
        ...player,
        plus: player.plus || null,
        blacklisted: isBlacklisted,
        overallRating,
        gamemodeRatings: isBlacklisted ? {} : (player.gamemodeRatings || {}),
        gamemodeMatchCount: player.gamemodeMatchCount || {},
        retiredGamemodes: player.retiredGamemodes || {},
        verifiedRoles: {
          admin: Boolean(player.roles?.admin === true),
          tester: Boolean(player.roles?.tester === true)
        },
        verifiedStaffRole: player.verifiedStaffRole || null
      };
    });

    if (requestedRegion) {
      playersArray = playersArray.filter((player) => String(player.region || '').trim().toUpperCase() === requestedRegion);
    }

    if (searchTerm) {
      playersArray = playersArray.filter((player) => {
        const username = String(player.username || '').toLowerCase();
        const playerRegion = String(player.region || '').toLowerCase();
        const userId = String(player.userId || '').toLowerCase();
        return username.includes(searchTerm)
          || playerRegion.includes(searchTerm)
          || userId.includes(searchTerm);
      });
    }

    const visibilityMap = searchTerm ? {} : ((await db.ref('leaderboardVisibility').once('value')).val() || {});
    if (!searchTerm) {
      playersArray = playersArray.filter((player) => !shouldHidePlayerFromLeaderboard(player, visibilityMap, {
        gamemode: requestedGamemode,
        search: searchTerm
      }));
    }

    // Filter by gamemode if specified.
    // For overall, do not filter out partially-rated players.
    if (!isOverallLeaderboard) {
      playersArray = playersArray.filter(player => {
        if (!player.gamemodeRatings || !player.gamemodeRatings[requestedGamemode]) return false;
        if (player.retiredGamemodes?.[requestedGamemode] === true) return false;
        // Require at least 5 matches to appear on gamemode leaderboard (unless provisional view)
        if (!includeProvisional) {
          const matchCount = Number(player.gamemodeMatchCount?.[requestedGamemode]) || 0;
          if (matchCount < 5) return false;
        }
        return true;
      });
    } else {
      // For overall leaderboard, require at least 5 total matches across all gamemodes
      if (!includeProvisional) {
        playersArray = playersArray.filter(player => {
          const totalMatches = Object.values(player.gamemodeMatchCount || {}).reduce((sum, v) => sum + (Number(v) || 0), 0);
          return totalMatches >= 5;
        });
      }
    }

    playersArray.sort((leftPlayer, rightPlayer) => {
      const leftRating = isOverallLeaderboard
        ? Number(leftPlayer.overallRating) || 0
        : Number(leftPlayer.gamemodeRatings?.[requestedGamemode]) || 0;
      const rightRating = isOverallLeaderboard
        ? Number(rightPlayer.overallRating) || 0
        : Number(rightPlayer.gamemodeRatings?.[requestedGamemode]) || 0;

      if (rightRating !== leftRating) {
        return rightRating - leftRating;
      }

      const leftPeak = isOverallLeaderboard
        ? Number(leftPlayer.peakOverallRating) || leftRating
        : Number(leftPlayer.peakRatings?.[requestedGamemode]) || leftRating;
      const rightPeak = isOverallLeaderboard
        ? Number(rightPlayer.peakOverallRating) || rightRating
        : Number(rightPlayer.peakRatings?.[requestedGamemode]) || rightRating;

      if (rightPeak !== leftPeak) {
        return rightPeak - leftPeak;
      }

      const leftMatches = isOverallLeaderboard
        ? Object.values(leftPlayer.gamemodeMatchCount || {}).reduce((total, value) => total + (Number(value) || 0), 0)
        : Number(leftPlayer.gamemodeMatchCount?.[requestedGamemode]) || 0;
      const rightMatches = isOverallLeaderboard
        ? Object.values(rightPlayer.gamemodeMatchCount || {}).reduce((total, value) => total + (Number(value) || 0), 0)
        : Number(rightPlayer.gamemodeMatchCount?.[requestedGamemode]) || 0;

      if (rightMatches !== leftMatches) {
        return rightMatches - leftMatches;
      }

      return String(leftPlayer.username || '').localeCompare(String(rightPlayer.username || ''), undefined, { sensitivity: 'base' });
    });

    playersArray.forEach((player, index) => {
      player.rank = index + 1;
    });
    
    // Add achievement titles (only for returned players to save CPU)
    playersArray.forEach(player => {
      player.achievementTitles = {
        overall: getAchievementTitle('overall', player.overallRating || 1000)
      };
      if (player.gamemodeRatings) {
        for (const [gm, rating] of Object.entries(player.gamemodeRatings)) {
          player.achievementTitles[gm] = getAchievementTitle(gm, rating);
        }
      }
    });
    
    // Update cache if no gamemode filter
    if (!gamemode && !region && !search) {
      playersCache.data = playersArray;
      playersCache.updatedAt = now;
    }
    
    // Apply pagination
    const total = playersArray.length;
    const pageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : total;
    const staffRoles = await getAllStaffRoles().catch(() => ({}));
    const paginatedBase = playersArray.slice(start, start + pageLimit);
    const userMetaById = await getPublicUserMetaBatch(
      paginatedBase.map((player) => player.userId).filter(Boolean),
      staffRoles
    );
    const paginated = paginatedBase.map((player) => {
      const userMeta = player.userId ? userMetaById[player.userId] : null;
      return {
        ...player,
        plus: userMeta?.plus ?? player.plus ?? null,
        retiredGamemodes: userMeta?.retiredGamemodes ?? player.retiredGamemodes ?? {},
        verifiedAdminRole: userMeta?.verifiedAdminRole || player.verifiedAdminRole || null,
        verifiedRoles: {
          admin: Boolean(player.verifiedRoles?.admin === true || userMeta?.verifiedRoles?.admin === true),
          tester: Boolean(player.verifiedRoles?.tester === true || userMeta?.verifiedRoles?.tester === true)
        },
        verifiedStaffRole: userMeta?.verifiedStaffRole || player.verifiedStaffRole || null
      };
    });
    
    res.json({ 
      players: paginated,
      total,
      limit: pageLimit,
      offset: start,
      hasMore: (start + pageLimit) < total
    });
  } catch (error) {
    console.error('Error fetching players:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching players'
    });
  }
});

function normalizePlayerSearchText(value) {
  return String(value || '').trim().toLowerCase();
}

function isLooseSubsequence(query, target) {
  if (!query || !target) return false;
  let queryIndex = 0;
  for (let index = 0; index < target.length; index++) {
    if (target[index] === query[queryIndex]) {
      queryIndex += 1;
      if (queryIndex >= query.length) {
        return true;
      }
    }
  }
  return false;
}

function scoreAutocompleteCandidate(player, query) {
  const normalizedQuery = normalizePlayerSearchText(query);
  const username = normalizePlayerSearchText(player?.username);
  const region = normalizePlayerSearchText(player?.region);

  if (!normalizedQuery || !username) return 0;

  let score = 0;

  if (username === normalizedQuery) score += 120;
  if (username.startsWith(normalizedQuery)) score += 90;

  const containsIndex = username.indexOf(normalizedQuery);
  if (containsIndex >= 0) {
    score += Math.max(40, 70 - containsIndex);
  }

  if (isLooseSubsequence(normalizedQuery, username)) {
    score += 24;
  }

  if (region && region === normalizedQuery) score += 18;
  if (region && region.startsWith(normalizedQuery)) score += 10;

  score += Math.min(12, Math.round((Number(player?.overallRating) || 0) / 250));
  return score;
}

/**
 * GET /api/players/search/autocomplete - Public live player suggestions
 */
app.get('/api/players/search/autocomplete', async (req, res) => {
  try {
    const rawQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const requestedRegion = typeof req.query.region === 'string' ? req.query.region.trim().toUpperCase() : '';
    const requestedGamemode = typeof req.query.gamemode === 'string' ? req.query.gamemode.trim().toLowerCase() : '';
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 8));

    if (!rawQuery || rawQuery.length < 1) {
      return res.json({ query: rawQuery, suggestions: [] });
    }

    const [playersSnapshot, blacklistSnapshot] = await Promise.all([
      db.ref('players').once('value'),
      db.ref('blacklist').once('value')
    ]);

    const players = playersSnapshot.val() || {};
    const blacklist = blacklistSnapshot.val() || {};
    const blacklistedUsernames = new Set(
      Object.values(blacklist)
        .filter((entry) => isBlacklistEntryActive(entry))
        .map((entry) => normalizePlayerSearchText(entry?.username))
        .filter(Boolean)
    );

    const suggestions = Object.entries(players)
      .map(([id, player]) => {
        const overallRating = Number(player?.overallRating ?? calculateOverallRating(player?.gamemodeRatings || {})) || 0;
        return {
          id,
          username: player?.username || '',
          region: player?.region || 'Unknown',
          overallRating,
          gamemodeRatings: player?.gamemodeRatings || {},
          minecraftUUID: player?.minecraftUUID || null
        };
      })
      .filter((player) => player.username && !blacklistedUsernames.has(normalizePlayerSearchText(player.username)))
      .filter((player) => !requestedRegion || String(player.region || '').trim().toUpperCase() === requestedRegion)
      .filter((player) => !requestedGamemode || Number(player.gamemodeRatings?.[requestedGamemode]) > 0)
      .map((player) => ({
        ...player,
        _score: scoreAutocompleteCandidate(player, rawQuery)
      }))
      .filter((player) => player._score > 0)
      .sort((left, right) => {
        if (right._score !== left._score) {
          return right._score - left._score;
        }
        if (right.overallRating !== left.overallRating) {
          return right.overallRating - left.overallRating;
        }
        return String(left.username || '').localeCompare(String(right.username || ''), undefined, { sensitivity: 'base' });
      })
      .slice(0, limit)
      .map((player) => ({
        id: player.id,
        username: player.username,
        region: player.region,
        overallRating: player.overallRating,
        minecraftUUID: player.minecraftUUID
      }));

    res.json({
      query: rawQuery,
      suggestions
    });
  } catch (error) {
    console.error('Error fetching player autocomplete suggestions:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching player suggestions'
    });
  }
});

/**
 * POST /api/players - Create a new player (admin only)
 */
app.post('/api/players', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { username, region } = req.body;

    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Username is required'
      });
    }

    const normalizedUsername = username.trim().toLowerCase();
    const playersRef = db.ref('players');

    // Check if player already exists
    const existingPlayersSnapshot = await playersRef.once('value');
    const existingPlayers = existingPlayersSnapshot.val() || {};

    for (const [key, player] of Object.entries(existingPlayers)) {
      if (player.username?.toLowerCase() === normalizedUsername) {
        return res.status(409).json({
          error: true,
          code: 'PLAYER_EXISTS',
          message: 'Player already exists'
        });
      }
    }

    // Create new player
    const newPlayerRef = playersRef.push();
    const playerData = {
      username: username.trim(),
      region: region || null,
      blacklisted: false,
      gamemodeRatings: {},
      overallRating: 0,
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid
    };

    await newPlayerRef.set(playerData);

    res.json({
      success: true,
      player: {
        id: newPlayerRef.key,
        ...playerData
      }
    });
  } catch (error) {
    console.error('Error creating player:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error creating player'
    });
  }
});

/**
 * GET /api/players/:id - Get player by ID
 */
app.get('/api/players/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const playerRef = db.ref(`players/${id}`);
    const snapshot = await playerRef.once('value');
    const player = snapshot.val();
    
    if (!player) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Player not found'
      });
    }
    
    res.json({ ...player, id });
  } catch (error) {
    console.error('Error fetching player:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching player'
    });
  }
});

/**
 * Build the public player profile payload used by player pages/search.
 */
async function buildPublicPlayerProfile(playerId, player) {
  const playersRef = db.ref('players');
  const [staffRoles, usersSnapshot, allPlayersSnapshot] = await Promise.all([
    getAllStaffRoles().catch(() => ({})),
    db.ref('users').once('value'),
    playersRef.once('value')
  ]);
  const allUsers = usersSnapshot.val() || {};
  const allPlayers = allPlayersSnapshot.val() || {};

  let userProfile = null;
  if (player.userId && allUsers[player.userId]) {
    userProfile = allUsers[player.userId];
  } else {
    const normalizedPlayerUsername = normalizeMinecraftUsername(player.username);
    const userEntry = Object.values(allUsers).find((candidate) => normalizeMinecraftUsername(candidate?.minecraftUsername) === normalizedPlayerUsername);
    userProfile = userEntry || null;
  }

  const resolvedStaffRole = userProfile ? resolveStaffRoleForProfile(userProfile, staffRoles) : null;
  const verifiedAdminRole = userProfile ? getAdminRole(userProfile, userProfile.email || '') : null;
  const verifiedRoles = {
    admin: Boolean(verifiedAdminRole),
    tester: Boolean(userProfile?.tester === true)
  };
  const plus = userProfile?.plus || player.plus || null;
  const retiredGamemodes = userProfile?.retiredGamemodes || player.retiredGamemodes || {};
  const isBlacklisted = Boolean(await findActiveBlacklistEntry({
    username: player.username,
    uuid: player.minecraftUUID
  }));

  if (isBlacklisted) {
    return {
      id: playerId,
      uuid: player.minecraftUUID || playerId,
      name: player.username,
      username: player.username,
      userId: player.userId || null,
      blacklisted: true,
      rankings: {},
      region: player.region || 'Unknown',
      points: 0,
      overall: 0,
      overallRating: 0,
      globalRank: null,
      badges: [],
      combat_master: false,
      plus,
      verifiedAdminRole,
      verifiedRoles,
      staffRole: resolvedStaffRole,
      retiredGamemodes
    };
  }

  const overallRating = calculateOverallRating(player.gamemodeRatings || {});
  const playersWithRatings = Object.entries(allPlayers)
    .map(([id, candidate]) => ({
      id,
      overallRating: calculateOverallRating(candidate?.gamemodeRatings || {})
    }))
    .sort((a, b) => b.overallRating - a.overallRating);
  const globalRankIndex = playersWithRatings.findIndex((entry) => entry.id === playerId);
  const globalRank = globalRankIndex >= 0 ? globalRankIndex + 1 : null;

  const response = {
    id: playerId,
    uuid: player.minecraftUUID || playerId,
    name: player.username,
    username: player.username,
    userId: player.userId || null,
    rankings: {},
    region: player.region || 'Unknown',
    points: 0,
    overall: overallRating,
    overallRating,
    globalRank,
    blacklisted: false,
    badges: [],
    combat_master: false,
    plus,
    verifiedAdminRole,
    verifiedRoles,
    staffRole: resolvedStaffRole,
    retiredGamemodes
  };

  if (player.gamemodeRatings) {
    Object.keys(player.gamemodeRatings).forEach((gamemode) => {
      response.rankings[gamemode] = {
        rating: player.gamemodeRatings[gamemode] || 1000,
        peak_rating: player.peakRatings?.[gamemode] || player.gamemodeRatings[gamemode] || 1000,
        games_played: player.gamemodeMatchCount?.[gamemode] || 0
      };
    });
  }

  return response;
}

/**
 * GET /api/players/:id/public-profile - Public player profile by ID
 */
app.get('/api/players/:id/public-profile', async (req, res) => {
  try {
    const rawPlayerId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!rawPlayerId) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_PLAYER_ID',
        message: 'Player ID is required'
      });
    }

    const playerSnapshot = await db.ref(`players/${rawPlayerId}`).once('value');
    const player = playerSnapshot.val();
    if (!player) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Player not found'
      });
    }

    const response = await buildPublicPlayerProfile(rawPlayerId, player);
    res.json(response);
  } catch (error) {
    console.error('Error fetching public player profile:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching player profile'
    });
  }
});

/**
 * GET /api/players/username/:username - Disabled legacy username lookup
 */
app.get('/api/players/username/:username', async (req, res) => {
  return res.status(410).json({
    error: true,
    code: 'ENDPOINT_DISABLED',
    message: 'Username-based player lookups have been disabled'
  });
});

/**
 * GET /api/players/username/:username/matches - Disabled legacy username match history
 */
app.get('/api/players/username/:username/matches', async (req, res) => {
  return res.status(410).json({
    error: true,
    code: 'ENDPOINT_DISABLED',
    message: 'Username-based player match history has been disabled'
  });
});

/**
 * GET /api/players/:id/matches - Public paginated player match history by ID
 */
app.get('/api/players/:id/matches', async (req, res) => {
  try {
    const rawPlayerId = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!rawPlayerId) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_PLAYER_ID',
        message: 'Player ID is required'
      });
    }

    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit, 10) || 10));
    const playerSnapshot = await db.ref(`players/${rawPlayerId}`).once('value');
    const player = playerSnapshot.val();
    if (!player) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Player not found'
      });
    }

    const normalizedUsername = normalizeMinecraftUsername(player.username);
    const history = (await listStoredMatchHistoryForUsername(normalizedUsername, player))
      .filter((match) => {
        const playerMatchesByUserId = player.userId && (match.playerId === player.userId || match.testerId === player.userId);
        const playerMatchesByUsername = normalizeMinecraftUsername(match.playerUsername) === normalizedUsername
          || normalizeMinecraftUsername(match.testerUsername) === normalizedUsername;
        return Boolean(playerMatchesByUserId || playerMatchesByUsername);
      })
      .sort((left, right) => {
        return parseDateToMs(right.finalizedAt || right.createdAt) - parseDateToMs(left.finalizedAt || left.createdAt);
      })
      .map((match) => {
        const asPlayer = normalizeMinecraftUsername(match.playerUsername) === normalizedUsername
          || (player.userId && match.playerId === player.userId);
        const userScore = Number(asPlayer ? (match.finalizationData?.playerScore ?? match.playerScore ?? 0) : (match.finalizationData?.testerScore ?? match.testerScore ?? 0)) || 0;
        const opponentScore = Number(asPlayer ? (match.finalizationData?.testerScore ?? match.testerScore ?? 0) : (match.finalizationData?.playerScore ?? match.playerScore ?? 0)) || 0;
        const opponentName = asPlayer ? (match.testerUsername || 'Unknown') : (match.playerUsername || 'Unknown');

        return sanitizeMatchForClient({
          ...match,
          matchId: match.matchId || match.id,
          userRole: asPlayer ? 'player' : 'tester',
          opponentName,
          userScore,
          opponentScore,
          result: userScore > opponentScore ? 'win' : (userScore < opponentScore ? 'loss' : 'draw')
        }, match.matchId || match.id);
      });

    const total = history.length;
    const start = (page - 1) * limit;
    const paginatedMatches = history.slice(start, start + limit);

    res.json({
      playerId: rawPlayerId,
      username: player.username,
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
      hasMore: (start + limit) < total,
      matches: paginatedMatches
    });
  } catch (error) {
    console.error('Error fetching public player match history by ID:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching player matches'
    });
  }
});

// ===== Alt Detection Routes =====

/**
 * POST /api/auth/check-ban - Check if an email is banned before login
 */
app.post('/api/auth/check-ban', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_EMAIL',
        message: 'Email is required'
      });
    }

    // Find user by email
    const usersRef = db.ref('users');
    const userSnapshot = await usersRef.orderByChild('email').equalTo(email.toLowerCase()).once('value');
    const users = userSnapshot.val();

    // Return identical response for "not found" and "not banned" to prevent account enumeration
    const NOT_BANNED_RESPONSE = { banned: false, warnings: [], message: 'No active ban' };

    if (!users) {
      return res.json(NOT_BANNED_RESPONSE);
    }

    const userId = Object.keys(users)[0];
    const userProfile = users[userId];

    if (!userProfile.banned) {
      // Don't leak warnings pre-login — they will be shown after authentication
      return res.json(NOT_BANNED_RESPONSE);
    }

    // Check if ban has expired
    if (userProfile.banExpires && userProfile.banExpires !== 'permanent') {
      const banExpires = new Date(userProfile.banExpires);
      const now = new Date();

      if (banExpires <= now) {
        // Ban has expired, auto-unban
        console.log(`Auto-unbanning expired ban for email: ${email}`);
        await db.ref(`users/${userId}`).update({
          banned: null,
          bannedAt: null,
          bannedBy: null,
          banExpires: null,
          banReason: null
        });

        return res.json(NOT_BANNED_RESPONSE);
      }
    }

    // User is still banned - calculate time remaining
    let timeRemaining = null;
    let timeRemainingText = '';

    if (userProfile.banExpires && userProfile.banExpires !== 'permanent') {
      const banExpires = new Date(userProfile.banExpires);
      const now = new Date();
      timeRemaining = Math.max(0, banExpires - now);

      // Format time remaining
      const days = Math.floor(timeRemaining / (1000 * 60 * 60 * 24));
      const hours = Math.floor((timeRemaining % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
      const minutes = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));

      if (days > 0) {
        timeRemainingText = `${days} day${days > 1 ? 's' : ''}, ${hours} hour${hours > 1 ? 's' : ''}`;
      } else if (hours > 0) {
        timeRemainingText = `${hours} hour${hours > 1 ? 's' : ''}, ${minutes} minute${minutes > 1 ? 's' : ''}`;
      } else {
        timeRemainingText = `${minutes} minute${minutes > 1 ? 's' : ''}`;
      }
    }

    return res.json({
      banned: true,
      reason: userProfile.banReason || 'Your account has been banned',
      bannedAt: userProfile.bannedAt || null,
      banExpires: userProfile.banExpires,
      timeRemaining: timeRemaining,
      timeRemainingText: timeRemainingText,
      isPermanent: userProfile.banExpires === 'permanent'
    });

  } catch (error) {
    console.error('Error checking ban status:', error);
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error checking ban status'
    });
  }
});

/**
 * Log admin action to audit log
 */
async function logAdminAction(req, adminUid, action, targetUserId = null, details = {}) {
  try {
    const logEntry = sanitizeFirebaseValue({
      id: Date.now().toString(),
      timestamp: new Date().toISOString(),
      adminUid: adminUid,
      action: action,
      targetUserId: targetUserId,
      details: details || {},
      ipAddress: getClientIP(req),
      userAgent: req.headers['user-agent'] || 'Unknown'
    });

    await writeAuditLogEntry(logEntry);
    logger.audit('Admin action recorded', { adminUid, action, targetUserId });
  } catch (error) {
    logger.error('Failed to write admin audit log', { adminUid, action, targetUserId, error });
  }
}

/**
 * POST /api/admin/warn - Warn a player (admin only)
 */
app.post('/api/admin/warn', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { userId, reason } = req.body;

    if (!userId || !reason) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_DATA',
        message: 'userId and reason are required'
      });
    }

    // Check for profanity in reason
    try {
      const hasProfanity = await containsProfanity(reason.trim());
      if (hasProfanity) {
        return res.status(400).json({
          error: true,
          code: 'PROFANITY_DETECTED',
          message: 'Reason contains inappropriate language and cannot be used'
        });
      }
    } catch (error) {
      // If profanity filter is unavailable, block the request
      return res.status(503).json({
        error: true,
        code: 'FILTER_UNAVAILABLE',
        message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
      });
    }

    // Get user profile
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (!userProfile) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Add warning to user's warnings array
    const warnings = userProfile.warnings || [];
    warnings.push({
      id: Date.now().toString(),
      reason: reason,
      warnedBy: req.user.uid,
      warnedAt: new Date().toISOString(),
      acknowledged: false
    });

    await userRef.update({
      warnings: warnings,
      updatedAt: new Date().toISOString()
    });

    // Send inbox notification about the warning
    await sendInboxMessage(userId, {
      title: 'Account Warning',
      message: `You have received a warning on your account.\n\nReason: ${reason}\n\nPlease review our rules and ensure compliance. Continued violations may result in further action including account restrictions.\n\nIf you believe this was issued in error, contact support.`,
      type: 'warning',
      from: 'MC Leaderboards Moderation',
      reason: reason
    });

    // Log admin action
    await logAdminAction(req, req.user.uid, 'WARN_USER', userId, { reason });

    res.json({
      success: true,
      message: 'Warning issued successfully'
    });

  } catch (error) {
    console.error('Error issuing warning:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error issuing warning'
    });
  }
});

/**
 * GET /api/admin/audit-log - Get admin audit log (admin only)
 */
app.get('/api/admin/audit-log', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'audit:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Audit capability required' });
    }

    const { action, adminUid, targetUserId, startDate, endDate } = req.query;
    const safeQ = sanitizeSearchQuery(req.query.q, 160);
    const { limit: safeLimit, page: safePage, offset: safeOffset } = parsePaginationParams(req.query, 50, 200);

    const maxFetchLimit = Math.min((safeLimit + safeOffset) * 3, 1000);
    let logs = await listAuditLogEntries({
      limit: action || adminUid || targetUserId || safeQ ? maxFetchLimit : safeLimit + safeOffset
    });

    // Apply additional filters
    if (action) {
      logs = logs.filter(log => log.action === action);
    }
    if (adminUid) {
      logs = logs.filter(log => log.adminUid === adminUid);
    }
    if (targetUserId) {
      logs = logs.filter(log => log.targetUserId === targetUserId);
    }
    if (safeQ) {
      const qLower = safeQ.toLowerCase();
      logs = logs.filter(log => {
        const haystack = [
          log.action,
          log.adminUid,
          log.targetUserId,
          JSON.stringify(log.details || {})
        ].join(' ').toLowerCase();
        return haystack.includes(qLower);
      });
    }

    // Apply pagination
    const startIndex = safeOffset;
    const endIndex = startIndex + safeLimit;
    const paginatedLogs = logs.slice(startIndex, endIndex);

    res.json({
      success: true,
      logs: paginatedLogs,
      total: logs.length,
      hasMore: endIndex < logs.length,
      pagination: {
        page: safePage,
        limit: safeLimit,
        offset: safeOffset,
        total: logs.length,
        totalPages: Math.max(1, Math.ceil(logs.length / safeLimit))
      }
    });

  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching audit log'
    });
  }
});

registerAuthRoutes({
  app,
  admin,
  db,
  config,
  logger,
  verifyAuth,
  checkBanned,
  requireRecaptcha,
  getClientIP,
  detectAltAccount,
  createConsolidatedAltReport,
  detectAccountAnomalies,
  checkAndFlagSuspiciousAccount,
  containsProfanity,
  isUsernameBlacklisted,
  triggerMinecraftUuidLinkForUser,
  hasAdminAccess
});

/**
 * GET /api/auth/verification-code - Get current user's verification code
 */
app.get('/api/auth/verification-code', verifyAuth, async (req, res) => {
  try {
    // Get current user's pending verifications
    const pendingVerificationsRef = db.ref('pendingVerifications');
    const pendingSnapshot = await pendingVerificationsRef.once('value');
    const pendingVerifications = pendingSnapshot.val() || {};

    // Find the most recent pending verification for this user
    let latestVerification = null;
    let latestTimestamp = 0;

    for (const [key, verification] of Object.entries(pendingVerifications)) {
      if (verification.userId === req.user.uid && verification.expiresAt > Date.now()) {
        if (verification.createdAt > latestTimestamp) {
          latestVerification = verification;
          latestTimestamp = verification.createdAt;
        }
      }
    }

    if (!latestVerification) {
      return res.status(404).json({
        error: true,
        code: 'NO_VERIFICATION_CODE',
        message: 'No active verification code found'
      });
    }

    res.json({
      success: true,
      verificationCode: latestVerification.verificationCode,
      expiresAt: latestVerification.expiresAt
    });

  } catch (error) {
    logger.error('Failed to retrieve verification code', { userId: req.user?.uid, error });
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error retrieving verification code'
    });
  }
});

/**
 * POST /api/auth/cleanup-minecraft - Clean up incomplete Minecraft linking data
 */
app.post('/api/auth/cleanup-minecraft', verifyAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    // Securely clean up all Minecraft-related data for this authenticated user only
    const userRef = db.ref(`users/${userId}`);
    await userRef.update({
      minecraftUsername: null,
      minecraftVerified: false,
      region: null,
      minecraftUUID: null,
      pendingMinecraftUUID: null,
      verifiedAt: null
    });

    // Clean up ALL pending verifications for this user (active and expired)
    const pendingVerificationsRef = db.ref('pendingVerifications');
    const pendingSnapshot = await pendingVerificationsRef.once('value');
    const pendingVerifications = pendingSnapshot.val() || {};

    const updates = {};
    let cleanupCount = 0;
    for (const [key, verification] of Object.entries(pendingVerifications)) {
      if (verification.userId === userId) {
        updates[key] = null; // Mark for deletion
        cleanupCount++;
      }
    }

    if (cleanupCount > 0) {
      await pendingVerificationsRef.update(updates);
    }

    logger.info('Minecraft linking data cleaned up', { userId, cleanedVerifications: cleanupCount });
    res.json({
      success: true,
      message: 'Minecraft linking data cleaned up successfully',
      cleanedVerifications: cleanupCount
    });

  } catch (error) {
    logger.error('Failed to clean up Minecraft linking data', { userId: req.user?.uid, error });
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error cleaning up Minecraft data'
    });
  }
});

/**
 * POST /api/auth/verify-minecraft - Verify Minecraft account from plugin
 */
app.post('/api/auth/verify-minecraft', async (req, res) => {
  try {
    // Check API key for plugin authentication
    const authHeader = req.headers.authorization;
    const expectedApiKey = PLUGIN_API_KEY;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: true,
        code: 'INVALID_AUTH',
        message: 'Missing or invalid authorization header'
      });
    }

    const apiKey = authHeader.split('Bearer ')[1];
    if (apiKey !== expectedApiKey) {
      return res.status(401).json({
        error: true,
        code: 'INVALID_API_KEY',
        message: 'Invalid API key'
      });
    }

    const { playerUUID, playerName, serverName, verificationCode } = req.body;
    const normalizedPlayerUUID = normalizeMinecraftUUID(playerUUID);

    if (!normalizedPlayerUUID || !playerName || !serverName || !verificationCode) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_DATA',
        message: 'Player UUID, name, server name, and verification code are required'
      });
    }


    // Find pending verification request for this player
    const pendingVerificationsRef = db.ref('pendingVerifications');
    const pendingSnapshot = await pendingVerificationsRef.once('value');
    const pendingVerifications = pendingSnapshot.val() || {};

    let verificationKey = null;
    let userId = null;

    // Find matching pending verification
    // First find by code, then check if username matches the expected username for that user
    logger.debug('Processing Minecraft verification request', { playerName, serverName });
    for (const [key, verification] of Object.entries(pendingVerifications)) {
      if (verification.verificationCode === verificationCode &&
          verification.expiresAt > Date.now()) {
        // Found code, now check if username matches expected username for this user
        // Support both old playerName field and new expectedUsername field for backward compatibility
        const expectedUsername = verification.expectedUsername || verification.playerName;
        if (normalizeMinecraftUsername(expectedUsername) === normalizeMinecraftUsername(playerName)) {
          const expectedUUID = normalizeMinecraftUUID(verification.expectedUUID);
          if (expectedUUID && expectedUUID !== normalizedPlayerUUID) {
            return res.status(400).json({
              error: true,
              code: 'UUID_MISMATCH',
              message: 'This verification code is bound to a different Minecraft account UUID.'
            });
          }
          verificationKey = key;
          userId = verification.userId;
          break;
        } else {
          logger.warn('Minecraft verification username mismatch', {
            expectedUsername,
            playerName,
            userId: verification.userId
          });
          return res.status(400).json({
            error: true,
            code: 'USERNAME_MISMATCH',
            message: `Username mismatch. This code is for username: ${expectedUsername}`
          });
        }
      }
    }

    if (!verificationKey) {
      return res.status(404).json({
        error: true,
        code: 'NO_PENDING_VERIFICATION',
        message: 'No pending verification found for this player'
      });
    }

    // Update the pending verification with the player's UUID for future reference
    await pendingVerificationsRef.child(verificationKey).update({
      playerUUID: normalizedPlayerUUID
    });

    // Update user profile with verified status
    const userRef = db.ref(`users/${userId}`);
    // First get the user's region from their profile
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};
    const userRegion = userData.region || 'Unknown';

    await userRef.update({
      minecraftVerified: true,
      minecraftUUID: normalizedPlayerUUID,
      pendingMinecraftUUID: null,
      usernameLocked: true, // Lock username changes once verified
      verifiedAt: new Date().toISOString()
    });

    // Remove the pending verification
    await pendingVerificationsRef.child(verificationKey).remove();

    // Now create the player record since verification is complete
    const playersRef = db.ref('players');
    const normalizedUsername = playerName.trim().toLowerCase();

    // Check if player already exists
    const existingPlayersSnapshot = await playersRef.once('value');
    const existingPlayers = existingPlayersSnapshot.val() || {};
    let playerKey = null;

    // Find existing player by normalized username
    for (const [key, player] of Object.entries(existingPlayers)) {
      const playerUuid = normalizeMinecraftUUID(player.minecraftUUID);
      if (player.username?.toLowerCase() === normalizedUsername || (playerUuid && playerUuid === normalizedPlayerUUID)) {
        playerKey = key;
        break;
      }
    }

    const playerData = {
      username: playerName.trim(),
      minecraftUUID: normalizedPlayerUUID,
      userId: userId,
      region: userRegion, // Use the user's actual region
      blacklisted: false,
      roles: {
        admin: false,
        tester: false
      },
      updatedAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString()
    };

    if (playerKey) {
      // Update existing player
      await playersRef.child(playerKey).update(playerData);
    } else {
      // Create new player record
      await playersRef.push(playerData);
    }

    res.json({
      success: true,
      message: 'Minecraft account verified successfully'
    });

  } catch (error) {
    logger.error('Minecraft account verification failed', { error });
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: `Error verifying Minecraft account: ${error.message}`
    });
  }
});

// ===== Queue Routes =====

/**
 * POST /api/queue/join - Join queue
 */
app.post('/api/queue/join', verifyAuthAndNotBanned, requireRecaptcha, queueLimiter, async (req, res) => {
  // Check for bot activity (ToS Section 4)
  const { gamemodes: requestedGamemodes, regions: requestedRegions } = normalizeQueueSelections(req.body);
  const botCheck = await detectBotActivity(req.user.uid, 'queue_join', {
    gamemodes: requestedGamemodes,
    regions: requestedRegions,
    gamemode: requestedGamemodes[0] || req.body.gamemode,
    region: requestedRegions[0] || req.body.region
  });
  
  if (botCheck.suspicious && botCheck.severity === 'high') {
    return res.status(429).json({
      error: true,
      code: 'SUSPICIOUS_ACTIVITY',
      message: 'Suspicious activity detected. Please try again later.'
    });
  }

  // Extract and sanitize inputs for error logging
  const { serverIP } = req.body;
  const selectedGamemodes = requestedGamemodes;
  const selectedRegions = requestedRegions;
  const sanitizedServerIP = serverIP?.toString().trim();
    
  try {
    const trustDecision = await enforceTrustedTierListAccess(req.user.uid, {
      profile: req.userProfile || null,
      clientIP: getClientIP(req)
    });
    if (!trustDecision.allowed) {
      return res.status(403).json({
        error: true,
        code: trustDecision.code || 'COMPETITIVE_ACCESS_RESTRICTED',
        message: trustDecision.message || 'Competitive access is restricted for this account.'
      });
    }

    if (!selectedGamemodes.length || !selectedRegions.length || !sanitizedServerIP) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'gamemode, region, and serverIP are required'
      });
    }

    const invalidRegions = selectedRegions.filter((region) => !ALLOWED_REGIONS.has(region));
    if (invalidRegions.length > 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid region selection: ${invalidRegions.join(', ')}`
      });
    }

    const resolvedServerIP = await getCanonicalWhitelistedServerIP(sanitizedServerIP);
    if (!resolvedServerIP) {
      return res.status(400).json({
        error: true,
        code: 'SERVER_NOT_WHITELISTED',
        message: 'The server IP you entered is not whitelisted. Please select a whitelisted server or contact an admin.'
      });
    }

    // Validate selected gamemodes
    const configuredGamemodes = new Set((CONFIG.GAMEMODES || []).map((g) => g.id).filter(Boolean));
    const invalidGamemodes = selectedGamemodes.filter((gamemode) => !configuredGamemodes.has(gamemode));
    if (invalidGamemodes.length > 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid gamemode selection: ${invalidGamemodes.join(', ')}`
      });
    }
    
    // Get user profile
    console.log('Getting user profile for:', req.user.uid);
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();
    console.log('User profile exists:', !!userProfile, 'has minecraft username:', !!userProfile?.minecraftUsername);
    
    if (!userProfile || !userProfile.minecraftUsername) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Minecraft username must be linked first'
      });
    }

    // Check if any selected gamemode is retired for this user
    const retiredSelections = selectedGamemodes.filter((gamemode) => isUserRetiredFromGamemode(userProfile, gamemode));
    if (retiredSelections.length > 0) {
      return res.status(403).json({
        error: true,
        code: 'GAMEMODE_RETIRED',
        message: `You have retired from: ${retiredSelections.map((gm) => gm.toUpperCase()).join(', ')}`
      });
    }

    // Check if player has skill level for this gamemode - REQUIRED before queuing
    const playersRefForQueue = db.ref('players');
    const playerSnapshot = await playersRefForQueue.orderByChild('username').equalTo(userProfile.minecraftUsername).once('value');
    
    let playerData = null;
    let playerId = null;
    
    if (playerSnapshot.exists()) {
      const players = playerSnapshot.val();
      playerId = Object.keys(players)[0];
      playerData = players[playerId];
    }
    
    const missingRatings = selectedGamemodes.filter((gamemode) => !playerData?.gamemodeRatings?.[gamemode]);
    if (missingRatings.length > 0) {
      return res.status(400).json({
        error: true,
        code: 'SKILL_LEVEL_REQUIRED',
        message: `Set your skill level first for: ${missingRatings.map((gm) => gm.toUpperCase()).join(', ')}`
      });
    }
    
    const moderationState = await getUserModerationState(req.user.uid, userProfile);
    if (moderationState.blacklisted) {
      return res.status(403).json({
        error: true,
        code: 'BLACKLISTED',
        message: 'You are blacklisted and cannot join the queue'
      });
    }
    
    // Check if already in queue
    const queueRef = db.ref('queue');
    const queueSnapshot = await queueRef.orderByChild('userId').equalTo(req.user.uid).once('value');
    
    if (queueSnapshot.exists()) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_IN_QUEUE',
        message: 'You are already in the queue'
      });
    }

    // Check if user already has an active match
    const matchesRef = db.ref('matches');
    const activeMatchSnapshot = await matchesRef
      .orderByChild('status')
      .equalTo('active')
      .once('value');
    
    const activeMatches = activeMatchSnapshot.val() || {};
    const hasActiveMatch = Object.values(activeMatches).some(match => 
      !match.finalized && (match.playerId === req.user.uid || match.testerId === req.user.uid)
    );
    
    if (hasActiveMatch) {
      return res.status(400).json({
        error: true,
        code: 'ACTIVE_MATCH_EXISTS',
        message: 'You already have an active match. Please complete it before queuing again.'
      });
    }

    // Check if user has cooldown for any selected gamemode.
    // Testers and admins are exempt – they can run unlimited matches.
    const isTesterOrAdmin = !!(userProfile.tester === true || userProfile.admin === true || userProfile.adminRole);
    if (!isTesterOrAdmin) {
      for (const gamemode of selectedGamemodes) {
        const cooldownState = getQueueCooldownState(userProfile, gamemode);
        if (!cooldownState.allowed) {
          const remainingMinutes = Math.ceil(cooldownState.remainingMs / (60 * 1000));
          return res.status(400).json({
            error: true,
            code: 'COOLDOWN_ACTIVE',
            message: `${cooldownState.reason} You can queue for ${gamemode.toUpperCase()} again in about ${remainingMinutes} minute${remainingMinutes === 1 ? '' : 's'}.`
          });
        }
      }
    }
    
    // Create queue entry
    const newQueueRef = queueRef.push();
    const queueEntry = buildQueueEntry({
      queueId: newQueueRef.key,
      userId: req.user.uid,
      minecraftUsername: userProfile.minecraftUsername,
      gamemodes: selectedGamemodes,
      regions: selectedRegions,
      serverIP: resolvedServerIP,
      rolePreference: 'player',
      testerEligible: hasTierTesterQueueRole(userProfile),
      source: 'player_queue'
    });
    
    await newQueueRef.set(queueEntry);
    
    // Attempt immediate matchmaking with available testers
    const matchResult = await attemptImmediateMatchmaking(queueEntry, userProfile);

    if (matchResult) {
      // Match found and created
      res.json({
        success: true,
        queueId: newQueueRef.key,
        matched: true,
        matchId: matchResult.matchId,
        testerUsername: matchResult.testerUsername,
        message: 'Match found! Redirecting to testing page...'
      });
    } else {
      // No match found, player remains in queue
      res.json({
        success: true,
        queueId: newQueueRef.key,
        matched: false,
        message: 'Added to queue. Waiting for a compatible match...'
      });
    }
  } catch (error) {
    console.error('Error joining queue:', error);
    console.error('Error details:', {
      message: error.message,
      stack: error.stack,
      userId: req.user?.uid,
      gamemodes: selectedGamemodes,
      regions: selectedRegions,
      serverIP: sanitizedServerIP
    });
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error joining queue',
      details: error.message
    });
  }
});

/**
 * GET /api/queue/stats - Get queue statistics
 */
app.get('/api/queue/stats', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const [queueSnapshot, activeMatchesSnapshot] = await Promise.all([
      db.ref('queue').once('value'),
      db.ref('matches').orderByChild('status').equalTo('active').once('value')
    ]);

    const queueEntries = queueSnapshot.val() || {};
    const activeMatches = activeMatchesSnapshot.val() || {};

    const busyUserIds = new Set();
    Object.values(activeMatches).forEach((match) => {
      if (!match || match.finalized) return;
      if (match.playerId) busyUserIds.add(match.playerId);
      if (match.testerId) busyUserIds.add(match.testerId);
    });

    const queueList = Object.values(queueEntries).filter((entry) => (
      entry?.userId
      && !busyUserIds.has(entry.userId)
      && getQueueGamemodeList(entry).length > 0
      && getQueueRegionList(entry).length > 0
      && !isQueueEntryExpired(entry)
    ));

    // Count players queued by gamemode and region
    const playersQueued = {};
    queueList.forEach(entry => {
      const gamemodes = getQueueGamemodeList(entry);
      const regions = getQueueRegionList(entry);
      if (!gamemodes.length || !regions.length) return;

      gamemodes.forEach((gamemode) => {
        if (!playersQueued[gamemode]) {
          playersQueued[gamemode] = {};
        }
        regions.forEach((region) => {
          if (!playersQueued[gamemode][region]) {
            playersQueued[gamemode][region] = 0;
          }
          playersQueued[gamemode][region]++;
        });
      });
    });

    const testersAvailable = {};
    queueList.forEach((entry) => {
      if (!isQueueEntryTesterEligible(entry)) return;
      const selectedGamemodes = getQueueGamemodeList(entry);
      const selectedRegions = getQueueRegionList(entry);
      selectedGamemodes.forEach((selectedGamemode) => {
        if (!testersAvailable[selectedGamemode]) {
          testersAvailable[selectedGamemode] = {};
        }

        selectedRegions.forEach((selectedRegion) => {
          if (!testersAvailable[selectedGamemode][selectedRegion]) {
            testersAvailable[selectedGamemode][selectedRegion] = 0;
          }
          testersAvailable[selectedGamemode][selectedRegion]++;
        });
      });
    });

    const totalAvailableTesters = queueList.filter((entry) => isQueueEntryTesterEligible(entry)).length;

    res.json({
      success: true,
      playersQueued,
      testersAvailable,
      totalQueued: queueList.length,
      totalAvailableTesters
    });
  } catch (error) {
    console.error('Error getting queue stats:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting queue statistics'
    });
  }
});

// ===== Dashboard Stats (Per-Gamemode) =====
// Keep this endpoint lightweight and cached to avoid rate limits.
// Cache is keyed by region (or 'all' for no filter)
let dashboardGamemodeStatsCache = {};
const DASHBOARD_GAMEMODE_STATS_TTL_MS = 8000; // shorter than 10s polling interval
const MAX_DASHBOARD_CACHE_KEYS = 50; // Cap cache entries

async function getDashboardGamemodeStatsSnapshot(regionFilter = '') {
  const nowMs = Date.now();
  const cacheKey = regionFilter || 'all';

  if (!dashboardGamemodeStatsCache[cacheKey]) {
    const keys = Object.keys(dashboardGamemodeStatsCache);
    if (keys.length >= MAX_DASHBOARD_CACHE_KEYS) {
      delete dashboardGamemodeStatsCache[keys[0]];
    }
    dashboardGamemodeStatsCache[cacheKey] = { data: null, updatedAtMs: 0 };
  }

  if (
    dashboardGamemodeStatsCache[cacheKey].data
    && (nowMs - dashboardGamemodeStatsCache[cacheKey].updatedAtMs) < DASHBOARD_GAMEMODE_STATS_TTL_MS
  ) {
    return {
      statsByGamemode: dashboardGamemodeStatsCache[cacheKey].data,
      generatedAt: new Date(dashboardGamemodeStatsCache[cacheKey].updatedAtMs).toISOString(),
      cached: true,
      region: regionFilter
    };
  }

  const [queueSnapshot, activeMatchesSnapshot] = await Promise.all([
    db.ref('queue').once('value'),
    db.ref('matches').orderByChild('status').equalTo('active').once('value')
  ]);

  const queueEntries = queueSnapshot.val() || {};
  const activeMatches = activeMatchesSnapshot.val() || {};

  const busyUserIds = new Set();
  Object.values(activeMatches).forEach(match => {
    if (!match || match.finalized) return;
    if (match.playerId) busyUserIds.add(match.playerId);
    if (match.testerId) busyUserIds.add(match.testerId);
  });

  const queueList = Object.values(queueEntries).filter((entry) => (
    entry?.userId
    && !busyUserIds.has(entry.userId)
    && !isQueueEntryExpired(entry)
  ));

  const playersQueuedByGamemode = {};
  queueList.forEach(entry => {
    const gamemodes = getQueueGamemodeList(entry);
    const regions = getQueueRegionList(entry);
    if (!gamemodes.length || !regions.length) return;

    const regionMatches = !regionFilter || regions.includes(regionFilter);
    if (!regionMatches) return;

    if (entry.rolePreference === 'tester') return;
    gamemodes.forEach((gm) => {
      playersQueuedByGamemode[gm] = (playersQueuedByGamemode[gm] || 0) + 1;
    });
  });

  const testersAvailableByGamemode = {};
  queueList.forEach(entry => {
    const gamemodes = getQueueGamemodeList(entry);
    const regions = getQueueRegionList(entry);
    if (!gamemodes.length || !regions.length) return;

    const regionMatches = !regionFilter || regions.includes(regionFilter);
    if (!regionMatches) return;

    if (entry.rolePreference !== 'tester') return;
    gamemodes.forEach((gm) => {
      testersAvailableByGamemode[gm] = (testersAvailableByGamemode[gm] || 0) + 1;
    });
  });

  const activeMatchesByGamemode = {};
  Object.values(activeMatches).forEach(match => {
    if (!match || match.finalized || match.status !== 'active' || !match.gamemode) return;
    if (regionFilter && match.region !== regionFilter) return;
    activeMatchesByGamemode[match.gamemode] = (activeMatchesByGamemode[match.gamemode] || 0) + 1;
  });

  const statsByGamemode = {};
  CONFIG.GAMEMODES.filter(gm => gm.id !== 'overall').forEach(({ id: gm }) => {
    statsByGamemode[gm] = {
      testersAvailable: testersAvailableByGamemode[gm] || 0,
      playersQueued: playersQueuedByGamemode[gm] || 0,
      activeMatches: activeMatchesByGamemode[gm] || 0
    };
  });

  dashboardGamemodeStatsCache[cacheKey] = { data: statsByGamemode, updatedAtMs: nowMs };
  return {
    statsByGamemode,
    generatedAt: new Date(nowMs).toISOString(),
    cached: false,
    region: regionFilter
  };
}

/**
 * GET /api/dashboard/gamemode-stats - Per-gamemode counts for dashboard widget
 * Returns: { success: true, statsByGamemode: { [gamemode]: { testersAvailable, playersQueued, activeMatches } }, generatedAt }
 */
app.get('/api/dashboard/gamemode-stats', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const regionFilter = req.query.region || '';
    const snapshot = await getDashboardGamemodeStatsSnapshot(regionFilter);

    return res.json({
      success: true,
      statsByGamemode: snapshot.statsByGamemode,
      generatedAt: snapshot.generatedAt,
      cached: snapshot.cached,
      region: snapshot.region
    });
  } catch (error) {
    console.error('Error getting dashboard gamemode stats:', error);
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting dashboard gamemode stats'
    });
  }
});

/**
 * GET /api/user/cooldowns - Get user's active cooldowns
 */
app.get('/api/user/cooldowns', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};
    const cooldowns = [];

    // Check each gamemode for active cooldowns
    const gamemodes = ['vanilla', 'uhc', 'pot', 'nethop', 'smp', 'sword', 'axe', 'mace'];

    gamemodes.forEach(gamemode => {
      const cooldownState = getQueueCooldownState(userData, gamemode);
      if (!cooldownState.allowed) {
        const startedAtMs = parseDateToMs(cooldownState.startedAt);
        cooldowns.push({
          gamemode,
          type: cooldownState.type,
          reason: cooldownState.reason,
          startedAt: cooldownState.startedAt,
          remainingMs: cooldownState.remainingMs,
          expiresAt: startedAtMs ? new Date(startedAtMs + QUEUE_COOLDOWN_MS).toISOString() : null,
          eventLabel: cooldownState.type === 'testing' ? 'Recently tested' : 'Recently completed a match'
        });
      }
    });

    res.json({
      success: true,
      cooldowns
    });
  } catch (error) {
    console.error('Error getting user cooldowns:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error retrieving cooldowns'
    });
  }
});

/**
 * POST /api/queue/leave - Leave queue
 */
app.post('/api/queue/leave', verifyAuthAndNotBanned, requireRecaptcha, queueLimiter, async (req, res) => {
  try {
    const removedCount = await clearUserQueueEntries(req.user.uid);

    if (removedCount === 0) {
      return res.status(404).json({
        error: true,
        code: 'NOT_IN_QUEUE',
        message: 'You are not in the queue'
      });
    }

    res.json({ success: true, message: 'Left queue successfully' });
  } catch (error) {
    console.error('Error leaving queue:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error leaving queue'
    });
  }
});

/**
 * GET /api/queue/status - Get queue status for current user
 */
app.get('/api/queue/status', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const queueRef = db.ref('queue');
    const queueSnapshot = await queueRef.orderByChild('userId').equalTo(req.user.uid).once('value');
    
    if (!queueSnapshot.exists()) {
      return res.json({ inQueue: false });
    }
    
    const queueEntry = queueSnapshot.val();
    const entryKey = Object.keys(queueEntry)[0];
    const entry = queueEntry[entryKey];
    const queueSummary = await buildQueueStatusSummary(entry, req.user.uid);
    
    res.json({ inQueue: true, queueEntry: entry, queueSummary });
  } catch (error) {
    console.error('Error getting queue status:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting queue status'
    });
  }
});

// Start matchmaking interval
setInterval(async () => {
  if (matchmakingJobRunning) {
    return;
  }
  matchmakingJobRunning = true;
  try {
    await attemptMatchmaking();
  } catch (error) {
    console.error('Matchmaking error:', error);
  } finally {
    matchmakingJobRunning = false;
  }
}, 10000); // Run every 10 seconds

/**
 * Check if player should be matched with evaluation tester
 */
/**
 * Calculate Elo-based match suitability (lower score = better match)
 */
function calculateMatchScore(playerRating, testerRating) {
  const ratingDiff = Math.abs(playerRating - testerRating);

  // Expanded matchmaking range for broader compatibility
  // Optimal difference is around 200-600 Elo points
  if (ratingDiff < 25) return ratingDiff + 1500; // Too close, higher penalty
  if (ratingDiff > 1200) return ratingDiff + 300; // Too far, lower penalty

  return ratingDiff; // Broader optimal range, no penalty
}

/**
 * Get player Elo rating for a gamemode
 */
async function getPlayerRating(userId, gamemode) {
  try {
    // Get rating from player record only
    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.orderByChild('userId').equalTo(userId).once('value');
    const players = playersSnapshot.val() || {};
    const playerData = Object.values(players).find(p => p.userId === userId);

    return playerData?.gamemodeRatings?.[gamemode] || 1000; // Default to 1000 if no rating
  } catch (error) {
    console.error('Error getting player rating:', error);
    return 1000; // Default rating
  }
}

const MATCH_START_TIMEOUT_MS = 5 * 60 * 1000;

async function buildDrawRatingSnapshot(match) {
  const [playerNewRating, testerNewRating] = await Promise.all([
    getPlayerRating(match.playerId, match.gamemode),
    getPlayerRating(match.testerId, match.gamemode)
  ]);

  return {
    playerRatingChange: 0,
    testerRatingChange: 0,
    playerNewRating,
    testerNewRating
  };
}

async function finalizeMatchAsDrawWithoutScoring(matchId, match, { type = 'draw_vote', reason = 'Match ended as a draw without scoring.' } = {}) {
  const matchRef = db.ref(`matches/${matchId}`);
  const finalizedAt = new Date().toISOString();
  const ratingChanges = await buildDrawRatingSnapshot(match);
  const finalizationData = {
    type,
    reason,
    playerScore: 0,
    testerScore: 0,
    playerUsername: match.playerUsername,
    gamemode: match.gamemode,
    ratingChanges
  };

  await matchRef.update({
    finalized: true,
    finalizedAt,
    status: 'ended',
    countdownStartedAt: null,
    startCountdownHandled: true,
    finalizationData
  });

  const playerRef = db.ref(`users/${match.playerId}`);
  const playerSnap = await playerRef.once('value');
  const playerData = playerSnap.val() || {};
  const lastTested = playerData.lastTested || {};
  lastTested[match.gamemode] = finalizedAt;
  await playerRef.update({ lastTested });
  await storeQueueCooldownTimestamps(match.playerId, match.gamemode);

  await Promise.allSettled([
    createNotification(match.playerId, {
      type: 'match_finalized',
      title: 'Match Ended (Draw)',
      message: `Your ${match.gamemode} match ended as a draw. No rating change.`,
      matchId,
      gamemode: match.gamemode
    }),
    createNotification(match.testerId, {
      type: 'match_finalized',
      title: 'Match Ended (Draw)',
      message: `Your ${match.gamemode} match ended as a draw. No rating change.`,
      matchId,
      gamemode: match.gamemode
    })
  ]);

  fsWrite(`matchMetrics/${matchId}`, {
    matchId,
    playerId: match.playerId,
    testerId: match.testerId,
    gamemode: match.gamemode,
    durationMs: new Date(finalizedAt).getTime() - new Date(match.createdAt).getTime(),
    playerScore: 0,
    testerScore: 0,
    type,
    reason,
    createdAt: match.createdAt,
    finalizedAt
  }, false).catch(() => {});
  computeAndStoreSecurityScore(match.playerId).catch(() => {});
  computeAndStoreSecurityScore(match.testerId).catch(() => {});

  await Promise.all([
    requeueUserAfterFinalizedMatch(match, match.playerId, 'player'),
    requeueUserAfterFinalizedMatch(match, match.testerId, 'tester')
  ]);

  return finalizationData;
}

async function handleMatchStartCountdownTimeout(matchId) {
  try {
    const matchRef = db.ref(`matches/${matchId}`);
    const matchSnapshot = await matchRef.once('value');
    const match = matchSnapshot.val();

    if (!match || match.status !== 'active' || match.finalized || match.matchStarted || !match.countdownStartedAt) {
      return;
    }

    const countdownStartedAt = new Date(match.countdownStartedAt).getTime();
    if (Number.isNaN(countdownStartedAt) || (Date.now() - countdownStartedAt) < MATCH_START_TIMEOUT_MS) {
      return;
    }

    const lockResult = await matchRef.child('startCountdownHandled').transaction((currentValue) => {
      if (currentValue === true) {
        return undefined;
      }
      return true;
    });

    if (!lockResult.committed) {
      return;
    }

    console.log('Match', matchId, ': Start countdown expired, finalizing as draw');
    await finalizeMatchAsDrawWithoutScoring(matchId, match, {
      type: 'draw_timeout',
      reason: 'Match was not marked as started within 5 minutes.'
    });
  } catch (error) {
    console.error('Error handling match start countdown timeout for match', matchId, ':', error);
  }
}

function scheduleMatchStartCountdownTimeout(matchId, delayMs = MATCH_START_TIMEOUT_MS) {
  setTimeout(async () => {
    try {
      await handleMatchStartCountdownTimeout(matchId);
    } catch (error) {
      console.error('Error in scheduled match start countdown timeout for match', matchId, ':', error);
    }
  }, delayMs);
}

/**
 * Matchmaking algorithm
 */
async function attemptMatchmaking() {
  const queueRef = db.ref('queue');
  const [queueSnapshot, activeMatchesSnapshot] = await Promise.all([
    queueRef.once('value'),
    db.ref('matches').orderByChild('status').equalTo('active').once('value')
  ]);

  if (!queueSnapshot.exists()) return;

  const activeMatches = activeMatchesSnapshot.val() || {};
  const busyUserIds = new Set();
  Object.values(activeMatches).forEach((m) => {
    if (!m || m.finalized) return;
    if (m.playerId) busyUserIds.add(m.playerId);
    if (m.testerId) busyUserIds.add(m.testerId);
  });

  let queueEntries = Object.keys(queueSnapshot.val() || {}).map((key) => ({ key, ...queueSnapshot.val()[key] }));
  queueEntries = queueEntries
    .filter((entry) => (
      entry?.userId
      && getQueueGamemodeList(entry).length > 0
      && getQueueRegionList(entry).length > 0
      && !busyUserIds.has(entry.userId)
      && !isQueueEntryExpired(entry)
    ))
    .sort((a, b) => new Date(a.joinedAt || 0) - new Date(b.joinedAt || 0));

  if (queueEntries.length < 2) return;

  const allUserIds = [...new Set(queueEntries.map((entry) => entry.userId))];

  // Batch user lookups with concurrency limit to avoid exhausting DB connections
  const BATCH_SIZE = 20;
  const userSnapshots = [];
  const playerSnapshots = [];
  for (let i = 0; i < allUserIds.length; i += BATCH_SIZE) {
    const batch = allUserIds.slice(i, i + BATCH_SIZE);
    const [uBatch, pBatch] = await Promise.all([
      Promise.all(batch.map((userId) => db.ref(`users/${userId}`).once('value'))),
      Promise.all(batch.map((userId) => db.ref('players').orderByChild('userId').equalTo(userId).limitToFirst(1).once('value')))
    ]);
    userSnapshots.push(...uBatch);
    playerSnapshots.push(...pBatch);
  }

  const userProfilesById = new Map();
  const ratingsByUserId = new Map();
  for (let i = 0; i < allUserIds.length; i++) {
    const userId = allUserIds[i];
    userProfilesById.set(userId, userSnapshots[i].val() || null);
    const playerObj = playerSnapshots[i].val() || {};
    const playerData = Object.values(playerObj)[0];
    ratingsByUserId.set(userId, playerData?.gamemodeRatings || {});
  }

  const pairCandidates = [];
  for (let i = 0; i < queueEntries.length; i++) {
    const entryA = queueEntries[i];
    const profileA = userProfilesById.get(entryA.userId) || {};

    for (let j = i + 1; j < queueEntries.length; j++) {
      const entryB = queueEntries[j];
      if (entryA.userId === entryB.userId) continue;

      const profileB = userProfilesById.get(entryB.userId) || {};
      const sharedSelections = getSharedQueueSelections(entryA, entryB);
      if (!sharedSelections.length) continue;

      for (const sharedSelection of sharedSelections) {
        if (isUserRetiredFromGamemode(profileA, sharedSelection.gamemode)) continue;
        if (isUserRetiredFromGamemode(profileB, sharedSelection.gamemode)) continue;

        const assignment = resolveQueuedRoleAssignment(entryA, entryB, profileA, profileB, sharedSelection.gamemode);
        if (!assignment) continue;

        const ratingA = (ratingsByUserId.get(entryA.userId) || {})[sharedSelection.gamemode] || 1000;
        const ratingB = (ratingsByUserId.get(entryB.userId) || {})[sharedSelection.gamemode] || 1000;
        const score = calculateMatchScore(ratingA, ratingB);
        pairCandidates.push({
          entryA,
          entryB,
          assignment,
          sharedSelection,
          score,
          oldestJoinedAtMs: Math.min(parseDateToMs(entryA.joinedAt), parseDateToMs(entryB.joinedAt)),
          newestJoinedAtMs: Math.max(parseDateToMs(entryA.joinedAt), parseDateToMs(entryB.joinedAt))
        });
      }
    }
  }

  pairCandidates.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    if (a.oldestJoinedAtMs !== b.oldestJoinedAtMs) return a.oldestJoinedAtMs - b.oldestJoinedAtMs;
    return a.newestJoinedAtMs - b.newestJoinedAtMs;
  });

  const matchedUserIds = new Set();
  for (const candidate of pairCandidates) {
    const { entryA, entryB, assignment, sharedSelection } = candidate;
    if (matchedUserIds.has(entryA.userId) || matchedUserIds.has(entryB.userId)) continue;

    const assignedPlayer = {
      ...assignment.player,
      gamemode: sharedSelection.gamemode,
      region: sharedSelection.region,
      gamemodes: getQueueGamemodeList(assignment.player),
      regions: getQueueRegionList(assignment.player),
      serverIP: assignment.player.serverIP || assignment.tester.serverIP || null,
      serverSelectionSource: assignment.player.serverIP ? 'player_queue' : (assignment.tester.serverIP ? 'tester_queue_fallback' : null),
      roleAssignmentReason: assignment.playerReason,
      roleAssignmentType: assignment.assignmentType,
      assignmentExplanation: assignment.explanation
    };
    const assignedTester = {
      ...assignment.tester,
      gamemode: sharedSelection.gamemode,
      region: sharedSelection.region,
      gamemodes: getQueueGamemodeList(assignment.tester),
      regions: getQueueRegionList(assignment.tester),
      roleAssignmentReason: assignment.testerReason,
      roleAssignmentType: assignment.assignmentType,
      assignmentExplanation: assignment.explanation,
      randomizedAssignment: assignment.randomized === true
    };

    if (!assignedPlayer.serverIP) continue;

    const matchCreated = await createMatch(assignedPlayer, assignedTester);
    if (!matchCreated) continue;

    matchedUserIds.add(entryA.userId);
    matchedUserIds.add(entryB.userId);
  }
}

/**
 * Create a match between player and tester
 */
async function createMatch(player, tester, matchType = 'regular') {
  try {
    // FIX #3: Optimize player loading - use queries instead of loading all players
    // Get user profiles and player ratings in parallel
    const [playerUserSnapshot, testerUserSnapshot, playerDataSnapshot, testerDataSnapshot] = await Promise.all([
      db.ref(`users/${player.userId}`).once('value'),
      db.ref(`users/${tester.userId}`).once('value'),
      db.ref('players').orderByChild('userId').equalTo(player.userId).limitToFirst(1).once('value'),
      db.ref('players').orderByChild('userId').equalTo(tester.userId).limitToFirst(1).once('value')
    ]);
    
    const playerUser = playerUserSnapshot.val();
    const testerUser = testerUserSnapshot.val();
    const playerCooldownState = getQueueCooldownState(playerUser || {}, player.gamemode);

    if (!playerCooldownState.allowed) {
      console.log(`Skipped match creation for ${player.userId} in ${player.gamemode}: assigned player is on cooldown.`);
      return false;
    }
    
    // Extract player data from query result
    const playerDataObj = playerDataSnapshot.val() || {};
    const playerData = Object.values(playerDataObj)[0];
    const playerCurrentRating = playerData?.gamemodeRatings?.[player.gamemode] || 1000;
    const testerDataObj = testerDataSnapshot.val() || {};
    const testerData = Object.values(testerDataObj)[0];
    const playerVanillaRating = playerData?.gamemodeRatings?.vanilla || 1000;
    const testerVanillaRating = testerData?.gamemodeRatings?.vanilla || 1000;
    const totemDrain = player.gamemode === 'vanilla' && playerVanillaRating > 1700 && testerVanillaRating > 1700 ? 8 : 14;
    
    // FIX #1: Use Firebase transaction to prevent race conditions in match creation
    const matchesRef = db.ref('matches');
    const newMatchRef = matchesRef.push();
    const matchId = newMatchRef.key;
    
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3 * 60 * 1000);
    
    const firstTo = getFirstToForGamemode(player.gamemode);
    const match = {
      matchId,
      playerId: player.userId,
      playerUsername: player.minecraftUsername,
      playerEmail: playerUser.email,
      testerId: tester.userId,
      testerUsername: tester.minecraftUsername,
      testerEmail: testerUser.email,
      gamemode: player.gamemode,
      firstTo,
      totemDrain,
      region: player.region,
      serverIP: player.serverIP,
      status: 'active',
      matchType,
      playerCurrentRating,
      createdAt: now.toISOString(),
      finalized: false,
      matchStarted: false,
      matchStartedAt: null,
      countdownStartedAt: null,
      startCountdownHandled: false,
      chat: {},
      participants: {},
      presence: {},
      playerQueueSelections: {
        gamemodes: getQueueGamemodeList(player),
        regions: getQueueRegionList(player)
      },
      testerQueueSelections: {
        gamemodes: Array.isArray(tester.gamemodes) ? tester.gamemodes.filter(Boolean) : (tester.gamemode ? [tester.gamemode] : []),
        regions: Array.isArray(tester.regions) ? tester.regions.filter(Boolean) : (tester.region ? [tester.region] : [])
      },
      queueMeta: {
        playerJoinedQueueAt: player.joinedAt || null,
        testerJoinedQueueAt: tester.joinedAt || null,
        playerQueueSource: player.queueSource || null,
        testerQueueSource: tester.queueSource || null,
        serverSelectionSource: player.serverSelectionSource || null,
        createdFromQueue: true
      },
      roleAssignment: {
        type: tester.roleAssignmentType || player.roleAssignmentType || null,
        explanation: tester.assignmentExplanation || player.assignmentExplanation || null,
        playerReason: player.roleAssignmentReason || null,
        testerReason: tester.roleAssignmentReason || null,
        randomized: tester.randomizedAssignment === true
      },
      participantRoles: {
        [player.userId]: 'player',
        [tester.userId]: 'tester'
      },
      pagestats: {
        playerJoined: false,
        testerJoined: false,
        lastUpdate: null
      },
      joinTimeout: {
        startedAt: now.toISOString(),
        timeoutMinutes: 3,
        expiresAt: expiresAt.toISOString()
      },
      // FIX #2: Store timeout info for persistence across server restarts
      timeoutScheduled: true,
      timeoutHandled: false
    };
    
    // FIX #1: Use transaction to atomically create match and remove queue entries
    // This prevents race conditions where two matches could be created simultaneously
    const queueRef = db.ref('queue');
    
    try {
      // Verify queue entries still exist before creating match (prevents duplicate matches)
      const playerQueueSnapshot = await queueRef.child(player.key).once('value');
      let testerQueueSnapshot = null;
      if (tester.key) {
        testerQueueSnapshot = await queueRef.child(tester.key).once('value');
      }

      if (!playerQueueSnapshot.exists() || (tester.key && !testerQueueSnapshot?.exists())) {
        console.log(`Queue entries no longer exist for match creation (race condition prevented)`);
        return false; // Another process already matched these players
      }

      // Final guard: ensure neither user is already in any active match.
      const activeSnapshot = await db.ref('matches').orderByChild('status').equalTo('active').once('value');
      const active = activeSnapshot.val() || {};
      const conflict = Object.values(active).some((m) => !m?.finalized && (m.playerId === player.userId || m.testerId === player.userId || m.playerId === tester.userId || m.testerId === tester.userId));
      if (conflict) {
        await Promise.all([
          queueRef.child(player.key).remove().catch(() => {}),
          queueRef.child(tester.key).remove().catch(() => {})
        ]);
        console.log(`Skipped duplicate match creation for ${player.userId}/${tester.userId}: already active in another match`);
        return false;
      }
      
      // Atomically create match and remove queue entries
      await newMatchRef.set(match);
      await Promise.all([
        clearUserQueueEntries(player.userId),
        clearUserQueueEntries(tester.userId)
      ]);
      
      console.log(`✅ Match created atomically: ${matchId} between ${player.minecraftUsername} and ${tester.minecraftUsername}`);
    } catch (error) {
      console.error(`❌ Error in atomic match creation:`, error);
      // Clean up partial match if creation failed
      await newMatchRef.remove().catch(err => console.error('Error cleaning up match:', err));
      throw error;
    }
    
    // FIX #2: Set up 3-minute inactivity timer with persistence tracking
    const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
    setTimeout(async () => {
      try {
        console.log(`⏰ Checking inactivity for match ${matchId} after 3 minutes...`);
        await handleMatchInactivity(matchId);
      } catch (error) {
        console.error(`❌ Error handling inactivity for match ${matchId}:`, error);
      }
    }, INACTIVITY_TIMEOUT_MS);

    console.log(`Match created: ${matchId} between ${player.minecraftUsername} and ${tester.minecraftUsername} (3-minute timer set)`);
    return true;
  } catch (error) {
    console.error('Error creating match:', error);
    throw error;
  }
}

// ===== Tier Tester Application Routes =====

async function getTierTesterApplicationsOpenSetting() {
  try {
    const snap = await db.ref('settings/tierTesterApplicationsOpen').once('value');
    const val = snap.val();
    // default open if unset
    return val !== false;
  } catch (e) {
    // Fail closed? For safety we keep it open if settings lookup fails
    return true;
  }
}

/**
 * GET /api/tier-tester/applications-open - Public: whether applications are open
 */
app.get('/api/tier-tester/applications-open', async (req, res) => {
  try {
    const open = await getTierTesterApplicationsOpenSetting();
    res.json({ success: true, open });
  } catch (error) {
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error fetching setting' });
  }
});

/**
 * Admin: GET/POST toggle for applications open
 */
app.get('/api/admin/settings/tier-tester-applications', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const open = await getTierTesterApplicationsOpenSetting();
    res.json({ success: true, open });
  } catch (error) {
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error fetching setting' });
  }
});

app.post('/api/admin/settings/tier-tester-applications', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const { open } = req.body || {};
    const value = open === true;
    await db.ref('settings/tierTesterApplicationsOpen').set(value);
    res.json({ success: true, open: value });
  } catch (error) {
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error saving setting' });
  }
});

/**
 * POST /api/tier-tester/apply - Submit tier tester application
 */
app.post('/api/tier-tester/apply', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const applicationsOpen = await getTierTesterApplicationsOpenSetting();
    if (!applicationsOpen) {
      return res.status(403).json({
        error: true,
        code: 'APPLICATIONS_CLOSED',
        message: 'Tier Tester applications are currently closed.'
      });
    }

    const userId = req.user.uid;
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val() || {};

    // Check if user already has tester role
    if (userProfile.tester) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_TESTER',
        message: 'You are already a Tier Tester.'
      });
    }

    // Check if user has a pending application
    if (userProfile.pendingTesterApplication) {
      return res.status(400).json({
        error: true,
        code: 'PENDING_APPLICATION',
        message: 'You already have a pending Tier Tester application.'
      });
    }

    // Check if user is blocked from applying
    if (userProfile.blockedFromTesterApplications) {
      return res.status(403).json({
        error: true,
        code: 'BLOCKED_FROM_APPLICATIONS',
        message: 'You are not eligible to apply for Tier Tester at this time.'
      });
    }

    const applicationData = req.body;

    // Validate required fields
    const requiredFields = ['name', 'age', 'minecraftExperience', 'favoriteGamemode', 'availability', 'whyTester'];
    for (const field of requiredFields) {
      if (!applicationData[field]) {
        return res.status(400).json({
          error: true,
          code: 'MISSING_FIELD',
          message: `Field '${field}' is required.`
        });
      }
    }

    // Validate age
    if (applicationData.age < 13) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_AGE',
        message: 'You must be at least 13 years old to apply.'
      });
    }

    // Check for profanity in text fields
    const textFields = ['name', 'whyTester', 'previousTesting', 'improvementIdeas'];
    for (const field of textFields) {
      if (applicationData[field] && typeof applicationData[field] === 'string') {
        try {
          const hasProfanity = await containsProfanity(applicationData[field]);
          if (hasProfanity) {
            return res.status(400).json({
              error: true,
              code: 'PROFANITY_DETECTED',
              message: `The ${field} field contains inappropriate language and cannot be submitted`
            });
          }
        } catch (error) {
          // If profanity filter is unavailable, block the request
          return res.status(503).json({
            error: true,
            code: 'FILTER_UNAVAILABLE',
            message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
          });
        }
      }
    }

    // Create application record
    const applicationsRef = db.ref('tierTesterApplications');
    const applicationId = applicationsRef.push().key;

    const application = {
      id: applicationId,
      userId: userId,
      userEmail: req.user.email,
      userDisplayName: userProfile.displayName || userProfile.email,
      ...applicationData,
      status: 'pending',
      submittedAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null
    };

    await applicationsRef.child(applicationId).set(application);

    // Update user profile to mark pending application
    await userRef.update({
      pendingTesterApplication: true,
      lastApplicationSubmitted: new Date().toISOString()
    });

    // Log admin action
    await logAdminAction(req, req.user.uid, 'SUBMIT_TESTER_APPLICATION', applicationId, {
      applicationId: applicationId
    });

    res.json({
      success: true,
      message: 'Tier Tester application submitted successfully.',
      applicationId: applicationId
    });
  } catch (error) {
    console.error('Error submitting tier tester application:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error submitting application.'
    });
  }
});

/**
 * GET /api/admin/tier-tester-applications - Get all tier tester applications (Admin only)
 * Query params: status (pending/all/approved/denied), sort (newest/oldest)
 */
app.get('/api/admin/tier-tester-applications', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { status = 'pending', sort = 'newest' } = req.query;

    const applicationsRef = db.ref('tierTesterApplications');
    const snapshot = await applicationsRef.once('value');
    const applications = snapshot.val() || {};

    // Convert to array
    let applicationsArray = Object.values(applications);

    // Filter by status
    if (status !== 'all') {
      applicationsArray = applicationsArray.filter(app => app.status === status);
    }

    // Sort by submission date
    if (sort === 'newest') {
      applicationsArray.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    } else if (sort === 'oldest') {
      applicationsArray.sort((a, b) => new Date(a.submittedAt) - new Date(b.submittedAt));
    }

    res.json({
      success: true,
      applications: applicationsArray
    });
  } catch (error) {
    console.error('Error fetching tier tester applications:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching applications.'
    });
  }
});

/**
 * POST /api/admin/tier-tester-applications/:id/approve - Approve tier tester application (Admin only)
 */
app.post('/api/admin/tier-tester-applications/:id/approve', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const applicationId = req.params.id;
    const adminId = req.user.uid;
    const reviewNotes = req.body.reviewNotes || '';

    const applicationRef = db.ref(`tierTesterApplications/${applicationId}`);
    const applicationSnapshot = await applicationRef.once('value');
    const application = applicationSnapshot.val();

    if (!application) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Application not found.'
      });
    }

    if (application.status !== 'pending') {
      return res.status(400).json({
        error: true,
        code: 'INVALID_STATUS',
        message: 'Application is not in pending status.'
      });
    }

    // Update application status
    await applicationRef.update({
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date().toISOString(),
      reviewNotes: reviewNotes
    });

    // Update user profile to grant tester role
    const userRef = db.ref(`users/${application.userId}`);
    await userRef.update({
      tester: true,
      pendingTesterApplication: null,
      testerApprovedAt: new Date().toISOString(),
      testerApprovedBy: adminId
    });

    // Send congratulations inbox message to the applicant
    await sendInboxMessage(application.userId, {
      title: 'Tier Tester Application Approved!',
      message: 'Congratulations! Your Tier Tester application has been approved.\n\nYou now have access to the Tier Tester queue and can begin testing players. Head to the Dashboard to set your availability and start matching with players.\n\nThank you for contributing to the MC Leaderboards community!',
      type: 'system',
      from: 'MC Leaderboards Staff',
      metadata: { applicationId, event: 'tester_approved' }
    });

    // Log admin action
    await logAdminAction(req, adminId, 'APPROVE_TESTER_APPLICATION', applicationId, {
      userId: application.userId,
      reviewNotes: reviewNotes
    });

    res.json({
      success: true,
      message: 'Tier Tester application approved successfully.'
    });
  } catch (error) {
    console.error('Error approving tier tester application:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error approving application.'
    });
  }
});

/**
 * POST /api/admin/tier-tester-applications/:id/deny - Deny tier tester application (Admin only)
 */
app.post('/api/admin/tier-tester-applications/:id/deny', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const applicationId = req.params.id;
    const adminId = req.user.uid;
    const reviewNotes = req.body.reviewNotes || '';

    if (!reviewNotes.trim()) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_NOTES',
        message: 'Review notes are required when denying an application.'
      });
    }

    const applicationRef = db.ref(`tierTesterApplications/${applicationId}`);
    const applicationSnapshot = await applicationRef.once('value');
    const application = applicationSnapshot.val();

    if (!application) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Application not found.'
      });
    }

    if (application.status !== 'pending') {
      return res.status(400).json({
        error: true,
        code: 'INVALID_STATUS',
        message: 'Application is not in pending status.'
      });
    }

    // Update application status
    await applicationRef.update({
      status: 'denied',
      reviewedBy: adminId,
      reviewedAt: new Date().toISOString(),
      reviewNotes: reviewNotes
    });

    // Update user profile to record denial
    const userRef = db.ref(`users/${application.userId}`);
    await userRef.update({
      pendingTesterApplication: null,
      testerApplicationDenied: true,
      testerDenialReason: reviewNotes,
      testerDenialDate: new Date().toISOString()
    });

    // Send denial inbox message to the applicant
    await sendInboxMessage(application.userId, {
      title: 'Tier Tester Application Update',
      message: `Thank you for your interest in becoming a Tier Tester. After careful review, your application was not approved at this time.\n\nFeedback: ${reviewNotes}\n\nYou are welcome to reapply in the future once applications reopen. If you have questions, please contact support.`,
      type: 'system',
      from: 'MC Leaderboards Staff',
      metadata: { applicationId, event: 'tester_denied' }
    });

    // Log admin action
    await logAdminAction(req, adminId, 'DENY_TESTER_APPLICATION', applicationId, {
      userId: application.userId,
      reviewNotes: reviewNotes
    });

    res.json({
      success: true,
      message: 'Tier Tester application denied successfully.'
    });
  } catch (error) {
    console.error('Error denying tier tester application:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error denying application.'
    });
  }
});

/**
 * POST /api/admin/tier-tester-applications/:id/block - Block user from future applications (Admin only)
 */
app.post('/api/admin/tier-tester-applications/:id/block', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const applicationId = req.params.id;
    const adminId = req.user.uid;
    const reviewNotes = req.body.reviewNotes || '';

    if (!reviewNotes.trim()) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_NOTES',
        message: 'Review notes are required when blocking a user.'
      });
    }

    const applicationRef = db.ref(`tierTesterApplications/${applicationId}`);
    const applicationSnapshot = await applicationRef.once('value');
    const application = applicationSnapshot.val();

    if (!application) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Application not found.'
      });
    }

    // Update application status
    await applicationRef.update({
      status: 'blocked',
      reviewedBy: adminId,
      reviewedAt: new Date().toISOString(),
      reviewNotes: reviewNotes
    });

    // Update user profile to block future applications
    const userRef = db.ref(`users/${application.userId}`);
    await userRef.update({
      pendingTesterApplication: null,
      blockedFromTesterApplications: true,
      blockedFromTesterAt: new Date().toISOString(),
      blockedFromTesterBy: adminId,
      blockedFromTesterReason: reviewNotes
    });

    // Log admin action
    await logAdminAction(req, adminId, 'BLOCK_TESTER_APPLICATIONS', applicationId, {
      userId: application.userId,
      reviewNotes: reviewNotes
    });

    res.json({
      success: true,
      message: 'User blocked from future Tier Tester applications.'
    });
  } catch (error) {
    console.error('Error blocking user from tier tester applications:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error blocking user.'
    });
  }
});

// ===== Player Reporting Routes =====

async function getRecentPlayerReportsForUser(userId, lookbackMs = 24 * 60 * 60 * 1000) {
  const fromIso = new Date(Date.now() - lookbackMs).toISOString();
  const userReportsRef = db.ref(`playerReportsByUser/${userId}`);
  const recentSnapshot = await userReportsRef
    .orderByChild('createdAt')
    .startAt(fromIso)
    .once('value');

  const recentIndexEntries = Object.values(recentSnapshot.val() || {});
  if (recentIndexEntries.length > 0) {
    return recentIndexEntries
      .filter((entry) => typeof entry?.createdAt === 'string')
      .sort((a, b) => parseDateToMs(a.createdAt) - parseDateToMs(b.createdAt));
  }

  // Backward-compat fallback for older data before user index existed.
  const reportsRef = db.ref('playerReports');
  const fallbackSnapshot = await reportsRef
    .orderByChild('reporterId')
    .equalTo(userId)
    .once('value');
  const all = Object.values(fallbackSnapshot.val() || {});
  return all
    .filter((report) => parseDateToMs(report.createdAt) >= parseDateToMs(fromIso))
    .sort((a, b) => parseDateToMs(a.createdAt) - parseDateToMs(b.createdAt));
}

function normalizeReportedPlayerKey(reportedPlayer, reportedUUID = null) {
  const normalizedUuid = String(reportedUUID || '').trim().toLowerCase();
  if (normalizedUuid) return `uuid:${normalizedUuid}`;

  const normalizedName = String(reportedPlayer || '').trim().toLowerCase();
  return normalizedName ? `name:${normalizedName}` : '';
}

async function findExistingPlayerReportForTarget(userId, reportedPlayer, reportedUUID = null) {
  const reportedPlayerKey = normalizeReportedPlayerKey(reportedPlayer, reportedUUID);
  if (!reportedPlayerKey) return null;

  const userReportsSnapshot = await db.ref(`playerReportsByUser/${userId}`).once('value');
  const indexedReports = Object.values(userReportsSnapshot.val() || {});
  const indexedMatch = indexedReports.find((report) => {
    const existingKey = String(report?.reportedPlayerKey || normalizeReportedPlayerKey(report?.reportedPlayer, report?.reportedUUID || null));
    return existingKey === reportedPlayerKey;
  });

  if (indexedMatch) {
    return indexedMatch;
  }

  const reportsSnapshot = await db.ref('playerReports').orderByChild('reporterId').equalTo(userId).once('value');
  const reports = Object.values(reportsSnapshot.val() || {});
  return reports.find((report) => {
    const existingKey = normalizeReportedPlayerKey(report?.reportedPlayer, report?.reportedUUID || null);
    return existingKey === reportedPlayerKey;
  }) || null;
}

async function getStaffReporterIds() {
  const usersSnapshot = await db.ref('users').once('value');
  const users = usersSnapshot.val() || {};
  return new Set(
    Object.entries(users)
      .filter(([, user]) => getAssignedStaffRoleIds(user).length > 0)
      .map(([uid]) => uid)
  );
}

async function resolveRequesterStaffRole(req) {
  const roleMap = await getAllStaffRoles().catch(() => ({}));
  return resolveStaffRoleForProfile(req.userProfile || {}, roleMap);
}

async function requireModerationCapability(req, res, next, capability) {
  try {
    const profile = req.userProfile || {};
    const adminRole = getAdminRole(profile, req.user?.email || profile.email || '');
    if (adminRole) {
      return next();
    }

    const staffRole = await resolveRequesterStaffRole(req);
    const capabilities = Array.isArray(staffRole?.capabilities) ? staffRole.capabilities : [];
    if (!capabilities.includes(capability)) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'You do not have permission to access this moderation tool.'
      });
    }

    req.staffRoleContext = staffRole;
    return next();
  } catch (error) {
    console.error('Error verifying moderation capability:', error);
    return res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Unable to verify moderation capability'
    });
  }
}

function requireModerationCapabilityMiddleware(capability) {
  return async (req, res, next) => requireModerationCapability(req, res, next, capability);
}

function requireAnyModerationCapabilityMiddleware(capabilities = []) {
  return async (req, res, next) => {
    try {
      const profile = req.userProfile || {};
      const adminRole = getAdminRole(profile, req.user?.email || profile.email || '');
      if (adminRole) {
        return next();
      }

      const staffRole = await resolveRequesterStaffRole(req);
      const roleCapabilities = new Set(Array.isArray(staffRole?.capabilities) ? staffRole.capabilities : []);
      if (!capabilities.some((capability) => roleCapabilities.has(capability))) {
        return res.status(403).json({
          error: true,
          code: 'PERMISSION_DENIED',
          message: 'You do not have permission to access this moderation tool.'
        });
      }

      req.staffRoleContext = staffRole;
      return next();
    } catch (error) {
      console.error('Error verifying moderation capability:', error);
      return res.status(500).json({
        error: true,
        code: 'SERVER_ERROR',
        message: 'Unable to verify moderation capability'
      });
    }
  };
}

/**
 * POST /api/submit-player-report - Submit a player report
 */
app.post('/api/submit-player-report', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const {
      reportedPlayer,
      reportedUUID,
      category,
      matchId,
      description,
      evidenceLinks,
      hasEvidence
    } = req.body;

    // Validate required fields
    if (!reportedPlayer || !category || !description) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_FIELDS',
        message: 'reportedPlayer, category, and description are required'
      });
    }

    if (!['alt_account', 'chat_abuse', 'unfair_play', 'match_throwing', 'impersonation', 'other'].includes(category)) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_CATEGORY',
        message: 'Invalid report category'
      });
    }

    const normalizedEvidenceLinks = Array.isArray(evidenceLinks)
      ? evidenceLinks.map(link => String(link || '').trim()).filter(Boolean)
      : [];
    const validEvidenceLinks = normalizedEvidenceLinks.filter(link => {
      try {
        const parsed = new URL(link);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
      } catch (_) {
        return false;
      }
    }).slice(0, 5);

    const reportedPlayerKey = normalizeReportedPlayerKey(reportedPlayer, reportedUUID);
    if (!reportedPlayerKey) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_REPORTED_PLAYER',
        message: 'A valid reported player identifier is required'
      });
    }

    const existingReport = await findExistingPlayerReportForTarget(req.user.uid, reportedPlayer, reportedUUID || null);
    if (existingReport) {
      return res.status(409).json({
        error: true,
        code: 'DUPLICATE_REPORT',
        message: 'You have already submitted a report for this player.',
        existingReportId: existingReport.id || null,
        existingStatus: existingReport.status || null
      });
    }

    // Rate limit: max 5 reports per user in 24 hours (user-scoped query only)
    const reportsRef = db.ref('playerReports');
    const reportsLast24h = await getRecentPlayerReportsForUser(req.user.uid, 24 * 60 * 60 * 1000);

    if (reportsLast24h.length >= 5) {
      const oldestRecentReportMs = reportsLast24h
        .map(report => new Date(report.createdAt).getTime())
        .sort((a, b) => a - b)[0];
      const resetAt = new Date(oldestRecentReportMs + (24 * 60 * 60 * 1000)).toISOString();
      return res.status(429).json({
        error: true,
        code: 'REPORT_LIMIT_REACHED',
        message: 'Report limit reached (5 reports per 24 hours). Please wait before submitting another report.',
        resetAt,
        reportsLast24h: reportsLast24h.length
      });
    }

    // Create report record
    const reportId = reportsRef.push().key;

    const report = {
      id: reportId,
      reporterId: req.user.uid,
      reporterEmail: req.user.email,
      reportedPlayer: reportedPlayer,
      reportedUUID: reportedUUID || null,
      reportedPlayerKey,
      category: category,
      matchId: matchId || null,
      description: description,
      hasEvidence: validEvidenceLinks.length > 0 || hasEvidence === true,
      evidenceLinks: validEvidenceLinks,
      status: 'pending',
      createdAt: new Date().toISOString(),
      reviewedBy: null,
      reviewedAt: null,
      reviewNotes: null
    };

    await reportsRef.child(reportId).set(report);
    await db.ref(`playerReportsByUser/${req.user.uid}/${reportId}`).set({
      id: reportId,
      reporterId: req.user.uid,
      createdAt: report.createdAt,
      status: report.status,
      category: report.category,
      reportedPlayer: report.reportedPlayer,
      reportedUUID: report.reportedUUID,
      reportedPlayerKey: report.reportedPlayerKey
    });

    // Log admin action
    await logAdminAction(req, req.user.uid, 'SUBMIT_PLAYER_REPORT', reportId, {
      reportedPlayer: reportedPlayer,
      category: category
    });

    res.json({
      success: true,
      message: 'Player report submitted successfully',
      reportId: reportId
    });
  } catch (error) {
    console.error('Error submitting player report:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error submitting report'
    });
  }
});

/**
 * GET /api/reports/my - Get recent reports submitted by current user
 */
app.get('/api/reports/my', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 5));
    const userReportsRef = db.ref(`playerReportsByUser/${req.user.uid}`);
    const userReportIndexSnap = await userReportsRef
      .orderByChild('createdAt')
      .limitToLast(limit)
      .once('value');

    const indexedEntries = Object.values(userReportIndexSnap.val() || {})
      .filter((entry) => entry?.id)
      .sort((a, b) => parseDateToMs(b.createdAt) - parseDateToMs(a.createdAt));

    let reports = [];
    if (indexedEntries.length > 0) {
      const fetched = await Promise.all(
        indexedEntries.map((entry) => db.ref(`playerReports/${entry.id}`).once('value'))
      );
      reports = fetched
        .map((snap) => snap.val())
        .filter(Boolean)
        .sort((a, b) => parseDateToMs(b.createdAt) - parseDateToMs(a.createdAt))
        .slice(0, limit);
    } else {
      // Backward-compat fallback for older data before user index existed.
      const reportsRef = db.ref('playerReports');
      const snapshot = await reportsRef
        .orderByChild('reporterId')
        .equalTo(req.user.uid)
        .once('value');
      reports = Object.values(snapshot.val() || {})
        .sort((a, b) => parseDateToMs(b.createdAt) - parseDateToMs(a.createdAt))
        .slice(0, limit);
    }

    res.json({
      success: true,
      reports
    });
  } catch (error) {
    console.error('Error fetching user reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching report history'
    });
  }
});

// ===== Support Ticket Routes =====

const SUPPORT_TICKET_CATEGORIES = new Set([
  'website_issue',
  'tiering_system_issue',
  'leaderboard_problem',
  'account_issue',
  'bug_report',
  'other'
]);
const SUPPORT_TICKET_URGENCIES = new Set(['low', 'medium', 'high']);
const SUPPORT_ACTIVE_STATUSES = new Set(['open', 'awaiting_admin', 'awaiting_user']);

function isSupportTicketActive(status) {
  return SUPPORT_ACTIVE_STATUSES.has(status || 'open');
}

function normalizeSupportText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function buildSupportPreview(text) {
  return normalizeSupportText(text, 160).replace(/\s+/g, ' ');
}

function normalizeSupportEvidenceLinks(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value || '')
      .split(/\r?\n|,/)
      .map((entry) => entry.trim());

  return raw
    .map((entry) => normalizeSupportText(entry, 300))
    .filter(Boolean)
    .slice(0, 10);
}

function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function buildSupportSubject({ category, urgency, description }) {
  const categoryLabel = String(category || 'other')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  const urgencyLabel = String(urgency || 'medium').toUpperCase();
  const preview = buildSupportPreview(description || '').slice(0, 72);
  return normalizeSupportText(`${categoryLabel} [${urgencyLabel}] ${preview}`, 140);
}

/**
 * POST /api/support/tickets - Submit support ticket (one active ticket per user)
 */
app.post('/api/support/tickets', verifyAuth, supportTicketLimiter, requireRecaptcha, async (req, res) => {
  try {
    const category = normalizeSupportText(req.body?.category, 32).toLowerCase();
    const urgency = normalizeSupportText(req.body?.urgency, 16).toLowerCase();
    const description = normalizeSupportText(req.body?.description, 4000);
    const anythingElse = normalizeSupportText(req.body?.anythingElse, 2000);
    const evidenceLinks = normalizeSupportEvidenceLinks(req.body?.evidenceLinks);
    const rulesConfirmed = req.body?.rulesConfirmed === true;
    const subject = buildSupportSubject({ category, urgency, description });

    if (!SUPPORT_TICKET_CATEGORIES.has(category)) {
      return res.status(400).json({ error: true, code: 'INVALID_CATEGORY', message: 'Invalid support category' });
    }
    if (!SUPPORT_TICKET_URGENCIES.has(urgency)) {
      return res.status(400).json({ error: true, code: 'INVALID_URGENCY', message: 'Invalid urgency selected' });
    }
    if (!description || description.length < 20) {
      return res.status(400).json({ error: true, code: 'INVALID_DESCRIPTION', message: 'Description must be at least 20 characters' });
    }
    if (!rulesConfirmed) {
      return res.status(400).json({ error: true, code: 'RULES_CONFIRMATION_REQUIRED', message: 'You must confirm that you have read the rules' });
    }

    if (evidenceLinks.some((link) => !isValidHttpUrl(link))) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_EVIDENCE_LINK',
        message: 'Evidence links must be valid http or https URLs.'
      });
    }

    if (await containsProfanity(subject) || await containsProfanity(description) || (anythingElse && await containsProfanity(anythingElse))) {
      return res.status(400).json({
        error: true,
        code: 'PROFANITY_DETECTED',
        message: 'Your support request contains inappropriate language. Please revise and try again.'
      });
    }

    const profile = req.userProfile || {};
    const now = new Date().toISOString();

    const ticket = {
      userId: req.user.uid,
      email: req.user.email || '',
      minecraftUsername: profile?.minecraftUsername || '',
      category,
      urgency,
      description,
      evidenceLinks,
      anythingElse,
      rulesConfirmed: true,
      subject,
      status: 'awaiting_admin',
      source: 'authenticated_form',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      lastSenderType: 'user',
      lastMessagePreview: buildSupportPreview(description)
    };

    const ticketMessage = {
      senderType: 'user',
      senderUid: req.user.uid,
      senderEmail: req.user.email || '',
      message: [
        `Support type: ${category}`,
        `Urgency: ${urgency}`,
        '',
        description,
        evidenceLinks.length ? `\nEvidence Links:\n${evidenceLinks.join('\n')}` : '',
        anythingElse ? `\nAnything else:\n${anythingElse}` : ''
      ].join('\n'),
      createdAt: now
    };

    const createdSupportRecord = await createSupportTicketRecord(ticket, ticketMessage);
    const createdTicket = createdSupportRecord.ticket;
    const ticketId = createdTicket.id;

    await sendInboxMessage(req.user.uid, {
      title: 'Support ticket received',
      message: `We received your support ticket #${ticketId}. Staff will reply here once it has been reviewed.`,
      type: 'support_ticket',
      from: 'Support',
      metadata: {
        event: 'support_ticket_created',
        ticketId,
        status: ticket.status
      }
    }).catch((inboxError) => {
      console.warn('Failed to send support ticket receipt inbox message:', inboxError.message);
    });

    res.json({ success: true, ticket: createdTicket });
  } catch (error) {
    console.error('Error creating support ticket:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error creating support ticket' });
  }
});

/**
 * POST /api/support/guest-ticket - Submit signed-out account issue ticket only
 */
app.post('/api/support/guest-ticket', supportTicketLimiter, requireRecaptcha, async (req, res) => {
  try {
    const category = normalizeSupportText(req.body?.category, 32).toLowerCase();
    const email = normalizeSupportText(req.body?.email, 180).toLowerCase();
    const minecraftUsername = normalizeSupportText(req.body?.minecraftUsername, 32);
    const urgency = normalizeSupportText(req.body?.urgency, 16).toLowerCase();
    const description = normalizeSupportText(req.body?.description, 4000);
    const anythingElse = normalizeSupportText(req.body?.anythingElse, 2000);
    const evidenceLinks = normalizeSupportEvidenceLinks(req.body?.evidenceLinks);
    const rulesConfirmed = req.body?.rulesConfirmed === true;
    const subject = buildSupportSubject({ category, urgency, description });

    if (!SUPPORT_TICKET_CATEGORIES.has(category)) {
      return res.status(400).json({ error: true, code: 'INVALID_CATEGORY', message: 'Invalid support category' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: true, code: 'INVALID_EMAIL', message: 'Valid email is required' });
    }
    if (!SUPPORT_TICKET_URGENCIES.has(urgency)) {
      return res.status(400).json({ error: true, code: 'INVALID_URGENCY', message: 'Invalid urgency selected' });
    }
    if (!description || description.length < 20) {
      return res.status(400).json({ error: true, code: 'INVALID_DESCRIPTION', message: 'Description must be at least 20 characters' });
    }
    if (!rulesConfirmed) {
      return res.status(400).json({ error: true, code: 'RULES_CONFIRMATION_REQUIRED', message: 'You must confirm that you have read the rules' });
    }
    if (evidenceLinks.some((link) => !isValidHttpUrl(link))) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_EVIDENCE_LINK',
        message: 'Evidence links must be valid http or https URLs.'
      });
    }
    if (await containsProfanity(subject) || await containsProfanity(description) || (anythingElse && await containsProfanity(anythingElse))) {
      return res.status(400).json({
        error: true,
        code: 'PROFANITY_DETECTED',
        message: 'Your support request contains inappropriate language. Please revise and try again.'
      });
    }

    const now = new Date().toISOString();
    const ticket = {
      isGuest: true,
      userId: null,
      email,
      minecraftUsername,
      category,
      urgency,
      description,
      evidenceLinks,
      anythingElse,
      rulesConfirmed: true,
      subject,
      status: 'awaiting_admin',
      source: 'guest_form',
      createdAt: now,
      updatedAt: now,
      lastMessageAt: now,
      lastSenderType: 'guest',
      lastMessagePreview: buildSupportPreview(description)
    };

    const createdSupportRecord = await createSupportTicketRecord(ticket, {
      senderType: 'guest',
      senderUid: null,
      senderEmail: email,
      message: [
        `Support type: ${category}`,
        `Urgency: ${urgency}`,
        '',
        description,
        evidenceLinks.length ? `\nEvidence Links:\n${evidenceLinks.join('\n')}` : '',
        anythingElse ? `\nAnything else:\n${anythingElse}` : ''
      ].join('\n'),
      createdAt: now
    });

    res.json({ success: true, ticket: createdSupportRecord.ticket });
  } catch (error) {
    console.error('Error creating guest support ticket:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error creating support ticket' });
  }
});

/**
 * GET /api/support/tickets/me - Get active ticket + recent history for current user
 */
app.get('/api/support/tickets/me', verifyAuth, async (req, res) => {
  try {
    const tickets = (await listSupportTicketRecords({ userId: req.user.uid, limit: 100 })).sort(
      (a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime()
    );

    const activeTicket = tickets.find(ticket => isSupportTicketActive(ticket.status)) || null;
    const recentTickets = tickets.slice(0, 5);
    let messages = [];

    if (activeTicket) {
      messages = (await listSupportTicketMessages(activeTicket.id)).sort(
        (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
      );
    }

    res.json({
      success: true,
      activeTicket,
      messages,
      recentTickets
    });
  } catch (error) {
    console.error('Error loading user support tickets:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error loading support tickets' });
  }
});

/**
 * POST /api/support/tickets/:ticketId/messages - Reply to active support ticket
 */
app.post('/api/support/tickets/:ticketId/messages', verifyAuth, messageLimiter, requireRecaptcha, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const message = normalizeSupportText(req.body?.message, 2000);
    if (!message || message.length < 2) {
      return res.status(400).json({ error: true, code: 'INVALID_MESSAGE', message: 'Message is required' });
    }

    const ticket = await getSupportTicketRecord(ticketId);
    if (!ticket || ticket.userId !== req.user.uid) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Ticket not found' });
    }
    if (!isSupportTicketActive(ticket.status)) {
      return res.status(400).json({ error: true, code: 'TICKET_CLOSED', message: 'Ticket is closed' });
    }
    if (await containsProfanity(message)) {
      return res.status(400).json({
        error: true,
        code: 'PROFANITY_DETECTED',
        message: 'Your message contains inappropriate language. Please revise and try again.'
      });
    }

    const now = new Date().toISOString();
    await Promise.all([
      addSupportTicketMessage(ticketId, {
        senderType: 'user',
        senderUid: req.user.uid,
        senderEmail: req.user.email || '',
        message,
        createdAt: now
      }),
      updateSupportTicketRecord(ticketId, {
        status: 'awaiting_admin',
        updatedAt: now,
        lastMessageAt: now,
        lastSenderType: 'user',
        lastMessagePreview: buildSupportPreview(message)
      })
    ]);

    res.json({ success: true, message: 'Message sent' });
  } catch (error) {
    console.error('Error replying to support ticket:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error sending message' });
  }
});

/**
 * POST /api/support/tickets/:ticketId/close - Close own support ticket
 */
app.post('/api/support/tickets/:ticketId/close', verifyAuth, supportTicketLimiter, requireRecaptcha, async (req, res) => {
  try {
    const { ticketId } = req.params;
    const ticket = await getSupportTicketRecord(ticketId);
    if (!ticket || ticket.userId !== req.user.uid) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Ticket not found' });
    }

    await updateSupportTicketRecord(ticketId, {
      status: 'closed',
      closedBy: 'user',
      closedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    res.json({ success: true, message: 'Ticket closed' });
  } catch (error) {
    console.error('Error closing support ticket:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error closing ticket' });
  }
});

/**
 * GET /api/admin/support/tickets - List support tickets (Admin only)
 */
app.get('/api/admin/support/tickets', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view') && !adminHasCapability(req, 'support:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Support ticket access required' });
    }

    const status = normalizeSupportText(req.query.status, 32).toLowerCase();
    const max = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 100));
    let tickets = await listSupportTicketRecords({ limit: max });

    if (status) {
      if (status === 'active') {
        tickets = tickets.filter(ticket => isSupportTicketActive(ticket.status));
      } else {
        tickets = tickets.filter(ticket => (ticket.status || '') === status);
      }
    }

    tickets.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
    tickets = tickets.slice(0, max);

    res.json({ success: true, tickets });
  } catch (error) {
    console.error('Error loading support tickets:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error loading support tickets' });
  }
});

/**
 * GET /api/admin/support/tickets/:ticketId - Ticket details + messages (Admin only)
 */
app.get('/api/admin/support/tickets/:ticketId', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view') && !adminHasCapability(req, 'support:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Support ticket access required' });
    }

    const { ticketId } = req.params;
    const ticket = await getSupportTicketRecord(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Ticket not found' });
    }

    const messages = (await listSupportTicketMessages(ticketId)).sort(
      (a, b) => new Date(a.createdAt || 0).getTime() - new Date(b.createdAt || 0).getTime()
    );

    res.json({ success: true, ticket, messages });
  } catch (error) {
    console.error('Error loading support ticket details:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error loading support ticket' });
  }
});

/**
 * POST /api/admin/support/tickets/:ticketId/messages - Admin reply to ticket
 */
app.post('/api/admin/support/tickets/:ticketId/messages', adminLimiter, verifyAuthAndNotBanned, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view') && !adminHasCapability(req, 'support:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Support ticket access required' });
    }

    const { ticketId } = req.params;
    const message = normalizeSupportText(req.body?.message, 2000);
    if (!message || message.length < 2) {
      return res.status(400).json({ error: true, code: 'INVALID_MESSAGE', message: 'Message is required' });
    }
    if (await containsProfanity(message)) {
      return res.status(400).json({
        error: true,
        code: 'PROFANITY_DETECTED',
        message: 'Message contains inappropriate language.'
      });
    }

    const ticket = await getSupportTicketRecord(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Ticket not found' });
    }
    if (!isSupportTicketActive(ticket.status)) {
      return res.status(400).json({ error: true, code: 'TICKET_CLOSED', message: 'Ticket is closed' });
    }

    const now = new Date().toISOString();
    await Promise.all([
      addSupportTicketMessage(ticketId, {
        senderType: 'admin',
        senderUid: req.user.uid,
        senderEmail: req.user.email || '',
        message,
        createdAt: now
      }),
      updateSupportTicketRecord(ticketId, {
        status: 'awaiting_user',
        updatedAt: now,
        lastMessageAt: now,
        lastSenderType: 'admin',
        lastMessagePreview: buildSupportPreview(message)
      })
    ]);

    await writeAuditLogEntry({
      action: 'support_ticket_reply',
      adminUid: req.user.uid,
      adminEmail: req.user.email || '',
      ticketId,
      timestamp: now,
      ipAddress: getClientIP(req)
    }).catch((auditError) => {
      logger.warn('Failed to audit support ticket reply', { ticketId, error: auditError });
    });

    if (ticket.userId) {
      await sendInboxMessage(ticket.userId, {
        title: 'Support replied to your ticket',
        message: `Staff replied to support ticket #${ticketId}. Open Support to continue the conversation.`,
        type: 'support_ticket',
        from: 'Support',
        metadata: {
          event: 'support_ticket_reply',
          ticketId,
          status: 'awaiting_user'
        }
      }).catch((inboxError) => {
        console.warn('Failed to send support reply inbox message:', inboxError.message);
      });
    }

    res.json({ success: true, message: 'Reply sent' });
  } catch (error) {
    console.error('Error replying to support ticket as admin:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error sending reply' });
  }
});

/**
 * POST /api/admin/support/tickets/:ticketId/status - Update support ticket status (Admin only)
 */
app.post('/api/admin/support/tickets/:ticketId/status', adminLimiter, verifyAuthAndNotBanned, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view') && !adminHasCapability(req, 'support:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Support ticket access required' });
    }

    const { ticketId } = req.params;
    const status = normalizeSupportText(req.body?.status, 32).toLowerCase();
    if (!['open', 'awaiting_user', 'awaiting_admin', 'resolved', 'closed'].includes(status)) {
      return res.status(400).json({ error: true, code: 'INVALID_STATUS', message: 'Invalid status' });
    }

    const ticket = await getSupportTicketRecord(ticketId);
    if (!ticket) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Ticket not found' });
    }

    const updates = {
      status,
      updatedAt: new Date().toISOString()
    };
    if (status === 'resolved' || status === 'closed') {
      updates.closedAt = new Date().toISOString();
      updates.closedBy = 'admin';
    }
    await updateSupportTicketRecord(ticketId, updates);

    await writeAuditLogEntry({
      action: 'support_ticket_status_update',
      adminUid: req.user.uid,
      adminEmail: req.user.email || '',
      ticketId,
      status,
      timestamp: updates.updatedAt,
      ipAddress: getClientIP(req)
    }).catch((auditError) => {
      logger.warn('Failed to audit support ticket status update', { ticketId, status, error: auditError });
    });

    if (ticket.userId && (status === 'resolved' || status === 'closed')) {
      await sendInboxMessage(ticket.userId, {
        title: `Support ticket ${status}`,
        message: `Your support ticket #${ticketId} has been ${status}. Check Support if you need to review the original conversation or open a new request.`,
        type: 'support_ticket',
        from: 'Support',
        metadata: {
          event: 'support_ticket_finalized',
          ticketId,
          status
        }
      }).catch((inboxError) => {
        console.warn('Failed to send finalized support ticket inbox message:', inboxError.message);
      });
    }

    res.json({ success: true, message: 'Status updated', status });
  } catch (error) {
    console.error('Error updating support ticket status:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error updating status' });
  }
});

/**
 * Leaderboard visibility helpers for leaderboard moderators.
 */
function normalizeLeaderboardVisibilityEntry(userId, entry = {}) {
  const hiddenGamemodes = {};
  Object.entries(entry.hiddenGamemodes || {}).forEach(([gamemode, enabled]) => {
    const normalizedGamemode = String(gamemode || '').trim().toLowerCase();
    if (enabled === true && CONFIG.GAMEMODES.some((item) => item.id === normalizedGamemode) && normalizedGamemode !== 'overall') {
      hiddenGamemodes[normalizedGamemode] = true;
    }
  });

  return {
    userId: userId || entry.userId || null,
    username: entry.username || null,
    globalHidden: entry.globalHidden === true,
    hiddenGamemodes,
    reason: normalizeSupportText(entry.reason, 300),
    updatedAt: entry.updatedAt || null,
    updatedBy: entry.updatedBy || null
  };
}

async function resolveLeaderboardVisibilityTarget({ targetUserId = null, username = null } = {}) {
  const safeUserId = String(targetUserId || '').trim();
  if (safeUserId) {
    const userProfile = await getStoredUserProfile(safeUserId);
    if (userProfile) {
      return {
        userId: safeUserId,
        username: userProfile.minecraftUsername || null
      };
    }
  }

  const safeUsername = normalizeMinecraftUsername(username);
  if (!safeUsername) {
    return null;
  }

  const playerMatch = await findPlayerByMinecraftIdentity({ username: safeUsername });
  if (playerMatch?.player?.userId) {
    return {
      userId: playerMatch.player.userId,
      username: playerMatch.player.username || safeUsername
    };
  }

  const usersSnapshot = await db.ref('users').once('value');
  const users = usersSnapshot.val() || {};
  const matchedEntry = Object.entries(users).find(([, profile]) => normalizeMinecraftUsername(profile?.minecraftUsername) === safeUsername);
  if (!matchedEntry) {
    return null;
  }

  return {
    userId: matchedEntry[0],
    username: matchedEntry[1]?.minecraftUsername || safeUsername
  };
}

/**
 * Staff moderation routes for moderator / leaderboard moderator roles.
 */
app.get('/api/moderation/chat-reports', verifyAuthAndNotBanned, requireModerationCapabilityMiddleware('moderation:chat_reports:view'), async (req, res) => {
  try {
    const { player, status, limit = 100 } = req.query;
    const maxLimit = Math.min(parseInt(limit, 10) || 100, 500);

    const reportsRef = db.ref('playerReports');
    const snapshot = await reportsRef.once('value');
    const reports = snapshot.val() || {};

    let filteredReports = Object.values(reports).filter((report) => report?.category === 'chat_abuse');

    if (player) {
      const lowerPlayer = String(player).toLowerCase();
      filteredReports = filteredReports.filter((report) => {
        const reportedMessage = report?.messageReport?.reportedMessage || {};
        return [
          report.reportedPlayer,
          report.reporterEmail,
          reportedMessage.username,
          reportedMessage.text,
          report.matchId
        ].some((value) => String(value || '').toLowerCase().includes(lowerPlayer));
      });
    }

    if (status) {
      filteredReports = filteredReports.filter((report) => report.status === status);
    }

    const staffReporterIds = await getStaffReporterIds();
    filteredReports.sort((a, b) => {
      const aStaff = staffReporterIds.has(String(a?.reporterId || '')) ? 1 : 0;
      const bStaff = staffReporterIds.has(String(b?.reporterId || '')) ? 1 : 0;
      if (aStaff !== bStaff) return bStaff - aStaff;
      return parseDateToMs(b?.createdAt) - parseDateToMs(a?.createdAt);
    });

    res.json({
      success: true,
      reports: filteredReports.slice(0, maxLimit)
    });
  } catch (error) {
    console.error('Error getting moderation chat reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error loading chat reports'
    });
  }
});

app.post('/api/moderation/chat-restrictions', verifyAuthAndNotBanned, requireModerationCapabilityMiddleware('moderation:chat:block'), async (req, res) => {
  try {
    const target = await resolveLeaderboardVisibilityTarget({
      targetUserId: req.body?.targetUserId,
      username: req.body?.targetUsername
    });
    if (!target?.userId) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'Could not resolve that player to a user account'
      });
    }

    const active = req.body?.active !== false;
    const reason = normalizeSupportText(req.body?.reason, 250) || 'Chat restricted by moderator';
    const safeDurationHours = Number(req.body?.durationHours) > 0 ? Math.min(Number(req.body.durationHours), 24 * 365) : 24;
    const expiresAt = active
      ? new Date(Date.now() + safeDurationHours * 60 * 60 * 1000).toISOString()
      : null;

    const userData = await getStoredUserProfile(target.userId);
    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    const nextRestrictions = { ...(userData.functionRestrictions || {}) };
    if (active) {
      nextRestrictions.chat = {
        active: true,
        reason,
        setBy: req.user.uid,
        setAt: new Date().toISOString(),
        expiresAt,
        source: 'moderator'
      };
    } else {
      delete nextRestrictions.chat;
    }

    await setStoredUserProfile(target.userId, {
      functionRestrictions: nextRestrictions,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    await addUserModerationHistoryEntry(target.userId, {
      type: active ? 'chat_restriction_added' : 'chat_restriction_removed',
      reason,
      expiresAt,
      by: req.user.uid,
      at: new Date().toISOString()
    });

    await sendInboxMessage(target.userId, {
      title: active ? 'Chat access restricted' : 'Chat access restored',
      message: active
        ? `A moderator restricted your chat access.\n\nReason: ${reason}\n\n${expiresAt ? `This restriction expires on ${new Date(expiresAt).toLocaleString()}.` : 'This restriction is active until staff review it.'}`
        : 'A moderator removed your chat restriction. Please continue following the community rules.',
      type: 'system',
      from: 'MC Leaderboards Moderation',
      metadata: {
        event: active ? 'chat_restriction_added' : 'chat_restriction_removed',
        expiresAt
      }
    }).catch(() => null);

    res.json({
      success: true,
      userId: target.userId,
      restrictions: nextRestrictions
    });
  } catch (error) {
    console.error('Error updating chat restriction:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating chat restriction'
    });
  }
});

app.get('/api/moderation/leaderboard-filters', verifyAuthAndNotBanned, requireModerationCapabilityMiddleware('leaderboard:filters:manage'), async (_req, res) => {
  try {
    const snapshot = await db.ref('leaderboardVisibility').once('value');
    const entries = Object.entries(snapshot.val() || {})
      .map(([userId, entry]) => normalizeLeaderboardVisibilityEntry(userId, entry))
      .filter((entry) => entry.globalHidden || Object.keys(entry.hiddenGamemodes).length > 0)
      .sort((left, right) => parseDateToMs(right.updatedAt) - parseDateToMs(left.updatedAt));

    res.json({ success: true, entries });
  } catch (error) {
    console.error('Error loading leaderboard filters:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error loading leaderboard filters'
    });
  }
});

app.post('/api/moderation/leaderboard-filters', verifyAuthAndNotBanned, requireModerationCapabilityMiddleware('leaderboard:filters:manage'), async (req, res) => {
  try {
    const target = await resolveLeaderboardVisibilityTarget({
      targetUserId: req.body?.targetUserId,
      username: req.body?.targetUsername
    });
    if (!target?.userId) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'Could not resolve that player to a user account'
      });
    }

    const requestedGamemodes = Array.isArray(req.body?.gamemodes) ? req.body.gamemodes : [];
    const hiddenGamemodes = {};
    requestedGamemodes.forEach((gamemode) => {
      const normalizedGamemode = String(gamemode || '').trim().toLowerCase();
      if (normalizedGamemode && normalizedGamemode !== 'overall' && CONFIG.GAMEMODES.some((item) => item.id === normalizedGamemode)) {
        hiddenGamemodes[normalizedGamemode] = true;
      }
    });

    const entry = normalizeLeaderboardVisibilityEntry(target.userId, {
      userId: target.userId,
      username: target.username,
      globalHidden: req.body?.globalHidden === true,
      hiddenGamemodes,
      reason: req.body?.reason,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.uid
    });

    if (!entry.globalHidden && Object.keys(entry.hiddenGamemodes).length === 0) {
      await db.ref(`leaderboardVisibility/${target.userId}`).remove();
    } else {
      await db.ref(`leaderboardVisibility/${target.userId}`).set(entry);
    }

    playersCache.data = null;
    playersCache.updatedAt = 0;

    res.json({
      success: true,
      entry
    });
  } catch (error) {
    console.error('Error saving leaderboard filter:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error saving leaderboard filter'
    });
  }
});

app.delete('/api/moderation/leaderboard-filters/:userId', verifyAuthAndNotBanned, requireModerationCapabilityMiddleware('leaderboard:filters:manage'), async (req, res) => {
  try {
    const userId = String(req.params.userId || '').trim();
    if (!userId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'User ID is required'
      });
    }

    await db.ref(`leaderboardVisibility/${userId}`).remove();
    playersCache.data = null;
    playersCache.updatedAt = 0;

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing leaderboard filter:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing leaderboard filter'
    });
  }
});

app.post('/api/moderation/admin-contact', verifyAuthAndNotBanned, requireAnyModerationCapabilityMiddleware([
  'moderation:contact_admins',
  'moderation:chat_reports:view',
  'moderation:chat:block',
  'leaderboard:filters:manage'
]), async (req, res) => {
  try {
    const message = normalizeSupportText(req.body?.message, 2000);
    if (!message || message.length < 5) {
      return res.status(400).json({ error: true, code: 'INVALID_MESSAGE', message: 'Message must be at least 5 characters.' });
    }
    if (await containsProfanity(message)) {
      return res.status(400).json({ error: true, code: 'PROFANITY_DETECTED', message: 'Message contains inappropriate language.' });
    }

    const profile = req.userProfile || await getStoredUserProfile(req.user.uid) || {};
    const requestRef = db.ref('moderatorAdminRequests').push();
    const staffRole = req.staffRoleContext || await resolveRequesterStaffRole(req).catch(() => null);
    const payload = sanitizeFirebaseValue({
      id: requestRef.key,
      requesterUserId: req.user.uid,
      requesterEmail: req.user.email || profile.email || null,
      requesterUsername: profile.minecraftUsername || null,
      staffRoleName: staffRole?.name || null,
      staffRoleIds: Array.isArray(staffRole?.roleIds) ? staffRole.roleIds : [],
      message,
      status: 'open',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    await requestRef.set(payload);
    res.json({ success: true, request: payload });
  } catch (error) {
    console.error('Error creating admin contact request:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error sending admin request' });
  }
});

app.get('/api/admin/moderator-requests', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'settings:manage') && !adminHasCapability(req, '*')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Settings manage capability required' });
    }

    const status = normalizeSupportText(req.query.status, 32).toLowerCase();
    const snapshot = await db.ref('moderatorAdminRequests').once('value');
    let requests = Object.entries(snapshot.val() || {}).map(([id, request]) => ({ id, ...(request || {}) }));
    if (status && status !== 'all') {
      requests = requests.filter((request) => String(request.status || 'open') === status);
    }
    requests.sort((left, right) => parseDateToMs(right.updatedAt || right.createdAt) - parseDateToMs(left.updatedAt || left.createdAt));
    res.json({ success: true, requests: requests.slice(0, 200) });
  } catch (error) {
    console.error('Error loading moderator admin requests:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error loading admin requests' });
  }
});

app.post('/api/admin/moderator-requests/:requestId/status', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'settings:manage') && !adminHasCapability(req, '*')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Settings manage capability required' });
    }

    const status = normalizeSupportText(req.body?.status, 32).toLowerCase();
    if (!['open', 'reviewed', 'closed'].includes(status)) {
      return res.status(400).json({ error: true, code: 'INVALID_STATUS', message: 'Invalid status' });
    }
    const requestId = String(req.params.requestId || '').trim();
    const requestRef = db.ref(`moderatorAdminRequests/${requestId}`);
    const snapshot = await requestRef.once('value');
    if (!snapshot.exists()) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Request not found' });
    }

    await requestRef.update({
      status,
      reviewedBy: req.user.uid,
      updatedAt: new Date().toISOString()
    });
    res.json({ success: true, status });
  } catch (error) {
    console.error('Error updating moderator admin request:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error updating admin request' });
  }
});

/**
 * GET /admin/reports/user - Get user reports (Admin only)
 */
app.get('/api/admin/reports/user', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { player, category, status, limit = 100 } = req.query;
    const maxLimit = Math.min(parseInt(limit) || 100, 500); // Cap at 500 records

    const reportsRef = db.ref('playerReports');
    const snapshot = await reportsRef.once('value');
    const reports = snapshot.val() || {};

    let filteredReports = Object.values(reports);

    // Apply filters
    if (player) {
      const lowerPlayer = player.toLowerCase();
      filteredReports = filteredReports.filter(r => 
        r.reportedPlayer.toLowerCase().includes(lowerPlayer) ||
        r.reporterEmail.toLowerCase().includes(lowerPlayer)
      );
    }

    if (category) {
      filteredReports = filteredReports.filter(r => r.category === category);
    }

    if (status) {
      filteredReports = filteredReports.filter(r => r.status === status);
    }

    const staffReporterIds = await getStaffReporterIds();

    // Sort by newest first and limit results
    filteredReports.sort((a, b) => {
      const aStaff = staffReporterIds.has(String(a?.reporterId || '')) ? 1 : 0;
      const bStaff = staffReporterIds.has(String(b?.reporterId || '')) ? 1 : 0;
      if (aStaff !== bStaff) return bStaff - aStaff;
      return parseDateToMs(b?.createdAt) - parseDateToMs(a?.createdAt);
    });
    filteredReports = filteredReports.slice(0, maxLimit);

    res.json({
      success: true,
      reports: filteredReports
    });
  } catch (error) {
    console.error('Error getting user reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting reports'
    });
  }
});

/**
 * GET /admin/reports/user/:reportId - Get user report details (Admin only)
 */
app.get('/api/admin/reports/user/:reportId', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { reportId } = req.params;
    const reportRef = db.ref(`playerReports/${reportId}`);
    const snapshot = await reportRef.once('value');
    const report = snapshot.val();

    if (!report) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Report not found'
      });
    }

    res.json({
      success: true,
      report: report
    });
  } catch (error) {
    console.error('Error getting report details:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting report'
    });
  }
});

/**
 * GET /admin/reports/messages - Get chat/message reports (Admin only)
 */
app.get('/api/admin/reports/messages', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { player, status, limit = 100 } = req.query;
    const maxLimit = Math.min(parseInt(limit, 10) || 100, 500);

    const reportsRef = db.ref('playerReports');
    const snapshot = await reportsRef.once('value');
    const reports = snapshot.val() || {};

    let filteredReports = Object.values(reports).filter((report) => report?.category === 'chat_abuse');

    if (player) {
      const lowerPlayer = String(player).toLowerCase();
      filteredReports = filteredReports.filter((report) => {
        const reportedMessage = report?.messageReport?.reportedMessage || {};
        return [
          report.reportedPlayer,
          report.reporterEmail,
          reportedMessage.username,
          reportedMessage.text,
          report.matchId
        ].some((value) => String(value || '').toLowerCase().includes(lowerPlayer));
      });
    }

    if (status) {
      filteredReports = filteredReports.filter((report) => report.status === status);
    }

    const staffReporterIds = await getStaffReporterIds();

    filteredReports.sort((a, b) => {
      const aStaff = staffReporterIds.has(String(a?.reporterId || '')) ? 1 : 0;
      const bStaff = staffReporterIds.has(String(b?.reporterId || '')) ? 1 : 0;
      if (aStaff !== bStaff) return bStaff - aStaff;
      return parseDateToMs(b.createdAt) - parseDateToMs(a.createdAt);
    });
    filteredReports = filteredReports.slice(0, maxLimit);

    res.json({
      success: true,
      reports: filteredReports
    });
  } catch (error) {
    console.error('Error getting message reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting reports'
    });
  }
});

/**
 * POST /admin/reports/user/:reportId/resolve - Resolve user report (Admin only)
 */
app.post('/api/admin/reports/user/:reportId/resolve', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { reportId } = req.params;
    const { notes, action } = req.body;

    const reportRef = db.ref(`playerReports/${reportId}`);
    const snapshot = await reportRef.once('value');
    const report = snapshot.val();

    if (!report) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Report not found'
      });
    }

    // Update report
    await reportRef.update({
      status: 'resolved',
      reviewedBy: req.user.uid,
      reviewedAt: new Date().toISOString(),
      reviewNotes: notes || '',
      actionTaken: action || null
    });

    // Send inbox message to the reporter
    if (report.reporterId) {
      const actionText = action === 'blacklisted' ? 'Action has been taken against the reported player.'
        : action === 'warned' ? 'A warning has been issued to the reported player.'
        : action === 'dismissed' ? 'After review, no action was deemed necessary at this time.'
        : 'Your report has been reviewed by our moderation team.';
      await sendInboxMessage(report.reporterId, {
        title: 'Your Report Has Been Resolved',
        message: `Your report against ${report.reportedPlayer || 'a player'} has been reviewed and resolved.\n\n${actionText}\n\nThank you for helping keep MC Leaderboards fair and safe.`,
        type: 'report_resolved',
        from: 'MC Leaderboards Moderation',
        metadata: { reportId, action: action || 'reviewed' }
      });
    }

    // Send inbox message to the reported player (look up their userId by username)
    let reportedUserId = null;
    if (report.reportedPlayer) {
      const playerSnap = await db.ref('players').orderByChild('username').equalTo(report.reportedPlayer).limitToFirst(1).once('value');
      const playerData = playerSnap.val();
      if (playerData) {
        const entry = Object.values(playerData)[0];
        reportedUserId = entry?.userId || null;
      }
    }
    if (reportedUserId) {
      const reportedMsg = action === 'blacklisted'
        ? 'After investigation, action has been taken on your account. Please review your inbox for details.'
        : action === 'warned'
        ? 'After investigation, a warning has been issued. Please review our rules to ensure compliance.'
        : 'After investigation, no further action is being taken at this time.';
      await sendInboxMessage(reportedUserId, {
        title: 'Report Investigation Complete',
        message: `A report filed against your account has been reviewed by our moderation team.\n\n${reportedMsg}\n\nIf you have questions, please contact support.`,
        type: 'system',
        from: 'MC Leaderboards Moderation',
        metadata: { reportId }
      });
    }

    // Update the reporter's index entry status
    if (report.reporterId) {
      await db.ref(`playerReportsByUser/${report.reporterId}/${reportId}/status`).set('resolved');
    }

    // Log admin action
    await logAdminAction(req, req.user.uid, 'RESOLVE_PLAYER_REPORT', reportId, {
      reportedPlayer: report.reportedPlayer,
      notes: notes,
      action: action
    });

    res.json({
      success: true,
      message: 'Report resolved successfully'
    });
  } catch (error) {
    console.error('Error resolving report:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error resolving report'
    });
  }
});

/**
 * GET /admin/reports/noshow - Get no-show reports (Admin only)
 */
app.get('/api/admin/reports/noshow', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { player, status } = req.query;

    const noshowRef = db.ref('noshowReports');
    const snapshot = await noshowRef.once('value');
    const noshowReports = snapshot.val() || {};

    let filteredReports = Object.values(noshowReports);

    // Apply filters
    if (player) {
      const lowerPlayer = player.toLowerCase();
      filteredReports = filteredReports.filter(r => 
        (r.playerName || '').toLowerCase().includes(lowerPlayer) ||
        (r.playerId || '').toLowerCase().includes(lowerPlayer)
      );
    }

    if (status) {
      filteredReports = filteredReports.filter(r => r.status === status);
    }

    // Sort by newest first
    const staffReporterIds = await getStaffReporterIds();
    filteredReports.sort((a, b) => {
      const aStaff = staffReporterIds.has(String(a?.reporterId || a?.reportedByUserId || '')) ? 1 : 0;
      const bStaff = staffReporterIds.has(String(b?.reporterId || b?.reportedByUserId || '')) ? 1 : 0;
      if (aStaff !== bStaff) return bStaff - aStaff;
      return parseDateToMs(b?.createdAt) - parseDateToMs(a?.createdAt);
    });

    res.json({
      success: true,
      reports: filteredReports
    });
  } catch (error) {
    console.error('Error getting no-show reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting reports'
    });
  }
});

/**
 * POST /admin/reports/noshow/:reportId/resolve - Resolve no-show report (Admin only)
 */
app.post('/api/admin/reports/noshow/:reportId/resolve', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { reportId } = req.params;
    const { notes } = req.body;

    const reportRef = db.ref(`noshowReports/${reportId}`);
    const snapshot = await reportRef.once('value');
    const report = snapshot.val();

    if (!report) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Report not found'
      });
    }

    // Update report
    await reportRef.update({
      status: 'resolved',
      reviewedBy: req.user.uid,
      resolvedAt: new Date().toISOString(),
      resolutionNotes: notes || ''
    });

    // Send inbox message to the reported player about no-show resolution
    if (report.playerId) {
      await sendInboxMessage(report.playerId, {
        title: 'No-Show Report Resolved',
        message: `A no-show report on your account has been reviewed and resolved.\n\n${notes ? 'Notes: ' + notes + '\n\n' : ''}Please ensure you show up for scheduled matches in the future. Repeated no-shows may result in cooldowns or restrictions.`,
        type: 'system',
        from: 'MC Leaderboards Moderation',
        metadata: { reportId, event: 'noshow_resolved' }
      });
    }

    // Log admin action
    await logAdminAction(req, req.user.uid, 'RESOLVE_NOSHOW_REPORT', reportId, {
      playerId: report.playerId,
      notes: notes
    });

    res.json({
      success: true,
      message: 'No-show report resolved successfully'
    });
  } catch (error) {
    console.error('Error resolving no-show report:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error resolving report'
    });
  }
});

/**
 * POST /admin/security/whitelist - Add account to security whitelist (Admin only)
 */
app.post('/api/admin/security/whitelist', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_FIELD',
        message: 'userId is required'
      });
    }

    // Validate userId exists
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    
    if (!userSnapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    const whitelistRef = db.ref('securityWhitelist');
    const whitelistSnapshot = await whitelistRef.once('value');
    const whitelist = whitelistSnapshot.val() || {};

    // Check if already whitelisted
    if (Object.values(whitelist).find(w => w.userId === userId)) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_WHITELISTED',
        message: 'User is already whitelisted'
      });
    }

    // Add to whitelist
    const whitelistEntryId = whitelistRef.push().key;
    const userData = userSnapshot.val();

    await whitelistRef.child(whitelistEntryId).set({
      id: whitelistEntryId,
      userId: userId,
      email: userData.email,
      addedBy: req.user.uid,
      addedAt: new Date().toISOString(),
      reason: req.body.reason || 'Admin whitelist'
    });
    
    // Invalidate cache
    cache.invalidate('whitelist');

    // Log admin action
    await logAdminAction(req, req.user.uid, 'ADD_SECURITY_WHITELIST', whitelistEntryId, {
      userId: userId
    });

    res.json({
      success: true,
      message: 'User added to security whitelist',
      entryId: whitelistEntryId
    });
  } catch (error) {
    console.error('Error adding to security whitelist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error adding to whitelist'
    });
  }
});

/**
 * GET /admin/security/whitelist - Get security whitelist (Admin only)
 */
app.get('/api/admin/security/whitelist', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const whitelistRef = db.ref('securityWhitelist');
    const snapshot = await whitelistRef.once('value');
    const whitelist = snapshot.val() || {};

    const whitelisted = Object.values(whitelist).sort((a, b) => 
      new Date(b.addedAt) - new Date(a.addedAt)
    );

    res.json({
      success: true,
      whitelisted: whitelisted
    });
  } catch (error) {
    console.error('Error getting security whitelist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting whitelist'
    });
  }
});

/**
 * DELETE /admin/security/whitelist/:entryId - Remove account from security whitelist (Admin only)
 */
app.delete('/api/admin/security/whitelist/:entryId', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { entryId } = req.params;

    const whitelistRef = db.ref(`securityWhitelist/${entryId}`);
    const snapshot = await whitelistRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Whitelist entry not found'
      });
    }

    const entry = snapshot.val();

    // Remove from whitelist
    await whitelistRef.remove();
    
    // Invalidate cache
    cache.invalidate('whitelist');

    // Log admin action
    await logAdminAction(req, req.user.uid, 'REMOVE_SECURITY_WHITELIST', entryId, {
      userId: entry.userId
    });

    res.json({
      success: true,
      message: 'User removed from security whitelist'
    });
  } catch (error) {
    console.error('Error removing from security whitelist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing from whitelist'
    });
  }
});

// ===== Tier Tester Routes =====

/**
 * POST /api/tester/availability - Set tester availability
 */
app.post('/api/tester/availability', verifyAuthAndNotBanned, verifyTester, requireRecaptcha, async (req, res) => {
  try {
    const { available } = req.body;
    const { gamemodes, regions } = normalizeAvailabilitySelections(req.body);
    const gamemode = gamemodes[0] || null;
    const region = regions[0] || null;
    
    if (typeof available !== 'boolean' || (available && gamemodes.length === 0)) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'available (boolean) and at least one gamemode are required'
      });
    }

    if (available && regions.length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'at least one region is required when setting availability'
      });
    }

    if (available && gamemodes.some((value) => !CONFIG.GAMEMODES.some((gm) => gm.id === value && gm.id !== 'overall'))) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'One or more selected gamemodes are invalid'
      });
    }

    if (available && regions.some((value) => !ALLOWED_REGIONS.has(value))) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'One or more selected regions are invalid'
      });
    }
    
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (available && gamemodes.some((value) => isUserRetiredFromGamemode(userProfile, value))) {
      return res.status(403).json({
        error: true,
        code: 'GAMEMODE_RETIRED',
        message: 'You have retired from one or more selected gamemodes and cannot set tester availability for them'
      });
    }
    
    if (available) {
      const activeMatchSnapshot = await db.ref('matches').orderByChild('status').equalTo('active').once('value');
      const activeMatches = activeMatchSnapshot.val() || {};
      const hasActiveMatch = Object.values(activeMatches).some((m) => !m?.finalized && (m.playerId === req.user.uid || m.testerId === req.user.uid));
      if (hasActiveMatch) {
        return res.status(400).json({
          error: true,
          code: 'ACTIVE_MATCH_EXISTS',
          message: 'You already have an active match. Complete it before setting availability.'
        });
      }

      // Check if tester is tiered appropriately
      // First try to find by userId, then fallback to username matching
      const playersRef = db.ref('players');
      const playersSnapshot = await playersRef.once('value');
      const players = playersSnapshot.val() || {};

      // Try to find by Firebase userId first
      let testerPlayer = Object.values(players).find(p => p.userId === req.user.uid);

      // If not found by userId, try to find by Minecraft username from profile
      if (!testerPlayer && userProfile.minecraftUsername) {
        testerPlayer = Object.values(players).find(p => p.username === userProfile.minecraftUsername);

        // If found by username, update the record to include userId for future lookups
        if (testerPlayer && !testerPlayer.userId) {
          const playerKey = Object.keys(players).find(key => players[key].username === userProfile.minecraftUsername);
          if (playerKey) {
            await playersRef.child(playerKey).update({ userId: req.user.uid });
            testerPlayer.userId = req.user.uid; // Update local copy
          }
        }
      }

      if (!testerPlayer) {
        return res.status(400).json({
          error: true,
          code: 'NOT_TIERED',
          message: 'You must have a linked Minecraft account with tier data to become a tester'
        });
      }

      // Testers can join any queue regardless of rating

      const sanitizedServerIP = String(req.body?.serverIP || '').trim();
      if (!sanitizedServerIP) {
        return res.status(400).json({
          error: true,
          code: 'VALIDATION_ERROR',
          message: 'serverIP is required'
        });
      }

      const resolvedServerIP = await getCanonicalWhitelistedServerIP(sanitizedServerIP);
      if (!resolvedServerIP) {
        return res.status(400).json({
          error: true,
          code: 'SERVER_NOT_WHITELISTED',
          message: 'The server IP you entered is not whitelisted. Please select a whitelisted server or contact an admin.'
        });
      }

      const queueRef = db.ref('queue');
      const existingQueueSnapshot = await queueRef.orderByChild('userId').equalTo(req.user.uid).once('value');
      if (existingQueueSnapshot.exists()) {
        return res.status(400).json({
          error: true,
          code: 'ALREADY_IN_QUEUE',
          message: 'You are already in the queue'
        });
      }

      const newQueueRef = queueRef.push();
      const queueEntry = buildQueueEntry({
        queueId: newQueueRef.key,
        userId: req.user.uid,
        minecraftUsername: userProfile.minecraftUsername,
        gamemodes,
        regions,
        serverIP: resolvedServerIP,
        rolePreference: 'tester',
        testerEligible: true,
        source: 'tester_dashboard',
        timeoutAt: new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()
      });
      await newQueueRef.set(queueEntry);

      const matchResult = await attemptImmediateMatchmaking(queueEntry, userProfile);

      if (!matchResult) {
        // Notify users who have selected this gamemode for tester availability notifications
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val() || {};
        
        for (const [uid, user] of Object.entries(users)) {
          if (uid === req.user.uid) continue; // Don't notify self
          
          const notifySettings = user.notificationSettings || {};
          const selectedGamemodes = notifySettings.testerAvailabilityGamemodes || [];
          
          const matchingGamemodes = gamemodes.filter((selectedGamemode) => selectedGamemodes.includes(selectedGamemode));
          for (const notifyGamemode of matchingGamemodes) {
            await createNotification(uid, {
              type: 'tester_available',
              title: 'Tester Available',
              message: `A tier tester is now available for ${notifyGamemode} in ${regions.join(', ')}`,
              gamemode: notifyGamemode,
              region: regions[0] || null,
              regions
            });
          }
        }
      }

      res.json({
        success: true,
        matched: Boolean(matchResult),
        matchId: matchResult?.matchId || null,
        message: matchResult ? 'Match found! Redirecting to testing page...' : 'Joined the queue as a tier tester'
      });
    } else {
      await clearUserQueueEntries(req.user.uid);
      
      res.json({ success: true, message: 'Removed from queue' });
    }
  } catch (error) {
    console.error('Error setting tier tester availability:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting availability'
    });
  }
});

/**
 * GET /api/tester/availability - Get tester availability
 */
app.get('/api/tester/availability', verifyAuthAndNotBanned, verifyTester, async (req, res) => {
  try {
    const snapshot = await db.ref('queue').orderByChild('userId').equalTo(req.user.uid).once('value');
    const queueEntries = Object.values(snapshot.val() || {});
    const availability = queueEntries.find((entry) => entry?.queueSource === 'tester_dashboard' && !isQueueEntryExpired(entry)) || null;
    
    res.json({ available: availability !== null, availability: availability || null });
  } catch (error) {
    console.error('Error getting tier tester availability:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting availability'
    });
  }
});

/**
 * GET /api/tester/reputation - Get tester reputation stats
 */
app.get('/api/tester/reputation', verifyAuthAndNotBanned, verifyTester, async (req, res) => {
  try {
    const testerId = req.user.uid;

    const matchesSnap = await db.ref('matches').orderByChild('testerId').equalTo(testerId).once('value');

    const emptyReputation = {
      onTimeRate: 100,
      noShowRate: 0,
      averageMatchCompletionMinutes: 0,
      totalMatchesEvaluated: 0
    };

    if (!matchesSnap.exists()) {
      return res.json({ reputation: emptyReputation });
    }

    const allMatches = Object.values(matchesSnap.val() || {});
    const finalizedMatches = allMatches.filter(m => m.status === 'ended' && m.finalized && m.finalizedAt && m.createdAt);
    const cancelledMatches = allMatches.filter(m => m.status === 'cancelled');

    const totalMatchesEvaluated = finalizedMatches.length;

    if (totalMatchesEvaluated === 0) {
      return res.json({ reputation: emptyReputation });
    }

    const ON_TIME_THRESHOLD_MS = 60 * 60 * 1000; // 60 minutes
    let totalMinutes = 0;
    let onTimeCount = 0;

    for (const m of finalizedMatches) {
      const durationMs = new Date(m.finalizedAt) - new Date(m.createdAt);
      if (durationMs > 0) {
        totalMinutes += durationMs / 60000;
        if (durationMs <= ON_TIME_THRESHOLD_MS) onTimeCount++;
      }
    }

    const averageMatchCompletionMinutes = Math.round(totalMinutes / totalMatchesEvaluated);
    const onTimeRate = Math.round((onTimeCount / totalMatchesEvaluated) * 100);
    const totalEvaluated = totalMatchesEvaluated + cancelledMatches.length;
    const noShowRate = totalEvaluated > 0
      ? Math.min(100, Math.round((cancelledMatches.length / totalEvaluated) * 100))
      : 0;

    res.json({
      reputation: {
        onTimeRate,
        noShowRate,
        averageMatchCompletionMinutes,
        totalMatchesEvaluated
      }
    });
  } catch (error) {
    console.error('Error getting tester reputation:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting tester reputation'
    });
  }
});

// ===== Match SSE (Server-Sent Events) =====

// Track active SSE connections per match for broadcasting
const matchSSEClients = new Map(); // matchId -> Set<{ res, userId }>

/**
 * GET /api/match/:matchId/stream - SSE stream for real-time match updates
 * Requires authentication. Only match participants and admins can connect.
 */
app.get('/api/match/:matchId/stream', verifyAuth, async (req, res) => {
  try {
    const userId = req.user.uid;

    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const matchData = snapshot.val();
    if (!matchData) {
      return res.status(404).json({ error: true, message: 'Match not found' });
    }

    // Only participants and admins
    const isParticipant = matchData.playerId === userId || matchData.testerId === userId;
    if (!isParticipant) {
      const profile = req.userProfile || (await db.ref(`users/${userId}`).once('value')).val();
      if (!hasAdminAccess(profile || {}, req.user.email)) {
        return res.status(403).json({ error: true, message: 'Access denied' });
      }
    }

    // Set up SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // Disable nginx buffering for this stream
    });
    res.flushHeaders();
    res.socket?.setKeepAlive?.(true, 30000);

    // Send initial state
    res.write(`data: ${JSON.stringify({ type: 'match', data: sanitizeMatchForClient(matchData, matchId) })}\n\n`);

    // Register this client
    if (!matchSSEClients.has(matchId)) {
      matchSSEClients.set(matchId, new Set());
    }
    const client = { res, userId };
    matchSSEClients.get(matchId).add(client);

    // Listen for RTDB changes on this match
    const onMatchChange = (snap) => {
      try {
        const updated = snap.val();
        if (!updated) return;
        res.write(`data: ${JSON.stringify({ type: 'match', data: sanitizeMatchForClient(updated, matchId) })}\n\n`);
      } catch { /* client disconnected */ }
    };
    matchRef.on('value', onMatchChange);

    // Listen for chat changes
    const chatRef = db.ref(`matches/${matchId}/chat`);
    const onChatChange = (snap) => {
      try {
        const chatData = snap.val() || {};
        const messages = Object.entries(chatData)
          .map(([messageId, msg]) => ({ ...msg, messageId }))
          .sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        res.write(`data: ${JSON.stringify({ type: 'chat', data: messages })}\n\n`);
      } catch { /* client disconnected */ }
    };
    chatRef.on('value', onChatChange);

    // Heartbeat to keep connection alive (every 30s)
    const heartbeat = setInterval(() => {
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); }
    }, 30000);

    // Clean up on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      matchRef.off('value', onMatchChange);
      chatRef.off('value', onChatChange);
      const clients = matchSSEClients.get(matchId);
      if (clients) {
        clients.delete(client);
        if (clients.size === 0) matchSSEClients.delete(matchId);
      }
    });
  } catch (error) {
    logger.error('SSE stream error', { matchId: req.params.matchId, error });
    if (!res.headersSent) {
      res.status(500).json({ error: true, message: 'Stream error' });
    }
  }
});

// ===== Match Routes =====

/**
 * GET /api/match/active - Get active match for current user
 */
app.get('/api/match/active', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const matchesRef = db.ref('matches');
    const matchesSnapshot = await matchesRef
      .orderByChild('status')
      .equalTo('active')
      .once('value');
    
    if (!matchesSnapshot.exists()) {
      return res.json({ hasMatch: false });
    }
    
    const matches = matchesSnapshot.val();
    
    // Find match where user is participant
	    for (const matchId in matches) {
	      const match = matches[matchId];
	      if (match.playerId === req.user.uid || match.testerId === req.user.uid) {
	        return res.json({ hasMatch: true, match: await enrichMatchForClient(match, matchId) });
	      }
	    }
    
    res.json({ hasMatch: false });
  } catch (error) {
    console.error('Error getting active match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting active match'
    });
  }
});

/**
 * GET /api/match/:matchId - Get match details
 */
app.get('/api/match/:matchId', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();
    
    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }
    
    // Verify user is participant or admin
    const isParticipant = match.playerId === req.user.uid || match.testerId === req.user.uid;
    let isAdmin = false;
    if (!isParticipant) {
      const userRef = db.ref(`users/${req.user.uid}`);
      const userSnapshot = await userRef.once('value');
      const userProfile = userSnapshot.val();
      isAdmin = hasAdminAccess(userProfile || {}, req.user.email);
      if (!isAdmin) {
        return res.status(403).json({
          error: true,
          code: 'PERMISSION_DENIED',
          message: 'Access denied'
        });
      }
    }
    
	    // Admins get full data; participants get sanitized data
	    res.json(isAdmin ? { ...match, matchId } : await enrichMatchForClient(match, matchId));
  } catch (error) {
    console.error('Error getting match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error getting match'
    });
  }
});

/**
 * POST /api/match/:matchId/join - Join match
 */
app.post('/api/match/:matchId/join', verifyAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();
    
    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }
    
    // Verify user is participant
    if (match.playerId !== req.user.uid && match.testerId !== req.user.uid) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'You are not a participant in this match'
      });
    }
    
    // Add to participants
    const participantsRef = matchRef.child('participants');
    await participantsRef.child(req.user.uid).set({
      joinedAt: new Date().toISOString()
    });
    
    res.json({ success: true, message: 'Joined match' });
  } catch (error) {
    console.error('Error joining match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error joining match'
    });
  }
});

/**
 * POST /api/match/:matchId/presence - Update presence
 */
app.post('/api/match/:matchId/presence', verifyAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { onPage } = req.body;
    const matchRef = db.ref(`matches/${matchId}/presence`);
    
    await matchRef.child(req.user.uid).set({
      onPage: onPage === true,
      lastSeen: new Date().toISOString()
    });
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating presence:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating presence'
    });
  }
});

/**
 * POST /api/match/:matchId/pagestats - Update page stats
 */
app.post('/api/match/:matchId/pagestats', verifyAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { isPlayer } = req.body;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();
    
    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }
    
    const pagestatsRef = matchRef.child('pagestats');
    const previousPagestats = match.pagestats || {};
    const previouslyBothJoined = !!(previousPagestats.playerJoined && previousPagestats.testerJoined);
    const joinedField = isPlayer ? 'playerJoined' : 'testerJoined';

    await pagestatsRef.update({
      [joinedField]: true,
      lastUpdate: new Date().toISOString()
    });

    const updatedSnapshot = await matchRef.once('value');
    const updatedMatch = updatedSnapshot.val() || {};
    const pagestats = {
      playerJoined: updatedMatch.pagestats?.playerJoined === true,
      testerJoined: updatedMatch.pagestats?.testerJoined === true,
      lastUpdate: updatedMatch.pagestats?.lastUpdate || new Date().toISOString()
    };
    
    // FIX #2: If both players have now joined, mark timeout as handled (no need to check later)
    if (pagestats.playerJoined && pagestats.testerJoined && !updatedMatch.timeoutHandled) {
      console.log('Both players joined match', matchId, ', cancelling timeout check');
      await matchRef.update({ timeoutHandled: true });
    }

    // If tester just joined, start player join timeout
    if (!isPlayer && pagestats.testerJoined && !previousPagestats.testerJoined && !updatedMatch.playerJoinTimeout) {
      const playerJoinTimeout = {
        startedAt: new Date().toISOString(),
        timeoutMinutes: 3,
        autoEndEnabled: true
      };

      await matchRef.child('playerJoinTimeout').set(playerJoinTimeout);

      // Set up 3-minute timeout for player to join
      const PLAYER_JOIN_TIMEOUT_MS = 3 * 60 * 1000;
      setTimeout(async () => {
        try {
          console.log('⏰ Checking player join timeout for match', matchId, '...');
          await handlePlayerJoinTimeout(matchId);
        } catch (error) {
          console.error('Error handling player join timeout for match', matchId, ':', error);
        }
      }, PLAYER_JOIN_TIMEOUT_MS);
    }

    if (pagestats.playerJoined && pagestats.testerJoined && !previouslyBothJoined && !updatedMatch.matchStarted && !updatedMatch.countdownStartedAt) {
      const countdownStartedAt = new Date().toISOString();
      await matchRef.update({
        countdownStartedAt,
        startCountdownHandled: false
      });
      scheduleMatchStartCountdownTimeout(matchId);
    }
    
    res.json({ success: true, pagestats });
  } catch (error) {
    console.error('Error updating page stats:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating page stats'
    });
  }
});

/**
 * POST /api/match/:matchId/started - Mark match as started
 */
app.post('/api/match/:matchId/started', verifyAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();

    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    if (match.playerId !== req.user.uid && match.testerId !== req.user.uid) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'You are not a participant in this match'
      });
    }

    if (match.testerId !== req.user.uid) {
      return res.status(403).json({
        error: true,
        code: 'TESTER_ONLY_ACTION',
        message: 'Only the tier tester can mark the match as started'
      });
    }

    const playerJoined = match.pagestats?.playerJoined || false;
    const testerJoined = match.pagestats?.testerJoined || false;
    if (!playerJoined || !testerJoined) {
      return res.status(400).json({
        error: true,
        code: 'NOT_READY',
        message: 'Both players must join before starting the match'
      });
    }

    if (match.matchStarted) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_STARTED',
        message: 'Match has already started'
      });
    }

    if (match.countdownStartedAt) {
      const countdownExpiresAt = new Date(match.countdownStartedAt).getTime() + MATCH_START_TIMEOUT_MS;
      if (!Number.isNaN(countdownExpiresAt) && Date.now() >= countdownExpiresAt) {
        return res.status(400).json({
          error: true,
          code: 'START_COUNTDOWN_EXPIRED',
          message: 'The 5 minute start window expired. This match is being finalized as a draw.'
        });
      }
    }

    const playerUserSnapshot = await db.ref(`users/${match.playerId}`).once('value');
    const playerUserProfile = playerUserSnapshot.val() || {};
    const playerCooldownState = getQueueCooldownState(playerUserProfile, match.gamemode);
    if (!playerCooldownState.allowed) {
      return res.status(400).json({
        error: true,
        code: 'PLAYER_COOLDOWN_ACTIVE',
        message: `The player is still on cooldown for ${match.gamemode.toUpperCase()} and cannot start this match yet.`
      });
    }

    await matchRef.update({
      matchStarted: true,
      matchStartedAt: new Date().toISOString(),
      countdownStartedAt: null,
      startCountdownHandled: true
    });

    await Promise.all([
      clearUserQueueEntries(match.playerId),
      clearUserQueueEntries(match.testerId)
    ]);

    res.json({ success: true, message: 'Match marked as started' });
  } catch (error) {
    console.error('Error marking match as started:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error marking match as started'
    });
  }
});

/**
 * POST /api/match/:matchId/message - Send chat message
 */
app.post('/api/match/:matchId/message', verifyAuth, requireRecaptcha, messageLimiter, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { text } = req.body;
    
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Message text is required'
      });
    }

    // Check for profanity in chat message
    try {
      const hasProfanity = await containsProfanity(text.trim());
      if (hasProfanity) {
        return res.status(400).json({
          error: true,
          code: 'PROFANITY_DETECTED',
          message: 'Your message contains inappropriate language and cannot be sent'
        });
      }
    } catch (error) {
      // If profanity filter is unavailable, block the request
      return res.status(503).json({
        error: true,
        code: 'FILTER_UNAVAILABLE',
        message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
      });
    }

    // Check for spam (ToS Section 6)
    const spamCheck = await detectSpam(req.user.uid, text.trim());
    if (spamCheck.suspicious && spamCheck.severity === 'high') {
      return res.status(429).json({
        error: true,
        code: 'SPAM_DETECTED',
        message: 'You are sending messages too frequently. Please slow down.'
      });
    }
    
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();
    
    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    // Check if match has ended - block chat
    if (match.status === 'ended' || match.finalized) {
      return res.status(403).json({
        error: true,
        code: 'MATCH_ENDED',
        message: 'Cannot send messages - match has ended'
      });
    }
    
    // Verify user is participant
    if (match.playerId !== req.user.uid && match.testerId !== req.user.uid) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'You are not a participant in this match'
      });
    }
    
    // Get user profile for username
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();
    
    // Add message to chat
    const chatRef = matchRef.child('chat');
    const newMessageRef = chatRef.push();
    await newMessageRef.set({
      userId: req.user.uid,
      username: userProfile.minecraftUsername || userProfile.email,
      text: text.trim(),
      timestamp: Date.now()
    });
    
    res.json({ success: true, messageId: newMessageRef.key });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error sending message'
    });
  }
});

/**
 * GET /api/match/:matchId/messages - Get chat messages
 */
app.get('/api/match/:matchId/messages', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();

    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    if (match.playerId !== req.user.uid && match.testerId !== req.user.uid) {
      const userRef = db.ref(`users/${req.user.uid}`);
      const userSnapshot = await userRef.once('value');
      const userProfile = userSnapshot.val() || {};
      if (!hasAdminAccess(userProfile, req.user.email)) {
        return res.status(403).json({
          error: true,
          code: 'PERMISSION_DENIED',
          message: 'Access denied'
        });
      }
    }

    const messages = Object.entries(match.chat || {})
      .map(([messageId, message]) => ({
        ...(message || {}),
        messageId
      }))
      .sort((a, b) => Number(a?.timestamp || 0) - Number(b?.timestamp || 0));

    res.json({ success: true, messages });
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching chat messages'
    });
  }
});

/**
 * DELETE /api/match/:matchId/message/:messageId - Delete chat message (tier tester only)
 */
app.delete('/api/match/:matchId/message/:messageId', verifyAuth, verifyTester, async (req, res) => {
  try {
    const { matchId, messageId } = req.params;
    
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();
    
    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }
    
    // Check if user is the tier tester for this match
    if (match.testerId !== req.user.uid) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Only the tier tester can delete messages'
      });
    }

    // Check if message exists
    const messageRef = matchRef.child(`chat/${messageId}`);
    const messageSnapshot = await messageRef.once('value');
    const message = messageSnapshot.val();

    if (!message) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Message not found'
      });
    }

    // Delete the message
    await messageRef.remove();

    res.json({ success: true, message: 'Message deleted' });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error deleting message'
    });
  }
});


/**
 * POST /api/match/:matchId/draw-vote - Vote to end match without scoring (player or tester)
 */
app.post('/api/match/:matchId/draw-vote', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { agree } = req.body;

    if (agree !== true) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'agree must be true'
      });
    }

    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();

    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    const uid = req.user.uid;

    if (match.playerId !== uid && match.testerId !== uid) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'You are not a participant in this match'
      });
    }

    if (match.finalized || match.status === 'ended') {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_FINALIZED',
        message: 'Match has already been finalized'
      });
    }

    // Record this user's vote
    await matchRef.child(`drawVotes/${uid}`).set({ agree: true });

    // Re-read to get current votes
    const updatedSnap = await matchRef.once('value');
    const updatedMatch = updatedSnap.val();
    const playerAgreed = updatedMatch.drawVotes?.[updatedMatch.playerId]?.agree === true;
    const testerAgreed = updatedMatch.drawVotes?.[updatedMatch.testerId]?.agree === true;

    // Both agreed — finalize as draw without scoring
    if (playerAgreed && testerAgreed && !updatedMatch.finalized) {
      await finalizeMatchAsDrawWithoutScoring(matchId, updatedMatch, {
        type: 'draw_vote',
        reason: 'Both participants agreed to end match without scoring.'
      });
    }

    res.json({
      success: true,
      votes: { playerAgreed, testerAgreed }
    });
  } catch (error) {
    console.error('Error submitting draw vote:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: error.message || 'Error submitting draw vote'
    });
  }
});

/**
 * POST /api/match/:matchId/finalize - Finalize match (tier tester only)
 */
app.post('/api/match/:matchId/finalize', verifyAuth, verifyTester, requireRecaptcha, async (req, res) => {
  try {
    const { matchId } = req.params;
    const { playerScore, testerScore } = req.body;

    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();

    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    if (match.testerId !== req.user.uid) { // Changed from tierTesterId
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Only the tester can finalize this match'
      });
    }

    if (match.finalized) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_FINALIZED',
        message: 'Match has already been finalized'
      });
    }

    const [playerProfile, testerProfile] = await Promise.all([
      getStoredUserProfile(match.playerId),
      getStoredUserProfile(match.testerId)
    ]);
    const testerClientIP = getClientIP(req);
    const [playerTrust, testerTrust] = await Promise.all([
      enforceTrustedTierListAccess(match.playerId, {
        profile: playerProfile,
        clientIP: Array.isArray(playerProfile?.ipAddresses) ? playerProfile.ipAddresses[0] : (playerProfile?.ipAddresses || null)
      }),
      enforceTrustedTierListAccess(match.testerId, {
        profile: testerProfile,
        clientIP: testerClientIP
      })
    ]);

    if (!playerTrust.allowed || !testerTrust.allowed) {
      return res.status(403).json({
        error: true,
        code: 'TIER_LIST_LOCKED',
        message: 'This match cannot change ratings because one of the accounts is under review or failed trust checks. An admin can whitelist the user in the admin panel if needed.'
      });
    }

    // Validate scores against this match's first-to settings.
    if (typeof playerScore !== 'number' || typeof testerScore !== 'number') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'playerScore and testerScore must be numbers'
      });
    }

    if (playerScore < 0 || testerScore < 0 || (playerScore + testerScore) < 1) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Invalid match scores'
      });
    }

    if (playerScore === testerScore) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Ties are not allowed. One player must win.'
      });
    }

    const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
    if (playerScore !== firstTo && testerScore !== firstTo) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid score for ${match.gamemode}. Winner must reach ${firstTo}.`
      });
    }

    // Handle Elo-based finalization
    const ratingChanges = await handleManualFinalization(match, { playerScore, testerScore });
    
    // Update match
    await matchRef.update({
      finalized: true,
      finalizedAt: new Date().toISOString(),
      status: 'ended',
      finalizationData: {
        type: 'elo_rating',
        playerScore: playerScore,
        testerScore: testerScore,
        ratingChanges: ratingChanges,
        playerUsername: match.playerUsername,
        gamemode: match.gamemode
      }
    });

    // Create notification for player if enabled
    await createNotification(match.playerId, {
      type: 'match_finalized',
      title: 'Match Finalized',
      message: `Your ${match.gamemode} match has been finalized. Rating: ${ratingChanges.playerNewRating} (${ratingChanges.playerRatingChange >= 0 ? '+' : ''}${ratingChanges.playerRatingChange})`,
      matchId: matchId,
      gamemode: match.gamemode
    });

    // Update player's last tested timestamp for cooldown
    const userRef = db.ref(`users/${match.playerId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};

    const lastTested = userData.lastTested || {};
    lastTested[match.gamemode] = new Date().toISOString();

    await userRef.update({
      lastTested: lastTested
    });

    // Write match metrics to Firestore for security scoring (non-blocking)
    const durationMs = match.finalizedAt
      ? new Date(match.finalizedAt).getTime() - new Date(match.createdAt).getTime()
      : new Date().getTime() - new Date(match.createdAt).getTime();
    const metricData = {
      matchId: match.matchId || matchId,
      playerId: match.playerId,
      testerId: match.testerId,
      gamemode: match.gamemode,
      durationMs,
      playerScore,
      testerScore,
      createdAt: match.createdAt,
      finalizedAt: new Date().toISOString()
    };
    fsWrite(`matchMetrics/${match.matchId || matchId}`, metricData, false).catch(() => {});

    // Recompute security scores async – never blocks the response
    computeAndStoreSecurityScore(match.playerId).catch(() => {});
    computeAndStoreSecurityScore(match.testerId).catch(() => {});

    await Promise.all([
      requeueUserAfterFinalizedMatch(match, match.playerId, 'player'),
      requeueUserAfterFinalizedMatch(match, match.testerId, 'tester')
    ]);

    res.json({
      success: true,
      message: 'Match finalized successfully',
      finalizationData: {
        type: 'elo_rating',
        playerScore: playerScore,
        testerScore: testerScore,
        ratingChanges: ratingChanges,
        playerUsername: match.playerUsername,
        gamemode: match.gamemode
      }
    });
  } catch (error) {
    console.error('Error finalizing match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: error.message || 'Error finalizing match'
    });
  }
});

/**
 * Glicko-2 Rating System Constants
 * Adjusted for more significant rating changes in competitive PvP
 */
const GLICKO2_SCALE = 173.7178;
const GLICKO2_CONVERGENCE_TOLERANCE = 0.000001;
const GLICKO2_DEFAULT_RD = 350; // Starting RD - high uncertainty for new players
const GLICKO2_MIN_RD = 100; // Minimum RD - prevents ratings from becoming too stable
const GLICKO2_DEFAULT_VOLATILITY = 0.06;
const GLICKO2_TAU = 0.5; // Increased from 0.2 - allows more volatility changes
const GLICKO2_C = 34.6; // RD increase constant (per rating period)
const GLICKO2_DEBUG = process.env.GLICKO2_DEBUG === 'true' && config.nodeEnv !== 'production';

function glickoLog(...args) {
  if (GLICKO2_DEBUG) {
    console.log(...args);
  }
}

/**
 * Convert rating from Glicko-2 scale to display scale
 * Glicko-2 uses 0 as average, we use 1000 as average
 * Glicko-2 scale: 173.7178 = 400/ln(10)
 */
function glicko2ToDisplay(rating) {
  return rating * GLICKO2_SCALE + 1000;
}

/**
 * Convert rating from display scale to Glicko-2 scale
 * Display scale: 1000 is average
 * Glicko-2 scale: 0 is average
 */
function displayToGlicko2(rating) {
  return (rating - 1000) / GLICKO2_SCALE;
}

/**
 * Update Rating Deviation (RD) based on time elapsed since last game
 * RD increases over time to reflect growing uncertainty about player skill
 * @param {number} rd - Current rating deviation
 * @param {number} timePeriods - Number of rating periods that have passed (e.g., days/100)
 * @returns {number} New rating deviation
 */
function updateRDForTimePeriods(rd, timePeriods) {
  if (timePeriods <= 0) return rd;
  
  const rdSquared = Math.pow(rd, 2);
  const cSquared = Math.pow(GLICKO2_C, 2);
  
  // RD = min(sqrt(RD0^2 + c^2 * t), 350)
  const newRD = Math.sqrt(rdSquared + cSquared * timePeriods);
  
  return Math.min(newRD, GLICKO2_DEFAULT_RD);
}

/**
 * Calculate rating changes using proper Glicko-2 algorithm
 * Based on Mark Glickman's paper: http://www.glicko.net/glicko/glicko2.pdf
 * 
 * This implementation follows the complete Glicko-2 algorithm:
 * - Step 1: Compute ancillary quantities (v and Δ)
 * - Step 2: Determine new rating volatility using Illinois algorithm
 * - Step 3: Determine new ratings deviation
 * - Step 4: Determine new rating
 * 
 * @param {Object} player - Player object with rating, rd, and volatility
 * @param {Object} opponent - Opponent object with rating, rd, and volatility
 * @param {number} score - Match outcome (1 = win, 0 = loss, 0.5 = draw)
 * @returns {Object} Object containing ratingChange, newRating, newRD, and newVolatility
 */
function calculateGlicko2Change(player, opponent, score) {
  glickoLog(`[GLICKO2] Input - Player rating: ${player.rating}, RD: ${player.rd}, Opponent rating: ${opponent.rating}, RD: ${opponent.rd}, Score: ${score}`);
  
  // Convert from display scale (1500) to Glicko-2 scale (0)
  const mu = displayToGlicko2(player.rating);
  const muJ = displayToGlicko2(opponent.rating);
  
  glickoLog(`[GLICKO2] Converted - mu: ${mu}, muJ: ${muJ}`);
  
  // Convert RD from display scale to Glicko-2 scale
  const phi = (player.rd || GLICKO2_DEFAULT_RD) / GLICKO2_SCALE;
  const phiJ = (opponent.rd || GLICKO2_DEFAULT_RD) / GLICKO2_SCALE;
  
  const sigma = player.volatility || GLICKO2_DEFAULT_VOLATILITY;

  glickoLog(`[GLICKO2] phi: ${phi}, phiJ: ${phiJ}, sigma: ${sigma}`);

  // Step 1: Compute ancillary quantities v and Δ
  const gPhiJ = 1 / Math.sqrt(1 + 3 * Math.pow(phiJ, 2) / Math.pow(Math.PI, 2));
  const E = 1 / (1 + Math.exp(-gPhiJ * (mu - muJ)));
  
  glickoLog(`[GLICKO2] gPhiJ: ${gPhiJ}, Expected score (E): ${E}`);
  
  const v = 1 / (Math.pow(gPhiJ, 2) * E * (1 - E));
  const delta = v * gPhiJ * (score - E);
  
  glickoLog(`[GLICKO2] v: ${v}, delta: ${delta}`);

  // Step 2: Determine new rating volatility using Illinois algorithm
  const a = Math.log(Math.pow(sigma, 2));
  const tau = GLICKO2_TAU;
  
  const f = (x) => {
    const eX = Math.exp(x);
    const phiSq = Math.pow(phi, 2);
    const deltaSq = Math.pow(delta, 2);
    
    const numerator = eX * (deltaSq - phiSq - v - eX);
    const denominator = 2 * Math.pow(phiSq + v + eX, 2);
    const tauTerm = (x - a) / Math.pow(tau, 2);
    
    return numerator / denominator - tauTerm;
  };
  
  // Illinois algorithm to find A such that f(A) = 0
  let A = a;
  let B;
  
  // Find initial B
  const deltaSq = Math.pow(delta, 2);
  const phiSq = Math.pow(phi, 2);

  if (deltaSq > phiSq + v) {
    B = Math.log(deltaSq - phiSq - v);
    } else {
    let k = 1;
    while (f(a - k * tau) < 0) {
      k++;
    }
    B = a - k * tau;
    }

  let fA = f(A);
  let fB = f(B);
  
  // Iteratively narrow down the interval
  while (Math.abs(B - A) > GLICKO2_CONVERGENCE_TOLERANCE) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = f(C);
    
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    
    B = C;
    fB = fC;
  }

  const sigmaPrime = Math.exp(A / 2);

  // Step 3: Determine new ratings deviation
  const phiStar = Math.sqrt(Math.pow(phi, 2) + Math.pow(sigmaPrime, 2));
  const phiPrime = 1 / Math.sqrt(1 / Math.pow(phiStar, 2) + 1 / v);
  
  // Step 4: Determine new rating
  const muPrime = mu + Math.pow(phiPrime, 2) * gPhiJ * (score - E);

  // Convert back to display scale
  const newRating = glicko2ToDisplay(muPrime);
  let newRD = phiPrime * GLICKO2_SCALE;
  
  glickoLog(`[GLICKO2] muPrime: ${muPrime}, newRating (before round): ${newRating}`);
  
  // Enforce minimum RD to prevent ratings from becoming too stable
  // This ensures rating changes remain significant even for experienced players
  newRD = Math.max(newRD, GLICKO2_MIN_RD);
  
  const newVolatility = sigmaPrime;

  // Calculate rating change
  const ratingChange = newRating - player.rating;
  
  glickoLog(`[GLICKO2] Rating change (before round): ${ratingChange}, newRD: ${newRD}`);

  const result = {
    ratingChange: Math.round(ratingChange),
    newRating: Math.round(newRating),
    newRD: Math.round(newRD),
    newVolatility: newVolatility
  };
  
  glickoLog('[GLICKO2] Final result:', result);

  return result;
}

/**
 * Handle player join timeout (tester joined, waiting for player)
 */
async function handlePlayerJoinTimeout(matchId) {
  try {
    const matchRef = db.ref(`matches/${matchId}`);
    const matchSnapshot = await matchRef.once('value');
    const match = matchSnapshot.val();

    if (!match || match.status !== 'active' || match.finalized) {
      return; // Match already handled or doesn't exist
    }

    // Check if player has joined
    const playerJoined = match.pagestats?.playerJoined || false;

    if (!playerJoined) {
      const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
      console.log(`Match ${matchId}: Player did not join within 3 minutes after tester joined, auto-finalizing with tester win (0-${firstTo})`);

      // Report the player for not showing up
      if (match.playerId) {
        const reportsRef = db.ref('reports');
        await reportsRef.push({
          reportedUserId: match.playerId,
          reportedByUserId: match.testerId,
          reason: 'Did not join match within 3 minutes after tester was ready',
          matchId: matchId,
          timestamp: new Date().toISOString(),
          type: 'no_show'
        });
        console.log(`Reported player ${match.playerId} for not showing up in match ${matchId}`);
      }

      await handleManualFinalization(match, { playerScore: 0, testerScore: firstTo });
      await matchRef.update({
        status: 'ended',
        finalized: true,
        finalizedAt: new Date().toISOString(),
        result: { playerScore: 0, testerScore: firstTo },
        reason: 'Player did not join within 3 minutes'
      });

      // Update player's last tested timestamp for cooldown
      const userRef = db.ref(`users/${match.playerId}`);
      const userSnapshot = await userRef.once('value');
      const userData = userSnapshot.val() || {};

      const lastTested = userData.lastTested || {};
      lastTested[match.gamemode] = new Date().toISOString();

      await userRef.update({
        lastTested: lastTested
      });

      await Promise.all([
        requeueUserAfterFinalizedMatch(match, match.playerId, 'player'),
        requeueUserAfterFinalizedMatch(match, match.testerId, 'tester')
      ]);
    } else {
      // Player did join, no action needed
      console.log('Match', matchId, ': Player joined in time, no timeout action needed');
    }
  } catch (error) {
    console.error('Error handling player join timeout for match', matchId, ':', error);
  }
}

/**
 * FIX #2: Check for matches that missed their timeout due to server restart
 * This function runs on server startup and periodically to catch any matches
 * that should have timed out but didn't due to server downtime
 */
async function checkMissedTimeouts() {
  try {
    const matchesRef = db.ref('matches');
    const snapshot = await matchesRef
      .orderByChild('status')
      .equalTo('active')
      .once('value');
    
    const matches = snapshot.val() || {};
    const now = Date.now();
    let handledCount = 0;
    
    for (const matchId in matches) {
      const match = matches[matchId];

      if (!match.finalized && !match.matchStarted && match.countdownStartedAt) {
        const countdownExpiresAt = new Date(match.countdownStartedAt).getTime() + MATCH_START_TIMEOUT_MS;
        if (!Number.isNaN(countdownExpiresAt) && now > countdownExpiresAt) {
          console.log(`⏰ Found expired match start countdown ${matchId} (expired ${Math.round((now - countdownExpiresAt) / 1000)}s ago)`);
          await handleMatchStartCountdownTimeout(matchId);
          handledCount++;
          continue;
        }
      }
      
      // Skip if already finalized or join timeout already handled
      if (match.finalized || match.timeoutHandled) continue;
      
      // Check if match has expired
      if (match.joinTimeout?.expiresAt) {
        const expiresAt = new Date(match.joinTimeout.expiresAt).getTime();
        
        if (now > expiresAt) {
          console.log(`⏰ Found expired match ${matchId} (expired ${Math.round((now - expiresAt) / 1000)}s ago)`);
          
          // handleMatchInactivity sets timeoutHandled internally — do NOT set it here
          // or the re-read inside handleMatchInactivity will skip the match.
          await handleMatchInactivity(matchId);
          handledCount++;
        }
      }
    }
    
    if (handledCount > 0) {
      console.log(`✅ Processed ${handledCount} expired match(es)`);
    }
  } catch (error) {
    console.error('❌ Error checking missed timeouts:', error);
  }
}

/**
 * Handle inactivity timeouts for matches
 * Called 3 minutes after match creation to check if both players have joined
 * Uses the EXACT same finalization logic as the manual finalize endpoint
 */
async function handleMatchInactivity(matchId) {
  try {
    const matchRef = db.ref(`matches/${matchId}`);
    const matchSnapshot = await matchRef.once('value');
    const match = matchSnapshot.val();

    if (!match || match.status !== 'active' || match.finalized || match.timeoutHandled) {
      console.log(`Match ${matchId}: Already handled or doesn't exist, skipping inactivity check`);
      return; // Match already handled or doesn't exist
    }
    
    // FIX #2: Mark timeout as handled to prevent duplicate processing
    await matchRef.update({ timeoutHandled: true });

    const playerJoined = match.pagestats?.playerJoined || false;
    const testerJoined = match.pagestats?.testerJoined || false;

    console.log(`Match ${matchId} inactivity check: Player joined: ${playerJoined}, Tester joined: ${testerJoined}`);

    // Case 1: Neither player joined - cancel match (no finalization, no rating changes)
    // Match will be cleaned up after 2 weeks by the scheduled cleanup
    if (!playerJoined && !testerJoined) {
      console.log(`Match ${matchId}: Neither player joined within 3 minutes, cancelling match`);
      await matchRef.update({
        status: 'cancelled',
        finalized: true,
        finalizedAt: new Date().toISOString(),
        reason: 'Neither player joined within 3 minutes',
        deletedDueToInactivity: true,
        scheduledDeleteAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString()
      });
      return;
    }

    // Case 2: Tester joined but player didn't
    // Use EXACT same logic as POST /api/match/:matchId/finalize
    if (testerJoined && !playerJoined) {
      const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
      console.log(`Match ${matchId}: Player did not join within 3 minutes, auto-finalizing with tester win (0-${firstTo})`);
      
      // Report the player for not showing up
      if (match.playerId) {
        const reportsRef = db.ref('reports');
        await reportsRef.push({
          reportedUserId: match.playerId,
          reportedByUserId: match.testerId,
          reason: 'Did not join match within 3 minutes',
          matchId: matchId,
          timestamp: new Date().toISOString(),
          type: 'no_show'
        });
        console.log(`Reported player ${match.playerId} for not showing up in match ${matchId}`);
      }

      // Use EXACT finalization logic from the manual endpoint
      const playerScore = 0;
      const testerScore = firstTo;
      
      // Handle Elo-based finalization (same as manual finalize endpoint)
      const ratingChanges = await handleManualFinalization(match, { playerScore, testerScore });
      
      // Update match (same as manual finalize endpoint)
      await matchRef.update({
        finalized: true,
        finalizedAt: new Date().toISOString(),
        status: 'ended',
        finalizationData: {
          type: 'elo_rating',
          playerScore: playerScore,
          testerScore: testerScore,
          ratingChanges: ratingChanges,
          playerUsername: match.playerUsername,
          gamemode: match.gamemode,
          autoFinalized: true,
          reason: 'Player did not join within 3 minutes'
        }
      });

      // Create notification for player (same as manual finalize endpoint)
      await createNotification(match.playerId, {
        type: 'match_finalized',
        title: 'Match Auto-Finalized',
        message: `Your ${match.gamemode} match was auto-finalized (you didn't join). Rating: ${ratingChanges.playerNewRating} (${ratingChanges.playerRatingChange >= 0 ? '+' : ''}${ratingChanges.playerRatingChange})`,
        matchId: matchId,
        gamemode: match.gamemode
      });

      // Update player's last tested timestamp for cooldown (same as manual finalize endpoint)
      const userRef = db.ref(`users/${match.playerId}`);
      const userSnapshot = await userRef.once('value');
      const userData = userSnapshot.val() || {};

      const lastTested = userData.lastTested || {};
      lastTested[match.gamemode] = new Date().toISOString();

      await userRef.update({
        lastTested: lastTested
      });

      await Promise.all([
        requeueUserAfterFinalizedMatch(match, match.playerId, 'player'),
        requeueUserAfterFinalizedMatch(match, match.testerId, 'tester')
      ]);

      console.log(`Match ${matchId}: Auto-finalized with tester win (0-${firstTo}), rating changes applied`);
      return;
    }

    // Case 3: Player joined but tester didn't
    // Use EXACT same logic as POST /api/match/:matchId/finalize
    if (playerJoined && !testerJoined) {
      const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
      console.log(`Match ${matchId}: Tester did not join within 3 minutes, auto-finalizing with player win (${firstTo}-0)`);
      
      // Use EXACT finalization logic from the manual endpoint
      const playerScore = firstTo;
      const testerScore = 0;
      
      // Handle Elo-based finalization (same as manual finalize endpoint)
      const ratingChanges = await handleManualFinalization(match, { playerScore, testerScore });
      
      // Update match (same as manual finalize endpoint)
      await matchRef.update({
        finalized: true,
        finalizedAt: new Date().toISOString(),
        status: 'ended',
        finalizationData: {
          type: 'elo_rating',
          playerScore: playerScore,
          testerScore: testerScore,
          ratingChanges: ratingChanges,
          playerUsername: match.playerUsername,
          gamemode: match.gamemode,
          autoFinalized: true,
          reason: 'Tester did not join within 3 minutes'
        }
      });

      // Create notification for player (same as manual finalize endpoint)
      await createNotification(match.playerId, {
        type: 'match_finalized',
        title: 'Match Auto-Finalized',
        message: `Your ${match.gamemode} match was auto-finalized (tester didn't join). Rating: ${ratingChanges.playerNewRating} (${ratingChanges.playerRatingChange >= 0 ? '+' : ''}${ratingChanges.playerRatingChange})`,
        matchId: matchId,
        gamemode: match.gamemode
      });

      // Update player's last tested timestamp for cooldown (same as manual finalize endpoint)
      const userRef = db.ref(`users/${match.playerId}`);
      const userSnapshot = await userRef.once('value');
      const userData = userSnapshot.val() || {};

      const lastTested = userData.lastTested || {};
      lastTested[match.gamemode] = new Date().toISOString();

      await userRef.update({
        lastTested: lastTested
      });

      console.log(`Match ${matchId}: Auto-finalized with player win (${firstTo}-0), rating changes applied`);
      return;
    }

    // Case 4: Both players joined - match is active, no action needed
    console.log(`Match ${matchId}: Both players have joined, match is active`);
  } catch (error) {
    console.error(`Error handling inactivity for match ${matchId}:`, error);
  }
}

/**
 * Centralized rating update function that handles both user and player records
 */
async function updatePlayerRating(userId, gamemode, ratingChange, newRating, newRD, newVolatility) {
  try {
    // Update player record only (not user profile)
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('userId').equalTo(userId).once('value');
    const players = playerSnapshot.val() || {};
    const playerId = Object.keys(players).find(key => players[key].userId === userId);

    if (playerId) {
  const playerRef = playersRef.child(playerId);
      const player = players[playerId];

      // Update gamemode rating
      const gamemodeRatings = player.gamemodeRatings || {};
      gamemodeRatings[gamemode] = newRating;

      // Update peak ratings
      const peakRatings = player.peakRatings || {};
      if (!peakRatings[gamemode] || newRating > peakRatings[gamemode]) {
        peakRatings[gamemode] = newRating;
      }

      // Update Glicko-2 parameters
      const glicko2Params = player.glicko2Params || {};
      glicko2Params[gamemode] = {
        rd: newRD,
        volatility: newVolatility
      };

      // Recalculate overall rating
      const overallRating = calculateOverallRating(gamemodeRatings);

      // Increment match count
      const gamemodeMatchCount = player.gamemodeMatchCount || {};
      gamemodeMatchCount[gamemode] = (gamemodeMatchCount[gamemode] || 0) + 1;

      await playerRef.update({
        gamemodeRatings,
        peakRatings,
        glicko2Params,
        overallRating,
        gamemodeMatchCount,
        [`lastTested/${gamemode}`]: new Date().toISOString()
      });
    }

  } catch (error) {
    console.error('Error updating player rating:', error);
    throw error;
  }
}

async function storeQueueCooldownTimestamps(userId, gamemode, timestamp = new Date().toISOString()) {
  if (!userId || !gamemode) return;

  const userRef = db.ref(`users/${userId}`);
  const userSnapshot = await userRef.once('value');
  const userProfile = userSnapshot.val() || {};
  const lastQueueJoins = userProfile.lastQueueJoins || {};
  const lastTestCompletions = userProfile.lastTestCompletions || {};

  lastQueueJoins[gamemode] = timestamp;
  lastTestCompletions[gamemode] = timestamp;

  await userRef.update({ lastQueueJoins, lastTestCompletions });
}

/**
 * Handle match finalization with Glicko-2 calculations
 */
async function handleManualFinalization(match, result) {
  // result format: { playerScore: number, testerScore: number }
  const playerScore = result.playerScore;
  const testerScore = result.testerScore;
  const playerWon = playerScore > testerScore;

  console.log(`[FINALIZATION] Match ${match.matchId}: Player ${playerScore} - ${testerScore} Tester`);

  // Convert scores to Glicko-2 compatible scores (0, 0.5, or 1)
  let playerGlicko2Score;
  if (playerScore > testerScore) {
    playerGlicko2Score = 1; // Win
  } else if (playerScore < testerScore) {
    playerGlicko2Score = 0; // Loss
  } else {
    // This should never happen with proper validation
    console.warn(`[FINALIZATION] WARNING: Tie detected in match ${match.matchId}! Score: ${playerScore}-${testerScore}`);
    playerGlicko2Score = 0.5; // Draw
  }

  // Get current player data
  const playersRef = db.ref('players');
  const playerSnapshot = await playersRef.orderByChild('userId').equalTo(match.playerId).once('value');
  const testerSnapshot = await playersRef.orderByChild('userId').equalTo(match.testerId).once('value');

  const players = playerSnapshot.val() || {};
  const testers = testerSnapshot.val() || {};

  const playerData = Object.values(players).find(p => p.userId === match.playerId) || {
    gamemodeRatings: {},
    glicko2Params: {}
  };
  const testerData = Object.values(testers).find(p => p.userId === match.testerId) || {
    gamemodeRatings: {},
    glicko2Params: {}
  };

  // Get current ratings and Glicko-2 parameters
  const playerRating = playerData.gamemodeRatings?.[match.gamemode] || 1000;
  const testerRating = testerData.gamemodeRatings?.[match.gamemode] || 1000;

  const playerRD = playerData.glicko2Params?.[match.gamemode]?.rd || GLICKO2_DEFAULT_RD;
  const testerRD = testerData.glicko2Params?.[match.gamemode]?.rd || GLICKO2_DEFAULT_RD;

  const playerVolatility = playerData.glicko2Params?.[match.gamemode]?.volatility || GLICKO2_DEFAULT_VOLATILITY;
  const testerVolatility = testerData.glicko2Params?.[match.gamemode]?.volatility || GLICKO2_DEFAULT_VOLATILITY;

  // Update RD based on time since last match (Step 1 of Glicko-2 algorithm)
  // Calculate rating periods elapsed (assume 1 day = 1 rating period / 100)
  const now = Date.now();
  const playerLastTested = playerData.lastTested?.[match.gamemode] 
    ? new Date(playerData.lastTested[match.gamemode]).getTime() 
    : now - (100 * 24 * 60 * 60 * 1000); // Default to 100 days ago if never tested
  const testerLastTested = testerData.lastTested?.[match.gamemode] 
    ? new Date(testerData.lastTested[match.gamemode]).getTime() 
    : now - (100 * 24 * 60 * 60 * 1000);
  
  const playerTimePeriods = (now - playerLastTested) / (24 * 60 * 60 * 1000) / 100; // Days / 100
  const testerTimePeriods = (now - testerLastTested) / (24 * 60 * 60 * 1000) / 100;
  
  const playerRDUpdated = updateRDForTimePeriods(playerRD, playerTimePeriods);
  const testerRDUpdated = updateRDForTimePeriods(testerRD, testerTimePeriods);

  // Create player and opponent objects for Glicko-2 calculation
  const playerObj = { rating: playerRating, rd: playerRDUpdated, volatility: playerVolatility };
  const testerObj = { rating: testerRating, rd: testerRDUpdated, volatility: testerVolatility };

  // Calculate Glicko-2 rating changes
  const playerResult = calculateGlicko2Change(playerObj, testerObj, playerGlicko2Score);
  const testerResult = calculateGlicko2Change(testerObj, playerObj, 1 - playerGlicko2Score);

  console.log(`[FINALIZATION] Player: ${playerRating} → ${playerResult.newRating} (${playerResult.ratingChange >= 0 ? '+' : ''}${playerResult.ratingChange})`);
  console.log(`[FINALIZATION] Tester: ${testerRating} → ${testerResult.newRating} (${testerResult.ratingChange >= 0 ? '+' : ''}${testerResult.ratingChange})`);
  console.log(`[FINALIZATION] Player RD: ${playerRDUpdated}, Tester RD: ${testerRDUpdated}`);

  // Check for zero rating changes (shouldn't happen unless it's a draw)
  if (playerResult.ratingChange === 0 && testerResult.ratingChange === 0) {
    console.error('[FINALIZATION] ERROR: Both players got 0 rating change! Match', match.matchId);
    console.error('[FINALIZATION] Player:', playerRating, 'RD:', playerRDUpdated, 'Tester:', testerRating, 'RD:', testerRDUpdated);
    console.error('[FINALIZATION] Score:', playerScore + '-' + testerScore, 'Glicko2Score:', playerGlicko2Score);
  }

  // Get title changes
  const playerOldTitle = getAchievementTitle(match.gamemode, playerRating);
  const playerNewTitle = getAchievementTitle(match.gamemode, playerResult.newRating);
  const testerOldTitle = getAchievementTitle(match.gamemode, testerRating);
  const testerNewTitle = getAchievementTitle(match.gamemode, testerResult.newRating);

  const playerTitleChanged = playerOldTitle.title !== playerNewTitle.title;
  const testerTitleChanged = testerOldTitle.title !== testerNewTitle.title;

  // Check for rating manipulation before updating (ToS Section 5)
  const manipulationCheck = await detectRatingManipulation(match.playerId, match.gamemode, result);
  if (manipulationCheck.suspicious && manipulationCheck.severity === 'high') {
    console.warn('[SECURITY] Rating manipulation detected for user', match.playerId, ':', manipulationCheck.patterns);
    // Check and flag account if needed
    await checkAndFlagSuspiciousAccount(match.playerId);
  }

  // Check for match rigging (ToS Section 4)
  const riggingCheck = await detectMatchRigging(match, result);
  if (riggingCheck.suspicious && riggingCheck.severity === 'high') {
    console.warn('[SECURITY] Match rigging detected for match', match.matchId, ':', riggingCheck.patterns);
    // Flag both accounts for review
    await checkAndFlagSuspiciousAccount(match.playerId);
    await checkAndFlagSuspiciousAccount(match.testerId);
  }

  // Check for account anomalies
  const playerAnomalies = await detectAccountAnomalies(match.playerId);
  const testerAnomalies = await detectAccountAnomalies(match.testerId);
  
  if (playerAnomalies.suspicious && playerAnomalies.severity === 'high') {
    console.warn('[SECURITY] Account anomalies detected for player', match.playerId, ':', playerAnomalies.anomalies);
    await checkAndFlagSuspiciousAccount(match.playerId);
  }
  
  if (testerAnomalies.suspicious && testerAnomalies.severity === 'high') {
    console.warn('[SECURITY] Account anomalies detected for tester', match.testerId, ':', testerAnomalies.anomalies);
    await checkAndFlagSuspiciousAccount(match.testerId);
  }

  // Update ratings using centralized function
  await updatePlayerRating(match.playerId, match.gamemode, playerResult.ratingChange, playerResult.newRating, playerResult.newRD, playerResult.newVolatility);
  await updatePlayerRating(match.testerId, match.gamemode, testerResult.ratingChange, testerResult.newRating, testerResult.newRD, testerResult.newVolatility);
  await storeQueueCooldownTimestamps(match.playerId, match.gamemode);

  // Return rating changes and title changes for API response
  return {
    playerRatingChange: playerResult.ratingChange,
    testerRatingChange: testerResult.ratingChange,
    playerNewRating: playerResult.newRating,
    testerNewRating: testerResult.newRating,
    titleChanges: {
      player: playerTitleChanged ? { oldTitle: playerOldTitle, newTitle: playerNewTitle } : null,
      tester: testerTitleChanged ? { oldTitle: testerOldTitle, newTitle: testerNewTitle } : null
    }
  };
}

/**
 * Profanity filter - cached word list
 */
let profanityWordList = null;
let profanityListLastFetch = 0;
const PROFANITY_CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch profanity word list from API
 */
async function fetchProfanityList() {
  return new Promise((resolve, reject) => {
    https.get('https://api.dedolist.com/api/v1/language/profane-words-english/', (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          const words = JSON.parse(data);
          resolve(words);
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Get profanity word list (with caching)
 */
async function getProfanityList() {
  const now = Date.now();
  
  // Return cached list if still valid
  if (profanityWordList && (now - profanityListLastFetch) < PROFANITY_CACHE_DURATION) {
    return profanityWordList;
  }
  
  try {
    // Fetch fresh list
    profanityWordList = await fetchProfanityList();
    profanityListLastFetch = now;
    console.log(`Loaded ${profanityWordList.length} profanity words from API`);
    return profanityWordList;
  } catch (error) {
    console.error('Error fetching profanity list:', error);
    // Return cached list if available, even if expired
    if (profanityWordList) {
      console.log('Using expired profanity cache due to fetch error');
      return profanityWordList;
    }
    // If API is unavailable and no cache, throw error (fail-closed)
    throw new Error('Profanity filter API is unavailable and no cached data exists');
  }
}

/**
 * Check if text contains profanity
 * Checks each word individually for exact matches only
 */
async function containsProfanity(text) {
  if (!text || typeof text !== 'string') {
    return false;
  }
  
  let wordList;
  try {
    wordList = await getProfanityList();
  } catch (error) {
    // If API is unavailable, fail-closed (block the message)
    console.error('[PROFANITY FILTER] API unavailable:', error.message);
    throw new Error('Content filtering is temporarily unavailable. Please try again later.');
  }
  
  // Validate wordList is an array
  if (!Array.isArray(wordList)) {
    console.error('[PROFANITY FILTER] Invalid word list format, expected array, got:', typeof wordList);
    throw new Error('Content filtering is temporarily unavailable. Please try again later.');
  }
  
  if (wordList.length === 0) {
    // If list is empty, fail-closed
    console.error('[PROFANITY FILTER] Word list is empty');
    throw new Error('Content filtering is temporarily unavailable. Please try again later.');
  }
  
  // Normalize text and split into individual words
  // Split by whitespace and punctuation, keeping only alphanumeric characters
  const messageWords = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ') // Replace punctuation with spaces
    .split(/\s+/) // Split by whitespace
    .filter(word => word.length > 0); // Remove empty strings
  
  // Normalize the message text for phrase matching
  const normalizedMessage = text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // Process profanity list: separate single words from phrases
  const singleWordProfanity = new Set();
  const phraseProfanity = [];
  
  for (const entry of wordList) {
    if (typeof entry === 'string' && entry.trim()) {
      // Normalize profanity entry: lowercase and remove punctuation
      const normalizedEntry = entry.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      
      if (!normalizedEntry) continue;
      
      // Check if it's a single word or a phrase
      const words = normalizedEntry.split(/\s+/).filter(w => w.length > 0);
      
      if (words.length === 1) {
        // Single word profanity - add to set for exact matching
        singleWordProfanity.add(words[0]);
      } else {
        // Multi-word phrase - store the entire phrase
        phraseProfanity.push(normalizedEntry);
      }
    }
  }
  
  // Check each word in the message against single-word profanity
  for (const messageWord of messageWords) {
    if (singleWordProfanity.has(messageWord)) {
      console.log(`[PROFANITY FILTER] Match detected: word="${messageWord}" in message="${text}"`);
      return true; // Exact match found
    }
  }
  
  // Check if any profanity phrase appears in the message
  for (const phrase of phraseProfanity) {
    if (normalizedMessage.includes(phrase)) {
      console.log(`[PROFANITY FILTER] Phrase match detected: phrase="${phrase}" in message="${text}"`);
      return true; // Phrase match found
    }
  }
  
  return false; // No matches found
}

/**
 * Create a notification for a user
 */
async function createNotification(userId, notificationData) {
  // Route to inbox system
  return sendInboxMessage(userId, {
    title: notificationData.title || 'Notification',
    message: notificationData.message || '',
    type: notificationData.type || 'system',
    from: 'System',
    metadata: notificationData
  });
}

// Re-queue user into the same gamemode/region after finalization when they opted in.
async function requeueUserAfterFinalizedMatch(match, userId, role = 'player') {
  try {
    if (!match || !userId) return;

    const userSnap = await db.ref(`users/${userId}`).once('value');
    const userProfile = userSnap.val() || {};
    if (userProfile.stayInQueueAfterMatch !== true) return;

    // Never queue or set availability if this user is already in an active match.
    const activeSnap = await db.ref('matches').orderByChild('status').equalTo('active').once('value');
    const activeMatches = activeSnap.val() || {};
    const hasActive = Object.values(activeMatches).some((m) => !m?.finalized && (m.playerId === userId || m.testerId === userId));
    if (hasActive) return;

    const queueRef = db.ref('queue');
    await clearUserQueueEntries(userId);

    const isTesterLike = !!(userProfile.tester === true || userProfile.admin === true || userProfile.adminRole);
    const queueSelections = role === 'tester'
      ? (match.testerQueueSelections || {})
      : (match.playerQueueSelections || {});
    const selectedGamemodes = Array.isArray(queueSelections.gamemodes) && queueSelections.gamemodes.length > 0
      ? queueSelections.gamemodes.filter(Boolean)
      : (match.gamemode ? [match.gamemode] : []);
    const selectedRegions = Array.isArray(queueSelections.regions) && queueSelections.regions.length > 0
      ? queueSelections.regions.filter(Boolean)
      : (match.region ? [match.region] : []);
    if (!selectedGamemodes.length || !selectedRegions.length) return;

    if (!match.serverIP) return;

    if (!isTesterLike) {
      const blockedGamemode = selectedGamemodes.find((gamemode) => !getQueueCooldownState(userProfile, gamemode).allowed);
      if (blockedGamemode) return;
    }

    const playersSnap = await db.ref('players').orderByChild('userId').equalTo(userId).limitToFirst(1).once('value');
    const playerObj = playersSnap.val() || {};
    const playerData = Object.values(playerObj)[0] || null;
    const username = playerData?.username || userProfile.minecraftUsername;
    if (!username) return;

    const newQueueRef = queueRef.push();
    await newQueueRef.set(buildQueueEntry({
      queueId: newQueueRef.key,
      userId,
      minecraftUsername: username,
      gamemodes: selectedGamemodes,
      regions: selectedRegions,
      serverIP: match.serverIP,
      rolePreference: role === 'tester' ? 'tester' : 'player',
      testerEligible: isTesterLike,
      source: role === 'tester' ? 'tester_dashboard' : 'match_requeue',
      timeoutAt: role === 'tester' ? new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString() : null
    }));
  } catch (error) {
    console.error('Error re-queueing user after finalized match:', error);
  }
}

/**
 * Calculate overall rating as average of gamemode ratings
 */
function calculateOverallRating(gamemodeRatings) {
  const ratings = Object.values(gamemodeRatings);
  if (ratings.length === 0) return 1000;
  return Math.round(ratings.reduce((sum, rating) => sum + rating, 0) / ratings.length);
}

/**
 * Get achievement title for a gamemode and rating
 */
function getAchievementTitle(gamemode, rating) {
  const titles = CONFIG.TITLES;
  if (!titles) return { title: 'Unknown', color: '#8B8B8B' };

  // Find the highest title the player qualifies for
  for (let i = titles.length - 1; i >= 0; i--) {
    if (rating >= titles[i].minRating) {
      return titles[i];
    }
  }

  // Fallback to first title
  return titles[0] || { title: 'Unknown', color: '#8B8B8B' };
}

/**
 * POST /api/match/:matchId/abort - Abort match
 */
app.post('/api/match/:matchId/abort', verifyAuth, async (req, res) => {
  try {
    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();
    
    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }
    
    // Verify user is participant
    if (match.playerId !== req.user.uid && match.testerId !== req.user.uid) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'You are not a participant in this match'
      });
    }

    // Check if match is still in waiting phase (neither player has joined)
    const pagestats = match.pagestats || {};
    const neitherHasJoined = !pagestats.playerJoined && !pagestats.testerJoined;

    let ratingChanges = null;
    let finalizationData;

    if (neitherHasJoined) {
      // No one has joined yet - abort with no penalties
      finalizationData = {
        type: 'aborted_early',
        playerScore: 0,
        testerScore: 0,
        ratingChanges: null,
        abortedBy: match.playerId === req.user.uid ? 'player' : 'tester',
        reason: 'Match aborted before players joined - no penalties applied'
      };
    } else {
      // Someone has joined - apply normal abort penalties
      const isPlayerAborting = match.playerId === req.user.uid;
      const playerScore = isPlayerAborting ? 0 : 3;
      const testerScore = isPlayerAborting ? 3 : 0;

      // Finalize the match with scores
      ratingChanges = await handleManualFinalization(match, { playerScore, testerScore });

      finalizationData = {
        type: 'forfeit',
        playerScore: playerScore,
        testerScore: testerScore,
        ratingChanges: ratingChanges,
        abortedBy: isPlayerAborting ? 'player' : 'tester',
        reason: `${isPlayerAborting ? 'Player' : 'Tester'} aborted the match`
      };
    }
    
    await matchRef.update({
      status: 'ended',
      aborted: true,
      abortedAt: new Date().toISOString(),
      finalized: true,
      finalizedAt: new Date().toISOString(),
      finalizationData: finalizationData
    });

    // If no penalties were applied, don't update last tested timestamp
    if (!neitherHasJoined) {
      // Update player's last tested timestamp for cooldown (only if penalties applied)
      const userRef = db.ref(`users/${match.playerId}`);
      const userSnapshot = await userRef.once('value');
      const userData = userSnapshot.val() || {};

      const lastTested = userData.lastTested || {};
      lastTested[match.gamemode] = new Date().toISOString();

      await userRef.update({
        lastTested: lastTested
      });
    }
    
    res.json({ success: true, message: 'Match aborted' });
  } catch (error) {
    console.error('Error aborting match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error aborting match'
    });
  }
});

function createDisputeHistoryEntry({ type, actorId, actorRole, note = '', metadata = {} }) {
  return {
    type,
    actorId: actorId || null,
    actorRole: actorRole || 'system',
    note: String(note || '').trim(),
    metadata: metadata || {},
    timestamp: new Date().toISOString()
  };
}

app.post('/api/match/:matchId/disputes', verifyAuthAndNotBanned, requireRecaptcha, async (_req, res) => {
  return res.status(410).json({
    error: true,
    code: 'MATCH_DISPUTES_REMOVED',
    message: 'Match disputes were removed. Use Support to report a player or submit a broader issue instead.'
  });
});

app.get('/api/match/:matchId/disputes', verifyAuth, async (_req, res) => {
  return res.status(410).json({
    error: true,
    code: 'MATCH_DISPUTES_REMOVED',
    message: 'Match disputes were removed. Use Support to report a player or submit a broader issue instead.'
  });
});

// ===== Skill Level Management Routes =====

/**
 * POST /api/account/update-skill-levels - Update individual gamemode skill levels (with locking protection)
 */
app.post('/api/account/update-skill-levels', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const { gamemodeRatings: newRatings } = req.body;

    if (!newRatings || typeof newRatings !== 'object') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Invalid gamemode ratings'
      });
    }

    // Get current user profile
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val() || {};

    if (!userProfile.minecraftUsername) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Minecraft username not linked'
      });
    }

    // Get player record
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('username').equalTo(userProfile.minecraftUsername).once('value');
    
    if (!playerSnapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'PLAYER_NOT_FOUND',
        message: 'Player record not found'
      });
    }

    const players = playerSnapshot.val();
    const playerId = Object.keys(players)[0];
    const playerData = players[playerId];

    // Check for locked skill levels (already set ratings cannot be changed)
    const existingRatings = playerData.gamemodeRatings || {};
    const lockedGamemodes = Object.keys(newRatings).filter(gamemode =>
      existingRatings[gamemode] !== undefined && existingRatings[gamemode] !== newRatings[gamemode]
    );

    if (lockedGamemodes.length > 0) {
      return res.status(400).json({
        error: true,
        code: 'SKILL_LEVEL_LOCKED',
        message: `Skill levels for the following gamemodes are already locked: ${lockedGamemodes.join(', ')}`
      });
    }

    // Validate new ratings
    for (const [gamemode, rating] of Object.entries(newRatings)) {
      if (typeof rating !== 'number' || rating < 300 || rating > 1300) {
        return res.status(400).json({
          error: true,
          code: 'VALIDATION_ERROR',
          message: `Invalid rating for ${gamemode}: must be 300-1300`
        });
      }
    }

    // Update gamemode ratings in player record only
    const updatedRatings = { ...existingRatings, ...newRatings };

    // Calculate overall rating (average of all gamemode ratings)
    const overallRating = Object.keys(updatedRatings).length > 0
      ? Math.round(Object.values(updatedRatings).reduce((sum, rating) => sum + rating, 0) / Object.keys(updatedRatings).length)
      : 1000;

    // Update player record
    const playerRef = playersRef.child(playerId);
    await playerRef.update({
      gamemodeRatings: updatedRatings,
      overallRating: overallRating,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Skill levels updated successfully',
      gamemodeRatings: updatedRatings,
      overallRating
    });
  } catch (error) {
    console.error('Error updating skill levels:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating skill levels'
    });
  }
});

/**
 * POST /api/account/set-gamemode-retirement - Set or unset retirement for a gamemode
 */
app.post('/api/account/set-gamemode-retirement', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const { gamemode, retired } = req.body;

    if (!gamemode || typeof retired !== 'boolean') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'gamemode and retired (boolean) are required'
      });
    }

    // Validate gamemode
    const validGamemode = CONFIG.GAMEMODES.find(g => g.id === gamemode && g.id !== 'overall');
    if (!validGamemode) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Invalid gamemode'
      });
    }

    // Get user profile
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val() || {};

    // Retirement is only allowed for gamemodes with a configured skill level.
    const playersRef = db.ref('players');
    let playerSnapshot = await playersRef
      .orderByChild('userId')
      .equalTo(req.user.uid)
      .once('value');
    if (!playerSnapshot.exists() && userProfile.minecraftUsername) {
      playerSnapshot = await playersRef
        .orderByChild('username')
        .equalTo(userProfile.minecraftUsername)
        .once('value');
    }
    const matchedPlayers = playerSnapshot.exists() ? (playerSnapshot.val() || {}) : {};
    const playerId = Object.keys(matchedPlayers)[0] || null;
    const playerData = playerId ? matchedPlayers[playerId] : null;
    const currentRating = playerData?.gamemodeRatings?.[gamemode];
    if (!Number.isFinite(currentRating) || currentRating <= 0) {
      return res.status(400).json({
        error: true,
        code: 'SKILL_LEVEL_REQUIRED',
        message: `Set your ${gamemode} skill level before changing retirement status`
      });
    }

    const retiredGamemodes = userProfile.retiredGamemodes || {};
    const retirementHistory = userProfile.retirementHistory || {};
    const lastRetirementChange = retirementHistory[gamemode];

    // Check 30-day cooldown
    if (lastRetirementChange) {
      const lastChangeTime = new Date(lastRetirementChange);
      const now = new Date();
      const daysSinceChange = (now - lastChangeTime) / (1000 * 60 * 60 * 24);

      if (daysSinceChange < 30) {
        const daysRemaining = Math.ceil(30 - daysSinceChange);
        return res.status(400).json({
          error: true,
          code: 'COOLDOWN_ACTIVE',
          message: `You can only change retirement status once every 30 days. ${daysRemaining} days remaining.`
        });
      }
    }

    // Update retirement status
    if (retired) {
      retiredGamemodes[gamemode] = true;
    } else {
      delete retiredGamemodes[gamemode];
    }

    // Update retirement history
    retirementHistory[gamemode] = new Date().toISOString();

    const updateTimestamp = new Date().toISOString();
    const updates = [
      userRef.update({
        retiredGamemodes,
        retirementHistory,
        updatedAt: updateTimestamp
      })
    ];
    if (playerId) {
      updates.push(playersRef.child(playerId).update({
        retiredGamemodes,
        updatedAt: updateTimestamp
      }));
    }
    await Promise.all(updates);

    res.json({
      success: true,
      message: `Gamemode ${retired ? 'retired' : 'unretired'} successfully`,
      retiredGamemodes
    });
  } catch (error) {
    console.error('Error setting gamemode retirement:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting gamemode retirement'
    });
  }
});

// ===== Pre-Authentication Routes =====

// ===== Onboarding Routes =====

/**
 * GET /api/onboarding/status - Get onboarding status and requirements
 */
app.get('/api/onboarding/status', verifyAuth, async (req, res) => {
  try {
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (!userProfile) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User profile not found'
      });
    }

    const status = {
      onboardingCompleted: userProfile.onboardingCompleted || false,
      emailVerified: req.user?.emailVerified === true,
      hasMinecraftUsername: !!(userProfile.minecraftUsername && userProfile.minecraftUsername.trim()),
      hasRegion: !!(userProfile.region && userProfile.region.trim()),
      isMinecraftVerified: userProfile.minecraftVerified || false,
      canProceedToStep2: !!(userProfile.minecraftUsername && userProfile.minecraftUsername.trim() &&
                           userProfile.region && userProfile.region.trim()),
      canProceedToStep3: !!(userProfile.minecraftUsername && userProfile.minecraftUsername.trim() &&
                           userProfile.region && userProfile.region.trim() &&
                           userProfile.minecraftVerified === true)
    };

    res.json(status);
  } catch (error) {
    console.error('Error getting onboarding status:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error retrieving onboarding status'
    });
  }
});

/**
 * Attempt immediate matchmaking when player joins queue
 */
async function attemptImmediateMatchmaking(queueEntry, playerProfile) {
  try {
    await attemptMatchmaking();

    const activeMatchSnapshot = await db.ref('matches').orderByChild('status').equalTo('active').once('value');
    const activeMatches = activeMatchSnapshot.val() || {};
    const activeMatch = Object.values(activeMatches).find((match) => (
      match && !match.finalized && (match.playerId === queueEntry.userId || match.testerId === queueEntry.userId)
    ));

    if (!activeMatch) {
      return null;
    }

    const otherUsername = activeMatch.playerId === queueEntry.userId
      ? activeMatch.testerUsername
      : activeMatch.playerUsername;

    return {
      matchId: activeMatch.matchId,
      testerUsername: otherUsername || 'Opponent'
    };

  } catch (error) {
    console.error('Error in immediate matchmaking:', error);
    return null;
  }
}

// ===== Onboarding Routes =====

/**
 * POST /api/onboarding/save-preferences - Save gamemode preferences and skill level for Elo-based system
 */
app.post('/api/onboarding/save-preferences', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const { selectedGamemodes, gamemodeSkillLevels } = req.body;

    if (!Array.isArray(selectedGamemodes) || selectedGamemodes.length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'At least one gamemode must be selected'
      });
    }

    // Get current user profile
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val() || {};

    if (!userProfile.minecraftUsername) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Minecraft username not linked'
      });
    }

    // Get or create player record
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('username').equalTo(userProfile.minecraftUsername).once('value');

    let playerRef;
    let playerData;

    if (playerSnapshot.exists()) {
      // Update existing player
      const players = playerSnapshot.val();
      const playerId = Object.keys(players)[0];
      playerRef = playersRef.child(playerId);
      playerData = players[playerId];
    } else {
      // Create new player record
      playerRef = playersRef.push();
      playerData = {
        username: userProfile.minecraftUsername,
        userId: req.user.uid,
        region: userProfile.region || null,
        gamemodeRatings: {},
        overallRating: 0,
        lastTested: {},
        createdAt: new Date().toISOString(),
        createdBy: req.user.uid
      };
    }

    // Check for locked skill levels (already set ratings cannot be changed)
    const existingRatings = playerData.gamemodeRatings || {};
    const lockedGamemodes = selectedGamemodes.filter(gamemode => existingRatings[gamemode] !== undefined);

    if (lockedGamemodes.length > 0) {
      return res.status(400).json({
        error: true,
        code: 'SKILL_LEVEL_LOCKED',
        message: `Skill levels for the following gamemodes are already locked: ${lockedGamemodes.join(', ')}`
      });
    }

    // Initialize Elo ratings for selected gamemodes (player record only)
    const gamemodeRatings = { ...existingRatings };
    selectedGamemodes.forEach(gamemode => {
      gamemodeRatings[gamemode] = gamemodeSkillLevels[gamemode];
    });

    // Calculate overall rating (average of gamemode ratings)
    const overallRating = Object.keys(gamemodeRatings).length > 0
      ? Math.round(Object.values(gamemodeRatings).reduce((sum, rating) => sum + rating, 0) / Object.keys(gamemodeRatings).length)
      : 1000;

    // Update user profile (only selectedGamemodes, not ratings)
    await userRef.update({
      selectedGamemodes: [...new Set([...(userProfile.selectedGamemodes || []), ...selectedGamemodes])],
      updatedAt: new Date().toISOString()
    });

    // Update player record with Elo ratings
    const playerUpdates = {
      gamemodeRatings: gamemodeRatings,
      overallRating: overallRating,
      updatedAt: new Date().toISOString()
    };

    await playerRef.update(playerUpdates);

    res.json({
      success: true,
      message: 'Elo ratings saved successfully to leaderboard',
      gamemodeRatings,
      overallRating,
      selectedGamemodes
    });
  } catch (error) {
    console.error('Error saving preferences:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error saving onboarding preferences'
    });
  }
});

/**
 * POST /api/admin/players/:playerId/rating - Admin endpoint to set player rating
 */
app.post('/api/admin/players/:playerId/rating', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {

    const { playerId } = req.params;
    const decodedPlayerId = decodeURIComponent(playerId);
    console.log('Original playerId:', playerId, 'Decoded:', decodedPlayerId);

    // Additional security: Sanitize inputs
    const sanitizedPlayerId = decodedPlayerId?.toString().trim();
    const sanitizedGamemode = req.body.gamemode?.toString().trim();
    const sanitizedRating = typeof req.body.rating === 'number' ? req.body.rating : parseFloat(req.body.rating);

    if (!sanitizedPlayerId || sanitizedPlayerId.length > 100) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Invalid player ID'
      });
    }

    const { gamemode, rating } = { gamemode: sanitizedGamemode, rating: sanitizedRating };
    console.log('Setting rating for player:', sanitizedPlayerId, 'gamemode:', gamemode, 'rating:', rating, 'by user:', req.user.email);

    // Security audit log
    console.log(`ADMIN ACTION: Setting rating for player ${sanitizedPlayerId}: ${gamemode}=${rating}`);

    if (!gamemode || !CONFIG.GAMEMODES.find(g => g.id === gamemode)) {
      console.log('Invalid gamemode:', gamemode);
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid gamemode: ${gamemode}`
      });
    }

    if (typeof rating !== 'number' || rating < 300 || rating > 3000) {
      console.log('Invalid rating:', rating, typeof rating);
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid rating (must be 300-3000): ${rating}`
      });
    }

    // Get player data
    console.log('Looking for player with ID:', decodedPlayerId);
    const playerRef = db.ref(`players/${decodedPlayerId}`);
    const playerSnapshot = await playerRef.once('value');
    console.log('Player snapshot exists:', playerSnapshot.exists());

    if (!playerSnapshot.exists()) {
      console.log('Player not found, checking all players...');
      // Debug: Check if player exists with different ID format
      const allPlayersRef = db.ref('players');
      const allPlayersSnapshot = await allPlayersRef.once('value');
      const allPlayers = allPlayersSnapshot.val() || {};
      console.log('All player keys:', Object.keys(allPlayers));
      console.log('Looking for player with username...');

      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: `Player not found with ID: ${playerId}`
      });
    }

    const playerData = playerSnapshot.val();
    console.log('Player exists:', playerSnapshot.exists());
    console.log('Player data:', playerData);
    const gamemodeRatings = playerData.gamemodeRatings || {};
    console.log('Current gamemode ratings:', gamemodeRatings);

    // Update the specific gamemode rating
    gamemodeRatings[gamemode] = rating;
    console.log('Updated gamemode ratings:', gamemodeRatings);

    // Recalculate overall rating
    const ratings = Object.values(gamemodeRatings);
    console.log('Ratings array:', ratings);
    const overallRating = ratings.length > 0
      ? Math.round(ratings.reduce((sum, r) => sum + r, 0) / ratings.length)
      : rating;
    console.log('Calculated overall rating:', overallRating);

    // Update player
    await playerRef.update({
      gamemodeRatings,
      overallRating,
      updatedAt: new Date().toISOString()
    });

    // Log admin action
    await logAdminAction(req, req.user.uid, 'UPDATE_RATING', decodedPlayerId, {
      gamemode,
      oldRating: gamemodeRatings[gamemode] !== rating ? playerData.gamemodeRatings?.[gamemode] : null,
      newRating: rating,
      overallRating
    });

    res.json({
      success: true,
      message: `Player ${gamemode} rating set to ${rating}`,
      gamemodeRatings,
      overallRating
    });
  } catch (error) {
    console.error('Error setting player rating:', error);
    console.error('Player ID:', playerId);
    console.error('Gamemode:', gamemode);
    console.error('Rating:', rating);
    console.error('User ID:', req.user.uid);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting player rating',
      details: error.message
    });
  }
});

/**
 * POST /api/onboarding/complete - Mark onboarding as completed
 */
app.post('/api/onboarding/complete', verifyAuth, async (req, res) => {
  try {
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();

    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Check if onboarding is already completed
    if (userData.onboardingCompleted === true) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_COMPLETED',
        message: 'Onboarding has already been completed for this account'
      });
    }

    if (req.user?.emailVerified !== true) {
      return res.status(403).json({
        error: true,
        code: 'EMAIL_VERIFICATION_REQUIRED',
        message: 'Verify your email address before completing onboarding.'
      });
    }

    // Verify all required steps are completed (order doesn't matter)
    const hasMinecraftUsername = !!(userData.minecraftUsername && userData.minecraftUsername.trim());
    const isMinecraftVerified = userData.minecraftVerified === true;
    const hasRegion = !!(userData.region && userData.region.trim());
    const hasSelectedGamemodes = userData.selectedGamemodes && Array.isArray(userData.selectedGamemodes) && userData.selectedGamemodes.length > 0;

    if (!hasMinecraftUsername) {
      return res.status(400).json({
        error: true,
        code: 'INCOMPLETE_ONBOARDING',
        message: 'Minecraft username is required to complete onboarding'
      });
    }

    if (!isMinecraftVerified) {
      return res.status(400).json({
        error: true,
        code: 'INCOMPLETE_ONBOARDING',
        message: 'Minecraft account must be verified to complete onboarding'
      });
    }

    if (!hasRegion) {
      return res.status(400).json({
        error: true,
        code: 'INCOMPLETE_ONBOARDING',
        message: 'Region selection is required to complete onboarding'
      });
    }

    if (!hasSelectedGamemodes) {
      return res.status(400).json({
        error: true,
        code: 'INCOMPLETE_ONBOARDING',
        message: 'Gamemode selection is required to complete onboarding'
      });
    }

    // Verify player record has skill levels set (ratings in player record)
    if (userData.minecraftUsername) {
      const playersRef = db.ref('players');
      const playerSnapshot = await playersRef.orderByChild('username').equalTo(userData.minecraftUsername).once('value');
      
      if (!playerSnapshot.exists()) {
        return res.status(400).json({
          error: true,
          code: 'INCOMPLETE_ONBOARDING',
          message: 'Player record not found. Please complete skill level selection.'
        });
      }

      const players = playerSnapshot.val();
      const playerId = Object.keys(players)[0];
      const playerData = players[playerId];
      
      if (!playerData.gamemodeRatings || Object.keys(playerData.gamemodeRatings).length === 0) {
        return res.status(400).json({
          error: true,
          code: 'INCOMPLETE_ONBOARDING',
          message: 'Skill levels are required to complete onboarding'
        });
      }
    }

    // All checks passed, mark onboarding as completed
    await userRef.update({
      onboardingCompleted: true,
      onboardingCompletedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });

    // Send welcome inbox message
    await sendInboxMessage(req.user.uid, {
      title: 'Welcome to MC Leaderboards!',
      message: `Welcome, ${userData.minecraftUsername}! Your account is all set up and ready to go.\n\nHere's how to get started:\n• Head to the Dashboard to join the queue and find matches\n• Check the Leaderboard to see where you stand\n• Visit the Rules page to understand our guidelines\n\nGood luck and have fun competing!`,
      type: 'system',
      from: 'MC Leaderboards',
      metadata: { event: 'welcome' }
    });

    console.log(`Onboarding completed for user ${req.user.uid} (${userData.email})`);

    res.json({ 
      success: true, 
      message: 'Onboarding completed successfully',
      completedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error completing onboarding:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error completing onboarding'
    });
  }
});

// ===== Dashboard Stats Routes =====

/**
 * GET /api/dashboard/stats - Get dashboard statistics
 */
app.get('/api/dashboard/stats', verifyAuthAndNotBanned, async (req, res) => {
  try {
    // Get queue and active match data
    const [queueSnapshot, matchesSnapshot] = await Promise.all([
      db.ref('queue').once('value'),
      db.ref('matches').orderByChild('status').equalTo('active').once('value')
    ]);

    const queueData = queueSnapshot.val() || {};
    const activeMatches = matchesSnapshot.val() || {};
    const activeMatchesCount = Object.keys(activeMatches).length;

    const busyUserIds = new Set();
    Object.values(activeMatches).forEach((match) => {
      if (!match || match.finalized) return;
      if (match.playerId) busyUserIds.add(match.playerId);
      if (match.testerId) busyUserIds.add(match.testerId);
    });

    const queueList = Object.values(queueData).filter((entry) => (
      entry?.status === 'waiting' && entry?.userId && !busyUserIds.has(entry.userId)
    ));

    const uniqueUserIds = [...new Set(queueList.map((entry) => entry.userId))];
    const userSnapshots = await Promise.all(uniqueUserIds.map((userId) => db.ref(`users/${userId}`).once('value')));
    const isTesterByUserId = new Map();
    for (let i = 0; i < uniqueUserIds.length; i++) {
      const profile = userSnapshots[i].val() || {};
      isTesterByUserId.set(uniqueUserIds[i], profile.tester === true);
    }

    const playersQueued = {};
    const testersAvailable = {};
    queueList.forEach((entry) => {
      const gamemodes = getQueueGamemodeList(entry);
      const isTester = isTesterByUserId.get(entry.userId) === true;
      gamemodes.forEach((gamemode) => {
        if (!playersQueued[gamemode]) playersQueued[gamemode] = 0;
        playersQueued[gamemode]++;
        if (isTester) {
          if (!testersAvailable[gamemode]) testersAvailable[gamemode] = 0;
          testersAvailable[gamemode]++;
        }
      });
    });

    res.json({
      playersQueued,
      testersAvailable,
      activeMatchesCount,
      totalQueuedPlayers: Object.values(playersQueued).reduce((sum, count) => sum + count, 0),
      totalAvailableTierTesters: Object.values(testersAvailable).reduce((sum, count) => sum + count, 0)
    });
  } catch (error) {
    console.error('Error getting dashboard stats:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error retrieving dashboard statistics'
    });
  }
});

// ===== Notification Settings Routes =====

/**
 * POST /api/notifications/test - Send a test notification
 */
app.post('/api/notifications/test', verifyAuth, requireRecaptcha, async (req, res) => {
  res.status(410).json({
    error: true,
    code: 'NOTIFICATION_SYSTEM_REMOVED',
    message: 'The notification system has been removed.'
  });
});

/**
 * GET /api/notifications - Get notifications for current user
 */
app.get('/api/notifications', verifyAuth, async (req, res) => {
  res.json({ success: true, notifications: [], total: 0, removed: true });
});

/**
 * POST /api/notifications/:id/read - Mark a notification as read
 */
app.post('/api/notifications/:id/read', verifyAuth, async (req, res) => {
  res.json({ success: true, removed: true });
});

/**
 * DELETE /api/notifications/:id - Delete a notification
 */
app.delete('/api/notifications/:id', verifyAuth, async (req, res) => {
  res.json({ success: true, removed: true });
});

/**
 * DELETE /api/notifications/:id - Delete a notification
 */
app.delete('/api/notifications/:id', verifyAuth, async (req, res) => {
  res.json({ success: true, removed: true });
});

// ===== Inbox System Routes =====

/**
 * Helper: Send an inbox message to a user
 * Stores message in Firebase RTDB under inbox/{userId}/{messageId}
 */
async function sendInboxMessage(userId, messageData) {
  if (!userId) return null;
  const inboxRef = db.ref(`inbox/${userId}`);
  const newMsgRef = inboxRef.push();
  const message = {
    id: newMsgRef.key,
    title: messageData.title || 'Message',
    message: messageData.message || '',
    preview: (messageData.message || '').substring(0, 120),
    type: messageData.type || 'system',
    from: messageData.from || 'System',
    read: false,
    createdAt: new Date().toISOString(),
    ...(messageData.htmlBody ? { htmlBody: messageData.htmlBody } : {}),
    ...(messageData.ratingAdjustments ? { ratingAdjustments: messageData.ratingAdjustments } : {}),
    ...(messageData.reason ? { reason: messageData.reason } : {}),
    ...(messageData.metadata ? { metadata: messageData.metadata } : {})
  };
  await newMsgRef.set(message);
  await realtimeDbRef(`inboxMeta/${userId}/unreadCount`).transaction((currentValue) => {
    const currentCount = Number.isFinite(Number(currentValue)) ? Number(currentValue) : 0;
    return currentCount + 1;
  });
  return message;
}

async function getInboxUnreadCount(userId) {
  if (!userId) return 0;

  const unreadCountRef = realtimeDbRef(`inboxMeta/${userId}/unreadCount`);
  const unreadCountSnapshot = await unreadCountRef.once('value').catch(() => null);
  if (unreadCountSnapshot?.exists?.()) {
    const unreadCount = Number(unreadCountSnapshot.val());
    return Number.isFinite(unreadCount) && unreadCount >= 0 ? unreadCount : 0;
  }

  const inboxSnapshot = await realtimeDbRef(`inbox/${userId}`).once('value').catch(() => null);
  const messages = inboxSnapshot?.val?.() || {};
  const unreadCount = Object.values(messages).filter((message) => message && message.read !== true).length;
  await unreadCountRef.set(unreadCount).catch(() => null);
  return unreadCount;
}

/**
 * GET /api/inbox/messages - Get inbox messages for current user
 */
app.get('/api/inbox/messages', verifyAuth, async (req, res) => {
  try {
    const inboxRef = db.ref(`inbox/${req.user.uid}`);
    const snapshot = await inboxRef.orderByChild('createdAt').limitToLast(100).once('value');
    const rawMessages = snapshot.val() || {};
    const messages = Object.values(rawMessages).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, messages, total: messages.length });
  } catch (error) {
    console.error('Error fetching inbox:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error fetching inbox' });
  }
});

/**
 * GET /api/inbox/unread-count - Get count of unread messages
 */
app.get('/api/inbox/unread-count', verifyAuth, async (req, res) => {
  try {
    const unreadCount = await getInboxUnreadCount(req.user.uid);
    res.json({ success: true, unreadCount });
  } catch (error) {
    res.json({ success: true, unreadCount: 0 });
  }
});

/**
 * POST /api/inbox/messages/:id/read - Mark a message as read
 */
app.post('/api/inbox/messages/:id/read', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const readRef = realtimeDbRef(`inbox/${req.user.uid}/${id}/read`);
    const readSnapshot = await readRef.once('value');
    const wasUnread = readSnapshot.val() !== true;

    await readRef.set(true);
    if (wasUnread) {
      await realtimeDbRef(`inboxMeta/${req.user.uid}/unreadCount`).transaction((currentValue) => {
        const currentCount = Number.isFinite(Number(currentValue)) ? Number(currentValue) : 0;
        return Math.max(0, currentCount - 1);
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error marking message as read' });
  }
});

/**
 * POST /api/inbox/messages/read-all - Mark all messages as read
 */
app.post('/api/inbox/messages/read-all', verifyAuth, async (req, res) => {
  try {
    const inboxRef = db.ref(`inbox/${req.user.uid}`);
    const snapshot = await inboxRef.once('value');
    const messages = snapshot.val() || {};
    const updates = {};
    for (const msgId of Object.keys(messages)) {
      updates[`${msgId}/read`] = true;
    }
    if (Object.keys(updates).length > 0) {
      await inboxRef.update(updates);
    }
    await realtimeDbRef(`inboxMeta/${req.user.uid}/unreadCount`).set(0);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error marking all as read' });
  }
});

/**
 * DELETE /api/inbox/messages/:id - Delete an inbox message
 */
app.delete('/api/inbox/messages/:id', verifyAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const messageRef = realtimeDbRef(`inbox/${req.user.uid}/${id}`);
    const messageSnapshot = await messageRef.once('value');
    const message = messageSnapshot.val();
    await messageRef.remove();
    if (message && message.read !== true) {
      await realtimeDbRef(`inboxMeta/${req.user.uid}/unreadCount`).transaction((currentValue) => {
        const currentCount = Number.isFinite(Number(currentValue)) ? Number(currentValue) : 0;
        return Math.max(0, currentCount - 1);
      });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error deleting message' });
  }
});

/**
 * POST /api/admin/inbox/send - Admin send message to a user's inbox
 */
app.post('/api/admin/inbox/send', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage') && !adminHasCapability(req, 'messages:send')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Message send capability required' });
    }

    const { userId, title, message, type } = req.body;

    if (!userId || !title || !message) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'userId, title, and message are required' });
    }

    // Verify user exists
    const userSnap = await db.ref(`users/${userId}`).once('value');
    if (!userSnap.exists()) {
      return res.status(404).json({ error: true, code: 'USER_NOT_FOUND', message: 'User not found' });
    }

    const adminSnap = await db.ref(`users/${req.user.uid}`).once('value');
    const adminProfile = adminSnap.val() || {};
    const adminName = adminProfile.minecraftUsername || 'Admin';

    await sendInboxMessage(userId, {
      title,
      message,
      type: type || 'admin_message',
      from: adminName + ' (Staff)'
    });

    await logAdminAction(req, req.user.uid, 'SEND_INBOX_MESSAGE', userId, { title, type });

    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    console.error('Error sending admin message:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error sending message' });
  }
});

/**
 * POST /api/admin/resolve-violation - Resolve a match violation
 * Reverts rating changes, blacklists offender, notifies both players
 */
app.post('/api/admin/resolve-violation', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { username, matchId, reason, blacklistDurationHours } = req.body;

    if (!username || !matchId || !reason) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'username, matchId, and reason are required' });
    }

    // 1. Get the match data
    const matchRef = db.ref(`matches/${matchId}`);
    const matchSnap = await matchRef.once('value');
    const match = matchSnap.val();

    if (!match) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Match not found' });
    }

    if (!match.finalized) {
      return res.status(400).json({ error: true, code: 'NOT_FINALIZED', message: 'Match has not been finalized yet' });
    }

    // 2. Identify the offending player and the victim
    const offenderUsername = username.toLowerCase();
    let offenderId = null;
    let victimId = null;
    let offenderIsPlayer = false;

    if (match.playerUsername && match.playerUsername.toLowerCase() === offenderUsername) {
      offenderId = match.playerId;
      victimId = match.testerId;
      offenderIsPlayer = true;
    } else if (match.testerUsername && match.testerUsername.toLowerCase() === offenderUsername) {
      offenderId = match.testerId;
      victimId = match.playerId;
      offenderIsPlayer = false;
    } else {
      // Try to find by player lookup
      const playerSnap = await db.ref('players').orderByChild('username').equalTo(username).limitToFirst(1).once('value');
      const playerData = playerSnap.val() || {};
      const playerEntry = Object.values(playerData)[0];
      if (playerEntry) {
        if (playerEntry.userId === match.playerId) {
          offenderId = match.playerId;
          victimId = match.testerId;
          offenderIsPlayer = true;
        } else if (playerEntry.userId === match.testerId) {
          offenderId = match.testerId;
          victimId = match.playerId;
          offenderIsPlayer = false;
        }
      }
    }

    if (!offenderId) {
      return res.status(404).json({ error: true, code: 'PLAYER_NOT_FOUND', message: 'Could not find the offending player in this match' });
    }

    // 3. Get finalization data to determine rating changes to revert
    const finData = match.finalizationData || {};
    const ratingChanges = finData.ratingChanges || {};
    const gamemode = match.gamemode;

    // 4. Revert rating changes for the victim
    const ratingAdjustments = [];
    if (gamemode && victimId) {
      const victimPlayersSnap = await db.ref('players').orderByChild('userId').equalTo(victimId).limitToFirst(1).once('value');
      const victimPlayers = victimPlayersSnap.val() || {};
      const victimPlayerEntry = Object.entries(victimPlayers)[0];

      if (victimPlayerEntry) {
        const [victimPlayerId, victimPlayerData] = victimPlayerEntry;
        const currentRating = victimPlayerData.gamemodeRatings?.[gamemode] || 1000;

        // Calculate how much to restore
        let ratingToRestore = 0;
        if (offenderIsPlayer) {
          // Offender was the player; victim was the tester
          ratingToRestore = Math.abs(ratingChanges.testerRatingChange || 0);
          if (ratingChanges.testerRatingChange < 0) {
            // Tester lost rating - restore the loss
            ratingToRestore = Math.abs(ratingChanges.testerRatingChange);
          } else {
            ratingToRestore = 0; // Tester gained, no need to restore
          }
        } else {
          // Offender was the tester; victim was the player
          ratingToRestore = Math.abs(ratingChanges.playerRatingChange || 0);
          if (ratingChanges.playerRatingChange < 0) {
            ratingToRestore = Math.abs(ratingChanges.playerRatingChange);
          } else {
            ratingToRestore = 0;
          }
        }

        if (ratingToRestore > 0) {
          const newRating = currentRating + ratingToRestore;
          await db.ref(`players/${victimPlayerId}/gamemodeRatings/${gamemode}`).set(newRating);

          ratingAdjustments.push({
            gamemode: gamemode,
            before: currentRating,
            restored: ratingToRestore,
            after: newRating
          });
        }
      }
    }

    // 5. Blacklist the offender
    const safeDuration = Number(blacklistDurationHours) > 0 ? Math.min(Number(blacklistDurationHours), 24 * 365) : 0;
    const expiresAt = safeDuration > 0
      ? new Date(Date.now() + safeDuration * 60 * 60 * 1000).toISOString()
      : null;

    const blacklistRef = db.ref('blacklist');
    const newBlacklistRef = blacklistRef.push();
    await newBlacklistRef.set({
      username: username,
      userId: offenderId,
      reason: `[Auto-Resolve] ${reason}`,
      addedAt: new Date().toISOString(),
      addedBy: req.user.uid,
      expiresAt,
      disabledFunctions: {}
    });

    // 6. Send inbox notice to the VICTIM
    if (victimId) {
      const victimMessage = ratingAdjustments.length > 0
        ? 'We have detected that one or more of your recent opponents has violated our policies. As compensation for potentially unfair rating losses, we have adjusted your ratings.'
        : 'We have detected that one or more of your recent opponents has violated our policies. Your ratings were not negatively affected by this match.';

      await sendInboxMessage(victimId, {
        title: 'Match Rating Adjustment',
        message: victimMessage,
        type: 'rating_adjustment',
        from: 'MC Leaderboards Moderation',
        ratingAdjustments: ratingAdjustments,
        reason: reason
      });
    }

    // 7. Send inbox notice to the OFFENDER
    if (offenderId) {
      const durText = expiresAt
        ? `Your account has been temporarily restricted until ${new Date(expiresAt).toLocaleDateString()}.`
        : 'Your account has been permanently restricted.';

      await sendInboxMessage(offenderId, {
        title: 'Account Action: Policy Violation',
        message: `Your account has been flagged for violating our policies in match ${matchId}.\n\n${durText}\n\nReason: ${reason}\n\nIf you believe this action was taken in error, please contact support.`,
        type: 'blacklist',
        from: 'MC Leaderboards Moderation',
        reason: reason
      });
    }

    // 8. Mark match as resolved
    await matchRef.update({
      resolved: true,
      resolvedAt: new Date().toISOString(),
      resolvedBy: req.user.uid,
      resolveReason: reason,
      ratingReverted: ratingAdjustments.length > 0
    });

    // 9. Log admin action
    await logAdminAction(req, req.user.uid, 'RESOLVE_VIOLATION', offenderId, {
      matchId,
      username,
      reason,
      blacklistDurationHours: safeDuration,
      ratingAdjustments,
      victimId
    });

    await checkAndTerminateBlacklistedMatches();

    res.json({
      success: true,
      message: 'Match violation resolved successfully. Ratings reverted, offender blacklisted, both players notified.',
      ratingAdjustments
    });
  } catch (error) {
    console.error('Error resolving violation:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: error.message || 'Error resolving violation' });
  }
});

// ===== Plus Membership Routes =====

function normalizeMinecraftUsername(username) {
  return (username || '').toString().trim().toLowerCase();
}

function normalizeSixDigitCode(code) {
  const normalized = String(code || '').trim();
  return /^\d{6}$/.test(normalized) ? normalized : null;
}

function isPlusCodeExpired(codeEntry) {
  if (!codeEntry || codeEntry.neverExpires === true || codeEntry.source === 'easter_egg') {
    return false;
  }

  const expiresAtMs = parseDateToMs(codeEntry.expiresAt);
  return Boolean(expiresAtMs && expiresAtMs <= Date.now());
}

function isPlusCodeRedeemableByUser(codeEntry, userId) {
  if (!codeEntry) return false;
  if (codeEntry.active === false || codeEntry.removedAt) return false;
  if (isPlusCodeExpired(codeEntry)) return false;
  if (codeEntry.used === true) return false;
  if (codeEntry.assignedUserId && codeEntry.assignedUserId !== userId) return false;
  return true;
}

function normalizePuzzleAnswer(answer) {
  return String(answer || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const EASTER_EGG_STEPS = [
  {
    id: 'hall-of-echoes',
    answers: ['echo']
  },
  {
    id: 'clockwork-garden',
    answers: ['shadow']
  },
  {
    id: 'frozen-library',
    answers: ['candle', 'a candle']
  },
  {
    id: 'crown-vault',
    answers: ['vanilla', 'purevanilla']
  }
];

function isCorrectPuzzleAnswer(inputAnswer, allowedAnswers = []) {
  const normalizedInput = normalizePuzzleAnswer(inputAnswer);
  if (!normalizedInput) return false;
  return allowedAnswers.some((candidate) => normalizePuzzleAnswer(candidate) === normalizedInput);
}

async function generateUniquePlusCode(maxAttempts = 40) {
  for (let i = 0; i < maxAttempts; i++) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const snapshot = await db.ref(`plusPurchaseCodes/${code}`).once('value');
    if (!snapshot.exists()) return code;
  }
  throw new Error('Unable to generate unique 6-digit code');
}

function sanitizePlusGradient(gradient) {
  if (!gradient || typeof gradient !== 'object') return null;
  const angle = typeof gradient.angle === 'number' && isFinite(gradient.angle)
    ? Math.max(0, Math.min(360, gradient.angle))
    : 90;
  const animation = typeof gradient.animation === 'string' ? gradient.animation : 'none';
  const allowedAnimations = new Set(['none', 'shift', 'pulse']);
  const safeAnimation = allowedAnimations.has(animation) ? animation : 'none';
  const stops = Array.isArray(gradient.stops) ? gradient.stops : [];
  const safeStops = stops
    .map((s) => {
      const color = typeof s?.color === 'string' && /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/.test(s.color) ? s.color : null;
      const pos = typeof s?.pos === 'number' && isFinite(s.pos) ? Math.max(0, Math.min(100, s.pos)) : null;
      return color ? { color, pos } : null;
    })
    .filter(Boolean)
    .slice(0, 5); // limit complexity

  if (safeStops.length < 2) return null;
  // Keep stops ordered for consistency
  safeStops.sort((a, b) => (a.pos ?? 0) - (b.pos ?? 0));
  return { angle, stops: safeStops, animation: safeAnimation };
}

async function findPlayerByUsername(username) {
  const normalized = normalizeMinecraftUsername(username);
  if (!normalized) return null;
  const playersRef = db.ref('players');
  const snap = await playersRef.once('value');
  const players = snap.val() || {};
  for (const [playerId, p] of Object.entries(players)) {
    if (normalizeMinecraftUsername(p.username) === normalized) {
      return { playerId, playerRef: playersRef.child(playerId), player: p };
    }
  }
  return null;
}

async function findPlayerByMinecraftIdentity({ username, uuid } = {}) {
  const normalizedUsername = normalizeMinecraftUsername(username);
  const normalizedUuid = normalizeMinecraftUUID(uuid);
  const playersRef = db.ref('players');
  const snap = await playersRef.once('value');
  const players = snap.val() || {};

  for (const [playerId, player] of Object.entries(players)) {
    const playerUsername = normalizeMinecraftUsername(player.username);
    const playerUuid = normalizeMinecraftUUID(player.minecraftUUID);
    if ((normalizedUsername && playerUsername === normalizedUsername) || (normalizedUuid && playerUuid === normalizedUuid)) {
      return { playerId, playerRef: playersRef.child(playerId), player };
    }
  }

  return null;
}

async function syncPlusToPlayerForUser(userId) {
  const userRef = db.ref(`users/${userId}`);
  const userSnap = await userRef.once('value');
  const user = userSnap.val();
  if (!user) return { synced: false, reason: 'USER_NOT_FOUND' };

  const username = user.minecraftUsername;
  const minecraftUUID = normalizeMinecraftUUID(user.minecraftUUID);
  if (!username && !minecraftUUID) return { synced: false, reason: 'USERNAME_NOT_LINKED' };

  const playerMatch = await findPlayerByMinecraftIdentity({ username, uuid: minecraftUUID });
  if (!playerMatch) return { synced: false, reason: 'PLAYER_NOT_FOUND' };

  const plus = user.plus || {};
  const nowIso = new Date().toISOString();
  const playerPlus = {
    active: plus.active === true,
    expiresAt: plus.expiresAt || null,
    showBadge: plus.showBadge !== false, // default true
    gradient: plus.active === true ? (plus.gradient || null) : null,
    updatedAt: nowIso
  };

  await playerMatch.playerRef.update({
    plus: playerPlus,
    updatedAt: nowIso
  });

  // Bust players cache so the leaderboard reflects it quickly
  playersCache.data = null;
  playersCache.updatedAt = 0;

  return { synced: true, playerId: playerMatch.playerId };
}

/**
 * POST /api/plus/requests - Create a Plus purchase/gift request (requires auth)
 */
app.post('/api/plus/requests', verifyAuth, requireRecaptcha, async (req, res) => {
  try {
    const { giftUsername, years } = req.body || {};
    const yearsInt = Math.max(1, Math.min(5, parseInt(years || 1)));
    const normalizedGift = giftUsername ? normalizeMinecraftUsername(giftUsername) : null;

    const requestsRef = db.ref('plusRequests');
    const newRef = requestsRef.push();
    const request = {
      requesterUserId: req.user.uid,
      requesterEmail: req.user.email || null,
      giftUsername: normalizedGift,
      years: yearsInt,
      priceUsd: 9.99 * yearsInt,
      status: 'pending',
      createdAt: new Date().toISOString()
    };
    await newRef.set(request);

    res.json({ success: true, requestId: newRef.key });
  } catch (error) {
    console.error('Error creating plus request:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error creating plus request' });
  }
});

/**
 * POST /api/plus/preferences - Save Plus preferences (badge toggle + gradient)
 */
app.post('/api/plus/preferences', verifyAuth, requireRecaptcha, async (req, res) => {
  try {
    const { showBadge, gradient } = req.body || {};
    const userRef = db.ref(`users/${req.user.uid}`);
    const snap = await userRef.once('value');
    const user = snap.val();
    if (!user) {
      return res.status(404).json({ error: true, code: 'USER_NOT_FOUND', message: 'User profile not found' });
    }

    const existingPlus = user.plus || {};
    const sanitizedGradient = sanitizePlusGradient(gradient);

    const updates = {
      plus: {
        ...existingPlus,
        showBadge: showBadge === false ? false : true,
        gradient: sanitizedGradient,
        updatedAt: new Date().toISOString()
      }
    };

    await userRef.update(updates);
    await syncPlusToPlayerForUser(req.user.uid).catch(() => null);

    res.json({ success: true, plus: updates.plus });
  } catch (error) {
    console.error('Error saving plus preferences:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error saving plus preferences' });
  }
});

/**
 * POST /api/plus/sync - Sync Plus perks to player record (safe to call anytime)
 */
app.post('/api/plus/sync', verifyAuth, requireRecaptcha, async (req, res) => {
  try {
    const result = await syncPlusToPlayerForUser(req.user.uid);
    if (!result.synced) {
      return res.status(400).json({ error: true, code: result.reason, message: 'Unable to sync Plus perks' });
    }
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error syncing plus to player:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error syncing Plus perks' });
  }
});

/**
 * POST /api/plus/redeem-code - Redeem a 6-digit Plus purchase code
 */
app.post('/api/plus/redeem-code', verifyAuth, requireRecaptcha, async (req, res) => {
  const nowIso = new Date().toISOString();
  const userId = req.user.uid;
  const rawCode = req.body?.code;
  const code = normalizeSixDigitCode(rawCode);

  if (!code) {
    return res.status(400).json({
      error: true,
      code: 'INVALID_CODE_FORMAT',
      message: 'Code must be exactly 6 digits.'
    });
  }

  const codeRef = db.ref(`plusPurchaseCodes/${code}`);

  try {
    // First, check if code exists before attempting transaction
    const codeSnapshot = await codeRef.once('value');
    const codeData = codeSnapshot.val();
    
    if (!codeData) {
      return res.status(404).json({
        error: true,
        code: 'CODE_NOT_FOUND',
        message: 'Code not found. Please check and try again.'
      });
    }
    
    if (codeData.active === false || codeData.removedAt) {
      return res.status(404).json({
        error: true,
        code: 'CODE_INACTIVE',
        message: 'This code is no longer active.'
      });
    }

    if (isPlusCodeExpired(codeData)) {
      return res.status(410).json({
        error: true,
        code: 'CODE_EXPIRED',
        message: 'This code has expired.'
      });
    }
    
    if (codeData.used === true) {
      if (codeData.usedBy === userId) {
        // If the previous redemption is still pending (grant never completed), 
        // skip the early return and fall through to the grant logic below.
        if (codeData.redeemedPending !== true) {
          const userSnapshot = await db.ref(`users/${userId}`).once('value');
          return res.json({
            success: true,
            message: 'Code was already redeemed on this account.',
            plus: userSnapshot.val()?.plus || null,
            code,
            alreadyRedeemed: true
          });
        }
        // redeemedPending === true: fall through to complete the grant
      } else {
        return res.status(409).json({
          error: true,
          code: 'CODE_ALREADY_USED',
          message: 'This code has already been used.'
        });
      }
    }
    
    if (codeData.assignedUserId && codeData.assignedUserId !== userId) {
      return res.status(403).json({
        error: true,
        code: 'CODE_NOT_ASSIGNED_TO_USER',
        message: 'This code is assigned to a different account.'
      });
    }

    const reserveCodeForUser = async () => codeRef.transaction((current) => {
      if (!current) return;
      if (!isPlusCodeRedeemableByUser(current, userId)) return;

      return {
        ...current,
        used: true,
        usedBy: userId,
        usedByEmail: req.user.email || null,
        usedAt: nowIso,
        redeemedPending: true
      };
    });

    // Reserve the code for this user before granting Plus.
    let txResult = await reserveCodeForUser();
    let latestSnapshot = await codeRef.once('value');
    let latestCode = latestSnapshot.val() || null;

    if (!txResult.committed) {
      const pendingSelfReservation = latestCode?.used === true && latestCode.usedBy === userId && latestCode.redeemedPending === true;

      if (!pendingSelfReservation && isPlusCodeRedeemableByUser(latestCode, userId)) {
        txResult = await reserveCodeForUser();
        latestSnapshot = await codeRef.once('value');
        latestCode = latestSnapshot.val() || null;
      }

      if (latestCode?.used === true && latestCode.usedBy === userId) {
        if (latestCode.redeemedPending === true) {
          // A previous reservation succeeded for this same user but the response path did not complete.
        } else {
          const userSnapshot = await db.ref(`users/${userId}`).once('value');
          return res.json({
            success: true,
            message: 'Code was already redeemed on this account.',
            plus: userSnapshot.val()?.plus || null,
            code,
            alreadyRedeemed: true
          });
        }
      }

      if (!txResult.committed && !(latestCode?.used === true && latestCode.usedBy === userId && latestCode.redeemedPending === true)) {
        return res.status(400).json({
          error: true,
          code: 'REDEMPTION_FAILED',
          message: 'This code was already redeemed or is no longer available.'
        });
      }
    }

    const reservedCode = latestCode || codeData;
    const yearsInt = Math.max(1, Math.min(5, parseInt(reservedCode.years || 1, 10) || 1));

    let plus;
    if (reservedCode.redeemedPending === true && reservedCode.redeemedPlusExpiresAt) {
      const userSnapshot = await db.ref(`users/${userId}`).once('value');
      plus = userSnapshot.val()?.plus || null;
    } else {
      plus = await grantPlusToUser(userId, yearsInt, reservedCode.createdBy || 'system/code-redeem');
    }

    await codeRef.update({
      redeemedPending: false,
      redeemedPlusExpiresAt: plus?.expiresAt || reservedCode.redeemedPlusExpiresAt || null
    });

    res.json({
      success: true,
      message: 'Code redeemed successfully. Plus has been activated.',
      plus,
      code
    });
  } catch (error) {
    console.error('Error redeeming plus code:', error);

    // Roll back reservation if Plus grant failed.
    await codeRef.transaction((current) => {
      if (!current) return current;
      if (current.usedBy === userId && current.redeemedPending === true) {
        return {
          ...current,
          used: false,
          usedBy: null,
          usedByEmail: null,
          usedAt: null,
          redeemedPending: false
        };
      }
      return current;
    });

    res.status(400).json({
      error: true,
      code: error.code || 'REDEEM_FAILED',
      message: error.message || 'Unable to redeem code'
    });
  }
});

/**
 * GET /api/easter-egg/state - Fetch the signed-in user's puzzle progress
 */
app.get('/api/easter-egg/state', verifyAuthAndNotBanned, async (req, res) => {
  try {
    const eggRef = db.ref(`users/${req.user.uid}/easterEgg`);
    const snapshot = await eggRef.once('value');
    const egg = snapshot.val() || {};
    const stepIndex = Math.max(0, Math.min(parseInt(egg.stepIndex || 0, 10) || 0, EASTER_EGG_STEPS.length));
    const completed = egg.completed === true || stepIndex >= EASTER_EGG_STEPS.length;

    res.json({
      success: true,
      progress: {
        stepIndex,
        totalSteps: EASTER_EGG_STEPS.length,
        completed,
        currentStepId: completed ? null : EASTER_EGG_STEPS[stepIndex].id,
        solvedStepIds: Object.keys(egg.solvedSteps || {}),
        rewardClaimed: egg.rewardClaimed === true,
        rewardClaimedAt: egg.rewardClaimedAt || null,
        rewardCode: egg.rewardCode || null
      }
    });
  } catch (error) {
    console.error('Error fetching easter egg state:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Failed to load easter egg progress' });
  }
});

/**
 * POST /api/easter-egg/solve - Submit answer for current puzzle step
 */
app.post('/api/easter-egg/solve', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const { stepId, answer } = req.body || {};
    if (!stepId || !answer) {
      return res.status(400).json({ error: true, code: 'MISSING_DATA', message: 'stepId and answer are required' });
    }

    const eggRef = db.ref(`users/${req.user.uid}/easterEgg`);
    const snapshot = await eggRef.once('value');
    const egg = snapshot.val() || {};
    const stepIndex = Math.max(0, Math.min(parseInt(egg.stepIndex || 0, 10) || 0, EASTER_EGG_STEPS.length));

    if (egg.completed === true || stepIndex >= EASTER_EGG_STEPS.length) {
      return res.json({ success: true, completed: true, message: 'All puzzle steps are already complete.' });
    }

    const currentStep = EASTER_EGG_STEPS[stepIndex];
    if (stepId !== currentStep.id) {
      return res.status(409).json({
        error: true,
        code: 'STEP_OUT_OF_ORDER',
        message: 'Solve the current step before moving forward.',
        currentStepId: currentStep.id
      });
    }

    if (!isCorrectPuzzleAnswer(answer, currentStep.answers)) {
      await eggRef.update({
        lastAttemptAt: new Date().toISOString(),
        failedAttempts: (parseInt(egg.failedAttempts || 0, 10) || 0) + 1
      });
      return res.status(400).json({ error: true, code: 'WRONG_ANSWER', message: 'That answer does not unlock this event.' });
    }

    const solvedSteps = { ...(egg.solvedSteps || {}) };
    solvedSteps[currentStep.id] = new Date().toISOString();
    const nextStepIndex = stepIndex + 1;
    const completed = nextStepIndex >= EASTER_EGG_STEPS.length;

    await eggRef.update({
      stepIndex: nextStepIndex,
      completed,
      completedAt: completed ? new Date().toISOString() : egg.completedAt || null,
      solvedSteps,
      lastSolvedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      correct: true,
      completed,
      nextStepId: completed ? null : EASTER_EGG_STEPS[nextStepIndex].id,
      progress: {
        solved: nextStepIndex,
        total: EASTER_EGG_STEPS.length
      }
    });
  } catch (error) {
    console.error('Error solving easter egg step:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Failed to validate puzzle answer' });
  }
});

/**
 * POST /api/easter-egg/claim-reward - Claim one-time easter egg reward code
 */
app.post('/api/easter-egg/claim-reward', verifyAuthAndNotBanned, requireRecaptcha, async (req, res) => {
  try {
    const userRef = db.ref(`users/${req.user.uid}`);
    const snapshot = await userRef.once('value');
    const profile = snapshot.val() || {};
    const egg = profile.easterEgg || {};

    if (egg.rewardClaimed === true) {
      return res.status(409).json({
        error: true,
        code: 'REWARD_ALREADY_CLAIMED',
        message: 'You already claimed this reward.',
        rewardCode: egg.rewardCode || null
      });
    }

    const stepIndex = Math.max(0, Math.min(parseInt(egg.stepIndex || 0, 10) || 0, EASTER_EGG_STEPS.length));
    const completed = egg.completed === true || stepIndex >= EASTER_EGG_STEPS.length;
    if (!completed) {
      return res.status(400).json({
        error: true,
        code: 'EASTER_EGG_NOT_COMPLETED',
        message: 'Finish all puzzle steps before claiming the reward.'
      });
    }

    const rewardCode = await generateUniquePlusCode();
    const nowIso = new Date().toISOString();

    await db.ref(`plusPurchaseCodes/${rewardCode}`).set({
      code: rewardCode,
      years: 1,
      source: 'easter_egg',
      neverExpires: true,
      expiresAt: null,
      assignedUserId: req.user.uid,
      assignedEmail: req.user.email || null,
      note: 'Easter egg completion reward',
      createdBy: 'system/easter-egg',
      createdAt: nowIso,
      active: true,
      used: false,
      usedBy: null,
      usedAt: null,
      removedAt: null,
      removedBy: null
    });

    await userRef.child('easterEgg').update({
      rewardClaimed: true,
      rewardClaimedAt: nowIso,
      rewardCode
    });

    res.json({
      success: true,
      message: 'Reward claimed! Use this code on the Plus page.',
      code: rewardCode,
      years: 1
    });
  } catch (error) {
    console.error('Error claiming easter egg reward:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Failed to claim reward code' });
  }
});

/**
 * Admin: List Plus requests
 */
app.get('/api/admin/plus/requests', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const snap = await db.ref('plusRequests').once('value');
    const requests = snap.val() || {};
    const list = Object.entries(requests).map(([id, r]) => ({ id, ...r }));
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json({ success: true, requests: list });
  } catch (error) {
    console.error('Error listing plus requests:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error listing plus requests' });
  }
});

async function grantPlusToUser(userId, yearsInt, grantedBy) {
  const userRef = db.ref(`users/${userId}`);
  const snap = await userRef.once('value');
  const user = snap.val();
  if (!user) throw Object.assign(new Error('User profile not found'), { code: 'USER_NOT_FOUND' });

  const existingPlus = user.plus || {};
  if (existingPlus.blocked === true) throw Object.assign(new Error('Plus is blocked for this user'), { code: 'PLUS_BLOCKED' });

  const now = Date.now();
  const yearsMs = yearsInt * 365 * 24 * 60 * 60 * 1000;
  
  // If user already has active Plus (not expired), extend from existing expiry
  // Otherwise, start from now
  let expiresAt;
  if (existingPlus.active === true && existingPlus.expiresAt) {
    const existingExpiryMs = new Date(existingPlus.expiresAt).getTime();
    // If already expired, start from now; otherwise extend from expiry
    const baseMs = existingExpiryMs > now ? existingExpiryMs : now;
    expiresAt = new Date(baseMs + yearsMs).toISOString();
  } else {
    expiresAt = new Date(now + yearsMs).toISOString();
  }
  
  const updatedPlus = {
    ...existingPlus,
    active: true,
    expiresAt,
    blocked: false,
    grantedAt: new Date().toISOString(),
    grantedBy: grantedBy || null,
    showBadge: existingPlus.showBadge !== false,
    updatedAt: new Date().toISOString()
  };

  await userRef.update({ plus: updatedPlus });
  await syncPlusToPlayerForUser(userId).catch(() => null);
  return updatedPlus;
}

async function cancelPlusForUser(userId, cancelledBy, reason = '') {
  const userRef = db.ref(`users/${userId}`);
  const snap = await userRef.once('value');
  const user = snap.val();
  if (!user) throw Object.assign(new Error('User profile not found'), { code: 'USER_NOT_FOUND' });

  const existingPlus = user.plus || {};
  const updatedPlus = {
    ...existingPlus,
    active: false,
    expiresAt: null,
    showBadge: false,
    gradient: null,
    cancelledAt: new Date().toISOString(),
    cancelledBy: cancelledBy || null,
    cancelReason: reason || '',
    updatedAt: new Date().toISOString()
  };

  await userRef.update({ plus: updatedPlus });
  await syncPlusToPlayerForUser(userId).catch(() => null);
  return updatedPlus;
}

/**
 * POST /api/admin/plus/grant
 */
app.post('/api/admin/plus/grant', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const { userId, years } = req.body || {};
    if (!userId) return res.status(400).json({ error: true, code: 'MISSING_DATA', message: 'userId is required' });
    const yearsInt = Math.max(1, Math.min(5, parseInt(years || 1)));
    const plus = await grantPlusToUser(userId, yearsInt, req.user.uid);
    res.json({ success: true, plus });
  } catch (error) {
    console.error('Error granting plus:', error);
    res.status(400).json({ error: true, code: error.code || 'SERVER_ERROR', message: error.message || 'Error granting Plus' });
  }
});

/**
 * POST /api/admin/plus/cancel
 */
app.post('/api/admin/plus/cancel', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const { userId, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: true, code: 'MISSING_DATA', message: 'userId is required' });
    const plus = await cancelPlusForUser(userId, req.user.uid, reason || '');
    res.json({ success: true, plus });
  } catch (error) {
    console.error('Error cancelling plus:', error);
    res.status(400).json({ error: true, code: error.code || 'SERVER_ERROR', message: error.message || 'Error cancelling Plus' });
  }
});

/**
 * POST /api/admin/plus/block - block/unblock plus; blocking also removes perks
 */
app.post('/api/admin/plus/block', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const { userId, blocked, reason } = req.body || {};
    if (!userId) return res.status(400).json({ error: true, code: 'MISSING_DATA', message: 'userId is required' });
    const userRef = db.ref(`users/${userId}`);
    const snap = await userRef.once('value');
    const user = snap.val();
    if (!user) return res.status(404).json({ error: true, code: 'USER_NOT_FOUND', message: 'User profile not found' });

    const existingPlus = user.plus || {};
    const setBlocked = blocked === true;

    let updatedPlus = {
      ...existingPlus,
      blocked: setBlocked,
      blockReason: setBlocked ? (reason || '') : '',
      blockedAt: setBlocked ? new Date().toISOString() : null,
      blockedBy: setBlocked ? req.user.uid : null,
      updatedAt: new Date().toISOString()
    };

    // If blocking, also cancel perks
    if (setBlocked) {
      updatedPlus = {
        ...updatedPlus,
        active: false,
        expiresAt: null,
        showBadge: false,
        gradient: null
      };
    }

    await userRef.update({ plus: updatedPlus });
    await syncPlusToPlayerForUser(userId).catch(() => null);

    res.json({ success: true, plus: updatedPlus });
  } catch (error) {
    console.error('Error blocking plus:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error updating Plus block status' });
  }
});

/**
 * GET /api/admin/plus/codes - List purchase codes
 */
app.get('/api/admin/plus/codes', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const includeRemoved = String(req.query?.includeRemoved || 'false').toLowerCase() === 'true';
    const snapshot = await db.ref('plusPurchaseCodes').once('value');
    const codes = snapshot.val() || {};
    const list = Object.entries(codes)
      .map(([code, entry]) => ({ code, ...entry }))
      .filter((entry) => includeRemoved || !entry.removedAt)
      .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());

    res.json({ success: true, codes: list });
  } catch (error) {
    console.error('Error listing plus codes:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error listing Plus codes' });
  }
});

/**
 * POST /api/admin/plus/codes - Create purchase code
 */
app.post('/api/admin/plus/codes', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const rawCode = req.body?.code;
    const yearsInt = Math.max(1, Math.min(5, parseInt(req.body?.years || 1, 10) || 1));
    const assignedUserId = req.body?.assignedUserId ? String(req.body.assignedUserId).trim() : null;
    const note = req.body?.note ? String(req.body.note).slice(0, 240) : '';

    const code = rawCode ? normalizeSixDigitCode(rawCode) : await generateUniquePlusCode();
    if (!code) {
      return res.status(400).json({ error: true, code: 'INVALID_CODE_FORMAT', message: 'Code must be exactly 6 digits.' });
    }

    const codeRef = db.ref(`plusPurchaseCodes/${code}`);
    const existing = await codeRef.once('value');
    if (existing.exists()) {
      return res.status(409).json({ error: true, code: 'CODE_ALREADY_EXISTS', message: 'This code already exists.' });
    }

    const payload = {
      code,
      years: yearsInt,
      source: 'admin',
      assignedUserId: assignedUserId || null,
      note,
      createdBy: req.user.uid,
      createdAt: new Date().toISOString(),
      active: true,
      used: false,
      usedBy: null,
      usedAt: null,
      removedAt: null,
      removedBy: null
    };

    await codeRef.set(payload);
    await logAdminAction(req, req.user.uid, 'PLUS_CODE_CREATE', assignedUserId || null, {
      code,
      years: yearsInt,
      source: 'admin'
    }).catch(() => null);

    res.json({ success: true, code: payload });
  } catch (error) {
    console.error('Error creating plus code:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error creating Plus code' });
  }
});

/**
 * DELETE /api/admin/plus/codes/:code - Remove purchase code
 */
app.delete('/api/admin/plus/codes/:code', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const code = normalizeSixDigitCode(req.params.code);
    if (!code) {
      return res.status(400).json({ error: true, code: 'INVALID_CODE_FORMAT', message: 'Code must be exactly 6 digits.' });
    }

    const codeRef = db.ref(`plusPurchaseCodes/${code}`);
    const snapshot = await codeRef.once('value');
    const existing = snapshot.val();
    if (!existing) {
      return res.status(404).json({ error: true, code: 'CODE_NOT_FOUND', message: 'Code not found.' });
    }

    await codeRef.update({
      active: false,
      removedAt: new Date().toISOString(),
      removedBy: req.user.uid
    });

    await logAdminAction(req, req.user.uid, 'PLUS_CODE_REMOVE', existing.assignedUserId || null, {
      code
    }).catch(() => null);

    res.json({ success: true, message: 'Code removed successfully.' });
  } catch (error) {
    console.error('Error removing plus code:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error removing Plus code' });
  }
});

/**
 * POST /api/admin/plus/requests/:id/approve - approve a pending request (self or gift)
 */
app.post('/api/admin/plus/requests/:id/approve', verifyAuth, verifyAdmin, requireRecaptcha, async (req, res) => {
  try {
    const { id } = req.params;
    const requestRef = db.ref(`plusRequests/${id}`);
    const snap = await requestRef.once('value');
    const request = snap.val();
    if (!request) return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Request not found' });
    if (request.status !== 'pending') return res.status(400).json({ error: true, code: 'INVALID_STATE', message: 'Request is not pending' });

    const yearsInt = Math.max(1, Math.min(5, parseInt(request.years || 1)));
    let targetUserId = request.requesterUserId;

    if (request.giftUsername) {
      const playerMatch = await findPlayerByUsername(request.giftUsername);
      const linkedUserId = playerMatch?.player?.userId || null;
      if (!linkedUserId) {
        return res.status(400).json({
          error: true,
          code: 'RECIPIENT_NOT_LINKED',
          message: 'Gift recipient must have a linked account (userId) to receive Plus'
        });
      }
      targetUserId = linkedUserId;
    }

    const plus = await grantPlusToUser(targetUserId, yearsInt, req.user.uid);
    await requestRef.update({
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy: req.user.uid,
      appliedToUserId: targetUserId
    });

    res.json({ success: true, plus, appliedToUserId: targetUserId });
  } catch (error) {
    console.error('Error approving plus request:', error);
    res.status(500).json({ error: true, code: error.code || 'SERVER_ERROR', message: error.message || 'Error approving request' });
  }
});

async function cleanupExpiredPlusSubscriptions() {
  const usersRef = db.ref('users');
  const snap = await usersRef.once('value');
  const users = snap.val() || {};
  const now = Date.now();
  let expiredCount = 0;

  for (const [userId, user] of Object.entries(users)) {
    const plus = user?.plus;
    if (!plus || plus.active !== true || !plus.expiresAt) continue;
    const exp = new Date(plus.expiresAt).getTime();
    if (!isFinite(exp)) continue;
    if (exp > now) continue;

    expiredCount++;
    const updatedPlus = {
      ...plus,
      active: false,
      expiresAt: null,
      showBadge: false,
      gradient: null,
      expiredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await usersRef.child(userId).update({ plus: updatedPlus });
    await syncPlusToPlayerForUser(userId).catch(() => null);
  }

  if (expiredCount > 0) {
    console.log(`[PLUS] Cleanup complete: ${expiredCount} expired subscriptions cleared`);
  }
}

// ===== Account Management Routes =====

/**
 * POST /api/account/reload-badges - Reload account badges and lock username
 */
app.post('/api/account/reload-badges', verifyAuth, verifyAdminOrTester, requireRecaptcha, async (req, res) => {
  try {
    console.log('Reload badges request received');
    console.log('Auth user object:', !!req.user);
    console.log('User UID:', req.user?.uid);

    if (!req.user || !req.user.uid) {
      return res.status(401).json({
        error: true,
        code: 'AUTH_ERROR',
        message: 'User not authenticated'
      });
    }

    console.log('Reload badges request for user:', req.user.uid);
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();
    console.log('User profile found:', !!userProfile);

    if (!userProfile) {
      console.error('User profile not found for UID:', req.user.uid);
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User profile not found'
      });
    }

    // Check if user is admin or tier tester
    if (!userProfile.admin && !userProfile.tester) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Only administrators and testers can use this function'
      });
    }

    if (!userProfile.minecraftUsername) {
      return res.status(400).json({
        error: true,
        code: 'USERNAME_NOT_LINKED',
        message: 'Minecraft username must be linked first'
      });
    }

    // Find the player record for this username
    console.log('Looking for player with username:', userProfile.minecraftUsername);
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('username').equalTo(userProfile.minecraftUsername).once('value');
    console.log('Player snapshot exists:', playerSnapshot.exists());

    if (!playerSnapshot.exists()) {
      console.error('Player record not found for username:', userProfile.minecraftUsername);
      return res.status(404).json({
        error: true,
        code: 'PLAYER_NOT_FOUND',
        message: 'Player record not found for linked username'
      });
    }

    const players = playerSnapshot.val();
    const playerId = Object.keys(players)[0];
    const playerRef = playersRef.child(playerId);
    const playerData = players[playerId];
    console.log('Found player data:', !!playerData);

    // Check if the account refreshing badges has admin/tiertester roles
    const accountHasAdmin = userProfile.admin || false;
    const accountHasTierTester = userProfile.tester || false;

    // Update player record with account roles if account has them
    console.log('Account has admin:', accountHasAdmin, 'tierTester:', accountHasTierTester);
    if (accountHasAdmin || accountHasTierTester) {
      const playerUpdates = {
        roles: {
          admin: accountHasAdmin,
          tierTester: accountHasTierTester
        },
        updatedAt: new Date().toISOString()
      };
      console.log('Updating player with:', playerUpdates);
      await playerRef.update(playerUpdates);
      console.log('Player update completed');
    }

    // Update user profile to lock username changes (can only be bypassed by admins)
    const updates = {
      // Lock username changes (can only be bypassed by admins)
      usernameLocked: true,
      badgesReloadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await userRef.update(updates);

    res.json({
      success: true,
      message: 'Account badges reloaded successfully. Username linking has been locked.',
      updates: updates
    });
  } catch (error) {
    console.error('Error reloading account badges:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error reloading account badges'
    });
  }
});

/**
 * POST /api/account/reload-tiers - Reload account tiers to match points
 */
app.post('/api/account/reload-tiers', verifyAuth, verifyAdminOrTester, requireRecaptcha, async (req, res) => {
  try {
    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (!userProfile) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User profile not found'
      });
    }

    // Check if user is admin or tier tester
    if (!userProfile.admin && !userProfile.tester) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Only administrators and testers can use this function'
      });
    }

    // Calculate total points from gamemode points
    const gamemodePoints = userProfile.gamemodePoints || {};
    const totalPoints = Object.values(gamemodePoints).reduce((sum, points) => sum + (points || 0), 0);

    // Update user profile
    const updates = {
      totalPoints: totalPoints,
      tiersReloadedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    await userRef.update(updates);

    res.json({
      success: true,
      message: 'Account tiers reloaded successfully.',
      totalPoints: totalPoints
    });
  } catch (error) {
    console.error('Error reloading account tiers:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error reloading account tiers'
    });
  }
});

// ===== Player Management Routes =====

/**
 * POST /api/players/update-region - Update player region
 */
app.post('/api/players/update-region', verifyAuth, requireRecaptcha, async (req, res) => {
  try {
    const { username, region } = req.body;

    if (!username || !region) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Username and region are required'
      });
    }

    // Find player by username
    const playersRef = db.ref('players');
    const playerSnapshot = await playersRef.orderByChild('username').equalTo(username.trim()).once('value');

    if (!playerSnapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'PLAYER_NOT_FOUND',
        message: 'Player not found'
      });
    }

    // Get player ID and update region
    const players = playerSnapshot.val();
    const playerId = Object.keys(players)[0];

    await playersRef.child(playerId).update({
      region: region.trim(),
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Player region updated successfully'
    });
  } catch (error) {
    console.error('Error updating player region:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating player region'
    });
  }
});

// ===== Player Management Routes =====

/**
 * POST /api/admin/players/:id/roles - Update player roles
 */
app.post('/api/admin/players/:id/roles', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { admin, tester } = req.body;

    if (typeof admin !== 'boolean' || typeof tester !== 'boolean') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'admin and tester must be boolean values'
      });
    }

    // Security audit log
    console.log(`ADMIN ACTION: Updating roles for player ${id}: admin=${admin}, tester=${tester}`);

    const playerRef = db.ref(`players/${id}`);
    const snapshot = await playerRef.once('value');
    const player = snapshot.val();

    if (!player) {
      return res.status(404).json({
        error: true,
        code: 'PLAYER_NOT_FOUND',
        message: 'Player not found'
      });
    }

    const updates = {
      roles: {
        admin: admin,
        tester: tester
      },
      updatedAt: new Date().toISOString()
    };

    await playerRef.update(updates);

    // Log admin action
    await logAdminAction(req, req.user.uid, 'UPDATE_ROLES', id, {
      oldRoles: player.roles || { admin: false, tester: false },
      newRoles: updates.roles
    });

    res.json({
      success: true,
      message: 'Player roles updated successfully',
      playerId: id,
      roles: updates.roles
    });
  } catch (error) {
    console.error('Error updating player roles:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating player roles'
    });
  }
});

// ===== Admin Routes =====

/**
 * GET /api/admin/applications - Get all applications
 */
app.get('/api/admin/applications', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const applicationsRef = db.ref('applications');
    const snapshot = await applicationsRef.once('value');
    const applications = snapshot.val() || {};
    
    const applicationsArray = Object.keys(applications).map(key => ({
      id: key,
      ...applications[key]
    }));
    
    res.json({ applications: applicationsArray });
  } catch (error) {
    console.error('Error fetching applications:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching applications'
    });
  }
});

/**
 * POST /api/admin/applications/:id/approve - Approve application
 */
app.post('/api/admin/applications/:id/approve', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const applicationRef = db.ref(`applications/${id}`);
    const snapshot = await applicationRef.once('value');
    const application = snapshot.val();
    
    if (!application) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Application not found'
      });
    }
    
    // Update user to tier tester
    const userRef = db.ref(`users/${application.userId}`);
    await userRef.update({
      tierTester: true,
      tierTesterApprovedAt: new Date().toISOString()
    });
    
    // Update application
    await applicationRef.update({
      status: 'approved',
      approvedAt: new Date().toISOString(),
      approvedBy: req.user.uid
    });
    
    res.json({ success: true, message: 'Application approved' });
  } catch (error) {
    console.error('Error approving application:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error approving application'
    });
  }
});

/**
 * POST /api/admin/applications/:id/deny - Deny application
 */
app.post('/api/admin/applications/:id/deny', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const applicationRef = db.ref(`applications/${id}`);
    const snapshot = await applicationRef.once('value');
    const application = snapshot.val();
    
    if (!application) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Application not found'
      });
    }
    
    await applicationRef.update({
      status: 'denied',
      deniedAt: new Date().toISOString(),
      deniedBy: req.user.uid
    });
    
    res.json({ success: true, message: 'Application denied' });
  } catch (error) {
    console.error('Error denying application:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error denying application'
    });
  }
});

/**
 * GET /api/admin/security-logs - Get security logs (Admin only)
 */
app.get('/api/admin/security-logs', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { limit = 100, severity, type, userId } = req.query;
    let logs = await listSecurityLogEntries({
      limit: parseInt(limit, 10) || 100,
      userId: userId || null
    });

    // Retired signal: do not show legacy account-sharing IP anomaly logs.
    logs = logs.filter(log => log.type !== 'multiple_ip_addresses');

    // Filter by severity if provided
    if (severity) {
      logs = logs.filter(log => log.severity === severity);
    }

    // Filter by type if provided
    if (type) {
      logs = logs.filter(log => log.type === type);
    }

    res.json({
      success: true,
      logs,
      count: logs.length
    });
  } catch (error) {
    console.error('Error fetching security logs:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching security logs'
    });
  }
});

/**
 * DELETE /api/admin/security-logs/:logId - Remove security log entry (Admin only)
 */
app.delete('/api/admin/security-logs/:logId', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { logId } = req.params;

    const existingLog = await fsRead(`securityLogs/${logId}`) || (await db.ref(`securityLogs/${logId}`).once('value').then((snapshot) => snapshot.val()).catch(() => null));

    if (!existingLog) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Security log not found'
      });
    }

    await deleteSecurityLogEntry(logId);

    await logAdminAction(req, req.user.uid, 'REMOVE_SECURITY_LOG', logId, {
      removedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Security log removed successfully'
    });
  } catch (error) {
    console.error('Error removing security log:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing security log'
    });
  }
});

function appendTimelineEvent(events, event) {
  const timestampMs = parseDateToMs(event?.timestamp);
  if (!timestampMs) return;
  events.push({
    id: `${event.type || 'event'}_${events.length}_${timestampMs}`,
    type: event.type || 'event',
    timestamp: event.timestamp,
    title: event.title || 'Event',
    description: event.description || '',
    metadata: event.metadata || {}
  });
}

function buildQueueInspectorResult(entryA, entryB, profileA = {}, profileB = {}, activeMatches = []) {
  const result = {
    canMatch: false,
    blockers: [],
    sharedSelections: getSharedQueueSelections(entryA || {}, entryB || {}),
    previews: []
  };

  if (!entryA || !entryB) {
    result.blockers.push('Both users must have an active queue entry.');
    return result;
  }

  if (entryA.userId === entryB.userId) {
    result.blockers.push('A user cannot be matched against themselves.');
    return result;
  }

  if (isQueueEntryExpired(entryA) || isQueueEntryExpired(entryB)) {
    result.blockers.push('One or both queue entries are expired.');
  }

  const activeConflict = activeMatches.find((match) => (
    match && !match.finalized && (
      match.playerId === entryA.userId || match.testerId === entryA.userId ||
      match.playerId === entryB.userId || match.testerId === entryB.userId
    )
  ));
  if (activeConflict) {
    result.blockers.push('One or both users already have an active match.');
  }

  if (!isQueueEntryTesterEligible(entryA, profileA) && !isQueueEntryTesterEligible(entryB, profileB)) {
    result.blockers.push('At least one queued user must be tester-eligible.');
  }

  if (!result.sharedSelections.length) {
    result.blockers.push('The queue entries do not share a compatible gamemode and region.');
    return result;
  }

  result.previews = result.sharedSelections.map((selection) => {
    const preview = {
      gamemode: selection.gamemode,
      region: selection.region,
      canMatch: true,
      reasons: [],
      assignment: null
    };

    if (isUserRetiredFromGamemode(profileA, selection.gamemode)) {
      preview.canMatch = false;
      preview.reasons.push(`${entryA.minecraftUsername || 'User A'} is retired from ${selection.gamemode.toUpperCase()}.`);
    }

    if (isUserRetiredFromGamemode(profileB, selection.gamemode)) {
      preview.canMatch = false;
      preview.reasons.push(`${entryB.minecraftUsername || 'User B'} is retired from ${selection.gamemode.toUpperCase()}.`);
    }

    const assignment = resolveQueuedRoleAssignment(entryA, entryB, profileA, profileB, selection.gamemode);
    if (!assignment) {
      preview.canMatch = false;
      preview.reasons.push('Role assignment failed because neither user can legally fill the player slot for this gamemode.');
    } else {
      const serverIP = assignment.player?.serverIP || assignment.tester?.serverIP || null;
      if (!serverIP) {
        preview.canMatch = false;
        preview.reasons.push('No valid server IP is available for the assigned player.');
      }
      preview.assignment = assignment ? {
        type: assignment.assignmentType,
        playerUserId: assignment.player?.userId || null,
        playerUsername: assignment.player?.minecraftUsername || null,
        testerUserId: assignment.tester?.userId || null,
        testerUsername: assignment.tester?.minecraftUsername || null,
        explanation: assignment.explanation || ''
      } : null;
    }

    return preview;
  });

  result.canMatch = result.previews.some((preview) => preview.canMatch);
  if (!result.canMatch && result.previews.length > 0 && result.blockers.length === 0) {
    result.blockers.push('The pair shares selections, but every compatible combination has a legal blocker.');
  }

  return result;
}

app.get('/api/admin/queue-inspector', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'queue:inspect') && !adminHasCapability(req, 'matches:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Queue inspection capability required' });
    }

    const leftUserId = String(req.query.leftUserId || '').trim();
    const rightUserId = String(req.query.rightUserId || '').trim();
    if (!leftUserId || !rightUserId) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'leftUserId and rightUserId are required' });
    }

    const [leftQueueSnapshot, rightQueueSnapshot, leftUserSnapshot, rightUserSnapshot, activeMatchesSnapshot] = await Promise.all([
      db.ref('queue').orderByChild('userId').equalTo(leftUserId).once('value'),
      db.ref('queue').orderByChild('userId').equalTo(rightUserId).once('value'),
      db.ref(`users/${leftUserId}`).once('value'),
      db.ref(`users/${rightUserId}`).once('value'),
      db.ref('matches').orderByChild('status').equalTo('active').once('value')
    ]);

    const leftEntry = Object.values(leftQueueSnapshot.val() || {})[0] || null;
    const rightEntry = Object.values(rightQueueSnapshot.val() || {})[0] || null;
    const leftProfile = leftUserSnapshot.val() || {};
    const rightProfile = rightUserSnapshot.val() || {};
    const activeMatches = Object.values(activeMatchesSnapshot.val() || {});
    const analysis = buildQueueInspectorResult(leftEntry, rightEntry, leftProfile, rightProfile, activeMatches);

    res.json({
      success: true,
      left: leftEntry ? { ...leftEntry, profile: { minecraftUsername: leftProfile.minecraftUsername || null, adminRole: leftProfile.adminRole || null, tester: leftProfile.tester === true } } : null,
      right: rightEntry ? { ...rightEntry, profile: { minecraftUsername: rightProfile.minecraftUsername || null, adminRole: rightProfile.adminRole || null, tester: rightProfile.tester === true } } : null,
      analysis
    });
  } catch (error) {
    console.error('Error inspecting queue pair:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error inspecting queue pair' });
  }
});

app.get('/api/admin/disputes', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'disputes:manage') && !adminHasCapability(req, 'reports:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Dispute management capability required' });
    }

    const statusFilter = String(req.query.status || '').trim().toLowerCase();
    const matchIdFilter = String(req.query.matchId || '').trim();
    const userIdFilter = String(req.query.userId || '').trim();
    const disputesSnapshot = await db.ref('matchDisputes').once('value');
    let disputes = Object.values(disputesSnapshot.val() || {});

    if (statusFilter) {
      disputes = disputes.filter((dispute) => String(dispute?.status || '').toLowerCase() === statusFilter);
    }
    if (matchIdFilter) {
      disputes = disputes.filter((dispute) => dispute?.matchId === matchIdFilter);
    }
    if (userIdFilter) {
      disputes = disputes.filter((dispute) => dispute?.reporterId === userIdFilter || dispute?.opponentId === userIdFilter);
    }

    disputes.sort((a, b) => parseDateToMs(b?.updatedAt) - parseDateToMs(a?.updatedAt));
    res.json({ success: true, disputes });
  } catch (error) {
    console.error('Error fetching admin disputes:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error fetching disputes' });
  }
});

app.post('/api/admin/disputes/:disputeId/status', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'disputes:manage') && !adminHasCapability(req, 'reports:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Dispute management capability required' });
    }

    const { disputeId } = req.params;
    const { status, note } = req.body || {};
    const normalizedStatus = String(status || '').trim().toLowerCase();
    const allowedStatuses = new Set(['open', 'in_review', 'resolved', 'rejected']);
    if (!allowedStatuses.has(normalizedStatus)) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid dispute status' });
    }

    const disputeRef = db.ref(`matchDisputes/${disputeId}`);
    const disputeSnapshot = await disputeRef.once('value');
    const dispute = disputeSnapshot.val();
    if (!dispute) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Dispute not found' });
    }

    const history = Array.isArray(dispute.history) ? dispute.history : [];
    history.push(createDisputeHistoryEntry({
      type: 'status_change',
      actorId: req.user.uid,
      actorRole: 'admin',
      note: String(note || '').trim() || `Status changed to ${normalizedStatus}`,
      metadata: { status: normalizedStatus }
    }));

    await disputeRef.update({
      status: normalizedStatus,
      resolutionNote: String(note || '').trim() || null,
      resolvedBy: req.user.uid,
      updatedAt: new Date().toISOString(),
      history
    });

    await logAdminAction(req, req.user.uid, 'UPDATE_DISPUTE', disputeId, {
      matchId: dispute.matchId,
      status: normalizedStatus
    });

    res.json({ success: true, message: 'Dispute updated' });
  } catch (error) {
    console.error('Error updating dispute status:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error updating dispute' });
  }
});

app.get('/api/admin/matches/:matchId/timeline', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'matches:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Matches view capability required' });
    }

    const { matchId } = req.params;
    const [matchSnapshot, auditEntries, disputesSnapshot] = await Promise.all([
      db.ref(`matches/${matchId}`).once('value'),
      listAuditLogEntries({ limit: 1000 }),
      db.ref('matchDisputes').once('value')
    ]);

    const match = matchSnapshot.val();
    if (!match) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Match not found' });
    }

    const timeline = [];
    const queueMeta = match.queueMeta || {};
    const roleAssignment = match.roleAssignment || {};

    if (queueMeta.playerJoinedQueueAt) {
      appendTimelineEvent(timeline, {
        type: 'queue_join',
        timestamp: queueMeta.playerJoinedQueueAt,
        title: 'Player Joined Queue',
        description: `${match.playerUsername || 'Player'} entered the queue.`,
        metadata: { role: 'player', source: queueMeta.playerQueueSource || null }
      });
    }
    if (queueMeta.testerJoinedQueueAt) {
      appendTimelineEvent(timeline, {
        type: 'queue_join',
        timestamp: queueMeta.testerJoinedQueueAt,
        title: 'Tester Joined Queue',
        description: `${match.testerUsername || 'Tester'} entered the queue.`,
        metadata: { role: 'tester', source: queueMeta.testerQueueSource || null }
      });
    }

    appendTimelineEvent(timeline, {
      type: 'match_created',
      timestamp: match.createdAt,
      title: 'Match Created',
      description: `Match created for ${match.gamemode?.toUpperCase() || 'unknown gamemode'} in ${match.region || 'unknown region'}.`,
      metadata: {
        serverIP: match.serverIP || null,
        forceCreated: match.forceCreated === true
      }
    });

    if (roleAssignment.explanation) {
      appendTimelineEvent(timeline, {
        type: 'role_assignment',
        timestamp: match.createdAt,
        title: 'Role Assignment',
        description: roleAssignment.explanation,
        metadata: {
          type: roleAssignment.type || null,
          randomized: roleAssignment.randomized === true,
          serverSelectionSource: roleAssignment.serverSelectionSource || queueMeta.serverSelectionSource || null
        }
      });
    }

    if (match.participants?.[match.playerId]?.joinedAt) {
      appendTimelineEvent(timeline, {
        type: 'page_join',
        timestamp: match.participants[match.playerId].joinedAt,
        title: 'Player Opened Match Page',
        description: `${match.playerUsername || 'Player'} joined the match page.`
      });
    }
    if (match.participants?.[match.testerId]?.joinedAt) {
      appendTimelineEvent(timeline, {
        type: 'page_join',
        timestamp: match.participants[match.testerId].joinedAt,
        title: 'Tester Opened Match Page',
        description: `${match.testerUsername || 'Tester'} joined the match page.`
      });
    }
    if (match.countdownStartedAt) {
      appendTimelineEvent(timeline, {
        type: 'countdown_started',
        timestamp: match.countdownStartedAt,
        title: 'Start Countdown Began',
        description: 'Both participants were present, so the start countdown began.'
      });
    }
    if (match.matchStartedAt) {
      appendTimelineEvent(timeline, {
        type: 'match_started',
        timestamp: match.matchStartedAt,
        title: 'Match Started',
        description: 'The match was marked as started.'
      });
    }
    if (match.finalizedAt) {
      appendTimelineEvent(timeline, {
        type: 'match_finalized',
        timestamp: match.finalizedAt,
        title: 'Match Finalized',
        description: match.finalizationData?.type
          ? `Finalized as ${String(match.finalizationData.type).replace(/_/g, ' ')}.`
          : 'Match finalized.',
        metadata: match.finalizationData || {}
      });
    }
    if (match.revertedAt) {
      appendTimelineEvent(timeline, {
        type: 'match_reverted',
        timestamp: match.revertedAt,
        title: 'Ratings Reverted',
        description: 'An admin reverted the rating changes for this match.',
        metadata: { revertedBy: match.revertedBy || null }
      });
    }

    const disputeList = Object.values(disputesSnapshot.val() || {}).filter((dispute) => dispute?.matchId === matchId);
    disputeList.forEach((dispute) => {
      appendTimelineEvent(timeline, {
        type: 'dispute_created',
        timestamp: dispute.createdAt,
        title: 'Dispute Opened',
        description: `${dispute.reporterUsername || 'A participant'} opened a dispute.`,
        metadata: {
          disputeId: dispute.disputeId,
          status: dispute.status,
          category: dispute.category
        }
      });

      (Array.isArray(dispute.history) ? dispute.history : []).forEach((historyEntry) => {
        appendTimelineEvent(timeline, {
          type: `dispute_${historyEntry.type || 'update'}`,
          timestamp: historyEntry.timestamp,
          title: 'Dispute Update',
          description: historyEntry.note || 'Dispute history updated.',
          metadata: {
            disputeId: dispute.disputeId,
            actorId: historyEntry.actorId || null,
            actorRole: historyEntry.actorRole || null,
            status: historyEntry.metadata?.status || dispute.status
          }
        });
      });
    });

    const matchingAuditEntries = auditEntries.filter((entry) => (
      entry?.targetUserId === matchId || entry?.details?.matchId === matchId
    ));
    matchingAuditEntries.forEach((entry) => {
      appendTimelineEvent(timeline, {
        type: 'admin_intervention',
        timestamp: entry.timestamp,
        title: `Admin Action: ${String(entry.action || 'UNKNOWN').replace(/_/g, ' ')}`,
        description: `Admin ${entry.adminUid || 'unknown'} performed ${String(entry.action || 'an action').replace(/_/g, ' ').toLowerCase()}.`,
        metadata: entry.details || {}
      });
    });

    timeline.sort((a, b) => parseDateToMs(a.timestamp) - parseDateToMs(b.timestamp));
    res.json({ success: true, matchId, timeline });
  } catch (error) {
    console.error('Error fetching match timeline:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error fetching match timeline' });
  }
});

/**
 * GET /api/admin/matches - Get matches with filters (Admin only)
 */
app.get('/api/admin/matches', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'matches:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Matches view capability required' });
    }

    const { limit = 100, status, gamemode, search } = req.query;

    const matchesRef = db.ref('matches');
    const snapshot = await matchesRef.once('value');
    const matchMap = snapshot.val() || {};

    let matches = Object.keys(matchMap).map(id => ({
      id,
      ...matchMap[id]
    }));

    if (status) {
      matches = matches.filter(m => (m.status || '').toLowerCase() === String(status).toLowerCase());
    }

    if (gamemode) {
      matches = matches.filter(m => (m.gamemode || '').toLowerCase() === String(gamemode).toLowerCase());
    }

    if (search) {
      const q = String(search).toLowerCase();
      matches = matches.filter(m =>
        (m.id || '').toLowerCase().includes(q) ||
        (m.playerId || '').toLowerCase().includes(q) ||
        (m.testerId || '').toLowerCase().includes(q) ||
        (m.playerUsername || '').toLowerCase().includes(q) ||
        (m.testerUsername || '').toLowerCase().includes(q)
      );
    }

    const safeLimit = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
    matches.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    matches = matches.slice(0, safeLimit);

    res.json({
      success: true,
      matches,
      count: matches.length
    });
  } catch (error) {
    console.error('Error fetching admin matches:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching admin matches'
    });
  }
});

/**
 * DELETE /api/admin/matches/:matchId - Delete match (Admin only)
 */
app.delete('/api/admin/matches/:matchId', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'matches:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Matches manage capability required' });
    }

    const { matchId } = req.params;
    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');

    if (!snapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    const match = snapshot.val() || {};
    await matchRef.remove();

    await logAdminAction(req, req.user.uid, 'DELETE_MATCH', matchId, {
      playerId: match.playerId || null,
      testerId: match.testerId || null,
      gamemode: match.gamemode || null
    });

    res.json({
      success: true,
      message: 'Match deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting admin match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error deleting match'
    });
  }
});

/**
 * POST /api/admin/matches/:matchId/revert - Revert rating changes for a finalized match (Admin only)
 */
app.post('/api/admin/matches/:matchId/revert', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'matches:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Matches manage capability required' });
    }

    const { matchId } = req.params;

    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();

    if (!match) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Match not found' });
    }

    if (!match.finalized) {
      return res.status(400).json({ error: true, code: 'NOT_FINALIZED', message: 'Match is not finalized' });
    }

    if (match.reverted) {
      return res.status(400).json({ error: true, code: 'ALREADY_REVERTED', message: 'Match ratings have already been reverted' });
    }

    const ratingChanges = match.finalizationData?.ratingChanges;
    if (!ratingChanges) {
      return res.status(400).json({ error: true, code: 'NO_RATING_DATA', message: 'No rating change data found — cannot revert a draw or unscored match' });
    }

    const { playerRatingChange, testerRatingChange, playerNewRating, testerNewRating } = ratingChanges;
    const gamemode = match.gamemode;

    // Reverse: old rating = new rating - change
    const playerOldRating = (playerNewRating ?? 0) - (playerRatingChange ?? 0);
    const testerOldRating = (testerNewRating ?? 0) - (testerRatingChange ?? 0);

    // Apply reversal to both player records
    const playersRef = db.ref('players');
    for (const { userId, oldRating } of [
      { userId: match.playerId, oldRating: playerOldRating },
      { userId: match.testerId, oldRating: testerOldRating }
    ]) {
      if (!userId) continue;
      const pSnap = await playersRef.orderByChild('userId').equalTo(userId).once('value');
      const pMap = pSnap.val() || {};
      const playerId = Object.keys(pMap).find(k => pMap[k].userId === userId);
      if (!playerId) continue;

      const playerRef = playersRef.child(playerId);
      const player = pMap[playerId];

      const gamemodeRatings = { ...(player.gamemodeRatings || {}), [gamemode]: oldRating };
      const overallRating = calculateOverallRating(gamemodeRatings);
      const gamemodeMatchCount = { ...(player.gamemodeMatchCount || {}) };
      if (gamemodeMatchCount[gamemode] > 0) gamemodeMatchCount[gamemode]--;

      await playerRef.update({ gamemodeRatings, overallRating, gamemodeMatchCount });
    }

    // Mark match as reverted (keep the record, just flag it)
    await matchRef.update({
      reverted: true,
      revertedAt: new Date().toISOString(),
      revertedBy: req.user.uid
    });

    // Invalidate players cache
    playersCache.data = null;
    playersCache.updatedAt = 0;

    await logAdminAction(req, req.user.uid, 'REVERT_MATCH', matchId, {
      playerId: match.playerId,
      testerId: match.testerId,
      gamemode,
      playerRatingChange,
      testerRatingChange
    });

    res.json({
      success: true,
      message: 'Rating changes reverted successfully',
      playerOldRating,
      testerOldRating
    });
  } catch (error) {
    console.error('Error reverting match:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: error.message || 'Error reverting match' });
  }
});

/**
 * POST /api/admin/matches/:matchId/finalize - Finalize match (Admin only)
 */
app.post('/api/admin/matches/:matchId/finalize', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'matches:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Matches manage capability required' });
    }

    const { matchId } = req.params;
    const { playerScore, testerScore } = req.body;

    const matchRef = db.ref(`matches/${matchId}`);
    const snapshot = await matchRef.once('value');
    const match = snapshot.val();

    if (!match) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Match not found'
      });
    }

    if (match.finalized) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_FINALIZED',
        message: 'Match has already been finalized'
      });
    }

    if (typeof playerScore !== 'number' || typeof testerScore !== 'number') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'playerScore and testerScore must be numbers'
      });
    }

    if (playerScore < 0 || testerScore < 0 || (playerScore + testerScore) < 1) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Invalid match scores'
      });
    }

    if (playerScore === testerScore) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Ties are not allowed. One player must win.'
      });
    }

    const firstTo = match.firstTo || getFirstToForGamemode(match.gamemode);
    if (playerScore !== firstTo && testerScore !== firstTo) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid score for ${match.gamemode}. Winner must reach ${firstTo}.`
      });
    }

    const ratingChanges = await handleManualFinalization(match, { playerScore, testerScore });

    const finalizedAt = new Date().toISOString();
    await matchRef.update({
      finalized: true,
      finalizedAt,
      status: 'ended',
      finalizationData: {
        type: 'elo_rating',
        playerScore,
        testerScore,
        ratingChanges,
        playerUsername: match.playerUsername,
        gamemode: match.gamemode,
        adminFinalized: true,
        finalizedBy: req.user.uid
      }
    });

    await createNotification(match.playerId, {
      type: 'match_finalized',
      title: 'Match Finalized',
      message: `Your ${match.gamemode} match has been finalized. Rating: ${ratingChanges.playerNewRating} (${ratingChanges.playerRatingChange >= 0 ? '+' : ''}${ratingChanges.playerRatingChange})`,
      matchId,
      gamemode: match.gamemode
    });

    const userRef = db.ref(`users/${match.playerId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};
    const lastTested = userData.lastTested || {};
    lastTested[match.gamemode] = finalizedAt;
    await userRef.update({ lastTested });

    const durationMs = match.createdAt
      ? Math.max(0, new Date(finalizedAt).getTime() - new Date(match.createdAt).getTime())
      : 0;
    fsWrite(`matchMetrics/${match.matchId || matchId}`, {
      matchId: match.matchId || matchId,
      playerId: match.playerId,
      testerId: match.testerId,
      gamemode: match.gamemode,
      durationMs,
      playerScore,
      testerScore,
      createdAt: match.createdAt,
      finalizedAt
    }, false).catch(() => {});

    computeAndStoreSecurityScore(match.playerId).catch(() => {});
    computeAndStoreSecurityScore(match.testerId).catch(() => {});

    await Promise.all([
      requeueUserAfterFinalizedMatch(match, match.playerId, 'player'),
      requeueUserAfterFinalizedMatch(match, match.testerId, 'tester')
    ]);

    await logAdminAction(req, req.user.uid, 'FINALIZE_MATCH', matchId, {
      playerId: match.playerId,
      testerId: match.testerId,
      gamemode: match.gamemode,
      playerScore,
      testerScore
    });

    res.json({
      success: true,
      message: 'Match finalized successfully',
      finalizationData: {
        type: 'elo_rating',
        playerScore,
        testerScore,
        ratingChanges,
        playerUsername: match.playerUsername,
        gamemode: match.gamemode
      }
    });
  } catch (error) {
    console.error('Error finalizing admin match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: error.message || 'Error finalizing match'
    });
  }
});

/**
 * GET /api/admin/flagged-accounts - Get flagged accounts (Admin only)
 */
app.get('/api/admin/flagged-accounts', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val() || {};
    
    const flaggedAccounts = Object.keys(users)
      .filter(uid => users[uid].flaggedForReview)
      .map(uid => ({
        userId: uid,
        email: users[uid].email,
        minecraftUsername: users[uid].minecraftUsername,
        flaggedAt: users[uid].flaggedAt,
        flagReason: users[uid].flagReason,
        flagCount: users[uid].flagCount
      }));

    res.json({
      success: true,
      flaggedAccounts,
      count: flaggedAccounts.length
    });
  } catch (error) {
    console.error('Error fetching flagged accounts:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching flagged accounts'
    });
  }
});

/**
 * POST /api/admin/flagged-accounts/:userId/unflag - Unflag an account (Admin only)
 */
app.post('/api/admin/flagged-accounts/:userId/unflag', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const userData = await getStoredUserProfile(userId);

    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    if (!userData.flaggedForReview) {
      return res.status(400).json({
        error: true,
        code: 'NOT_FLAGGED',
        message: 'Account is not flagged'
      });
    }

    await userRef.update({
      flaggedForReview: null,
      flaggedAt: null,
      flagReason: null,
      flagCount: null,
      unflaggedAt: new Date().toISOString(),
      unflaggedBy: req.user.uid
    });

    res.json({
      success: true,
      message: 'Account unflagged successfully'
    });
  } catch (error) {
    console.error('Error unflagging account:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error unflagging account'
    });
  }
});

/**
 * GET /api/admin/blacklist - Get blacklist
 */
app.get('/api/admin/blacklist', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist view capability required' });
    }

    const { limit: safeLimit, page: safePage } = parsePaginationParams(req.query, 25, 200);
    const safeQ = sanitizeSearchQuery(req.query.q, 120);
    const includeExpired = parseBooleanParam(req.query.includeExpired, false);
    const activeOnly = parseBooleanParam(req.query.activeOnly, false);

    const blacklistRef = db.ref('blacklist');
    const snapshot = await blacklistRef.once('value');
    const blacklist = snapshot.val() || {};

    let blacklistArray = buildBlacklistEntries(blacklist);

    if (!includeExpired) {
      blacklistArray = blacklistArray.filter(entry => entry.active);
    }
    if (activeOnly) {
      blacklistArray = blacklistArray.filter(entry => entry.active);
    }
    if (safeQ) {
      const qLower = safeQ.toLowerCase();
      blacklistArray = blacklistArray.filter(entry => {
        return [entry.username, entry.userId, entry.reason].some(v => String(v || '').toLowerCase().includes(qLower));
      });
    }

    const total = blacklistArray.length;
    const start = (safePage - 1) * safeLimit;
    const paginated = blacklistArray.slice(start, start + safeLimit);
    
    res.json({
      blacklist: paginated,
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    });
  } catch (error) {
    console.error('Error fetching blacklist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching blacklist'
    });
  }
});

/**
 * GET /api/public/blacklist - Public blacklist feed
 */
app.get('/api/public/blacklist', async (req, res) => {
  try {
    const { limit: safeLimit, page: safePage } = parsePaginationParams(req.query, 25, 100);
    const includeExpired = parseBooleanParam(req.query.includeExpired, false);

    const snapshot = await db.ref('blacklist').once('value');
    const blacklist = snapshot.val() || {};
    let blacklistArray = buildBlacklistEntries(blacklist);

    if (!includeExpired) {
      blacklistArray = blacklistArray.filter((entry) => entry.active);
    }

    const total = blacklistArray.length;
    const start = (safePage - 1) * safeLimit;
    const entries = blacklistArray.slice(start, start + safeLimit);

    res.json({
      success: true,
      entries,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    });
  } catch (error) {
    console.error('Error fetching public blacklist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching blacklist feed'
    });
  }
});

/**
 * POST /api/admin/blacklist - Add to blacklist
 */
app.post('/api/admin/blacklist', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { username, userId, reason, durationHours, disabledFunctions } = req.body;
    
    if (!username && !userId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'username or userId is required'
      });
    }

    let resolvedUsername = String(username || '').trim();
    let resolvedUserId = String(userId || '').trim() || null;
    let resolvedMinecraftUUID = null;
    if (resolvedUserId && !resolvedUsername) {
      const userSnapshot = await db.ref(`users/${resolvedUserId}`).once('value');
      const userData = userSnapshot.val() || {};
      resolvedUsername = String(userData.minecraftUsername || '').trim();
      resolvedMinecraftUUID = normalizeMinecraftUUID(userData.minecraftUUID || userData.pendingMinecraftUUID);
      if (!resolvedUsername) {
        return res.status(400).json({
          error: true,
          code: 'MISSING_USERNAME',
          message: 'Target user does not have a linked minecraft username'
        });
      }
    }

    if (!resolvedUsername) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'username could not be resolved'
      });
    }

    if (resolvedUsername && !resolvedMinecraftUUID) {
      const mojangProfile = await fetchMojangProfile(resolvedUsername).catch(() => null);
      if (mojangProfile) {
        resolvedUsername = mojangProfile.username;
        resolvedMinecraftUUID = mojangProfile.uuid;
      }
    }

    if (!resolvedMinecraftUUID && resolvedUserId) {
      const playerMatch = await findPlayerByMinecraftIdentity({ username: resolvedUsername });
      resolvedMinecraftUUID = normalizeMinecraftUUID(playerMatch?.player?.minecraftUUID);
    }

    // Check for profanity in reason if provided
    if (reason && reason.trim()) {
      try {
        const hasProfanity = await containsProfanity(reason.trim());
        if (hasProfanity) {
          return res.status(400).json({
            error: true,
            code: 'PROFANITY_DETECTED',
            message: 'Blacklist reason contains inappropriate language and cannot be used'
          });
        }
      } catch (error) {
        // If profanity filter is unavailable, block the request
        return res.status(503).json({
          error: true,
          code: 'FILTER_UNAVAILABLE',
          message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
        });
      }
    }

    const safeDurationHours = Number(durationHours) > 0 ? Math.min(Number(durationHours), 24 * 365) : 0;
    const expiresAt = safeDurationHours > 0
      ? new Date(Date.now() + (safeDurationHours * 60 * 60 * 1000)).toISOString()
      : null;

    const normalizedDisabledFunctions = (disabledFunctions && typeof disabledFunctions === 'object')
      ? Object.fromEntries(Object.entries(disabledFunctions).map(([k, v]) => [k, v === true]))
      : {};
    
    const blacklistRef = db.ref('blacklist');
    const newEntryRef = blacklistRef.push();
    const payload = {
      username: resolvedUsername,
      userId: resolvedUserId,
      minecraftUUID: resolvedMinecraftUUID,
      reason: reason || 'No reason provided',
      addedAt: new Date().toISOString(),
      addedBy: req.user.uid,
      expiresAt,
      disabledFunctions: normalizedDisabledFunctions
    };

    await newEntryRef.set(payload);
    blacklistCache.data = null; // Invalidate cache

    if (resolvedUserId) {
      await addUserModerationHistoryEntry(resolvedUserId, {
        type: 'blacklist_added',
        minecraftUUID: resolvedMinecraftUUID,
        reason: payload.reason,
        temporary: Boolean(expiresAt),
        expiresAt,
        disabledFunctions: normalizedDisabledFunctions,
        by: req.user.uid,
        at: new Date().toISOString()
      });
    }

    await logAdminAction(req, req.user.uid, 'BLACKLIST_ADD', resolvedUserId, {
      username: resolvedUsername,
      minecraftUUID: resolvedMinecraftUUID,
      reason: payload.reason,
      expiresAt,
      disabledFunctions: normalizedDisabledFunctions
    });

    // Send inbox notification about the blacklist
    if (resolvedUserId) {
      const durText = expiresAt
        ? `Your account has been temporarily restricted until ${new Date(expiresAt).toLocaleDateString()}. Your access will be automatically restored after this date.`
        : 'Your account has been permanently restricted from the platform.';

      await sendInboxMessage(resolvedUserId, {
        title: 'Account Restricted',
        message: `Your account has been restricted.\n\n${durText}\n\nReason: ${payload.reason}\n\nIf you believe this action was taken in error, please contact support.`,
        type: 'blacklist',
        from: 'MC Leaderboards Moderation',
        reason: payload.reason
      });
    }
    
    // Check and terminate any active matches for this blacklisted user
    await checkAndTerminateBlacklistedMatches();
    
    res.json({ success: true, message: 'Added to blacklist', id: newEntryRef.key });
  } catch (error) {
    console.error('Error adding to blacklist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error adding to blacklist'
    });
  }
});

/**
 * DELETE /api/admin/blacklist/:id - Remove from blacklist
 */
app.delete('/api/admin/blacklist/:id', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { id } = req.params;
    const blacklistRef = db.ref(`blacklist/${id}`);
    const snapshot = await blacklistRef.once('value');
    const entry = snapshot.val() || null;
    await blacklistRef.remove();
    blacklistCache.data = null; // Invalidate cache

    if (entry?.userId) {
      await addUserModerationHistoryEntry(entry.userId, {
        type: 'blacklist_removed',
        reason: entry.reason || 'Removed by admin',
        by: req.user.uid,
        at: new Date().toISOString()
      });

      // Send inbox message notifying user their restriction has been lifted
      await sendInboxMessage(entry.userId, {
        title: 'Account Restriction Lifted',
        message: 'Your account restriction has been removed. You now have full access to all MC Leaderboards features.\n\nPlease make sure to follow our community rules to avoid future restrictions.\n\nWelcome back!',
        type: 'system',
        from: 'MC Leaderboards Moderation',
        metadata: { event: 'blacklist_removed' }
      });
    }

    await logAdminAction(req, req.user.uid, 'BLACKLIST_REMOVE', entry?.userId || null, {
      blacklistId: id,
      username: entry?.username || null
    });
    
    res.json({ success: true, message: 'Removed from blacklist' });
  } catch (error) {
    console.error('Error removing from blacklist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing from blacklist'
    });
  }
});

/**
 * POST /api/admin/bulk-punish - Bulk punish accounts: revert matches, send inbox messages, blacklist
 */
app.post('/api/admin/bulk-punish', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { usernames, reason, ban, banFirebase, blacklistUsernames, revertMatches, notifyOpponents, durationHours } = req.body;

    if (!Array.isArray(usernames) || usernames.length === 0) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'At least one username is required' });
    }

    if (usernames.length > 50) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Maximum 50 usernames per request' });
    }

    // Support both old 'ban' parameter and new granular options
    const shouldBanFirebase = banFirebase !== undefined ? banFirebase : ban !== false;
    const shouldBlacklistUsernames = blacklistUsernames !== undefined ? blacklistUsernames : ban !== false;
    const shouldRevertMatches = revertMatches !== undefined ? revertMatches : true;
    const shouldNotifyOpponents = notifyOpponents !== undefined ? notifyOpponents : true;

    const safeReason = String(reason || 'Bulk punishment').trim().substring(0, 500);
    const safeDuration = Number(durationHours) > 0 ? Math.min(Number(durationHours), 24 * 365) : 0;
    const expiresAt = safeDuration > 0 ? new Date(Date.now() + safeDuration * 60 * 60 * 1000).toISOString() : null;

    const results = { 
      accountsBanned: 0,
      matchesReverted: 0, 
      messagesSent: 0, 
      accountsBlacklisted: 0, 
      errors: [] 
    };
    const affectedOpponents = new Map(); // opponentUserId -> [matchIds]

    // Load all users, players, and matches once
    const [usersSnap, playersSnap, matchesSnap] = await Promise.all([
      db.ref('users').once('value'),
      db.ref('players').once('value'),
      db.ref('matches').once('value')
    ]);
    const allUsers = usersSnap.val() || {};
    const allPlayers = playersSnap.val() || {};
    const allMatches = matchesSnap.val() || {};

    // Build lookup maps
    const usernameToUserId = {};
    for (const [uid, user] of Object.entries(allUsers)) {
      if (user.minecraftUsername) {
        usernameToUserId[user.minecraftUsername.toLowerCase()] = uid;
      }
    }

    const userIdToPlayerKey = {};
    for (const [key, player] of Object.entries(allPlayers)) {
      if (player.userId) {
        userIdToPlayerKey[player.userId] = key;
      }
    }

    // Normalize target usernames
    const targetUsernames = usernames.map(u => String(u).trim()).filter(Boolean);
    const targetUsernamesLower = new Set(targetUsernames.map(u => u.toLowerCase()));

    // Find all user IDs for the target usernames
    const targetUserIds = new Set();
    for (const uname of targetUsernamesLower) {
      if (usernameToUserId[uname]) {
        targetUserIds.add(usernameToUserId[uname]);
      }
    }

    // Ban Firebase accounts if requested
    if (shouldBanFirebase) {
      for (const uid of targetUserIds) {
        try {
          await db.ref(`users/${uid}`).update({
            banned: true,
            bannedAt: new Date().toISOString(),
            bannedBy: req.user.uid,
            banExpires: 'permanent',
            banReason: safeReason
          });

          await logAdminAction(req, req.user.uid, 'BAN_USER', uid, {
            reason: safeReason,
            isPermanent: true,
            fromBulkPunish: true
          });

          results.accountsBanned++;
        } catch (err) {
          results.errors.push(`Failed to ban Firebase account ${uid}: ${err.message}`);
        }
      }
    }

    // Find and revert all finalized matches if requested
    if (shouldRevertMatches) {
      for (const [matchId, match] of Object.entries(allMatches)) {
        if (!match.finalized || match.reverted) continue;

        const playerIsTarget = targetUserIds.has(match.playerId) ||
          targetUsernamesLower.has((match.playerUsername || '').toLowerCase());
        const testerIsTarget = targetUserIds.has(match.testerId) ||
          targetUsernamesLower.has((match.testerUsername || '').toLowerCase());

        if (!playerIsTarget && !testerIsTarget) continue;

        // Revert rating changes if they exist
        const ratingChanges = match.finalizationData?.ratingChanges;
        if (ratingChanges) {
          try {
            const { playerRatingChange, testerRatingChange, playerNewRating, testerNewRating } = ratingChanges;
            const gamemode = match.gamemode;
            const playerOldRating = (playerNewRating ?? 0) - (playerRatingChange ?? 0);
            const testerOldRating = (testerNewRating ?? 0) - (testerRatingChange ?? 0);

            for (const { userId, oldRating } of [
              { userId: match.playerId, oldRating: playerOldRating },
              { userId: match.testerId, oldRating: testerOldRating }
            ]) {
              if (!userId) continue;
              const playerKey = userIdToPlayerKey[userId];
              if (!playerKey) continue;
              const player = allPlayers[playerKey];
              const gamemodeRatings = { ...(player.gamemodeRatings || {}), [gamemode]: oldRating };
              const overallRating = calculateOverallRating(gamemodeRatings);
              const gamemodeMatchCount = { ...(player.gamemodeMatchCount || {}) };
              if (gamemodeMatchCount[gamemode] > 0) gamemodeMatchCount[gamemode]--;

              await db.ref(`players/${playerKey}`).update({ gamemodeRatings, overallRating, gamemodeMatchCount });
              // Update our local copy for subsequent reverts
              player.gamemodeRatings = gamemodeRatings;
              player.gamemodeMatchCount = gamemodeMatchCount;
            }

            await db.ref(`matches/${matchId}`).update({
              reverted: true,
              revertedAt: new Date().toISOString(),
              revertedBy: req.user.uid,
              revertReason: safeReason
            });

            results.matchesReverted++;
          } catch (err) {
            results.errors.push(`Failed to revert match ${matchId}: ${err.message}`);
          }
        }

        // Track opponents for notification (only when reverting matches)
        if (shouldRevertMatches) {
          const opponentId = playerIsTarget ? match.testerId : match.playerId;
          if (opponentId && !targetUserIds.has(opponentId)) {
            if (!affectedOpponents.has(opponentId)) affectedOpponents.set(opponentId, []);
            affectedOpponents.get(opponentId).push(matchId);
          }
        }
      }
    }

    // Send inbox messages to all affected opponents if requested
    if (shouldNotifyOpponents && shouldRevertMatches && affectedOpponents.size > 0) {
      for (const [opponentId, matchIds] of affectedOpponents.entries()) {
        try {
          await sendInboxMessage(opponentId, {
            title: 'Match Ratings Reverted',
            message: `${matchIds.length} match(es) you participated in have had their ratings reverted due to policy enforcement against another player.\n\nYour rating has been restored to its pre-match value. No action is required from you.\n\nReason: ${safeReason}`,
            type: 'system',
            from: 'MC Leaderboards Moderation',
            metadata: { event: 'bulk_punish_revert', matchIds, reason: safeReason }
          });
          results.messagesSent++;
        } catch (err) {
          results.errors.push(`Failed to message user ${opponentId}: ${err.message}`);
        }
      }
    }

    // Send inbox messages to the punished players if requested
    if (shouldNotifyOpponents) {
      for (const uid of targetUserIds) {
        try {
          let message = 'Your account has been subject to administrative action.\n\n';
          
          if (shouldBanFirebase) {
            message += 'Your account has been permanently banned.\n';
          }
          if (shouldBlacklistUsernames) {
            const durText = expiresAt
              ? `for ${Math.ceil((new Date(expiresAt) - new Date()) / (1000 * 60 * 60))} hours`
              : 'permanently';
            message += `Your Minecraft username has been blacklisted ${durText}.\n`;
          }
          if (shouldRevertMatches) {
            message += 'All your finalized match ratings have been reverted.\n';
          }

          message += `\nReason: ${safeReason}\n\nIf you believe this was in error, please contact support.`;

          await sendInboxMessage(uid, {
            title: 'Administrative Action Taken',
            message,
            type: 'admin_action',
            from: 'MC Leaderboards Moderation',
            reason: safeReason
          });
          results.messagesSent++;
        } catch (err) {
          results.errors.push(`Failed to message target ${uid}: ${err.message}`);
        }
      }
    }

    // Blacklist accounts if requested
    if (shouldBlacklistUsernames) {
      for (const uname of targetUsernames) {
        try {
          const resolvedUserId = usernameToUserId[uname.toLowerCase()] || null;
          let resolvedMinecraftUUID = null;

          const mojangProfile = await fetchMojangProfile(uname).catch(() => null);
          if (mojangProfile) {
            resolvedMinecraftUUID = mojangProfile.uuid;
          }

          const blacklistRef = db.ref('blacklist');
          const newEntryRef = blacklistRef.push();
          await newEntryRef.set({
            username: mojangProfile?.username || uname,
            userId: resolvedUserId,
            minecraftUUID: resolvedMinecraftUUID,
            reason: safeReason,
            addedAt: new Date().toISOString(),
            addedBy: req.user.uid,
            expiresAt,
            disabledFunctions: {}
          });

          if (resolvedUserId) {
            await addUserModerationHistoryEntry(resolvedUserId, {
              type: 'blacklist_added',
              reason: safeReason,
              temporary: Boolean(expiresAt),
              expiresAt,
              by: req.user.uid,
              at: new Date().toISOString()
            });
          }

          results.accountsBlacklisted++;
        } catch (err) {
          results.errors.push(`Failed to blacklist ${uname}: ${err.message}`);
        }
      }

      blacklistCache.data = null;
      await checkAndTerminateBlacklistedMatches();
    }

    playersCache.data = null;
    playersCache.updatedAt = 0;

    await logAdminAction(req, req.user.uid, 'BULK_PUNISH', null, {
      usernames: targetUsernames,
      reason: safeReason,
      banFirebase: shouldBanFirebase,
      blacklistUsernames: shouldBlacklistUsernames,
      revertMatches: shouldRevertMatches,
      notifyOpponents: shouldNotifyOpponents,
      durationHours: safeDuration,
      results: {
        accountsBanned: results.accountsBanned,
        matchesReverted: results.matchesReverted,
        messagesSent: results.messagesSent,
        accountsBlacklisted: results.accountsBlacklisted
      }
    });

    res.json({ success: true, results });
  } catch (error) {
    console.error('Error executing bulk punishment:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: error.message || 'Error executing bulk punishment' });
  }
});

/**
 * GET /api/admin/users - Get all users
 */
app.get('/api/admin/users', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users view capability required' });
    }

    const { limit: safeLimit, page: safePage } = parsePaginationParams(req.query, 25, 200);
    const safeQ = sanitizeSearchQuery(req.query.q, 120);
    const role = sanitizeSearchQuery(String(req.query.role || 'all'), 20).toLowerCase();
    const status = sanitizeSearchQuery(String(req.query.status || 'all'), 20).toLowerCase();

    const usersRef = db.ref('users');
    const snapshot = await usersRef.once('value');
    const users = snapshot.val() || {};
    
    let usersArray = Object.keys(users).map(key => ({
      id: key,
      ...users[key]
    }));

    if (safeQ) {
      const qLower = safeQ.toLowerCase();
      usersArray = usersArray.filter(u => {
        return [u.id, u.email, u.minecraftUsername].some(v => String(v || '').toLowerCase().includes(qLower));
      });
    }

    if (role !== 'all') {
      usersArray = usersArray.filter(u => {
        if (role === 'admin') return u.admin === true;
        if (role === 'tester') return u.tester === true || u.tierTester === true;
        if (role === 'user') return !u.admin && !u.tester && !u.tierTester;
        return true;
      });
    }

    if (status !== 'all') {
      usersArray = usersArray.filter(u => {
        if (status === 'banned') return u.banned === true;
        if (status === 'active') return u.banned !== true;
        return true;
      });
    }

    usersArray.sort((a, b) => {
      return parseDateToMs(b.updatedAt || b.createdAt) - parseDateToMs(a.updatedAt || a.createdAt);
    });

    const total = usersArray.length;
    const start = (safePage - 1) * safeLimit;
    const paginated = usersArray.slice(start, start + safeLimit);
    
    res.json({
      users: paginated,
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching users'
    });
  }
});

/**
 * POST /api/admin/users/:id/tester - Set tester status
 */
app.post('/api/admin/users/:id/tester', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users manage capability required' });
    }

    const { id } = req.params;
    const { status } = req.body;
    
    if (typeof status !== 'boolean') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'status must be a boolean'
      });
    }
    
    const userRef = db.ref(`users/${id}`);
    const oldUserData = await userRef.once('value');
    const oldTesterStatus = oldUserData.val()?.tester || false;

    await userRef.update({
      tester: status,
      updatedAt: new Date().toISOString()
    });
    
    // Log admin action
    await logAdminAction(req, req.user.uid, 'SET_TESTER_STATUS', id, {
      oldStatus: oldTesterStatus,
      newStatus: status
    });

    res.json({ success: true, message: `Tester status set to ${status}` });
  } catch (error) {
    console.error('Error setting tester status:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting tester status'
    });
  }
});

/**
 * POST /api/admin/users/:id/admin - Set admin status
 */
app.post('/api/admin/users/:id/admin', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users manage capability required' });
    }

    const { id } = req.params;
    const { status, adminRole } = req.body;
    
    if (typeof status !== 'boolean') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'status must be a boolean'
      });
    }
    
    // Prevent removing your own admin status
    if (id === req.user.uid && status === false) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'You cannot remove your own admin status'
      });
    }
    
    const userRef = db.ref(`users/${id}`);
    const oldUserData = await userRef.once('value');
    const oldAdminStatus = oldUserData.val()?.admin || false;

    const nextAdminRole = status ? (adminRole || oldUserData.val()?.adminRole || 'moderator') : null;

    await userRef.update({
      admin: status,
      adminRole: nextAdminRole,
      updatedAt: new Date().toISOString()
    });

    // Log admin action
    await logAdminAction(req, req.user.uid, 'SET_ADMIN_STATUS', id, {
      oldStatus: oldAdminStatus,
      newStatus: status,
      adminRole: nextAdminRole
    });
    
    res.json({ success: true, message: `Admin status set to ${status}` });
  } catch (error) {
    console.error('Error setting admin status:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting admin status'
    });
  }
});

/**
 * GET /api/admin/staff-roles - List staff roles
 */
app.get('/api/admin/staff-roles', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'settings:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Settings manage capability required' });
    }

		    const roles = await getAllStaffRoles();
		    const roleList = Object.entries(roles).map(([id, role]) => {
		      const iconConfig = buildStaffRoleIconConfig(role);
		      const specialRole = resolveSpecialStaffRoleDefinition(id, role.name || id);
          const capabilities = deriveStaffRoleCapabilities(id, role);
          const specialBadges = buildStaffRoleSpecialBadges(id, role, capabilities);
			      return {
			        id,
			        name: specialRole?.label || role.name || id,
			        color: specialRole?.color || role.color || '#38bdf8',
		        iconType: iconConfig.iconType,
		        iconValue: iconConfig.iconValue,
		        iconUrl: iconConfig.iconUrl,
			        iconClass: specialRole?.iconClass || iconConfig.iconClass,
			        iconLabel: specialRole?.label || iconConfig.iconLabel,
			        builtIn: Boolean(SPECIAL_STAFF_ROLE_DEFINITIONS[id]),
			        badgeVariant: specialBadges[0]?.badgeVariant || specialRole?.badgeVariant || null,
			        capabilities,
              specialBadges,
			        dashboardActions: Array.isArray(role.dashboardActions) ? role.dashboardActions : []
			      };
		    });

	    Object.entries(SPECIAL_STAFF_ROLE_DEFINITIONS).forEach(([roleId, definition]) => {
	      if (!roleList.some((role) => role.id === roleId)) {
	        roleList.push({
	          id: roleId,
	          name: definition.label,
	          color: definition.color,
		        iconType: 'preset',
		        iconValue: 'shield',
		        iconUrl: null,
			        iconClass: definition.iconClass,
			        iconLabel: definition.label,
			        builtIn: true,
			        badgeVariant: definition.badgeVariant,
			        capabilities: definition.capabilities,
              specialBadges: [{
                id: roleId,
                label: definition.label,
                badgeVariant: definition.badgeVariant,
                color: definition.color,
                iconClass: definition.iconClass
              }],
			        dashboardActions: definition.dashboardActions
			        });
		      }
		    });

    roleList.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    res.json({
      success: true,
      roles: roleList,
      actionCatalog: Object.entries(STAFF_DASHBOARD_ACTION_DEFINITIONS)
        .filter(([, action]) => action.legacy !== true)
        .map(([id, action]) => ({ id, label: action.label, icon: action.icon })),
      badgePresets: Object.entries(STAFF_ROLE_ICON_PRESETS).map(([id, preset]) => ({
        id,
        label: preset.label,
        iconClass: preset.iconClass
      }))
    });
  } catch (error) {
    console.error('Error listing staff roles:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error listing staff roles' });
  }
});

/**
 * POST /api/admin/staff-roles - Create a staff role
 */
app.post('/api/admin/staff-roles', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'settings:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Settings manage capability required' });
    }

    const payload = sanitizeStaffRolePayload(req.body || {});
    if (!payload.valid) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Role name must be at least 2 characters.' });
    }

    const requestedId = sanitizeStaffRoleId(req.body?.id || payload.data.name);
    if (!requestedId) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid role id.' });
    }

    const roleRef = db.ref(`settings/staffRoles/${requestedId}`);
    const existing = await roleRef.once('value');
    if (existing.exists()) {
      return res.status(409).json({ error: true, code: 'ALREADY_EXISTS', message: 'A role with this id already exists.' });
    }

    await roleRef.set({
      ...payload.data,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: req.user.uid
    });

    res.json({ success: true, roleId: requestedId, role: { id: requestedId, ...payload.data, ...buildStaffRoleIconConfig(payload.data) } });
  } catch (error) {
    console.error('Error creating staff role:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error creating staff role' });
  }
});

/**
 * PUT /api/admin/staff-roles/:roleId - Update a staff role
 */
app.put('/api/admin/staff-roles/:roleId', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'settings:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Settings manage capability required' });
    }

    const roleId = sanitizeStaffRoleId(req.params.roleId);
    if (!roleId) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid role id.' });
    }

    const roleRef = db.ref(`settings/staffRoles/${roleId}`);
    const existingSnapshot = await roleRef.once('value');
    if (!existingSnapshot.exists()) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Role not found.' });
    }

    const payload = sanitizeStaffRolePayload(req.body || {});
    if (!payload.valid) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Role name must be at least 2 characters.' });
    }

    await roleRef.update({
      ...payload.data,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.uid
    });

    playersCache.data = null;
    playersCache.updatedAt = 0;

    res.json({ success: true, role: { id: roleId, ...payload.data, ...buildStaffRoleIconConfig(payload.data) } });
  } catch (error) {
    console.error('Error updating staff role:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error updating staff role' });
  }
});

/**
 * DELETE /api/admin/staff-roles/:roleId - Remove a staff role
 */
app.delete('/api/admin/staff-roles/:roleId', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'settings:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Settings manage capability required' });
    }

    const roleId = sanitizeStaffRoleId(req.params.roleId);
    if (!roleId) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid role id.' });
    }

    const roleRef = db.ref(`settings/staffRoles/${roleId}`);
    const existingSnapshot = await roleRef.once('value');
    if (!existingSnapshot.exists()) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Role not found.' });
    }

    await roleRef.remove();

    const usersSnapshot = await db.ref('users').once('value');
    const users = usersSnapshot.val() || {};
    const updates = {};
    Object.entries(users).forEach(([uid, user]) => {
      if (String(user?.staffRoleId || '') === roleId) {
        updates[`${uid}/staffRoleId`] = null;
        updates[`${uid}/updatedAt`] = new Date().toISOString();
      }
    });
    if (Object.keys(updates).length > 0) {
      await db.ref('users').update(updates);
    }

    playersCache.data = null;
    playersCache.updatedAt = 0;

    res.json({ success: true, message: 'Role removed.' });
  } catch (error) {
    console.error('Error deleting staff role:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error deleting staff role' });
  }
});

/**
 * POST /api/admin/users/:id/staff-role - Assign or clear staff role
 */
app.post('/api/admin/users/:id/staff-role', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users manage capability required' });
    }

    const { id } = req.params;
    const roleIdRaw = req.body?.roleId;
    const roleId = roleIdRaw === null || roleIdRaw === '' ? null : sanitizeStaffRoleId(roleIdRaw);

    if (roleIdRaw !== null && roleIdRaw !== '' && !roleId) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid staff role id.' });
    }

	    if (roleId) {
	      const roleExists = await db.ref(`settings/staffRoles/${roleId}`).once('value');
	      if (!roleExists.exists() && !SPECIAL_STAFF_ROLE_DEFINITIONS[roleId]) {
	        return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Staff role not found.' });
	      }
	    }

    const userRef = db.ref(`users/${id}`);
    const userSnapshot = await userRef.once('value');
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'User not found.' });
    }

    const existingUser = userSnapshot.val() || {};
    const updates = {
      staffRoleId: roleId,
      updatedAt: new Date().toISOString()
    };

    if (roleId && BUILTIN_STAFF_ROLE_IDS.has(roleId)) {
      updates.staffRoleId = null;
      updates.builtinStaffRoleIds = [roleId];
    } else if (!roleId && BUILTIN_STAFF_ROLE_IDS.has(sanitizeStaffRoleId(existingUser.staffRoleId))) {
      updates.staffRoleId = null;
      updates.builtinStaffRoleIds = null;
    }

    await userRef.update(updates);

    playersCache.data = null;
    playersCache.updatedAt = 0;
    staffRolesCache.data = null;
    staffRolesCache.updatedAt = 0;

    res.json({ success: true, message: roleId ? 'Staff role assigned.' : 'Staff role cleared.', roleId });
  } catch (error) {
    console.error('Error assigning staff role:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error assigning staff role' });
  }
});

/**
 * POST /api/admin/users/:id/builtin-staff-roles - Assign built-in moderator roles
 */
app.post('/api/admin/users/:id/builtin-staff-roles', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users manage capability required' });
    }

    const { id } = req.params;
    const roleIds = Array.isArray(req.body?.roleIds) ? req.body.roleIds : [];
    const normalizedRoleIds = [...new Set(
      roleIds
        .map((value) => sanitizeStaffRoleId(value))
        .filter((roleId) => roleId && BUILTIN_STAFF_ROLE_IDS.has(roleId))
    )];

    const userRef = db.ref(`users/${id}`);
    const userSnapshot = await userRef.once('value');
    if (!userSnapshot.exists()) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'User not found.' });
    }

    const existingUser = userSnapshot.val() || {};
    const oldBuiltinRoleIds = getBuiltinStaffRoleIds(existingUser);
    const currentPrimaryRoleId = sanitizeStaffRoleId(existingUser.staffRoleId);
    const updates = {
      builtinStaffRoleIds: normalizedRoleIds.length ? normalizedRoleIds : null,
      updatedAt: new Date().toISOString()
    };

    if (currentPrimaryRoleId && BUILTIN_STAFF_ROLE_IDS.has(currentPrimaryRoleId)) {
      updates.staffRoleId = null;
    }

    await userRef.update(updates);

    playersCache.data = null;
    playersCache.updatedAt = 0;
    staffRolesCache.data = null;
    staffRolesCache.updatedAt = 0;

    await logAdminAction(req, req.user.uid, 'SET_BUILTIN_STAFF_ROLES', id, {
      oldRoleIds: oldBuiltinRoleIds,
      newRoleIds: normalizedRoleIds
    });

    res.json({
      success: true,
      roleIds: normalizedRoleIds,
      message: 'Built-in staff roles updated.'
    });
  } catch (error) {
    console.error('Error updating built-in staff roles:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating built-in staff roles'
    });
  }
});

/**
 * POST /api/admin/users/:id/unlink-minecraft - Unlink minecraft username from account (admin only)
 * Optionally wipes associated player data.
 */
app.post('/api/admin/users/:id/unlink-minecraft', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { wipePlayer } = req.body || {};

    const userRef = db.ref(`users/${id}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (!userProfile) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'User not found' });
    }

    const oldUsername = userProfile.minecraftUsername || null;

    await userRef.update({
      minecraftUsername: null,
      minecraftVerified: false,
      updatedAt: new Date().toISOString()
    });

    let wipedPlayers = 0;
    if (wipePlayer === true && oldUsername) {
      const playersRef = db.ref('players');

      // Try match by userId first
      const byUserId = await playersRef.orderByChild('userId').equalTo(id).once('value');
      if (byUserId.exists()) {
        const val = byUserId.val();
        for (const playerKey of Object.keys(val)) {
          await playersRef.child(playerKey).remove();
          wipedPlayers++;
        }
      }

      // Also match by username (legacy players without userId)
      const byUsername = await playersRef.orderByChild('username').equalTo(oldUsername).once('value');
      if (byUsername.exists()) {
        const val = byUsername.val();
        for (const playerKey of Object.keys(val)) {
          await playersRef.child(playerKey).remove();
          wipedPlayers++;
        }
      }
    }

    await logAdminAction(req, req.user.uid, 'UNLINK_MINECRAFT', id, {
      oldMinecraftUsername: oldUsername,
      wipePlayer: wipePlayer === true,
      wipedPlayers
    });

    res.json({
      success: true,
      message: 'Minecraft username unlinked',
      oldMinecraftUsername: oldUsername,
      wipedPlayers
    });
  } catch (error) {
    console.error('Error unlinking minecraft username:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error unlinking minecraft username' });
  }
});

/**
 * POST /api/admin/players/:id/manage - Player management actions (admin only)
 */
app.post('/api/admin/players/:id/manage', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, payload } = req.body || {};

    const allowedActions = new Set([
      'wipe_ratings',
      'recalc_overall',
      'reset_overall_1000',
      'clear_match_count',
      'clear_achievements',
      'clear_verified_roles',
      'set_region',
      'wipe_player_data',
      'set_note'
    ]);

    if (!action || !allowedActions.has(action)) {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid action' });
    }

    const playersRef = db.ref('players');
    const playerRef = playersRef.child(id);
    const snap = await playerRef.once('value');
    const player = snap.val();

    if (!player) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'Player not found' });
    }

    const updates = {};

    if (action === 'wipe_player_data') {
      await playerRef.remove();
      await logAdminAction(req, req.user.uid, 'PLAYER_WIPE_DATA', id, { username: player.username || null });
      return res.json({ success: true, message: 'Player data wiped (deleted player record)' });
    }

    if (action === 'wipe_ratings') {
      updates.gamemodeRatings = {};
      updates.gamemodeMatchCount = {};
      updates.achievementTitles = {};
      updates.overallRating = 1000;
    }

    if (action === 'recalc_overall') {
      const gamemodeRatings = player.gamemodeRatings || {};
      updates.overallRating = calculateOverallRating(gamemodeRatings);
    }

    if (action === 'reset_overall_1000') {
      updates.overallRating = 1000;
    }

    if (action === 'clear_match_count') {
      updates.gamemodeMatchCount = {};
    }

    if (action === 'clear_achievements') {
      updates.achievementTitles = {};
    }

    if (action === 'clear_verified_roles') {
      // Verified roles are derived from player.roles; clear roles to remove verification
      updates.roles = {};
    }

    if (action === 'set_region') {
      const region = payload?.region;
      const allowedRegions = new Set(['NA', 'EU', 'AS', 'SA', 'AU']);
      if (!allowedRegions.has(region)) {
        return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'Invalid region' });
      }
      updates.region = region;
    }

    if (action === 'set_note') {
      updates.adminNote = (payload?.note || '').toString().slice(0, 500);
    }

    updates.updatedAt = new Date().toISOString();

    await playerRef.update(updates);

    await logAdminAction(req, req.user.uid, 'PLAYER_MANAGE', id, {
      action,
      payload: payload || null,
      username: player.username || null
    });

    res.json({ success: true, message: 'Player updated', action });
  } catch (error) {
    console.error('Error managing player:', error);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error managing player' });
  }
});

/**
 * POST /api/admin/players/:id/tier - Force set tier for a player
 */
app.post('/api/admin/players/:id/tier', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { gamemode, tier } = req.body;
    
    if (!gamemode || !tier) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'gamemode and tier are required'
      });
    }
    
    // Validate tier
    const validTiers = ['HT1', 'LT1', 'HT2', 'LT2', 'HT3', 'LT3', 'HT4', 'LT4', 'HT5', 'LT5'];
    if (!validTiers.includes(tier)) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `tier must be one of: ${validTiers.join(', ')}`
      });
    }
    
    // Get player
    const playerRef = db.ref(`players/${id}`);
    const snapshot = await playerRef.once('value');
    const player = snapshot.val();
    
    if (!player) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Player not found'
      });
    }
    
    // Get tier points
    const tierPoints = CONFIG.TIERS[tier]?.points || 0;
    const currentTier = player.gamemodeTiers?.[gamemode];
    const currentPoints = player.gamemodePoints?.[gamemode] || 0;
    const currentTierPoints = currentTier ? (CONFIG.TIERS[currentTier]?.points || 0) : 0;
    
    // Calculate point difference
    const pointsDiff = tierPoints - currentTierPoints;
    const newGamemodePoints = currentPoints + pointsDiff;
    const newTotalPoints = (player.totalPoints || 0) + pointsDiff;
    
    // Update player
    const updates = {};
    updates[`gamemodeTiers/${gamemode}`] = tier;
    updates[`gamemodePoints/${gamemode}`] = newGamemodePoints;
    updates.totalPoints = newTotalPoints;
    updates[`lastTested/${gamemode}`] = new Date().toISOString();
    updates.lastAdminUpdate = new Date().toISOString();
    updates.lastAdminUpdateBy = req.user.uid;
    
    await playerRef.update(updates);
    
    res.json({ 
      success: true, 
      message: `Tier set to ${tier} for ${gamemode}`,
      player: { ...player, ...updates }
    });
  } catch (error) {
    console.error('Error setting tier:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting tier'
    });
  }
});

// ===== Advanced Player Management Endpoints =====

/**
 * POST /api/admin/players/force-auth - Force link username to account (admin only)
 */
app.post('/api/admin/players/force-auth', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { userId, username } = req.body;

    if (!userId || !username) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'userId and username are required'
      });
    }

    const sanitizedUsername = username.trim();
    if (!sanitizedUsername || sanitizedUsername.length < 3 || sanitizedUsername.length > 16) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Username must be between 3 and 16 characters'
      });
    }

    // Check if user exists
    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (!userProfile) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    // Check if username is already linked to another account
    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const allUsers = usersSnapshot.val() || {};

    let existingLinkUserId = null;
    for (const [uid, user] of Object.entries(allUsers)) {
      if (uid !== userId && user.minecraftUsername && 
          user.minecraftUsername.toLowerCase() === sanitizedUsername.toLowerCase()) {
        existingLinkUserId = uid;
        break;
      }
    }

    // If username is linked to another account, unlink it first
    if (existingLinkUserId) {
      const existingUserRef = db.ref(`users/${existingLinkUserId}`);
      await existingUserRef.update({
        minecraftUsername: null,
        minecraftVerified: false,
        updatedAt: new Date().toISOString()
      });
    }

    // Force link username to target account
    await userRef.update({
      minecraftUsername: sanitizedUsername,
      minecraftVerified: true,
      updatedAt: new Date().toISOString()
    });

    // Ensure player record exists or update it
    const playersRef = db.ref('players');
    let playerSnapshot = await playersRef.orderByChild('userId').equalTo(userId).once('value');
    let playerData = playerSnapshot.val();

    if (!playerData || Object.keys(playerData).length === 0) {
      // Try by username
      playerSnapshot = await playersRef.orderByChild('username').equalTo(sanitizedUsername).once('value');
      playerData = playerSnapshot.val();
    }

    if (playerData) {
      const playerKey = Object.keys(playerData)[0];
      const playerRef = playersRef.child(playerKey);
      await playerRef.update({
        userId: userId,
        username: sanitizedUsername,
        updatedAt: new Date().toISOString()
      });
    } else {
      // Create new player record
      const newPlayerRef = playersRef.push();
      await newPlayerRef.set({
        id: newPlayerRef.key,
        userId: userId,
        username: sanitizedUsername,
        gamemodeRatings: {},
        gamemodeMatchCount: {},
        overallRating: 1000,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    }

    await logAdminAction(req, req.user.uid, 'FORCE_AUTH', userId, {
      username: sanitizedUsername,
      previousLinkUserId: existingLinkUserId || null
    });

    res.json({
      success: true,
      message: `Username ${sanitizedUsername} force-linked to account`,
      username: sanitizedUsername,
      userId: userId,
      unlinkedFromPrevious: existingLinkUserId || null
    });
  } catch (error) {
    console.error('Error force linking username:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error force linking username'
    });
  }
});

/**
 * POST /api/admin/players/force-auth-unlink - Force unlink username but keep ratings (admin only)
 */
app.post('/api/admin/players/force-auth-unlink', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'userId is required'
      });
    }

    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userProfile = userSnapshot.val();

    if (!userProfile) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    const oldUsername = userProfile.minecraftUsername || null;

    // Unlink username from user account (but keep player data)
    await userRef.update({
      minecraftUsername: null,
      minecraftVerified: false,
      updatedAt: new Date().toISOString()
    });

    // Player record and ratings are preserved (not deleted)

    await logAdminAction(req, req.user.uid, 'FORCE_AUTH_UNLINK', userId, {
      oldMinecraftUsername: oldUsername,
      ratingsPreserved: true
    });

    res.json({
      success: true,
      message: 'Username unlinked from account (ratings preserved)',
      oldMinecraftUsername: oldUsername,
      userId: userId
    });
  } catch (error) {
    console.error('Error force unlinking username:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error force unlinking username'
    });
  }
});

/**
 * POST /api/admin/players/force-test - Force create match between tester and player (admin only)
 * Accepts: testerUserId (required), playerUserId (required), gamemode (required), region (optional), serverIP (optional)
 * Also accepts: playerId (alternative to playerUserId) - will look up player and get userId
 */
app.post('/api/admin/players/force-test', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'matches:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Matches manage capability required' });
    }

    const { testerUserId, playerUserId, playerId, gamemode, region, serverIP } = req.body;

    if (!testerUserId || !gamemode) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'testerUserId and gamemode are required'
      });
    }

    // Validate gamemode
    const validGamemodes = ['vanilla', 'uhc', 'pot', 'nethop', 'smp', 'sword', 'axe', 'mace'];
    if (!validGamemodes.includes(gamemode)) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `gamemode must be one of: ${validGamemodes.join(', ')}`
      });
    }

    // Get tester user profile
    const testerUserRef = db.ref(`users/${testerUserId}`);
    const testerUserSnapshot = await testerUserRef.once('value');
    const testerUser = testerUserSnapshot.val();

    if (!testerUser) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Tester user not found'
      });
    }

    // Verify tester has tester role
    if (!testerUser.tester && !testerUser.admin) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Tester user does not have tester role'
      });
    }

    // Resolve playerUserId - can be provided directly or via playerId
    let resolvedPlayerUserId = playerUserId;
    
    if (!resolvedPlayerUserId && playerId) {
      // Look up player by playerId to get userId
      const playersRef = db.ref('players');
      const playerSnapshot = await playersRef.child(playerId).once('value');
      const playerData = playerSnapshot.val();
      
      if (!playerData) {
        return res.status(404).json({
          error: true,
          code: 'NOT_FOUND',
          message: 'Player not found'
        });
      }
      
      resolvedPlayerUserId = playerData.userId;
      
      if (!resolvedPlayerUserId) {
        return res.status(400).json({
          error: true,
          code: 'VALIDATION_ERROR',
          message: 'Player does not have a linked user account. Use playerUserId instead.'
        });
      }
    }

    if (!resolvedPlayerUserId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'playerUserId or playerId is required'
      });
    }

    if (resolvedPlayerUserId === testerUserId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Player and tester must be different users'
      });
    }

    // Get player user profile
    const playerUserRef = db.ref(`users/${resolvedPlayerUserId}`);
    const playerUserSnapshot = await playerUserRef.once('value');
    const playerUser = playerUserSnapshot.val();

    if (!playerUser) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Player user not found'
      });
    }

    const activeMatchSnapshot = await db.ref('matches').orderByChild('status').equalTo('active').once('value');
    const activeMatches = activeMatchSnapshot.val() || {};
    const conflictingMatch = Object.values(activeMatches).find((match) => (
      match && !match.finalized && (
        match.playerId === testerUserId
        || match.testerId === testerUserId
        || match.playerId === resolvedPlayerUserId
        || match.testerId === resolvedPlayerUserId
      )
    ));
    if (conflictingMatch) {
      return res.status(400).json({
        error: true,
        code: 'ACTIVE_MATCH_EXISTS',
        message: 'Player or tester already has an active match'
      });
    }

    const resolvedServer = await getUserPreferredServerIP(resolvedPlayerUserId, serverIP);
    if (!resolvedServer.serverIP) {
      return res.status(400).json({
        error: true,
        code: 'SERVER_NOT_WHITELISTED',
        message: 'A whitelisted server IP is required. The player queue server is used when available.'
      });
    }

    // Get player data for rating
    const playersRef = db.ref('players');
    let playerSnapshot = await playersRef.orderByChild('userId').equalTo(resolvedPlayerUserId).once('value');
    let playerData = playerSnapshot.val();

    if (!playerData || Object.keys(playerData).length === 0) {
      if (playerUser.minecraftUsername) {
        playerSnapshot = await playersRef.orderByChild('username').equalTo(playerUser.minecraftUsername).once('value');
        playerData = playerSnapshot.val();
      }
    }

    const playerCurrentRating = playerData ? 
      (Object.values(playerData)[0]?.gamemodeRatings?.[gamemode] || 1000) : 1000;

    // Create match
    const matchesRef = db.ref('matches');
    const newMatchRef = matchesRef.push();
    const matchId = newMatchRef.key;

    const firstTo = getFirstToForGamemode(gamemode);
    const match = {
      matchId,
      playerId: resolvedPlayerUserId,
      playerUsername: playerUser.minecraftUsername || playerUser.email,
      playerEmail: playerUser.email,
      testerId: testerUserId,
      testerUsername: testerUser.minecraftUsername || testerUser.email,
      testerEmail: testerUser.email,
      gamemode: gamemode,
      firstTo,
      region: region || 'NA',
      serverIP: resolvedServer.serverIP,
      status: 'active',
      matchType: 'regular',
      playerCurrentRating,
      createdAt: new Date().toISOString(),
      finalized: false,
      chat: {},
      participants: {},
      presence: {},
      pagestats: {
        playerJoined: false,
        testerJoined: false,
        lastUpdate: null
      },
      joinTimeout: {
        startedAt: new Date().toISOString(),
        timeoutMinutes: 3,
        expiresAt: new Date(Date.now() + 3 * 60 * 1000).toISOString()
      },
      queueMeta: {
        playerJoinedQueueAt: null,
        testerJoinedQueueAt: null,
        playerQueueSource: null,
        testerQueueSource: null,
        serverSelectionSource: resolvedServer.source,
        createdFromQueue: false,
        requestedServerIP: String(serverIP || '').trim() || null,
        resolvedServerIP: resolvedServer.serverIP
      },
      roleAssignment: {
        type: 'admin_force_test',
        explanation: resolvedServer.source === 'player_queue'
          ? 'This match was force-created by an admin, but the player queue server IP overrode the requested server.'
          : 'This match was force-created by an admin.',
        playerReason: 'Admin force-created this match.',
        testerReason: 'Admin force-created this match.',
        randomized: false,
        debugLabel: resolvedServer.source === 'player_queue' ? 'Player Server Override' : 'Force Created',
        serverSelectionSource: resolvedServer.source
      },
      forceCreated: true,
      forceCreatedBy: req.user.uid
    };

    // Set up 3-minute inactivity timer
    const INACTIVITY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
    setTimeout(async () => {
      try {
        console.log(`⏰ Checking inactivity for match ${matchId} after 3 minutes...`);
        await handleMatchInactivity(matchId);
      } catch (error) {
        console.error(`❌ Error handling inactivity for match ${matchId}:`, error);
      }
    }, INACTIVITY_TIMEOUT_MS);

    await newMatchRef.set(match);

    await Promise.all([
      clearUserQueueEntries(testerUserId),
      clearUserQueueEntries(resolvedPlayerUserId)
    ]);

    await logAdminAction(req, req.user.uid, 'FORCE_TEST', matchId, {
      testerUserId,
      playerUserId: resolvedPlayerUserId,
      playerId: playerId || null,
      gamemode,
      region: region || 'NA',
      requestedServerIP: String(serverIP || '').trim() || null,
      resolvedServerIP: resolvedServer.serverIP,
      serverSelectionSource: resolvedServer.source,
      matchId
    });

    res.json({
      success: true,
      message: 'Match force-created successfully',
      matchId: matchId,
      match: match
    });
  } catch (error) {
    console.error('Error force creating match:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error force creating match'
    });
  }
});

/**
 * POST /api/admin/players/rating-transfer - Transfer ratings from one player to another (admin only)
 */
app.post('/api/admin/players/rating-transfer', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { fromPlayerId, toPlayerId } = req.body;

    if (!fromPlayerId || !toPlayerId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'fromPlayerId and toPlayerId are required'
      });
    }

    if (fromPlayerId === toPlayerId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Cannot transfer ratings to the same player'
      });
    }

    const playersRef = db.ref('players');
    const fromPlayerRef = playersRef.child(fromPlayerId);
    const toPlayerRef = playersRef.child(toPlayerId);

    const fromPlayerSnapshot = await fromPlayerRef.once('value');
    const toPlayerSnapshot = await toPlayerRef.once('value');

    const fromPlayer = fromPlayerSnapshot.val();
    const toPlayer = toPlayerSnapshot.val();

    if (!fromPlayer) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Source player not found'
      });
    }

    if (!toPlayer) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Destination player not found'
      });
    }

    // Transfer ratings
    const fromRatings = fromPlayer.gamemodeRatings || {};
    const fromMatchCounts = fromPlayer.gamemodeMatchCount || {};
    const toRatings = toPlayer.gamemodeRatings || {};
    const toMatchCounts = toPlayer.gamemodeMatchCount || {};

    // Merge ratings (destination takes precedence if both exist)
    const mergedRatings = { ...toRatings };
    const mergedMatchCounts = { ...toMatchCounts };

    for (const [gamemode, rating] of Object.entries(fromRatings)) {
      if (!mergedRatings[gamemode] || mergedRatings[gamemode] < rating) {
        mergedRatings[gamemode] = rating;
      }
    }

    for (const [gamemode, count] of Object.entries(fromMatchCounts)) {
      mergedMatchCounts[gamemode] = (mergedMatchCounts[gamemode] || 0) + count;
    }

    // Update destination player
    const toUpdates = {
      gamemodeRatings: mergedRatings,
      gamemodeMatchCount: mergedMatchCounts,
      overallRating: calculateOverallRating(mergedRatings),
      updatedAt: new Date().toISOString()
    };

    await toPlayerRef.update(toUpdates);

    // Wipe ratings from source player
    const fromUpdates = {
      gamemodeRatings: {},
      gamemodeMatchCount: {},
      overallRating: 1000,
      achievementTitles: {},
      updatedAt: new Date().toISOString()
    };

    await fromPlayerRef.update(fromUpdates);

    await logAdminAction(req, req.user.uid, 'RATING_TRANSFER', fromPlayerId, {
      fromPlayerId,
      toPlayerId,
      fromUsername: fromPlayer.username || null,
      toUsername: toPlayer.username || null,
      transferredRatings: Object.keys(fromRatings)
    });

    res.json({
      success: true,
      message: 'Ratings transferred successfully',
      fromPlayerId,
      toPlayerId,
      transferredGamemodes: Object.keys(fromRatings)
    });
  } catch (error) {
    console.error('Error transferring ratings:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error transferring ratings'
    });
  }
});

/**
 * POST /api/admin/players/rating-wipe - Wipe all ratings from a player (admin only)
 */
app.post('/api/admin/players/rating-wipe', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { playerId } = req.body;

    if (!playerId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'playerId is required'
      });
    }

    const playersRef = db.ref('players');
    const playerRef = playersRef.child(playerId);
    const playerSnapshot = await playerRef.once('value');
    const player = playerSnapshot.val();

    if (!player) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Player not found'
      });
    }

    // Wipe all ratings
    const updates = {
      gamemodeRatings: {},
      gamemodeMatchCount: {},
      overallRating: 1000,
      achievementTitles: {},
      updatedAt: new Date().toISOString()
    };

    await playerRef.update(updates);

    await logAdminAction(req, req.user.uid, 'RATING_WIPE', playerId, {
      username: player.username || null,
      wipedRatings: Object.keys(player.gamemodeRatings || {})
    });

    res.json({
      success: true,
      message: 'All ratings wiped from player',
      playerId,
      username: player.username || null
    });
  } catch (error) {
    console.error('Error wiping ratings:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error wiping ratings'
    });
  }
});

// ===== Ban Management Endpoints =====

// Ban account
app.post('/api/admin/ban', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage') && !adminHasCapability(req, 'bans:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Ban manage capability required' });
    }

    const { identifier, duration, reason } = req.body;

    if (!identifier) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_IDENTIFIER',
        message: 'Account identifier (email or Firebase UID) is required'
      });
    }

    if (!duration) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_DURATION',
        message: 'Ban duration is required'
      });
    }

    // Check for profanity in reason if provided
    if (reason && reason.trim()) {
      try {
        const hasProfanity = await containsProfanity(reason.trim());
        if (hasProfanity) {
          return res.status(400).json({
            error: true,
            code: 'PROFANITY_DETECTED',
            message: 'Ban reason contains inappropriate language and cannot be used'
          });
        }
      } catch (error) {
        // If profanity filter is unavailable, block the request
        return res.status(503).json({
          error: true,
          code: 'FILTER_UNAVAILABLE',
          message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
        });
      }
    }

    // Find user by email or Firebase UID
    let userQuery = db.ref('users').orderByChild('email').equalTo(identifier);
    let userSnapshot = await userQuery.once('value');
    let userData = userSnapshot.val();
    let firebaseUid = null;

    if (!userData) {
      // Try to find by Firebase UID
      const userRef = db.ref(`users/${identifier}`);
      const userSnapshot = await userRef.once('value');
      userData = userSnapshot.val();
      firebaseUid = identifier;
    } else {
      // Get the Firebase UID from the found user
      firebaseUid = Object.keys(userData)[0];
      userData = userData[firebaseUid];
    }

    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Check if already banned
    if (userData.banned) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_BANNED',
        message: 'User is already banned'
      });
    }

    // Calculate ban expiration
    let banExpires = null;
    if (duration !== 'permanent') {
      const now = new Date();
      const durationMatch = duration.match(/^(\d+)([hd])$/);
      if (durationMatch) {
        const value = parseInt(durationMatch[1]);
        const unit = durationMatch[2];
        if (unit === 'h') {
          banExpires = new Date(now.getTime() + value * 60 * 60 * 1000);
        } else if (unit === 'd') {
          banExpires = new Date(now.getTime() + value * 24 * 60 * 60 * 1000);
        }
      }
    }

    // Update user with ban information
    const banData = {
      banned: true,
      bannedAt: new Date().toISOString(),
      bannedBy: req.user.uid,
      banExpires: banExpires ? banExpires.toISOString() : 'permanent',
      banReason: reason || null
    };

    await db.ref(`users/${firebaseUid}`).update(banData);

    // Log the ban action
    await logAdminAction(req, req.user.uid, 'BAN_USER', firebaseUid, {
      reason: reason || 'No reason provided',
      duration: banExpires ? banExpires.toISOString() : 'permanent',
      isPermanent: duration === 'permanent'
    });

    res.json({
      success: true,
      message: 'Account banned successfully',
      bannedAccount: {
        firebaseUid,
        email: userData.email,
        ...banData
      }
    });

  } catch (error) {
    console.error('Error banning account:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error banning account'
    });
  }
});

// Unban account
/**
 * POST /api/admin/warn/:firebaseUid - Warn a user
 */
app.post('/api/admin/warn/:firebaseUid', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { firebaseUid } = req.params;
    const { reason, severity = 'warning' } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_REASON',
        message: 'Warning reason is required'
      });
    }

    // Check for profanity in reason
    try {
      const hasProfanity = await containsProfanity(reason.trim());
      if (hasProfanity) {
        return res.status(400).json({
          error: true,
          code: 'PROFANITY_DETECTED',
          message: 'Warning reason contains inappropriate language and cannot be used'
        });
      }
    } catch (error) {
      // If profanity filter is unavailable, block the request
      return res.status(503).json({
        error: true,
        code: 'FILTER_UNAVAILABLE',
        message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
      });
    }

    const userRef = db.ref(`users/${firebaseUid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();

    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    // Add warning to user's warnings array
    const warnings = userData.warnings || [];
    const newWarning = {
      id: Date.now().toString(),
      reason: reason.trim(),
      severity: severity,
      issuedBy: req.user.uid,
      issuedAt: new Date().toISOString(),
      acknowledged: false
    };

    warnings.push(newWarning);

    await userRef.update({
      warnings: warnings,
      updatedAt: new Date().toISOString()
    });

    console.log(`ADMIN ACTION: Warning issued to user ${firebaseUid}`);

    res.json({
      success: true,
      message: 'Warning issued successfully',
      warning: newWarning
    });

  } catch (error) {
    console.error('Error issuing warning:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error issuing warning'
    });
  }
});

/**
 * POST /api/auth/acknowledge-warning - Acknowledge a warning
 */
app.post('/api/auth/acknowledge-warning', verifyAuth, requireRecaptcha, async (req, res) => {
  try {
    const { warningId } = req.body;

    if (!warningId) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_WARNING_ID',
        message: 'Warning ID is required'
      });
    }

    const userRef = db.ref(`users/${req.user.uid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();

    if (!userData || !userData.warnings) {
      return res.status(404).json({
        error: true,
        code: 'WARNING_NOT_FOUND',
        message: 'Warning not found'
      });
    }

    // Find and acknowledge the warning
    const warnings = userData.warnings.map(warning => {
      if (warning.id === warningId && warning.acknowledged === false) {
        return { ...warning, acknowledged: true, acknowledgedAt: new Date().toISOString() };
      }
      return warning;
    });

    await userRef.update({
      warnings: warnings,
      updatedAt: new Date().toISOString()
    });

    res.json({
      success: true,
      message: 'Warning acknowledged'
    });

  } catch (error) {
    console.error('Error acknowledging warning:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error acknowledging warning'
    });
  }
});

app.post('/api/admin/unban/:firebaseUid', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage') && !adminHasCapability(req, 'bans:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Ban manage capability required' });
    }

    const { firebaseUid } = req.params;

    const userRef = db.ref(`users/${firebaseUid}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();

    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'USER_NOT_FOUND',
        message: 'User not found'
      });
    }

    if (!userData.banned) {
      return res.status(400).json({
        error: true,
        code: 'NOT_BANNED',
        message: 'User is not banned'
      });
    }

    // Remove ban fields
    const updates = {
      banned: null,
      bannedAt: null,
      bannedBy: null,
      banExpires: null,
      banReason: null
    };

    await userRef.update(updates);

    // Log the unban action
    await logAdminAction(req, req.user.uid, 'UNBAN_USER', firebaseUid, {
      previousReason: userData.banReason,
      previousExpiry: userData.banExpires
    });

    res.json({
      success: true,
      message: 'Account unbanned successfully',
      unbannedAccount: {
        firebaseUid,
        email: userData.email
      }
    });

  } catch (error) {
    console.error('Error unbanning account:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error unbanning account'
    });
  }
});

// Get all banned accounts
app.get('/api/admin/banned', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage') && !adminHasCapability(req, 'bans:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Ban view capability required' });
    }

    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const allUsers = usersSnapshot.val() || {};

    const bannedAccounts = [];

    for (const [firebaseUid, userData] of Object.entries(allUsers)) {
      if (userData.banned) {
        bannedAccounts.push({
          firebaseUid,
          email: userData.email,
          bannedAt: userData.bannedAt,
          banExpires: userData.banExpires,
          banReason: userData.banReason,
          bannedBy: userData.bannedBy
        });
      }
    }

    res.json({
      success: true,
      bannedAccounts
    });

  } catch (error) {
    console.error('Error fetching banned accounts:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching banned accounts'
    });
  }
});

// Search banned accounts
app.get('/api/admin/banned/search', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage') && !adminHasCapability(req, 'bans:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Ban view capability required' });
    }

    const { q: searchTerm } = req.query;

    if (!searchTerm) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_SEARCH_TERM',
        message: 'Search term is required'
      });
    }

    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const allUsers = usersSnapshot.val() || {};

    const bannedAccounts = [];

    for (const [firebaseUid, userData] of Object.entries(allUsers)) {
      if (userData.banned) {
        // Check if search term matches email, Firebase UID, or ban reason
        const matchesSearch =
          userData.email?.toLowerCase().includes(searchTerm.toLowerCase()) ||
          firebaseUid.toLowerCase().includes(searchTerm.toLowerCase()) ||
          userData.banReason?.toLowerCase().includes(searchTerm.toLowerCase());

        if (matchesSearch) {
          bannedAccounts.push({
            firebaseUid,
            email: userData.email,
            bannedAt: userData.bannedAt,
            banExpires: userData.banExpires,
            banReason: userData.banReason,
            bannedBy: userData.bannedBy
          });
        }
      }
    }

    res.json({
      success: true,
      bannedAccounts
    });

  } catch (error) {
    console.error('Error searching banned accounts:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error searching banned accounts'
    });
  }
});

/**
 * ===== Ban Waves Management Endpoints =====
 */

/**
 * GET /api/admin/ban-waves - Get all ban waves
 */
app.get('/api/admin/ban-waves', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const waveRef = db.ref('banWaves');
    const waveSnapshot = await waveRef.once('value');
    const waveSnapshots = waveSnapshot.val() || {};

    const banWaves = Object.keys(waveSnapshots).map(id => ({
      id,
      ...waveSnapshots[id]
    }));

    res.json({
      success: true,
      banWaves: banWaves.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    });
  } catch (error) {
    console.error('Error fetching ban waves:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching ban waves'
    });
  }
});

/**
 * POST /api/admin/ban-waves - Create a new ban wave
 */
app.post('/api/admin/ban-waves', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { name, description, status, duration, accounts } = req.body;

    if (!name || !Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Name and at least one account are required'
      });
    }

    const newWaveRef = db.ref('banWaves').push();
    const waveId = newWaveRef.key;

    await newWaveRef.set({
      id: waveId,
      name: String(name).trim().substring(0, 100),
      description: String(description || '').trim().substring(0, 500),
      status: status || 'pending',
      duration: duration || 'permanent',
      accounts: accounts.map(a => String(a).trim()).filter(Boolean),
      createdAt: new Date().toISOString(),
      createdBy: req.user.uid,
      executedAt: null,
      executedBy: null
    });

    await logAdminAction(req, req.user.uid, 'CREATE_BAN_WAVE', null, {
      waveId,
      name,
      accountCount: accounts.length
    });

    res.json({
      success: true,
      message: 'Ban wave created successfully',
      waveId
    });
  } catch (error) {
    console.error('Error creating ban wave:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error creating ban wave'
    });
  }
});

/**
 * PUT /api/admin/ban-waves/:waveId - Update a ban wave
 */
app.put('/api/admin/ban-waves/:waveId', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { waveId } = req.params;
    const { name, description, status, duration, accounts } = req.body;

    const waveRef = db.ref(`banWaves/${waveId}`);
    const waveSnapshot = await waveRef.once('value');
    if (!waveSnapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Ban wave not found'
      });
    }

    const wave = waveSnapshot.val();
    if (wave.executedAt) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_EXECUTED',
        message: 'Cannot edit an already executed ban wave'
      });
    }

    const updates = {};
    if (name) updates.name = String(name).trim().substring(0, 100);
    if (description !== undefined) updates.description = String(description || '').trim().substring(0, 500);
    if (status) updates.status = status;
    if (duration) updates.duration = duration;
    if (Array.isArray(accounts) && accounts.length > 0) {
      updates.accounts = accounts.map(a => String(a).trim()).filter(Boolean);
    }

    await waveRef.update(updates);

    await logAdminAction(req, req.user.uid, 'UPDATE_BAN_WAVE', null, {
      waveId,
      changes: updates
    });

    res.json({
      success: true,
      message: 'Ban wave updated successfully'
    });
  } catch (error) {
    console.error('Error updating ban wave:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating ban wave'
    });
  }
});

/**
 * DELETE /api/admin/ban-waves/:waveId - Delete a ban wave
 */
app.delete('/api/admin/ban-waves/:waveId', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { waveId } = req.params;

    const waveRef = db.ref(`banWaves/${waveId}`);
    const waveSnapshot = await waveRef.once('value');
    if (!waveSnapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Ban wave not found'
      });
    }

    await waveRef.remove();

    await logAdminAction(req, req.user.uid, 'DELETE_BAN_WAVE', null, {
      waveId
    });

    res.json({
      success: true,
      message: 'Ban wave deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting ban wave:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error deleting ban wave'
    });
  }
});

/**
 * POST /api/admin/ban-waves/:waveId/execute - Execute a ban wave
 */
app.post('/api/admin/ban-waves/:waveId/execute', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:manage')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist manage capability required' });
    }

    const { waveId } = req.params;

    const waveRef = db.ref(`banWaves/${waveId}`);
    const waveSnapshot = await waveRef.once('value');
    if (!waveSnapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Ban wave not found'
      });
    }

    const wave = waveSnapshot.val();
    if (wave.executedAt) {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_EXECUTED',
        message: 'This ban wave has already been executed'
      });
    }

    const results = {
      accountsBanned: 0,
      usernamesBlacklisted: 0,
      errors: []
    };

    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const allUsers = usersSnapshot.val() || {};

    // Ban each account
    for (const account of (wave.accounts || [])) {
      try {
        let foundUserId = null;

        // Check if it's an email or UID
        if (account.includes('@')) {
          // It's an email, find the matching Firebase UID
          for (const [uid, user] of Object.entries(allUsers)) {
            if (user.email === account) {
              foundUserId = uid;
              break;
            }
          }
        } else {
          // Assume it's a Firebase UID
          foundUserId = account;
        }

        if (!foundUserId) {
          results.errors.push(`Account ${account} not found`);
          continue;
        }

        // Ban the Firebase account
        await db.ref(`users/${foundUserId}`).update({
          banned: true,
          bannedAt: new Date().toISOString(),
          bannedBy: req.user.uid,
          banExpires: 'permanent',
          banReason: `Executed as part of ban wave: ${wave.name}`
        });

        results.accountsBanned++;
      } catch (error) {
        results.errors.push(`Failed to ban ${account}: ${error.message}`);
      }
    }

    // Mark wave as executed
    await waveRef.update({
      status: 'completed',
      executedAt: new Date().toISOString(),
      executedBy: req.user.uid
    });

    await logAdminAction(req, req.user.uid, 'EXECUTE_BAN_WAVE', null, {
      waveId,
      waveName: wave.name,
      accountsBanned: results.accountsBanned,
      errors: results.errors.length
    });

    res.json({
      success: true,
      message: `Ban wave executed. ${results.accountsBanned} account(s) banned.`,
      results
    });
  } catch (error) {
    console.error('Error executing ban wave:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error executing ban wave'
    });
  }
});

// ===== Alt Detection Management Endpoints =====

// Get reported accounts
app.get('/api/admin/alt-reports', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const reportsRef = db.ref('altReports');
    const reportsSnapshot = await reportsRef.once('value');
    const reports = reportsSnapshot.val() || {};

    const reportedAccounts = Object.keys(reports).map(id => ({
      id,
      ...reports[id]
    }));

    res.json({
      success: true,
      reportedAccounts
    });

  } catch (error) {
    console.error('Error fetching alt reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching alt reports'
    });
  }
});

// Move report to judgment day (deletes the report)
app.post('/api/admin/alt-reports/:reportId/judgment-day', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { reportId } = req.params;
    const reportRef = db.ref(`altReports/${reportId}`);

    const reportSnapshot = await reportRef.once('value');
    const report = reportSnapshot.val();

    if (!report) {
      return res.status(404).json({
        error: true,
        code: 'REPORT_NOT_FOUND',
        message: 'Report not found'
      });
    }

    if (report.status === 'judgment-day') {
      return res.status(400).json({
        error: true,
        code: 'ALREADY_IN_JUDGMENT',
        message: 'Report is already in judgment day'
      });
    }

    // Create judgment day entry with report data
    const judgmentDayRef = db.ref('judgmentDay').push();
    await judgmentDayRef.set({
      ...report,
      status: 'judgment-day',
      movedToJudgmentBy: req.user.uid,
      movedToJudgmentAt: new Date().toISOString(),
      originalReportId: reportId
    });

    // Delete the original report
    await reportRef.remove();

    res.json({
      success: true,
      message: 'Report moved to judgment day and removed from reports'
    });

  } catch (error) {
    console.error('Error moving report to judgment day:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error moving report to judgment day'
    });
  }
});

// Remove alt report
app.delete('/api/admin/alt-reports/:reportId', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { reportId } = req.params;
    const reportRef = db.ref(`altReports/${reportId}`);

    const reportSnapshot = await reportRef.once('value');
    const report = reportSnapshot.val();

    if (!report) {
      return res.status(404).json({
        error: true,
        code: 'REPORT_NOT_FOUND',
        message: 'Report not found'
      });
    }

    await reportRef.remove();

    res.json({
      success: true,
      message: 'Report removed'
    });

  } catch (error) {
    console.error('Error removing alt report:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing alt report'
    });
  }
});

/**
 * POST /api/admin/judgment-day/add - Manually add player/account to judgment day
 */
app.post('/api/admin/judgment-day/add', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { playerId, userId, username, reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Reason is required'
      });
    }

    // Check for profanity in reason
    try {
      const hasProfanity = await containsProfanity(reason.trim());
      if (hasProfanity) {
        return res.status(400).json({
          error: true,
          code: 'PROFANITY_DETECTED',
          message: 'Reason contains inappropriate language and cannot be used'
        });
      }
    } catch (error) {
      // If profanity filter is unavailable, block the request
      return res.status(503).json({
        error: true,
        code: 'FILTER_UNAVAILABLE',
        message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
      });
    }

    if (!playerId && !userId && !username) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Either playerId, userId, or username must be provided'
      });
    }

    let targetUserId = userId;
    let targetUsername = username;
    let targetPlayerId = playerId;

    // If username provided, find the user/player
    if (username && !userId && !playerId) {
      const playersRef = db.ref('players');
      const playerSnapshot = await playersRef.orderByChild('username').equalTo(username.trim()).once('value');
      
      if (playerSnapshot.exists()) {
        const players = playerSnapshot.val();
        const playerKey = Object.keys(players)[0];
        const player = players[playerKey];
        targetPlayerId = playerKey;
        targetUserId = player.userId;
        targetUsername = player.username;
      } else {
        // Try to find by username in users
        const usersRef = db.ref('users');
        const usersSnapshot = await usersRef.once('value');
        const users = usersSnapshot.val() || {};
        
        const foundUser = Object.values(users).find(u => u.minecraftUsername === username.trim());
        if (foundUser) {
          targetUserId = Object.keys(users).find(key => users[key] === foundUser);
          targetUsername = foundUser.minecraftUsername;
        } else {
          return res.status(404).json({
            error: true,
            code: 'NOT_FOUND',
            message: 'Player or user not found with that username'
          });
        }
      }
    }

    // If playerId provided, get player info
    if (playerId && !targetUserId) {
      const playerRef = db.ref(`players/${playerId}`);
      const playerSnapshot = await playerRef.once('value');
      const player = playerSnapshot.val();
      
      if (!player) {
        return res.status(404).json({
          error: true,
          code: 'NOT_FOUND',
          message: 'Player not found'
        });
      }
      
      targetPlayerId = playerId;
      targetUserId = player.userId;
      targetUsername = player.username;
    }

    // If userId provided, get user info
    if (userId && !targetUsername) {
      const userRef = db.ref(`users/${userId}`);
      const userSnapshot = await userRef.once('value');
      const user = userSnapshot.val();
      
      if (!user) {
        return res.status(404).json({
          error: true,
          code: 'NOT_FOUND',
          message: 'User not found'
        });
      }
      
      targetUserId = userId;
      targetUsername = user.minecraftUsername;
    }

    // Create judgment day entry
    const judgmentDayRef = db.ref('judgmentDay').push();
    await judgmentDayRef.set({
      primaryAccount: targetUserId,
      username: targetUsername,
      playerId: targetPlayerId,
      reason: reason.trim(),
      addedBy: req.user.uid,
      addedAt: new Date().toISOString(),
      status: 'judgment-day',
      manualEntry: true
    });

    res.json({
      success: true,
      message: 'Account/player added to judgment day successfully',
      judgmentDayId: judgmentDayRef.key
    });

  } catch (error) {
    console.error('Error adding to judgment day:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error adding to judgment day'
    });
  }
});

// Get judgment day accounts
app.get('/api/admin/judgment-day', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const judgmentDayRef = db.ref('judgmentDay');
    const judgmentDaySnapshot = await judgmentDayRef.once('value');
    const judgmentDayAccounts = judgmentDaySnapshot.val() || {};

    const accounts = Object.keys(judgmentDayAccounts).map(id => ({
      id,
      ...judgmentDayAccounts[id]
    }));

    res.json({
      success: true,
      judgmentDayAccounts: accounts
    });

  } catch (error) {
    console.error('Error fetching judgment day accounts:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching judgment day accounts'
    });
  }
});

// Execute judgment day - ban all accounts
app.post('/api/admin/judgment-day/execute', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const judgmentDayRef = db.ref('judgmentDay');
    const judgmentDaySnapshot = await judgmentDayRef.once('value');
    const judgmentDayAccounts = judgmentDaySnapshot.val() || {};

    const accounts = Object.keys(judgmentDayAccounts).map(id => ({
      id,
      ...judgmentDayAccounts[id]
    }));

    if (accounts.length === 0) {
      return res.status(400).json({
        error: true,
        code: 'NO_ACCOUNTS',
        message: 'No accounts in judgment day'
      });
    }

    const results = [];
    let bannedCount = 0;
    let blacklistedCount = 0;

    for (const report of accounts) {
      try {
        const processedAccounts = [];

        // Ban primary account
        const primaryRef = db.ref(`users/${report.primaryAccount}`);
        const primarySnapshot = await primaryRef.once('value');
        const primaryData = primarySnapshot.val();

        if (primaryData && !primaryData.banned) {
          await primaryRef.update({
            banned: true,
            bannedAt: new Date().toISOString(),
            bannedBy: req.user.uid,
            banExpires: 'permanent',
            banReason: `Alt account group - ${report.detectionReason} (Flagged ${report.flagCount} times)`
          });
          bannedCount++;
          processedAccounts.push({
            uid: report.primaryAccount,
            email: primaryData.email,
            type: 'primary'
          });
        }

        // Blacklist primary Minecraft username if exists
        if (primaryData?.minecraftUsername) {
          const blacklistRef = db.ref('blacklist').push();
          await blacklistRef.set({
            username: primaryData.minecraftUsername,
            reason: `Alt account group - ${report.detectionReason}`,
            addedAt: new Date().toISOString(),
            addedBy: req.user.uid
          });
          blacklistedCount++;
        }

        // Ban all suspicious accounts
        if (report.suspiciousAccounts) {
          for (const suspicious of report.suspiciousAccounts) {
            const suspiciousRef = db.ref(`users/${suspicious.uid}`);
            const suspiciousSnapshot = await suspiciousRef.once('value');
            const suspiciousData = suspiciousSnapshot.val();

            if (suspiciousData && !suspiciousData.banned) {
              await suspiciousRef.update({
                banned: true,
                bannedAt: new Date().toISOString(),
                bannedBy: req.user.uid,
                banExpires: 'permanent',
                banReason: `Alt account group - ${report.detectionReason} (Flagged ${report.flagCount} times)`
              });
              bannedCount++;
              processedAccounts.push({
                uid: suspicious.uid,
                email: suspicious.email,
                type: 'suspicious'
              });
            }

            // Blacklist suspicious Minecraft username
            if (suspicious.minecraftUsername) {
              const blacklistRef = db.ref('blacklist').push();
              await blacklistRef.set({
                username: suspicious.minecraftUsername,
                reason: `Alt account group - ${report.detectionReason}`,
                addedAt: new Date().toISOString(),
                addedBy: req.user.uid
              });
              blacklistedCount++;
            }
          }
        }

        // Remove from judgment day (delete the entry since it's executed)
        await judgmentDayRef.child(report.id).remove();
        
        // Check and terminate any active matches for blacklisted users
        await checkAndTerminateBlacklistedMatches();

        results.push({
          groupId: report.groupId,
          flagCount: report.flagCount,
          accountsProcessed: processedAccounts.length,
          primaryAccount: report.primaryAccount,
          suspiciousAccountsCount: report.suspiciousAccounts?.length || 0,
          status: 'success'
        });

      } catch (error) {
        console.error('Error processing alt group', report.groupId, ':', error);
        results.push({
          groupId: report.groupId,
          status: 'error',
          error: error.message
        });
      }
    }

    res.json({
      success: true,
      message: `Judgment day executed. ${bannedCount} accounts banned, ${blacklistedCount} usernames blacklisted.`,
      stats: {
        totalAccounts: judgmentDayAccounts.length,
        bannedCount,
        blacklistedCount,
        processedCount: results.length
      },
      results
    });

  } catch (error) {
    console.error('Error executing judgment day:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error executing judgment day'
    });
  }
});

/**
 * GET /api/admin/stats - Get system statistics
 */
app.get('/api/admin/stats', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    // Get active matches count
    const activeMatchesRef = db.ref('matches');
    const activeMatchesSnapshot = await activeMatchesRef
      .orderByChild('status')
      .equalTo('active')
      .once('value');

    const activeMatches = activeMatchesSnapshot.val() || {};
    const activeMatchesCount = Object.keys(activeMatches).length;

    // Get total players count
    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.once('value');
    const players = playersSnapshot.val() || {};
    const totalPlayers = Object.keys(players).length;

    // Get queued players count
    const queueRef = db.ref('queue');
    const queueSnapshot = await queueRef.once('value');
    const queue = queueSnapshot.val() || {};
    const queuedPlayers = Object.keys(queue).length;

    res.json({
      success: true,
      stats: {
        activeMatches: activeMatchesCount,
        totalPlayers: totalPlayers,
        queuedPlayers: queuedPlayers,
        matchCapacity: 100,
        matchUtilizationPercent: Math.round((activeMatchesCount / 100) * 100)
      }
    });

  } catch (error) {
    console.error('Error getting admin stats:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error retrieving system statistics'
    });
  }
});

/**
 * POST /api/admin/manual-rating-update - Manually update player ratings
 */
app.post('/api/admin/manual-rating-update', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { player1Username, player2Username, player1Score, player2Score, gamemode } = req.body;

    if (!player1Username || !player2Username || player1Score === undefined || player2Score === undefined || !gamemode) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'player1Username, player2Username, player1Score, player2Score, and gamemode are required'
      });
    }

    if (typeof player1Score !== 'number' || typeof player2Score !== 'number') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Scores must be numbers'
      });
    }

    if (player1Score < 0 || player2Score < 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Scores cannot be negative'
      });
    }

    // Validate gamemode
    const validGamemode = CONFIG.GAMEMODES.find(g => g.id === gamemode);
    if (!validGamemode) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: `Invalid gamemode: ${gamemode}`
      });
    }

    // Find players by username
    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.once('value');
    const allPlayers = playersSnapshot.val() || {};

    let player1Data = null;
    let player2Data = null;
    let player1Id = null;
    let player2Id = null;

    for (const [id, player] of Object.entries(allPlayers)) {
      if (player.username === player1Username) {
        player1Data = player;
        player1Id = id;
      }
      if (player.username === player2Username) {
        player2Data = player;
        player2Id = id;
      }
    }

    // Create players if they don't exist
    if (!player1Data) {
      console.log(`Creating player ${player1Username} for manual rating update`);
      const newPlayerRef = playersRef.push();
      player1Id = newPlayerRef.key;
      const dummyUserId = `manual-${player1Id}`;
      player1Data = {
        username: player1Username,
        userId: dummyUserId,
        gamemodeRatings: {},
        glicko2Params: {},
        createdAt: new Date().toISOString(),
        region: 'unknown' // Default region
      };
      await newPlayerRef.set(player1Data);
    }

    if (!player2Data) {
      console.log(`Creating player ${player2Username} for manual rating update`);
      const newPlayerRef = playersRef.push();
      player2Id = newPlayerRef.key;
      const dummyUserId = `manual-${player2Id}`;
      player2Data = {
        username: player2Username,
        userId: dummyUserId,
        gamemodeRatings: {},
        glicko2Params: {},
        createdAt: new Date().toISOString(),
        region: 'unknown' // Default region
      };
      await newPlayerRef.set(player2Data);
    }

    // Get current ratings and Glicko-2 data
    const player1Rating = player1Data.gamemodeRatings?.[gamemode] || 1000;
    const player2Rating = player2Data.gamemodeRatings?.[gamemode] || 1000;

    const player1Glicko2 = player1Data.glicko2Params?.[gamemode] || {
      rd: GLICKO2_DEFAULT_RD,
      volatility: GLICKO2_DEFAULT_VOLATILITY
    };
    const player2Glicko2 = player2Data.glicko2Params?.[gamemode] || {
      rd: GLICKO2_DEFAULT_RD,
      volatility: GLICKO2_DEFAULT_VOLATILITY
    };

    // Determine Glicko-2 scores
    let player1Glicko2Score, player2Glicko2Score;
    if (player1Score > player2Score) {
      player1Glicko2Score = 1; // Player 1 wins
      player2Glicko2Score = 0; // Player 2 loses
    } else if (player1Score < player2Score) {
      player1Glicko2Score = 0; // Player 1 loses
      player2Glicko2Score = 1; // Player 2 wins
    } else {
      player1Glicko2Score = 0.5; // Draw
      player2Glicko2Score = 0.5; // Draw
    }

    // Calculate Glicko-2 rating changes
    const player1Obj = {
      rating: player1Rating,
      rd: player1Glicko2.rd,
      volatility: player1Glicko2.volatility
    };
    const player2Obj = {
      rating: player2Rating,
      rd: player2Glicko2.rd,
      volatility: player2Glicko2.volatility
    };

    const player1Result = calculateGlicko2Change(player1Obj, player2Obj, player1Glicko2Score);
    const player2Result = calculateGlicko2Change(player2Obj, player1Obj, player2Glicko2Score);

    // Update ratings using centralized function
    await updatePlayerRating(player1Data.userId, gamemode, player1Result.ratingChange, player1Result.newRating, player1Result.newRD, player1Result.newVolatility);
    await updatePlayerRating(player2Data.userId, gamemode, player2Result.ratingChange, player2Result.newRating, player2Result.newRD, player2Result.newVolatility);

    res.json({
      success: true,
      message: 'Player ratings updated successfully',
      results: {
        player1: {
          username: player1Username,
          oldRating: player1Rating,
          newRating: player1Result.newRating,
          ratingChange: player1Result.ratingChange
        },
        player2: {
          username: player2Username,
          oldRating: player2Rating,
          newRating: player2Result.newRating,
          ratingChange: player2Result.ratingChange
        },
        gamemode,
        score: `${player1Score} - ${player2Score}`
      }
    });

  } catch (error) {
    console.error('Error updating player ratings manually:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error updating player ratings'
    });
  }
});

/**
 * POST /api/admin/reset-cooldown - Reset testing cooldown for a player
 */
app.post('/api/admin/reset-cooldown', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { username, gamemode } = req.body;

    if (!username) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Username is required'
      });
    }

    // Find player
    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.once('value');
    const allPlayers = playersSnapshot.val() || {};
    
    let playerKey = null;
    let playerData = null;
    for (const [key, player] of Object.entries(allPlayers)) {
      if (player.username?.toLowerCase() === username.toLowerCase()) {
        playerKey = key;
        playerData = player;
        break;
      }
    }

    if (!playerKey || !playerData) {
      return res.status(404).json({
        error: true,
        code: 'PLAYER_NOT_FOUND',
        message: 'Player not found'
      });
    }

    // Reset cooldown in user profile
    const userRef = db.ref(`users/${playerData.userId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val() || {};

    if (gamemode) {
      // Reset specific gamemode cooldown
      const lastTestCompletions = userData.lastTestCompletions || {};
      const lastQueueJoins = userData.lastQueueJoins || {};
      
      delete lastTestCompletions[gamemode];
      delete lastQueueJoins[gamemode];
      
      await userRef.update({
        lastTestCompletions,
        lastQueueJoins
      });

      res.json({
        success: true,
        message: `Cooldown reset for ${username} in ${gamemode.toUpperCase()}`
      });
    } else {
      // Reset all cooldowns
      await userRef.update({
        lastTestCompletions: {},
        lastQueueJoins: {}
      });

      res.json({
        success: true,
        message: `All cooldowns reset for ${username}`
      });
    }

  } catch (error) {
    console.error('Error resetting cooldown:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error resetting cooldown'
    });
  }
});

// Add account to alt whitelist
app.post('/api/admin/alt-whitelist', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { identifier } = req.body; // email or firebase UID
    const safeIdentifier = String(identifier || '').trim();

    if (!safeIdentifier) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_IDENTIFIER',
        message: 'Account identifier (email or Firebase UID) is required'
      });
    }

    // Find user
    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const allUsers = usersSnapshot.val() || {};

    let targetUid = null;
    for (const [uid, userData] of Object.entries(allUsers)) {
      if (String(userData.email || '').toLowerCase() === safeIdentifier.toLowerCase() || uid === safeIdentifier) {
        targetUid = uid;
        break;
      }
    }

    let whitelistKey = targetUid;
    let whitelistEmail = targetUid ? allUsers[targetUid].email : null;
    let pendingEmail = false;

    if (!targetUid) {
      const normalizedEmail = String(safeIdentifier || '').trim().toLowerCase();
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail);
      if (!looksLikeEmail) {
        return res.status(404).json({
          error: true,
          code: 'USER_NOT_FOUND',
          message: 'User not found. Enter an email address to whitelist a future signup.'
        });
      }

      whitelistKey = getAltWhitelistEmailKey(normalizedEmail);
      whitelistEmail = normalizedEmail;
      pendingEmail = true;
    }

    // Add to whitelist
    const whitelistRef = db.ref(`altWhitelist/${whitelistKey}`);
    await whitelistRef.set({
      whitelistedAt: new Date().toISOString(),
      whitelistedBy: req.user.uid,
      email: whitelistEmail,
      pendingEmail,
      firebaseUid: targetUid || null
    });

    res.json({
      success: true,
      message: pendingEmail
        ? 'Email added to alt detection whitelist for future signup'
        : 'Account added to alt detection whitelist'
    });

  } catch (error) {
    console.error('Error adding to whitelist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error adding to whitelist'
    });
  }
});

// Remove account from alt whitelist
app.delete('/api/admin/alt-whitelist/:firebaseUid', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { firebaseUid } = req.params;
    const whitelistRef = db.ref(`altWhitelist/${firebaseUid}`);

    await whitelistRef.remove();

    res.json({
      success: true,
      message: 'Account removed from alt detection whitelist'
    });

  } catch (error) {
    console.error('Error removing from whitelist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing from whitelist'
    });
  }
});

// Search alt reports
app.get('/api/admin/alt-reports/search', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { q: searchTerm } = req.query;

    if (!searchTerm) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_SEARCH_TERM',
        message: 'Search term is required'
      });
    }

    const reportsRef = db.ref('altReports');
    const reportsSnapshot = await reportsRef.once('value');
    const allReports = reportsSnapshot.val() || {};

    const matchingReports = Object.keys(allReports)
      .filter(id => {
        const report = allReports[id];
        const searchLower = searchTerm.toLowerCase();

        // Search in group ID, primary account, emails, UIDs
        return report.groupId?.toLowerCase().includes(searchLower) ||
               report.primaryAccount?.toLowerCase().includes(searchLower) ||
               report.suspiciousAccounts?.some(acc =>
                 acc.email?.toLowerCase().includes(searchLower) ||
                 acc.uid?.toLowerCase().includes(searchLower)
               );
      })
      .map(id => ({
        id,
        ...allReports[id]
      }));

    res.json({
      success: true,
      reportedAccounts: matchingReports
    });

  } catch (error) {
    console.error('Error searching alt reports:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error searching alt reports'
    });
  }
});

// Get alt whitelist
app.get('/api/admin/alt-whitelist', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const whitelistRef = db.ref('altWhitelist');
    const whitelistSnapshot = await whitelistRef.once('value');
    const whitelist = whitelistSnapshot.val() || {};

    const whitelistedAccounts = Object.keys(whitelist).map(uid => ({
      firebaseUid: uid,
      ...whitelist[uid]
    }));

    res.json({
      success: true,
      whitelistedAccounts
    });

  } catch (error) {
    console.error('Error fetching whitelist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching whitelist'
    });
  }
});

// Search blacklist
app.get('/api/admin/blacklist/search', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'blacklist:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Blacklist view capability required' });
    }

    const safeSearchTerm = sanitizeSearchQuery(req.query.q, 120);
    const includeExpired = parseBooleanParam(req.query.includeExpired, false);
    const { limit: safeLimit, page: safePage } = parsePaginationParams(req.query, 25, 200);

    if (!safeSearchTerm) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_SEARCH_TERM',
        message: 'Search term is required'
      });
    }

    const blacklistRef = db.ref('blacklist');
    const blacklistSnapshot = await blacklistRef.once('value');
    const blacklist = blacklistSnapshot.val() || {};

    const matchingEntries = [];

    for (const [id, entry] of Object.entries(blacklist)) {
      const active = isBlacklistEntryActive(entry);
      if (!active && !includeExpired) {
        continue;
      }

      if (entry.username?.toLowerCase().includes(safeSearchTerm.toLowerCase())) {
        matchingEntries.push({
          id,
          username: entry.username,
          userId: entry.userId || null,
          reason: entry.reason,
          addedAt: entry.addedAt,
          addedBy: entry.addedBy,
          expiresAt: entry.expiresAt || null,
          disabledFunctions: entry.disabledFunctions || {},
          active,
          temporary: Boolean(parseDateToMs(entry.expiresAt))
        });
      }
    }

    const total = matchingEntries.length;
    const start = (safePage - 1) * safeLimit;

    res.json({
      success: true,
      blacklist: matchingEntries.slice(start, start + safeLimit),
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    });

  } catch (error) {
    console.error('Error searching blacklist:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error searching blacklist'
    });
  }
});

// Search users
app.get('/api/admin/users/search', verifyAuth, verifyAdmin, adminSearchLimiter, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users view capability required' });
    }

    const safeSearchTerm = sanitizeSearchQuery(req.query.q, 120);
    const role = sanitizeSearchQuery(String(req.query.role || 'all'), 20).toLowerCase();
    const status = sanitizeSearchQuery(String(req.query.status || 'all'), 20).toLowerCase();
    const { limit: safeLimit, page: safePage } = parsePaginationParams(req.query, 25, 200);

    if (!safeSearchTerm) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_SEARCH_TERM',
        message: 'Search term is required'
      });
    }

    const usersRef = db.ref('users');
    const usersSnapshot = await usersRef.once('value');
    const allUsers = usersSnapshot.val() || {};
    const staffRoles = await getAllStaffRoles().catch(() => ({}));
    const playersSnapshot = await db.ref('players').once('value');
    const allPlayers = playersSnapshot.val() || {};

    const playersByUserId = new Map();
    const playersByUsername = new Map();
    for (const [playerId, playerData] of Object.entries(allPlayers)) {
      const normalizedPlayerUsername = normalizeMinecraftUsername(playerData?.username);
      const playerRecord = {
        id: playerId,
        ...playerData
      };

      if (playerData?.userId && !playersByUserId.has(playerData.userId)) {
        playersByUserId.set(playerData.userId, playerRecord);
      }

      if (normalizedPlayerUsername && !playersByUsername.has(normalizedPlayerUsername)) {
        playersByUsername.set(normalizedPlayerUsername, playerRecord);
      }
    }

    const matchingUsers = [];

    const searchTermLower = safeSearchTerm.toLowerCase();
    for (const [firebaseUid, userData] of Object.entries(allUsers)) {
      const normalizedUserUsername = normalizeMinecraftUsername(userData?.minecraftUsername);
      const linkedPlayer = playersByUserId.get(firebaseUid)
        || (normalizedUserUsername ? playersByUsername.get(normalizedUserUsername) : null)
        || null;
      const resolvedMinecraftUsername = linkedPlayer?.username || userData.minecraftUsername || null;

      // Check if search term matches email, Firebase UID, or Minecraft username
      const matchesSearch =
        userData.email?.toLowerCase().includes(searchTermLower) ||
        firebaseUid.toLowerCase().includes(searchTermLower) ||
        userData.minecraftUsername?.toLowerCase().includes(searchTermLower) ||
        linkedPlayer?.username?.toLowerCase().includes(searchTermLower) ||
        String(linkedPlayer?.id || '').toLowerCase().includes(searchTermLower);

      if (matchesSearch) {
        const testerFlag = userData.tester || userData.tierTester || false;
        matchingUsers.push({
          id: firebaseUid,
          email: userData.email,
          minecraftUsername: resolvedMinecraftUsername,
          admin: userData.admin || false,
          tester: testerFlag,
          tierTester: testerFlag,
          banned: userData.banned || false,
          builtinStaffRoleIds: getBuiltinStaffRoleIds(userData),
          staffRoleIds: getAssignedStaffRoleIds(userData),
          staffRoleId: userData.staffRoleId || null,
          staffRole: resolveStaffRoleForProfile(userData, staffRoles),
          linkedPlayerId: linkedPlayer?.id || null,
          linkedPlayerUsername: linkedPlayer?.username || null,
          linkedPlayerBlacklisted: linkedPlayer?.blacklisted || false,
          linkedPlayerUserId: linkedPlayer?.userId || null
        });
      }
    }

    let filteredUsers = matchingUsers;
    if (role !== 'all') {
      filteredUsers = filteredUsers.filter(user => {
        if (role === 'admin') return user.admin === true;
        if (role === 'tester') return user.tester === true || user.tierTester === true;
        if (role === 'user') return !user.admin && !user.tester && !user.tierTester;
        return true;
      });
    }

    if (status !== 'all') {
      filteredUsers = filteredUsers.filter(user => {
        if (status === 'banned') return user.banned === true;
        if (status === 'active') return user.banned !== true;
        return true;
      });
    }

    const total = filteredUsers.length;
    const start = (safePage - 1) * safeLimit;

    res.json({
      success: true,
      users: filteredUsers.slice(start, start + safeLimit),
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    });

  } catch (error) {
    console.error('Error searching users:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error searching users'
    });
  }
});

// Search players
app.get('/api/admin/players/search', verifyAuth, verifyAdmin, adminSearchLimiter, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Users view capability required' });
    }

    const safeSearchTerm = sanitizeSearchQuery(req.query.q, 120);
    const { limit: safeLimit, page: safePage } = parsePaginationParams(req.query, 25, 200);

    if (!safeSearchTerm) {
      return res.status(400).json({
        error: true,
        code: 'MISSING_SEARCH_TERM',
        message: 'Search term is required'
      });
    }

    const playersRef = db.ref('players');
    const playersSnapshot = await playersRef.once('value');
    const allPlayers = playersSnapshot.val() || {};
    const staffRoles = await getAllStaffRoles().catch(() => ({}));
    const usersSnapshot = await db.ref('users').once('value');
    const allUsers = usersSnapshot.val() || {};

    const usersByMinecraftUsername = new Map();
    for (const [firebaseUid, userData] of Object.entries(allUsers)) {
      const normalizedUserUsername = normalizeMinecraftUsername(userData?.minecraftUsername);
      if (normalizedUserUsername && !usersByMinecraftUsername.has(normalizedUserUsername)) {
        usersByMinecraftUsername.set(normalizedUserUsername, {
          id: firebaseUid,
          profile: userData
        });
      }
    }

    const matchingPlayers = [];

    const searchTermLower = safeSearchTerm.toLowerCase();
    for (const [playerId, playerData] of Object.entries(allPlayers)) {
      const normalizedPlayerUsername = normalizeMinecraftUsername(playerData?.username);
      const matchedUserEntry = (playerData.userId && allUsers[playerData.userId])
        ? { id: playerData.userId, profile: allUsers[playerData.userId] }
        : (normalizedPlayerUsername ? usersByMinecraftUsername.get(normalizedPlayerUsername) : null);
      const linkedUserId = matchedUserEntry?.id || playerData.userId || null;
      const linkedUserProfile = matchedUserEntry?.profile || null;
      const testerFlag = linkedUserProfile?.tester || linkedUserProfile?.tierTester || false;

      const matchesSearch =
        playerData.username?.toLowerCase().includes(searchTermLower) ||
        playerId.toLowerCase().includes(searchTermLower) ||
        String(playerData.userId || '').toLowerCase().includes(searchTermLower) ||
        String(linkedUserId || '').toLowerCase().includes(searchTermLower) ||
        linkedUserProfile?.email?.toLowerCase().includes(searchTermLower) ||
        linkedUserProfile?.minecraftUsername?.toLowerCase().includes(searchTermLower);

      if (matchesSearch) {
        matchingPlayers.push({
          id: playerId,
          username: playerData.username,
          userId: linkedUserId,
          email: linkedUserProfile?.email || null,
          minecraftUsername: linkedUserProfile?.minecraftUsername || null,
          admin: linkedUserProfile?.admin || false,
          tester: testerFlag,
          tierTester: testerFlag,
          banned: linkedUserProfile?.banned || false,
          builtinStaffRoleIds: getBuiltinStaffRoleIds(linkedUserProfile || {}),
          staffRoleIds: getAssignedStaffRoleIds(linkedUserProfile || {}),
          staffRoleId: linkedUserProfile?.staffRoleId || null,
          staffRole: linkedUserProfile ? resolveStaffRoleForProfile(linkedUserProfile, staffRoles) : null,
          totalPoints: playerData.totalPoints || 0,
          gamemodeTiers: playerData.gamemodeTiers || {},
          blacklisted: playerData.blacklisted || false,
          region: playerData.region
        });
      }
    }

    const total = matchingPlayers.length;
    const start = (safePage - 1) * safeLimit;

    res.json({
      success: true,
      players: matchingPlayers.slice(start, start + safeLimit),
      total,
      pagination: {
        page: safePage,
        limit: safeLimit,
        total,
        totalPages: Math.max(1, Math.ceil(total / safeLimit))
      }
    });

  } catch (error) {
    console.error('Error searching players:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error searching players'
    });
  }
});

// Error handling middleware (must be last)
let errorHandler, notFoundHandler;
try {
  const errorHandlers = require('./middleware/error-handler');
  errorHandler = errorHandlers.errorHandler;
  notFoundHandler = errorHandlers.notFoundHandler;
} catch (e) {
  // Fallback if middleware file doesn't exist
  notFoundHandler = (req, res) => {
    res.status(404).json({
      error: true,
      code: 'NOT_FOUND',
      message: `Route ${req.method} ${req.path} not found`
    });
  };
  errorHandler = (err, req, res, next) => {
    console.error('Error:', err);
    const status = err.status || err.statusCode || 500;
    const message = err.message || 'Internal Server Error';
    const code = err.code || 'SERVER_ERROR';
    res.status(status).json({
      error: true,
      code,
      message: config.nodeEnv === 'development' ? message : 'An error occurred'
    });
  };
}

// ===== User Management Endpoints =====

/**
 * POST /api/admin/users/:userId/manage - Admin user management actions
 */
app.post('/api/admin/users/:userId/manage', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage')) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Users manage capability required'
      });
    }

    const { userId } = req.params;
    const { action, reason, note } = req.body;

    if (!userId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'userId is required'
      });
    }

    if (!action) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'action is required'
      });
    }

    const userRef = db.ref(`users/${userId}`);
    const userSnapshot = await userRef.once('value');
    const userData = userSnapshot.val();

    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    let responseMessage = '';
    let responseData = {};

    switch (action) {
      case 'verify_username':
        // Manually verify the user's Minecraft username
        await setStoredUserProfile(userId, {
          minecraftVerified: true,
          verificationCode: null,
          verificationCodeExpiry: null
        }, { merge: true });
        responseMessage = 'Username manually verified';
        
        await logAdminAction(req, req.user.uid, 'VERIFY_USERNAME', userId, {
          username: userData.minecraftUsername
        });
        break;

      case 'reset_onboarding':
        // Reset onboarding status to allow user to redo it
        await setStoredUserProfile(userId, {
          onboardingCompleted: false,
          minecraftUsername: null,
          minecraftVerified: false,
          region: null,
          verificationCode: null,
          verificationCodeExpiry: null,
          gamemodePreferences: null,
          skillLevels: null
        }, { merge: true });
        responseMessage = 'Onboarding reset successfully';
        
        await logAdminAction(req, req.user.uid, 'RESET_ONBOARDING', userId, {});
        break;

      case 'ban_user':
        if (!reason) {
          return res.status(400).json({
            error: true,
            code: 'VALIDATION_ERROR',
            message: 'Ban reason is required'
          });
        }
        
        await setStoredUserProfile(userId, {
          banned: true,
          banReason: reason,
          bannedAt: Date.now(),
          bannedBy: req.user.uid
        }, { merge: true });
        responseMessage = 'User banned successfully';
        
        await logAdminAction(req, req.user.uid, 'BAN_USER', userId, { reason });
        break;

      case 'unban_user':
        await setStoredUserProfile(userId, {
          banned: false,
          banReason: null,
          bannedAt: null,
          bannedBy: null
        }, { merge: true });
        responseMessage = 'User unbanned successfully';
        
        await logAdminAction(req, req.user.uid, 'UNBAN_USER', userId, {});
        break;

      case 'reset_password':
        // Send password reset email via Firebase Auth
        try {
          const userRecord = await admin.auth().getUser(userId);
          await admin.auth().generatePasswordResetLink(userRecord.email);
          responseMessage = 'Password reset email sent';
          
          await logAdminAction(req, req.user.uid, 'RESET_PASSWORD', userId, {
            email: userRecord.email
          });
        } catch (authError) {
          console.error('Error sending password reset:', authError);
          return res.status(500).json({
            error: true,
            code: 'AUTH_ERROR',
            message: 'Failed to send password reset email'
          });
        }
        break;

      case 'delete_account':
        // Permanently delete user account and all associated data
        try {
          const cleanupNotes = [];

          // Delete from Firebase Auth (if user exists there)
          try {
            await admin.auth().deleteUser(userId);
          } catch (authDeleteError) {
            if (authDeleteError?.code === 'auth/user-not-found') {
              cleanupNotes.push('Auth user not found; database cleanup continued.');
            } else {
              throw authDeleteError;
            }
          }
          
          // Delete from database
          await deleteStoredUserProfile(userId);

          // Clean up moderation and notes documents tied to this account.
          await Promise.all([
            deleteAdminNoteEntries(userId).catch(() => null),
            deleteUserModerationHistoryEntries(userId).catch(() => null),
            db.ref(`tempUnblocks/${userId}`).remove().catch(() => null)
          ]);
          
          // Delete associated player record if exists
          if (userData.minecraftUsername) {
            const playersRef = db.ref('players');
            const playerQuery = playersRef.orderByChild('userId').equalTo(userId);
            const playerSnapshot = await playerQuery.once('value');
            
            if (playerSnapshot.exists()) {
              const updates = {};
              playerSnapshot.forEach(child => {
                updates[child.key] = null;
              });
              await playersRef.update(updates);
            }
          }
          
          responseMessage = cleanupNotes.length > 0
            ? `Account deleted with notes: ${cleanupNotes.join(' ')}`
            : 'Account deleted successfully';
          
          await logAdminAction(req, req.user.uid, 'DELETE_ACCOUNT', userId, {
            email: userData.email,
            username: userData.minecraftUsername,
            cleanupNotes
          });
        } catch (deleteError) {
          console.error('Error deleting account:', deleteError);
          return res.status(500).json({
            error: true,
            code: 'DELETE_ERROR',
            message: deleteError?.message || 'Failed to delete account'
          });
        }
        break;

      case 'view_notes':
        // Return admin notes history for this user
        const notes = await listAdminNoteEntries(userId);
        
        // Sort by timestamp descending
        notes.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        
        responseData = { notes };
        responseMessage = 'Notes retrieved successfully';
        break;

      case 'set_note':
        // Add a note to the user's admin notes history
        if (!note || typeof note !== 'string' || note.trim().length === 0) {
          return res.status(400).json({
            error: true,
            code: 'VALIDATION_ERROR',
            message: 'Note content is required'
          });
        }
        
        await addAdminNoteEntry(userId, {
          note: note.trim().slice(0, 1000),
          adminUid: req.user.uid,
          adminEmail: req.user.email,
          timestamp: Date.now()
        });
        
        responseMessage = 'Admin note added successfully';
        
        await logAdminAction(req, req.user.uid, 'SET_USER_NOTE', userId, {
          note: note.trim().slice(0, 100) // Log first 100 chars
        });
        break;

      default:
        return res.status(400).json({
          error: true,
          code: 'INVALID_ACTION',
          message: `Unknown action: ${action}`
        });
    }

    res.json({
      success: true,
      message: responseMessage,
      ...responseData
    });
  } catch (error) {
    console.error('Error managing user:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error managing user'
    });
  }
});

/**
 * POST /api/admin/users/:userId/restrictions - Set per-feature restrictions
 */
app.post('/api/admin/users/:userId/restrictions', adminLimiter, verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'users:manage')) {
      return res.status(403).json({
        error: true,
        code: 'PERMISSION_DENIED',
        message: 'Users manage capability required'
      });
    }

    const { userId } = req.params;
    const { restrictions, durationHours, reason } = req.body || {};

    if (!userId || !restrictions || typeof restrictions !== 'object') {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'userId and restrictions are required'
      });
    }

    const userData = await getStoredUserProfile(userId);
    if (!userData) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    const safeDurationHours = Number(durationHours) > 0 ? Math.min(Number(durationHours), 24 * 365) : 0;
    const expiresAt = safeDurationHours > 0
      ? new Date(Date.now() + (safeDurationHours * 60 * 60 * 1000)).toISOString()
      : null;

    const nextRestrictions = { ...(userData.functionRestrictions || {}) };
    Object.entries(restrictions).forEach(([featureKey, enabled]) => {
      if (enabled === true) {
        nextRestrictions[featureKey] = {
          active: true,
          reason: reason || 'Restricted by admin',
          setBy: req.user.uid,
          setAt: new Date().toISOString(),
          expiresAt,
          source: 'user'
        };
      } else {
        delete nextRestrictions[featureKey];
      }
    });

    await setStoredUserProfile(userId, {
      functionRestrictions: nextRestrictions,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    await addUserModerationHistoryEntry(userId, {
      type: 'restrictions_updated',
      restrictions,
      reason: reason || 'Restrictions updated',
      expiresAt,
      by: req.user.uid,
      at: new Date().toISOString()
    });

    await logAdminAction(req, req.user.uid, 'SET_USER_RESTRICTIONS', userId, {
      restrictions,
      reason: reason || 'Restrictions updated',
      expiresAt
    });

    res.json({
      success: true,
      message: 'Restrictions updated',
      restrictions: nextRestrictions
    });
  } catch (error) {
    console.error('Error setting user restrictions:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error setting restrictions'
    });
  }
});

/**
 * GET /api/admin/users/:userId/moderation-history - warnings/blacklist/restrictions/audit
 */
app.get('/api/admin/users/:userId/moderation-history', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const { userId } = req.params;
    const profile = await getStoredUserProfile(userId);

    if (!profile) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'User not found'
      });
    }

    const [blacklistSnap, auditLogs, moderationHistory] = await Promise.all([
      db.ref('blacklist').once('value'),
      listAuditLogEntries({ limit: 500 }),
      listUserModerationHistoryEntries(userId)
    ]);

    const warnings = (Array.isArray(profile.warnings) ? profile.warnings : []).slice().sort((a, b) => {
      return parseDateToMs(b?.warnedAt) - parseDateToMs(a?.warnedAt);
    });

    const blacklistEntries = Object.entries(blacklistSnap.val() || {})
      .map(([id, entry]) => ({ id, ...entry }))
      .filter(entry => {
        const entryUsername = String(entry.username || '').toLowerCase();
        return entry.userId === userId || (profile.minecraftUsername && entryUsername === String(profile.minecraftUsername).toLowerCase());
      })
      .sort((a, b) => parseDateToMs(b.addedAt) - parseDateToMs(a.addedAt));

    const matchingAuditLogs = auditLogs
      .filter(log => log.targetUserId === userId)
      .sort((a, b) => parseDateToMs(b.timestamp) - parseDateToMs(a.timestamp))
      .slice(0, 200);
    const sortedModerationHistory = moderationHistory
      .sort((a, b) => parseDateToMs(b.at || b.timestamp) - parseDateToMs(a.at || a.timestamp));

    res.json({
      success: true,
      warnings,
      blacklistEntries,
      restrictions: normalizeRestrictions(profile.functionRestrictions || {}),
      moderationHistory: sortedModerationHistory,
      auditLogs: matchingAuditLogs
    });
  } catch (error) {
    console.error('Error fetching moderation history:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching moderation history'
    });
  }
});

/**
 * POST /api/auth/verify-minecraft-username - Verify Minecraft username via Mojang API
 */
app.post('/api/auth/verify-minecraft-username', usernameVerifyLimiter, async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Username is required'
      });
    }

    // Validate username format (3-16 alphanumeric characters and underscores)
    const usernameRegex = /^[a-zA-Z0-9_]{3,16}$/;
    if (!usernameRegex.test(username)) {
      return res.status(400).json({
        error: true,
        code: 'INVALID_USERNAME',
        message: 'Invalid Minecraft username format. Must be 3-16 alphanumeric characters or underscores.',
        valid: false
      });
    }

    const profile = await fetchMojangProfile(username);
    if (!profile) {
      return res.json({
        success: true,
        valid: false,
        message: 'Username not found. Please check spelling or create a Minecraft account.'
      });
    }

    return res.json({
      success: true,
      valid: true,
      message: 'Username verified',
      uuid: profile.uuid,
      username: profile.username
    });
  } catch (error) {
    console.error('Error verifying Minecraft username:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error verifying username',
      valid: false
    });
  }
});

// ===== Whitelisted Servers Routes =====

/**
 * GET /api/whitelisted-servers - Get all whitelisted servers (public)
 */
app.get('/api/whitelisted-servers', async (req, res) => {
  try {
    const serversRef = db.ref('whitelistedServers');
    const snapshot = await serversRef.once('value');
    const servers = snapshot.val() || {};

    // Convert to array and sort by name
    const serversArray = Object.entries(servers).map(([id, server]) => ({
      id,
      ...server
    })).sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json({
      success: true,
      servers: serversArray
    });
  } catch (error) {
    console.error('Error fetching whitelisted servers:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error fetching servers.'
    });
  }
});

/**
 * POST /api/admin/whitelisted-servers - Add a whitelisted server (Admin only)
 */
app.post('/api/admin/whitelisted-servers', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { name, ip } = req.body;

    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Server name is required'
      });
    }

    if (!ip || typeof ip !== 'string' || ip.trim().length === 0) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Server IP is required'
      });
    }

    // Basic IP/domain validation
    const ipRegex = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}(:[0-9]+)?$/;
    if (!ipRegex.test(ip.trim())) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Invalid IP address or domain format'
      });
    }

    const serversRef = db.ref('whitelistedServers');
    const newServerRef = serversRef.push();
    
    await newServerRef.set({
      name: name.trim(),
      ip: ip.trim(),
      addedBy: req.user.uid,
      addedAt: new Date().toISOString()
    });

    // Log admin action
    await logAdminAction(req, req.user.uid, 'ADD_WHITELISTED_SERVER', newServerRef.key, {
      name: name.trim(),
      ip: ip.trim()
    });

    res.json({
      success: true,
      message: 'Server added successfully',
      serverId: newServerRef.key
    });
  } catch (error) {
    console.error('Error adding whitelisted server:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error adding server.'
    });
  }
});

/**
 * DELETE /api/admin/whitelisted-servers/:serverId - Remove a whitelisted server (Admin only)
 */
app.delete('/api/admin/whitelisted-servers/:serverId', verifyAuthAndNotBanned, verifyAdmin, async (req, res) => {
  try {
    const { serverId } = req.params;

    if (!serverId) {
      return res.status(400).json({
        error: true,
        code: 'VALIDATION_ERROR',
        message: 'Server ID is required'
      });
    }

    const serverRef = db.ref(`whitelistedServers/${serverId}`);
    const snapshot = await serverRef.once('value');
    
    if (!snapshot.exists()) {
      return res.status(404).json({
        error: true,
        code: 'NOT_FOUND',
        message: 'Server not found'
      });
    }

    const serverData = snapshot.val();

    // Delete the server
    await serverRef.remove();

    // Log admin action
    await logAdminAction(req, req.user.uid, 'REMOVE_WHITELISTED_SERVER', serverId, {
      name: serverData.name,
      ip: serverData.ip
    });

    res.json({
      success: true,
      message: 'Server removed successfully'
    });
  } catch (error) {
    console.error('Error removing whitelisted server:', error);
    res.status(500).json({
      error: true,
      code: 'SERVER_ERROR',
      message: 'Error removing server.'
    });
  }
});

/**
 * GET /api/admin/security-scores - Paginated list of player security scores
 */
app.get('/api/admin/security-scores', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    const limitVal = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const startAfter = req.query.startAfter ? parseInt(req.query.startAfter, 10) : null;
    const riskFilter = req.query.riskLevel || null; // 'critical'|'high'|'medium'|'low'|'clean'

    let scores = [];

    if (!adminHasCapability(req, 'audit:view') && !adminHasCapability(req, 'security_scores:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Security score access required' });
    }

    if (fsdb) {
      try {
        let query = fsdb.collection('securityScores').orderBy('score', 'desc');
        if (riskFilter) query = query.where('riskLevel', '==', riskFilter);
        if (Number.isFinite(startAfter)) query = query.startAfter(startAfter);
        query = query.limit(limitVal);

        const snap = await query.get();
        scores = snap.docs.map((doc) => ({ userId: doc.id, ...doc.data() }));
      } catch (firestoreError) {
        logger.warn('Firestore security score list failed; falling back to RTDB', { error: firestoreError });
        scores = [];
      }
    }

    if (scores.length === 0) {
      scores = await listStoredSecurityScores({
        limit: limitVal,
        riskLevel: riskFilter,
        startAfter
      });
    }

    res.json({ scores, total: scores.length, limit: limitVal });
  } catch (err) {
    console.error('[SecurityScores] List error:', err);
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error fetching security scores' });
  }
});

/**
 * GET /api/admin/security-scores/:userId - Score for a single user
 */
app.get('/api/admin/security-scores/:userId', verifyAuth, verifyAdmin, async (req, res) => {
  try {
    if (!adminHasCapability(req, 'audit:view') && !adminHasCapability(req, 'security_scores:view')) {
      return res.status(403).json({ error: true, code: 'PERMISSION_DENIED', message: 'Security score access required' });
    }

    const { userId } = req.params;
    if (!userId || typeof userId !== 'string') {
      return res.status(400).json({ error: true, code: 'VALIDATION_ERROR', message: 'userId required' });
    }

    // Always recompute on demand for single-user view
    const score = await computeAndStoreSecurityScore(userId);
    if (!score) {
      return res.status(404).json({ error: true, code: 'NOT_FOUND', message: 'User not found or no matches' });
    }
    res.json(score);
  } catch (err) {
    logger.error('Security score detail computation failed', { error: err });
    res.status(500).json({ error: true, code: 'SERVER_ERROR', message: 'Error computing score' });
  }
});

app.use(notFoundHandler);
app.use(errorHandler);

// ---------------------------------------------------------------------------
// SECURITY SCORING SYSTEM
// Computes a numeric fraud/rigging risk score per user, stored in Firestore.
// Score factors (additive, unbounded):
//   • Each match finalized in <30 s      → +60 per match
//   • Each match finalized in 30–60 s    → +25 per match
//   • 5+ consecutive matches all <60 s   → +100 cluster bonus
//   • Same opponent >3 times recent 20   → +20 per extra occurrence beyond 3
//   • Win rate 95–100% or 0–5% (≥5 m)   → +45
//   • Automated timing (std dev <120 s)  → +50
//   • Existing security-log entries      → +15 per entry (cap 10 entries)
// Risk levels: clean(<20) low(20-39) medium(40-69) high(70-99) critical(≥100)
// ---------------------------------------------------------------------------

const SECURITY_SCORE_CACHE_TTL_MS = 5 * 60 * 1000; // Only re-compute if 5 min old

async function computeAndStoreSecurityScore(userId) {
  if (!userId) return null;

  try {
    // Throttle: skip if score is fresh
    const existing = await readStoredSecurityScore(userId);
    if (existing && existing.lastComputed) {
      const age = Date.now() - new Date(existing.lastComputed).getTime();
      if (age < SECURITY_SCORE_CACHE_TTL_MS) return existing;
    }

    // ---- Gather data ----
    const [matchesSnap, secLogs, userProfile] = await Promise.all([
      db.ref('matches')
        .orderByChild('playerId').equalTo(userId)
        .limitToLast(50)
        .once('value'),
      listSecurityLogEntries({ limit: 10, userId }),
      getStoredUserProfile(userId)
    ]);

    const matchMap = matchesSnap.val() || {};
    const filteredSecurityLogs = secLogs.filter(log => log?.type !== 'multiple_ip_addresses');

    // Also include matches where this user was a tester
    const testerMatchesSnap = await db.ref('matches')
      .orderByChild('testerId').equalTo(userId)
      .limitToLast(50)
      .once('value');
    const testerMatchMap = testerMatchesSnap.val() || {};

    const allMatchList = Object.values({ ...matchMap, ...testerMatchMap })
      .filter(m => m.finalized && m.status === 'ended')
      .sort((a, b) => new Date(a.finalizedAt || a.createdAt) - new Date(b.finalizedAt || b.createdAt));

    // ---- Derive username ----
    let username = userProfile.minecraftUsername || userProfile.email || userId;
    if (!username || username === userId) {
      const playerSnap = await db.ref('players').orderByChild('userId').equalTo(userId).limitToFirst(1).once('value');
      const playerVal = playerSnap.val();
      if (playerVal) {
        username = Object.values(playerVal)[0]?.username || username;
      }
    }

    // ---- Score computation ----
    let score = 0;
    const factors = [];
    const recentMatches = allMatchList.slice(-20);

    // Factor 1: Ultra-fast / fast match durations
    let ultraFastCount = 0;
    let fastCount = 0;
    for (const m of recentMatches) {
      const dur = m.finalizedAt && m.createdAt
        ? new Date(m.finalizedAt).getTime() - new Date(m.createdAt).getTime()
        : null;
      if (dur !== null && dur >= 0) {
        if (dur < 30000) ultraFastCount++;
        else if (dur < 60000) fastCount++;
      }
    }
    if (ultraFastCount > 0) {
      const pts = ultraFastCount * 60;
      score += pts;
      factors.push({ id: 'ultra_fast_matches', label: `${ultraFastCount} match${ultraFastCount > 1 ? 'es' : ''} finalized in under 30 s`, points: pts, severity: 'critical' });
    }
    if (fastCount > 0) {
      const pts = fastCount * 25;
      score += pts;
      factors.push({ id: 'fast_matches', label: `${fastCount} match${fastCount > 1 ? 'es' : ''} finalized in 30–60 s`, points: pts, severity: 'high' });
    }

    // Factor 2: Cluster bonus – 5+ consecutive matches all under 60 s
    let maxCluster = 0;
    let currentCluster = 0;
    for (const m of recentMatches) {
      const dur = m.finalizedAt && m.createdAt
        ? new Date(m.finalizedAt).getTime() - new Date(m.createdAt).getTime()
        : 999999;
      if (dur < 60000) {
        currentCluster++;
        maxCluster = Math.max(maxCluster, currentCluster);
      } else {
        currentCluster = 0;
      }
    }
    if (maxCluster >= 5) {
      score += 100;
      factors.push({ id: 'match_cluster', label: `Cluster of ${maxCluster} consecutive sub-60 s matches`, points: 100, severity: 'critical' });
    }

    // Factor 3: Repeated opponent
    const opponentCount = {};
    for (const m of recentMatches) {
      const opp = m.playerId === userId ? m.testerId : m.playerId;
      if (opp) opponentCount[opp] = (opponentCount[opp] || 0) + 1;
    }
    const maxOpp = Math.max(0, ...Object.values(opponentCount));
    if (maxOpp > 3) {
      const pts = (maxOpp - 3) * 20;
      score += pts;
      factors.push({ id: 'repeated_opponent', label: `Played the same opponent ${maxOpp}× in recent matches`, points: pts, severity: 'high' });
    }

    // Factor 4: Extreme win/loss rate (only player-side matches)
    const playerMatches = recentMatches.filter(m => m.playerId === userId);
    if (playerMatches.length >= 5) {
      const wins = playerMatches.filter(m => {
        const ps = m.finalizationData?.playerScore ?? m.result?.playerScore ?? 0;
        const ts = m.finalizationData?.testerScore ?? m.result?.testerScore ?? 0;
        return ps > ts;
      }).length;
      const rate = wins / playerMatches.length;
      if (rate >= 0.95 || rate <= 0.05) {
        score += 45;
        factors.push({ id: 'extreme_win_rate', label: `${(rate * 100).toFixed(0)}% win rate over ${playerMatches.length} matches`, points: 45, severity: 'high' });
      }
    }

    // Factor 5: Automated timing – std dev of intervals < 120 s
    const finalizationTimes = recentMatches
      .filter(m => m.finalizedAt)
      .map(m => new Date(m.finalizedAt).getTime())
      .sort((a, b) => a - b);
    if (finalizationTimes.length >= 5) {
      const intervals = [];
      for (let i = 1; i < finalizationTimes.length; i++) {
        intervals.push(finalizationTimes[i] - finalizationTimes[i - 1]);
      }
      const avg = intervals.reduce((a, b) => a + b, 0) / intervals.length;
      const variance = intervals.reduce((s, v) => s + Math.pow(v - avg, 2), 0) / intervals.length;
      const stdDev = Math.sqrt(variance);
      if (stdDev < 120000 && avg < 600000) {
        score += 50;
        factors.push({ id: 'automated_timing', label: `Suspiciously consistent match intervals (σ=${(stdDev / 1000).toFixed(0)} s)`, points: 50, severity: 'high' });
      }
    }

    // Factor 6: Existing security log entries
    const logCount = Math.min(filteredSecurityLogs.length, 10);
    if (logCount > 0) {
      const pts = logCount * 15;
      score += pts;
      factors.push({ id: 'security_logs', label: `${logCount} existing security flag${logCount > 1 ? 's' : ''}`, points: pts, severity: logCount >= 3 ? 'critical' : 'medium' });
    }

    // ---- Risk level ----
    let riskLevel = 'clean';
    if (score >= 100) riskLevel = 'critical';
    else if (score >= 70) riskLevel = 'high';
    else if (score >= 40) riskLevel = 'medium';
    else if (score >= 20) riskLevel = 'low';

    const result = {
      userId,
      username,
      score,
      riskLevel,
      factors,
      matchCount: allMatchList.length,
      isTester: !!(userProfile.tester === true),
      isAdmin: !!(userProfile.admin === true || userProfile.adminRole),
      lastComputed: new Date().toISOString()
    };

    // Persist to available storage. Firestore remains primary when configured,
    // but RTDB is kept in sync so scores still exist in environments without Firestore.
    await writeStoredSecurityScore(userId, result);

    return result;
  } catch (err) {
    console.error('[SecurityScore] Error computing score for', userId, err.message);
    return null;
  }
}

// Start server
app.listen(PORT, async () => {
  logger.info('MC Leaderboards API server started', {
    port: PORT,
    environment: config.nodeEnv,
    healthCheckPath: `/api/health`
  });
  
  // FIX #2: On startup, check for any matches that timed out during server downtime
  logger.info('Checking for timed-out matches missed during downtime');
  try {
    await checkMissedTimeouts();
  } catch (error) {
    logger.error('Missed-timeout startup recovery failed', { error });
  }

  registerMaintenanceJobs({
    db,
    logger,
    checkMissedTimeouts,
    checkAndTerminateBlacklistedMatches,
    detectAccountAnomalies,
    checkAndFlagSuspiciousAccount,
    cleanupExpiredPlusSubscriptions,
    cleanupRetiredNotificationData,
    createRealtimeDatabaseFirestoreBackup
  });
});
