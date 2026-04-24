# Backend Scripts

Utility scripts for MC Leaderboards backend.

## Available Scripts

### seed-data.js

Populates the database with example data for testing.

**Usage:**
```bash
npm run seed
```

**What it does:**
- Creates example players with tiers and points
- Adds example blacklist entries

**Note:** Make sure Firebase is configured before running.

### cleanup-matches.js

Automatically cleans up old matches on a recurring schedule. Removes matches older than 60 days.

**Usage:**
```bash
# Run once
npm run cleanup

# Run continuously (recommended for production)
node scripts/cleanup-matches.js
```

**What it does:**
- **Continuous Mode**: Runs cleanup every 2 weeks automatically
- **Cleanup Rules**:
  - Removes finalized/cancelled/ended matches older than 60 days
  - Removes long-stale stuck matches older than 60 days
- **Logging**: Detailed logs of removed matches and expired availabilities
- **Graceful Shutdown**: Handles SIGINT/SIGTERM signals properly

**Scheduling:**
- **Cron (Linux/Mac)**: `0 */48 * * * cd /path/to/backend && node scripts/cleanup-matches.js`
- **PM2**: Set up as a persistent background process
- **Windows Task Scheduler**: Run script every 48 hours

**Note:** Best run as a background service for automatic maintenance.

### backup-database.js

Creates a backup of the entire Firebase Realtime Database.

**Usage:**
```bash
npm run backup
```

**What it does:**
- Exports all database data to JSON file
- Saves to `backups/` directory with timestamp
- Keeps last 10 backups, removes older ones
- Creates backup directory if it doesn't exist

**Output:**
- `backups/backup-YYYY-MM-DDTHH-MM-SS-sssZ.json`

**Note:** Run regularly for data protection.

### restore-database.js

Restores database from a backup file.

**Usage:**
```bash
npm run restore ../../backups/backup-2024-01-15T10-00-00-000Z.json
```

**What it does:**
- Reads backup JSON file
- Prompts for confirmation (requires typing "yes")
- Restores all data to database
- **WARNING:** Overwrites existing data!

**Note:** Use with caution! Always backup before restoring.

## Creating New Scripts

1. Create script in `scripts/` directory
2. Add npm script to `package.json`:
   ```json
   "scripts": {
     "your-script": "node scripts/your-script.js"
   }
   ```
3. Document in this README

## Best Practices

- Always handle errors gracefully
- Log operations clearly
- Exit with appropriate codes (0 = success, 1 = error)
- Use environment variables for configuration
- Test scripts before running in production
- Add confirmation prompts for destructive operations

## Scheduled Tasks

### Using Cron (Linux/Mac)

```bash
# Edit crontab
crontab -e

# Run cleanup daily at 2 AM
0 2 * * * cd /path/to/backend && npm run cleanup

# Run backup daily at 3 AM
0 3 * * * cd /path/to/backend && npm run backup
```

### Using Task Scheduler (Windows)

1. Open Task Scheduler
2. Create Basic Task
3. Set trigger (daily, weekly, etc.)
4. Set action: `node` with script path
5. Configure to run in backend directory

### Using PM2 Cron

```bash
pm2 install pm2-cron
pm2 set pm2-cron:cleanup "0 2 * * *"
```
