        // Helper function to format date difference
        function formatDateDifference(dateString) {
            const date = new Date(dateString);
            const now = new Date();
            const diffMs = now - date;
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffMonths = Math.floor(diffDays / 30);
            const diffYears = Math.floor(diffMonths / 12);

            if (diffYears > 0) {
                return diffYears === 1 ? "1 year ago" : `${diffYears} years ago`;
            } else if (diffMonths > 0) {
                return diffMonths === 1 ? "1 month ago" : `${diffMonths} months ago`;
            } else if (diffDays > 0) {
                return diffDays === 1 ? "1 day ago" : `${diffDays} days ago`;
            } else {
                return "Today";
            }
        }

        // Helper function to calculate days/months as tier tester
        function calculateTesterTenure(approvedAtDate) {
            const approvedAt = new Date(approvedAtDate);
            const now = new Date();
            const diffMs = now - approvedAt;
            const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
            const diffMonths = Math.floor(diffDays / 30);
            const residualDays = diffDays % 30;

            if (diffMonths === 0) {
                return `${diffDays} day${diffDays !== 1 ? 's' : ''}`;
            } else {
                return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} and ${residualDays} day${residualDays !== 1 ? 's' : ''}`;
            }
        }

        // Plus expiry helper
        function getPlusExpiryStatus(expiresAtDate) {
            const expiresAt = new Date(expiresAtDate);
            const now = new Date();
            const diffMs = expiresAt - now;
            const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

            return {
                daysRemaining: diffDays,
                isExpired: diffDays <= 0,
                isCritical: diffDays <= 7 && diffDays > 0,
                formattedDate: expiresAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
            };
        }

        function getAccountStaffCapabilities(profile = AppState.getProfile() || {}) {
            const capabilitySet = new Set();
            const capabilitySources = [
                Array.isArray(profile?.adminContext?.capabilities) ? profile.adminContext.capabilities : [],
                Array.isArray(profile?.staffRole?.capabilities) ? profile.staffRole.capabilities : [],
                Array.isArray(profile?.verifiedStaffRole?.capabilities) ? profile.verifiedStaffRole.capabilities : []
            ];

            capabilitySources.forEach((list) => {
                list.forEach((capability) => capabilitySet.add(capability));
            });

            return capabilitySet;
        }

        function openAccountRoleToolDestination(url) {
            if (!url) return;
            window.location.href = url;
        }

        function buildAccountRoleToolButtonHtml(toolType, label, iconClass, accentClass) {
            return `
                <button class="account-role-action-btn ${accentClass}" type="button" onclick="openAccountRoleToolsLauncher()">
                    <i class="fas ${escapeHtml(iconClass)}"></i>
                    <span>${escapeHtml(label)}</span>
                </button>
            `;
        }

        function renderAccountRoleActions(profile = AppState.getProfile() || {}) {
            const container = document.getElementById('accountRoleActions');
            if (!container) return;

            const capabilities = getAccountStaffCapabilities(profile);
            const buttons = [];

            if (capabilities.has('moderation:chat_reports:view') || capabilities.has('moderation:chat:block')) {
                buttons.push(buildAccountRoleToolButtonHtml('moderator', 'Moderator', 'fa-shield-alt', 'is-moderator'));
            }

            if (capabilities.has('leaderboard:filters:manage')) {
                buttons.push(buildAccountRoleToolButtonHtml('leaderboard', 'Leaderboard', 'fa-filter', 'is-leaderboard'));
            }

            container.innerHTML = buttons.join('');
            container.style.display = buttons.length ? 'flex' : 'none';
        }

        function buildAccountRoleLauncherHtml(title, description, actions = [], capabilities = []) {
            const capabilityItems = capabilities.length
                ? `<div style="display:grid; gap:0.45rem; margin-top:1rem;">
                        ${capabilities.map((capability) => `
                            <div style="padding:0.7rem 0.85rem; border-radius:12px; background:rgba(255,255,255,0.03); color:#d6dfda; text-align:left;">
                                <i class="fas fa-check-circle" style="margin-right:0.45rem;"></i>${escapeHtml(capability)}
                            </div>
                        `).join('')}
                   </div>`
                : '';
            const actionButtons = actions.length
                ? `<div style="display:grid; gap:0.75rem; margin-top:1rem;">
                        ${actions.map((action) => `
                            <button class="btn btn-secondary" type="button" data-role-tool-action="${escapeHtml(action.id)}" style="width:100%; justify-content:flex-start;">
                                <i class="fas ${escapeHtml(action.icon)}"></i> ${escapeHtml(action.label)}
                            </button>
                        `).join('')}
                   </div>`
                : '<div class="text-muted" style="margin-top:1rem;">No role tools are available on this account right now.</div>';

            return `
                <div style="text-align:left;">
                    <p style="margin:0; color:#dbe4f0; line-height:1.65;">${escapeHtml(description)}</p>
                    ${capabilityItems}
                    ${actionButtons}
                </div>
            `;
        }

        window.openAccountRoleToolsLauncher = function() {
            openAccountRoleToolDestination('moderation.html');
        };

        async function initAccount() {
            if (!AppState.isAuthenticated()) {
                return;
            }

            if (window.mclbLoadingOverlay) {
                window.mclbLoadingOverlay.updateStatus('Loading account data...', 85);
            }

            await firebaseAuthService.reloadCurrentUser({
                forceTokenRefresh: false,
                syncSession: false
            }).catch(() => null);
            await loadProfile();
            updateConnectedAccountsUI();

            const reloadAccountBtn = document.getElementById('reloadAccountBtn');
            if (reloadAccountBtn) {
                reloadAccountBtn.addEventListener('click', openReloadAccountModal);
            }
        }

        async function loadProfile() {
            try {
                const standingPromise = (typeof apiService.getMyStanding === 'function')
                    ? apiService.getMyStanding().catch(() => null)
                    : (typeof apiService.get === 'function'
                        ? apiService.get('/users/me/standing').catch(() => null)
                        : Promise.resolve(null));

                const [profileResponse, standingResponse] = await Promise.all([
                    apiService.getProfile(),
                    standingPromise
                ]);
                const profile = profileResponse || {};
                profile.standing = standingResponse?.standing || null;
                AppState.setProfile(profile);
                
                // Update account overview
                const initials = (profile.email || '?')[0].toUpperCase();
                document.getElementById('accountInitials').textContent = initials;
                document.getElementById('accountUsername').textContent = profile.minecraftUsername || profile.email;
                document.getElementById('accountEmail').textContent = profile.email;

                // Update status badges
                const badgesContainer = document.getElementById('accountStatusBadges');
                const badges = [];
                if (typeof renderRoleBadges === 'function') {
                    const roleBadgesHtml = renderRoleBadges(profile);
                    if (roleBadgesHtml) {
                        badges.push(roleBadgesHtml);
                    }
                }
                if (profile.minecraftUsername && typeof buildStaticRoleBadge === 'function') {
                    badges.push(buildStaticRoleBadge('Minecraft Linked', 'staff', '<i class="fas fa-gamepad"></i>'));
                }
                if (profile.emailVerified && typeof buildStaticRoleBadge === 'function') {
                    badges.push(buildStaticRoleBadge('Email Verified', 'support', '<i class="fas fa-envelope"></i>'));
                }
                badgesContainer.innerHTML = badges.length ? badges.join('') : '<span class="badge badge-secondary">Regular User</span>';
                renderAccountRoleActions(profile);

                applyBlacklistedRestrictions(profile);
                renderStandingSection(profile);
                updateConnectedAccountsUI();

                // Update Tier Tester section (always shown)
                const testerContent = document.getElementById('testerContent');
                if (profile.tester && profile.testerApprovedAt) {
                    // User is an approved tier tester
                    document.getElementById('testerSubtitle').textContent = 'You are an active tier tester';
                    testerContent.innerHTML = `
                        <div class="tier-tester-content">
                            <div class="tier-tester-row">
                                <span class="tier-tester-label">Status:</span>
                                <span class="tier-tester-value">Active - Approved</span>
                            </div>
                            <div class="tier-tester-row">
                                <span class="tier-tester-label">Tenure:</span>
                                <span class="tier-tester-value">${calculateTesterTenure(profile.testerApprovedAt)}</span>
                            </div>
                            <div class="tier-tester-row">
                                <span class="tier-tester-label">Approved:</span>
                                <span class="tier-tester-value">${new Date(profile.testerApprovedAt).toLocaleDateString()}</span>
                            </div>
                        </div>
                        <div class="card-actions">
                            <a href="dashboard.html" class="btn btn-primary account-card-action">
                                <i class="fas fa-user-shield"></i> Go to Tester Dashboard
                            </a>
                        </div>
                    `;
                } else if (profile.pendingTesterApplication === true) {
                    // Application is pending
                    document.getElementById('testerSubtitle').textContent = 'Application pending review';
                    const lastApplicationDate = profile.lastApplicationSubmitted ? new Date(profile.lastApplicationSubmitted).toLocaleDateString() : '-';
                    testerContent.innerHTML = `
                        <div class="card-alert info account-card-alert-spaced">
                            <i class="fas fa-clock"></i>
                            <div>
                                <strong>Application Under Review</strong><br>
                                <span class="account-inline-note">Your tier tester application is being reviewed by admins. This typically takes 3-7 days.</span>
                            </div>
                        </div>
                        <div class="tier-tester-content">
                            <div class="tier-tester-row">
                                <span class="tier-tester-label">Submitted:</span>
                                <span class="tier-tester-value">${lastApplicationDate}</span>
                            </div>
                        </div>
                    `;
                } else if (profile.testerApplicationDenied === true) {
                    // Application was denied
                    document.getElementById('testerSubtitle').textContent = 'Application denied';
                    testerContent.innerHTML = `
                        <div class="card-alert warning account-card-alert-spaced">
                            <i class="fas fa-info-circle"></i>
                            <div>
                                <strong>Application Status: Denied</strong><br>
                                <span class="account-inline-note">${profile.testerDenialReason || 'Your application did not meet the requirements at this time.'}</span>
                            </div>
                        </div>
                        <div class="card-actions">
                            <a href="tier-tester-application.html" class="btn btn-primary account-card-action">
                                <i class="fas fa-reload"></i> Apply Again
                            </a>
                        </div>
                    `;
                } else {
                    // Not a tier tester and no application
                    document.getElementById('testerSubtitle').textContent = 'Help evaluate players';
                    testerContent.innerHTML = profile.blacklisted ? `
                        <div class="card-alert warning account-card-alert-spaced">
                            <i class="fas fa-ban"></i>
                            <div>
                                <strong>Applications Disabled</strong><br>
                                <span class="account-inline-note">Blacklisted accounts cannot submit tier tester applications.</span>
                            </div>
                        </div>
                    ` : `
                        <div class="card-alert info account-card-alert-spaced">
                            <i class="fas fa-graduation-cap"></i>
                            <div>
                                <strong>Become a Tier Tester</strong><br>
                                <span class="account-inline-note">Join our team of testers and help evaluate player skills. Earn exclusive perks and recognition!</span>
                            </div>
                        </div>
                        <div class="card-actions">
                            <a href="tier-tester-application.html" class="btn btn-success account-card-action">
                                <i class="fas fa-clipboard-check"></i> Apply Now
                            </a>
                        </div>
                    `;
                }

                // Update Plus section
                const plus = profile.plus || {};
                const plusContent = document.getElementById('plusContent');
                if (plus.active && plus.expiresAt) {
                    // User has Plus
                    const expiryStatus = getPlusExpiryStatus(plus.expiresAt);
                    document.getElementById('plusStatusSubtitle').textContent = 'Premium features active';
                    
                    let expiryHTML = `
                        <div class="account-plus-summary">
                            <span class="plus-badge">ACTIVE</span>
                            <p class="expiry-display">
                                Expires on <strong class="${expiryStatus.isCritical ? 'expiry-critical' : ''}">${expiryStatus.formattedDate}</strong>
                                <br>
                                <span class="${expiryStatus.isCritical ? 'expiry-critical' : ''}">${expiryStatus.daysRemaining} days remaining</span>
                            </p>
                        </div>
                    `;
                    
                    if (expiryStatus.isCritical) {
                        expiryHTML += `<div class="card-alert warning account-card-alert-spaced"><i class="fas fa-exclamation-triangle"></i> Your Plus membership expires soon! <a href="plus.html" class="account-link-underline">Renew now</a></div>`;
                    }
                    
                    expiryHTML += `
                        <div id="plusSettingsContent">
                            <div class="card-form-group">
                                <label class="card-form-label account-inline-label">
                                    <input type="checkbox" id="showPlusBadgeCheckbox">
                                    <span>Show Plus badge on leaderboards</span>
                                </label>
                            </div>
                            <div class="card-form-group">
                                <label class="card-form-label">Username Gradient</label>
                                <button class="btn btn-secondary btn-block" type="button" onclick="openPlusGradientEditor()">
                                    <i class="fas fa-palette"></i> Edit Gradient
                                </button>
                                <div id="plusGradientPreview" class="plus-gradient-preview-name account-gradient-preview">PreviewName</div>
                            </div>
                            <button class="btn btn-primary btn-block account-button-spaced" type="button" onclick="savePlusSettings()">
                                <i class="fas fa-save"></i> Save Plus Settings
                            </button>
                        </div>
                        <div class="card-actions">
                            <a href="dashboard.html" class="btn btn-primary account-card-action">
                                <i class="fas fa-star"></i> Enjoy Plus Features
                            </a>
                            <a href="plus.html" class="btn btn-secondary account-card-action">
                                <i class="fas fa-info-circle"></i> More Info
                            </a>
                        </div>
                    `;
                    
                    plusContent.innerHTML = expiryHTML;
                } else if (plus.blocked) {
                    // Plus is blocked
                    document.getElementById('plusStatusSubtitle').textContent = 'Blocked';
                    plusContent.innerHTML = '<div class="card-alert info"><i class="fas fa-shield-alt"></i> Plus is blocked for your account. Please contact support for more information.</div>';
                } else {
                    // No Plus membership
                    document.getElementById('plusStatusSubtitle').textContent = 'Not a member yet';
                    plusContent.innerHTML = `
                        <div class="card-alert info account-card-alert-spaced">
                            <i class="fas fa-crown"></i>
                            <div>
                                <strong>Upgrade to Plus</strong><br>
                                <span class="account-inline-note">Get priority queue, custom badges, and exclusive features. Support the platform you love!</span>
                            </div>
                        </div>
                        <div class="card-actions">
                            <a href="plus.html" class="btn btn-primary account-card-action">
                                <i class="fas fa-star"></i> View Plus Features
                            </a>
                        </div>
                    `;
                }

                // Update form fields
                document.getElementById('accountRegion').value = profile.region || '';

                // Update Minecraft section
                await renderMinecraftSection(profile);

                // Populate skill levels
                populateSkillLevels(profile);

                // Populate retirement status
                populateRetirementStatus(profile);

                // Update connected accounts
                updateConnectedAccountsUI();

                // Show admin tools if applicable
                if (profile.admin || profile.tester) {
                    document.getElementById('adminToolsCard').style.display = 'block';
                }

                // Render Plus settings if active
                if (plus.active) {
                    renderPlusSettings(profile);
                }

                // Re-apply restrictions after dynamic sections/buttons are rendered.
                applyBlacklistedRestrictions(profile);

                if (window.mclbLoadingOverlay) {
                    window.mclbLoadingOverlay.updateStatus('Account ready!', 100);
                }

                await loadMyReports();
            } catch (error) {
                console.error('Error loading profile:', error);
            }
        }

        function getStandingLevel(score, blacklisted) {
            if (blacklisted || score >= 80) return { id: 'suspended', label: 'Suspended' };
            if (score >= 50) return { id: 'at-risk', label: 'At Risk' };
            if (score >= 30) return { id: 'very-limited', label: 'Very Limited' };
            if (score >= 10) return { id: 'limited', label: 'Limited' };
            return { id: 'all-good', label: 'All good!' };
        }

        function renderStandingSection(profile) {
            const standing = profile?.standing || {};
            const warnings = Array.isArray(standing.warnings) ? standing.warnings : (Array.isArray(profile?.warnings) ? profile.warnings : []);
            const restrictionsObj = standing.restrictions || profile?.moderation?.restrictions || {};
            const activeRestrictions = Object.entries(restrictionsObj).filter(([, config]) => config && config.active);
            const blacklisted = profile?.blacklisted === true;

            const warningScore = Math.min(warnings.length * 15, 60);
            const restrictionScore = Math.min(activeRestrictions.length * 12, 36);
            const blacklistScore = blacklisted ? 100 : 0;
            const score = Math.min(100, warningScore + restrictionScore + blacklistScore);

            const level = getStandingLevel(score, blacklisted);
            const labelEl = document.getElementById('standingLabel');
            const scoreEl = document.getElementById('standingScore');
            const fillEl = document.getElementById('standingFill');
            const levelsEl = document.getElementById('standingLevels');
            const historyEl = document.getElementById('standingHistoryList');
            if (!labelEl || !scoreEl || !fillEl || !levelsEl || !historyEl) return;

            labelEl.textContent = level.label;
            scoreEl.textContent = `${score}%`;
            fillEl.style.width = `${score}%`;

            levelsEl.querySelectorAll('span').forEach((span) => {
                span.classList.toggle('active', span.dataset.level === level.id);
            });

            const blacklistItem = blacklisted
                ? [{ text: `Blacklisted: ${profile?.moderation?.blacklistEntry?.reason || 'Restricted account'}`, when: profile?.moderation?.blacklistEntry?.addedAt || null }]
                : [];

            const warningItems = warnings.slice(0, 4).map(w => ({
                text: `Warning: ${w.reason || 'No reason provided'}`,
                when: w.warnedAt || null
            }));

            const restrictionItems = activeRestrictions.slice(0, 4).map(([key, value]) => ({
                text: `Function limited: ${key.replace(/_/g, ' ')} (${value.reason || 'Admin restriction'})`,
                when: value.setAt || value.expiresAt || null
            }));

            const historyItems = [...blacklistItem, ...warningItems, ...restrictionItems].slice(0, 8);
            if (historyItems.length === 0) {
                historyEl.innerHTML = '<div class="standing-history-item">No moderation history found.</div>';
                return;
            }

            historyEl.innerHTML = historyItems.map(item => {
                const whenText = item.when ? new Date(item.when).toLocaleString() : 'No timestamp';
                return `<div class="standing-history-item">${escapeHtml(item.text)}<br><small>${escapeHtml(whenText)}</small></div>`;
            }).join('');
        }

        function getReportTypeLabel(report) {
            if (report.reportType === 'message') return 'Chat Report';
            if (String(report.category || '').toLowerCase() === 'no_show') return 'No-show Report';
            return 'Player Report';
        }

        function getReportTargetLabel(report) {
            if (report.reportType === 'message') {
                return report.messageReport?.reportedMessage?.username || report.reportedPlayer || 'Unknown';
            }
            return report.reportedPlayer || 'Unknown';
        }

        function getReportStatusBadge(statusRaw) {
            const status = String(statusRaw || 'pending').toLowerCase();
            if (status === 'resolved') {
                return '<span class="status-badge badge-active">Resolved</span>';
            }
            if (status === 'rejected') {
                return '<span class="status-badge badge-critical">Rejected</span>';
            }
            return '<span class="status-badge badge-warning">Pending</span>';
        }

        function renderReportItem(report) {
            const typeLabel = getReportTypeLabel(report);
            const target = escapeHtml(getReportTargetLabel(report));
            const statusBadge = getReportStatusBadge(report.status);
            const createdAt = report.createdAt ? new Date(report.createdAt).toLocaleString() : 'Unknown date';
            const matchId = report.matchId ? escapeHtml(report.matchId) : 'N/A';
            const description = escapeHtml(String(report.description || '').slice(0, 220));

            let extra = '';
            if (report.reportType === 'message') {
                const msg = escapeHtml(report.messageReport?.reportedMessage?.text || '');
                extra = `<div class="report-item-meta"><strong>Reported Message:</strong> ${msg || 'N/A'}</div>`;
            }

            let resolution = '';
            const isResolved = String(report.status || '').toLowerCase() === 'resolved';
            if (isResolved) {
                const reviewedAt = report.resolution?.reviewedAt || report.reviewedAt || report.resolvedAt;
                const reviewNotes = escapeHtml(report.resolution?.reviewNotes || report.reviewNotes || 'No notes provided');
                const actionTaken = escapeHtml(report.resolution?.actionTaken || report.actionTaken || 'No action recorded');
                resolution = `
                    <div class="report-resolution">
                        <div><strong>Resolved:</strong> ${reviewedAt ? new Date(reviewedAt).toLocaleString() : 'Unknown'}</div>
                        <div><strong>Action:</strong> ${actionTaken}</div>
                        <div><strong>Notes:</strong> ${reviewNotes}</div>
                    </div>
                `;
            }

            return `
                <div class="report-item">
                    <div class="report-item-top">
                        <div class="report-item-title">${typeLabel} on ${target}</div>
                        <div>${statusBadge}</div>
                    </div>
                    <div class="report-item-meta"><strong>Submitted:</strong> ${createdAt}</div>
                    <div class="report-item-meta"><strong>Match ID:</strong> ${matchId}</div>
                    <div class="report-item-meta"><strong>Description:</strong> ${description || 'No description'}</div>
                    ${extra}
                    ${resolution}
                </div>
            `;
        }

        async function loadMyReports() {
            const summaryEl = document.getElementById('myReportsSummary');
            const lastFiveEl = document.getElementById('myReportsLastFive');
            const allEl = document.getElementById('myReportsAll');
            if (!summaryEl || !lastFiveEl || !allEl) return;

            try {
                const response = await apiService.getMyPlayerReports(500, { includeConversation: false });
                const reports = Array.isArray(response?.reports) ? response.reports : [];
                const lastFive = reports.slice(0, 5);
                const resolvedCount = reports.filter(r => String(r?.status || '').toLowerCase() === 'resolved').length;
                const pendingCount = reports.filter(r => String(r?.status || 'pending').toLowerCase() !== 'resolved').length;

                summaryEl.innerHTML = `
                    <div class="report-summary-pill"><div class="k">Total</div><div class="v">${reports.length}</div></div>
                    <div class="report-summary-pill"><div class="k">Pending</div><div class="v">${pendingCount}</div></div>
                    <div class="report-summary-pill"><div class="k">Resolved</div><div class="v">${resolvedCount}</div></div>
                `;

                if (lastFive.length === 0) {
                    lastFiveEl.innerHTML = '<div class="report-item-meta">No reports submitted yet.</div>';
                } else {
                    lastFiveEl.innerHTML = lastFive.map(renderReportItem).join('');
                }

                if (reports.length === 0) {
                    allEl.innerHTML = '<div class="report-item-meta">No reports to show.</div>';
                } else {
                    allEl.innerHTML = reports.map(renderReportItem).join('');
                }
            } catch (error) {
                console.error('Error loading report history:', error);
                lastFiveEl.innerHTML = `<div class="report-item-meta">Failed to load reports: ${escapeHtml(error.message || 'Unknown error')}</div>`;
                allEl.innerHTML = '';
            }
        }

        async function renderMinecraftSection(profile) {
            const section = document.getElementById('minecraftSection');
            if (profile.minecraftUsername) {
                section.innerHTML = `
                    <div class="account-linked-summary">
                        <p class="account-linked-label">Linked Account</p>
                        <p class="account-linked-value">${escapeHtml(profile.minecraftUsername)}</p>
                    </div>
                    <div class="card-alert info">
                        <i class="fas fa-lock"></i>
                        <span>Your username is locked once linked to prevent impersonation</span>
                    </div>
                `;
                document.getElementById('minecraftStatusSubtitle').textContent = 'Account linked and verified';
            } else {
                section.innerHTML = `
                    <div class="card-form-group">
                        <label class="card-form-label">Minecraft Username</label>
                        <input type="text" class="form-input" id="minecraftUsername" placeholder="Enter your Minecraft username">
                        <p class="form-help-text">Your in-game username (3-16 characters)</p>
                    </div>
                    <button class="btn btn-primary btn-block" onclick="handleLinkMinecraft()">
                        <i class="fas fa-link"></i> Link Username
                    </button>
                `;
                document.getElementById('minecraftStatusSubtitle').textContent = 'Not yet linked';
            }
        }

        function isBlacklistedAccount() {
            return AppState.getProfile()?.blacklisted === true;
        }

        function isAccountChangesRestricted() {
            const profile = AppState.getProfile() || {};
            return profile?.moderation?.restrictions?.account_changes?.active === true;
        }

        function applyBlacklistedRestrictions(profile) {
            const isBlacklisted = profile?.blacklisted === true;
            const accountRestricted = isBlacklisted || profile?.moderation?.restrictions?.account_changes?.active === true;

            let banner = document.getElementById('blacklistRestrictionBanner');
            if (accountRestricted && !banner) {
                banner = document.createElement('div');
                banner.id = 'blacklistRestrictionBanner';
                banner.className = 'card-alert warning';
                banner.style.marginBottom = '1rem';
                banner.innerHTML = '<i class="fas fa-ban"></i><span><strong>Restricted Account:</strong> Account changes are currently disabled. This can be caused by blacklist status or temporary admin restrictions.</span>';
                const main = document.querySelector('main.container');
                const header = document.querySelector('.page-header');
                if (main && header) {
                    main.insertBefore(banner, header.nextSibling);
                }
            } else if (!accountRestricted && banner) {
                banner.remove();
            }

            const restrictedSelectors = [
                '#linkGoogleBtn',
                '#saveSkillLevelsBtn',
                '#saveRetirementBtn',
                '#savePlusSettingsBtn',
                'button[onclick="handlePasswordReset()"]',
                'button[onclick="handleUpdateRegion()"]',
                'button[onclick="handleLinkMinecraft()"]',
                'button[onclick="savePlusSettings()"]'
            ];
            restrictedSelectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                    el.disabled = accountRestricted;
                    if (accountRestricted) {
                        el.title = 'Disabled by moderation restrictions';
                    } else {
                        el.removeAttribute('title');
                    }
                });
            });
        }

        function populateSkillLevels(profile) {
            const container = document.getElementById('skillLevelsContainer');
            const skillTitle = document.getElementById('skillConfigurationTitle');
            const skillCard = document.getElementById('skillLevelsCard');
            const saveBtn = document.getElementById('saveSkillLevelsBtn');
            container.innerHTML = '';

            const unsetGamemodes = CONFIG.GAMEMODES.filter(gamemode => {
                if (gamemode.id === 'overall') return false;
                const currentRating = profile.gamemodeRatings?.[gamemode.id];
                const isSet = Number.isFinite(currentRating) && currentRating > 0;
                return !isSet;
            });

            if (unsetGamemodes.length === 0) {
                if (skillTitle) skillTitle.style.display = 'none';
                if (skillCard) skillCard.style.display = 'none';
                return;
            }

            if (skillTitle) skillTitle.style.display = '';
            if (skillCard) skillCard.style.display = '';
            if (saveBtn) saveBtn.style.display = '';

            const wrapper = document.createElement('div');
            wrapper.className = 'mclb-config-grid';

            unsetGamemodes.forEach(gamemode => {
                const card = document.createElement('div');
                card.className = 'mclb-config-item skill-level-card';
                
                let optionsHTML = '';
                [
                    { label: 'Beginner', elo: 300 },
                    { label: 'Novice', elo: 500 },
                    { label: 'Intermediate', elo: 1000 },
                    { label: 'Advanced', elo: 1300 }
                ].forEach(option => {
                    optionsHTML += `
                        <button type="button" class="skill-option mclb-choice"
                                data-gamemode="${gamemode.id}" data-rating="${option.elo}" 
                                title="${option.label} - ${option.elo} Elo">
                            <span class="mclb-choice-label">${option.label}</span>
                            <span class="mclb-choice-sub">${option.elo} Elo</span>
                        </button>
                    `;
                });

                card.innerHTML = `
                    <div class="mclb-config-head">
                        <img src="${gamemode.icon}" alt="${gamemode.name}">
                        <span class="mclb-config-title">${gamemode.name}</span>
                        <span class="mclb-config-state">Not Set</span>
                    </div>
                    <div class="mclb-choice-grid">
                        ${optionsHTML}
                    </div>
                `;

                wrapper.appendChild(card);
            });

            container.appendChild(wrapper);
        }

        function selectSkillLevel(button) {
            if (button.classList.contains('disabled')) return;
            const gamemode = button.closest('.skill-level-card');
            if (!gamemode) return;
            gamemode.querySelectorAll('.skill-option').forEach(opt => opt.classList.remove('selected'));
            button.classList.add('selected');
            const state = gamemode.querySelector('.mclb-config-state');
            if (state) {
                state.textContent = `${button.dataset.rating} Elo`;
            }
        }

        async function handleSaveSkillLevels() {
            if (isBlacklistedAccount() || isAccountChangesRestricted()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot update skill levels.' });
                return;
            }
            const skillLevels = {};
            document.querySelectorAll('.skill-level-card:not(.locked)').forEach(card => {
                const selected = card.querySelector('.skill-option.selected');
                if (selected) {
                    skillLevels[selected.dataset.gamemode] = parseInt(selected.dataset.rating);
                }
            });

            if (Object.keys(skillLevels).length === 0) {
                Swal.fire({ icon: 'warning', title: 'No Changes', text: 'No new skill levels to save.' });
                return;
            }

            try {
                const btn = document.getElementById('saveSkillLevelsBtn');
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

                await apiService.updateSkillLevels(skillLevels);
                apiService.clearCache('/users/me');

                Swal.fire({ icon: 'success', title: 'Saved!', text: 'Skill levels updated.', timer: 1500, showConfirmButton: false });
                await loadProfile();
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Failed', text: error.message });
            }
        }

        let retirementChanges = {};

        function populateRetirementStatus(profile) {
            const container = document.getElementById('retirementContainer');
            const retirementCard = document.getElementById('retirementCard');
            const saveRetirementBtn = document.getElementById('saveRetirementBtn');
            container.innerHTML = '';
            retirementChanges = {};

            const eligibleGamemodes = CONFIG.GAMEMODES.filter(gamemode => {
                if (gamemode.id === 'overall') return false;
                const currentRating = profile.gamemodeRatings?.[gamemode.id];
                return Number.isFinite(currentRating) && currentRating > 0;
            });

            if (eligibleGamemodes.length === 0) {
                if (retirementCard) retirementCard.style.display = 'none';
                if (saveRetirementBtn) saveRetirementBtn.style.display = 'none';
                return;
            }

            if (retirementCard) retirementCard.style.display = '';
            if (saveRetirementBtn) saveRetirementBtn.style.display = '';

            const wrapper = document.createElement('div');
            wrapper.className = 'mclb-config-grid';

            eligibleGamemodes.forEach(gamemode => {

                const isRetired = profile.retiredGamemodes?.[gamemode.id] || false;
                const lastChange = profile.retirementHistory?.[gamemode.id];
                const isOnCooldown = lastChange && (new Date() - new Date(lastChange)) / (1000 * 60 * 60 * 24) < 30;

                const card = document.createElement('div');
                card.className = 'mclb-config-item retirement-card';
                
                const buttonsHTML = `
                    <div class="mclb-segment">
                        <button type="button" class="retirement-option ${isOnCooldown ? 'disabled' : ''} ${!isRetired ? 'selected' : ''}"
                                data-gamemode="${gamemode.id}" data-retired="false"
                                ${isOnCooldown ? 'disabled' : ''}>
                            Active
                        </button>
                        <button type="button" class="retirement-option ${isOnCooldown ? 'disabled' : ''} ${isRetired ? 'selected' : ''}"
                                data-gamemode="${gamemode.id}" data-retired="true"
                                ${isOnCooldown ? 'disabled' : ''}>
                            Retired
                        </button>
                    </div>
                `;

                card.innerHTML = `
                    <div class="mclb-config-head">
                        <img src="${gamemode.icon}" alt="${gamemode.name}">
                        <span class="mclb-config-title">${gamemode.name}</span>
                        <span class="mclb-config-state">${isRetired ? 'Retired' : 'Active'}</span>
                    </div>
                    ${buttonsHTML}
                    ${isOnCooldown ? `<div class="mclb-cooldown-note"><i class="fas fa-lock"></i> Can change in ${Math.ceil(30 - (new Date() - new Date(lastChange)) / (1000 * 60 * 60 * 24))} day(s)</div>` : ''}
                `;

                wrapper.appendChild(card);
            });

            container.appendChild(wrapper);
        }

        function selectRetirement(button) {
            if (button.classList.contains('disabled')) return;
            const card = button.closest('.retirement-card');
            if (!card) return;
            card.querySelectorAll('.retirement-option').forEach(opt => opt.classList.remove('selected'));
            button.classList.add('selected');
            retirementChanges[button.dataset.gamemode] = button.dataset.retired === 'true';
            const state = card.querySelector('.mclb-config-state');
            if (state) {
                state.textContent = button.dataset.retired === 'true' ? 'Retired' : 'Active';
            }
        }

        function bindAccountActionHandlers() {
            const saveSkillLevelsBtn = document.getElementById('saveSkillLevelsBtn');
            if (saveSkillLevelsBtn && !saveSkillLevelsBtn.dataset.bound) {
                saveSkillLevelsBtn.addEventListener('click', handleSaveSkillLevels);
                saveSkillLevelsBtn.dataset.bound = '1';
            }

            const saveRetirementBtn = document.getElementById('saveRetirementBtn');
            if (saveRetirementBtn && !saveRetirementBtn.dataset.bound) {
                saveRetirementBtn.addEventListener('click', handleSaveRetirement);
                saveRetirementBtn.dataset.bound = '1';
            }

            const skillContainer = document.getElementById('skillLevelsContainer');
            if (skillContainer && !skillContainer.dataset.bound) {
                skillContainer.addEventListener('click', (event) => {
                    const button = event.target.closest('.skill-option');
                    if (!button || !skillContainer.contains(button)) return;
                    selectSkillLevel(button);
                });
                skillContainer.dataset.bound = '1';
            }

            const retirementContainer = document.getElementById('retirementContainer');
            if (retirementContainer && !retirementContainer.dataset.bound) {
                retirementContainer.addEventListener('click', (event) => {
                    const button = event.target.closest('.retirement-option');
                    if (!button || !retirementContainer.contains(button)) return;
                    selectRetirement(button);
                });
                retirementContainer.dataset.bound = '1';
            }

            const reloadReportsBtn = document.getElementById('reloadReportsBtn');
            if (reloadReportsBtn && !reloadReportsBtn.dataset.bound) {
                reloadReportsBtn.addEventListener('click', async () => {
                    reloadReportsBtn.disabled = true;
                    const original = reloadReportsBtn.innerHTML;
                    reloadReportsBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refreshing...';
                    try {
                        await loadMyReports();
                    } finally {
                        reloadReportsBtn.disabled = false;
                        reloadReportsBtn.innerHTML = original;
                    }
                });
                reloadReportsBtn.dataset.bound = '1';
            }
        }

        async function handleSaveRetirement() {
            if (isBlacklistedAccount() || isAccountChangesRestricted()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot change retirement settings.' });
                return;
            }
            if (Object.keys(retirementChanges).length === 0) {
                Swal.fire({ icon: 'warning', title: 'No Changes', text: 'No retirement changes to save.' });
                return;
            }

            try {
                const btn = document.getElementById('saveRetirementBtn');
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

                await Promise.all(Object.entries(retirementChanges).map(([gamemode, retired]) =>
                    apiService.setGamemodeRetirement(gamemode, retired)
                ));
                apiService.clearCache('/users/me');

                Swal.fire({ icon: 'success', title: 'Saved!', text: 'Retirement status updated.', timer: 1500, showConfirmButton: false });
                retirementChanges = {};
                await loadProfile();
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Failed', text: error.message });
                await loadProfile();
            }
        }

        function getAccountAuthInstance() {
            try {
                if (typeof getAuth === 'function') {
                    return getAuth();
                }

                if (typeof firebase !== 'undefined' && Array.isArray(firebase.apps) && firebase.apps.length > 0 && typeof firebase.auth === 'function') {
                    const namedApp = firebase.apps.find(app => app && app.name === 'mcleaderboards');
                    if (namedApp) {
                        return firebase.auth(namedApp);
                    }
                    return firebase.auth(firebase.apps[0]);
                }
            } catch (e) {
                console.warn('Could not get Firebase auth instance for connected accounts UI:', e);
            }

            return null;
        }

        function updateConnectedAccountsUI() {
            try {
                const auth = getAccountAuthInstance();
                const user = auth?.currentUser || AppState.currentUser || null;
                const profile = AppState.getProfile() || {};
                const providerIds = (user?.providerData?.map(p => p.providerId) || []);
                const hasGoogle = providerIds.some(id => id === 'google.com');
                const hasPassword = providerIds.some(id => id === 'password') || !!profile.email;
                const isEmailVerified = profile.emailVerified === true || user?.emailVerified === true;

                const statusEl = document.getElementById('connectedAccountsStatus');
                const btnEl = document.getElementById('linkGoogleBtn');
                const emailStatusEl = document.getElementById('emailVerificationStatus');
                const emailBtnEl = document.getElementById('sendVerificationEmailBtn');
                if (!statusEl || !btnEl) return;

                if (hasGoogle) {
                    statusEl.innerHTML = `
                        <div class="account-connection-list">
                            <div class="account-connection-item">
                                <div>
                                    <strong>Email & Password</strong>
                                    <span>${hasPassword ? 'Primary account login is enabled.' : 'No password login detected.'}</span>
                                </div>
                                <span class="badge ${hasPassword ? 'badge-success' : 'badge-secondary'}">${hasPassword ? 'Enabled' : 'Unavailable'}</span>
                            </div>
                            <div class="account-connection-item">
                                <div>
                                    <strong>Google</strong>
                                    <span>Fast sign-in is connected to this account.</span>
                                </div>
                                <span class="badge badge-success"><i class="fas fa-check-circle"></i> Connected</span>
                            </div>
                        </div>
                    `;
                    btnEl.disabled = true;
                    btnEl.innerHTML = '<i class="fab fa-google"></i> Google already linked';
                } else {
                    statusEl.innerHTML = `
                        <div class="account-connection-list">
                            <div class="account-connection-item">
                                <div>
                                    <strong>Email & Password</strong>
                                    <span>${hasPassword ? 'Primary account login is enabled.' : 'No password login detected.'}</span>
                                </div>
                                <span class="badge ${hasPassword ? 'badge-success' : 'badge-secondary'}">${hasPassword ? 'Enabled' : 'Unavailable'}</span>
                            </div>
                            <div class="account-connection-item">
                                <div>
                                    <strong>Google</strong>
                                    <span>Add Google to sign in without typing your password.</span>
                                </div>
                                <span class="badge badge-secondary">Not connected</span>
                            </div>
                        </div>
                    `;
                    btnEl.disabled = false;
                    btnEl.innerHTML = '<i class="fab fa-google"></i> Add Google Account';
                }

                if (emailStatusEl) {
                    emailStatusEl.innerHTML = isEmailVerified
                        ? '<span class="badge badge-success"><i class="fas fa-check-circle"></i> Email verified and ready for sign-in</span>'
                        : '<span class="badge badge-warning"><i class="fas fa-exclamation-triangle"></i> Action required: verify your email before sign-in and onboarding can finish</span>';
                }

                if (emailBtnEl) {
                    emailBtnEl.disabled = isEmailVerified;
                    emailBtnEl.innerHTML = isEmailVerified
                        ? '<i class="fas fa-check-circle"></i> Email Already Verified'
                        : '<i class="fas fa-envelope-open-text"></i> Send Verification Email';
                }

            } catch (e) {
                console.error('Error updating connected accounts:', e);
            }
        }

        async function handleSendVerificationEmail() {
            try {
                const btn = document.getElementById('sendVerificationEmailBtn');
                const original = btn?.innerHTML || '';
                if (btn) {
                    btn.disabled = true;
                    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Sending...';
                }

                await firebaseAuthService.sendEmailVerification({ mode: 'account' });
                Swal.fire({ icon: 'success', title: 'Verification Sent', text: 'Check your inbox for the verification link.' });
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Failed', text: error.message });
            } finally {
                updateConnectedAccountsUI();
            }
        }

        async function handleLinkGoogleAccount() {
            if (isBlacklistedAccount() || isAccountChangesRestricted()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot link providers.' });
                return;
            }
            const btn = document.getElementById('linkGoogleBtn');
            btn.disabled = true;
            const original = btn.innerHTML;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting...';

            try {
                await firebaseAuthService.linkGoogleAccount();
                Swal.fire({ icon: 'success', title: 'Connected!', text: 'Google account linked successfully.', timer: 2000, showConfirmButton: false });
                updateConnectedAccountsUI();
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Failed', text: error.message });
            } finally {
                btn.disabled = false;
                btn.innerHTML = original;
            }
        }

        async function handlePasswordReset() {
            if (isBlacklistedAccount() || isAccountChangesRestricted()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot reset password from this portal.' });
                return;
            }
            const email = AppState.currentUser?.email;
            if (!email) {
                Swal.fire({ icon: 'error', title: 'Error', text: 'Email not found.' });
                return;
            }

            try {
                await firebaseAuthService.sendPasswordResetEmail(email);
                Swal.fire({ icon: 'success', title: 'Email Sent', text: 'Check your inbox for reset instructions.' });
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Error', text: error.message });
            }
        }

        async function handleLinkMinecraft() {
            if (isBlacklistedAccount() || isAccountChangesRestricted()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot edit linked account settings.' });
                return;
            }
            const username = document.getElementById('minecraftUsername').value.trim();
            if (!username.match(/^[a-zA-Z0-9_]{3,16}$/)) {
                Swal.fire({ icon: 'error', title: 'Invalid', text: 'Username must be 3-16 characters.' });
                return;
            }

            try {
                await apiService.linkMinecraftUsername(username);
                Swal.fire({ icon: 'success', title: 'Linked!', text: 'Minecraft username linked.', timer: 1500, showConfirmButton: false });
                await loadProfile();
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Failed', text: error.message });
            }
        }

        async function handleUpdateRegion() {
            if (isBlacklistedAccount() || isAccountChangesRestricted()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot edit account settings.' });
                return;
            }
            const region = document.getElementById('accountRegion').value;
            if (!region) {
                Swal.fire({ icon: 'warning', title: 'Required', text: 'Please select a region.' });
                return;
            }

            try {
                const btn = document.querySelector('button[onclick="handleUpdateRegion()"]');
                btn.disabled = true;
                btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

                await apiService.updateProfile({ region });
                Swal.fire({ icon: 'success', title: 'Saved!', text: 'Region updated.', timer: 1500, showConfirmButton: false });
                await loadProfile();
            } catch (error) {
                Swal.fire({ icon: 'error', title: 'Failed', text: error.message });
            }
        }

        /* Plus Settings Functions (existing from old account.html) */
        let plusGradientDraft = null;
        let plusGradientPreviewDraft = null;

        function getDefaultPlusGradient() {
            return { angle: 90, stops: [{ color: '#f2c94c', pos: 0 }, { color: '#ffffff', pos: 55 }, { color: '#d9a441', pos: 100 }] };
        }

        function applyGradientPreview(el, username, gradient) {
            if (!el) return;
            const name = username || 'PreviewName';
            const stops = Array.isArray(gradient?.stops) ? gradient.stops.slice() : [];
            if (!gradient || stops.length < 2) {
                el.textContent = name;
                el.style.background = '';
                return;
            }
            const angle = typeof gradient.angle === 'number' ? gradient.angle : 90;
            stops.sort((a, b) => (a.pos || 0) - (b.pos || 0));
            const stopStr = stops.map(s => `${s.color}${s.pos !== undefined ? ` ${s.pos}%` : ''}`).join(', ');
            el.textContent = name;
            el.style.background = `linear-gradient(${angle}deg, ${stopStr})`;
            el.style.webkitBackgroundClip = 'text';
            el.style.backgroundClip = 'text';
            el.style.color = 'transparent';
        }

        function renderPlusSettings(profile) {
            const checkbox = document.getElementById('showPlusBadgeCheckbox');
            const plus = profile?.plus || {};
            if (checkbox) {
                checkbox.checked = plus.showBadge !== false;
                checkbox.disabled = plus.active !== true;
            }
            plusGradientDraft = plus.active ? (plus.gradient || getDefaultPlusGradient()) : null;
            plusGradientPreviewDraft = plus.active ? (plusGradientDraft || getDefaultPlusGradient()) : getDefaultPlusGradient();
            const preview = document.getElementById('plusGradientPreview');
            if (preview) {
                applyGradientPreview(preview, profile.minecraftUsername || 'PreviewName', plusGradientPreviewDraft);
            }
        }

        window.openPlusGradientEditor = async function() {
            const profile = AppState.getProfile() || {};
            const plus = profile.plus || {};
            if (plus.blocked) {
                Swal.fire({ icon: 'error', title: 'Blocked', text: 'Plus blocked for this account.' });
                return;
            }
            const current = (plus.active ? (plusGradientDraft || plus.gradient) : plusGradientPreviewDraft) || getDefaultPlusGradient();
            const username = profile.minecraftUsername || 'PreviewName';
            const stops = current.stops || getDefaultPlusGradient().stops;
            const angle = typeof current.angle === 'number' ? current.angle : 90;
            const animation = (current.animation || 'none').toString();

            const html = `<div style="text-align:left;">
                <div style="padding: 1rem; border-radius: 12px; border: 1px solid rgba(59,179,137,0.22); background: rgba(10,10,10,0.7);">
                    <div style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 0.35rem;">
                        <i class="fas fa-eye"></i> Preview
                    </div>
                    <div id="plusGradientModalPreview" class="plus-gradient-preview-name">${escapeHtml(username)}</div>
                </div>
                <div style="display:grid; gap:0.75rem; margin-top: 1rem;">
                    <div><label style="color: var(--text-muted);">Angle: <input id="plusGradientAngle" type="range" min="0" max="360" value="${angle}" style="width:100px;"> <span id="plusGradientAngleVal">${angle}&deg;</span></label></div>
                    <div><label style="color: var(--text-muted);">Animation: <select id="plusGradientAnim" class="form-input" style="width:100%;"><option value="none" ${animation === 'none' ? 'selected' : ''}>None</option><option value="shift" ${animation === 'shift' ? 'selected' : ''}>Shimmer</option><option value="pulse" ${animation === 'pulse' ? 'selected' : ''}>Pulse</option></select></label></div>
                    <div><label style="color: var(--text-muted);">Color 1: <input id="plusColor1" type="color" value="${stops[0]?.color || '#f2c94c'}"> Position: <input id="plusPos1" type="number" min="0" max="100" value="${stops[0]?.pos || 0}" style="width:60px;"> %</label></div>
                    <div><label style="color: var(--text-muted);">Color 2: <input id="plusColor2" type="color" value="${stops[1]?.color || '#ffffff'}"> Position: <input id="plusPos2" type="number" min="0" max="100" value="${stops[1]?.pos || 55}" style="width:60px;"> %</label></div>
                    <div><label style="color: var(--text-muted);">Color 3: <input id="plusColor3" type="color" value="${stops[2]?.color || '#d9a441'}"> Position: <input id="plusPos3" type="number" min="0" max="100" value="${stops[2]?.pos || 100}" style="width:60px;"> % <button class="btn btn-secondary" type="button" id="plusSwapBtn" style="padding:0.25rem 0.5rem; margin-left: 0.5rem;"><i class="fas fa-exchange-alt"></i></button></label></div>
                </div>
            </div>`;

            const result = await Swal.fire({
                title: 'Gradient Editor',
                html,
                showCancelButton: true,
                confirmButtonText: plus.active ? 'Save' : 'Try',
                cancelButtonText: 'Cancel',
                confirmButtonColor: '#d9a441',
                background: 'rgba(36, 36, 36, 0.98)',
                color: '#e9eef5',
                didOpen: () => {
                    const preview = document.getElementById('plusGradientModalPreview');
                    const angleEl = document.getElementById('plusGradientAngle');
                    const angleVal = document.getElementById('plusGradientAngleVal');
                    const animEl = document.getElementById('plusGradientAnim');
                    const c1El = document.getElementById('plusColor1');
                    const c2El = document.getElementById('plusColor2');
                    const c3El = document.getElementById('plusColor3');
                    const p1El = document.getElementById('plusPos1');
                    const p2El = document.getElementById('plusPos2');
                    const p3El = document.getElementById('plusPos3');
                    const swapBtn = document.getElementById('plusSwapBtn');

                    const update = () => {
                        const ang = parseInt(angleEl.value || '90');
                        angleVal.innerHTML = `${ang}&deg;`;
                        const stops = [
                            { color: c1El.value, pos: parseInt(p1El.value || '0') },
                            { color: c2El.value, pos: parseInt(p2El.value || '55') },
                            { color: c3El.value, pos: parseInt(p3El.value || '100') }
                        ].sort((a,b) => a.pos - b.pos);
                        const anim = (animEl?.value || 'none').toString();
                        const draft = { angle: ang, stops, animation: anim };
                        plusGradientPreviewDraft = draft;
                        if (plus.active) plusGradientDraft = draft;
                        applyGradientPreview(preview, username, draft);
                    };
                    [angleEl, animEl, c1El, c2El, c3El, p1El, p2El, p3El].forEach(el => el?.addEventListener('input', update));
                    swapBtn.addEventListener('click', () => {
                        const tmp = c1El.value;
                        c1El.value = c3El.value;
                        c3El.value = tmp;
                        update();
                    });
                    update();
                },
                preConfirm: () => plusGradientPreviewDraft
            });

            if (result.isConfirmed) {
                const previewEl = document.getElementById('plusGradientPreview');
                if (previewEl) applyGradientPreview(previewEl, username, plusGradientPreviewDraft);
            }
        };

        window.savePlusSettings = async function() {
            if (isBlacklistedAccount()) {
                Swal.fire({ icon: 'error', title: 'Restricted', text: 'Blacklisted accounts cannot edit Plus preferences.' });
                return;
            }
            const profile = AppState.getProfile() || {};
            const plus = profile.plus || {};
            if (plus.active !== true) {
                Swal.fire({ icon: 'info', title: 'Plus Required', text: 'Active Plus membership needed.' });
                return;
            }

            const btn = document.querySelector('button[onclick="savePlusSettings()"]');
            const checkbox = document.getElementById('showPlusBadgeCheckbox');
            const showBadge = checkbox?.checked === true;

            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';

            try {
                await apiService.savePlusPreferences({ showBadge, gradient: plusGradientDraft });
                await apiService.syncPlusToPlayer();
                apiService.clearCache('/users/me');
                const updated = await apiService.getProfile();
                AppState.setProfile(updated);
                renderPlusSettings(updated);
                Swal.fire({ icon: 'success', title: 'Saved', text: 'Plus settings updated.', timer: 1500, showConfirmButton: false });
            } catch (e) {
                Swal.fire({ icon: 'error', title: 'Failed', text: e.message });
            } finally {
                btn.disabled = false;
                btn.innerHTML = '<i class="fas fa-save"></i> Save Plus Settings';
            }
        };

        function escapeHtml(text) {
            const div = document.createElement('div');
            div.textContent = text;
            return div.innerHTML;
        }

        function openReloadAccountModal() {
            Swal.fire({
                title: 'Reload Account',
                html: `
                    <div style="text-align: left;">
                        <div class="card-alert warning" style="margin-bottom: 1rem;">
                            <i class="fas fa-exclamation-triangle"></i>
                            <span><strong>Warning:</strong> Only use if you know what you're doing.</span>
                        </div>
                        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem;">
                            <button id="reloadBadgesBtn" class="btn btn-danger" style="width: 100%;">
                                <i class="fas fa-user-shield"></i><br>Reload Badges
                            </button>
                            <button id="reloadTiersBtn" class="btn btn-warning" style="width: 100%;">
                                <i class="fas fa-trophy"></i><br>Reload Tiers
                            </button>
                        </div>
                    </div>
                `,
                showConfirmButton: false,
                showCancelButton: true,
                cancelButtonText: 'Close',
                didOpen: () => {
                    document.getElementById('reloadBadgesBtn')?.addEventListener('click', async () => {
                        if (confirm('Confirm reload badges?')) {
                            try {
                                await apiService.reloadAccountBadges();
                                Swal.fire({ icon: 'success', title: 'Done!', timer: 2000, showConfirmButton: false });
                                setTimeout(() => window.location.reload(), 2000);
                            } catch (e) {
                                Swal.fire({ icon: 'error', title: 'Failed', text: e.message });
                            }
                        }
                    });
                    document.getElementById('reloadTiersBtn')?.addEventListener('click', async () => {
                        if (confirm('Confirm reload tiers?')) {
                            try {
                                await apiService.reloadAccountTiers();
                                Swal.fire({ icon: 'success', title: 'Done!', timer: 2000, showConfirmButton: false });
                                setTimeout(() => window.location.reload(), 2000);
                            } catch (e) {
                                Swal.fire({ icon: 'error', title: 'Failed', text: e.message });
                            }
                        }
                    });
                }
            });
        }

        window.addEventListener('DOMContentLoaded', async () => {
            const waitForFirebase = () => new Promise(resolve => {
                const check = () => typeof waitForFirebaseInit === 'function' ? waitForFirebaseInit().then(resolve) : setTimeout(check, 50);
                check();
            });
            const waitForAuth = () => new Promise(resolve => {
                const check = () => typeof requireAuth === 'function' ? resolve() : setTimeout(check, 50);
                check();
            });

            await waitForFirebase();
            await waitForAuth();
            bindAccountActionHandlers();
            const authenticated = await requireAuth();
            if (!authenticated) return;
            await initAccount();
        });
