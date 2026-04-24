const QUEST_STEPS = [
  {
    id: 'hall-of-echoes',
    title: 'I. Hall of Echoes',
    story: 'You descend beneath the arena and find a corridor lined with old scoreboards.\nEach board repeats your footsteps a second late, like memory itself is lagging behind reality.\nAt the final gate, a bronze plate waits for one word.',
    riddle: 'I repeat what you say, but I have no mouth. What am I?'
  },
  {
    id: 'clockwork-garden',
    title: 'II. Clockwork Garden',
    story: 'The second door opens into a garden made of gears and obsidian vines.\nA silent sundial points toward a moonlit wall, where your silhouette moves without you.\nA second plate asks for the name of what follows but is never held.',
    riddle: 'I follow you all day, but vanish in darkness. What am I?'
  },
  {
    id: 'frozen-library',
    title: 'III. Frozen Library',
    story: 'Past the garden lies a library trapped in ice.\nBooks whisper from sealed shelves, and one sentence keeps returning:\n"A single light makes knowledge breathe again."',
    riddle: 'I melt wax and reveal words, yet I am consumed while helping others see. What am I?'
  },
  {
    id: 'crown-vault',
    title: 'IV. Crown Vault',
    story: 'The final chamber is circular and quiet, crowned by cracked quartz and old banners.\nAt the center sits a box marked only with one phrase: "No gimmicks. No tricks. Just..."\nYou know the final answer. Say it, and the vault opens.',
    riddle: 'Complete the phrase: "No gimmicks. No tricks. Just ____."'
  }
];

let questState = null;

function getStepByIndex(index) {
  return QUEST_STEPS[index] || null;
}

function isAuthenticated() {
  return typeof AppState !== 'undefined' && typeof AppState.isAuthenticated === 'function' && AppState.isAuthenticated();
}

async function ensureQuestAuthReady() {
  // Prefer centralized auth guard when available.
  if (typeof requireAuth === 'function') {
    const ok = await requireAuth(false, false);
    return ok === true;
  }

  // Fallback path: wait briefly for Firebase auth state and AppState hydration.
  if (typeof firebase !== 'undefined' && typeof firebase.auth === 'function') {
    const auth = firebase.auth();

    if (!auth.currentUser) {
      await new Promise((resolve) => {
        let resolved = false;
        const unsubscribe = auth.onAuthStateChanged((user) => {
          if (resolved) return;
          resolved = true;
          unsubscribe();
          if (user && typeof AppState !== 'undefined' && typeof AppState.setUser === 'function') {
            AppState.setUser(user);
          }
          resolve();
        });

        setTimeout(() => {
          if (resolved) return;
          resolved = true;
          unsubscribe();
          resolve();
        }, 5000);
      });
    } else if (typeof AppState !== 'undefined' && typeof AppState.setUser === 'function') {
      AppState.setUser(auth.currentUser);
    }
  }

  return isAuthenticated();
}

function renderTimeline(progress) {
  const eventsEl = document.getElementById('questEvents');
  if (!eventsEl) return;

  const solved = new Set(progress?.solvedStepIds || []);
  eventsEl.innerHTML = QUEST_STEPS.map((step, idx) => {
    const done = solved.has(step.id) || (progress.completed && idx < QUEST_STEPS.length);
    return `
      <div class="quest-event ${done ? 'done' : ''}">
        <strong>${step.title}</strong>
        <div class="text-muted" style="font-size:0.9rem; margin-top:0.25rem;">${done ? 'Unlocked and solved' : 'Locked'}</div>
      </div>
    `;
  }).join('');
}

