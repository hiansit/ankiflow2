/**
 * AutoPlaybackManager - 自動連続再生（耳学習・睡眠学習）マネージャー
 * 
 * 責務:
 * 1. 一切の操作不要で問題・答えを音声自動ループ再生するセッションのライフサイクル管理
 * 2. タイマー管理（指定分経過・1周のみ・無制限ループでの終了制御）
 * 3. 1カード進行サイクル（非同期音声発話・思考待機・答え展開・答え発話・次問待機）
 * 4. 周回カウント（autoPlayLoopCount）の管理とトースト通知
 * 5. 一時停止/再開・スキップ・中断の安全な非同期キャンセラ制御
 * 6. 自動再生時のランク未評価・学習ログ非蓄積保護（寝落ち保護）
 */

class AutoPlaybackManager {
  constructor(app = null, dbService = null, speechService = null, studySessionManager = null) {
    this.app = app;
    this.dbService = dbService;
    this.speechService = speechService;
    this.studySessionManager = studySessionManager;
    this.wakeLock = null;
  }

  getEl(id) {
    if (typeof document === 'undefined') return null;
    return document.getElementById(id);
  }

  setServices({ app, dbService, speechService, studySessionManager }) {
    if (app) this.app = app;
    if (dbService) this.dbService = dbService;
    if (speechService) this.speechService = speechService;
    if (studySessionManager) this.studySessionManager = studySessionManager;
  }

  /**
   * 睡眠学習・連続再生中の画面自動スリープ・ロックを防止 (Screen Wake Lock API)
   */
  async requestWakeLock() {
    if (typeof navigator !== 'undefined' && 'wakeLock' in navigator) {
      try {
        this.wakeLock = await navigator.wakeLock.request('screen');
      } catch (err) {
        console.warn('[AutoPlaybackManager] WakeLock not available or rejected:', err);
      }
    }
  }

  releaseWakeLock() {
    if (this.wakeLock) {
      this.wakeLock.release().then(() => {
        this.wakeLock = null;
      }).catch(() => {
        this.wakeLock = null;
      });
    }
  }

  get session() {
    return this.studySessionManager ? this.studySessionManager.state : null;
  }

  /**
   * 自動連続再生セッションを開始
   * @param {Array} queue - 出題項目キュー
   * @param {Object} options - 自動再生オプション
   */
  start(queue, options = {}) {
    if (!this.studySessionManager) return;
    const session = this.studySessionManager.state;

    // タイマー設定の解析 ('5', '10', '15', '30', 'once', 'unlimited')
    const timerSetting = options.autoPlayTimer || '15';
    let timerRemainingSec = null;
    if (timerSetting === 'once' || timerSetting === 'unlimited') {
      timerRemainingSec = null;
    } else {
      timerRemainingSec = parseInt(timerSetting, 10) * 60;
    }

    const promptIntervalMs = Math.round(parseFloat(options.autoPlayPromptInterval || '2.5') * 1000);
    const answerIntervalMs = Math.round(parseFloat(options.autoPlayAnswerInterval || '2.0') * 1000);

    // セッション状態の初期化
    session.isActive = true;
    session.mode = 'auto_playback';
    session.options = options;
    session.queue = queue;
    session.currentIndex = 0;
    session.isAnswerShown = false;
    session.isPaused = false;
    session.accumulatedMs = 0;
    session.currentRunStart = Date.now();
    session.elapsedMs = 0;
    session.results = [];

    // 自動再生専用プロパティ
    session.isAutoPlay = true;
    session.autoPlayTimerSetting = timerSetting;
    session.autoPlayRemainingSec = timerRemainingSec;
    session.autoPlayTimerInterval = null;
    session.autoPlayPromptWaitMs = promptIntervalMs;
    session.autoPlayAnswerWaitMs = answerIntervalMs;
    session.autoPlayToken = 0;
    session.autoPlayStepTimeout = null;
    session.autoPlayLoopCount = 1;

    // 通常学習タイマー（放置ガードタイマー）を確実に停止
    if (this.studySessionManager && typeof this.studySessionManager.stopTimer === 'function') {
      this.studySessionManager.stopTimer();
    }

    // UIの切り替え
    const setupArea = this.getEl('study-setup-area');
    if (setupArea) setupArea.style.display = 'none';

    const activeArea = this.getEl('study-active-area');
    if (activeArea) activeArea.style.display = 'block';

    const overlay = this.getEl('study-pause-overlay');
    if (overlay) overlay.style.display = 'none';

    const normalControls = this.getEl('normal-study-controls');
    if (normalControls) normalControls.style.display = 'none';

    const autoPlayBar = this.getEl('auto-play-bar');
    if (autoPlayBar) autoPlayBar.style.display = 'flex';

    // 通常の回答時間インジケーター・自動発音ラベルを非表示
    const timerIndicator = typeof document !== 'undefined' ? document.querySelector('.timer-indicator') : null;
    if (timerIndicator) timerIndicator.style.display = 'none';

    const labelAutoSpeak = this.getEl('label-auto-speak');
    if (labelAutoSpeak) labelAutoSpeak.style.display = 'none';

    const btnPause = this.getEl('btn-auto-play-pause');
    if (btnPause) btnPause.textContent = '⏸️ 一時停止';

    // 画面スリープ防止（WakeLock）
    this.requestWakeLock();

    // タイマー開始
    this.startAutoPlayTimer();
    this.updateAutoPlayTimerDisplay();

    // 再生サイクルの開始
    this.runAutoPlayCycle();
  }

