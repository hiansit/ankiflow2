/**
 * FileSyncService - SQLite実ファイル（File System Access API）直接同期マネージャー
 * 
 * 責務:
 * 1. File System Access API (showOpenFilePicker / showSaveFilePicker) によるPC実ファイルの選択・保存
 * 2. 実ファイルハンドル (FileSystemFileHandle) への自動直接書き込みと同期状態管理
 * 3. ブラウザ互換フォールバック (Blobダウンロード / input[type=file])
 * 4. ファイル同期ステータスバー (UI) の表示更新
 * 5. 旧IndexedDBキャッシュのクリーンアップ（ディスク領域解放）
 */

class FileSyncService {
  constructor(dbService = null) {
    this.dbService = dbService;
    this.fileHandle = null;
    this.fileName = 'デモ版 (一時メモリ動作)';
    this.lastSavedAt = null;
    this.isModified = false;
    this.isPickerRunning = false;
  }

  /**
   * DBServiceのインスタンスをバインド
   */
  setDBService(dbService) {
    this.dbService = dbService;
  }

  /**
   * 実ファイルハンドルを設定
   */
  setFileHandle(handle) {
    this.fileHandle = handle;
    this.fileName = handle ? handle.name : 'デモ版 (一時メモリ動作)';
    this.lastSavedAt = handle ? new Date() : null;
    this.isModified = false;

    if (this.dbService) {
      this.dbService.fileHandle = this.fileHandle;
      this.dbService.fileName = this.fileName;
      this.dbService.lastSavedAt = this.lastSavedAt;
      this.dbService.isModified = false;
    }
  }

  /**
   * 連携中の実ファイルへ直接上書き保存（File System Access API）
   */
  async saveToFileHandle() {
    if (!this.fileHandle) {
      this.isModified = true;
      return false;
    }

    if (!this.dbService) {
      throw new Error('DBServiceが設定されていません。');
    }

    try {
      // 権限確認・要求（ユーザー操作コンテキストが残っていれば要求を試みる）
      if (typeof this.fileHandle.queryPermission === 'function') {
        const queryStatus = await this.fileHandle.queryPermission({ mode: 'readwrite' });
        if (queryStatus !== 'granted' && typeof this.fileHandle.requestPermission === 'function') {
          try {
            await this.fileHandle.requestPermission({ mode: 'readwrite' });
          } catch (pErr) {
            console.warn('[FileSyncService] Permission request deferred (requires user gesture):', pErr);
          }
        }
      }

      const binary = this.dbService.exportBinary();
      const writable = await this.fileHandle.createWritable();
      await writable.write(binary);
      await writable.close();

      this.lastSavedAt = new Date();
      this.isModified = false;
      console.log(`[FileSyncService] Successfully saved to local file: ${this.fileName} (${binary.length} bytes)`);
      return true;
    } catch (err) {
      // User activationエラーや権限未許可等の場合でも、業務処理（教材インポートや学習進行）を停止させないよう安全にフォールバック
      console.warn('[FileSyncService] Failed to write to local file handle (saved in memory, marked as modified):', err);
      this.isModified = true;
      if (this.dbService) {
        this.dbService.isModified = true;
      }
      return false;
    }
  }

  /**
   * 永続化ストレージへの保存（実ファイル同期）
   */
  async saveToStorage() {
    return await this.saveToFileHandle();
  }

