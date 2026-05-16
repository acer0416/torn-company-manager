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
  async getCompanyNews() { return this.v1('news'); },
  async getUserBasic() { return this.v1('basic', 'user'); },
  async getUserEvents() { return this.v1('events', 'user'); },
  async getUserLog(offset = 0) { return this.v1('log', 'user', `offset=${offset}`); },
  async getUserLogForTarget(target) { return this.v1('log', 'user', `target=${target}`); },
  async getUserLogByTypes(logIds, limit = 100) { return this.v2(`/user/log?log=${logIds}&limit=${limit}`); },
  async getCompanyTypes() { return this.v1('companies', 'torn'); },
  async getPlayerProfile(id) { return this.v1('profile,basic', 'user', `id=${id}`); },
  async getPlayerEvents(id) { return this.v1('events', 'user', `id=${id}`); },

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

  /** 始终返回 StockItem[] 数组 */
  async getStockUnified() {
    // 优先 V2（返回数组格式），回退 V1（返回 {name: {...}} 对象格式）
    try {
      const data = await this.v2('/company/stock');
      const stock = data?.stock;
      if (Array.isArray(stock) && stock.length > 0) return stock;
      throw new Error('V2 returned empty/invalid stock');
    } catch (e) {
      console.log('[TornAPI] getStockUnified: V2 failed, falling back to V1:', e.message);
      const data = await this.v1('stock');
      const stock = data?.company_stock;
      if (!stock) throw new Error('No stock data from V1');
      if (Array.isArray(stock)) return stock;
      return Object.entries(stock).map(([name, item]) => ({ name, ...item }));
    }
  },

  /** 一次调用获取所有公司数据，返回标准化结构 */
  async getCompanyData() {
    const raw = await this.v1('profile,employees,stock,detailed');
    return {
      profile: raw?.company || {},
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
