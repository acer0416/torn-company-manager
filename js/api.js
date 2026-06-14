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
  async getUserBasic() { return this.v1('basic', 'user'); },
  async getUserEvents() { return this.v1('events', 'user'); },
  async getUserLog(offset = 0) { return this.v1('log', 'user', `offset=${offset}`); },
  async getUserLogForTarget(target) { return this.v1('log', 'user', `target=${target}`); },
  async getUserLogByTypes(logIds, limit = 100) { return this.v2(`/user/log?log=${logIds}&limit=${limit}`); },
  async getCompanyTypes() { return this.v1('companies', 'torn'); },
  async getPlayerProfile(id) { return this.v1('profile,basic', `user/${id}`); },
  async getPlayerEvents(id) { return this.v1('events', `user/${id}`); },
  async getUserEducation() { return this.v2('/user/education'); },
  async getIndustryCompanies(industryId, offset = 0, limit = 100) {
    return this.v2(`/company/${industryId}/companies?limit=${limit}&offset=${offset}&striptags=false`);
  },

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
    try {
      const [profileData, statsData] = await Promise.all([
        this.v2(`/user/${id}?selections=profile`),
        this.v2(`/user/${id}/personalstats?stat=xantaken,useractivity`)
      ]);
      const profile = profileData?.profile || profileData || {};
      const rawPs = statsData?.personalstats;
      const ps = {};
      if (Array.isArray(rawPs)) {
        rawPs.forEach(item => {
          if (item && item.name) {
            ps[item.name] = item.value;
          }
        });
      } else if (rawPs && typeof rawPs === 'object') {
        Object.assign(ps, rawPs);
      }
      return {
        ...ps,
        age: profile.age || 0,
        days_old: profile.age || 0,
        useractivity: ps.useractivity || 0
      };
    } catch (e) {
      console.warn(`[TornAPI] getPlayerPersonalStats failed for ${id}:`, e.message);
      throw e;
    }
  },

  async getPlayerRehabBackupStats(playerId) {
    const id = String(playerId);
    try {
      const data = await this.v2(`/user/${id}/personalstats?stat=switravel,rehabs,xantaken`);
      const rawPs = data?.personalstats;
      const ps = { switravel: 0, rehabs: 0, xantaken: 0 };
      if (Array.isArray(rawPs)) {
        rawPs.forEach(item => {
          if (item && item.name) {
            ps[item.name] = Number(item.value) || 0;
          }
        });
      } else if (rawPs && typeof rawPs === 'object') {
        if (rawPs.switravel !== undefined) ps.switravel = Number(rawPs.switravel) || 0;
        if (rawPs.rehabs !== undefined) ps.rehabs = Number(rawPs.rehabs) || 0;
        if (rawPs.xantaken !== undefined) ps.xantaken = Number(rawPs.xantaken) || 0;
      }
      return ps;
    } catch (e) {
      console.warn(`[TornAPI] getPlayerRehabBackupStats failed for ${id}:`, e.message);
      throw e;
    }
  },

  /** 从 HoF 响应解析 workstats（工作属性）总值，与战斗属性无关 */
  _parseHofWorkstatsTotal(hofData) {
    if (hofData == null) return null;

    if (Array.isArray(hofData)) {
      const row = hofData.find((r) => {
        const key = String(r.id || r.category || r.name || '').toLowerCase().replace(/[\s_]+/g, '');
        return key === 'workstats' || key === 'workingstats';
      });
      if (row) {
        const v = Number(row.value ?? row.score ?? row.total);
        if (!Number.isNaN(v) && v >= 0) return v;
      }
    }

    const ws = hofData.working_stats ?? hofData.workstats ?? hofData.work_stats ?? hofData['work stats'];
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
    } catch (e) {
      console.warn(`[TornAPI] getPlayerTotalStats failed for ${id}:`, e.message);
    }
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
   * 通过 Torn API v2 /user/log 端点获取与指定玩家的交互日志。
   * 支持分页（通过 _metadata.links.next）。
   * @param {string|number} targetPlayerId - 目标玩家 ID
   * @param {object} options - { from, to, limit, cat }
   * @returns {Array} 所有 log 条目（已合并分页）
   */
  async getPlayerLog(targetPlayerId, options = {}) {
    if (!targetPlayerId) throw new Error('targetPlayerId is required');
    const { from, to, limit = 100, cat } = options;
    const params = [`target=${targetPlayerId}`, `limit=${limit}`];
    if (from) params.push(`from=${from}`);
    if (to) params.push(`to=${to}`);
    if (cat != null) params.push(`cat=${cat}`);

    let allLogs = [];
    let path = `/user/log?${params.join('&')}`;

    while (path) {
      const data = await this.v2(path);
      const logs = data?.log || [];
      allLogs = allLogs.concat(logs);

      // 检查是否有下一页
      const nextLink = data?._metadata?.links?.next;
      if (nextLink && logs.length >= limit) {
        // next 是完整 URL，提取 path 部分并去除冗余的 /v2 和屏蔽的 key
        const url = new URL(nextLink);
        let nextPath = url.pathname;
        if (nextPath.startsWith('/v2')) nextPath = nextPath.substring(3);
        url.searchParams.delete('key');
        path = nextPath + '?' + url.searchParams.toString();
      } else {
        path = null;
      }
    }

    console.log(`[TornAPI] getPlayerLog: target=${targetPlayerId}, total=${allLogs.length} entries`);
    return allLogs;
  },

  /**
   * 从 /user/log 返回的 log 条目中筛选训练记录。
   * 训练记录的识别方式：
   *   - details.title 或 details.category 包含 "train" 关键词（不区分大小写）
   *   - 或 data 中包含 training/train 相关字段
   * @param {Array} logEntries - getPlayerLog() 返回的 log 条目数组
   * @returns {Array<{playerId:string, playerName:string, date:string, timestamp:number, logId:string}>}
   */
  parseTrainingFromLog(logEntries) {
    if (!Array.isArray(logEntries)) return [];

    const entries = [];
    const trainRe = /\btrain(?:ing|ed|ee)?\b/i;

    for (const item of logEntries) {
      const details = item?.details || {};
      const title = (details.title || '').toString();
      const category = (details.category || '').toString();
      const data = item?.data || {};
      const params = item?.params || {};

      // 判断是否为训练记录
      const isTrain =
        trainRe.test(title) ||
        trainRe.test(category) ||
        (data && typeof data === 'object' && Object.keys(data).some(k => trainRe.test(k)));

      if (!isTrain) continue;

      const ts = Number(item?.timestamp || 0);
      const dateObj = ts > 0 ? new Date(ts * 1000) : new Date();
      const dateStr = dateObj.toISOString().slice(0, 10); // YYYY-MM-DD

      // 尝试从 data/params 中提取玩家名称
      const playerName =
        params?.player_name ||
        params?.name ||
        data?.player_name ||
        data?.name ||
        details.title?.replace(/<[^>]+>/g, '').trim() ||
        '';

      entries.push({
        playerId: String(params?.player_id || params?.target_id || data?.player_id || data?.target_id || ''),
        playerName: playerName,
        date: dateStr,
        timestamp: ts,
        logId: String(item?.id || ''),
        rawText: title.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
        details: details
      });
    }

    console.log(`[TornAPI] parseTrainingFromLog: ${logEntries.length} log entries -> ${entries.length} training entries`);
    return entries;
  },

  /**
   * 遍历所有员工，通过 /user/log 端点获取训练记录。
   * 对每个员工调用 getPlayerLog()，然后 parseTrainingFromLog() 筛选。
   * 遵守 650ms 速率限制（由 _fetch 自动处理）。
   * @param {Array<string|number>} employeeIds - 员工 player ID 列表
   * @param {number} sinceMs - Unix 毫秒时间戳，仅获取此时间之后的记录
   * @returns {Array<{playerId:string, playerName:string, date:string, timestamp:number, logId:string}>}
   */
  async getTrainingFromAllEmployees(employeeIds, sinceMs, untilMs) {
    if (!Array.isArray(employeeIds) || employeeIds.length === 0) {
      console.warn('[TornAPI] getTrainingFromAllEmployees: no employee IDs provided');
      return [];
    }

    const sinceSec = sinceMs ? Math.floor(sinceMs / 1000) : 0;
    const untilSec = untilMs ? Math.floor(untilMs / 1000) : 0;
    const allEntries = [];

    console.log(`[TornAPI] getTrainingFromAllEmployees: fetching logs for ${employeeIds.length} employees, since=${sinceSec}, until=${untilSec || 'none'}`);

    for (let i = 0; i < employeeIds.length; i++) {
      const empId = String(employeeIds[i]);
      try {
        const options = { limit: 100 };
        if (sinceSec > 0) options.from = sinceSec;
        if (untilSec > 0) options.to = untilSec;

        const logs = await this.getPlayerLog(empId, options);
        const trainingEntries = this.parseTrainingFromLog(logs);

        // 为每个条目补充 target playerId（log 中可能不直接包含）
        for (const entry of trainingEntries) {
          if (!entry.playerId) entry.playerId = empId;
        }

        allEntries.push(...trainingEntries);
        console.log(`[TornAPI] getTrainingFromAllEmployees: [${i + 1}/${employeeIds.length}] emp=${empId}, logs=${logs.length}, training=${trainingEntries.length}`);
      } catch (e) {
        console.warn(`[TornAPI] getTrainingFromAllEmployees: failed for emp=${empId}:`, e.message);
        // 继续处理下一个员工
      }
    }

    console.log(`[TornAPI] getTrainingFromAllEmployees: total training entries=${allEntries.length}`);
    return allEntries;
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
