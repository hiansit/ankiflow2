/**
 * 汎用記憶定着・項目別ランク学習管理システム
 * メインアプリケーション・オーケストレーター
 * 
 * 責務:
 * 1. サブシステム（FileSyncService, StudySessionManager, MaterialManager, UIViews, SpeechService, DBService）の初期化と協調
 * 2. アプリケーション共通状態（教材選択、ランク尺度選択、タブ遷移）の管理
 * 3. グローバルイベントのディスパッチとトースト通知
 */

class App {
  constructor() {
    this.dbService = new DBService();
    this.speechService = new SpeechService();
    this.fileSyncService = this.dbService.fileSync || (typeof FileSyncService !== 'undefined' ? new FileSyncService(this.dbService) : null);
    this.studySessionManager = typeof StudySessionManager !== 'undefined' ? new StudySessionManager(this, this.dbService, this.speechService) : null;
    this.materialManager = typeof MaterialManager !== 'undefined' ? new MaterialManager(this, this.dbService) : null;
    this.uiViews = typeof UIViews !== 'undefined' ? new UIViews(this, this.dbService, this.speechService) : null;

    this.currentScale = 'simple_3';
    this.materialType = 'chinese_top50';
    
    // 下位互換プロパティ（StudySessionManagerへの委譲互換）
    this._studySession = {
      isActive: false,
      mode: 'unmastered_first',
      queue: [],
      currentIndex: 0,
      isAnswerShown: false,
      isPaused: false,
      accumulatedMs: 0,
      currentRunStart: 0,
      timerInterval: null,
      elapsedMs: 0,
      results: []
    };

    // 下位互換プロパティ（MaterialManagerへの委譲互換）
    this._importData = {
      file: null,
      csvText: '',
      headers: [],
      rows: []
    };

    // ファイルピッカー多重起動防止フラグ
    this.isPickerRunning = false;
  }

  get studySession() {
    return this.studySessionManager ? this.studySessionManager.state : this._studySession;
  }
  set studySession(val) {
    if (this.studySessionManager) {
      this.studySessionManager.state = val;
    }
    this._studySession = val;
  }

  get importData() {
    return this.materialManager ? this.materialManager.importData : this._importData;
  }
  set importData(val) {
    if (this.materialManager) {
      this.materialManager.importData = val;
    }
    this._importData = val;
  }

  /**
   * アプリケーションの初期化
   */
  async init() {
    // 1. UIイベントリスナーを最優先で初期化（ボタン操作が即座に反応するように）
    this.initEvents();
    this.initKeyboardShortcuts();
    this.initModalEvents();

    // 2. ウェルカム画面を表示してファイル選択を待機
    const welcomeEl = document.getElementById('welcome-overlay');
    if (welcomeEl) {
      welcomeEl.style.display = 'flex';
    }

    try {
      // 3. Wasm・音声エンジンの非同期初期化
      await this.dbService.init('lib/sql-wasm.wasm');
      await this.speechService.init();
      this.updateFileSyncUI();
    } catch (err) {
      console.error('Initialization error:', err);
      this.showToast('初期化に失敗しました: ' + err.message, 'danger');
    }
  }

  /**
   * イベントリスナーの登録（機能別に構造化）
   */
  initEvents() {
    this.initNavigationEvents();
    this.initWelcomeAndFileEvents();
    this.initStudyControlEvents();
    this.initTableFilterEvents();
  }

