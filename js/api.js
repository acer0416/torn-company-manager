// Torn API Client for Chrome Extension
const TornAPI = {
  BASE_V1: 'https://api.torn.com',
  BASE_V2: 'https://api.torn.com/v2',
  _key: null,
  _lastCall: 0,

  async getKey() {
    if (this._key) return this._key;
    try {
      if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
        const result = await chrome.storage.local.get('apiKey');
        this._key = result.apiKey || null;
        console.log('[TornAPI] getKey from storage:', this._key ? 'found (' + this._key.substring(0, 4) + '*)' : 'empty');
      } else {
        console.warn('[TornAPI] chrome.storage.local not available');
      }
      return this._key;
    } catch (e) {
      console.error('[TornAPI] getKey error:', e);
      return null;
    }
  },

  async setKey(key) {
    this._key = key;
    try {
      await chrome.storage.local.set({ apiKey: key });
      console.log('[TornAPI] Key saved');
    } catch (e) {
      console.error('[TornAPI] setKey error:', e);
    }
  },

  async _fetch(url) {
    const now = Date.now();
    const wait = 650 - (now - this._lastCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    this._lastCall = Date.now();

    console.log('[TornAPI] Fetching:', url.replace(/key=[^&]+/, 'key=***'));
    const resp = await fetch(url);
    if (!resp.ok) {
      console.error('[TornAPI] HTTP error:', resp.status, resp.statusText);
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }
    const data = await resp.json();
    if (data.error) {
      console.error('[TornAPI] API error:', data.error);
      throw new Error(`Torn API Error ${data.error.code}: ${data.error.error}`);
    }
    return data;
  },

  async v1(selections, category = 'company', extraParams = '') {
    const key = await this.getKey();
    if (!key) throw new Error('API key not set');
    const url = `${this.BASE_V1}/${category}/?selections=${selections}&key=${key}${extraParams ? '&' + extraParams : ''}`;
    return this._fetch(url);
  },

  async v2(path) {
    const key = await this.getKey();
    if (!key) throw new Error('API key not set');
    const separator = path.includes('?') ? '&' : '?';
    const url = `${this.BASE_V2}${path}${separator}key=${key}`;
    return this._fetch(url);
  },

  async getCompanyFull() { return this.v1('profile,employees,stock,detailed'); },
  async getCompanyProfile() { return this.v1('profile'); },
  async getCompanyEmployees() { return this.v2('/company/employees'); },
  async getCompanyStock() { return this.v2('/company/stock'); },
  async getCompanyApplications() { return this.v2('/company/applications'); },
  async getCompanyDetailed() { return this.v1('detailed'); },
  async getCompanyNews() { return this.v1('news', 'company', 'limit=100'); },
  async getUserBasic() { return this.v1('basic', 'user'); },
  async getUserEvents() { return this.v1('events', 'user'); },
  async getUserLog(offset = 0) { return this.v1('log', 'user', `offset=${offset}`); },
  async getUserLogForTarget(target) { return this.v1('log', 'user', `target=${target}`); },
  async getUserLogByTypes(logIds, limit = 100) { return this.v2(`/user/log?log=${logIds}&limit=${limit}`); },
  async getCompanyTypes() { return this.v1('companies', 'torn'); },
  async getPlayerProfile(id) { return this.v1('profile,basic', 'user', `id=${id}`); },
  async getPlayerEvents(id) { return this.v1('events', 'user', `id=${id}`); },

  // Cache for player names to reduce API calls
  _playerCache: {},

  /** Fetch player info via v2 API: /v2/user/{id}?selections=profile */
  async getPlayerInfo(playerId) {
    if (!playerId) throw new Error('Invalid player ID');
    const id = String(playerId);
    if (this._playerCache[id]) return this._playerCache[id];
    try {
      const data = await this.v2(`/user/${id}?selections=profile`);
      const profile = data?.profile || data || {};
      const result = {
        player_id: id,
        name: profile.name || '',
        level: profile.level || 0,
        faction: profile.faction?.faction_name || '',
      };
      this._playerCache[id] = result;
      return result;
    } catch (e) {
      return { player_id: id, name: '', level: 0, faction: '' };
    }
  },

  async getPlayerPersonalStats(playerId) {
    const id = String(playerId);
    const data = await this.v1('personalstats', 'user', `id=${id}`);
    return data?.personalstats || {};
  },

  /** 从 HoF 响应解析 workstats（工作属性）总值，与战斗属性无关 */
  _parseHofWorkstatsTotal(hofData) {
    if (hofData == null) return null;

    if (Array.isArray(hofData)) {
      const row = hofData.find((r) => {
        const key = String(r.id || r.category || r.name || '').toLowerCase().replace(/\s+/g, '');
        return key === 'workstats' || key === 'work_stats' || key === 'workingstats';
      });
      if (row) {
        const v = Number(row.value ?? row.score ?? row.total);
        if (!Number.isNaN(v) && v >= 0) return v;
      }
    }

    const ws = hofData.workstats ?? hofData.work_stats ?? hofData['work stats'];
    if (ws == null) return null;
    if (typeof ws === 'number' && !Number.isNaN(ws)) return ws;
    if (typeof ws === 'object') {
      const v = Number(ws.value ?? ws.score ?? ws.total);
      if (!Number.isNaN(v) && v >= 0) return v;
    }
    return null;
  },

  /** 历史员工总属性值：HoF → workstats */
  async getPlayerTotalStats(playerId) {
    const id = String(playerId);
    try {
      const data = await this.v2(`/user/${id}?selections=hof`);
      const v = this._parseHofWorkstatsTotal(data?.hof);
      if (v != null) return v;
    } catch (e) { /* v2 → v1 */ }
    try {
      const data = await this.v1('hof', 'user', `id=${id}`);
      const v = this._parseHofWorkstatsTotal(data?.halloffame ?? data?.hof);
      if (v != null) return v;
    } catch (e) { /* ignore */ }
    return null;
  },

  async validateKey(key) {
    try {
      const url = `${this.BASE_V1}/key/?selections=info&key=${key}`;
      const resp = await fetch(url);
      const data = await resp.json();
      return !data.error;
    } catch (e) {
      return false;
    }
  },

  async getCompanyById(id) { return this.v1('profile', 'company', `id=${id}`); },

  // --- 统一数据获取方法（屏蔽 V1/V2 差异）---

  /** 始终返回 Employee[] 数组 */
  async getEmployeesUnified() {
    // 优先 V2（返回数组格式），回退 V1（返回 {id: {...}} 对象格式）
    try {
      const data = await this.v2('/company/employees');
      const employees = data?.employees;
      if (Array.isArray(employees) && employees.length > 0) return employees;
      throw new Error('V2 returned empty/invalid employees');
    } catch (e) {
      console.log('[TornAPI] getEmployeesUnified: V2 failed, falling back to V1:', e.message);
      const data = await this.v1('employees');
      const employees = data?.company_employees;
      if (!employees) throw new Error('No employees data from V1');
      if (Array.isArray(employees)) return employees;
      return Object.values(employees);
    }
  },

  /** 始终返回 StockItem[]；sold_amount / sold_worth 为当日销量与销售额（非累计） */
  async getStockUnified() {
    const parseQty = (v) => {
      if (v == null || v === '') return 0;
      const n = Number(String(v).replace(/,/g, ''));
      return Number.isFinite(n) ? n : 0;
    };
    const normalize = (item) => ({
      name: item.name || item.title || '',
      price: parseQty(item.price),
      cost: parseQty(item.cost ?? item.buy_price),
      rrp: parseQty(item.rrp ?? item.recommended_price),
      in_stock: parseQty(item.in_stock ?? item.quantity ?? item.available ?? item.amount),
      on_order: parseQty(item.on_order ?? item.onorder ?? item.ordered ?? item.onOrder),
      sold_amount: parseQty(item.sold_amount ?? item.sold),
      sold_worth: parseQty(item.sold_worth ?? item.sold_total ?? item.total_sold_value),
    });
    const toArray = (stock) => {
      if (!stock) return [];
      if (Array.isArray(stock)) return stock.map(normalize);
      return Object.entries(stock).map(([name, item]) => normalize({ name, ...item }));
    };

    // 优先 V2（数组格式），回退 V1（{商品名: {...}} 对象格式）
    try {
      const data = await this.v2('/company/stock');
      const items = toArray(data?.stock);
      if (items.length) return items;
      throw new Error('V2 returned empty/invalid stock');
    } catch (e) {
      console.log('[TornAPI] getStockUnified: V2 failed, falling back to V1:', e.message);
      const data = await this.v1('stock');
      const items = toArray(data?.company_stock);
      if (items.length) return items;
      throw new Error('No stock data from V1');
    }
  },

  /**
   * 从公司新闻统计每位员工训练次数（v1 company/?selections=news）。
   * 新闻格式示例："... XID=123>Name</a> has been trained by the director"
   * @param {object} newsResponse - getCompanyNews() 返回值
   * @param {number} sinceMs - 仅统计此时间戳（毫秒）之后的新闻
   * @returns {Record<string, number>} player_id -> 训练次数
   */
  parseTrainingCountsFromNews(newsResponse, sinceMs) {
    const counts = {};
    const news = newsResponse?.news || newsResponse?.company_news || {};
    const entries = Array.isArray(news) ? news : Object.values(news);
    const sinceSec = Math.floor((sinceMs || 0) / 1000);
    const trainedRe = /has been trained\b/i;
    const xidRe = /XID=(\d+)/i;

    for (const item of entries) {
      const text = (item?.news || item?.text || '').toString();
      if (!trainedRe.test(text)) continue;
      const ts = Number(item?.timestamp || item?.time || 0);
      if (sinceSec > 0 && ts > 0 && ts < sinceSec) continue;
      const m = text.match(xidRe);
      if (!m) continue;
      const pid = String(m[1]);
      counts[pid] = (counts[pid] || 0) + 1;
    }
    return counts;
  },

  /** 本周（周一至周日）各员工训练次数，来源：公司新闻 API */
  async getWeeklyEmployeeTrainCounts() {
    const sinceMs = Utils.weekDateRange(Utils.weekKey()).start.getTime();
    const data = await this.getCompanyNews();
    return this.parseTrainingCountsFromNews(data, sinceMs);
  },

  async getCompanyData() {
    const raw = await this.v1('profile,employees,stock,detailed');
    const profile = raw?.company || {};
    if (!profile.company_type && raw?.company_detailed?.company_type) {
      profile.company_type = raw.company_detailed.company_type;
    }
    return {
      profile,
      employees: raw?.company_employees
        ? (Array.isArray(raw.company_employees)
          ? raw.company_employees
          : Object.entries(raw.company_employees).map(([id, emp]) => ({ id: Number(id), ...emp })))
        : [],
      stock: raw?.company_stock
        ? (Array.isArray(raw.company_stock) ? raw.company_stock : Object.entries(raw.company_stock).map(([name, item]) => ({ name, ...item })))
        : [],
      detailed: raw?.company_detailed || {}
    };
  }
};