  /**
   * 実ファイル（.db / .sqlite）をFile System Access APIで直接開く
   * @param {Object} callbacks - { onStart, onSuccess, onError, onCancel }
   */
  async openLocalFilePicker(callbacks = {}) {
    if (this.isPickerRunning) return;
    this.isPickerRunning = true;

    try {
      if (typeof window !== 'undefined' && typeof window.showOpenFilePicker === 'function') {
        let handle = null;
        try {
          const handles = await window.showOpenFilePicker({
            types: [{
              description: 'SQLite データベースファイル (*.db, *.sqlite)',
              accept: {
                'application/vnd.sqlite3': ['.db', '.sqlite', '.sqlite3'],
                'application/x-sqlite3': ['.db', '.sqlite', '.sqlite3'],
                'application/octet-stream': ['.db', '.sqlite', '.sqlite3']
              }
            }],
            multiple: false
          });
          if (handles && handles.length > 0) {
            handle = handles[0];
          }
        } catch (pickerErr) {
          if (pickerErr.name === 'AbortError') {
            if (callbacks.onCancel) callbacks.onCancel();
            return null;
          }
          console.warn('[FileSyncService] showOpenFilePicker failed, trying input fallback:', pickerErr);
        }

        // ファイルハンドルが正常に取得できた場合、後続処理を実行（エラー時はフォールバックしない）
        if (handle) {
          try {
            if (callbacks.onStart) callbacks.onStart(handle.name);

            // 書き込み権限の事前確認・要求（ユーザー操作直後のためプロンプト表示可能）
            if (typeof handle.requestPermission === 'function') {
              try {
                const queryStatus = typeof handle.queryPermission === 'function'
                  ? await handle.queryPermission({ mode: 'readwrite' })
                  : 'prompt';
                if (queryStatus !== 'granted') {
                  await handle.requestPermission({ mode: 'readwrite' });
                }
              } catch (permErr) {
                console.warn('[FileSyncService] Initial permission request warning:', permErr);
              }
            }

            const file = await handle.getFile();
            const arrayBuffer = await file.arrayBuffer();

            if (!this.dbService) throw new Error('DBServiceがバインドされていません。');
            await this.dbService.openDatabaseFromBuffer(arrayBuffer);
            this.setFileHandle(handle);

            if (callbacks.onSuccess) await callbacks.onSuccess(file);
            return file;
          } catch (err) {
            console.error('[FileSyncService] Error reading/initializing file:', err);
            if (callbacks.onError) callbacks.onError(err);
            else if (typeof alert !== 'undefined') alert('ファイル読み込みに失敗しました: ' + err.message);
            return null;
          }
        }
      }

      // フォールバック: 通常のinput[type=file] (showOpenFilePickerが非サポート、またはピッカー起動自体が失敗した場合)
      const input = document.getElementById('input-direct-file-open') || document.getElementById('input-import-db');
      if (input) {
        input.click();
      } else {
        const err = new Error('ファイル選択ダイアログを開けませんでした。');
        if (callbacks.onError) callbacks.onError(err);
        else if (typeof alert !== 'undefined') alert(err.message);
      }
    } finally {
      setTimeout(() => { this.isPickerRunning = false; }, 500);
    }
  }

