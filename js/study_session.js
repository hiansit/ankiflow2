/**
 * StudySessionManager - フラッシュカード学習セッション管理マネージャー
 * 
 * 責務:
 * 1. 学習セッション状態（出題キュー、進行インデックス、タイマー変数、無操作監視、回答履歴）の管理
 * 2. フラッシュカードのDOM描画（問題、動的ヒント、答え、ランク評価ボタン群）
 * 3. 高精度タイマー計測（一時停止中の時間除外、最後の操作・再開から60秒放置時の自動停止ガード、200ms〜60秒サニティキャップ）
 * 4. 音声読み上げ連携（自動発音、問題/回答の発音）
 * 5. キーボードショートカット（Space, 1-5, P, Esc, R）
 * 6. セッション完了サマリー画面の描画と結果集計
 */

class StudySessionManager {
  static AUTO_PAUSE_IDLE_MS = 60000; // 60秒無操作で自動一時停止
  static MIN_SANITY_TIME_MS = 200;   // 最小回答時間キャップ (0.2秒)
  static MAX_SANITY_TIME_MS = 60000; // 最大回答時間キャップ (60.0秒)
  static TIMER_TICK_MS = 100;        // タイマー更新間隔 (0.1秒)

  constructor(app = null, dbService = null, speechService = null) {
    this.app = app;
    this.dbService = dbService;
    this.speechService = speechService;
    this.autoPlaybackManager = (typeof AutoPlaybackManager !== 'undefined')
      ? new AutoPlaybackManager(app, dbService, speechService, this)
      : null;

    // 自動一時停止のタイムアウト設定（ミリ秒、0は自動停止OFF）
    this.autoPauseTimeoutMs = this._loadAutoPauseTimeoutMs();
    // 直近セッションで最高ランク以外だった苦手項目リスト（即復習用）
    this.lastWeakItems = [];

    // セッション状態
    this.state = this._createInitialState();
  }

  /**
   * localStorageから自動一時停止秒数設定を読み込み（デフォルト60秒）
   */
  _loadAutoPauseTimeoutMs() {
    try {
      if (typeof localStorage !== 'undefined') {
        const saved = localStorage.getItem('ankiflow_auto_pause_sec');
        if (saved !== null && saved !== undefined && saved !== '') {
          if (saved === '0' || saved === 'off') return 0;
          const sec = parseInt(saved, 10);
          if (!isNaN(sec) && sec > 0) return sec * 1000;
        }
      }
    } catch (e) {}
    return StudySessionManager.AUTO_PAUSE_IDLE_MS;
  }

