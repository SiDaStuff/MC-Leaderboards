const {
  AUTH_SESSION_DURATION_MS,
  normalizeEmailAddress,
  ensureUserProfileExists,
  assertRegistrationAllowed,
  setAuthSessionCookie,
  clearAuthSessionCookie
} = require('../services/auth-service');

function registerAuthRoutes({
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
}) {
  const applySessionCookie = (res, sessionCookie) => setAuthSessionCookie(res, sessionCookie, { nodeEnv: config.nodeEnv });
  const removeSessionCookie = (res) => clearAuthSessionCookie(res, { nodeEnv: config.nodeEnv });

  app.post('/api/auth/session', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        removeSessionCookie(res);
        return res.status(401).json({
          error: true,
          code: 'AUTH_REQUIRED',
          message: 'Authentication required'
        });
      }

      const idToken = authHeader.split('Bearer ')[1];
      await admin.auth().verifyIdToken(idToken);
      const sessionCookie = await admin.auth().createSessionCookie(idToken, {
        expiresIn: AUTH_SESSION_DURATION_MS
      });

      applySessionCookie(res, sessionCookie);
      return res.json({
        success: true,
        expiresIn: AUTH_SESSION_DURATION_MS
      });
    } catch (error) {
      removeSessionCookie(res);
      logger.warn('Failed to create auth session cookie', { error });
      return res.status(401).json({
        error: true,
        code: 'AUTH_INVALID',
        message: 'Invalid or expired token'
      });
    }
  });

  app.delete('/api/auth/session', (req, res) => {
    removeSessionCookie(res);
    res.json({ success: true });
  });

  app.post('/api/auth/register-preflight', requireRecaptcha, async (req, res) => {
    try {
      const { clientIP, age, firebaseUid = null } = req.body || {};
      const realClientIP = clientIP || getClientIP(req);

      await assertRegistrationAllowed(db, {
        firebaseUid,
        clientIP: realClientIP,
        age
      });

      return res.json({
        success: true,
        message: 'Registration allowed'
      });
    } catch (error) {
      return res.status(error.status || 500).json({
        error: true,
        code: error.code || 'SERVER_ERROR',
        message: error.message || 'Unable to validate registration right now'
      });
    }
  });

  app.post('/api/auth/register', requireRecaptcha, async (req, res) => {
    try {
      const { email, firebaseUid, minecraftUsername, clientIP, age } = req.body;
      const realClientIP = clientIP || getClientIP(req);

      if (!email || !firebaseUid) {
        return res.status(400).json({
          error: true,
          code: 'MISSING_DATA',
          message: 'Email and Firebase UID are required'
        });
      }

      await assertRegistrationAllowed(db, {
        firebaseUid,
        clientIP: realClientIP,
        age
      });

      const altDetection = await detectAltAccount(email, realClientIP, minecraftUsername);
      if (altDetection.isAlt) {
        const reportResult = await createConsolidatedAltReport(
          firebaseUid,
          altDetection.suspiciousAccounts,
          realClientIP,
          altDetection.reason,
          'registration'
        );

        if (reportResult) {
          console.log('Suspicious registration detected:', altDetection.reason, '(Group flagged', reportResult.flagCount, 'times)');
        }
      }

      const userRef = db.ref(`users/${firebaseUid}`);
      const existingSnapshot = await userRef.once('value');
      const existingProfile = existingSnapshot.val();
      if (existingProfile) {
        if (existingProfile.email && existingProfile.email !== email) {
          return res.status(409).json({
            error: true,
            code: 'EMAIL_MISMATCH',
            message: 'This account is already registered with a different email address'
          });
        }

        const currentIPs = Array.isArray(existingProfile.ipAddresses) ? existingProfile.ipAddresses : [];
        if (realClientIP && !currentIPs.includes(realClientIP)) {
          currentIPs.push(realClientIP);
          if (currentIPs.length > 10) currentIPs.shift();
        }

        await userRef.update({
          email: existingProfile.email || email,
          firebaseUid,
          ipAddresses: currentIPs,
          lastLoginAt: new Date().toISOString(),
          lastLoginIP: realClientIP,
          updatedAt: new Date().toISOString()
        });

        if (req.headers.authorization?.startsWith('Bearer ')) {
          const sessionCookie = await admin.auth().createSessionCookie(req.headers.authorization.split('Bearer ')[1], {
            expiresIn: AUTH_SESSION_DURATION_MS
          });
          applySessionCookie(res, sessionCookie);
        }

        return res.json({
          success: true,
          message: 'User already registered',
          user: {
            uid: firebaseUid,
            email: existingProfile.email || email,
            minecraftUsername: existingProfile.minecraftUsername || null
          }
        });
      }

      const userProfile = {
        email,
        firebaseUid,
        ipAddresses: [realClientIP],
        securitySettings: {
          requireVerifiedEmailForSensitiveActions: false,
          requireVerifiedEmailForLogin: false
        },
        createdAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        lastLoginIP: realClientIP
      };

      if (minecraftUsername) {
        try {
          const hasProfanity = await containsProfanity(minecraftUsername);
          if (hasProfanity) {
            return res.status(400).json({
              error: true,
              code: 'PROFANITY_DETECTED',
              message: 'Username contains inappropriate language and cannot be used'
            });
          }
        } catch (error) {
          return res.status(503).json({
            error: true,
            code: 'FILTER_UNAVAILABLE',
            message: error.message || 'Content filtering is temporarily unavailable. Please try again later.'
          });
        }

        const normalizedMinecraftUsername = minecraftUsername.trim().toLowerCase();
        const usernameBlocked = await isUsernameBlacklisted(normalizedMinecraftUsername);
        if (usernameBlocked) {
          return res.status(403).json({
            error: true,
            code: 'USERNAME_BLACKLISTED',
            message: 'This Minecraft username is blacklisted and cannot be linked to an account.'
          });
        }
        userProfile.minecraftUsername = minecraftUsername;
      }

      await userRef.set(userProfile);
      if (req.headers.authorization?.startsWith('Bearer ')) {
        const sessionCookie = await admin.auth().createSessionCookie(req.headers.authorization.split('Bearer ')[1], {
          expiresIn: AUTH_SESSION_DURATION_MS
        });
        applySessionCookie(res, sessionCookie);
      }

      return res.json({
        success: true,
        message: 'User registered successfully',
        user: {
          uid: firebaseUid,
          email,
          minecraftUsername
        }
      });
    } catch (error) {
      console.error('Error registering user:', error);
      return res.status(500).json({
        error: true,
        code: 'SERVER_ERROR',
        message: 'Error registering user'
      });
    }
  });

  app.post('/api/auth/login', requireRecaptcha, verifyAuth, checkBanned, async (req, res) => {
    try {
      const { clientIP } = req.body || {};
      const realClientIP = clientIP || getClientIP(req);
      const userRef = db.ref(`users/${req.user.uid}`);

      const userProfile = await ensureUserProfileExists(db, req.user, {
        clientIP: realClientIP,
        existingProfile: req.userProfile || null
      });

      if (req.user?.emailVerified !== true && !hasAdminAccess(userProfile, req.user?.email || userProfile.email || '')) {
        return res.status(403).json({
          error: true,
          code: 'EMAIL_VERIFICATION_REQUIRED_FOR_LOGIN',
          message: 'Verify your email address before signing in.',
          suggestion: 'Open the verification email we sent you, then try signing in again. You can resend the verification email from the login page.'
        });
      }

      void triggerMinecraftUuidLinkForUser(req.user.uid, userProfile);

      const currentIPs = Array.isArray(userProfile.ipAddresses) ? userProfile.ipAddresses : [];
      if (!currentIPs.includes(realClientIP)) {
        currentIPs.push(realClientIP);
        if (currentIPs.length > 10) {
          currentIPs.shift();
        }
      }

      await userRef.update({
        ipAddresses: currentIPs,
        lastLoginAt: new Date().toISOString(),
        lastLoginIP: realClientIP
      });

      if (req.headers.authorization?.startsWith('Bearer ')) {
        const sessionCookie = await admin.auth().createSessionCookie(req.headers.authorization.split('Bearer ')[1], {
          expiresIn: AUTH_SESSION_DURATION_MS
        });
        applySessionCookie(res, sessionCookie);
      }

      const accountSummary = {
        uid: req.user.uid,
        email: userProfile.email || req.user.email || null,
        emailVerified: req.user?.emailVerified === true,
        onboardingCompleted: userProfile.onboardingCompleted === true,
        minecraftUsername: userProfile.minecraftUsername || null,
        minecraftVerified: userProfile.minecraftVerified === true,
        tester: userProfile.tester === true,
        admin: hasAdminAccess(userProfile, req.user?.email || userProfile.email || '')
      };

      res.json({
        success: true,
        message: 'Login tracked successfully',
        redirectTo: accountSummary.onboardingCompleted ? 'dashboard.html' : 'onboarding.html',
        account: accountSummary
      });

      void (async () => {
        try {
          const altDetection = await detectAltAccount(req.user.email, realClientIP, userProfile.minecraftUsername);
          if (altDetection.isAlt) {
            const reportResult = await createConsolidatedAltReport(
              req.user.uid,
              altDetection.suspiciousAccounts,
              realClientIP,
              altDetection.reason,
              'login'
            );

            if (reportResult) {
              console.log(`Suspicious login detected: ${altDetection.reason} (Group flagged ${reportResult.flagCount} times)`);
            }
          }

          const anomalyCheck = await detectAccountAnomalies(req.user.uid);
          if (anomalyCheck.suspicious && anomalyCheck.severity === 'high') {
            console.warn(`[SECURITY] Account anomalies detected on login for user ${req.user.uid}:`, anomalyCheck.anomalies);
          }

          const flagCheck = await checkAndFlagSuspiciousAccount(req.user.uid);
          if (flagCheck.flagged) {
            const reason = flagCheck.reason || 'already flagged for review';
            console.warn(`[SECURITY] Account ${req.user.uid} flagged for review:`, reason);
          }
        } catch (securityError) {
          console.warn('Deferred login security checks failed:', req.user.uid, securityError?.message || securityError);
        }
      })();
    } catch (error) {
      console.error('Error tracking login:', error);
      return res.status(500).json({
        error: true,
        code: 'SERVER_ERROR',
        message: 'Error tracking login'
      });
    }
  });
}

module.exports = {
  registerAuthRoutes
};