  /**
   * 画面ナビゲーション・教材セレクター関連イベント
   */
  initNavigationEvents() {
    // タブ切り替え
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetId = btn.getAttribute('data-tab');
        this.switchTab(targetId);
      });
    });

    // 教材セレクター切り替え
    const materialSelect = document.getElementById('material-select');
    if (materialSelect) {
      materialSelect.addEventListener('change', async (e) => {
        this.materialType = e.target.value;
        await this.onMaterialChanged();
      });
    }

    // スケールセレクター切り替え
    const scaleSelect = document.getElementById('scale-select');
    if (scaleSelect) {
      scaleSelect.addEventListener('change', async (e) => {
        this.currentScale = e.target.value;
        await this.renderDashboard();
        if (this.isTabActive('tab-materials')) {
          await this.renderMaterialsTable();
        }
        this.refreshStudySetupForm();
      });
    }
  }

  /**
   * ウェルカム画面・ファイル連携・DB管理関連イベント
   */
  initWelcomeAndFileEvents() {
    // ウェルカム画面のボタン
    const btnWelcomeOpen = document.getElementById('btn-welcome-open');
    if (btnWelcomeOpen) {
      btnWelcomeOpen.addEventListener('click', () => this.openLocalFilePicker());
    }

    const btnWelcomeCreate = document.getElementById('btn-welcome-create');
    if (btnWelcomeCreate) {
      btnWelcomeCreate.addEventListener('click', () => this.createNewDatabasePicker());
    }

    const btnWelcomeDemo = document.getElementById('btn-welcome-demo');
    if (btnWelcomeDemo) {
      btnWelcomeDemo.addEventListener('click', (e) => {
        e.preventDefault();
        this.startDemoDatabase();
      });
    }

    // 実ファイル連携バーのボタン
    const btnFileOpen = document.getElementById('btn-file-open');
    if (btnFileOpen) {
      btnFileOpen.addEventListener('click', () => this.openLocalFilePicker());
    }

    const btnFileSaveAs = document.getElementById('btn-file-save-as');
    if (btnFileSaveAs) {
      btnFileSaveAs.addEventListener('click', () => this.saveAsLocalFilePicker());
    }

    // DB管理: エクスポート・インポート
    const btnExport = document.getElementById('btn-export-db');
    if (btnExport) {
      btnExport.addEventListener('click', () => this.exportDatabaseFile());
    }

    const inputImport = document.getElementById('input-import-db');
    if (inputImport) {
      inputImport.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importDatabaseFile(file);
          inputImport.value = '';
        }
      });
    }

    const inputDirect = document.getElementById('input-direct-file-open');
    if (inputDirect) {
      inputDirect.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importDatabaseFile(file);
          inputDirect.value = '';
        }
      });
    }

    // 教材パック復元
    const inputImportPack = document.getElementById('input-import-pack');
    if (inputImportPack) {
      inputImportPack.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importMaterialPackageFile(file);
          inputImportPack.value = '';
        }
      });
    }

    // DB初期化リセット
    const btnReset = document.getElementById('btn-reset-db');
    if (btnReset) {
      btnReset.addEventListener('click', async () => {
        if (confirm('データベースを初期状態にリセットしますか？\n学習履歴や追加した教材もリセットされます。')) {
          await this.dbService.resetToInitial();
          this.showToast('データベースを初期化しました。', 'info');
          await this.refreshMaterialSelector();
          await this.refreshScaleSelector();
          await this.renderDashboard();
        }
      });
    }

    // カスタムSQL実行
    const btnRunSql = document.getElementById('btn-run-sql');
    if (btnRunSql) {
      btnRunSql.addEventListener('click', () => this.executeCustomSql());
    }
  }

  /**
   * 学習セッション制御・音声設定関連イベント
   */
  initStudyControlEvents() {
    // クイック学習開始
    const btnUnmastered = document.getElementById('btn-quick-unmastered');
    if (btnUnmastered) {
      btnUnmastered.addEventListener('click', () => {
        this.switchTab('tab-study');
        this.startStudySession('unmastered_first', 15);
      });
    }

    const btnMaintenance = document.getElementById('btn-quick-maintenance');
    if (btnMaintenance) {
      btnMaintenance.addEventListener('click', () => {
        this.switchTab('tab-study');
        this.startStudySession('maintenance', 15);
      });
    }

    const btnSequential = document.getElementById('btn-quick-sequential');
    if (btnSequential) {
      btnSequential.addEventListener('click', () => {
        this.switchTab('tab-study');
        const modeSelect = document.getElementById('study-mode-select');
        if (modeSelect) modeSelect.value = 'sequential';
        const autoSettings = document.getElementById('auto-play-settings-panel');
        if (autoSettings) autoSettings.style.display = 'none';
        this.updateStudyQueuePreview();
        this.startStudySession('sequential', 'all');
      });
    }

    // 自動連続再生 クイック開始カード
    const btnAutopilot = document.getElementById('btn-quick-autopilot');
    if (btnAutopilot) {
      btnAutopilot.addEventListener('click', () => {
        this.switchTab('tab-study');
        const modeSelect = document.getElementById('study-mode-select');
        if (modeSelect) modeSelect.value = 'auto_playback';
        const autoSettings = document.getElementById('auto-play-settings-panel');
        if (autoSettings) autoSettings.style.display = 'block';
        const countSelect = document.getElementById('study-count-select');
        if (countSelect) countSelect.value = 'all';

        const startInput = document.getElementById('study-range-start');
        const endInput = document.getElementById('study-range-end');
        const rankSelect = document.getElementById('study-rank-filter');
        const orderSelect = document.getElementById('auto-play-order-select');
        const timerSelect = document.getElementById('auto-play-timer-select');
        const intervalSelect = document.getElementById('auto-play-interval-select');

        const startIdVal = startInput ? startInput.value.trim() : '';
        const endIdVal = endInput ? endInput.value.trim() : '';
        const rankFilterVal = rankSelect ? rankSelect.value : '';

        this.updateStudyQueuePreview();
        this.startStudySession('auto_playback', 'all', {
          startId: startIdVal ? parseInt(startIdVal, 10) : null,
          endId: endIdVal ? parseInt(endIdVal, 10) : null,
          rankDefId: rankFilterVal || null,
          autoPlayOrder: orderSelect ? orderSelect.value : 'sequential',
          autoPlayTimer: timerSelect ? timerSelect.value : '15',
          autoPlayPromptInterval: intervalSelect ? intervalSelect.value : '2.5',
          autoPlayAnswerInterval: '2.0'
        });
      });
    }

    // ID範囲リセットボタン
    const btnResetRange = document.getElementById('btn-reset-id-range');
    if (btnResetRange) {
      btnResetRange.addEventListener('click', () => {
        const s = document.getElementById('study-range-start');
        const e = document.getElementById('study-range-end');
        if (s) s.value = '';
        if (e) e.value = '';
        this.updateRankFilterOptions();
        this.updateStudyQueuePreview();
      });
    }

    // ID範囲変更時のランク件数再集計＆プレビュー更新
    ['study-range-start', 'study-range-end'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => {
          this.updateRankFilterOptions();
          this.updateStudyQueuePreview();
        });
        el.addEventListener('change', () => {
          this.updateRankFilterOptions();
          this.updateStudyQueuePreview();
        });
      }
    });

    // ランク選択変更時のピル選択状態同期＆プレビュー更新
    const rankSelect = document.getElementById('study-rank-filter');
    if (rankSelect) {
      rankSelect.addEventListener('change', () => {
        this.updateRankFilterOptions();
        this.updateStudyQueuePreview();
      });
    }

    // モード・件数変更時のリアルタイムプレビュー更新
    const modeSelectEl = document.getElementById('study-mode-select');
    if (modeSelectEl) {
      modeSelectEl.addEventListener('change', () => {
        const isAuto = (modeSelectEl.value === 'auto_playback');
        const autoSettings = document.getElementById('auto-play-settings-panel');
        if (autoSettings) {
          autoSettings.style.display = isAuto ? 'block' : 'none';
        }
        // 自動再生モード選択時は出題件数を「対象全件 (all)」にデフォルト切り替え
        if (isAuto) {
          const countSelect = document.getElementById('study-count-select');
          if (countSelect) countSelect.value = 'all';
        }
        this.updateStudyQueuePreview();
      });
    }
    const countSelectEl = document.getElementById('study-count-select');
    if (countSelectEl) {
      countSelectEl.addEventListener('change', () => this.updateStudyQueuePreview());
    }

    // カスタム学習開始
    const btnStartCustom = document.getElementById('btn-start-custom-study');
    if (btnStartCustom) {
      btnStartCustom.addEventListener('click', () => {
        const modeSelect = document.getElementById('study-mode-select');
        const countSelect = document.getElementById('study-count-select');
        const startInput = document.getElementById('study-range-start');
        const endInput = document.getElementById('study-range-end');
        const rankSelect = document.getElementById('study-rank-filter');
        const orderSelect = document.getElementById('auto-play-order-select');
        const timerSelect = document.getElementById('auto-play-timer-select');
        const intervalSelect = document.getElementById('auto-play-interval-select');

        const mode = modeSelect ? modeSelect.value : 'unmastered_first';
        const countVal = countSelect ? countSelect.value : '15';
        const count = countVal === 'all' ? 'all' : parseInt(countVal, 10);

        const startIdVal = startInput ? startInput.value.trim() : '';
        const endIdVal = endInput ? endInput.value.trim() : '';
        const rankFilterVal = rankSelect ? rankSelect.value : '';

        const options = {
          startId: startIdVal ? parseInt(startIdVal, 10) : null,
          endId: endIdVal ? parseInt(endIdVal, 10) : null,
          rankDefId: rankFilterVal || null,
          autoPlayOrder: orderSelect ? orderSelect.value : 'sequential',
          autoPlayTimer: timerSelect ? timerSelect.value : '15',
          autoPlayPromptInterval: intervalSelect ? intervalSelect.value : '2.5',
          autoPlayAnswerInterval: '2.0'
        };

        this.startStudySession(mode, count, options);
      });
    }

    // フラッシュカード操作
    const btnShowAnswer = document.getElementById('btn-show-answer');
    if (btnShowAnswer) {
      btnShowAnswer.addEventListener('click', () => this.revealAnswer());
    }

    const btnSpeakPrompt = document.getElementById('btn-speak-prompt');
    if (btnSpeakPrompt) {
      btnSpeakPrompt.addEventListener('click', () => this.speakCurrentPrompt());
    }

    const btnSpeakAnswer = document.getElementById('btn-speak-answer');
    if (btnSpeakAnswer) {
      btnSpeakAnswer.addEventListener('click', () => this.speakCurrentAnswer());
    }

    const btnPause = document.getElementById('btn-pause-study');
    if (btnPause) {
      btnPause.addEventListener('click', () => this.togglePauseStudySession());
    }

    const btnResume = document.getElementById('btn-resume-study');
    if (btnResume) {
      btnResume.addEventListener('click', () => this.resumeStudySession());
    }

    const btnQuit = document.getElementById('btn-quit-study');
    if (btnQuit) {
      btnQuit.addEventListener('click', () => this.quitStudySession());
    }

    // 自動連続再生 コントロールバーのボタン
    const btnAutoPlayPrev = document.getElementById('btn-auto-play-prev');
    if (btnAutoPlayPrev) {
      btnAutoPlayPrev.addEventListener('click', () => this.skipPrevAutoPlay());
    }

    const btnAutoPlayPause = document.getElementById('btn-auto-play-pause');
    if (btnAutoPlayPause) {
      btnAutoPlayPause.addEventListener('click', () => this.toggleAutoPlayPause());
    }

    const btnAutoPlayNext = document.getElementById('btn-auto-play-next');
    if (btnAutoPlayNext) {
      btnAutoPlayNext.addEventListener('click', () => this.skipNextAutoPlay());
    }

    const btnAutoPlayStop = document.getElementById('btn-auto-play-stop');
    if (btnAutoPlayStop) {
      btnAutoPlayStop.addEventListener('click', () => this.finishAutoPlay('自動連続再生を停止しました。'));
    }

    // ブラウザタブ非アクティブ時の自動一時停止（※自動連続再生中は睡眠学習・耳学習のため停止させない）
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.studySession.isActive && !this.studySession.isPaused) {
          if (this.studySession.isAutoPlay) {
            // 自動再生モード中は画面消灯やバックグラウンドでも再生を維持
            return;
          }
          this.pauseStudySession(true);
        }
      });
    }

    // 自動発音トグル & 読み上げ速度
    const checkAutoSpeak = document.getElementById('check-auto-speak');
    if (checkAutoSpeak) {
      checkAutoSpeak.checked = this.speechService.isAutoSpeakEnabled;
      checkAutoSpeak.addEventListener('change', (e) => {
        this.speechService.setAutoSpeak(e.target.checked);
        this.showToast(e.target.checked ? '🔊 自動発音を有効にしました' : '🔇 自動発音を無効にしました', 'info');
      });
    }

    const selectRate = document.getElementById('select-speech-rate');
    if (selectRate) {
      selectRate.value = String(this.speechService.speechRate);
      selectRate.addEventListener('change', (e) => {
        this.speechService.setRate(parseFloat(e.target.value));
      });
    }

    // 学習完了画面からの再開
    const btnRestart = document.getElementById('btn-restart-study');
    if (btnRestart) {
      btnRestart.addEventListener('click', () => {
        document.getElementById('study-complete-area').style.display = 'none';
        document.getElementById('study-setup-area').style.display = 'block';
      });
    }
  }

  /**
   * 教材テーブル検索・フィルター関連イベント
   */
  initTableFilterEvents() {
    const searchInput = document.getElementById('material-search');
    if (searchInput) {
      searchInput.addEventListener('input', () => this.renderMaterialsTable());
    }

    const filterRank = document.getElementById('material-rank-filter');
    if (filterRank) {
      filterRank.addEventListener('change', () => this.renderMaterialsTable());
    }
  }

  /**
   * タブ切り替え
   */
  switchTab(tabId) {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');

    tabBtns.forEach(b => b.classList.remove('active'));
    tabContents.forEach(c => c.classList.remove('active'));

    const activeBtn = document.querySelector(`.tab-btn[data-tab="${tabId}"]`);
    const activeContent = document.getElementById(tabId);
    if (activeBtn) activeBtn.classList.add('active');
    if (activeContent) activeContent.classList.add('active');

    if (tabId === 'tab-dashboard') {
      this.renderDashboard();
    } else if (tabId === 'tab-study') {
      this.refreshStudySetupForm();
    } else if (tabId === 'tab-materials') {
      this.renderMaterialsTable();
    } else if (tabId === 'tab-logs') {
      this.renderLogsTable();
    } else if (tabId === 'tab-settings') {
      this.renderCatalogTable();
    }
  }

  isTabActive(tabId) {
    const content = document.getElementById(tabId);
    return content ? content.classList.contains('active') : false;
  }

  /**
   * 教材セレクターの選択肢更新
   */
  async refreshMaterialSelector() {
    const select = document.getElementById('material-select');
    if (!select) return;

    const list = this.dbService.getMaterialsList();
    select.innerHTML = '';

    if (list.length === 0) {
      this.materialType = '';
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '(教材が未登録です)';
      select.appendChild(opt);
      select.value = '';
      return;
    }

    list.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.material_type;
      opt.textContent = `${m.display_name} (${m.total_items}件)`;
      if (m.material_type === this.materialType) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });

    if (!list.some(m => m.material_type === this.materialType)) {
      this.materialType = list[0].material_type;
      select.value = this.materialType;
    }
  }

  /**
   * 教材変更時の画面全体再描画
   */
  async onMaterialChanged() {
    const subtitle = document.getElementById('app-header-subtitle');
    if (!this.materialType) {
      if (subtitle) {
        subtitle.textContent = '教材が選択されていません (SQLite Wasm / sql.js 駆動)';
      }
      await this.renderDashboard();
      if (this.isTabActive('tab-materials')) this.renderMaterialsTable();
      if (this.isTabActive('tab-logs')) this.renderLogsTable();
      if (this.isTabActive('tab-settings')) this.renderCatalogTable();
      return;
    }

    const meta = this.dbService.getMaterialMetadata(this.materialType);
    if (subtitle) {
      subtitle.textContent = `${meta.display_name} (SQLite Wasm / sql.js 駆動)`;
    }

    // 学習中ならセッションリセット
    if (this.studySession.isActive) {
      this.quitStudySession();
    }

    await this.renderDashboard();

    // フィルタセレクターのランク肢をリセット
    const filterSelect = document.getElementById('material-rank-filter');
    if (filterSelect) filterSelect.innerHTML = '<option value="">すべてのランク</option>';

    if (this.isTabActive('tab-materials')) {
      await this.renderMaterialsTable();
    } else if (this.isTabActive('tab-logs')) {
      await this.renderLogsTable();
    } else if (this.isTabActive('tab-settings')) {
      this.renderCatalogTable();
    }

    this.refreshStudySetupForm();
  }

  /**
   * スケールセレクターの選択肢更新
   */
  async refreshScaleSelector() {
    const select = document.getElementById('scale-select');
    if (!select) return;

    const scales = this.dbService.getScaleList ? this.dbService.getScaleList() : (this.dbService.getScales ? this.dbService.getScales() : []);
    select.innerHTML = '';
    scales.forEach(s => {
      const opt = document.createElement('option');
      opt.value = s.scale_id;
      opt.textContent = s.scale_name;
      if (s.scale_id === this.currentScale) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  }

  /**
   * データベースのロード完了時の共通処理（画面展開とUI初期化）
   */
  async onDatabaseReady() {
    const welcomeEl = document.getElementById('welcome-overlay');
    if (welcomeEl) {
      welcomeEl.style.display = 'none';
    }

    await this.refreshMaterialSelector();
    await this.refreshScaleSelector();
    await this.onMaterialChanged();
    this.switchTab('tab-dashboard');
    this.updateFileSyncUI();

    const btnOpen = document.getElementById('btn-welcome-open');
    if (btnOpen) {
      btnOpen.textContent = '📂 既存のDBファイルを開く';
      btnOpen.disabled = false;
    }
  }

  // ==========================================
  // 委譲ラッパー: UIViews (画面描画)
  // ==========================================
  async renderDashboard() {
    if (this.uiViews) return await this.uiViews.renderDashboard(this.materialType, this.currentScale);
  }
  async renderMaterialsTable() {
    if (this.uiViews) return await this.uiViews.renderMaterialsTable(this.materialType, this.currentScale);
  }
  async renderLogsTable() {
    if (this.uiViews) return await this.uiViews.renderLogsTable(this.materialType);
  }
  executeCustomSql() {
    if (this.uiViews) return this.uiViews.executeCustomSql();
  }

  // ==========================================
  // 委譲ラッパー: StudySessionManager (学習セッション)
  // ==========================================
  initKeyboardShortcuts() {
    if (this.studySessionManager) this.studySessionManager.initKeyboardShortcuts();
  }
  startStudySession(mode, limit = 15, options = {}) {
    if (this.studySessionManager) this.studySessionManager.start(mode, limit, options);
  }

  // ==========================================
  // 委譲ラッパー: StudySessionManager (学習セットアップUI)
  // ==========================================
  refreshStudySetupForm() {
    if (this.studySessionManager) this.studySessionManager.refreshSetupForm();
  }
  updateRankFilterOptions() {
    if (this.studySessionManager) this.studySessionManager.updateRankFilterOptions();
  }
  createRankPill(config) {
    return this.studySessionManager ? this.studySessionManager.createRankPill(config) : null;
  }
  updateStudyQueuePreview() {
    if (this.studySessionManager) this.studySessionManager.updateQueuePreview();
  }
  renderCurrentStudyCard() {
    if (this.studySessionManager) this.studySessionManager.renderCurrentCard();
  }
  speakCurrentPrompt() {
    if (this.studySessionManager) this.studySessionManager.speakCurrentPrompt();
  }
  speakCurrentAnswer() {
    if (this.studySessionManager) this.studySessionManager.speakCurrentAnswer();
  }
  revealAnswer() {
    if (this.studySessionManager) this.studySessionManager.revealAnswer();
  }
  pauseStudySession(isAuto = false) {
    if (this.studySessionManager) this.studySessionManager.pause(isAuto);
  }
  resumeStudySession() {
    if (this.studySessionManager) this.studySessionManager.resume();
  }
  togglePauseStudySession() {
    if (this.studySessionManager) this.studySessionManager.togglePause();
  }
  quitStudySession() {
    if (this.studySessionManager) this.studySessionManager.quit();
  }
  async submitStudyAssessment(rankDefId) {
    if (this.studySessionManager) return await this.studySessionManager.submitAssessment(rankDefId);
  }
  finishStudySession() {
    if (this.studySessionManager) this.studySessionManager.finish();
  }
  skipPrevAutoPlay() {
    if (this.studySessionManager) this.studySessionManager.skipPrevAutoPlay();
  }
  toggleAutoPlayPause() {
    if (this.studySessionManager) this.studySessionManager.toggleAutoPlayPause();
  }
  skipNextAutoPlay() {
    if (this.studySessionManager) this.studySessionManager.skipNextAutoPlay();
  }
  finishAutoPlay(msg) {
    if (this.studySessionManager) this.studySessionManager.finishAutoPlay(msg);
  }

  // ==========================================
  // 委譲ラッパー: MaterialManager (教材カタログ・CSVインポート)
  // ==========================================
  initModalEvents() {
    if (this.materialManager) this.materialManager.initModalEvents();
  }
  resetImportModal() {
    if (this.materialManager) this.materialManager.resetImportModal();
  }
  async handleSelectedCsvFile(file) {
    if (this.materialManager) return await this.materialManager.handleSelectedCsvFile(file);
  }
  renderCsvPreviewTable(headers, rows) {
    if (this.materialManager) this.materialManager.renderCsvPreviewTable(headers, rows);
  }
  async executeCsvImport() {
    if (this.materialManager) return await this.materialManager.executeCsvImport();
  }
  renderCatalogTable() {
    if (this.materialManager) this.materialManager.renderCatalogTable();
  }
  openMaterialEditModal(materialType, mode = 'edit') {
    if (this.materialManager) this.materialManager.openMaterialEditModal(materialType, mode);
  }
  async saveMaterialEdit() {
    if (this.materialManager) return await this.materialManager.saveMaterialEdit();
  }
  exportMaterialPackageFile(materialType, displayName) {
    if (this.materialManager) this.materialManager.exportMaterialPackageFile(materialType, displayName);
  }
  exportMaterialCsvFile(materialType, displayName) {
    if (this.materialManager) this.materialManager.exportMaterialCsvFile(materialType, displayName);
  }
  async importMaterialPackageFile(file) {
    if (this.materialManager) return await this.materialManager.importMaterialPackageFile(file);
  }

  // ==========================================
  // 委譲ラッパー: FileSyncService (ファイル同期)
  // ==========================================
  async openLocalFilePicker() {
    if (!this.fileSyncService) return;
    await this.fileSyncService.openLocalFilePicker({
      onStart: (name) => this.showToast(`実ファイル「${name}」を読み込み中...`),
      onSuccess: async (file) => {
        await this.onDatabaseReady();
        this.showToast(`実ファイル「${file.name}」と接続しました！以後の変更は直接自動保存されます。`, 'success');
      },
      onError: (err) => this.showToast('ファイルを開けませんでした: ' + err.message, 'danger')
    });
  }

  async createNewDatabasePicker() {
    if (!this.fileSyncService) return;
    await this.fileSyncService.createNewDatabasePicker({
      onStart: (name) => this.showToast(`新規DB「${name}」を作成中...`),
      onSuccess: async (handle) => {
        await this.onDatabaseReady();
        const name = handle ? handle.name : '新規ファイル';
        this.showToast(`新規DB「${name}」を作成・接続しました！`, 'success');
      },
      onError: (err) => this.showToast('新規作成に失敗しました: ' + err.message, 'danger')
    });
  }

  async startDemoDatabase() {
    this.showToast('内蔵デモ教材をメモリに読み込み中...');
    try {
      await this.dbService.loadDemoDatabase();
      await this.onDatabaseReady();
      this.showToast('デモ教材をロードしました（※一時メモリ動作）', 'info');
    } catch (err) {
      console.error('Failed to load demo DB:', err);
      this.showToast('デモ教材の読み込みに失敗しました: ' + err.message, 'danger');
    }
  }

  async saveAsLocalFilePicker() {
    if (!this.fileSyncService) return;
    await this.fileSyncService.saveAsLocalFilePicker({
      onStart: (name) => this.showToast(`「${name}」に保存中...`),
      onSuccess: async (handle) => {
        this.updateFileSyncUI();
        const name = handle ? handle.name : 'ファイル';
        this.showToast(`「${name}」に保存しました！今後はこの実ファイルと直接自動同期されます。`, 'success');
      },
      onError: (err) => this.showToast('保存に失敗しました: ' + err.message, 'danger')
    });
  }

  updateFileSyncUI() {
    if (this.fileSyncService) {
      this.fileSyncService.updateSyncBarUI();
    }
  }

  exportDatabaseFile() {
    try {
      if (this.fileSyncService) {
        this.fileSyncService.exportDatabaseFile();
      } else {
        const binary = this.dbService.exportBinary();
        const blob = new Blob([binary], { type: 'application/x-sqlite3' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `learning_rank_${new Date().toISOString().slice(0, 10)}.db`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }
      this.showToast('データベースファイルをエクスポートしました。', 'success');
    } catch (err) {
      console.error('Export error:', err);
      this.showToast('エクスポートに失敗しました: ' + err.message, 'danger');
    }
  }

  async importDatabaseFile(file) {
    try {
      this.showToast('データベースを読み込み中...');
      const arrayBuffer = await file.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      await this.dbService.importBinary(uint8Array);
      if (this.fileSyncService) {
        this.fileSyncService.fileName = file.name;
        this.fileSyncService.fileHandle = null;
        this.fileSyncService.lastSavedAt = new Date();
      }
      this.dbService.fileName = file.name;
      this.showToast(`SQLiteファイル「${file.name}」を正常にインポートしました。`, 'success');
      await this.onDatabaseReady();
    } catch (err) {
      console.error('Import error:', err);
      this.showToast('インポートに失敗しました: ' + err.message, 'danger');
    }
  }

  // ==========================================
  // 共通UIユーティリティ
  // ==========================================
  showToast(message, type = 'info') {
    if (typeof document === 'undefined' || !document.body) {
      console.log(`[Toast ${type}]: ${message}`);
      return;
    }
    let container = document.querySelector('.toast-container');
    if (!container) {
      container = document.createElement('div');
      container.className = 'toast-container';
      document.body.appendChild(container);
    }

    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    if (type === 'success') toast.style.backgroundColor = '#065f46';
    if (type === 'danger') toast.style.backgroundColor = '#991b1b';
    if (type === 'warning') toast.style.backgroundColor = '#92400e';

    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
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
  window.App = App;
  const app = new App();
  window.app = app;
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('DOMContentLoaded', () => app.init());
  }
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = App;
}
