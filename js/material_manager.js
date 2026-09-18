/**
 * MaterialManager - 教材カタログ・CSVインポート・教材設定編集マネージャー
 * 
 * 責務:
 * 1. 新規CSV教材の解析・自動カラムマッピング推定・プレビュー・取り込み
 * 2. 教材カタログ一覧テーブル（設定タブ）の描画と操作（編集・複製・パック・CSV・削除）
 * 3. 教材設定編集・複製モーダルの制御（出題の向き、音声言語設定）
 * 4. ポータブル教材パック（JSON）のエクスポート・インポート復元
 * 5. 元教材CSV形式のエクスポート
 */

class MaterialManager {
  constructor(app = null, dbService = null) {
    this.app = app;
    this.dbService = dbService;

    // CSVインポート一時データ
    this.importData = {
      file: null,
      csvText: '',
      headers: [],
      rows: []
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

  setServices({ app, dbService }) {
    if (app) this.app = app;
    if (dbService) this.dbService = dbService;
  }

  /**
   * インポートモーダルおよび編集モーダルのイベント登録
   */
  initModalEvents() {
    if (typeof document === 'undefined') return;

    // 1. CSVインポートモーダル
    const importModal = this.getEl('csv-import-modal');
    const openBtn1 = this.getEl('btn-open-import-modal');
    const openBtn2 = this.getEl('btn-open-import-modal-2');
    const closeBtn = this.getEl('btn-close-import-modal');
    const cancelBtn = this.getEl('btn-cancel-import');
    const dropzone = this.getEl('dropzone');
    const fileInput = this.getEl('csv-file-input');
    const executeBtn = this.getEl('btn-execute-import');

    const openModal = () => {
      this.resetImportModal();
      if (importModal) importModal.style.display = 'flex';
    };

    const closeModal = () => {
      if (importModal) importModal.style.display = 'none';
      this.resetImportModal();
    };

    if (openBtn1) openBtn1.addEventListener('click', openModal);
    if (openBtn2) openBtn2.addEventListener('click', openModal);
    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);

    // ドロップゾーンイベント
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());

      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });

      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
      });

      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
          this.handleSelectedCsvFile(e.dataTransfer.files[0]);
        }
      });

      fileInput.addEventListener('change', (e) => {
        if (e.target.files && e.target.files.length > 0) {
          this.handleSelectedCsvFile(e.target.files[0]);
        }
      });
    }

    // インポート実行ボタン
    if (executeBtn) {
      executeBtn.addEventListener('click', async () => {
        await this.executeCsvImport();
      });
    }

    // 2. 教材設定編集・複製モーダル
    const editModal = this.getEl('material-edit-modal');
    const closeEditBtn = this.getEl('btn-close-edit-modal');
    const cancelEditBtn = this.getEl('btn-cancel-edit');
    const saveEditBtn = this.getEl('btn-save-material-edit');

    const closeEditModal = () => {
      if (editModal) editModal.style.display = 'none';
    };

    if (closeEditBtn) closeEditBtn.addEventListener('click', closeEditModal);
    if (cancelEditBtn) cancelEditBtn.addEventListener('click', closeEditModal);
    if (saveEditBtn) {
      saveEditBtn.addEventListener('click', async () => {
        await this.saveMaterialEdit();
      });
    }
  }

  /**
   * インポートモーダルの状態リセット
   */
  resetImportModal() {
    this.importData = { file: null, csvText: '', headers: [], rows: [] };
    const stepFile = this.getEl('import-step-file');
    const stepConfig = this.getEl('import-step-config');
    const fileInput = this.getEl('csv-file-input');
    const matName = this.getEl('new-material-name');
    const matType = this.getEl('new-material-type');
    const previewTable = this.getEl('csv-preview-table');

    if (stepFile) stepFile.style.display = 'block';
    if (stepConfig) stepConfig.style.display = 'none';
    if (fileInput) fileInput.value = '';
    if (matName) matName.value = '';
    if (matType) matType.value = '';
    if (previewTable) previewTable.innerHTML = '';
  }

  /**
   * 選択されたCSVファイルの解析とUI設定
   */
  async handleSelectedCsvFile(file) {
    if (!file.name.endsWith('.csv')) {
      if (typeof alert !== 'undefined') alert('CSVファイル（.csv）を選択してください。');
      return;
    }

    const text = await file.text();
    const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      if (typeof alert !== 'undefined') alert('CSVにはヘッダー行と1行以上のデータが必要です。');
      return;
    }

    const headers = this.dbService ? this.dbService.parseCsvLine(lines[0]) : lines[0].split(',').map(s => s.trim());
    const previewRows = [];
    for (let i = 1; i < Math.min(lines.length, 6); i++) {
      const parsed = this.dbService ? this.dbService.parseCsvLine(lines[i]) : lines[i].split(',').map(s => s.trim());
      previewRows.push(parsed);
    }

    this.importData = {
      file,
      csvText: text,
      headers,
      rows: previewRows
    };

    // デフォルト名推定
    const baseName = file.name.replace(/\.csv$/i, '');
    let cleanId = (this.dbService && typeof this.dbService.sanitizeMaterialType === 'function')
      ? this.dbService.sanitizeMaterialType(baseName)
      : baseName.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    if (/^[0-9]/.test(cleanId)) {
      cleanId = 'm_' + cleanId;
    }
    const nameInput = this.getEl('new-material-name');
    const typeInput = this.getEl('new-material-type');
    if (nameInput) nameInput.value = baseName;
    if (typeInput) typeInput.value = cleanId;

    // カラムマッピング選択肢生成
    const promptSelect = this.getEl('map-prompt-col');
    const answerSelect = this.getEl('map-answer-col');
    if (promptSelect) promptSelect.innerHTML = '';
    if (answerSelect) answerSelect.innerHTML = '';

    headers.forEach((h, idx) => {
      if (promptSelect) {
        const opt1 = this.createEl('option');
        opt1.value = h;
        opt1.textContent = `${h} (列 ${idx + 1})`;
        promptSelect.appendChild(opt1);
      }
      if (answerSelect) {
        const opt2 = this.createEl('option');
        opt2.value = h;
        opt2.textContent = `${h} (列 ${idx + 1})`;
        answerSelect.appendChild(opt2);
      }
    });

    // 自動選択の推定
    const guesses = this.guessColumnMapping(headers);
    if (promptSelect) promptSelect.value = guesses.promptGuess;
    if (answerSelect) answerSelect.value = guesses.answerGuess;
    const hintInput = this.getEl('map-hint-cols');
    if (hintInput) hintInput.value = guesses.hintGuess;

    // プレビューテーブル描画
    this.renderCsvPreviewTable(headers, previewRows);

    // ステップ切り替え
    const stepFile = this.getEl('import-step-file');
    const stepConfig = this.getEl('import-step-config');
    if (stepFile) stepFile.style.display = 'none';
    if (stepConfig) stepConfig.style.display = 'block';
  }

  /**
   * カラムマッピングの自動推定ロジック
   */
  guessColumnMapping(headers) {
    const promptGuess = headers.find(h => ['word', 'prompt', 'question', 'term', '見出し', '問題', '単語', '年号', 'year'].includes(h.toLowerCase())) || headers[0];
    const answerGuess = headers.find(h => ['meaning', 'meaning_ja', 'answer', 'translation', '意味', '訳', '解答', '正解', '出来事', 'event', 'explanation'].includes(h.toLowerCase())) || headers[headers.length - 1];
    const hintGuess = headers.filter(h => h !== 'id' && h !== promptGuess && h !== answerGuess).join(', ');
    return { promptGuess, answerGuess, hintGuess };
  }

  /**
   * CSVプレビューテーブルの描画
   */
  renderCsvPreviewTable(headers, rows) {
    const table = this.getEl('csv-preview-table');
    if (!table) return;

    let html = '<thead><tr>' + headers.map(h => `<th>${this.escapeHtml(h)}</th>`).join('') + '</tr></thead><tbody>';
    rows.forEach(r => {
      html += '<tr>' + r.map(cell => `<td>${this.escapeHtml(cell)}</td>`).join('') + '</tr>';
    });
    html += '</tbody>';
    table.innerHTML = html;
  }

  /**
   * CSVインポートの実行
   */
  async executeCsvImport() {
    const nameInput = this.getEl('new-material-name');
    const typeInput = this.getEl('new-material-type');
    const promptColInput = this.getEl('map-prompt-col');
    const answerColInput = this.getEl('map-answer-col');
    const hintColsInput = this.getEl('map-hint-cols');

    const displayName = nameInput ? nameInput.value.trim() : '';
    const materialType = typeInput ? typeInput.value.trim() : '';
    const promptColumn = promptColInput ? promptColInput.value : '';
    const answerColumn = answerColInput ? answerColInput.value : '';
    const hintColumns = hintColsInput ? hintColsInput.value.trim() : '';

    if (!displayName || !materialType) {
      if (typeof alert !== 'undefined') alert('教材表示名と識別IDを入力してください。');
      return;
    }

    try {
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast('教材をデータベースに登録中...');
      }

      const res = await this.dbService.importNewMaterialFromCsv({
        materialType,
        displayName,
        csvText: this.importData.csvText,
        promptColumn,
        hintColumns,
        answerColumn
      });

      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast(`教材「${displayName}」（${res.totalItems}件）を登録しました！`, 'success');
      }

      const importModal = this.getEl('csv-import-modal');
      if (importModal) importModal.style.display = 'none';

      // 登録した新教材を選択してUI更新
      if (this.app) {
        if (typeof this.app.refreshMaterialSelector === 'function') {
          await this.app.refreshMaterialSelector();
        }
        const matSelect = this.getEl('material-select');
        if (matSelect) matSelect.value = res.materialType;
        this.app.materialType = res.materialType;
        if (typeof this.app.onMaterialChanged === 'function') {
          await this.app.onMaterialChanged();
        }
        if (typeof this.app.updateFileSyncUI === 'function') {
          this.app.updateFileSyncUI();
        }
      }
    } catch (err) {
      console.error('[MaterialManager] Import error:', err);
      if (typeof alert !== 'undefined') alert('インポートに失敗しました: ' + err.message);
    }
  }

  /**
   * 教材カタログ一覧の描画（設定タブ）
   */
  renderCatalogTable() {
    const tbody = this.getEl('catalog-table-body');
    if (!tbody || !this.dbService) return;

    const list = this.dbService.getMaterialsList();
    tbody.innerHTML = '';

    if (list.length === 0) {
      tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">登録されている教材はありません。右上の「➕ 新規CSV教材をインポート」または「📦 教材パックを復元」から教材を追加してください。</td></tr>`;
      return;
    }

    list.forEach(m => {
      const tr = this.createEl('tr');
      if (!tr) return;

      tr.innerHTML = `
        <td><code>${this.escapeHtml(m.material_type)}</code></td>
        <td style="font-weight: 700;">${this.escapeHtml(m.display_name)}</td>
        <td><span class="badge" style="background: #e0f2fe; color: #0369a1; padding: 0.2rem 0.5rem; border-radius: 4px;">${m.total_items} 項目</span></td>
        <td style="font-size: 0.85rem; color: var(--text-muted);">${this.escapeHtml(m.prompt_column)} / ${this.escapeHtml(m.answer_column)}</td>
        <td style="font-size: 0.85rem; color: var(--text-muted);">${this.escapeHtml(m.created_at || '-')}</td>
        <td style="text-align: center;">
          <div style="display: flex; gap: 0.35rem; justify-content: center; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-edit-mat" data-type="${m.material_type}" title="表示名や問題・回答列の設定を変更" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; color: #2563eb;">
              ✏️ 編集
            </button>
            <button class="btn btn-secondary btn-clone-mat" data-type="${m.material_type}" title="向きを変えて別教材として複製" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; color: #7c3aed;">
              📋 複製
            </button>
            <button class="btn btn-secondary btn-export-pack" data-type="${m.material_type}" data-name="${m.display_name}" title="進捗・履歴を含む完全バックアップを出力" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; color: var(--primary);">
              📥 パック保存
            </button>
            <button class="btn btn-secondary btn-export-csv" data-type="${m.material_type}" data-name="${m.display_name}" title="元教材データ単体をCSV形式で出力" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;">
              📄 CSV
            </button>
            <button class="btn btn-secondary btn-delete-mat" data-type="${m.material_type}" title="教材と学習データを削除" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; color: var(--danger);">
              🗑️
            </button>
          </div>
        </td>
      `;
      tbody.appendChild(tr);
    });

    // 編集ボタンイベント
    tbody.querySelectorAll('.btn-edit-mat').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.currentTarget.getAttribute('data-type');
        this.openMaterialEditModal(type, 'edit');
      });
    });

    // 複製ボタンイベント
    tbody.querySelectorAll('.btn-clone-mat').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.currentTarget.getAttribute('data-type');
        this.openMaterialEditModal(type, 'clone');
      });
    });

    // パック保存ボタンイベント
    tbody.querySelectorAll('.btn-export-pack').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.currentTarget.getAttribute('data-type');
        const name = e.currentTarget.getAttribute('data-name');
        this.exportMaterialPackageFile(type, name);
      });
    });

    // CSV出力ボタンイベント
    tbody.querySelectorAll('.btn-export-csv').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const type = e.currentTarget.getAttribute('data-type');
        const name = e.currentTarget.getAttribute('data-name');
        this.exportMaterialCsvFile(type, name);
      });
    });

    // 削除ボタンイベント
    tbody.querySelectorAll('.btn-delete-mat').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const type = e.currentTarget.getAttribute('data-type');
        const listNow = this.dbService.getMaterialsList();
        if (listNow.length <= 1) {
          if (typeof alert !== 'undefined') alert('教材が1つしかないため削除できません。');
          return;
        }

        const confirmMsg = `教材「${type}」とその学習進捗・履歴ログを完全に削除しますか？\n（事前に「📥 パック保存」しておけばいつでも復元可能です）`;
        if (typeof confirm === 'undefined' || confirm(confirmMsg)) {
          await this.dbService.deleteMaterial(type);
          if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast(`教材「${type}」を削除しました。`, 'info');
          }
          if (this.app) {
            if (typeof this.app.refreshMaterialSelector === 'function') {
              await this.app.refreshMaterialSelector();
            }
            if (typeof this.app.onMaterialChanged === 'function') {
              await this.app.onMaterialChanged();
            }
          }
        }
      });
    });
  }

  /**
   * 教材設定編集・複製モーダルを開く
   */
  openMaterialEditModal(materialType, mode = 'edit') {
    if (!this.dbService) return;
    const meta = this.dbService.getMaterialMetadata(materialType);
    if (!meta) return;

    const modal = this.getEl('material-edit-modal');
    const titleEl = this.getEl('edit-modal-title');
    const modeEl = this.getEl('edit-modal-mode');
    const sourceEl = this.getEl('edit-source-material-type');
    const cloneGroup = this.getEl('clone-id-group');
    const newTypeInput = this.getEl('edit-new-material-type');
    const nameInput = this.getEl('edit-material-name');
    const promptSelect = this.getEl('edit-prompt-col');
    const answerSelect = this.getEl('edit-answer-col');
    const hintInput = this.getEl('edit-hint-cols');
    const promptSpeechColSelect = this.getEl('edit-prompt-speech-col');
    const answerSpeechColSelect = this.getEl('edit-answer-speech-col');
    const saveBtn = this.getEl('btn-save-material-edit');

    if (modeEl) modeEl.value = mode;
    if (sourceEl) sourceEl.value = materialType;

    // テーブルのカラム一覧を取得
    const cols = this.dbService.getMaterialTableColumns(materialType);

    // プルダウンのオプション構築
    if (promptSelect) promptSelect.innerHTML = cols.map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');
    if (answerSelect) answerSelect.innerHTML = cols.map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');

    if (promptSpeechColSelect) {
      promptSpeechColSelect.innerHTML = '<option value="">[標準] 問題・見出し列を使用</option>' + 
        cols.map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');
    }
    if (answerSpeechColSelect) {
      answerSpeechColSelect.innerHTML = '<option value="">[標準] 正解・意味列を使用</option>' + 
        cols.map(c => `<option value="${this.escapeHtml(c)}">${this.escapeHtml(c)}</option>`).join('');
    }

    if (promptSelect) promptSelect.value = meta.prompt_column || cols[0];
    if (answerSelect) answerSelect.value = meta.answer_column || cols[cols.length - 1];
    if (hintInput) hintInput.value = meta.hint_columns || '';
    if (promptSpeechColSelect) promptSpeechColSelect.value = meta.prompt_speech_column || '';
    if (answerSpeechColSelect) answerSpeechColSelect.value = meta.answer_speech_column || '';

    const promptLangSelect = this.getEl('edit-prompt-lang');
    const answerLangSelect = this.getEl('edit-answer-lang');
    if (promptLangSelect) promptLangSelect.value = meta.prompt_lang || 'auto';
    if (answerLangSelect) answerLangSelect.value = meta.answer_lang || 'auto';

    if (mode === 'edit') {
      if (titleEl) titleEl.textContent = '✏️ 教材設定の編集';
      if (cloneGroup) cloneGroup.style.display = 'none';
      if (nameInput) nameInput.value = meta.display_name;
      if (saveBtn) saveBtn.textContent = '設定を保存';
    } else {
      if (titleEl) titleEl.textContent = '📋 教材を複製して別学習を作成';
      if (cloneGroup) cloneGroup.style.display = 'block';
      if (newTypeInput) newTypeInput.value = `${meta.material_type}_copy`;
      if (nameInput) nameInput.value = `${meta.display_name} (複製)`;
      if (saveBtn) saveBtn.textContent = '別教材として作成';
    }

    if (modal) modal.style.display = 'flex';
  }

  /**
   * 教材設定の保存（更新または複製）
   */
  async saveMaterialEdit() {
    const modeEl = this.getEl('edit-modal-mode');
    const sourceEl = this.getEl('edit-source-material-type');
    const nameInput = this.getEl('edit-material-name');
    const promptSelect = this.getEl('edit-prompt-col');
    const answerSelect = this.getEl('edit-answer-col');
    const hintInput = this.getEl('edit-hint-cols');
    const promptLangSelect = this.getEl('edit-prompt-lang');
    const answerLangSelect = this.getEl('edit-answer-lang');
    const promptSpeechColSelect = this.getEl('edit-prompt-speech-col');
    const answerSpeechColSelect = this.getEl('edit-answer-speech-col');

    const mode = modeEl ? modeEl.value : 'edit';
    const sourceType = sourceEl ? sourceEl.value : '';
    const displayName = nameInput ? nameInput.value.trim() : '';
    const promptColumn = promptSelect ? promptSelect.value : '';
    const answerColumn = answerSelect ? answerSelect.value : '';
    const hintColumns = hintInput ? hintInput.value.trim() : '';
    const promptLang = promptLangSelect ? promptLangSelect.value : 'auto';
    const answerLang = answerLangSelect ? answerLangSelect.value : 'auto';
    const promptSpeechColumn = promptSpeechColSelect ? promptSpeechColSelect.value : '';
    const answerSpeechColumn = answerSpeechColSelect ? answerSpeechColSelect.value : '';

    if (!displayName) {
      if (typeof alert !== 'undefined') alert('教材表示名を入力してください。');
      return;
    }

    try {
      if (mode === 'edit') {
        await this.dbService.updateMaterialMetadata({
          materialType: sourceType,
          displayName,
          promptColumn,
          hintColumns,
          answerColumn,
          promptLang,
          answerLang,
          promptSpeechColumn,
          answerSpeechColumn
        });
        if (this.app && typeof this.app.showToast === 'function') {
          this.app.showToast(`教材「${displayName}」の設定を更新しました。`, 'success');
        }
      } else {
        const newTypeInput = this.getEl('edit-new-material-type');
        const newType = newTypeInput ? newTypeInput.value.trim() : '';
        if (!newType) {
          if (typeof alert !== 'undefined') alert('新規教材IDを入力してください。');
          return;
        }

        const res = await this.dbService.cloneMaterial({
          sourceMaterialType: sourceType,
          newMaterialType: newType,
          newDisplayName: displayName,
          promptColumn,
          hintColumns,
          answerColumn,
          promptLang,
          answerLang,
          promptSpeechColumn,
          answerSpeechColumn
        });

        if (this.app && typeof this.app.showToast === 'function') {
          this.app.showToast(`教材「${res.display_name}」を作成しました！`, 'success');
        }
        if (this.app) {
          this.app.materialType = res.material_type;
        }
      }

      const modal = this.getEl('material-edit-modal');
      if (modal) modal.style.display = 'none';

      if (this.app) {
        if (typeof this.app.refreshMaterialSelector === 'function') {
          await this.app.refreshMaterialSelector();
        }
        if (mode === 'clone') {
          const matSelect = this.getEl('material-select');
          if (matSelect) matSelect.value = this.app.materialType;
        }
        if (typeof this.app.onMaterialChanged === 'function') {
          await this.app.onMaterialChanged();
        }
        if (typeof this.app.updateFileSyncUI === 'function') {
          this.app.updateFileSyncUI();
        }
      }
    } catch (err) {
      console.error('[MaterialManager] Save material edit error:', err);
      if (typeof alert !== 'undefined') alert('保存に失敗しました: ' + err.message);
    }
  }

  /**
   * 教材パック(JSON)のエクスポート
   */
  exportMaterialPackageFile(materialType, displayName) {
    try {
      const pkg = this.dbService.exportMaterialPackage(materialType);
      const jsonStr = JSON.stringify(pkg, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (displayName || materialType).replace(/[^a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, '_');
      const dateStr = new Date().toISOString().slice(0, 10);
      a.href = url;
      a.download = `${safeName}_learning_pack_${dateStr}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast(`教材パック「${displayName}」を出力しました。`, 'success');
      }
    } catch (err) {
      console.error('[MaterialManager] Export pack error:', err);
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast('パック出力に失敗しました: ' + err.message, 'danger');
      }
    }
  }

  /**
   * 元教材CSVのエクスポート
   */
  exportMaterialCsvFile(materialType, displayName) {
    try {
      const csvStr = this.dbService.exportMaterialAsCsv(materialType);
      const blob = new Blob([new Uint8Array([0xEF, 0xBB, 0xBF]), csvStr], { type: 'text/csv;charset=utf-8;' }); // UTF-8 BOM付き
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const safeName = (displayName || materialType).replace(/[^a-zA-Z0-9_\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g, '_');
      a.href = url;
      a.download = `${safeName}_materials.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast(`教材CSV「${displayName}」を出力しました。`, 'success');
      }
    } catch (err) {
      console.error('[MaterialManager] Export CSV error:', err);
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast('CSV出力に失敗しました: ' + err.message, 'danger');
      }
    }
  }

  /**
   * 教材パック(JSON)のインポート復元
   */
  async importMaterialPackageFile(file) {
    if (!file.name.endsWith('.json')) {
      if (typeof alert !== 'undefined') alert('教材パックファイル（.json）を選択してください。');
      return;
    }

    try {
      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast('教材パックを復元中...');
      }
      const text = await file.text();
      const pkg = JSON.parse(text);
      const res = await this.dbService.importMaterialPackage(pkg);

      if (this.app && typeof this.app.showToast === 'function') {
        this.app.showToast(`教材「${res.displayName}」を復元しました！（${res.totalItems}項目、進捗${res.progressCount}件、ログ${res.logsCount}件）`, 'success');
      }

      if (this.app) {
        if (typeof this.app.refreshMaterialSelector === 'function') {
          await this.app.refreshMaterialSelector();
        }
        const matSelect = this.getEl('material-select');
        if (matSelect) matSelect.value = res.materialType;
        this.app.materialType = res.materialType;
        if (typeof this.app.onMaterialChanged === 'function') {
          await this.app.onMaterialChanged();
        }
      }
    } catch (err) {
      console.error('[MaterialManager] Import pack error:', err);
      if (typeof alert !== 'undefined') alert('教材パックの復元に失敗しました: ' + err.message);
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
  window.MaterialManager = MaterialManager;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = MaterialManager;
}
