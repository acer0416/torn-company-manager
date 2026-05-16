// Settings Page - API key, monitoring, app settings
window.SettingsPage = {
    settings: {},
    showKey: false,
    companyInfo: null,

    async init() {
        await this._migrateOldNestedSettings();
        await this.loadSettings();
        await this.render();
    },

    // 迁移旧嵌套结构 { settings: { rehabMonitorEnabled, ... } } 到扁平结构
    async _migrateOldNestedSettings() {
        try {
            const result = await chrome.storage.local.get('settings');
            if (result.settings && typeof result.settings === 'object') {
                const flat = result.settings;
                const newSettings = {};
                if (flat.rehabMonitorEnabled !== undefined) {
                    newSettings[SETTINGS_KEYS.MONITORING_ENABLED] = flat.rehabMonitorEnabled;
                }
                if (flat.rehabCheckInterval !== undefined) {
                    newSettings[SETTINGS_KEYS.CHECK_INTERVAL] = flat.rehabCheckInterval;
                }
                if (flat.autoRefreshInterval !== undefined) {
                    newSettings[SETTINGS_KEYS.REFRESH_INTERVAL] = flat.autoRefreshInterval;
                }
                if (flat.notificationsEnabled !== undefined) {
                    newSettings[SETTINGS_KEYS.NOTIFICATIONS_ENABLED] = flat.notificationsEnabled;
                }
                if (Object.keys(newSettings).length > 0) {
                    await chrome.storage.local.set(newSettings);
                    await chrome.storage.local.remove('settings');
                    console.log('[Settings] Migrated old nested settings to flat structure:', newSettings);
                }
            }
        } catch (e) {
            // 迁移失败静默忽略
        }
    },

    // DB `settings` 表是权威数据源，`chrome.storage.local` 仅作为 service-worker 的同步副本。
    // 合并逻辑：完全以 DB 为准，chrome.storage.local 仅用于补充 DB 中不存在的 key（首次安装回退）。
    async loadSettings() {
        const all = await DB.getAll('settings');
        this.settings = {};
        all.forEach(s => { this.settings[s.key] = s.value; });

        // 仅从 chrome.storage.local 回填 DB 中不存在的 key（首次安装场景）
        try {
            const result = await chrome.storage.local.get([
                SETTINGS_KEYS.API_KEY,
                SETTINGS_KEYS.MONITORING_ENABLED,
                SETTINGS_KEYS.CHECK_INTERVAL,
                SETTINGS_KEYS.REFRESH_INTERVAL,
                SETTINGS_KEYS.NOTIFICATIONS_ENABLED
            ]);
            // 仅当 DB 中不存在该 key 时才从 chrome.storage.local 回退
            if (result[SETTINGS_KEYS.API_KEY] && this.settings[SETTINGS_KEYS.API_KEY] === undefined)
                this.settings[SETTINGS_KEYS.API_KEY] = result[SETTINGS_KEYS.API_KEY];
            if (result[SETTINGS_KEYS.MONITORING_ENABLED] !== undefined && this.settings[SETTINGS_KEYS.MONITORING_ENABLED] === undefined)
                this.settings[SETTINGS_KEYS.MONITORING_ENABLED] = result[SETTINGS_KEYS.MONITORING_ENABLED];
            if (result[SETTINGS_KEYS.CHECK_INTERVAL] && this.settings[SETTINGS_KEYS.CHECK_INTERVAL] === undefined)
                this.settings[SETTINGS_KEYS.CHECK_INTERVAL] = result[SETTINGS_KEYS.CHECK_INTERVAL];
            if (result[SETTINGS_KEYS.REFRESH_INTERVAL] && this.settings[SETTINGS_KEYS.REFRESH_INTERVAL] === undefined)
                this.settings[SETTINGS_KEYS.REFRESH_INTERVAL] = result[SETTINGS_KEYS.REFRESH_INTERVAL];
            if (result[SETTINGS_KEYS.NOTIFICATIONS_ENABLED] !== undefined && this.settings[SETTINGS_KEYS.NOTIFICATIONS_ENABLED] === undefined)
                this.settings[SETTINGS_KEYS.NOTIFICATIONS_ENABLED] = result[SETTINGS_KEYS.NOTIFICATIONS_ENABLED];
        } catch (e) {
            // chrome.storage.local may not be available
        }
    },

    // 写入顺序：DB 是权威数据源，先写 DB，成功后再同步到 chrome.storage.local
    async saveSetting(key, value) {
        this.settings[key] = value;
        try {
            await DB.put('settings', { key, value });
            // DB 写入成功后才同步到 chrome.storage.local（service-worker 副本）
            try {
                await chrome.storage.local.set({ [key]: value });
            } catch (e) { /* chrome.storage.local 不可用，不影响核心功能 */ }
        } catch (e) {
            console.error('[SettingsPage] Failed to save setting to DB:', key, e);
            Utils.toast('保存设置失败', 'error');
        }
    },

    notifyAlarms() {
        try {
            chrome.runtime.sendMessage({ action: 'setupAlarms' });
        } catch (e) { /* ignore */ }
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;

        c.innerHTML = this._buildPageHTML();
        this._bindEvents();

        // Load company info if API key exists
        if (this.settings[SETTINGS_KEYS.API_KEY] || TornAPI._key) {
            this._loadCompanyInfo();
        }
    },

    _buildPageHTML() {
        const keyType = this.showKey ? 'text' : 'password';
        const eyeIcon = this.showKey ? 'fa-eye-slash' : 'fa-eye';
        const apiKey = this.settings[SETTINGS_KEYS.API_KEY] || '';
        const monitoring = this.settings[SETTINGS_KEYS.MONITORING_ENABLED] ?? false;
        const notifications = this.settings[SETTINGS_KEYS.NOTIFICATIONS_ENABLED] ?? true;
        const checkInterval = this.settings[SETTINGS_KEYS.CHECK_INTERVAL] || 5;
        const refreshInterval = this.settings[SETTINGS_KEYS.REFRESH_INTERVAL] || 15;

        return `
            <div class="flex items-center justify-between mb-6">
                <h1 class="text-xl font-bold text-white flex items-center gap-2">
                    <i class="fas fa-cog text-gray-400"></i> 设置
                </h1>
            </div>

            <!-- API Key -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-key mr-2 text-torn-gold"></i>API密钥
                </h3>
                <div class="flex items-end gap-3">
                    <div class="flex-1">
                        <label class="text-gray-400 text-sm mb-1 block">Torn API Key</label>
                        <div class="relative">
                            <input id="settings-api-key" class="input pr-10" type="${keyType}" placeholder="输入API密钥" value="${apiKey}">
                            <button id="settings-toggle-key" class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white">
                                <i class="fas ${eyeIcon}"></i>
                            </button>
                        </div>
                    </div>
                    <button id="settings-save-key" class="btn btn-primary">保存</button>
                    <button id="settings-validate-key" class="btn btn-secondary">验证</button>
                </div>
            </div>

            <!-- Company Info -->
            <div id="settings-company-card" class="card mb-6" style="display:none;">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-building mr-2 text-torn-accent"></i>公司信息
                </h3>
                <div id="settings-company-info" class="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <div class="text-gray-400 text-sm">加载中...</div>
                </div>
            </div>

            <!-- Monitoring -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-bell mr-2 text-torn-blue"></i>监控设置
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div class="flex items-center justify-between bg-torn-surface rounded-lg p-3">
                        <div>
                            <div class="text-white text-sm font-medium">康复监控</div>
                            <div class="text-gray-500 text-xs">员工需要康复时提醒</div>
                        </div>
                        <input id="settings-rehab-monitor" type="checkbox" ${monitoring ? 'checked' : ''}>
                    </div>
                    <div class="flex items-center justify-between bg-torn-surface rounded-lg p-3">
                        <div>
                            <div class="text-white text-sm font-medium">通知推送</div>
                            <div class="text-gray-500 text-xs">显示浏览器通知</div>
                        </div>
                        <input id="settings-notifications" type="checkbox" ${notifications ? 'checked' : ''}>
                    </div>
                    <div class="bg-torn-surface rounded-lg p-3">
                        <div class="text-white text-sm font-medium mb-1">检查间隔</div>
                        <div class="text-gray-500 text-xs mb-2">检查员工数据的频率 (分钟)</div>
                        <input id="settings-check-interval" class="input input-sm" type="number" min="1" value="${checkInterval}">
                    </div>
                    <div class="bg-torn-surface rounded-lg p-3">
                        <div class="text-white text-sm font-medium mb-1">自动刷新间隔</div>
                        <div class="text-gray-500 text-xs mb-2">自动刷新仪表盘数据 (分钟)</div>
                        <input id="settings-refresh-interval" class="input input-sm" type="number" min="1" value="${refreshInterval}">
                    </div>
                </div>
            </div>

            <!-- Window -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-window-restore mr-2 text-torn-purple"></i>窗口
                </h3>
                <div class="text-gray-400 text-sm mb-3">在独立窗口中打开管理器，获得更好的使用体验。</div>
                <button id="settings-open-window" class="btn btn-primary">
                    <i class="fas fa-external-link-alt mr-2"></i>在新窗口中打开
                </button>
            </div>

            <!-- About -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-info-circle mr-2 text-torn-green"></i>关于
                </h3>
                <div class="space-y-3">
                    <div class="flex justify-between">
                        <span class="text-gray-400">名称</span>
                        <span class="text-white">Torn Company Manager</span>
                    </div>
                    <div class="flex justify-between">
                        <span class="text-gray-400">版本</span>
                        <span class="badge badge-green">v1.0.0</span>
                    </div>
                    <div class="flex justify-between items-center">
                        <span class="text-gray-400">作者</span>
                        <span class="text-white">
                            <a href="https://www.torn.com/profiles.php?XID=3434492" target="_blank" class="text-torn-blue hover:text-white hover:underline transition-colors">Luvsusan [3434492]</a>
                        </span>
                    </div>
                    <div class="border-t border-torn-border pt-3 mt-3">
                        <div class="text-gray-500 text-xs text-center">
                            Torn City is a trademark of CityMojo Ltd. This extension is not affiliated with Torn City.
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    _bindEvents() {
        // Toggle API key visibility
        document.getElementById('settings-toggle-key')?.addEventListener('click', () => {
            this.showKey = !this.showKey;
            const input = document.getElementById('settings-api-key');
            const icon = document.querySelector('#settings-toggle-key i');
            if (input) input.type = this.showKey ? 'text' : 'password';
            if (icon) icon.className = `fas ${this.showKey ? 'fa-eye-slash' : 'fa-eye'}`;
        });

        // Save API key
        document.getElementById('settings-save-key')?.addEventListener('click', async () => {
            const key = document.getElementById('settings-api-key')?.value.trim();
            if (!key) {
                Utils.toast('请输入API密钥', 'error');
                return;
            }
            await TornAPI.setKey(key);
            await this.saveSetting(SETTINGS_KEYS.API_KEY, key);
            Utils.toast('API密钥已保存', 'success');
        });

        // Validate API key
        document.getElementById('settings-validate-key')?.addEventListener('click', async () => {
            const key = document.getElementById('settings-api-key')?.value.trim() || this.settings[SETTINGS_KEYS.API_KEY];
            if (!key) {
                Utils.toast('请先输入API密钥', 'error');
                return;
            }
            Utils.showLoading('正在验证API密钥...');
            try {
                const valid = await TornAPI.validateKey(key);
                Utils.hideLoading();
                if (valid) {
                    Utils.toast('API密钥有效！', 'success');
                } else {
                    Utils.toast('API密钥无效', 'error');
                }
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`验证错误: ${e.message}`, 'error');
            }
        });

        // Rehab monitor toggle
        document.getElementById('settings-rehab-monitor')?.addEventListener('change', async (e) => {
            await this.saveSetting(SETTINGS_KEYS.MONITORING_ENABLED, e.target.checked);
            this.notifyAlarms();
            Utils.toast(`康复监控已${e.target.checked ? '开启' : '关闭'}`, 'info');
        });

        // Notifications toggle
        document.getElementById('settings-notifications')?.addEventListener('change', async (e) => {
            await this.saveSetting(SETTINGS_KEYS.NOTIFICATIONS_ENABLED, e.target.checked);
            this.notifyAlarms();
            Utils.toast(`通知已${e.target.checked ? '开启' : '关闭'}`, 'info');
        });

        // Check interval
        document.getElementById('settings-check-interval')?.addEventListener('change', async (e) => {
            await this.saveSetting(SETTINGS_KEYS.CHECK_INTERVAL, parseInt(e.target.value) || 5);
            this.notifyAlarms();
            Utils.toast('检查间隔已更新', 'info');
        });

        // Refresh interval
        document.getElementById('settings-refresh-interval')?.addEventListener('change', async (e) => {
            await this.saveSetting(SETTINGS_KEYS.REFRESH_INTERVAL, parseInt(e.target.value) || 15);
            this.notifyAlarms();
            Utils.toast('刷新间隔已更新', 'info');
        });

        // Open in new window
        document.getElementById('settings-open-window')?.addEventListener('click', () => {
            try {
                chrome.windows.create({
                    url: chrome.runtime.getURL('popup/index.html'),
                    type: 'popup',
                    width: 1280,
                    height: 900
                });
            } catch (e) {
                Utils.toast('无法在此上下文中打开新窗口', 'error');
            }
        });
    },

    async _loadCompanyInfo() {
        const card = document.getElementById('settings-company-card');
        const infoDiv = document.getElementById('settings-company-info');
        if (!card || !infoDiv) return;

        try {
            const data = await TornAPI.getCompanyProfile();
            const company = data?.company || {};
            if (!company.name) return;

            card.style.display = '';
            const rating = company.rating || 0;
            const stars = '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating));

            infoDiv.innerHTML = `
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">公司名称</div>
                    <div class="text-white font-bold">${company.name || 'N/A'}</div>
                </div>
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">公司类型</div>
                    <div class="text-white font-bold">${company.type || 'N/A'}</div>
                </div>
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">评分</div>
                    <div class="text-torn-gold font-bold">${stars}</div>
                </div>
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">员工</div>
                    <div class="text-white font-bold">${Object.keys(data.employees || {}).length || 0}/${company.capacity || 10}</div>
                </div>
            `;
        } catch (e) {
            // Silently fail if API key invalid
        }
    }
};