  /**
   * 自動再生タイマーの開始（1秒ごとのカウントダウン）
   */
  startAutoPlayTimer() {
    this.stopAutoPlayTimer();
    const session = this.session;
    if (!session || !session.isAutoPlay) return;

    if (session.autoPlayTimerSetting === 'once' || session.autoPlayTimerSetting === 'unlimited') {
      return;
    }

    session.autoPlayTimerInterval = setInterval(() => {
      if (!session.isActive || !session.isAutoPlay) {
        this.stopAutoPlayTimer();
        return;
      }
      if (session.isPaused) return;

      if (session.autoPlayRemainingSec !== null) {
        session.autoPlayRemainingSec--;
        this.updateAutoPlayTimerDisplay();

        if (session.autoPlayRemainingSec <= 0) {
          this.finish('⏱️ タイマー時間終了により、自動連続再生を完了しました。');
        }
      }
    }, 1000);
  }

  /**
   * 自動再生タイマーの停止
   */
  stopAutoPlayTimer() {
    const session = this.session;
    if (session && session.autoPlayTimerInterval) {
      clearInterval(session.autoPlayTimerInterval);
      session.autoPlayTimerInterval = null;
    }
  }

  /**
   * タイマー表示の更新
   */
  updateAutoPlayTimerDisplay() {
    const timerDisplay = this.getEl('auto-play-timer-text');
    if (!timerDisplay) return;

    const session = this.session;
    if (!session || !session.isAutoPlay) return;

    const loopText = session.autoPlayLoopCount > 1 ? ` (${session.autoPlayLoopCount}周目)` : '';
    if (session.autoPlayTimerSetting === 'once') {
      timerDisplay.textContent = `1周のみ再生${loopText}`;
    } else if (session.autoPlayTimerSetting === 'unlimited') {
      timerDisplay.textContent = `無制限ループ${loopText}`;
    } else if (session.autoPlayRemainingSec !== null) {
      const min = Math.floor(Math.max(0, session.autoPlayRemainingSec) / 60);
      const sec = Math.max(0, session.autoPlayRemainingSec) % 60;
      timerDisplay.textContent = `⏱️ 残り ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}${loopText}`;
    }
  }

