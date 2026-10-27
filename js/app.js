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
   * DOM要素へのイベント登録ヘルパー
   */
  _on(id, event, handler) {
    if (typeof document === 'undefined') return null;
    const el = document.getElementById(id);
    if (el) el.addEventListener(event, handler);
    return el;
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
    if (typeof document !== 'undefined') {
      document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => this.switchTab(btn.getAttribute('data-tab')));
      });
    }

    this._on('material-select', 'change', async (e) => {
      this.materialType = e.target.value;
      await this.onMaterialChanged();
    });

    this._on('scale-select', 'change', async (e) => {
      this.currentScale = e.target.value;
      if (this.materialType && this.dbService && typeof this.dbService.setMaterialDefaultScale === 'function') {
        await this.dbService.setMaterialDefaultScale(this.materialType, this.currentScale);
      }
      const filterSelect = document.getElementById('material-rank-filter');
      if (filterSelect) filterSelect.innerHTML = '<option value="">すべてのランク</option>';

      await this.renderDashboard();
      if (this.isTabActive('tab-materials')) {
        await this.renderMaterialsTable();
      }
      if (this.studySession && this.studySession.isActive && !this.studySession.isAutoPlay && this.studySessionManager) {
        this.studySessionManager.renderRankButtons();
      }
      this.refreshStudySetupForm();
      this.updateFileSyncUI();
    });
  }

  /**
   * ウェルカム画面・ファイル連携・DB管理関連イベント
   */
  initWelcomeAndFileEvents() {
    this._on('btn-welcome-open', 'click', () => this.openLocalFilePicker());
    this._on('btn-welcome-create', 'click', () => this.createNewDatabasePicker());
    this._on('btn-welcome-demo', 'click', (e) => {
      e.preventDefault();
      this.startDemoDatabase();
    });
    this._on('btn-file-open', 'click', () => this.openLocalFilePicker());
    this._on('btn-file-save-as', 'click', () => this.saveAsLocalFilePicker());
    this._on('btn-export-db', 'click', () => this.exportDatabaseFile());

    ['input-import-db', 'input-direct-file-open'].forEach(id => {
      this._on(id, 'change', async (e) => {
        const file = e.target.files[0];
        if (file) {
          await this.importDatabaseFile(file);
          e.target.value = '';
        }
      });
    });

    this._on('input-import-pack', 'change', async (e) => {
      const file = e.target.files[0];
      if (file) {
        await this.importMaterialPackageFile(file);
        e.target.value = '';
      }
    });

    this._on('btn-reset-db', 'click', async () => {
      if (confirm('データベースを初期状態にリセットしますか？\n学習履歴や追加した教材もリセットされます。')) {
        await this.dbService.resetToInitial();
        this.showToast('データベースを初期化しました。', 'info');
        await this.refreshMaterialSelector();
        await this.refreshScaleSelector();
        await this.onMaterialChanged();
        this.updateFileSyncUI();
      }
    });

    this._on('btn-run-sql', 'click', () => this.executeCustomSql());
  }

  /**
   * 学習セットアップフォームの現在値を収集
   */
  _collectStudySetupOptions() {
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : '';
    };
    const startIdVal = val('study-range-start');
    const endIdVal = val('study-range-end');

    return {
      startId: startIdVal ? parseInt(startIdVal, 10) : null,
      endId: endIdVal ? parseInt(endIdVal, 10) : null,
      rankDefId: val('study-rank-filter') || null,
      autoPlayOrder: val('auto-play-order-select') || 'sequential',
      autoPlayTimer: val('auto-play-timer-select') || '15',
      autoPlayPromptInterval: val('auto-play-interval-select') || '2.5',
      autoPlayAnswerInterval: '2.0'
    };
  }

  /**
   * 学習セッション制御・音声設定関連イベント
   */
  initStudyControlEvents() {
    this._on('btn-quick-unmastered', 'click', () => {
      this.switchTab('tab-study');
      this.startStudySession('unmastered_first', 15);
    });

    this._on('btn-quick-maintenance', 'click', () => {
      this.switchTab('tab-study');
      this.startStudySession('maintenance', 15);
    });

    this._on('btn-quick-sequential', 'click', () => {
      this.switchTab('tab-study');
      const modeSelect = document.getElementById('study-mode-select');
      if (modeSelect) modeSelect.value = 'sequential';
      const autoSettings = document.getElementById('auto-play-settings-panel');
      if (autoSettings) autoSettings.style.display = 'none';
      this.updateStudyQueuePreview();
      this.startStudySession('sequential', 'all');
    });

    this._on('btn-quick-autopilot', 'click', () => {
      this.switchTab('tab-study');
      const modeSelect = document.getElementById('study-mode-select');
      if (modeSelect) modeSelect.value = 'auto_playback';
      const autoSettings = document.getElementById('auto-play-settings-panel');
      if (autoSettings) autoSettings.style.display = 'block';
      const countSelect = document.getElementById('study-count-select');
      if (countSelect) countSelect.value = 'all';

      this.updateStudyQueuePreview();
      this.startStudySession('auto_playback', 'all', this._collectStudySetupOptions());
    });

    this._on('btn-reset-id-range', 'click', () => {
      const s = document.getElementById('study-range-start');
      const e = document.getElementById('study-range-end');
      if (s) s.value = '';
      if (e) e.value = '';
      this.updateRankFilterOptions();
      this.updateStudyQueuePreview();
    });

    ['study-range-start', 'study-range-end'].forEach(id => {
      const handler = () => {
        this.updateRankFilterOptions();
        this.updateStudyQueuePreview();
      };
      this._on(id, 'input', handler);
      this._on(id, 'change', handler);
    });

    this._on('study-rank-filter', 'change', () => {
      this.updateRankFilterOptions();
      this.updateStudyQueuePreview();
    });

    this._on('study-mode-select', 'change', (e) => {
      const isAuto = (e.target.value === 'auto_playback');
      const autoSettings = document.getElementById('auto-play-settings-panel');
      if (autoSettings) autoSettings.style.display = isAuto ? 'block' : 'none';
      if (isAuto) {
        const countSelect = document.getElementById('study-count-select');
        if (countSelect) countSelect.value = 'all';
      }
      this.updateStudyQueuePreview();
    });

    this._on('study-count-select', 'change', () => this.updateStudyQueuePreview());

    this._on('btn-start-custom-study', 'click', () => {
      const modeSelect = document.getElementById('study-mode-select');
      const countSelect = document.getElementById('study-count-select');
      const mode = modeSelect ? modeSelect.value : 'unmastered_first';
      const countVal = countSelect ? countSelect.value : '15';
      const count = countVal === 'all' ? 'all' : parseInt(countVal, 10);
      this.startStudySession(mode, count, this._collectStudySetupOptions());
    });

    this._on('btn-show-answer', 'click', () => this.revealAnswer());
    this._on('btn-speak-prompt', 'click', () => this.speakCurrentPrompt());
    this._on('btn-speak-answer', 'click', () => this.speakCurrentAnswer());
    this._on('btn-pause-study', 'click', () => this.togglePauseStudySession());
    this._on('btn-undo-study', 'click', () => this.undoStudyAssessment());
    this._on('btn-resume-study', 'click', () => this.resumeStudySession());
    this._on('btn-quit-study', 'click', () => this.quitStudySession());

    this._on('btn-auto-play-prev', 'click', () => this.skipPrevAutoPlay());
    this._on('btn-auto-play-pause', 'click', () => this.toggleAutoPlayPause());
    this._on('btn-auto-play-next', 'click', () => this.skipNextAutoPlay());
    this._on('btn-auto-play-stop', 'click', () => this.finishAutoPlay('自動連続再生を停止しました。'));

    if (this.studySessionManager && typeof this.studySessionManager.initStylePanelEvents === 'function') {
      this.studySessionManager.initStylePanelEvents();
    }

    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden && this.studySession.isActive && !this.studySession.isPaused) {
          if (this.studySession.isAutoPlay) return;
          if (this.studySessionManager && this.studySessionManager.getAutoPauseTimeoutSec() === 0) return;
          this.pauseStudySession(true);
        }
      });
    }

    ['select-auto-pause-timeout', 'setup-auto-pause-select'].forEach(selectId => {
      if (this.studySessionManager) {
        const el = this._on(selectId, 'change', (e) => {
          this.studySessionManager.setAutoPauseTimeoutSec(e.target.value);
          const sec = this.studySessionManager.getAutoPauseTimeoutSec();
          this.showToast(sec === 0 ? '⏱️ 自動一時停止を OFF にしました' : `⏱️ 自動一時停止を ${sec}秒 に設定しました`, 'info');
        });
        if (el) el.value = String(this.studySessionManager.getAutoPauseTimeoutSec());
      }
    });

    const checkAutoSpeak = this._on('check-auto-speak', 'change', (e) => {
      this.speechService.setAutoSpeak(e.target.checked);
      this.showToast(e.target.checked ? '🔊 自動発音を有効にしました' : '🔇 自動発音を無効にしました', 'info');
    });
    if (checkAutoSpeak) checkAutoSpeak.checked = this.speechService.isAutoSpeakEnabled;

    const selectRate = this._on('select-speech-rate', 'change', (e) => {
      this.speechService.setRate(parseFloat(e.target.value));
    });
    if (selectRate) selectRate.value = String(this.speechService.speechRate);

    this._on('btn-retry-weak-study', 'click', () => this.startRetryWeakStudySession());
    this._on('btn-restart-study', 'click', () => {
      document.getElementById('study-complete-area').style.display = 'none';
      document.getElementById('study-setup-area').style.display = 'block';
      this.refreshStudySetupForm();
    });
  }

  /**
   * 教材テーブル検索・フィルター・ページ表示件数関連イベント
   */
  initTableFilterEvents() {
    let searchDebounceTimer = null;
    this._on('material-search', 'input', () => {
      if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => this.renderMaterialsTable(), 150);
    });
    this._on('material-rank-filter', 'change', () => this.renderMaterialsTable());
    this._on('materials-page-size', 'change', (e) => {
      if (this.uiViews && typeof this.uiViews.setMaterialsPageSize === 'function') {
        this.uiViews.setMaterialsPageSize(e.target.value);
        this.renderMaterialsTable();
      }
    });
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

    // 教材ごとに記憶されたデフォルト評価スケールがあれば復元
    if (meta && meta.default_scale_id && meta.default_scale_id !== this.currentScale) {
      this.currentScale = meta.default_scale_id;
      const scaleSelect = document.getElementById('scale-select');
      if (scaleSelect) scaleSelect.value = this.currentScale;
    }

    // 学習中ならセッションリセット
    if (this.studySession.isActive) {
      this.quitStudySession();
    }
    if (this.studySessionManager && typeof this.studySessionManager.applyCardStyle === 'function') {
      this.studySessionManager.applyCardStyle();
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
  async undoStudyAssessment() {
    if (this.studySessionManager) return await this.studySessionManager.undoLastAssessment();
  }
  startRetryWeakStudySession() {
    if (this.studySessionManager) return this.studySessionManager.startRetryWeakSession();
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
  async updateCardStyle(partialConfig) {
    return this.studySessionManager ? await this.studySessionManager.updateCardStyle(partialConfig) : null;
  }
  async resetCardStyle() {
    return this.studySessionManager ? await this.studySessionManager.resetCardStyle() : null;
  }
  toggleCardStylePanel(forceOpen = null) {
    return this.studySessionManager ? this.studySessionManager.toggleStylePanel(forceOpen) : false;
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

    // すでに実ファイルハンドルがあり未同期変更がある場合は、まず直接同期（権限再承認含む）を試みる
    if (this.fileSyncService.fileHandle && this.fileSyncService.isModified) {
      this.showToast(`実ファイル「${this.fileSyncService.fileName}」へ保存中...`);
      try {
        const ok = await this.fileSyncService.saveToFileHandle();
        if (ok) {
          this.updateFileSyncUI();
          this.showToast(`実ファイル「${this.fileSyncService.fileName}」に最新の変更を保存しました！`, 'success');
          return;
        }
      } catch (e) {
        console.warn('Direct sync retry error:', e);
      }
    }

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
