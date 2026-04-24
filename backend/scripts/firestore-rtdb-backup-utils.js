const admin = require('firebase-admin');
const { loadRuntimeConfig } = require('../config');

const { serviceAccount, config } = loadRuntimeConfig();
const BACKUP_COLLECTION = 'realtimeDatabaseBackups';
const CHUNK_SIZE = 900000;

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: config.databaseURL
  });
}

const db = admin.database();
const fsdb = admin.firestore();

function chunkString(value, size) {
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  return chunks;
}

async function deleteBackupDoc(docId) {
  const backupRef = fsdb.collection(BACKUP_COLLECTION).doc(docId);
  const chunkSnapshot = await backupRef.collection('chunks').get();
  const batch = fsdb.batch();
  chunkSnapshot.docs.forEach((doc) => batch.delete(doc.ref));
  batch.delete(backupRef);
  await batch.commit();
}

async function createRealtimeDatabaseFirestoreBackup(reason = 'manual') {
  const snapshot = await db.ref('/').once('value');
  const payload = JSON.stringify(snapshot.val() || {});
  const chunks = chunkString(payload, CHUNK_SIZE);
  const backupId = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRef = fsdb.collection(BACKUP_COLLECTION).doc(backupId);

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

  const existingBackups = await fsdb.collection(BACKUP_COLLECTION).orderBy('createdAt', 'desc').get();
  const staleDocs = existingBackups.docs.slice(1);
  for (const staleDoc of staleDocs) {
    await deleteBackupDoc(staleDoc.id);
  }

  return {
    backupId,
    chunkCount: chunks.length,
    payloadLength: payload.length
  };
}

async function listRealtimeDatabaseBackups(limit = 5) {
  const snapshot = await fsdb.collection(BACKUP_COLLECTION)
    .orderBy('createdAt', 'desc')
    .limit(Math.max(1, limit))
    .get();

  return snapshot.docs.map((doc) => doc.data());
}

async function loadBackupPayload(backupId) {
  const backupRef = fsdb.collection(BACKUP_COLLECTION).doc(backupId);
  const backupSnap = await backupRef.get();
  if (!backupSnap.exists) {
    throw new Error(`Backup not found: ${backupId}`);
  }

  const chunkSnapshot = await backupRef.collection('chunks').orderBy('order', 'asc').get();
  const payload = chunkSnapshot.docs.map((doc) => doc.data().content || '').join('');
  return {
    metadata: backupSnap.data(),
    data: JSON.parse(payload || '{}')
  };
}

async function restoreRealtimeDatabaseFromFirestoreBackup(backupId) {
  let resolvedBackupId = backupId;
  if (!resolvedBackupId) {
    const backups = await listRealtimeDatabaseBackups(1);
    if (!backups.length) {
      throw new Error('No Firestore Realtime Database backups were found');
    }
    resolvedBackupId = backups[0].backupId;
  }

  const backupPayload = await loadBackupPayload(resolvedBackupId);
  await db.ref('/').set(backupPayload.data);
  return {
    backupId: resolvedBackupId,
    metadata: backupPayload.metadata
  };
}

module.exports = {
  createRealtimeDatabaseFirestoreBackup,
  listRealtimeDatabaseBackups,
  restoreRealtimeDatabaseFromFirestoreBackup
};