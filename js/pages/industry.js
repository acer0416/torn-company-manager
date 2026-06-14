// Industry Analysis Page
window.IndustryPage = (() => {
  let _industryId = null;
  let _companies = [];
  let _lastUpdate = null;
  let _loading = false;

  const INDUSTRY_MAP = {
    1: "Hair Salon", 2: "Law Firm", 3: "Flower Shop",
    4: "Car Dealership", 5: "Clothing Store", 6: "Gun Shop",
    7: "Game Shop", 8: "Candle Shop", 9: "Toy Shop",
    10: "Adult Novelties", 11: "Cyber Cafe", 12: "Grocery Store",
    13: "Theater", 14: "Sweet Shop", 15: "Cruise Line",
    16: "Television Network", 18: "Zoo", 19: "Firework Stand",
    20: "Property Broker", 21: "Furniture Store", 22: "Gas Station",
    23: "Music Store", 24: "Nightclub", 25: "Pub",
    26: "Gents Strip Club", 27: "Restaurant", 28: "Oil Rig",
    29: "Fitness Center", 30: "Mechanic Shop", 31: "Amusement Park",
    32: "Lingerie Store", 33: "Meat Warehouse", 34: "Farm",
    35: "Software Corporation", 36: "Ladies Strip Club",
    37: "Private Security Firm", 38: "Mining Corporation",
    39: "Detective Agency", 40: "Logistics Management"
  };

  function _industryName(id) {
    return INDUSTRY_MAP[id] || `Type ${id}`;
  }

  function _parseCompanyId(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return INDUSTRY_MAP[raw] ? raw : null;
    if (typeof raw === 'string') {
      const n = parseInt(raw, 10);
      return INDUSTRY_MAP[n] ? n : null;
    }
    if (typeof raw === 'object') {
      const id = raw.id ?? raw.company_type ?? raw.type_id;
      if (id != null) return _parseCompanyId(id);
    }
    return null;
  }

  async function _detectIndustry() {
    try {
      const saved = await DB.get('settings', 'industry_analysis_industry');
      if (saved?.value) {
        const n = _parseCompanyId(saved.value);
        if (n) return n;
      }
    } catch {}
    try {
      const cached = AppCache.get('companyData');
      const t = _parseCompanyId(cached?.profile?.company_type);
      if (t) return t;
    } catch {}
    try {
      const profile = await TornAPI.getCompanyProfile();
      const t = _parseCompanyId(profile?.company?.company_type);
      if (t) return t;
    } catch {}
    return 1;
  }

  async function _loadFromDB() {
    try {
      const meta = await DB.get('industry_meta', 'last_update');
      _lastUpdate = meta?.value || null;
      const indMeta = await DB.get('industry_meta', 'industry_id');
      if (!_industryId && indMeta?.value) _industryId = indMeta.value;
      const all = await DB.getAll('industry_companies');
      _companies = (all || []).filter(c => c.industry_id === _industryId);
      return _companies.length > 0;
    } catch { return false; }
  }

  function _isCacheValid() {
    if (!_lastUpdate) return false;
    const now = new Date();
    // 缓存有效时间：当天凌晨2:15 - 第二天凌晨2:14
    const cacheStart = new Date(now);
    cacheStart.setHours(2, 15, 0, 0);
    const cacheEnd = new Date(now);
    cacheEnd.setDate(cacheEnd.getDate() + 1);
    cacheEnd.setHours(2, 14, 59, 999);
    return _lastUpdate >= cacheStart.getTime() && _lastUpdate <= cacheEnd.getTime();
  }

  async function _fetchFromAPI(industryId) {
    _loading = true;
    _industryId = industryId;
    _companies = [];
    try {
      let offset = 0;
      const limit = 100;
      while (true) {
        const data = await TornAPI.getIndustryCompanies(industryId, offset, limit);
        const companies = data.companies || [];
        for (const c of companies) {
          const director = c.director || {};
          _companies.push({
            CompanyID: c.id || 0,
            industry_id: industryId,
            Name: c.name || 'Unknown',
            DirectorName: (director != null && typeof director === 'object' ? director.name : director) || 'Unknown',
            DirectorID: (director != null && typeof director === 'object' ? (director.id ?? director.player_id) : null) || null,
            Stars: c.rating || 0,
            Daily_Income: c.income?.daily || 0,
            Weekly_Income: c.income?.weekly || 0,
            Daily_Customers: c.customers?.daily || 0,
            Weekly_Customers: c.customers?.weekly || 0,
            Employees_Hired: c.employees?.hired || 0,
            Employees_Capacity: c.employees?.capacity || 0,
            Days_Old: c.days_old || 0
          });
        }
        if (!data._metadata?.links?.next || companies.length === 0) break;
        offset += limit;
      }
      // Save to DB - only clear current industry's data, keep others
      const allExisting = await DB.getAll('industry_companies');
      for (const row of allExisting) {
        if (row.industry_id === industryId) {
          await DB.delete('industry_companies', row.CompanyID);
        }
      }
      for (const c of _companies) {
        await DB.put('industry_companies', c);
      }
      _lastUpdate = Date.now();
      await DB.put('industry_meta', { key: 'last_update', value: _lastUpdate });
      await DB.put('industry_meta', { key: 'industry_id', value: industryId });
      await DB.put('industry_meta', { key: 'company_count', value: _companies.length });
    } catch (e) {
      Utils.toast('获取行业数据失败: ' + e.message, 'error');
    }
    _loading = false;
  }

  function _calcAnalysis() {
    const allSorted = [..._companies].sort((a, b) => b.Weekly_Income - a.Weekly_Income);
    const totalCount = allSorted.length;
    if (totalCount === 0) return null;

    // Rank by weekly income
    allSorted.forEach((r, i) => { r.Rank = i + 1; });

    // Star distribution
    const starGroups = {};
    for (let s = 0; s <= 10; s++) starGroups[s] = [];
    allSorted.forEach(row => {
      const s = Math.min(row.Stars, 10);
      starGroups[s].push(row);
    });

    const starStats = [];
    for (let s = 10; s >= 0; s--) {
      const co = starGroups[s];
      if (co.length > 0) {
        const w = co.map(c => c.Weekly_Income);
        const d = co.map(c => c.Daily_Income);
        starStats.push({
          star: s, count: co.length,
          pct: (co.length / totalCount) * 100,
          minWeekly: Math.min(...w), maxWeekly: Math.max(...w),
          minDaily: Math.min(...d), maxDaily: Math.max(...d),
        });
      } else {
        starStats.push({ star: s, count: 0, pct: 0, minWeekly: 0, maxWeekly: 0, minDaily: 0, maxDaily: 0 });
      }
    }

    // Promotion thresholds
    let cumulativeCount = 0;
    const promotionThresholds = [];
    const starStatsMap = new Map(starStats.map(s => [s.star, s]));

    for (let s = 9; s >= 0; s--) {
      const targetStat = starStatsMap.get(s + 1);
      const targetPct = targetStat ? targetStat.pct : 0;
      const targetCount = Math.round(targetPct / 100 * totalCount);
      const quotaFrom = cumulativeCount + 1;
      cumulativeCount += targetCount;
      let quotaTo = s === 0 ? totalCount : cumulativeCount;
      quotaTo = Math.min(quotaTo, totalCount);

      if (quotaFrom > totalCount || targetCount === 0) {
        promotionThresholds.push({ fromStar: s, toStar: s + 1, quotaFrom, quotaTo, blockerCount: 0, thresholdRank: null, thresholdWeekly: 0, thresholdDaily: 0 });
        continue;
      }

      const fromIdx = Math.max(0, quotaFrom - 1);
      const toIdx = Math.min(totalCount - 1, quotaTo - 1);
      const intervalCos = allSorted.slice(fromIdx, toIdx + 1);
      const blockers = intervalCos.filter(c => Math.min(c.Stars, 10) < s).length;
      let thresholdRank = Math.min(quotaTo + blockers, totalCount);
      let thresholdCo = allSorted[thresholdRank - 1];
      while (thresholdCo && thresholdCo.Weekly_Income <= 0 && thresholdRank < totalCount) {
        thresholdRank++;
        thresholdCo = allSorted[thresholdRank - 1];
      }
      const validWeekly = (thresholdCo && thresholdCo.Weekly_Income > 0) ? thresholdCo.Weekly_Income : 0;
      const validDaily = validWeekly > 0 ? Math.ceil(validWeekly / 7) : 0;

      promotionThresholds.push({
        fromStar: s, toStar: s + 1, quotaFrom, quotaTo,
        blockerCount: blockers, thresholdRank, thresholdWeekly: validWeekly, thresholdDaily: validDaily
      });
    }

    return { allSorted, totalCount, starStats, starStatsMap, promotionThresholds };
  }

  function _formatMoney(v) {
    if (!v) return '$0';
    if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}b`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}m`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
    return `$${v.toLocaleString()}`;
  }

  function _starsHTML(count) {
    const n = Math.min(count, 10);
    return '★'.repeat(n) + '☆'.repeat(10 - n);
  }

  return {
    init() {},

    async render() {
      const container = document.getElementById('page-content');
      container.innerHTML = `
        <div class="flex items-center justify-between mb-6">
          <h1 class="text-xl font-bold text-white flex items-center gap-2">
            <i class="fas fa-industry text-torn-gold"></i> 行业分析
          </h1>
          <div class="flex gap-2">
            <select id="industry-select" class="bg-torn-surface border border-torn-border rounded px-2 py-1 text-sm text-gray-200"></select>
            <button id="industry-refresh" class="btn btn-primary btn-sm">
              <i class="fas fa-sync-alt"></i> 刷新数据
            </button>
          </div>
        </div>
        <div id="industry-update-info" class="text-sm text-gray-500 mb-4"></div>
        <div id="industry-content"></div>
      `;

      // Populate industry select
      const sel = document.getElementById('industry-select');
      Object.entries(INDUSTRY_MAP).forEach(([id, name]) => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = `${id} - ${name}`;
        sel.appendChild(opt);
      });

      // Detect and set industry
      _industryId = await _detectIndustry();
      sel.value = _industryId;

      // Load data
      const hasData = await _loadFromDB();
      if (hasData && _isCacheValid()) {
        sel.value = _industryId;
        this._renderAnalysis();
      } else {
        await this._refresh();
      }

      // Bind events
      sel.addEventListener('change', async (e) => {
        _industryId = parseInt(e.target.value, 10);
        await DB.put('settings', { key: 'industry_analysis_industry', value: _industryId });
        const hasData = await _loadFromDB();
        if (hasData && _isCacheValid()) {
          this._renderAnalysis();
        } else {
          await this._refresh();
        }
      });

      document.getElementById('industry-refresh').addEventListener('click', () => this._refresh());
    },

    async _refresh() {
      if (_loading) return;
      Utils.showLoading('获取行业数据...');
      await _fetchFromAPI(_industryId);
      Utils.hideLoading();
      this._renderAnalysis();
    },

    _renderAnalysis() {
      const content = document.getElementById('industry-content');
      const updateInfo = document.getElementById('industry-update-info');

      if (_lastUpdate) {
        const d = new Date(_lastUpdate);
        updateInfo.textContent = `数据更新时间: ${d.toLocaleString('zh-CN')} · 共 ${_companies.length} 家公司`;
      } else {
        updateInfo.textContent = '暂无数据，请点击刷新';
      }

      if (_companies.length === 0) {
        content.innerHTML = `<div class="text-center text-gray-500 py-10"><i class="fas fa-inbox text-3xl mb-3 block"></i>暂无行业数据，点击刷新获取</div>`;
        return;
      }

      const analysis = _calcAnalysis();
      if (!analysis) return;

      const { totalCount, starStats, promotionThresholds } = analysis;

      let html = '';

      // Star distribution table
      html += `<div class="card mb-6"><h3 class="text-white font-medium mb-3">📋 各星级分布</h3>`;
      html += `<div class="overflow-x-auto"><table class="w-full text-left text-sm">
        <thead><tr class="text-gray-400 border-b border-torn-border">
          <th class="px-3 py-2 text-center">星级</th>
          <th class="px-3 py-2 text-center">公司数</th>
          <th class="px-3 py-2 text-center">占比</th>
          <th class="px-3 py-2">周收入范围</th>
          <th class="px-3 py-2">日收入范围</th>
        </tr></thead><tbody>`;

      for (const stat of starStats) {
        html += `<tr class="border-t border-torn-border/50 hover:bg-torn-surface/50">
          <td class="px-3 py-2 text-center"><span class="text-torn-gold">${_starsHTML(stat.star)}</span> ${stat.star}★</td>
          <td class="px-3 py-2 text-center font-mono">${stat.count}</td>
          <td class="px-3 py-2 text-center font-mono">${stat.pct.toFixed(1)}%</td>
          <td class="px-3 py-2 font-mono text-gray-300">${stat.count > 0 ? `${_formatMoney(stat.minWeekly)} ~ ${_formatMoney(stat.maxWeekly)}` : '—'}</td>
          <td class="px-3 py-2 font-mono text-gray-300">${stat.count > 0 ? `${_formatMoney(stat.minDaily)} ~ ${_formatMoney(stat.maxDaily)}` : '—'}</td>
        </tr>`;
      }
      html += `</tbody></table></div></div>`;

      // Promotion thresholds
      html += `<div class="card mb-6"><h3 class="text-white font-medium mb-3">🚀 晋升门槛预估</h3>`;
      html += `<div class="overflow-x-auto"><table class="w-full text-left text-sm">
        <thead><tr class="text-gray-400 border-b border-torn-border">
          <th class="px-3 py-2 text-center">晋升方向</th>
          <th class="px-3 py-2 text-center">目标配额</th>
          <th class="px-3 py-2 text-center">占位者</th>
          <th class="px-3 py-2 text-center">顺延排名</th>
          <th class="px-3 py-2 text-center">门槛周收入</th>
          <th class="px-3 py-2 text-center">门槛日收入</th>
        </tr></thead><tbody>`;

      for (const pt of promotionThresholds) {
        if (pt.thresholdWeekly === 0 && pt.quotaFrom > totalCount) continue;
        html += `<tr class="border-t border-torn-border/50 hover:bg-torn-surface/50">
          <td class="px-3 py-2 text-center font-medium">
            <span class="text-torn-gold">${_starsHTML(pt.fromStar)}</span> ${pt.fromStar}★
            <span class="mx-1">→</span>
            <span class="text-torn-gold">${_starsHTML(pt.toStar)}</span> ${pt.toStar}★
          </td>
          <td class="px-3 py-2 text-center font-mono">#${pt.quotaFrom}–#${pt.quotaTo} (${pt.quotaTo - pt.quotaFrom + 1}家)</td>
          <td class="px-3 py-2 text-center font-mono ${pt.blockerCount > 0 ? 'text-red-400' : 'text-gray-500'}">${pt.blockerCount > 0 ? pt.blockerCount + ' 家' : '0'}</td>
          <td class="px-3 py-2 text-center font-mono font-bold">${pt.thresholdRank ? '#' + pt.thresholdRank : '—'}</td>
          <td class="px-3 py-2 text-center font-mono text-torn-accent font-bold">${pt.thresholdWeekly > 0 ? `≥ ${_formatMoney(pt.thresholdWeekly)}` : '—'}</td>
          <td class="px-3 py-2 text-center font-mono text-torn-accent">${pt.thresholdDaily > 0 ? `≥ ${_formatMoney(pt.thresholdDaily)}` : '—'}</td>
        </tr>`;
      }
      html += `</tbody></table></div></div>`;

      // Note
      html += `<div class="bg-torn-surface/50 p-3 rounded border border-torn-border text-sm text-gray-400">
        <strong class="text-gray-300">📌 门槛推算逻辑：</strong>
        占位者（星级过低无法一步晋升的公司）升一星后留出空位，门槛排名后移。
        门槛 = 顺延后排名位置的收入。行业总门店数: <strong class="text-white">${totalCount}</strong> 家
      </div>`;

      content.innerHTML = html;
    }
  };
})();
