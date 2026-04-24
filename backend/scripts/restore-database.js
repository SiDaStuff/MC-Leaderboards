// MC Leaderboards - Database Restore Script
// Restores the Realtime Database from the latest or a specified Firestore backup.

const readline = require('readline');
const {
  listRealtimeDatabaseBackups,
  restoreRealtimeDatabaseFromFirestoreBackup
} = require('./firestore-rtdb-backup-utils');

/**
 * Restore database from backup
 */
async function restoreDatabase(backupId) {
  try {
    const backups = await listRealtimeDatabaseBackups(5);
    if (!backups.length && !backupId) {
      console.error('Error: No Firestore Realtime Database backups were found.');
      process.exit(1);
    }

    const selectedBackup = backupId
      ? { backupId, createdAt: 'Unknown (loaded by id)', chunkCount: 'Unknown' }
      : backups[0];

    console.log(`Preparing to restore backup: ${selectedBackup.backupId}`);
    console.log(`Created at: ${selectedBackup.createdAt}`);
    console.log(`Chunks: ${selectedBackup.chunkCount}`);
    
    // Confirm restoration
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    const answer = await new Promise(resolve => {
      rl.question('\n⚠️  WARNING: This will overwrite all existing data!\nAre you sure you want to continue? (yes/no): ', resolve);
    });
    
    rl.close();
    
    if (answer.toLowerCase() !== 'yes') {
      console.log('Restore cancelled.');
      process.exit(0);
    }
    
    // Restore data
    console.log('\nRestoring database...');
    const result = await restoreRealtimeDatabaseFromFirestoreBackup(selectedBackup.backupId);
    
    console.log(`✓ Database restored successfully from Firestore backup ${result.backupId}!`);
    process.exit(0);
  } catch (error) {
    console.error('Error restoring database:', error);
    process.exit(1);
  }
}

// Optional backup id from command line argument. If omitted, restore the latest Firestore backup.
const backupId = process.argv[2] || null;

// Run restore
restoreDatabase(backupId);

