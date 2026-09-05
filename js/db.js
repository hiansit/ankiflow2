/**
 * 汎用記憶定着・項目別ランク学習管理システム
 * データベースサービスクラス (SQLite Wasm / sql.js)
 */

let FileSyncServiceClass = typeof FileSyncService !== 'undefined' ? FileSyncService : null;
if (!FileSyncServiceClass && typeof require === 'function') {
  try {
    FileSyncServiceClass = require('./file_sync');
  } catch (e) {}
}

class DBService {
  constructor() {
    this.SQL = null;
    this.db = null;
    this.isInitialized = false;

    // 実ファイル連携管理（FileSyncServiceへの委譲）
    this.fileSync = FileSyncServiceClass ? new FileSyncServiceClass(this) : null;
    this.fileHandle = null;
    this.fileName = null;
    this.lastSavedAt = null;
    this.isModified = false;
  }

  /**
   * sql.js Wasmエンジンの初期化
   */
  async init(wasmPath = 'lib/sql-wasm.wasm', dbBuffer = null) {
    if (!this.isInitialized) {
      if (typeof initSqlJs !== 'function') {
        throw new Error('initSqlJs is not defined. Ensure sql-wasm.js is loaded.');
      }

      // 過去のセッションでIndexedDBに保存された旧バイナリキャッシュを完全消去（領域解放）
      await this.cleanupLegacyIndexedDBCache();

      this.SQL = await initSqlJs({
        locateFile: (file) => wasmPath
      });

      this.isInitialized = true;
    }

    if (dbBuffer) {
      await this.openDatabaseFromBuffer(dbBuffer);
    }
    return this;
  }

  /**
   * バッファ（ArrayBufferまたはUint8Array）からデータベースを開く
   */
  async openDatabaseFromBuffer(buffer) {
    if (!this.SQL) {
      await this.init();
    }
    if (this.db) {
      this.db.close();
    }
    const uint8Array = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    this.db = new this.SQL.Database(uint8Array);
    await this.createSchemaAndSeed();
    return this.db;
  }

  /**
   * 新規の空データベースを作成
   */
  async createNewDatabase() {
    if (!this.SQL) throw new Error('SQLエンジンが初期化されていません。');
    if (this.db) {
      this.db.close();
    }
    this.db = new this.SQL.Database();
    await this.createSchemaAndSeed();
    return this.db;
  }

  /**
   * デモ用初期データベースをサーバーからフェッチして一時メモリにロード
   */
  async loadDemoDatabase() {
    if (!this.SQL) throw new Error('SQLエンジンが初期化されていません。');
    let dbBuffer = null;
    try {
      const response = await fetch('learning_rank.db');
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        dbBuffer = new Uint8Array(arrayBuffer);
      }
    } catch (err) {
      console.warn('Could not fetch demo learning_rank.db:', err);
    }

    if (this.db) {
      this.db.close();
    }

    if (dbBuffer) {
      this.db = new this.SQL.Database(dbBuffer);
      await this.createSchemaAndSeed();
    } else {
      this.db = new this.SQL.Database();
      await this.createSchemaAndSeed();
      await this.seedChineseTop50Sample();
    }

