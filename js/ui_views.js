/**
 * UIViews - ダッシュボード・テーブル描画・SQLコンソールUIマネージャー
 * 
 * 責務:
 * 1. ダッシュボード画面の描画（習得率メトリクス、忘却曲線推奨アラート、ランク分布スタックバー & 凡例）
 * 2. 教材項目一覧テーブル（教材タブ）の描画（動的ヘッダー、検索・ランク絞り込み、インラインランク更新、TTS発音ボタン）
 * 3. 学習履歴ログテーブル（履歴タブ）の描画（直近50件）
 * 4. 内部SQLコンソールの実行と結果テーブル描画
 */

class UIViews {
  constructor(app = null, dbService = null, speechService = null) {
    this.app = app;
    this.dbService = dbService;
    this.speechService = speechService;

    // 教材一覧テーブルのページネーション状態（1ページ標準100件、0は全件表示）
    this.materialsPage = 1;
    this.materialsPageSize = 100;
    this._lastFilterSignature = '';
  }

  /**
   * 教材一覧テーブルのページ番号を設定
   */
  setMaterialsPage(page) {
    const p = parseInt(page, 10);
    if (!isNaN(p) && p >= 1) {
      this.materialsPage = p;
    }
  }

  /**
   * 教材一覧テーブルの1ページあたり表示件数を設定（0 または 'all' で全件表示）
   */
  setMaterialsPageSize(size) {
    if (size === 0 || size === '0' || size === 'all') {
      this.materialsPageSize = 0;
    } else {
      const s = parseInt(size, 10);
      if (!isNaN(s) && s > 0) {
        this.materialsPageSize = s;
      }
    }
    this.materialsPage = 1;
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
  }

  /**
   * 1. ダッシュボード画面の描画
   */
  async renderDashboard(materialType, currentScale) {
    const alertBanner = this.getEl('due-alert-banner');
    const alertText = this.getEl('due-alert-text');

    if (!materialType || !this.dbService) {
      if (alertBanner && alertText) {
        alertBanner.className = 'alert-banner';
        alertText.innerHTML = '📚 教材がまだ登録されていません。右上の「➕ 教材追加」または「DB管理」タブからCSV教材を取り込んでください。';
      }
      const rateEl = this.getEl('metric-mastery-rate');
      const countEl = this.getEl('metric-mastery-count');
      const fillEl = this.getEl('metric-mastery-fill');
      if (rateEl) rateEl.textContent = '0%';
      if (countEl) countEl.textContent = '0 / 0 項目';
      if (fillEl) fillEl.style.width = '0%';
      const logsEl = this.getEl('metric-total-logs');
      if (logsEl) logsEl.textContent = '0';
      const avgEl = this.getEl('metric-avg-time');
      if (avgEl) avgEl.textContent = '0.0s';
      const barEl = this.getEl('dashboard-dist-bar');
      const legendEl = this.getEl('dashboard-dist-legend');
      if (barEl) barEl.innerHTML = '';
      if (legendEl) legendEl.innerHTML = '<span style="color: var(--text-muted);">教材未登録</span>';
      return;
    }

    const stats = this.dbService.getStats(materialType, currentScale);

    // 復習推奨アラート（忘却曲線に基づく判定）
    if (alertBanner && alertText) {
      if (stats.dueCount > 0) {
        alertBanner.className = 'alert-banner has-due due';
        alertText.innerHTML = `⚠️ 復習推奨日時が到来している項目が <strong>${stats.dueCount} 件</strong> あります！忘却を防ぐため早めの復習をおすすめします。`;
      } else {
        alertBanner.className = 'alert-banner ok';
        alertText.innerHTML = '✨ 現在、期日超過している復習項目はありません。素晴らしい学習ペースです！';
      }
    }

    // メトリクス表示
    const rateEl = this.getEl('metric-mastery-rate');
    const countEl = this.getEl('metric-mastery-count');
    const fillEl = this.getEl('metric-mastery-fill');
    if (rateEl) rateEl.textContent = `${stats.masteryRate}%`;
    if (countEl) countEl.textContent = `${stats.masteredCount} / ${stats.totalCount} 項目`;
    if (fillEl) fillEl.style.width = `${stats.masteryRate}%`;

    const logsEl = this.getEl('metric-total-logs');
    if (logsEl) logsEl.textContent = String(stats.totalLogs);

    const avgEl = this.getEl('metric-avg-time');
    if (avgEl) avgEl.textContent = (stats.avgTimeMs / 1000).toFixed(1) + 's';

    // ランク分布スタックバー & 凡例
    const barEl = this.getEl('dashboard-dist-bar');
    const legendEl = this.getEl('dashboard-dist-legend');
    if (barEl && legendEl) {
      barEl.innerHTML = '';
      legendEl.innerHTML = '';

      if (stats.unstudiedCount > 0) {
        const seg = this.createEl('div');
        if (seg) {
          seg.className = 'distribution-segment dist-segment';
          seg.style.width = `${stats.unstudiedPercentage}%`;
          seg.style.backgroundColor = '#94a3b8';
          seg.title = `未学習: ${stats.unstudiedCount}件 (${stats.unstudiedPercentage}%)`;
          barEl.appendChild(seg);
        }

        const leg = this.createEl('div');
        if (leg) {
          leg.className = 'legend-item dist-legend-item';
          leg.innerHTML = `<span class="legend-dot dist-legend-color" style="background-color: #94a3b8;"></span> 未学習 (${stats.unstudiedCount})`;
          legendEl.appendChild(leg);
        }
      }

      stats.distribution.forEach(d => {
        if (d.count > 0) {
          const seg = this.createEl('div');
          if (seg) {
            seg.className = 'distribution-segment dist-segment';
            seg.style.width = `${d.percentage}%`;
            seg.style.backgroundColor = d.color_code;
            seg.title = `${d.rank_label}: ${d.count}件 (${d.percentage}%)`;
            barEl.appendChild(seg);
          }
        }

        const leg = this.createEl('div');
        if (leg) {
          leg.className = 'legend-item dist-legend-item';
          leg.innerHTML = `<span class="legend-dot dist-legend-color" style="background-color: ${d.color_code};"></span> ${d.rank_label} (${d.count})`;
          legendEl.appendChild(leg);
        }
      });
    }
  }