  /**
   * 自動再生の1カードサイクル（問題読み上げ → 思考時間 → 答え読み上げ → 次へ）
   */
  async runAutoPlayCycle() {
    const session = this.session;
    if (!session || !session.isActive || !session.isAutoPlay || session.isPaused) return;

    const token = ++session.autoPlayToken;
    if (this.studySessionManager) {
      this.studySessionManager.renderCurrentCard();
    }

    // 1. 問題の音声読み上げ
    this.setAutoPlayCardStatus('🔊 問題を読み上げ中...');
    await this.speakCurrentPromptAsync();
    if (this.isAutoPlayAborted(token)) return;

    // 2. 思考時間の待機
    this.setAutoPlayCardStatus(`🤔 思考中 (${(session.autoPlayPromptWaitMs / 1000).toFixed(1)}秒)...`);
    await this.sleepAsync(session.autoPlayPromptWaitMs, token);
    if (this.isAutoPlayAborted(token)) return;

    // 3. 答えを展開
    if (this.studySessionManager) {
      this.studySessionManager.revealAnswer(false);
    }

    // 4. 答えの音声読み上げ
    this.setAutoPlayCardStatus('🔊 答えを読み上げ中...');
    await this.speakCurrentAnswerAsync();
    if (this.isAutoPlayAborted(token)) return;

    // 5. 次問への待機
    this.setAutoPlayCardStatus(`⏳ 次のカードへ (${(session.autoPlayAnswerWaitMs / 1000).toFixed(1)}秒)...`);
    await this.sleepAsync(session.autoPlayAnswerWaitMs, token);
    if (this.isAutoPlayAborted(token)) return;

    // 6. 次のカードへ進む
    this.advanceAutoPlay(token);
  }

  advanceAutoPlay(token) {
    const session = this.session;
    if (!session || this.isAutoPlayAborted(token)) return;

    session.currentIndex++;

    if (session.currentIndex >= session.queue.length) {
      if (session.autoPlayTimerSetting === 'once') {
        this.finish('🎉 1周の自動再生が完了しました！');
        return;
      }
      session.currentIndex = 0;
      session.autoPlayLoopCount++;
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast(`🎧 ${session.autoPlayLoopCount}周目の再生に入ります`, 'info');
      }
    }

