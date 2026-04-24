// MC Leaderboards - Database Backup Script
// Stores the Firebase Realtime Database inside Firestore as a chunked backup.

const { createRealtimeDatabaseFirestoreBackup } = require('./firestore-rtdb-backup-utils');

/**
 * Backup entire database
 */
async function backupDatabase() {
  try {
    console.log('Starting Firestore Realtime Database backup...\n');
    const result = await createRealtimeDatabaseFirestoreBackup('manual-script');
    console.log(`✓ Backup created in Firestore: ${result.backupId}`);
    console.log(`✓ Chunks stored: ${result.chunkCount}`);
    console.log(`✓ Payload length: ${result.payloadLength} bytes`);
    console.log('\n✓ Backup process completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error backing up database:', error);
    process.exit(1);
  }
}

// Run backup
backupDatabase();