  /**
   * 2. 教材項目一覧テーブルの描画（教材タブ・ページネーション＆スケール間マッピング対応）
   */
  async renderMaterialsTable(materialType, currentScale, options = {}) {
    const tbody = this.getEl('materials-table-body');
    const resolvedScale = currentScale || (this.app ? this.app.currentScale : 'simple_3');

    if (!materialType || !this.dbService) {
      if (tbody) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">教材がまだ登録されていません。[➕ 教材追加] からCSV教材を取り込んでください。</td></tr>';
      }
      const countSummary = this.getEl('materials-count-summary');
      if (countSummary) countSummary.textContent = '0 件';
      const paginationBar = this.getEl('materials-pagination-bar');
      if (paginationBar) paginationBar.style.display = 'none';
      return;
    }

    const searchInput = this.getEl('material-search');
    const filterSelect = this.getEl('material-rank-filter');
    const search = searchInput ? searchInput.value : '';
    const rankFilter = filterSelect ? filterSelect.value : '';
    const meta = this.dbService.getMaterialMetadata(materialType);

    // 検索・フィルタ・教材・スケール条件が変化した場合は自動的に1ページ目へリセット
    const filterSignature = `${materialType}::${resolvedScale}::${search}::${rankFilter}`;
    if (filterSignature !== this._lastFilterSignature) {
      if (!options.keepPage) {
        this.materialsPage = 1;
      }
      this._lastFilterSignature = filterSignature;
    }

    // フィルタセレクターのランク選択肢を初期化（未初期化の場合）
    if (filterSelect && filterSelect.options && filterSelect.options.length <= 1) {
      const rankDefs = this.dbService.getRankDefinitions(resolvedScale);
      filterSelect.innerHTML = '<option value="">すべてのランク</option><option value="unstudied">未学習</option>';
      rankDefs.forEach(d => {
        const opt = this.createEl('option');
        if (opt) {
          opt.value = d.rank_def_id;
          opt.textContent = d.rank_label;
          filterSelect.appendChild(opt);
        }
      });
      filterSelect.value = rankFilter;
    }

    const items = this.dbService.getItemsWithProgress(materialType, {
      search,
      rankDefId: rankFilter
    }, resolvedScale);

