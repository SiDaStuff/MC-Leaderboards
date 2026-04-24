# MC Leaderboards - Backend API

Express.js backend server for MC Leaderboards.

## Quick Start

```bash
# Install dependencies
npm install

# Create local config
cp .env.example .env

# Start server
npm start

# Development mode
npm run dev
```

## Configuration

The backend supports both `key.json` and `.env`.

Priority order:
- Process environment / `backend/.env`
- `FIREBASE_SERVICE_ACCOUNT_PATH`
- `backend/key.json`

You can use either approach:

1. `key.json` file
   Place a Firebase service account file at `backend/key.json` and keep it out of git.

2. `.env` file
   Put secrets in `backend/.env` using `backend/.env.example` as a template.

### Required Firebase Settings

Option A: service account file
- `FIREBASE_SERVICE_ACCOUNT_PATH=./key.json`

Option B: inline service account values
- `FIREBASE_PROJECT_ID`
- `FIREBASE_CLIENT_EMAIL`
- `FIREBASE_PRIVATE_KEY`

### Common App Settings

- `DATABASE_URL`
- `PORT`
- `NODE_ENV`
- `PLUGIN_API_KEY`
- `JWT_SECRET`
- `JWT_EXPIRES_IN`
- `ADMIN_BYPASS_EMAIL`

## PM2 Deployment

```bash
pm2 start ecosystem.config.js --env production
pm2 save
pm2 startup
```

For Ubuntu, keep secrets out of `ecosystem.config.js`. Use one of these:

- Put a real `backend/key.json` on the server and point `FIREBASE_SERVICE_ACCOUNT_PATH` at it.
- Put secrets in `backend/.env` and let the backend load them on startup.
- Use both: keep Firebase in `key.json`, keep app secrets like `PLUGIN_API_KEY` and `JWT_SECRET` in `.env`.

## Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with nodemon
- `npm run health-check` - Run health check
- `npm run seed` - Seed database with example data
- `npm run cleanup` - Clean up old matches
- `npm run backup` - Backup database
- `npm run restore` - Restore database

## Troubleshooting

- Missing Firebase credentials: set `FIREBASE_SERVICE_ACCOUNT_PATH`, provide `backend/key.json`, or configure the inline Firebase env vars
- Database connection error: verify `DATABASE_URL` or `databaseURL`
- Port already in use: change `PORT`

## Security

- Never commit `key.json` or `.env`
- Rotate any service account or API key that was previously committed
- Use strong random values for `PLUGIN_API_KEY` and `JWT_SECRET`
- Set `NODE_ENV=production` in production

## License

MIT