  /**
   * 自動一時停止までの秒数を変更・保存（0 または 'off' で無効化）
   */
  setAutoPauseTimeoutSec(sec) {
    let nextMs = StudySessionManager.AUTO_PAUSE_IDLE_MS;
    if (sec === 0 || sec === '0' || sec === 'off') {
      nextMs = 0;
    } else {
      const parsed = parseInt(sec, 10);
      if (!isNaN(parsed) && parsed > 0) {
        nextMs = parsed * 1000;
      }
    }
    this.autoPauseTimeoutMs = nextMs;
    const secStr = String(Math.round(nextMs / 1000));
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('ankiflow_auto_pause_sec', secStr);
      }
    } catch (e) {}

    // 画面上のセレクター表示を同期
    ['select-auto-pause-timeout', 'setup-auto-pause-select'].forEach(id => {
      const el = this.getEl(id);
      if (el && el.value !== secStr) {
        el.value = secStr;
      }
    });

    this.touchActivity();
    return nextMs;
  }

  /**
   * 現在の自動一時停止設定（秒数、0はOFF）を取得
   */
  getAutoPauseTimeoutSec() {
    const ms = (this.autoPauseTimeoutMs !== undefined && this.autoPauseTimeoutMs !== null)
      ? this.autoPauseTimeoutMs
      : StudySessionManager.AUTO_PAUSE_IDLE_MS;
    return Math.round(ms / 1000);
  }

  _createInitialState(overrides = {}) {
    const now = Date.now();
    return {
      isActive: false,
      mode: 'unmastered_first',
      options: {},
      queue: [],
      currentIndex: 0,
      isAnswerShown: false,
      isPaused: false,
      isSubmitting: false,
      accumulatedMs: 0,
      currentRunStart: now,
      lastActivityStart: now,
      timerInterval: null,
      elapsedMs: 0,
      results: [],
      ...overrides
    };
  }

  getEl(id) {
    if (typeof document === 'undefined') return null;
    return document.getElementById(id);
  }

  createEl(tag) {
    if (typeof document === 'undefined') return null;
    return document.createElement(tag);
  }

  setServices({ app, dbService, speechService }) {
    if (app) this.app = app;
    if (dbService) this.dbService = dbService;
    if (speechService) this.speechService = speechService;
    if (this.autoPlaybackManager) {
      this.autoPlaybackManager.setServices({ app, dbService, speechService, studySessionManager: this });
    }
  }

  /**
   * ユーザー操作時のアクティビティ時刻を更新（自動一時停止までの猶予60秒をリセット）
   */
  touchActivity() {
    if (this.state && this.state.isActive && !this.state.isPaused) {
      this.state.lastActivityStart = Date.now();
    }
  }

  /**
   * 学習セッションを開始
   * @param {string} mode - 'unmastered_first' | 'maintenance' | 'sequential' | 'all_shuffle' | 'auto_playback'
   * @param {number|string} limit - 出題件数 (0または'all'で全件)
   * @param {Object} options - { startId, endId, rankDefId, autoPlayTimer, autoPlayPromptInterval, autoPlayAnswerInterval, autoPlayBaseMode }
   */
  start(mode = 'unmastered_first', limit = 15, options = {}) {
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const currentScale = this.app ? this.app.currentScale : 'simple_3';

    if (!this.dbService) {
      console.error('[StudySessionManager] dbService not set');
      return;
    }

    const isAutoPlay = (mode === 'auto_playback');
    // 自動再生モードの場合は出題クエリモードを解決（指定の autoPlayOrder、未指定なら sequential）
    const queryMode = isAutoPlay
      ? (options.autoPlayOrder || options.autoPlayBaseMode || 'sequential')
      : mode;

    const queue = (options && Array.isArray(options.customQueue) && options.customQueue.length > 0)
      ? options.customQueue.map(item => ({ ...item }))
      : this.dbService.getStudyQueue(materialType, queryMode, currentScale, limit, options);
    if (!queue || queue.length === 0) {
      if (typeof alert !== 'undefined') alert('出題対象の項目がありません。ID範囲やランクの絞り込み条件を見直してください。');
      return;
    }

    // 自動再生モードの場合は専用マネージャーへ委譲
    if (isAutoPlay) {
      if (!this.autoPlaybackManager && typeof AutoPlaybackManager !== 'undefined') {
        this.autoPlaybackManager = new AutoPlaybackManager(this.app, this.dbService, this.speechService, this);
      }
      if (this.autoPlaybackManager) {
        return this.autoPlaybackManager.start(queue, options);
      }
    }

    // 通常のフラッシュカード学習セッション開始
    this.state = this._createInitialState({
      isActive: true,
      mode,
      options,
      queue
    });

    const setupArea = this.getEl('study-setup-area');
    const completeArea = this.getEl('study-complete-area');
    const activeArea = this.getEl('study-active-area');

    if (setupArea) setupArea.style.display = 'none';
    if (completeArea) completeArea.style.display = 'none';
    if (activeArea) activeArea.style.display = 'block';

    // 自動再生バーを非表示・通常コントロールを表示
    const autoPlayBar = this.getEl('auto-play-bar');
    const normalControls = this.getEl('normal-study-controls');
    if (autoPlayBar) autoPlayBar.style.display = 'none';
    if (normalControls) normalControls.style.display = 'flex';

    // 自動発音ラベルとタイマーの表示
    const labelAutoSpeak = this.getEl('label-auto-speak');
    if (labelAutoSpeak) labelAutoSpeak.style.display = 'inline-flex';

    const timerIndicator = typeof document !== 'undefined' ? document.querySelector('.timer-indicator') : null;
    if (timerIndicator) timerIndicator.style.display = 'inline-block';

    this.renderCurrentCard();
  }

  /**
   * 現在のカードをDOMに描画
   */
  renderCurrentCard() {
    const session = this.state;
    if (session.currentIndex >= session.queue.length) {
      if (session.isAutoPlay) {
        if (session.autoPlayTimerSetting === 'once') {
          this.finishAutoPlay('🎉 1周の自動再生が完了しました！');
          return;
        }
        session.currentIndex = 0;
        session.autoPlayLoopCount++;
      } else {
        this.finish();
        return;
      }
    }

    const currentItem = session.queue[session.currentIndex];
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const meta = this.dbService.getMaterialMetadata(materialType);

    // プログレス
    const progressText = this.getEl('study-progress-text');
    const progressFill = this.getEl('study-session-progress-fill');
    if (progressText) {
      const loopInfo = (session.isAutoPlay && session.autoPlayLoopCount > 1) ? ` [${session.autoPlayLoopCount}周目]` : '';
      progressText.textContent = `${session.currentIndex + 1} / ${session.queue.length}${loopInfo}`;
    }
    if (progressFill) progressFill.style.width = `${Math.round((session.currentIndex / session.queue.length) * 100)}%`;

    // 教材名バッジ + ID番号表示
    const materialLabel = this.getEl('card-material-label');
    if (materialLabel) {
      let labelText = meta ? meta.display_name : materialType;
      if (currentItem.item_id !== undefined && currentItem.item_id !== null) {
        labelText += ` [No.${currentItem.item_id}]`;
      }
      if (session.isAutoPlay) {
        labelText += ` 🎧 自動再生`;
      }
      materialLabel.textContent = labelText;
    }

    // 現在ランクバッジ（スケール切り替え時のマッピング表示に対応）
    const rankBadge = this.getEl('card-current-rank');
    if (rankBadge) {
      const displayLabel = currentItem.mapped_rank_label || currentItem.rank_label;
      const displayColor = currentItem.mapped_color_code || currentItem.color_code;
      if (currentItem.current_rank_def_id && displayLabel) {
        rankBadge.textContent = displayLabel;
        rankBadge.style.backgroundColor = displayColor + '20';
        rankBadge.style.color = displayColor;
      } else {
        rankBadge.textContent = '未学習';
        rankBadge.style.backgroundColor = '#f1f5f9';
        rankBadge.style.color = 'var(--text-muted)';
      }
    }

    // Undo（1つ前に戻る）ボタンの有効・無効状態を更新
    const btnUndo = this.getEl('btn-undo-study');
    if (btnUndo) {
      const canUndo = !session.isAutoPlay && Array.isArray(session.results) && session.results.length > 0;
      btnUndo.disabled = !canUndo;
      btnUndo.style.opacity = canUndo ? '1' : '0.45';
      btnUndo.style.cursor = canUndo ? 'pointer' : 'not-allowed';
    }

    // 問題・見出し
    const promptEl = this.getEl('card-prompt');
    if (promptEl) {
      promptEl.textContent = currentItem.display_prompt || '-';
    }

    // 補足・読み情報（動的生成）
    const hintsContainer = this.getEl('card-hints-row');
    if (hintsContainer && meta) {
      hintsContainer.innerHTML = '';
      const hintColsStr = meta.hint_columns || '';
      const hintCols = hintColsStr ? hintColsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

      hintCols.forEach(col => {
        const val = currentItem[col];
        if (val) {
          const box = this.createEl('div');
          if (box) {
            box.className = 'phonetic-box';
            box.innerHTML = `${this.escapeHtml(val)} <span style="font-size: 0.8rem; margin-left: 0.25rem;">🔊</span>`;
            box.title = `クリックで発音: ${val}`;
            box.addEventListener('click', (e) => {
              e.stopPropagation();
              this.touchActivity();
              if (this.speechService) this.speechService.speak(val, { lang: 'auto' });
            });
            hintsContainer.appendChild(box);
          }
        }
      });
    }

    // 正解・意味
    const answerEl = this.getEl('card-answer');
    if (answerEl) {
      answerEl.textContent = currentItem.display_answer || '-';
    }

    // ボタン・状態リセット
    session.isAnswerShown = false;
    session.isSubmitting = false;
    const btnShowAnswer = this.getEl('btn-show-answer');
    const answerArea = this.getEl('card-answer-area');
    const autoPlayStatusArea = this.getEl('auto-play-card-status-area');
    const cardEvalContainer = this.getEl('card-eval-container');

    if (session.isAutoPlay) {
      if (btnShowAnswer) btnShowAnswer.style.display = 'none';
      if (answerArea) answerArea.style.display = 'none';
      if (autoPlayStatusArea) autoPlayStatusArea.style.display = 'block';
      if (cardEvalContainer) cardEvalContainer.style.display = 'none';
    } else {
      if (btnShowAnswer) btnShowAnswer.style.display = 'inline-block';
      if (answerArea) answerArea.style.display = 'none';
      if (autoPlayStatusArea) autoPlayStatusArea.style.display = 'none';
      if (cardEvalContainer) cardEvalContainer.style.display = 'block';
      // 評価ボタン群の生成
      this.renderRankButtons();
    }

    // 自動発音が有効な通常モードの場合は問題文を読み上げ
    if (!session.isAutoPlay && this.speechService && this.speechService.isAutoSpeakEnabled) {
      setTimeout(() => this.speakCurrentPrompt(), 150);
    }

    // タイマー開始（通常モードのみ）
    if (!session.isAutoPlay) {
      this.startTimer();
    }
  }

  /**
   * 現在のカードの発話対象テキストと言語設定を解決
   * @param {'prompt'|'answer'} side
   * @returns {{ text: string, lang: string } | null}
   */
  resolveCurrentSpeechTarget(side = 'prompt') {
    const session = this.state;
    if (!session || !session.isActive || session.currentIndex >= session.queue.length) return null;
    const currentItem = session.queue[session.currentIndex];
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const meta = this.dbService ? this.dbService.getMaterialMetadata(materialType) : null;

    const isPrompt = (side === 'prompt');
    const speechCol = meta ? (isPrompt ? meta.prompt_speech_column : meta.answer_speech_column) : null;
    const fallbackText = isPrompt ? currentItem.display_prompt : currentItem.display_answer;
    const lang = meta ? ((isPrompt ? meta.prompt_lang : meta.answer_lang) || 'auto') : 'auto';

    const text = (speechCol && currentItem[speechCol] !== undefined && currentItem[speechCol] !== null && String(currentItem[speechCol]).trim() !== '')
      ? String(currentItem[speechCol]).trim()
      : fallbackText;

    if (!text) return null;
    return { text, lang };
  }

  /**
   * 現在の問題文を発音
   */
  speakCurrentPrompt() {
    this.touchActivity();
    const target = this.resolveCurrentSpeechTarget('prompt');
    if (target && this.speechService) {
      this.speechService.speak(target.text, { lang: target.lang });
    }
  }

  /**
   * 現在の回答文を発音
   */
  speakCurrentAnswer() {
    this.touchActivity();
    const target = this.resolveCurrentSpeechTarget('answer');
    if (target && this.speechService) {
      this.speechService.speak(target.text, { lang: target.lang });
    }
  }

  /**
   * 評価ボタン群の生成
   */
  renderRankButtons() {
    const container = this.getEl('rank-buttons-container');
    if (!container || !this.dbService) return;

    const currentScale = this.app ? this.app.currentScale : 'simple_3';
    const rankDefs = this.dbService.getRankDefinitions(currentScale);
    container.innerHTML = '';

    rankDefs.forEach((def, index) => {
      const btn = this.createEl('button');
      if (!btn) return;
      btn.className = 'btn rank-btn';
      btn.style.borderColor = def.color_code;
      btn.style.color = def.color_code;
      btn.innerHTML = `
        <span>[${index + 1}] ${def.rank_label}</span>
        <span class="rank-btn-interval">間隔: +${def.default_interval_days}日</span>
      `;

      btn.addEventListener('click', () => {
        this.submitAssessment(def.rank_def_id);
      });

      container.appendChild(btn);
    });
  }

  /**
   * 答えを表示
   * @param {boolean} triggerAutoSpeak - 自動発音をトリガーするか
   */
  revealAnswer(triggerAutoSpeak = true) {
    this.touchActivity();
    this.state.isAnswerShown = true;
    const btnShowAnswer = this.getEl('btn-show-answer');
    const answerArea = this.getEl('card-answer-area');
    if (btnShowAnswer) btnShowAnswer.style.display = 'none';
    if (answerArea) answerArea.style.display = 'block';

    // 自動発音（通常学習モードのみ。自動連続再生時はシーケンス制御側で読み上げる）
    if (triggerAutoSpeak && !this.state.isAutoPlay && this.speechService && this.speechService.isAutoSpeakEnabled) {
      setTimeout(() => this.speakCurrentAnswer(), 150);
    }
  }

  // ==========================================
  // 自動連続再生（AutoPlaybackManagerへの委譲プロキシ）
  // ==========================================
  get autoPlayback() {
    return this.autoPlaybackManager;
  }

  startAutoPlay() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.runAutoPlayCycle();
  }

  startAutoPlayTimer() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.startAutoPlayTimer();
  }

  stopAutoPlayTimer() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.stopAutoPlayTimer();
  }

  updateAutoPlayTimerDisplay() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.updateAutoPlayTimerDisplay();
  }

  runAutoPlayCycle() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.runAutoPlayCycle();
  }

  advanceAutoPlay(token) {
    if (this.autoPlaybackManager) this.autoPlaybackManager.advanceAutoPlay(token);
  }

  isAutoPlayAborted(token) {
    return this.autoPlaybackManager ? this.autoPlaybackManager.isAutoPlayAborted(token) : true;
  }

  sleepAsync(ms, token) {
    return this.autoPlaybackManager ? this.autoPlaybackManager.sleepAsync(ms, token) : Promise.resolve();
  }

  speakCurrentPromptAsync() {
    return this.autoPlaybackManager ? this.autoPlaybackManager.speakCurrentPromptAsync() : Promise.resolve();
  }

  speakCurrentAnswerAsync() {
    return this.autoPlaybackManager ? this.autoPlaybackManager.speakCurrentAnswerAsync() : Promise.resolve();
  }

  setAutoPlayCardStatus(msg) {
    if (this.autoPlaybackManager) this.autoPlaybackManager.setAutoPlayCardStatus(msg);
  }

  stopCurrentSpeechAndTimer() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.stopCurrentSpeechAndTimer();
  }

  skipNextAutoPlay() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.skipNext();
  }

  skipPrevAutoPlay() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.skipPrev();
  }

  toggleAutoPlayPause() {
    if (this.autoPlaybackManager) this.autoPlaybackManager.togglePause();
  }

  finishAutoPlay(msg) {
    if (this.autoPlaybackManager) this.autoPlaybackManager.finish(msg);
  }

  // ==========================================
  // タイマー制御・放置ガード（自動一時停止と再開）
  // ==========================================

  /**
   * インターバル監視ループの内部起動（startTimer / resume 共通）
   */
  _startTimerLoop() {
    this.stopTimer();
    const session = this.state;
    if (session.isAutoPlay) return;

    const timerEl = this.getEl('card-timer');

    session.timerInterval = setInterval(() => {
      if (session.isPaused || !session.isActive) return;

      const now = Date.now();
      const currentRun = now - session.currentRunStart;
      const totalElapsed = session.accumulatedMs + currentRun;
      session.elapsedMs = totalElapsed;

      if (timerEl) {
        timerEl.textContent = (totalElapsed / 1000).toFixed(1) + 's';
      }

      // 最後の操作または再開から設定秒数経過で自動一時停止（通常学習時の放置ガード、0の場合はOFF）
      const timeoutMs = (this.autoPauseTimeoutMs !== undefined && this.autoPauseTimeoutMs !== null)
        ? this.autoPauseTimeoutMs
        : StudySessionManager.AUTO_PAUSE_IDLE_MS;
      const idleBase = session.lastActivityStart || session.currentRunStart;
      const idleElapsed = now - idleBase;
      if (!session.isAutoPlay && timeoutMs > 0 && idleElapsed >= timeoutMs) {
        this.pause(true);
      }
    }, StudySessionManager.TIMER_TICK_MS);
  }

  /**
   * 新しいカード用のタイマー開始
   */
  startTimer() {
    this.stopTimer();
    const session = this.state;
    // 自動連続再生モード中は通常タイマー（および放置ガード）を動かさない
    if (session.isAutoPlay) return;

    const now = Date.now();
    session.isPaused = false;
    session.accumulatedMs = 0;
    session.currentRunStart = now;
    session.lastActivityStart = now;
    session.elapsedMs = 0;

    const overlay = this.getEl('study-pause-overlay');
    if (overlay) overlay.style.display = 'none';

    const pauseBtn = this.getEl('btn-pause-study');
    if (pauseBtn) pauseBtn.textContent = '⏸️ 一時停止';

    const timerEl = this.getEl('card-timer');
    if (timerEl) timerEl.textContent = '0.0s';

    this._startTimerLoop();
  }

  /**
   * タイマー停止
   */
  stopTimer() {
    if (this.state.timerInterval) {
      clearInterval(this.state.timerInterval);
      this.state.timerInterval = null;
    }
  }

  /**
   * 学習タイマーの一時停止
   * @param {boolean} isAuto - 60秒無操作・タブ非表示等による自動停止か
   */
  pause(isAuto = false) {
    const session = this.state;
    if (!session.isActive || session.isPaused) return;

    // 自動再生モード中、自動一時停止（60秒無操作・非アクティブ検知）は無効化（睡眠学習・耳学習のため）
    if (isAuto && session.isAutoPlay) {
      return;
    }

    const now = Date.now();
    session.accumulatedMs += Math.max(0, now - session.currentRunStart);
    session.elapsedMs = session.accumulatedMs;
    session.isPaused = true;
    this.stopTimer();

    // 自動再生中の手動一時停止なら、AutoPlaybackManagerの一時停止も同期
    if (session.isAutoPlay && this.autoPlaybackManager) {
      this.autoPlaybackManager.pause();
    }

    const overlay = this.getEl('study-pause-overlay');
    if (overlay) {
      overlay.style.display = 'flex';
      const titleEl = overlay.querySelector('h3');
      const descEl = overlay.querySelector('p');
      if (titleEl && descEl) {
        if (isAuto) {
          const timeoutSec = Math.max(1, Math.round(((this.autoPauseTimeoutMs !== undefined && this.autoPauseTimeoutMs !== null && this.autoPauseTimeoutMs > 0) ? this.autoPauseTimeoutMs : StudySessionManager.AUTO_PAUSE_IDLE_MS) / 1000));
          titleEl.textContent = '⏱️ 自動一時停止中';
          descEl.innerHTML = `${timeoutSec}秒間操作がなかったため、タイマーを自動停止しました。<br>準備ができたら「学習を再開する」を押してください。`;
        } else {
          titleEl.textContent = '☕ 一時停止中（休憩）';
          descEl.innerHTML = '回答時間のカウントを一時停止しています。<br>落ち着いて準備ができたら再開してください。';
        }
      }
    }

    const pauseBtn = this.getEl('btn-pause-study');
    if (pauseBtn) pauseBtn.textContent = '▶️ 再開';
  }

  /**
   * 学習タイマーの再開
   */
  resume() {
    const session = this.state;
    if (!session.isActive || !session.isPaused) return;

    const now = Date.now();
    session.isPaused = false;
    session.currentRunStart = now;
    // 再開時点から新たに60秒間の無操作猶予を付与（再開直後に即再停止するのを防止）
    session.lastActivityStart = now;

    const overlay = this.getEl('study-pause-overlay');
    if (overlay) overlay.style.display = 'none';

    // 自動再生モード中の再開はAutoPlaybackManagerに委譲
    if (session.isAutoPlay) {
      if (this.autoPlaybackManager) {
        this.autoPlaybackManager.resume();
      }
      return;
    }

    const pauseBtn = this.getEl('btn-pause-study');
    if (pauseBtn) pauseBtn.textContent = '⏸️ 一時停止';

    this._startTimerLoop();
  }

  /**
   * 一時停止・再開の切り替え
   */
  togglePause() {
    if (!this.state.isActive) return;
    if (this.state.isPaused) {
      this.resume();
    } else {
      this.pause(false);
    }
  }

  /**
   * 学習セッションを途中で終了
   */
  quit() {
    const session = this.state;
    if (!session.isActive) return;

    this.pause(false);

    const answeredCount = session.results.length;
    const msg = answeredCount > 0
      ? `ここまでの学習結果（${answeredCount} 件）を記録して、学習セッションを終了しますか？`
      : 'まだ1件も回答していません。学習を中止して戻りますか？';

    if (typeof confirm === 'undefined' || confirm(msg)) {
      this.finish();
    } else {
      this.resume();
    }
  }

  /**
   * ランク評価を確定して記録・次問遷移
   */
  async submitAssessment(rankDefId) {
    const session = this.state;
    if (!session.isActive || session.isSubmitting) return;
    session.isSubmitting = true;

    this.stopTimer();
    const currentItem = session.queue[session.currentIndex];
    const materialType = this.app ? this.app.materialType : 'chinese_top50';

    // 経過ミリ秒（累積＋今回）
    const timeSpentRaw = session.accumulatedMs + (session.isPaused ? 0 : Math.max(0, Date.now() - session.currentRunStart));
    // 異常値防止サニティキャップ: 最低0.2秒、最大60秒
    const timeSpent = Math.min(
      Math.max(timeSpentRaw, StudySessionManager.MIN_SANITY_TIME_MS),
      StudySessionManager.MAX_SANITY_TIME_MS
    );

    const prevItemSnapshot = {
      current_rank_def_id: currentItem.current_rank_def_id,
      rank_label: currentItem.rank_label,
      color_code: currentItem.color_code,
      mapped_rank_def_id: currentItem.mapped_rank_def_id,
      mapped_rank_level: currentItem.mapped_rank_level,
      mapped_rank_label: currentItem.mapped_rank_label,
      mapped_color_code: currentItem.mapped_color_code,
      total_attempts: currentItem.total_attempts
    };

    try {
      const res = await this.dbService.recordStudyResult({
        materialType,
        materialItemId: currentItem.item_id,
        assessedRankDefId: rankDefId,
        timeSpentMs: timeSpent
      });

      session.results.push({
        item: currentItem,
        rankDefId,
        timeSpent,
        res,
        prevItemSnapshot
      });

      session.currentIndex++;
      session.isSubmitting = false;
      if (this.app && typeof this.app.updateFileSyncUI === 'function') {
        this.app.updateFileSyncUI();
      }
      this.renderCurrentCard();
    } catch (err) {
      session.isSubmitting = false;
      console.error('[StudySessionManager] Error saving study log:', err);
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast('学習データの保存に失敗しました: ' + err.message, 'danger');
      }
    }
  }

  /**
   * 直前のランク評価を取り消して1つ前の問題に戻る（Undo機能）
   */
  async undoLastAssessment() {
    const session = this.state;
    if (!session || !session.isActive || session.isAutoPlay || session.isSubmitting) return false;
    if (!Array.isArray(session.results) || session.results.length === 0) return false;

    session.isSubmitting = true;
    this.stopTimer();

    try {
      const lastResult = session.results.pop();
      if (lastResult && lastResult.res && lastResult.res.undoSnapshot && this.dbService && typeof this.dbService.undoStudyResult === 'function') {
        await this.dbService.undoStudyResult(lastResult.res.undoSnapshot);
      }

      session.currentIndex = Math.max(0, session.currentIndex - 1);
      if (lastResult && lastResult.prevItemSnapshot && session.queue[session.currentIndex]) {
        Object.assign(session.queue[session.currentIndex], lastResult.prevItemSnapshot);
      }

      session.isSubmitting = false;
      if (this.app) {
        if (typeof this.app.updateFileSyncUI === 'function') {
          this.app.updateFileSyncUI();
        }
        if (typeof this.app.showToast === 'function') {
          this.app.showToast('↩️ 直前の評価を取り消して前の問題に戻りました', 'info');
        }
      }

      this.renderCurrentCard();
      return true;
    } catch (err) {
      session.isSubmitting = false;
      console.error('[StudySessionManager] Error undoing study result:', err);
      return false;
    }
  }

  /**
   * 直近の完了セッションで最高ランク（「完璧」等）以外だった項目だけを再テスト開始
   */
  startRetryWeakSession() {
    if (!this.lastWeakItems || this.lastWeakItems.length === 0) return false;
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const currentScale = this.app ? this.app.currentScale : 'simple_3';

    let refreshedQueue = this.lastWeakItems.map(item => ({ ...item }));
    if (this.dbService && typeof this.dbService.getItemsWithProgress === 'function') {
      try {
        const latestItems = this.dbService.getItemsWithProgress(materialType, {}, currentScale);
        if (Array.isArray(latestItems) && latestItems.length > 0) {
          const itemMap = new Map(latestItems.map(it => [String(it.item_id), it]));
          refreshedQueue = this.lastWeakItems.map(oldItem => {
            const latest = itemMap.get(String(oldItem.item_id));
            return latest ? { ...latest } : { ...oldItem };
          });
        }
      } catch (e) {}
    }

    this.start('unmastered_first', 'all', { customQueue: refreshedQueue });
    if (this.app && typeof this.app.showToast === 'function') {
      this.app.showToast(`🔥 覚えきれなかった ${refreshedQueue.length} 件の再テストを開始しました！`, 'info');
    }
    return true;
  }

  /**
   * セッション完了
   */
  finish() {
    this.stopTimer();
    this.state.isActive = false;
    this.state.isSubmitting = false;

    const overlay = this.getEl('study-pause-overlay');
    if (overlay) overlay.style.display = 'none';

    const activeArea = this.getEl('study-active-area');
    if (activeArea) activeArea.style.display = 'none';

    const labelAutoSpeak = this.getEl('label-auto-speak');
    if (labelAutoSpeak) labelAutoSpeak.style.display = 'inline-flex';

    const timerIndicator = typeof document !== 'undefined' ? document.querySelector('.timer-indicator') : null;
    if (timerIndicator) timerIndicator.style.display = 'inline-block';

    const results = this.state.results;
    const totalCount = results.length;

    if (totalCount === 0) {
      const setupArea = this.getEl('study-setup-area');
      if (setupArea) setupArea.style.display = 'block';
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast('学習セッションを中止しました。', 'info');
      }
      this.refreshSetupForm();
      return;
    }

    const completeArea = this.getEl('study-complete-area');
    if (completeArea) completeArea.style.display = 'block';

    const totalTime = results.reduce((acc, r) => acc + r.timeSpent, 0);
    const avgTime = (totalTime / totalCount / 1000).toFixed(1);

    const countEl = this.getEl('summary-total-count');
    const timeEl = this.getEl('summary-avg-time');
    if (countEl) countEl.textContent = totalCount;
    if (timeEl) timeEl.textContent = avgTime + 's';

    // 今回の評価内訳集計 & 最高ランク以外の苦手項目抽出（即復習用）
    this._updateSessionCompleteBreakdown(results);

    // 学習セッション完了時にセットアップ画面のランク別件数・ピル表示を最新DBデータへ更新
    this.refreshSetupForm();

    if (this.app) {
      if (typeof this.app.renderDashboard === 'function') {
        this.app.renderDashboard();
      }
      if (typeof this.app.showToast === 'function') {
        this.app.showToast(`学習セッション完了（${totalCount}件完了）！`, 'success');
      }
    }
  }

  /**
   * セッション完了画面の評価ランク別内訳と「今回『完璧』以外だった項目だけ即復習」ボタンを更新
   */
  _updateSessionCompleteBreakdown(results = []) {
    const currentScale = this.app ? this.app.currentScale : 'simple_3';
    const rankDefs = (this.dbService && typeof this.dbService.getRankDefinitions === 'function')
      ? this.dbService.getRankDefinitions(currentScale)
      : [];
    const maxLevel = rankDefs.length > 0 ? rankDefs[rankDefs.length - 1].rank_level : 3;

    const defById = new Map();
    const countByDefId = new Map();
    rankDefs.forEach(d => {
      defById.set(String(d.rank_def_id), d);
      countByDefId.set(String(d.rank_def_id), 0);
    });

    // 各アイテムの最終評価を追跡（同一セッション内の重複対策）
    const latestResultByItemId = new Map();
    results.forEach((r, idx) => {
      const defIdStr = String(r.rankDefId);
      let def = defById.get(defIdStr);
      if (!def && this.dbService && typeof this.dbService.mapRankDefToScale === 'function') {
        def = this.dbService.mapRankDefToScale(r.rankDefId, currentScale);
      }
      if (def) {
        const key = String(def.rank_def_id);
        countByDefId.set(key, (countByDefId.get(key) || 0) + 1);
      }
      const itemKey = (r.item && r.item.item_id !== undefined) ? String(r.item.item_id) : `idx_${idx}`;
      latestResultByItemId.set(itemKey, { item: r.item, rankDefId: r.rankDefId, def });
    });

    const weakItems = [];
    latestResultByItemId.forEach(({ item, rankDefId, def }) => {
      if (!item) return;
      let isMastered = false;
      if (def) {
        isMastered = (def.rank_level === maxLevel);
      } else {
        isMastered = (String(rankDefId) === '3' || String(rankDefId) === '8');
      }
      if (!isMastered) {
        weakItems.push(item);
      }
    });

    this.lastWeakItems = weakItems;

    // 1. 内訳バッジ群の描画
    const breakdownEl = this.getEl('summary-rank-breakdown');
    if (breakdownEl) {
      if (rankDefs.length > 0) {
        const badgesHtml = rankDefs.map(d => {
          const c = countByDefId.get(String(d.rank_def_id)) || 0;
          return `<span class="summary-rank-badge" style="display: inline-flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.75rem; border-radius: 999px; font-size: 0.85rem; font-weight: 700; background-color: ${d.color_code}18; color: ${d.color_code}; border: 1px solid ${d.color_code}40;">
            <span>${this.escapeHtml(d.rank_label)}</span>
            <strong style="background: ${d.color_code}; color: #fff; padding: 0.05rem 0.45rem; border-radius: 999px; font-size: 0.8rem;">${c}件</strong>
          </span>`;
        }).join('');
        const perfectNote = weakItems.length === 0
          ? `<div style="margin-top: 0.6rem; font-size: 0.88rem; color: var(--success); font-weight: 700;">✨ 全問最高ランク達成！パーフェクトです！</div>`
          : '';
        breakdownEl.innerHTML = `<div style="display: flex; justify-content: center; gap: 0.6rem; flex-wrap: wrap;">${badgesHtml}</div>${perfectNote}`;
        breakdownEl.style.display = 'block';
      } else {
        breakdownEl.style.display = 'none';
      }
    }

    // 2. 「今回覚えきれなかったN件を今すぐ再テスト」ボタンの表示制御
    const retryBtn = this.getEl('btn-retry-weak-study');
    if (retryBtn) {
      if (weakItems.length > 0) {
        retryBtn.style.display = 'inline-flex';
        retryBtn.innerHTML = `🔥 今回覚えきれなかった ${weakItems.length} 件を今すぐ再テスト`;
      } else {
        retryBtn.style.display = 'none';
      }
    }
  }

  /**
   * キーボードショートカットの登録
   */
  initKeyboardShortcuts() {
    if (typeof window === 'undefined') return;

    window.addEventListener('keydown', (e) => {
      if (!this.state.isActive) return;
      if (typeof document !== 'undefined' && document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;

      // 自動連続再生中のショートカット
      if (this.state.isAutoPlay) {
        if (e.code === 'Space' || (e.key && e.key.toLowerCase() === 'p')) {
          e.preventDefault();
          this.toggleAutoPlayPause();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          this.finishAutoPlay('自動連続再生を停止しました。');
        } else if (e.key === 'ArrowRight') {
          e.preventDefault();
          this.skipNextAutoPlay();
        } else if (e.key === 'ArrowLeft') {
          e.preventDefault();
          this.skipPrevAutoPlay();
        }
        return;
      }

      // 通常学習モードのショートカット
      if (e.code === 'Space') {
        e.preventDefault();
        if (this.state.isPaused) {
          this.resume();
        } else if (!this.state.isAnswerShown) {
          this.revealAnswer();
        }
      } else if (e.key && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        this.togglePause();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.quit();
      } else if (e.key && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        this.speakCurrentPrompt();
      } else if (!this.state.isPaused && (e.key === 'Backspace' || (e.key && e.key.toLowerCase() === 'z'))) {
        e.preventDefault();
        this.undoLastAssessment();
      } else if (this.state.isAnswerShown && !this.state.isPaused && e.key >= '1' && e.key <= '5') {
        const keyNum = parseInt(e.key, 10);
        const currentScale = this.app ? this.app.currentScale : 'simple_3';
        const rankDefs = this.dbService ? this.dbService.getRankDefinitions(currentScale) : [];
        const targetDef = rankDefs.find(d => d.rank_level === keyNum) || rankDefs[keyNum - 1];
        if (targetDef) {
          e.preventDefault();
          this.submitAssessment(targetDef.rank_def_id);
        }
      }
    });
  }

  // ==========================================
  // 学習画面セットアップUI制御（出題範囲・ランク分布・プレビュー更新）
  // ==========================================

  /**
   * 学習タブのセットアップフォーム（ID範囲案内・ランク選択肢・件数プレビュー）を初期化・更新
   */
  refreshSetupForm() {
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    if (!this.dbService || !materialType) return;

    // 1. ID範囲ヒントの更新
    const rangeHint = this.getEl('study-id-range-hint');
    const startInput = this.getEl('study-range-start');
    const endInput = this.getEl('study-range-end');
    const idRange = this.dbService.getMaterialIdRange(materialType);

    if (rangeHint) {
      rangeHint.textContent = `全体範囲: ${idRange.minId} 〜 ${idRange.maxId} (全${idRange.totalCount}件)`;
    }
    if (startInput && !startInput.value) {
      startInput.placeholder = `開始ID (最小: ${idRange.minId})`;
    }
    if (endInput && !endInput.value) {
      endInput.placeholder = `終了ID (最大: ${idRange.maxId})`;
    }

    // 2. ランク選択肢の更新 & クイック選択ピル描画（出題範囲内のランク分布と連動）
    this.updateRankFilterOptions();

    // 3. リアルタイム件数プレビューの更新
    this.updateQueuePreview();

    // 4. 自動再生パネルの表示状態整合 & 自動一時停止セレクター同期
    const modeSelect = this.getEl('study-mode-select');
    const autoSettings = this.getEl('auto-play-settings-panel');
    if (modeSelect && autoSettings) {
      autoSettings.style.display = modeSelect.value === 'auto_playback' ? 'block' : 'none';
    }
    const currentTimeoutSecStr = String(this.getAutoPauseTimeoutSec());
    ['select-auto-pause-timeout', 'setup-auto-pause-select'].forEach(id => {
      const el = this.getEl(id);
      if (el) el.value = currentTimeoutSecStr;
    });
  }

  /**
   * 現在のID範囲条件に基づいて、定着ランク選択肢の件数表示およびクイック選択ピル群を更新
   */
  updateRankFilterOptions() {
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const currentScale = this.app ? this.app.currentScale : 'simple_3';
    const rankSelect = this.getEl('study-rank-filter');
    const pillsContainer = this.getEl('study-rank-pills');
    const hintSpan = this.getEl('study-range-status-hint');
    if (!this.dbService || !materialType) return;

    const startInput = this.getEl('study-range-start');
    const endInput = this.getEl('study-range-end');
    const startId = startInput && startInput.value.trim() ? parseInt(startInput.value.trim(), 10) : null;
    const endId = endInput && endInput.value.trim() ? parseInt(endInput.value.trim(), 10) : null;

    // 範囲指定があるかどうかのテキスト案内
    if (hintSpan) {
      if (startId !== null || endId !== null) {
        hintSpan.textContent = `ID: ${startId || '最小'}〜${endId || '最大'} 内の集計`;
        hintSpan.style.color = 'var(--primary)';
        hintSpan.style.fontWeight = '600';
      } else {
        hintSpan.textContent = '全体範囲内の集計';
        hintSpan.style.color = 'var(--text-muted)';
        hintSpan.style.fontWeight = 'normal';
      }
    }

    // 範囲内のランク分布を取得
    const dist = typeof this.dbService.getRankDistributionByRange === 'function'
      ? this.dbService.getRankDistributionByRange(materialType, currentScale, { startId, endId })
      : { total: 0, unstudied: 0, byRankDefId: {} };

    const rankDefs = this.dbService.getRankDefinitions ? this.dbService.getRankDefinitions(currentScale) : [];
    const currentVal = rankSelect ? rankSelect.value : '';

    // 1. セレクトボックス内の option 更新
    if (rankSelect) {
      rankSelect.innerHTML = '';

      const optAll = document.createElement('option');
      optAll.value = '';
      optAll.textContent = `すべてのランク（限定しない） (${dist.total}件)`;
      rankSelect.appendChild(optAll);

      const optUnstudied = document.createElement('option');
      optUnstudied.value = 'unstudied';
      optUnstudied.textContent = `未学習のみ (${dist.unstudied}件)`;
      rankSelect.appendChild(optUnstudied);

      rankDefs.forEach(d => {
        const count = dist.byRankDefId[d.rank_def_id] || 0;
        const opt = document.createElement('option');
        opt.value = String(d.rank_def_id);
        opt.textContent = `[Lv${d.rank_level}] ${d.rank_label} (${count}件)`;
        rankSelect.appendChild(opt);
      });

      // 以前の選択状態を復元（存在すれば）
      if (currentVal !== undefined && currentVal !== null) {
        rankSelect.value = currentVal;
      }
    }

    // 2. クイック選択ピル群の描画
    if (pillsContainer) {
      pillsContainer.innerHTML = '';

      // 「すべて」ピル
      const pillAll = this.createRankPill({
        label: 'すべて',
        count: dist.total,
        value: '',
        color: '#64748b',
        isSelected: currentVal === ''
      });
      pillsContainer.appendChild(pillAll);

      // 「未学習」ピル
      const pillUnstudied = this.createRankPill({
        label: '未学習',
        count: dist.unstudied,
        value: 'unstudied',
        color: '#94a3b8',
        isSelected: currentVal === 'unstudied'
      });
      pillsContainer.appendChild(pillUnstudied);

      // 各ランクピル
      rankDefs.forEach(d => {
        const count = dist.byRankDefId[d.rank_def_id] || 0;
        const pill = this.createRankPill({
          label: `Lv${d.rank_level} ${d.rank_label}`,
          count: count,
          value: String(d.rank_def_id),
          color: d.color_code || '#3b82f6',
          isSelected: currentVal === String(d.rank_def_id)
        });
        pillsContainer.appendChild(pill);
      });
    }
  }

  /**
   * ランク選択ピルDOM要素の作成ヘルパー
   */
  createRankPill({ label, count, value, color, isSelected }) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'rank-pill-badge';

    const isZero = count === 0;
    pill.style.display = 'inline-flex';
    pill.style.alignItems = 'center';
    pill.style.gap = '0.35rem';
    pill.style.padding = '0.25rem 0.6rem';
    pill.style.borderRadius = '20px';
    pill.style.fontSize = '0.78rem';
    pill.style.fontWeight = '600';
    pill.style.cursor = 'pointer';
    pill.style.transition = 'all 0.15s ease';
    pill.style.border = isSelected ? `2px solid ${color}` : '1px solid #cbd5e1';
    pill.style.backgroundColor = isSelected ? `${color}20` : (isZero ? '#f8fafc' : '#ffffff');
    pill.style.color = isZero ? '#94a3b8' : (isSelected ? color : '#334155');
    if (isZero) {
      pill.style.opacity = '0.65';
    }

    pill.innerHTML = `<span>${label}</span> <strong style="background: ${isZero ? '#e2e8f0' : color + '25'}; color: ${isZero ? '#64748b' : color}; padding: 0.1rem 0.4rem; border-radius: 10px; font-size: 0.75rem;">${count}</strong>`;

    pill.addEventListener('click', () => {
      const rankSelect = this.getEl('study-rank-filter');
      if (rankSelect) {
        rankSelect.value = value;
        this.updateRankFilterOptions();
        this.updateQueuePreview();
      }
    });

    return pill;
  }

  /**
   * 現在のフォーム入力値から対象項目数をカウントしバッジを更新
   */
  updateQueuePreview() {
    const materialType = this.app ? this.app.materialType : 'chinese_top50';
    const currentScale = this.app ? this.app.currentScale : 'simple_3';
    const badge = this.getEl('study-target-count-badge');
    if (!badge || !this.dbService || !materialType) return;

    const modeSelect = this.getEl('study-mode-select');
    const startInput = this.getEl('study-range-start');
    const endInput = this.getEl('study-range-end');
    const rankSelect = this.getEl('study-rank-filter');

    const mode = modeSelect ? modeSelect.value : 'unmastered_first';
    const startId = startInput && startInput.value.trim() ? parseInt(startInput.value.trim(), 10) : null;
    const endId = endInput && endInput.value.trim() ? parseInt(endInput.value.trim(), 10) : null;
    const rankDefId = rankSelect && rankSelect.value ? rankSelect.value : null;

    if (typeof this.dbService.getStudyQueueCount === 'function') {
      const count = this.dbService.getStudyQueueCount(materialType, mode, currentScale, {
        startId,
        endId,
        rankDefId
      });

      badge.textContent = `🎯 対象項目: ${count}件`;
      if (count === 0) {
        badge.className = 'sync-badge sync-warning';
      } else {
        badge.className = 'sync-badge sync-primary';
      }
    }
  }

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
}

if (typeof window !== 'undefined') {
  window.StudySessionManager = StudySessionManager;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StudySessionManager;
}