function renderQuest(progress) {
  const progressEl = document.getElementById('questProgress');
  const storyEl = document.getElementById('questStory');
  const riddleEl = document.getElementById('questRiddle');
  const answerInput = document.getElementById('questAnswer');
  const submitBtn = document.getElementById('questSubmitBtn');
  const rewardEl = document.getElementById('questRewardCard');

  if (!progressEl || !storyEl || !riddleEl || !answerInput || !submitBtn || !rewardEl) return;

  const solvedCount = Math.max(0, Math.min(progress.stepIndex || 0, QUEST_STEPS.length));
  progressEl.textContent = `Progress: ${solvedCount} / ${QUEST_STEPS.length} chapters solved`;

  renderTimeline(progress);

  if (progress.completed) {
    storyEl.textContent = 'The vault opens. Inside is an old crown insignia, a ledger of forgotten players, and a final note:\n"For those who solve with patience, a year of Plus is yours."';
    riddleEl.style.display = 'none';
    answerInput.style.display = 'none';
    submitBtn.style.display = 'none';

    rewardEl.style.display = 'block';
    if (progress.rewardClaimed && progress.rewardCode) {
      rewardEl.innerHTML = `
        <strong><i class="fas fa-crown"></i> Reward already claimed</strong>
        <div class="text-muted" style="margin-top:0.35rem;">Your one-time reward code:</div>
        <div class="reward-code">${progress.rewardCode}</div>
        <div class="text-muted" style="margin-top:0.55rem;">Redeem it on the Plus page.</div>
      `;
    } else {
      rewardEl.innerHTML = `
        <strong><i class="fas fa-gift"></i> Final reward unlocked</strong>
        <div class="text-muted" style="margin-top:0.35rem;">Claim your one-time 6-digit code for 1 year of Plus.</div>
        <button class="btn btn-primary" style="margin-top:0.65rem;" onclick="claimQuestReward()">
          <i class="fas fa-box-open"></i> Claim Reward Code
        </button>
      `;
    }
    return;
  }

  const step = getStepByIndex(progress.stepIndex || 0);
  if (!step) {
    storyEl.textContent = 'Unable to load current chapter. Try refreshing.';
    riddleEl.style.display = 'none';
    return;
  }

  storyEl.textContent = step.story;
  riddleEl.style.display = 'block';
  riddleEl.textContent = step.riddle;
  answerInput.style.display = '';
  submitBtn.style.display = '';
  rewardEl.style.display = 'none';
}

async function loadQuestState() {
  const ready = await ensureQuestAuthReady();
  if (!ready) {
    // If auth guard is active it handles redirect/prompt itself.
    if (typeof requireAuth !== 'function') {
      window.location.href = 'login.html';
    }
    return;
  }

  const response = await apiService.getEasterEggState();
  questState = response.progress;
  renderQuest(questState);
}

window.submitQuestAnswer = async function submitQuestAnswer() {
  if (!questState || questState.completed) return;

  const answerInput = document.getElementById('questAnswer');
  const step = getStepByIndex(questState.stepIndex || 0);
  if (!answerInput || !step) return;

  const answer = (answerInput.value || '').trim();
  if (!answer) {
    Swal.fire({ icon: 'warning', title: 'Answer required', text: 'Enter an answer before submitting.' });
    return;
  }

  // Show fade-to-black "Awaiting..." screen
  const overlay = document.createElement('div');
  overlay.id = 'questAwaitingOverlay';
  overlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.95);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 9999;
    animation: fadeIn 0.4s ease-out;
  `;
  
  overlay.innerHTML = `
    <div style="text-align: center; color: #fff;">
      <div style="font-size: 2rem; font-weight: 300; letter-spacing: 2px; margin-bottom: 1rem;">Awaiting...</div>
      <div style="font-size: 0.9rem; color: rgba(255, 255, 255, 0.6); margin-top: 2rem;">The vault considers your answer...</div>
    </div>
  `;
  
  // Add fade-in animation
  const style = document.createElement('style');
  style.textContent = `
    @keyframes fadeIn {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
  `;
  document.head.appendChild(style);
  document.body.appendChild(overlay);

  try {
    await apiService.solveEasterEggStep(step.id, answer);
    // Keep fade overlay for 3 seconds, then reload page
    await new Promise(resolve => setTimeout(resolve, 3000));
    window.location.reload();
  } catch (error) {
    overlay.remove();
    Swal.fire({ icon: 'error', title: 'Not quite', text: error.message || 'That answer does not fit this chapter.' });
  }
};

window.claimQuestReward = async function claimQuestReward() {
  try {
    const response = await apiService.claimEasterEggReward();
    await loadQuestState();
    Swal.fire({
      icon: 'success',
      title: 'Reward Claimed',
      html: `Your Plus code is <strong style="letter-spacing:0.15em;">${response.code}</strong><br>Redeem it on the Plus page.`
    });
  } catch (error) {
    Swal.fire({ icon: 'error', title: 'Claim failed', text: error.message || 'Unable to claim reward code.' });
  }
};

document.addEventListener('DOMContentLoaded', () => {
  loadQuestState().catch((error) => {
    console.error('Failed to load quest:', error);
    Swal.fire({ icon: 'error', title: 'Error', text: error.message || 'Failed to load quest progress.' });
  });
});