  /**
   * 新規データベースファイルを作成して連携開始
   * @param {Object} callbacks - { onStart, onSuccess, onError, onCancel }
   */
  async createNewDatabasePicker(callbacks = {}) {
    if (this.isPickerRunning) return;
    this.isPickerRunning = true;

    try {
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        try {
          const dateStr = new Date().toISOString().slice(0, 10);
          const handle = await window.showSaveFilePicker({
            suggestedName: `learning_rank_${dateStr}.db`,
            types: [{
              description: 'SQLite データベースファイル (*.db)',
              accept: {
                'application/vnd.sqlite3': ['.db', '.sqlite'],
                'application/x-sqlite3': ['.db', '.sqlite'],
                'application/octet-stream': ['.db', '.sqlite']
              }
            }],
            excludeAcceptAllOption: false
          });

          if (callbacks.onStart) callbacks.onStart(handle.name);
          if (!this.dbService) throw new Error('DBServiceがバインドされていません。');

          await this.dbService.createNewDatabase();
          this.setFileHandle(handle);
          await this.saveToFileHandle();

          if (callbacks.onSuccess) await callbacks.onSuccess(handle);
          return handle;
        } catch (err) {
          if (err.name === 'AbortError') {
            if (callbacks.onCancel) callbacks.onCancel();
            return null;
          }
          console.warn('[FileSyncService] showSaveFilePicker failed:', err);
        }
      }

      // フォールバック: メモリ上で新規作成してダウンロード
      if (this.dbService) {
        await this.dbService.createNewDatabase();
        this.exportDatabaseFile();
        if (callbacks.onSuccess) await callbacks.onSuccess(null);
      }
    } finally {
      setTimeout(() => { this.isPickerRunning = false; }, 500);
    }
  }

  /**
   * PC上の任意の場所に実ファイルとして保存（名前を付けて保存）
   * @param {Object} callbacks - { onStart, onSuccess, onError, onCancel }
   */
  async saveAsLocalFilePicker(callbacks = {}) {
    if (this.isPickerRunning) return;
    this.isPickerRunning = true;

    try {
      if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
        try {
          const defaultName = (this.fileName && !this.fileName.includes('デモ版'))
            ? this.fileName
            : `learning_rank_${new Date().toISOString().slice(0, 10)}.db`;

          const handle = await window.showSaveFilePicker({
            suggestedName: defaultName,
            types: [{
              description: 'SQLite データベースファイル (*.db)',
              accept: {
                'application/vnd.sqlite3': ['.db', '.sqlite'],
                'application/x-sqlite3': ['.db', '.sqlite'],
                'application/octet-stream': ['.db', '.sqlite']
              }
            }],
            excludeAcceptAllOption: false
          });

          if (callbacks.onStart) callbacks.onStart(handle.name);
          this.setFileHandle(handle);
          await this.saveToFileHandle();

          if (callbacks.onSuccess) await callbacks.onSuccess(handle);
          return handle;
        } catch (err) {
          if (err.name === 'AbortError') {
            if (callbacks.onCancel) callbacks.onCancel();
            return null;
          }
          console.warn('[FileSyncService] showSaveFilePicker failed, fallback to download:', err);
        }
      }

      // フォールバック: 通常のダウンロード保存
      this.exportDatabaseFile();
      if (callbacks.onSuccess) await callbacks.onSuccess(null);
    } finally {
      setTimeout(() => { this.isPickerRunning = false; }, 500);
    }
  }

  /**
   * データベースファイルを通常ダウンロード（Blobエクスポート）
   */
  exportDatabaseFile(defaultName = null) {
    if (!this.dbService) throw new Error('DBServiceが設定されていません。');
    const binary = this.dbService.exportBinary();
    const blob = new Blob([binary], { type: 'application/x-sqlite3' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const now = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = defaultName || `learning_rank_${now}.sqlite`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * 実ファイル同期ステータスバーの表示更新
   */
  updateSyncBarUI(elements = {}) {
    const nameEl = elements.nameEl || document.getElementById('file-sync-name');
    const badgeEl = elements.badgeEl || document.getElementById('file-sync-status-badge');
    const detailsEl = elements.detailsEl || document.getElementById('file-sync-details');
    const iconEl = elements.iconEl || document.getElementById('file-sync-icon');

    if (!nameEl || !badgeEl || !detailsEl) return;

    if (this.fileHandle && this.fileName) {
      nameEl.textContent = this.fileName;
      if (this.isModified) {
        badgeEl.className = 'sync-badge sync-warning';
        badgeEl.textContent = '⚠️ 未同期の変更あり';
        if (iconEl) iconEl.textContent = '💾';
        const timeStr = this.lastSavedAt
          ? this.lastSavedAt.toLocaleTimeString()
          : '未保存';
        detailsEl.innerHTML = `前回保存: <b>${timeStr}</b>（実ファイルへ保存するには「💾 実ファイルに保存 (同期)」を押してください）`;
      } else {
        badgeEl.className = 'sync-badge sync-success';
        badgeEl.textContent = '🟢 自動同期中';
        if (iconEl) iconEl.textContent = '🗄️';

        const timeStr = this.lastSavedAt
          ? this.lastSavedAt.toLocaleTimeString()
          : '保存済み';
        detailsEl.innerHTML = `最終保存: <b>${timeStr}</b>（PC上の実ファイルが直接自動更新されています）`;
      }
    } else {
      nameEl.textContent = '未接続 (メモリ動作中)';
      badgeEl.className = 'sync-badge sync-warning';
      badgeEl.textContent = '⚠️ 未保存';
      if (iconEl) iconEl.textContent = '📁';
      detailsEl.textContent = 'PC上の実ファイル（.db）を開くか新規保存すると、学習のたびに手元のファイルへ直接自動保存されます';
    }
  }

  /**
   * 過去のセッションでIndexedDBに保存されてしまった旧大容量キャッシュを完全に消去（ディスク領域解放）
   */
  async cleanupLegacyIndexedDBCache() {
    if (typeof indexedDB === 'undefined') return;
    try {
      const legacyDbName = 'learning_rank_db_storage';
      const req = indexedDB.deleteDatabase(legacyDbName);
      req.onsuccess = () => {
        console.log('[FileSyncService] Cleaned up legacy IndexedDB database cache to free disk space.');
      };
      req.onerror = () => {};
    } catch (e) {
      // ignore
    }
  }
}

if (typeof window !== 'undefined') {
  window.FileSyncService = FileSyncService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = FileSyncService;
}