    this.fileHandle = null;
    this.fileName = 'デモ版 (一時メモリ動作)';
    this.lastSavedAt = null;
    this.isModified = false;
    return this.db;
  }




  /**
   * スキーマ作成と初期データ投入
   */
  async createSchemaAndSeed() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS RANK_SCALES (
        scale_id TEXT PRIMARY KEY,
        scale_name TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS RANK_DEFINITIONS (
        rank_def_id INTEGER PRIMARY KEY AUTOINCREMENT,
        scale_id TEXT NOT NULL,
        rank_level INTEGER NOT NULL,
        rank_label TEXT NOT NULL,
        color_code TEXT NOT NULL,
        default_interval_days INTEGER NOT NULL,
        FOREIGN KEY (scale_id) REFERENCES RANK_SCALES(scale_id)
      );

      CREATE TABLE IF NOT EXISTS ITEM_PROGRESS (
        progress_id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_type TEXT NOT NULL,
        material_item_id TEXT NOT NULL,
        current_rank_def_id INTEGER,
        total_attempts INTEGER DEFAULT 0,
        consecutive_success INTEGER DEFAULT 0,
        last_studied_at TEXT,
        next_review_at TEXT,
        FOREIGN KEY (current_rank_def_id) REFERENCES RANK_DEFINITIONS(rank_def_id),
        UNIQUE (material_type, material_item_id)
      );

      CREATE TABLE IF NOT EXISTS STUDY_LOGS (
        log_id INTEGER PRIMARY KEY AUTOINCREMENT,
        progress_id INTEGER NOT NULL,
        assessed_rank_def_id INTEGER NOT NULL,
        time_spent_ms INTEGER NOT NULL,
        studied_at TEXT NOT NULL,
        FOREIGN KEY (progress_id) REFERENCES ITEM_PROGRESS(progress_id),
        FOREIGN KEY (assessed_rank_def_id) REFERENCES RANK_DEFINITIONS(rank_def_id)
      );

      CREATE TABLE IF NOT EXISTS MATERIALS_CATALOG (
        catalog_id INTEGER PRIMARY KEY AUTOINCREMENT,
        material_type TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        table_name TEXT NOT NULL,
        id_column TEXT NOT NULL DEFAULT 'id',
        prompt_column TEXT NOT NULL,
        hint_columns TEXT,
        answer_column TEXT NOT NULL,
        prompt_lang TEXT DEFAULT 'auto',
        answer_lang TEXT DEFAULT 'auto',
        prompt_speech_column TEXT DEFAULT NULL,
        answer_speech_column TEXT DEFAULT NULL,
        total_items INTEGER DEFAULT 0,
        created_at TEXT NOT NULL
      );
    `);

    // カラムマイグレーション（prompt_lang, answer_lang, prompt_speech_column, answer_speech_column）
    try {
      this.db.run("ALTER TABLE MATERIALS_CATALOG ADD COLUMN prompt_lang TEXT DEFAULT 'auto';");
    } catch (e) {}
    try {
      this.db.run("ALTER TABLE MATERIALS_CATALOG ADD COLUMN answer_lang TEXT DEFAULT 'auto';");
    } catch (e) {}
    try {
      this.db.run("ALTER TABLE MATERIALS_CATALOG ADD COLUMN prompt_speech_column TEXT DEFAULT NULL;");
    } catch (e) {}
    try {
      this.db.run("ALTER TABLE MATERIALS_CATALOG ADD COLUMN answer_speech_column TEXT DEFAULT NULL;");
    } catch (e) {}

    // 評価スケールマスタ（評価システムの基盤マスタのみ投入）
    const scalesCount = this.queryOne('SELECT COUNT(*) as count FROM RANK_SCALES');
    if (!scalesCount || scalesCount.count === 0) {
      this.db.run(`
        INSERT INTO RANK_SCALES (scale_id, scale_name) VALUES ('simple_3', '3段階評価（シンプル）');
        INSERT INTO RANK_SCALES (scale_id, scale_name) VALUES ('detailed_5', '5段階評価（詳細）');

        INSERT INTO RANK_DEFINITIONS (scale_id, rank_level, rank_label, color_code, default_interval_days) VALUES
        ('simple_3', 1, '全然ダメ', '#ef4444', 1),
        ('simple_3', 2, 'まだまだ', '#f59e0b', 3),
        ('simple_3', 3, '完璧', '#10b981', 7),
        ('detailed_5', 1, '初見/不可', '#dc2626', 1),
        ('detailed_5', 2, 'ヒント要', '#f97316', 2),
        ('detailed_5', 3, '遅い/要復習', '#eab308', 4),
        ('detailed_5', 4, '即答', '#22c55e', 7),
        ('detailed_5', 5, '完全定着', '#06b6d4', 14);
      `);
    }
  }

  /**
   * サンプル教材（chinese_top50）の明示的シード投入（デモ・テスト用）
   */
  async seedChineseTop50Sample() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS chinese_top50 (
        id INTEGER PRIMARY KEY,
        word TEXT NOT NULL,
        zhuyin TEXT,
        pinyin TEXT,
        meaning_ja TEXT NOT NULL
      );
    `);

    const itemsCount = this.queryOne('SELECT COUNT(*) as count FROM chinese_top50');
    if (!itemsCount || itemsCount.count === 0) {
      let csvText = '';
      if (typeof window === 'undefined') {
        try {
          const fs = require('fs');
          if (fs.existsSync('chinese_top50_sample.csv')) {
            csvText = fs.readFileSync('chinese_top50_sample.csv', 'utf-8');
          }
        } catch (e) {}
      } else {
        try {
          const res = await fetch('chinese_top50_sample.csv');
          if (res.ok) {
            csvText = await res.text();
          }
        } catch (err) {
          console.warn('Could not fetch CSV from server.', err);
        }
      }

      if (csvText) {
        this.importRawCsvData('chinese_top50', csvText);
      }
    }

    const catalogCount = this.queryOne("SELECT COUNT(*) as count FROM MATERIALS_CATALOG WHERE material_type = 'chinese_top50'");
    if (!catalogCount || catalogCount.count === 0) {
      const actualCount = this.queryOne('SELECT COUNT(*) as count FROM chinese_top50')?.count || 50;
      this.db.run(`
        INSERT OR IGNORE INTO MATERIALS_CATALOG (
          material_type, display_name, table_name, id_column, prompt_column, hint_columns, answer_column, prompt_lang, answer_lang, total_items, created_at
        ) VALUES (
          'chinese_top50', '繁体字中文 出る順Top50', 'chinese_top50', 'id', 'word', 'zhuyin,pinyin', 'meaning_ja', 'zh-TW', 'ja-JP', ?, datetime('now', 'localtime')
        )
      `, [actualCount]);
    }
  }

  /**
   * 登録されている教材一覧を取得（純粋なカタログ参照）
   */
  getMaterialsList() {
    let rows = this.query('SELECT * FROM MATERIALS_CATALOG ORDER BY catalog_id ASC');
    if (!rows) return [];

    // 各教材の実テーブルの最新件数を同期
    for (const r of rows) {
      try {
        const countRow = this.queryOne(`SELECT COUNT(*) as cnt FROM ${r.table_name}`);
        r.total_items = countRow ? countRow.cnt : 0;
      } catch (e) {
        r.total_items = 0;
      }
    }
    return rows;
  }



  /**
   * 指定教材のメタデータを取得
   */
  getMaterialMetadata(materialType) {
    let meta = this.queryOne('SELECT * FROM MATERIALS_CATALOG WHERE material_type = ?', [materialType]);
    if (!meta) {
      // フォールバック（chinese_top50）
      meta = {
        material_type: materialType,
        display_name: materialType,
        table_name: materialType,
        id_column: 'id',
        prompt_column: 'word',
        hint_columns: 'zhuyin,pinyin',
        answer_column: 'meaning_ja',
        total_items: 0
      };
    }
    return meta;
  }

  /**
   * 新規CSVから教材テーブルを作成しカタログに登録
   */
  async importNewMaterialFromCsv({
    materialType,
    displayName,
    csvText,
    idColumn = 'id',
    promptColumn,
    hintColumns = '',
    answerColumn,
    promptLang = 'auto',
    answerLang = 'auto',
    promptSpeechColumn = null,
    answerSpeechColumn = null
  }) {

    if (!materialType || !displayName || !csvText) {
      throw new Error('教材ID、表示名、CSVデータは必須です。');
    }

    // テーブル名・IDサニタイズ（半角英数字とアンダースコアのみ）
    const safeMaterialType = materialType.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    if (!safeMaterialType) {
      throw new Error('有効な教材識別子を入力してください（半角英数推奨）。');
    }

    const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) {
      throw new Error('CSVにはヘッダー行と少なくとも1行のデータが必要です。');
    }

    const headers = this.parseCsvLine(lines[0]);
    if (headers.length === 0) {
      throw new Error('CSVのヘッダー行を解析できませんでした。');
    }

    // ヘッダーカラム名のサニタイズ
    const safeHeaders = headers.map((h, i) => h.trim().replace(/[^a-zA-Z0-9_]/g, '_') || `col_${i+1}`);
    
    // id列の確認・決定
    let targetIdCol = idColumn;
    const hasExplicitId = safeHeaders.includes(idColumn);

    // DDL作成
    let createSql = `CREATE TABLE IF NOT EXISTS ${safeMaterialType} (\n`;
    if (!hasExplicitId) {
      createSql += `  id INTEGER PRIMARY KEY AUTOINCREMENT,\n`;
      targetIdCol = 'id';
    }
    const colDefs = safeHeaders.map(col => {
      if (col === targetIdCol && hasExplicitId) {
        return `  ${col} INTEGER PRIMARY KEY`;
      }
      return `  ${col} TEXT`;
    });
    createSql += colDefs.join(',\n') + '\n);';

    // 既存テーブルがあれば削除して新規作成
    this.db.run(`DROP TABLE IF EXISTS ${safeMaterialType};`);
    this.db.run(createSql);

    // データINSERT
    const placeholders = safeHeaders.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${safeMaterialType} (${safeHeaders.join(', ')}) VALUES (${placeholders});`;
    const stmt = this.db.prepare(insertSql);

    let insertedCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const parts = this.parseCsvLine(lines[i]);
      if (parts.length > 0 && parts.some(p => p.length > 0)) {
        // カラム長調整
        const rowVals = [];
        for (let c = 0; c < safeHeaders.length; c++) {
          rowVals.push(parts[c] !== undefined ? parts[c] : '');
        }
        stmt.run(rowVals);
        insertedCount++;
      }
    }
    stmt.free();

    // デフォルトのカラムマッピング推定（指定がなければ）
    let safePromptCol = promptColumn;
    let safeAnswerCol = answerColumn;
    let safeHintCols = hintColumns;

    if (!safePromptCol) {
      safePromptCol = safeHeaders.find(h => ['word', 'prompt', 'question', 'term', '見出し', '問題', '単語', '年号', 'year'].includes(h.toLowerCase())) || safeHeaders[hasExplicitId ? 1 : 0] || safeHeaders[0];
    }
    if (!safeAnswerCol) {
      safeAnswerCol = safeHeaders.find(h => ['meaning', 'meaning_ja', 'answer', 'translation', '意味', '訳', '解答', '正解', '出来事', 'event', 'explanation'].includes(h.toLowerCase())) || safeHeaders[safeHeaders.length - 1];
    }
    if (safeHintCols === undefined || safeHintCols === null) {
      safeHintCols = safeHeaders.filter(h => h !== targetIdCol && h !== safePromptCol && h !== safeAnswerCol).join(',');
    }

    // カタログ登録
    this.db.run(`
      INSERT OR REPLACE INTO MATERIALS_CATALOG (
        material_type, display_name, table_name, id_column, prompt_column, hint_columns, answer_column, prompt_lang, answer_lang, prompt_speech_column, answer_speech_column, total_items, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `, [safeMaterialType, displayName, safeMaterialType, targetIdCol, safePromptCol, safeHintCols, safeAnswerCol, promptLang || 'auto', answerLang || 'auto', promptSpeechColumn || null, answerSpeechColumn || null, insertedCount]);

    await this.saveToStorage();

    return {
      materialType: safeMaterialType,
      displayName,
      totalItems: insertedCount,
      headers: safeHeaders,
      promptColumn: safePromptCol,
      hintColumns: safeHintCols,
      answerColumn: safeAnswerCol,
      promptLang: promptLang || 'auto',
      answerLang: answerLang || 'auto',
      promptSpeechColumn: promptSpeechColumn || null,
      answerSpeechColumn: answerSpeechColumn || null
    };
  }


  /**
   * 教材の削除
   */
  async deleteMaterial(materialType) {
    if (materialType === 'chinese_top50') {
      // サンプル教材は削除可能だが、全削除を避けるため確認
    }

    // 1. カタログ削除
    this.db.run('DELETE FROM MATERIALS_CATALOG WHERE material_type = ?', [materialType]);

    // 2. テーブル削除
    try {
      this.db.run(`DROP TABLE IF EXISTS ${materialType}`);
    } catch (e) {
      console.warn('Error dropping table:', e);
    }

    // 3. 進捗・学習ログ削除
    this.db.run(`
      DELETE FROM STUDY_LOGS 
      WHERE progress_id IN (SELECT progress_id FROM ITEM_PROGRESS WHERE material_type = ?)
    `, [materialType]);

    this.db.run('DELETE FROM ITEM_PROGRESS WHERE material_type = ?', [materialType]);

    await this.saveToStorage();
  }

  /**
   * 教材＋学習進捗＋学習履歴ログをポータブルパッケージ(JSON)としてエクスポート
   */
  exportMaterialPackage(materialType) {
    const meta = this.getMaterialMetadata(materialType);
    if (!meta) {
      throw new Error(`教材「${materialType}」が見つかりません。`);
    }

    // 1. カタログ情報
    const catalog = {
      material_type: meta.material_type,
      display_name: meta.display_name,
      table_name: meta.table_name,
      id_column: meta.id_column || 'id',
      prompt_column: meta.prompt_column,
      hint_columns: meta.hint_columns,
      answer_column: meta.answer_column,
      prompt_lang: meta.prompt_lang || 'auto',
      answer_lang: meta.answer_lang || 'auto',
      prompt_speech_column: meta.prompt_speech_column || null,
      answer_speech_column: meta.answer_speech_column || null
    };


    // 2. 教材全データ
    const items = this.query(`SELECT * FROM ${meta.table_name} ORDER BY ${meta.id_column || 'id'} ASC`);

    // 3. 進捗データ
    const progressRows = this.query(`
      SELECT 
        p.material_item_id,
        p.total_attempts,
        p.consecutive_success,
        p.last_studied_at,
        p.next_review_at,
        rd.scale_id,
        rd.rank_level
      FROM ITEM_PROGRESS p
      LEFT JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
      WHERE p.material_type = ?
    `, [materialType]);

    // 4. 学習履歴ログ
    const logsRows = this.query(`
      SELECT 
        p.material_item_id,
        l.time_spent_ms,
        l.studied_at,
        rd.scale_id,
        rd.rank_level
      FROM STUDY_LOGS l
      JOIN ITEM_PROGRESS p ON l.progress_id = p.progress_id
      JOIN RANK_DEFINITIONS rd ON l.assessed_rank_def_id = rd.rank_def_id
      WHERE p.material_type = ?
      ORDER BY l.log_id ASC
    `, [materialType]);

    return {
      version: '1.0',
      exported_at: this.formatDate(new Date()),
      catalog,
      items,
      progress: progressRows,
      logs: logsRows
    };
  }

  /**
   * ポータブルパッケージ(JSON)から教材・進捗・履歴ログを完全復元
   */
  async importMaterialPackage(pkg) {
    if (!pkg || !pkg.catalog || !pkg.items) {
      throw new Error('無効な教材パッケージファイルです。');
    }

    const { catalog, items, progress = [], logs = [] } = pkg;
    const materialType = catalog.material_type.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    const displayName = catalog.display_name || materialType;
    const idCol = catalog.id_column || 'id';

    if (items.length === 0) {
      throw new Error('教材データが空です。');
    }

    // 1. テーブルDDL作成
    const firstItem = items[0];
    const itemCols = Object.keys(firstItem);
    
    let createSql = `CREATE TABLE IF NOT EXISTS ${materialType} (\n`;
    const colDefs = itemCols.map(col => {
      if (col === idCol) {
        return `  ${col} INTEGER PRIMARY KEY`;
      }
      return `  ${col} TEXT`;
    });
    createSql += colDefs.join(',\n') + '\n);';

    // 既存テーブル削除＆作成
    this.db.run(`DROP TABLE IF EXISTS ${materialType};`);
    this.db.run(createSql);

    // 2. アイテムINSERT
    const placeholders = itemCols.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${materialType} (${itemCols.join(', ')}) VALUES (${placeholders});`;
    const stmt = this.db.prepare(insertSql);

    for (const row of items) {
      const vals = itemCols.map(c => row[c] !== undefined ? row[c] : null);
      stmt.run(vals);
    }
    stmt.free();

    // 3. カタログ登録
    this.db.run(`
      INSERT OR REPLACE INTO MATERIALS_CATALOG (
        material_type, display_name, table_name, id_column, prompt_column, hint_columns, answer_column, prompt_lang, answer_lang, prompt_speech_column, answer_speech_column, total_items, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      materialType,
      displayName,
      materialType,
      idCol,
      catalog.prompt_column || itemCols[1] || 'word',
      catalog.hint_columns || '',
      catalog.answer_column || itemCols[itemCols.length - 1] || 'meaning_ja',
      catalog.prompt_lang || 'auto',
      catalog.answer_lang || 'auto',
      catalog.prompt_speech_column || null,
      catalog.answer_speech_column || null,
      items.length,
      pkg.exported_at || this.formatDate(new Date())
    ]);


    // 4. 進捗データ削除＆復元
    this.db.run('DELETE FROM ITEM_PROGRESS WHERE material_type = ?', [materialType]);
    const progressIdMap = {}; // material_item_id -> progress_id

    for (const prog of progress) {
      let targetRankDefId = null;
      if (prog.scale_id && prog.rank_level) {
        const defRow = this.queryOne(`
          SELECT rank_def_id FROM RANK_DEFINITIONS 
          WHERE scale_id = ? AND rank_level = ?
        `, [prog.scale_id, prog.rank_level]);
        if (defRow) targetRankDefId = defRow.rank_def_id;
      }

      this.db.run(`
        INSERT INTO ITEM_PROGRESS (
          material_type, material_item_id, current_rank_def_id,
          total_attempts, consecutive_success, last_studied_at, next_review_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [
        materialType,
        String(prog.material_item_id),
        targetRankDefId,
        prog.total_attempts || 0,
        prog.consecutive_success || 0,
        prog.last_studied_at || null,
        prog.next_review_at || null
      ]);

      const lastIdRow = this.queryOne('SELECT last_insert_rowid() as id');
      if (lastIdRow) {
        progressIdMap[String(prog.material_item_id)] = lastIdRow.id;
      }
    }

    // 5. 学習履歴ログ復元
    for (const log of logs) {
      let progressId = progressIdMap[String(log.material_item_id)];
      if (!progressId) {
        // progressが存在しない場合のフォールバック作成
        this.db.run(`
          INSERT INTO ITEM_PROGRESS (
            material_type, material_item_id, current_rank_def_id, total_attempts, consecutive_success, last_studied_at, next_review_at
          ) VALUES (?, ?, NULL, 1, 0, ?, ?)
        `, [materialType, String(log.material_item_id), log.studied_at, null]);
        const lastIdRow = this.queryOne('SELECT last_insert_rowid() as id');
        progressId = lastIdRow.id;
        progressIdMap[String(log.material_item_id)] = progressId;
      }

      let assessedRankDefId = null;
      if (log.scale_id && log.rank_level) {
        const defRow = this.queryOne(`
          SELECT rank_def_id FROM RANK_DEFINITIONS 
          WHERE scale_id = ? AND rank_level = ?
        `, [log.scale_id, log.rank_level]);
        if (defRow) assessedRankDefId = defRow.rank_def_id;
      }

      if (assessedRankDefId && progressId) {
        this.db.run(`
          INSERT INTO STUDY_LOGS (progress_id, assessed_rank_def_id, time_spent_ms, studied_at)
          VALUES (?, ?, ?, ?)
        `, [progressId, assessedRankDefId, log.time_spent_ms || 0, log.studied_at]);
      }
    }

    await this.saveToStorage();

    return {
      materialType,
      displayName,
      totalItems: items.length,
      progressCount: progress.length,
      logsCount: logs.length
    };
  }

  /**
   * 元教材データをCSV文字列としてエクスポート
   */
  exportMaterialAsCsv(materialType) {
    const meta = this.getMaterialMetadata(materialType);
    const items = this.query(`SELECT * FROM ${meta.table_name} ORDER BY ${meta.id_column || 'id'} ASC`);
    if (items.length === 0) return '';

    const cols = Object.keys(items[0]);
    const escapeCsv = val => {
      if (val === null || val === undefined) return '';
      const str = String(val);
      if (str.includes(',') || str.includes('"') || str.includes('\n')) {
        return `"${str.replace(/"/g, '""')}"`;
      }
      return str;
    };

    let csv = cols.map(escapeCsv).join(',') + '\n';
    items.forEach(row => {
      csv += cols.map(c => escapeCsv(row[c])).join(',') + '\n';
    });
    return csv;
  }

  /**
   * 教材テーブルのカラム一覧を取得
   */
  getMaterialTableColumns(materialType) {
    const meta = this.getMaterialMetadata(materialType);
    const tableInfo = this.query(`PRAGMA table_info(${meta.table_name})`);
    return tableInfo.map(c => c.name);
  }

  /**
   * 教材の表示名・問題列・回答列・補足列・読み上げ言語・発音対象列のメタデータを更新
   */
  async updateMaterialMetadata({
    materialType,
    displayName,
    promptColumn,
    hintColumns = '',
    answerColumn,
    promptLang = 'auto',
    answerLang = 'auto',
    promptSpeechColumn = null,
    answerSpeechColumn = null
  }) {
    if (!materialType || !displayName || !promptColumn || !answerColumn) {
      throw new Error('教材ID、表示名、問題列、回答列は必須です。');
    }

    const safePromptSpeechCol = (promptSpeechColumn && promptSpeechColumn.trim() !== '') ? promptSpeechColumn.trim() : null;
    const safeAnswerSpeechCol = (answerSpeechColumn && answerSpeechColumn.trim() !== '') ? answerSpeechColumn.trim() : null;

    const stmt = this.db.prepare(`
      UPDATE MATERIALS_CATALOG
      SET display_name = ?,
          prompt_column = ?,
          hint_columns = ?,
          answer_column = ?,
          prompt_lang = ?,
          answer_lang = ?,
          prompt_speech_column = ?,
          answer_speech_column = ?
      WHERE material_type = ?
    `);
    stmt.run([
      displayName,
      promptColumn,
      hintColumns,
      answerColumn,
      promptLang || 'auto',
      answerLang || 'auto',
      safePromptSpeechCol,
      safeAnswerSpeechCol,
      materialType
    ]);
    stmt.free();

    await this.saveToStorage();

    return this.getMaterialMetadata(materialType);
  }

  /**
   * 既存教材を複製して別の学習用途（例: 日→中、ピンイン特化など）の教材を作成
   */
  async cloneMaterial({
    sourceMaterialType,
    newMaterialType,
    newDisplayName,
    promptColumn,
    hintColumns = '',
    answerColumn,
    promptLang = 'auto',
    answerLang = 'auto',
    promptSpeechColumn = undefined,
    answerSpeechColumn = undefined
  }) {
    if (!sourceMaterialType || !newMaterialType || !newDisplayName) {
      throw new Error('複製元ID、新規ID、表示名は必須です。');
    }

    const safeNewType = newMaterialType.trim().replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
    const sourceMeta = this.getMaterialMetadata(sourceMaterialType);

    // 新テーブルを作成して全データを複製
    this.db.run(`DROP TABLE IF EXISTS ${safeNewType};`);
    this.db.run(`CREATE TABLE ${safeNewType} AS SELECT * FROM ${sourceMeta.table_name};`);

    // 総件数取得
    const countRow = this.queryOne(`SELECT COUNT(*) as cnt FROM ${safeNewType}`);
    const totalItems = countRow ? countRow.cnt : 0;

    const finalPromptSpeechCol = promptSpeechColumn !== undefined 
      ? (promptSpeechColumn && promptSpeechColumn.trim() !== '' ? promptSpeechColumn.trim() : null)
      : (sourceMeta.prompt_speech_column || null);
    const finalAnswerSpeechCol = answerSpeechColumn !== undefined 
      ? (answerSpeechColumn && answerSpeechColumn.trim() !== '' ? answerSpeechColumn.trim() : null)
      : (sourceMeta.answer_speech_column || null);

    // カタログ登録
    this.db.run(`
      INSERT OR REPLACE INTO MATERIALS_CATALOG (
        material_type, display_name, table_name, id_column, prompt_column, hint_columns, answer_column, prompt_lang, answer_lang, prompt_speech_column, answer_speech_column, total_items, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `, [
      safeNewType,
      newDisplayName,
      safeNewType,
      sourceMeta.id_column || 'id',
      promptColumn || sourceMeta.prompt_column,
      hintColumns !== undefined ? hintColumns : sourceMeta.hint_columns,
      answerColumn || sourceMeta.answer_column,
      promptLang || sourceMeta.prompt_lang || 'auto',
      answerLang || sourceMeta.answer_lang || 'auto',
      finalPromptSpeechCol,
      finalAnswerSpeechCol,
      totalItems
    ]);

    await this.saveToStorage();

    return this.getMaterialMetadata(safeNewType);
  }




  /**
   * 生のCSVテキストを教材テーブルに直接投入
   */
  importRawCsvData(tableName, csvText) {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim().length > 0);
    if (lines.length < 2) return;

    const stmt = this.db.prepare(`INSERT OR REPLACE INTO ${tableName} (id, word, zhuyin, pinyin, meaning_ja) VALUES (?, ?, ?, ?, ?)`);
    for (let i = 1; i < lines.length; i++) {
      const parts = this.parseCsvLine(lines[i]);
      if (parts.length >= 5) {
        stmt.run([parseInt(parts[0], 10), parts[1], parts[2], parts[3], parts[4]]);
      }
    }
    stmt.free();
  }

  /**
   * 簡易CSV行パーサー（カンマ区切り、ダブルクォート対応）
   */
  parseCsvLine(text) {
    const result = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += char;
      }
    }
    result.push(cur.trim());
    return result;
  }

  /**
   * 汎用クエリ実行（オブジェクト配列で返す）
   */
  query(sql, params = []) {
    if (!this.db) return [];
    const stmt = this.db.prepare(sql);
    if (params && params.length > 0) {
      stmt.bind(params);
    }
    const rows = [];
    while (stmt.step()) {
      rows.push(stmt.getAsObject());
    }
    stmt.free();
    return rows;
  }

  /**
   * 単一レコード取得
   */
  queryOne(sql, params = []) {
    if (!this.db) return null;
    const rows = this.query(sql, params);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * 更新・挿入・削除の実行
   */
  run(sql, params = []) {
    if (!this.db) return;
    this.db.run(sql, params);
  }


  /**
   * スケール一覧を取得
   */
  getScaleList() {
    return this.query('SELECT scale_id, scale_name FROM RANK_SCALES ORDER BY scale_id');
  }

  getScales() {
    return this.getScaleList();
  }

  /**
   * 指定スケールのランク定義一覧を取得
   */
  getRankDefinitions(scaleId = 'simple_3') {
    return this.query(`
      SELECT rank_def_id, scale_id, rank_level, rank_label, color_code, default_interval_days
      FROM RANK_DEFINITIONS
      WHERE scale_id = ?
      ORDER BY rank_level ASC
    `, [scaleId]);
  }

  /**
   * 教材項目と学習進捗を結合して全件取得（動的カラム対応）
   */
  getItemsWithProgress(materialType = 'chinese_top50', filter = {}) {
    const meta = this.getMaterialMetadata(materialType);
    const idCol = meta.id_column || 'id';
    const promptCol = meta.prompt_column || 'word';
    const answerCol = meta.answer_column || 'meaning_ja';
    const hintColsStr = meta.hint_columns || '';
    const hintCols = hintColsStr ? hintColsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    let sql = `
      SELECT 
        m.*,
        m.${idCol} as item_id,
        m.${promptCol} as display_prompt,
        m.${answerCol} as display_answer,
        p.progress_id,
        p.current_rank_def_id,
        p.total_attempts,
        p.consecutive_success,
        p.last_studied_at,
        p.next_review_at,
        rd.scale_id,
        rd.rank_level,
        rd.rank_label,
        rd.color_code
      FROM ${meta.table_name} m
      LEFT JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
      LEFT JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
      WHERE 1=1
    `;

    const params = [];

    if (filter.search) {
      const searchFields = [promptCol, answerCol, ...hintCols].map(c => `m.${c} LIKE ?`).join(' OR ');
      sql += ` AND (${searchFields})`;
      const s = `%${filter.search}%`;
      for (let i = 0; i < 2 + hintCols.length; i++) {
        params.push(s);
      }
    }

    if (filter.rankDefId !== undefined && filter.rankDefId !== '') {
      if (filter.rankDefId === 'unstudied') {
        sql += ` AND (p.current_rank_def_id IS NULL)`;
      } else {
        sql += ` AND (p.current_rank_def_id = ?)`;
        params.push(parseInt(filter.rankDefId, 10));
      }
    }

    sql += ` ORDER BY m.${idCol} ASC`;
    return this.query(sql, params);
  }

  /**
   * 指定した出題範囲（ID連番）内における各定着ランクの単語数を集計
   * @param {string} materialType
   * @param {string} scaleId
   * @param {Object} options - { startId, endId }
   * @returns {Object} { total, unstudied, byRankDefId: { [rankDefId]: count } }
   */
  getRankDistributionByRange(materialType = 'chinese_top50', scaleId = 'simple_3', options = {}) {
    const meta = this.getMaterialMetadata(materialType);
    const rankDefs = this.getRankDefinitions ? this.getRankDefinitions(scaleId) : [];
    const result = {
      total: 0,
      unstudied: 0,
      byRankDefId: {}
    };
    rankDefs.forEach(d => {
      result.byRankDefId[d.rank_def_id] = 0;
    });

    if (!meta) return result;
    const idCol = meta.id_column || 'id';

    const startId = options.startId !== undefined && options.startId !== '' && options.startId !== null ? parseInt(options.startId, 10) : null;
    const endId = options.endId !== undefined && options.endId !== '' && options.endId !== null ? parseInt(options.endId, 10) : null;

    const extraConditions = [];
    const params = [];

    if (startId !== null && !isNaN(startId)) {
      extraConditions.push(`CAST(m.${idCol} AS INTEGER) >= ?`);
      params.push(startId);
    }
    if (endId !== null && !isNaN(endId)) {
      extraConditions.push(`CAST(m.${idCol} AS INTEGER) <= ?`);
      params.push(endId);
    }

    const whereClause = extraConditions.length > 0 ? ' AND ' + extraConditions.join(' AND ') : '';

    const sql = `
      SELECT 
        p.current_rank_def_id,
        COUNT(*) as cnt
      FROM ${meta.table_name} m
      LEFT JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
      WHERE 1=1 ${whereClause}
      GROUP BY p.current_rank_def_id
    `;

    try {
      const rows = this.query(sql, params);
      rows.forEach(r => {
        const count = r.cnt || 0;
        result.total += count;
        if (r.current_rank_def_id === null || r.current_rank_def_id === undefined) {
          result.unstudied += count;
        } else {
          result.byRankDefId[r.current_rank_def_id] = count;
        }
      });
      return result;
    } catch (e) {
      console.warn('[DBService] getRankDistributionByRange error:', e);
      return result;
    }
  }

  /**
   * 教材の最小・最大IDおよび総件数を取得
   */
  getMaterialIdRange(materialType = 'chinese_top50') {
    const meta = this.getMaterialMetadata(materialType);
    if (!meta) return { minId: 1, maxId: 1, totalCount: 0 };
    const idCol = meta.id_column || 'id';
    try {
      const row = this.queryOne(`
        SELECT 
          MIN(CAST(${idCol} AS INTEGER)) as min_id,
          MAX(CAST(${idCol} AS INTEGER)) as max_id,
          COUNT(*) as total_count
        FROM ${meta.table_name}
      `);
      return {
        minId: row && row.min_id !== null ? row.min_id : 1,
        maxId: row && row.max_id !== null ? row.max_id : 1,
        totalCount: row && row.total_count !== null ? row.total_count : 0
      };
    } catch (e) {
      console.warn('[DBService] getMaterialIdRange error:', e);
      return { minId: 1, maxId: 1, totalCount: 0 };
    }
  }

  /**
   * 指定条件に合致する出題対象件数のカウント
   */
  getStudyQueueCount(materialType = 'chinese_top50', mode = 'unmastered_first', scaleId = 'simple_3', optionsOrRankDefId = null) {
    const meta = this.getMaterialMetadata(materialType);
    if (!meta) return 0;
    const idCol = meta.id_column || 'id';

    let options = {};
    if (optionsOrRankDefId !== null && optionsOrRankDefId !== undefined) {
      if (typeof optionsOrRankDefId === 'object') {
        options = optionsOrRankDefId;
      } else {
        options = { rankDefId: optionsOrRankDefId };
      }
    }

    const startId = options.startId !== undefined && options.startId !== '' && options.startId !== null ? parseInt(options.startId, 10) : null;
    const endId = options.endId !== undefined && options.endId !== '' && options.endId !== null ? parseInt(options.endId, 10) : null;
    const rankDefId = options.rankDefId !== undefined && options.rankDefId !== '' && options.rankDefId !== null ? options.rankDefId : null;

    const extraConditions = [];
    const params = [];

    if (startId !== null && !isNaN(startId)) {
      extraConditions.push(`CAST(m.${idCol} AS INTEGER) >= ?`);
      params.push(startId);
    }
    if (endId !== null && !isNaN(endId)) {
      extraConditions.push(`CAST(m.${idCol} AS INTEGER) <= ?`);
      params.push(endId);
    }
    if (rankDefId !== null) {
      if (rankDefId === 'unstudied') {
        extraConditions.push(`p.current_rank_def_id IS NULL`);
      } else {
        extraConditions.push(`p.current_rank_def_id = ?`);
        params.push(parseInt(rankDefId, 10));
      }
    }

    const extraConditionsSql = extraConditions.length > 0 ? ' AND ' + extraConditions.join(' AND ') : '';

    let sql = '';
    if (mode === 'maintenance') {
      sql = `
        SELECT COUNT(*) as count
        FROM ${meta.table_name} m
        INNER JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
        INNER JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
        WHERE 1=1 ${extraConditionsSql}
      `;
    } else {
      sql = `
        SELECT COUNT(*) as count
        FROM ${meta.table_name} m
        LEFT JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
        LEFT JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
        WHERE 1=1 ${extraConditionsSql}
      `;
    }

    try {
      const row = this.queryOne(sql, params);
      return row ? row.count : 0;
    } catch (e) {
      console.warn('[DBService] getStudyQueueCount error:', e);
      return 0;
    }
  }

  /**
   * 学習キュー（出題リスト）の生成（動的カラム対応・ID順/範囲指定/ランク指定対応）
   * @param {string} materialType
   * @param {string} mode - 'unmastered_first' | 'maintenance' | 'sequential' | 'all_shuffle' | 'rank_filter'
   * @param {string} scaleId
   * @param {number|string} limit - 件数 (0または'all'で全件)
   * @param {Object|number|string} optionsOrRankDefId - { startId, endId, rankDefId } または 従来の targetRankDefId
   */
  getStudyQueue(materialType = 'chinese_top50', mode = 'unmastered_first', scaleId = 'simple_3', limit = 15, optionsOrRankDefId = null) {
    const meta = this.getMaterialMetadata(materialType);
    const idCol = meta.id_column || 'id';
    const promptCol = meta.prompt_column || 'word';
    const answerCol = meta.answer_column || 'meaning_ja';

    let options = {};
    if (optionsOrRankDefId !== null && optionsOrRankDefId !== undefined) {
      if (typeof optionsOrRankDefId === 'object') {
        options = optionsOrRankDefId;
      } else {
        options = { rankDefId: optionsOrRankDefId };
      }
    }

    const startId = options.startId !== undefined && options.startId !== '' && options.startId !== null ? parseInt(options.startId, 10) : null;
    const endId = options.endId !== undefined && options.endId !== '' && options.endId !== null ? parseInt(options.endId, 10) : null;
    let rankDefId = options.rankDefId !== undefined && options.rankDefId !== '' && options.rankDefId !== null ? options.rankDefId : null;

    // 後方互換性: mode === 'rank_filter' の場合の targetRankDefId
    if (mode === 'rank_filter' && !rankDefId && optionsOrRankDefId !== null) {
      rankDefId = optionsOrRankDefId;
    }

    const extraConditions = [];
    const params = [];

    if (startId !== null && !isNaN(startId)) {
      extraConditions.push(`CAST(m.${idCol} AS INTEGER) >= ?`);
      params.push(startId);
    }
    if (endId !== null && !isNaN(endId)) {
      extraConditions.push(`CAST(m.${idCol} AS INTEGER) <= ?`);
      params.push(endId);
    }
    if (rankDefId !== null) {
      if (rankDefId === 'unstudied') {
        extraConditions.push(`p.current_rank_def_id IS NULL`);
      } else {
        extraConditions.push(`p.current_rank_def_id = ?`);
        params.push(parseInt(rankDefId, 10));
      }
    }

    const extraConditionsSql = extraConditions.length > 0 ? ' AND ' + extraConditions.join(' AND ') : '';

    const isAllLimit = (limit === 0 || limit === 'all' || limit === -1 || limit === null || limit === undefined || parseInt(limit, 10) <= 0);
    const limitSql = isAllLimit ? '' : ' LIMIT ?';
    if (!isAllLimit) {
      params.push(parseInt(limit, 10));
    }

    let items = [];

    if (mode === 'sequential' || mode === 'id_sequential') {
      // 1. 連番・ID順学習モード（教材のID昇順通りに出題）
      const sql = `
        SELECT 
          m.*,
          m.${idCol} as item_id,
          m.${promptCol} as display_prompt,
          m.${answerCol} as display_answer,
          p.progress_id,
          p.current_rank_def_id,
          p.total_attempts,
          p.consecutive_success,
          p.last_studied_at,
          p.next_review_at,
          rd.scale_id,
          rd.rank_level,
          rd.rank_label,
          rd.color_code
        FROM ${meta.table_name} m
        LEFT JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
        LEFT JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
        WHERE 1=1 ${extraConditionsSql}
        ORDER BY CAST(m.${idCol} AS INTEGER) ASC
        ${limitSql}
      `;
      items = this.query(sql, params);

    } else if (mode === 'unmastered_first') {
      // 2. 未定着・苦手優先モード
      const sql = `
        SELECT 
          m.*,
          m.${idCol} as item_id,
          m.${promptCol} as display_prompt,
          m.${answerCol} as display_answer,
          p.progress_id,
          p.current_rank_def_id,
          p.total_attempts,
          p.consecutive_success,
          p.last_studied_at,
          p.next_review_at,
          rd.scale_id,
          rd.rank_level,
          rd.rank_label,
          rd.color_code,
          CASE 
            WHEN p.current_rank_def_id IS NULL THEN 0
            ELSE rd.rank_level 
          END as priority_rank
        FROM ${meta.table_name} m
        LEFT JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
        LEFT JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
        WHERE 1=1 ${extraConditionsSql}
        ORDER BY 
          priority_rank ASC,
          CASE WHEN p.next_review_at IS NOT NULL AND p.next_review_at <= datetime('now', 'localtime') THEN 0 ELSE 1 END ASC,
          RANDOM()
        ${limitSql}
      `;
      items = this.query(sql, params);

    } else if (mode === 'maintenance') {
      // 3. 記憶維持メンテナンスモード
      const sql = `
        SELECT 
          m.*,
          m.${idCol} as item_id,
          m.${promptCol} as display_prompt,
          m.${answerCol} as display_answer,
          p.progress_id,
          p.current_rank_def_id,
          p.total_attempts,
          p.consecutive_success,
          p.last_studied_at,
          p.next_review_at,
          rd.scale_id,
          rd.rank_level,
          rd.rank_label,
          rd.color_code
        FROM ${meta.table_name} m
        INNER JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
        INNER JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
        WHERE 1=1 ${extraConditionsSql}
        ORDER BY 
          CASE WHEN p.next_review_at <= datetime('now', 'localtime') THEN 0 ELSE 1 END ASC,
          p.next_review_at ASC,
          RANDOM()
        ${limitSql}
      `;
      items = this.query(sql, params);

    } else {
      // 4. 全件シャッフルまたはその他
      const sql = `
        SELECT 
          m.*,
          m.${idCol} as item_id,
          m.${promptCol} as display_prompt,
          m.${answerCol} as display_answer,
          p.progress_id,
          p.current_rank_def_id,
          p.total_attempts,
          p.consecutive_success,
          p.last_studied_at,
          p.next_review_at,
          rd.scale_id,
          rd.rank_level,
          rd.rank_label,
          rd.color_code
        FROM ${meta.table_name} m
        LEFT JOIN ITEM_PROGRESS p ON p.material_type = '${materialType}' AND p.material_item_id = CAST(m.${idCol} AS TEXT)
        LEFT JOIN RANK_DEFINITIONS rd ON p.current_rank_def_id = rd.rank_def_id
        WHERE 1=1 ${extraConditionsSql}
        ORDER BY RANDOM()
        ${limitSql}
      `;
      items = this.query(sql, params);
    }

    return items;
  }

  /**
   * 学習結果の記録とランク・復習日時の更新
   */
  async recordStudyResult({ materialType = 'chinese_top50', materialItemId, assessedRankDefId, timeSpentMs = 0 }) {
    const itemIdStr = String(materialItemId);
    const now = new Date();
    const nowStr = this.formatDate(now);

    const rankDef = this.queryOne('SELECT * FROM RANK_DEFINITIONS WHERE rank_def_id = ?', [assessedRankDefId]);
    if (!rankDef) {
      throw new Error('Invalid rank_def_id: ' + assessedRankDefId);
    }

    const maxLevelRow = this.queryOne('SELECT MAX(rank_level) as max_level FROM RANK_DEFINITIONS WHERE scale_id = ?', [rankDef.scale_id]);
    const maxLevel = maxLevelRow ? maxLevelRow.max_level : 3;
    const isTopRank = (rankDef.rank_level === maxLevel);

    let progress = this.queryOne(`
      SELECT * FROM ITEM_PROGRESS 
      WHERE material_type = ? AND material_item_id = ?
    `, [materialType, itemIdStr]);

    let progressId;
    let consecutiveSuccess = 0;
    let totalAttempts = 1;

    if (progress) {
      progressId = progress.progress_id;
      totalAttempts = (progress.total_attempts || 0) + 1;
      consecutiveSuccess = isTopRank ? (progress.consecutive_success || 0) + 1 : 0;
    } else {
      consecutiveSuccess = isTopRank ? 1 : 0;
    }

    let intervalDays = rankDef.default_interval_days;
    if (isTopRank && consecutiveSuccess > 1) {
      intervalDays = Math.round(intervalDays * Math.pow(1.5, consecutiveSuccess - 1));
    }
    const nextReviewDate = new Date(now.getTime() + intervalDays * 24 * 60 * 60 * 1000);
    const nextReviewStr = this.formatDate(nextReviewDate);

    if (progress) {
      this.db.run(`
        UPDATE ITEM_PROGRESS
        SET current_rank_def_id = ?,
            total_attempts = ?,
            consecutive_success = ?,
            last_studied_at = ?,
            next_review_at = ?
        WHERE progress_id = ?
      `, [assessedRankDefId, totalAttempts, consecutiveSuccess, nowStr, nextReviewStr, progressId]);
    } else {
      this.db.run(`
        INSERT INTO ITEM_PROGRESS (
          material_type, material_item_id, current_rank_def_id,
          total_attempts, consecutive_success, last_studied_at, next_review_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [materialType, itemIdStr, assessedRankDefId, totalAttempts, consecutiveSuccess, nowStr, nextReviewStr]);

      const lastIdRow = this.queryOne('SELECT last_insert_rowid() as id');
      progressId = lastIdRow.id;
    }

    this.db.run(`
      INSERT INTO STUDY_LOGS (progress_id, assessed_rank_def_id, time_spent_ms, studied_at)
      VALUES (?, ?, ?, ?)
    `, [progressId, assessedRankDefId, timeSpentMs, nowStr]);

    await this.saveToStorage();
    return {
      progressId,
      totalAttempts,
      consecutiveSuccess,
      nextReviewAt: nextReviewStr,
      intervalDays
    };
  }

  /**
   * 手動でのランク変更
   */
  async manualUpdateRank(materialType = 'chinese_top50', materialItemId, rankDefId) {
    const itemIdStr = String(materialItemId);
    const now = new Date();
    const nowStr = this.formatDate(now);

    if (!rankDefId || rankDefId === 'unstudied') {
      this.db.run(`
        UPDATE ITEM_PROGRESS
        SET current_rank_def_id = NULL
        WHERE material_type = ? AND material_item_id = ?
      `, [materialType, itemIdStr]);
    } else {
      const defId = parseInt(rankDefId, 10);
      const rankDef = this.queryOne('SELECT * FROM RANK_DEFINITIONS WHERE rank_def_id = ?', [defId]);
      if (!rankDef) return;

      const nextReviewDate = new Date(now.getTime() + rankDef.default_interval_days * 24 * 60 * 60 * 1000);
      const nextReviewStr = this.formatDate(nextReviewDate);

      let progress = this.queryOne(`
        SELECT progress_id FROM ITEM_PROGRESS 
        WHERE material_type = ? AND material_item_id = ?
      `, [materialType, itemIdStr]);

      if (progress) {
        this.db.run(`
          UPDATE ITEM_PROGRESS
          SET current_rank_def_id = ?,
              last_studied_at = ?,
              next_review_at = ?
          WHERE progress_id = ?
        `, [defId, nowStr, nextReviewStr, progress.progress_id]);
      } else {
        this.db.run(`
          INSERT INTO ITEM_PROGRESS (
            material_type, material_item_id, current_rank_def_id,
            total_attempts, consecutive_success, last_studied_at, next_review_at
          ) VALUES (?, ?, ?, 1, 0, ?, ?)
        `, [materialType, itemIdStr, defId, nowStr, nextReviewStr]);
      }
    }

    await this.saveToStorage();
  }

  /**
   * 統計情報の集計
   */
  getStats(materialType = 'chinese_top50', scaleId = 'simple_3') {
    const meta = this.getMaterialMetadata(materialType);
    let totalCount = 0;
    try {
      const totalCountRow = this.queryOne(`SELECT COUNT(*) as total FROM ${meta.table_name}`);
      totalCount = totalCountRow ? totalCountRow.total : 0;
    } catch (e) {
      totalCount = 0;
    }

    const rankDefs = this.getRankDefinitions(scaleId);
    const maxLevel = rankDefs.length > 0 ? rankDefs[rankDefs.length - 1].rank_level : 3;

    const distribution = [];
    let masteredCount = 0;

    for (const def of rankDefs) {
      const row = this.queryOne(`
        SELECT COUNT(*) as count
        FROM ITEM_PROGRESS p
        WHERE p.material_type = ? AND p.current_rank_def_id = ?
      `, [materialType, def.rank_def_id]);

      const count = row ? row.count : 0;
      distribution.push({
        rank_def_id: def.rank_def_id,
        rank_level: def.rank_level,
        rank_label: def.rank_label,
        color_code: def.color_code,
        count: count,
        percentage: totalCount > 0 ? Math.round((count / totalCount) * 100) : 0
      });

      if (def.rank_level === maxLevel || (scaleId === 'detailed_5' && def.rank_level >= 4)) {
        masteredCount += count;
      }
    }

    const studiedCountRow = this.queryOne(`
      SELECT COUNT(*) as count
      FROM ITEM_PROGRESS p
      WHERE p.material_type = ? AND p.current_rank_def_id IS NOT NULL
    `, [materialType]);
    const studiedCount = studiedCountRow ? studiedCountRow.count : 0;
    const unstudiedCount = Math.max(0, totalCount - studiedCount);

    const dueCountRow = this.queryOne(`
      SELECT COUNT(*) as count
      FROM ITEM_PROGRESS p
      WHERE p.material_type = ? 
        AND p.current_rank_def_id IS NOT NULL
        AND p.next_review_at <= datetime('now', 'localtime')
    `, [materialType]);
    const dueCount = dueCountRow ? dueCountRow.count : 0;

    const logStatsRow = this.queryOne(`
      SELECT 
        COUNT(*) as total_logs,
        AVG(time_spent_ms) as avg_time_ms
      FROM STUDY_LOGS l
      JOIN ITEM_PROGRESS p ON l.progress_id = p.progress_id
      WHERE p.material_type = ?
    `, [materialType]);

    const totalLogs = logStatsRow ? logStatsRow.total_logs : 0;
    const avgTimeMs = logStatsRow && logStatsRow.avg_time_ms ? Math.round(logStatsRow.avg_time_ms) : 0;
    const masteryRate = totalCount > 0 ? Math.round((masteredCount / totalCount) * 100) : 0;

    return {
      totalCount,
      studiedCount,
      unstudiedCount,
      unstudiedPercentage: totalCount > 0 ? Math.round((unstudiedCount / totalCount) * 100) : 0,
      distribution,
      masteredCount,
      masteryRate,
      dueCount,
      totalLogs,
      avgTimeMs
    };
  }

  /**
   * 学習履歴ログの取得（動的カラム対応）
   */
  getStudyLogs(limit = 50, materialType = 'chinese_top50') {
    const meta = this.getMaterialMetadata(materialType);
    const idCol = meta.id_column || 'id';
    const promptCol = meta.prompt_column || 'word';
    const answerCol = meta.answer_column || 'meaning_ja';

    return this.query(`
      SELECT 
        l.log_id,
        l.studied_at,
        l.time_spent_ms,
        rd.rank_level,
        rd.rank_label,
        rd.color_code,
        m.${idCol} as item_id,
        m.${promptCol} as display_prompt,
        m.${answerCol} as display_answer
      FROM STUDY_LOGS l
      JOIN ITEM_PROGRESS p ON l.progress_id = p.progress_id
      JOIN ${meta.table_name} m ON p.material_item_id = CAST(m.${idCol} AS TEXT)
      JOIN RANK_DEFINITIONS rd ON l.assessed_rank_def_id = rd.rank_def_id
      WHERE p.material_type = ?
      ORDER BY l.log_id DESC
      LIMIT ?
    `, [materialType, limit]);
  }

  exportBinary() {
    return this.db.export();
  }

  async importBinary(uint8Array) {
    await this.openDatabaseFromBuffer(uint8Array);
    await this.saveToStorage();
  }

  async resetToInitial() {
    if (this.db) {
      this.db.close();
    }
    await this.clearIndexedDB();
    this.isInitialized = false;
    await this.init();
  }

  formatDate(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  openIndexedDB() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        return resolve(null);
      }
      const req = indexedDB.open(this.dbName, 1);
      req.onupgradeneeded = (e) => {
        const idb = e.target.result;
        if (!idb.objectStoreNames.contains(this.storeName)) {
          idb.createObjectStore(this.storeName);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async saveToStorage() {
    return await this.saveToFileHandle();
  }

  /**
   * 連携中の実ファイルへ直接書き込み（FileSyncServiceへ委譲）
   */
  async saveToFileHandle() {
    if (this.fileSync) {
      if (this.fileSync.fileHandle) {
        this.fileHandle = this.fileSync.fileHandle;
        this.fileName = this.fileSync.fileName;
      } else if (this.fileHandle) {
        this.fileSync.fileHandle = this.fileHandle;
        this.fileSync.fileName = this.fileName;
      }
      const res = await this.fileSync.saveToFileHandle();
      this.lastSavedAt = this.fileSync.lastSavedAt;
      this.isModified = this.fileSync.isModified;
      return res;
    }

    if (!this.fileHandle) {
      this.isModified = true;
      return false;
    }

    try {
      const binary = this.exportBinary();
      const writable = await this.fileHandle.createWritable();
      await writable.write(binary);
      await writable.close();

      this.lastSavedAt = new Date();
      this.isModified = false;
      console.log(`[DBService] Successfully saved to local file: ${this.fileName} (${binary.length} bytes)`);
      return true;
    } catch (err) {
      console.error('[DBService] Failed to write to local file handle:', err);
      this.isModified = true;
      throw err;
    }
  }

  /**
   * 実ファイルハンドルを設定
   */
  setFileHandle(handle) {
    if (this.fileSync) {
      this.fileSync.setFileHandle(handle);
      this.fileHandle = this.fileSync.fileHandle;
      this.fileName = this.fileSync.fileName;
      this.lastSavedAt = this.fileSync.lastSavedAt;
      this.isModified = this.fileSync.isModified;
    } else {
      this.fileHandle = handle;
      this.fileName = handle ? handle.name : null;
      this.lastSavedAt = handle ? new Date() : null;
      this.isModified = false;
    }
  }

  /**
   * 実ファイルハンドルからデータベースを開く
   */
  async openFromFileHandle(handle) {
    if (!handle) throw new Error('有効なファイルハンドルがありません。');
    const file = await handle.getFile();
    const arrayBuffer = await file.arrayBuffer();

    if (this.db) {
      this.db.close();
    }
    this.db = new this.SQL.Database(new Uint8Array(arrayBuffer));
    await this.createSchemaAndSeed();
    this.setFileHandle(handle);
    return file;
  }

  /**
   * 過去のセッションでIndexedDBに保存されてしまった旧大容量キャッシュを完全に消去（ディスク領域解放）
   */
  async cleanupLegacyIndexedDBCache() {
    if (this.fileSync) {
      return await this.fileSync.cleanupLegacyIndexedDBCache();
    }
    if (typeof indexedDB === 'undefined') return;
    try {
      const legacyDbName = 'learning_rank_db_storage';
      const req = indexedDB.deleteDatabase(legacyDbName);
      req.onsuccess = () => {
        console.log('[DBService] Cleaned up legacy IndexedDB database cache to free disk space.');
      };
      req.onerror = () => {};
    } catch (e) {
      // ignore
    }
  }
}


if (typeof window !== 'undefined') {
  window.DBService = DBService;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DBService;
}