    const idRange = (typeof this.dbService.getMaterialIdRange === 'function')
      ? this.dbService.getMaterialIdRange(materialType)
      : { totalCount: items.length };
    const totalMaterialCount = idRange.totalCount || items.length;
    const totalFiltered = items.length;

    const effectivePageSize = (this.materialsPageSize && this.materialsPageSize > 0)
      ? this.materialsPageSize
      : (totalFiltered || 1);
    const totalPages = Math.max(1, Math.ceil(totalFiltered / effectivePageSize));
    if (this.materialsPage > totalPages) this.materialsPage = totalPages;
    if (this.materialsPage < 1) this.materialsPage = 1;

    const startIdx = (this.materialsPage - 1) * effectivePageSize;
    const endIdx = Math.min(startIdx + effectivePageSize, totalFiltered);
    const pageItems = (this.materialsPageSize && this.materialsPageSize > 0)
      ? items.slice(startIdx, endIdx)
      : items;

    this._renderMaterialsPagination({
      totalFiltered,
      totalMaterialCount,
      startIdx,
      endIdx,
      totalPages,
      materialType,
      currentScale: resolvedScale,
      isFiltered: Boolean(search || rankFilter)
    });

    const thead = this.getEl('materials-table-head');
    if (thead && meta) {
      thead.innerHTML = `
        <tr>
          <th style="width: 60px;">ID</th>
          <th>問題・見出し (${this.escapeHtml(meta.prompt_column)})</th>
          <th>補足・読み</th>
          <th>正解・意味 (${this.escapeHtml(meta.answer_column)})</th>
          <th>定着ランク設定</th>
          <th>学習回数</th>
        </tr>
      `;
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    if (pageItems.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">条件に一致する項目が見つかりません。</td></tr>';
      return;
    }

    const rankDefs = this.dbService.getRankDefinitions(resolvedScale);
    const hintColsStr = meta ? meta.hint_columns || '' : '';
    const hintCols = hintColsStr ? hintColsStr.split(',').map(s => s.trim()).filter(Boolean) : [];

    pageItems.forEach(item => {
      const tr = this.createEl('tr');
      if (!tr) return;

      // 補足表示作成（各補足項目に個別発音ボタン）
      let hintsHtml = '-';
      if (hintCols.length > 0) {
        const hintBadges = hintCols.map(c => {
          const val = item[c];
          if (!val) return '';
          return `<span style="display: inline-flex; align-items: center; gap: 0.2rem; background: #f1f5f9; padding: 0.15rem 0.4rem; border-radius: 4px; margin: 0.1rem 0.2rem;">
            ${this.escapeHtml(val)}
            <button class="btn-tts-mini" data-speak="${this.escapeHtml(val)}" data-lang="auto" title="発音">🔊</button>
          </span>`;
        }).filter(Boolean);
        if (hintBadges.length > 0) hintsHtml = hintBadges.join('');
      }

      // ランク選択ドロップダウン（別スケールで記録されたランクも現在スケールへマッピングして選択表示）
      const effectiveRankDefId = item.mapped_rank_def_id || item.current_rank_def_id;
      let rankOptions = `<option value="unstudied" ${!effectiveRankDefId ? 'selected' : ''}>未学習</option>`;
      rankDefs.forEach(d => {
        rankOptions += `<option value="${d.rank_def_id}" ${effectiveRankDefId == d.rank_def_id ? 'selected' : ''}>${d.rank_label}</option>`;
      });

      const promptVal = item.display_prompt || '';
      const answerVal = item.display_answer || '';
      const promptLang = meta ? meta.prompt_lang || 'auto' : 'auto';
      const answerLang = meta ? meta.answer_lang || 'auto' : 'auto';

      const promptSpeechCol = meta ? meta.prompt_speech_column : null;
      const answerSpeechCol = meta ? meta.answer_speech_column : null;
      const promptSpeakVal = (promptSpeechCol && item[promptSpeechCol] !== undefined && item[promptSpeechCol] !== null && String(item[promptSpeechCol]).trim() !== '')
        ? String(item[promptSpeechCol]).trim()
        : promptVal;
      const answerSpeakVal = (answerSpeechCol && item[answerSpeechCol] !== undefined && item[answerSpeechCol] !== null && String(item[answerSpeechCol]).trim() !== '')
        ? String(item[answerSpeechCol]).trim()
        : answerVal;

      tr.innerHTML = `
        <td>${item.item_id}</td>
        <td style="font-weight: 700; font-size: 1.05rem; color: var(--primary);">
          <span>${this.escapeHtml(promptVal)}</span>
          ${promptSpeakVal ? `<button class="btn-tts-mini" data-speak="${this.escapeHtml(promptSpeakVal)}" data-lang="${promptLang}" title="問題を発音">🔊</button>` : ''}
        </td>
        <td style="color: var(--text-muted); font-size: 0.85rem;">${hintsHtml}</td>
        <td style="font-weight: 500;">
          <span>${this.escapeHtml(answerVal)}</span>
          ${answerSpeakVal ? `<button class="btn-tts-mini" data-speak="${this.escapeHtml(answerSpeakVal)}" data-lang="${answerLang}" title="回答を発音">🔊</button>` : ''}
        </td>
        <td>
          <select class="rank-inline-select" data-id="${item.item_id}" style="padding: 0.3rem 0.6rem; border-radius: 6px; border: 1px solid var(--border);">
            ${rankOptions}
          </select>
        </td>
        <td>${item.total_attempts || 0}回</td>
      `;

      tbody.appendChild(tr);
    });

    if (typeof tbody.querySelectorAll === 'function') {
      // TTSボタンクリックイベント
      tbody.querySelectorAll('.btn-tts-mini').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const text = btn.getAttribute('data-speak');
          const lang = btn.getAttribute('data-lang') || 'auto';
          if (text && this.speechService) {
            this.speechService.speak(text, { lang });
          }
        });
      });

      // インラインランク手動変更イベント
      tbody.querySelectorAll('.rank-inline-select').forEach(sel => {
        sel.addEventListener('change', async (e) => {
          const id = e.target.getAttribute('data-id');
          const rankDefId = e.target.value;
          await this.dbService.manualUpdateRank(materialType, id, rankDefId);
          if (this.app && typeof this.app.showToast === 'function') {
            this.app.showToast('ランクを更新しました。', 'info');
          }
          if (this.app && typeof this.app.renderDashboard === 'function') {
            await this.app.renderDashboard();
          }
          if (this.app && typeof this.app.updateFileSyncUI === 'function') {
            this.app.updateFileSyncUI();
          }
        });
      });
    }
  }

  /**
   * 教材一覧テーブルの該当件数およびページネーションコントロールバーの描画
   */
  _renderMaterialsPagination({ totalFiltered, totalMaterialCount, startIdx, endIdx, totalPages, materialType, currentScale, isFiltered }) {
    const countSummary = this.getEl('materials-count-summary');
    if (countSummary) {
      if (totalFiltered === 0) {
        countSummary.textContent = isFiltered
          ? `該当 0 件 (全 ${totalMaterialCount} 件中)`
          : `全 0 件`;
      } else {
        const rangeStr = (totalPages > 1) ? `${startIdx + 1}〜${endIdx} 件を表示` : `${totalFiltered} 件を表示`;
        countSummary.textContent = isFiltered
          ? `該当 ${totalFiltered} 件中 ${rangeStr} (全体 ${totalMaterialCount} 件)`
          : `全 ${totalMaterialCount} 件中 ${rangeStr}`;
      }
    }

    const pageSizeSelect = this.getEl('materials-page-size');
    if (pageSizeSelect) {
      const targetVal = this.materialsPageSize === 0 ? 'all' : String(this.materialsPageSize);
      if (pageSizeSelect.value !== targetVal) {
        pageSizeSelect.value = targetVal;
      }
    }

    const paginationBar = this.getEl('materials-pagination-bar');
    if (!paginationBar) return;

    if (totalPages <= 1) {
      paginationBar.style.display = 'none';
      paginationBar.innerHTML = '';
      return;
    }

    paginationBar.style.display = 'flex';
    const cur = this.materialsPage;
    paginationBar.innerHTML = `
      <div style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;">
        <button type="button" class="btn btn-secondary btn-page-nav" data-page="1" ${cur <= 1 ? 'disabled' : ''} style="padding: 0.35rem 0.65rem; font-size: 0.85rem;">⏮️ 最初</button>
        <button type="button" class="btn btn-secondary btn-page-nav" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''} style="padding: 0.35rem 0.75rem; font-size: 0.85rem;">◀️ 前へ</button>
        <span style="font-weight: 700; font-size: 0.9rem; color: var(--text-main); padding: 0 0.5rem;">
          ページ ${cur} / ${totalPages} <span style="font-weight: 500; font-size: 0.8rem; color: var(--text-muted);">(${startIdx + 1}〜${endIdx} / ${totalFiltered}件)</span>
        </span>
        <button type="button" class="btn btn-secondary btn-page-nav" data-page="${cur + 1}" ${cur >= totalPages ? 'disabled' : ''} style="padding: 0.35rem 0.75rem; font-size: 0.85rem;">次へ ▶️</button>
        <button type="button" class="btn btn-secondary btn-page-nav" data-page="${totalPages}" ${cur >= totalPages ? 'disabled' : ''} style="padding: 0.35rem 0.65rem; font-size: 0.85rem;">最後 ⏭️</button>
      </div>
    `;

    if (typeof paginationBar.querySelectorAll === 'function') {
      paginationBar.querySelectorAll('.btn-page-nav').forEach(btn => {
        btn.addEventListener('click', () => {
          const targetPage = parseInt(btn.getAttribute('data-page'), 10);
          if (!isNaN(targetPage) && targetPage >= 1 && targetPage <= totalPages && targetPage !== this.materialsPage) {
            this.materialsPage = targetPage;
            this.renderMaterialsTable(materialType, currentScale, { keepPage: true });
          }
        });
      });
    }
  }

  /**
   * 3. 学習履歴ログテーブルの描画（履歴タブ）
   */
  async renderLogsTable(materialType) {
    const tbody = this.getEl('logs-table-body');
    if (!tbody || !this.dbService) return;

    const logs = this.dbService.getStudyLogs(50, materialType);
    tbody.innerHTML = '';

    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">学習ログはまだありません。</td></tr>';
      return;
    }

    logs.forEach(log => {
      const tr = this.createEl('tr');
      if (!tr) return;

      tr.innerHTML = `
        <td>${log.log_id}</td>
        <td style="font-size: 0.85rem; color: var(--text-muted);">${this.escapeHtml(log.studied_at)}</td>
        <td style="font-weight: 600;">${this.escapeHtml(log.display_prompt || '')}</td>
        <td>${this.escapeHtml(log.display_answer || '')}</td>
        <td><span class="badge" style="background-color: ${log.color_code}20; color: ${log.color_code}; font-weight: 700; padding: 0.2rem 0.6rem; border-radius: 4px;">${this.escapeHtml(log.rank_label)}</span></td>
        <td>${(log.time_spent_ms / 1000).toFixed(2)}s</td>
      `;
      tbody.appendChild(tr);
    });
  }

  /**
   * 4. カスタムSQLの実行（DB管理タブ）
   */
  executeCustomSql() {
    const sqlInput = this.getEl('custom-sql-input');
    const resultArea = this.getEl('sql-result-area');
    if (!sqlInput || !resultArea || !this.dbService) return;

    const sql = sqlInput.value.trim();
    if (!sql) return;

    try {
      if (sql.toUpperCase().startsWith('SELECT')) {
        const rows = this.dbService.query(sql);
        if (rows.length === 0) {
          resultArea.innerHTML = '<p style="color: var(--text-muted); padding: 0.5rem;">0 件の結果が返されました。</p>';
          return;
        }
        const cols = Object.keys(rows[0]);
        let html = '<table class="data-table"><thead><tr>';
        cols.forEach(c => html += `<th>${this.escapeHtml(c)}</th>`);
        html += '</tr></thead><tbody>';
        rows.forEach(r => {
          html += '<tr>';
          cols.forEach(c => html += `<td>${this.escapeHtml(String(r[c] !== null ? r[c] : ''))}</td>`);
          html += '</tr>';
        });
        html += '</tbody></table>';
        resultArea.innerHTML = html;
      } else {
        this.dbService.run(sql);
        this.dbService.saveToStorage();
        resultArea.innerHTML = '<p style="color: var(--success); font-weight: 600;">SQLコマンドを実行しました。</p>';
        if (this.app && typeof this.app.renderDashboard === 'function') {
          this.app.renderDashboard();
        }
      }
    } catch (err) {
      resultArea.innerHTML = `<p style="color: var(--danger); font-weight: 600;">SQLエラー: ${this.escapeHtml(err.message)}</p>`;
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
  window.UIViews = UIViews;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UIViews;
}