    this.runAutoPlayCycle();
  }

  isAutoPlayAborted(token) {
    const session = this.session;
    if (!session) return true;
    return token !== session.autoPlayToken || !session.isActive || !session.isAutoPlay || session.isPaused;
  }

  sleepAsync(ms, token) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, ms);
      if (this.session) {
        this.session.autoPlayStepTimeout = timer;
      }
    });
  }

  async speakCurrentPromptAsync() {
    const session = this.session;
    if (!session || !session.isActive || session.currentIndex >= session.queue.length) return;
    const currentItem = session.queue[session.currentIndex];
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const meta = this.dbService ? this.dbService.getMaterialMetadata(materialType) : null;
    const speechCol = meta ? meta.prompt_speech_column : null;
    const text = (speechCol && currentItem[speechCol] !== undefined && currentItem[speechCol] !== null && String(currentItem[speechCol]).trim() !== '')
      ? String(currentItem[speechCol]).trim()
      : currentItem.display_prompt;
    if (text && this.speechService && typeof this.speechService.speak === 'function') {
      try {
        await this.speechService.speak(text, { lang: (meta && meta.prompt_lang) ? meta.prompt_lang : 'auto' });
      } catch (e) {
        console.warn('[AutoPlaybackManager] speakCurrentPromptAsync error:', e);
      }
    }
  }

  async speakCurrentAnswerAsync() {
    const session = this.session;
    if (!session || !session.isActive || session.currentIndex >= session.queue.length) return;
    const currentItem = session.queue[session.currentIndex];
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const meta = this.dbService ? this.dbService.getMaterialMetadata(materialType) : null;
    const speechCol = meta ? meta.answer_speech_column : null;
    const text = (speechCol && currentItem[speechCol] !== undefined && currentItem[speechCol] !== null && String(currentItem[speechCol]).trim() !== '')
      ? String(currentItem[speechCol]).trim()
      : currentItem.display_answer;
    if (text && this.speechService && typeof this.speechService.speak === 'function') {
      try {
        await this.speechService.speak(text, { lang: (meta && meta.answer_lang) ? meta.answer_lang : 'auto' });
      } catch (e) {
        console.warn('[AutoPlaybackManager] speakCurrentAnswerAsync error:', e);
      }
    }
  }

  setAutoPlayCardStatus(msg) {
    const el = this.getEl('auto-play-card-status');
    if (el) el.textContent = msg;
  }

  stopCurrentSpeechAndTimer() {
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      try {
        window.speechSynthesis.cancel();
      } catch (e) {}
    }
    const session = this.session;
    if (session && session.autoPlayStepTimeout) {
      clearTimeout(session.autoPlayStepTimeout);
      session.autoPlayStepTimeout = null;
    }
  }

  skipNext() {
    const session = this.session;
    if (!session || !session.isActive || !session.isAutoPlay) return;
    this.stopCurrentSpeechAndTimer();
    session.currentIndex++;
    if (session.currentIndex >= session.queue.length) {
      if (session.autoPlayTimerSetting === 'once') {
        this.finish('🎉 1周の自動再生が完了しました！');
        return;
      }
      session.currentIndex = 0;
      session.autoPlayLoopCount++;
    }
    this.runAutoPlayCycle();
  }

  skipPrev() {
    const session = this.session;
    if (!session || !session.isActive || !session.isAutoPlay) return;
    this.stopCurrentSpeechAndTimer();
    session.currentIndex = Math.max(0, session.currentIndex - 1);
    this.runAutoPlayCycle();
  }

  /**
   * 自動再生の一時停止
   */
  pause() {
    const session = this.session;
    if (!session || !session.isActive || !session.isAutoPlay || session.isPaused) return;
    session.isPaused = true;
    this.stopCurrentSpeechAndTimer();
    this.releaseWakeLock();
    const btn = this.getEl('btn-auto-play-pause');
    if (btn) btn.textContent = '▶️ 再開';
    this.setAutoPlayCardStatus('⏸️ 一時停止中');
  }

  /**
   * 自動再生の再開
   */
  resume() {
    const session = this.session;
    if (!session || !session.isActive || !session.isAutoPlay || !session.isPaused) return;
    session.isPaused = false;
    this.requestWakeLock();
    const overlay = this.getEl('study-pause-overlay');
    if (overlay) overlay.style.display = 'none';
    const btn = this.getEl('btn-auto-play-pause');
    if (btn) btn.textContent = '⏸️ 一時停止';
    this.setAutoPlayCardStatus('▶️ 再開しました');
    this.runAutoPlayCycle();
  }

  togglePause() {
    const session = this.session;
    if (!session || !session.isActive || !session.isAutoPlay) return;
    if (session.isPaused) {
      this.resume();
    } else {
      this.pause();
    }
  }

  finish(msg = '自動連続再生を終了しました。') {
    this.stopCurrentSpeechAndTimer();
    this.stopAutoPlayTimer();
    this.releaseWakeLock();
    const session = this.session;
    if (session) {
      session.isActive = false;
      session.isAutoPlay = false;
    }

    const activeArea = this.getEl('study-active-area');
    if (activeArea) activeArea.style.display = 'none';

    const autoPlayBar = this.getEl('auto-play-bar');
    if (autoPlayBar) autoPlayBar.style.display = 'none';

    const normalControls = this.getEl('normal-study-controls');
    if (normalControls) normalControls.style.display = 'flex';

    const labelAutoSpeak = this.getEl('label-auto-speak');
    if (labelAutoSpeak) labelAutoSpeak.style.display = 'inline-flex';

    const timerIndicator = typeof document !== 'undefined' ? document.querySelector('.timer-indicator') : null;
    if (timerIndicator) timerIndicator.style.display = 'inline-block';

    const setupArea = this.getEl('study-setup-area');
    if (setupArea) setupArea.style.display = 'block';

    // 自動連続再生終了時にセットアップ画面のランク集計・ピル表示を更新
    if (this.studySessionManager && typeof this.studySessionManager.refreshSetupForm === 'function') {
      this.studySessionManager.refreshSetupForm();
    }

    if (this.app) {
      if (typeof this.app.showToast === 'function') {
        this.app.showToast(msg, 'info');
      }
      if (typeof this.app.renderDashboard === 'function') {
        this.app.renderDashboard();
      }
    }
  }
}

if (typeof window !== 'undefined') {
  window.AutoPlaybackManager = AutoPlaybackManager;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AutoPlaybackManager;
}
