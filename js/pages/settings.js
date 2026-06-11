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
                SETTINGS_KEYS.NOTIFICATIONS_ENABLED,
                'dash_addiction_threshold'
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
            if (result['dash_addiction_threshold'] !== undefined && this.settings['dash_addiction_threshold'] === undefined)
                this.settings['dash_addiction_threshold'] = result['dash_addiction_threshold'];
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
        const addictionThreshold = this.settings['dash_addiction_threshold'] ?? 5;

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
                    <div class="bg-torn-surface rounded-lg p-3">
                        <div class="text-white text-sm font-medium mb-1">毒瘾提醒阈值</div>
                        <div class="text-gray-500 text-xs mb-2">当工作效能削弱达到此值时发出警告 (1-100)</div>
                        <input id="settings-addiction-threshold" class="input input-sm" type="number" min="1" max="100" value="${addictionThreshold}">
                    </div>
                </div>
            </div>



            <!-- Data Operations -->
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-database mr-2 text-torn-blue"></i>数据操作
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <!-- Export -->
                    <div class="bg-torn-surface rounded-lg p-4 border border-torn-border">
                        <div class="text-torn-green font-bold mb-2">
                            <i class="fas fa-download mr-2"></i>导出数据
                        </div>
                        <div class="text-gray-400 text-sm mb-3">下载完整JSON备份文件</div>
                        <button id="data-export" class="btn btn-success w-full">导出备份</button>
                    </div>
                    <!-- Import -->
                    <div class="bg-torn-surface rounded-lg p-4 border border-torn-border">
                        <div class="text-torn-blue font-bold mb-2">
                            <i class="fas fa-upload mr-2"></i>导入数据
                        </div>
                        <div class="text-gray-400 text-sm mb-3">从JSON备份文件恢复数据</div>
                        <button id="data-import" class="btn btn-primary w-full">导入备份</button>
                    </div>
                    <!-- Clear -->
                    <div class="bg-torn-surface rounded-lg p-4 border border-torn-border">
                        <div class="text-red-400 font-bold mb-2">
                            <i class="fas fa-trash-alt mr-2"></i>清空数据
                        </div>
                        <div class="text-gray-400 text-sm mb-3">永久删除所有存储数据，不可撤销</div>
                        <button id="data-clear" class="btn w-full bg-red-600 hover:bg-red-700 text-white">清空所有数据</button>
                    </div>
                </div>
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

        // Addiction threshold
        document.getElementById('settings-addiction-threshold')?.addEventListener('change', async (e) => {
            const val = Math.max(1, Math.min(100, Math.abs(parseInt(e.target.value)) || 5));
            await this.saveSetting('dash_addiction_threshold', val);
            Utils.toast('毒瘾提醒阈值已更新', 'info');
        });



        // Data operations
        document.getElementById('data-export')?.addEventListener('click', () => this.exportData());
        document.getElementById('data-import')?.addEventListener('click', () => this.importData());
        document.getElementById('data-clear')?.addEventListener('click', () => this.clearAllData());
    },

    async _loadCompanyInfo() {
        const card = document.getElementById('settings-company-card');
        const infoDiv = document.getElementById('settings-company-info');
        if (!card || !infoDiv) return;

        try {
            const data = await TornAPI.getCompanyData();
            const profile = data?.profile || {};
            if (!profile.name) return;

            card.style.display = '';
            const rating = profile.rating || 0;
            const starHtml = UI.starPattern(rating);
            const companyTypeName = await Utils.resolveCompanyTypeName(profile);
            const employeesCount = data.employees?.length || 0;
            const capacity = profile.employees_capacity || data.detailed?.company_size || 10;

            infoDiv.innerHTML = `
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">公司名称</div>
                    <div class="text-white font-bold">${profile.name || 'N/A'}</div>
                </div>
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">公司类型</div>
                    <div class="text-white font-bold">${companyTypeName}</div>
                </div>
                <div class="bg-torn-surface rounded-lg p-3 flex flex-col justify-between">
                    <div class="text-gray-400 text-xs mb-1">评分</div>
                    <div>${starHtml}</div>
                </div>
                <div class="bg-torn-surface rounded-lg p-3">
                    <div class="text-gray-400 text-xs mb-1">员工</div>
                    <div class="text-white font-bold">${employeesCount}/${capacity}</div>
                </div>
            `;
        } catch (e) {
            // Silently fail if API key invalid
        }
    },

    async importData() {
        const fileInput = document.createElement('input');
        fileInput.type = 'file';
        fileInput.accept = '.json';
        fileInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = async (ev) => {
                try {
                    const data = JSON.parse(ev.target.result);
                    await this._showImportPreview(data);
                } catch (err) {
                    Utils.toast('无效的JSON文件', 'error');
                }
            };
            reader.readAsText(file);
        });
        fileInput.click();
    },

    async _showImportPreview(data) {
        Utils.showLoading('正在分析备份数据...');
        const counts = {};
        for (const store of ALL_STORES) {
            try {
                counts[store] = await DB.count(store);
            } catch (e) {
                counts[store] = 0;
            }
        }
        Utils.hideLoading();

        const content = document.createElement('div');
        content.className = 'p-6';

        let totalImport = 0;
        let hasOverwrite = false;

        const storeRows = ALL_STORES.map(store => {
            const importCount = data[store]?.length || 0;
            const currentCount = counts[store] || 0;
            totalImport += importCount;
            if (currentCount > 0 && importCount > 0) hasOverwrite = true;
            const countClass = importCount > 0 ? 'text-torn-green font-bold' : 'text-gray-500';
            return `
                <div class="flex justify-between items-center py-1 px-2 rounded bg-torn-surface">
                    <span class="text-gray-300 text-sm">${store}</span>
                    <div class="flex items-center gap-3">
                        <span class="text-gray-500 text-xs">当前: ${currentCount}</span>
                        <i class="fas fa-arrow-right text-gray-600 text-xs"></i>
                        <span class="${countClass}">${importCount}</span>
                    </div>
                </div>
            `;
        }).join('');

        const warning = hasOverwrite ? `
            <div class="bg-yellow-900/30 border border-yellow-500/50 rounded-lg p-3 mb-4 flex items-center gap-2">
                <i class="fas fa-exclamation-triangle text-yellow-400"></i>
                <span class="text-yellow-300 text-sm">警告: 导入将覆盖已有数据的存储</span>
            </div>
        ` : '';

        content.innerHTML = `
            <h3 class="text-lg font-bold text-white mb-2">
                <i class="fas fa-file-import mr-2 text-torn-blue"></i>导入预览
            </h3>
            ${data._exportDate ? `<div class="text-gray-400 text-sm mb-4">备份时间: ${data._exportDate}</div>` : ''}
            <div class="space-y-2 mb-4 max-h-48 overflow-y-auto">${storeRows}</div>
            ${warning}
            <div class="text-white mb-4">总导入记录数: ${totalImport}</div>
            <div class="flex justify-end gap-2">
                <button id="import-cancel" class="btn btn-secondary">取消</button>
                <button id="import-confirm" class="btn btn-primary">确认导入</button>
            </div>
        `;

        Utils.showModal(content);

        content.querySelector('#import-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#import-confirm').addEventListener('click', async () => {
            Utils.hideModal();
            Utils.showLoading('正在导入数据...');
            try {
                await DB.importAll(data);
                if (typeof TornAPI !== 'undefined') {
                    TornAPI._key = null;
                }
                Utils.hideLoading();
                Utils.toast('数据导入成功', 'success');
                await this.loadSettings();
                await this.render();
                this.notifyAlarms();
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`导入失败: ${e.message}`, 'error');
            }
        });
    },

    async exportData() {
        try {
            Utils.showLoading('正在导出数据...');
            const data = await DB.exportAll();
            const json = JSON.stringify(data, null, 2);
            const blob = new Blob([json], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `torn-company-backup-${Utils.todayKey()}.json`;
            a.click();
            URL.revokeObjectURL(url);
            Utils.hideLoading();
            Utils.toast('备份导出成功', 'success');
        } catch (e) {
            Utils.hideLoading();
            Utils.toast(`导出失败: ${e.message}`, 'error');
        }
    },

    clearAllData() {
        const content = document.createElement('div');
        content.className = 'p-6';
        content.innerHTML = `
            <h3 class="text-lg font-bold text-red-400 mb-2">
                <i class="fas fa-exclamation-triangle mr-2"></i>清空所有数据
            </h3>
            <div class="text-gray-300 mb-4">
                这将永久删除所有存储的数据，包括快照、交易记录、训练记录和设置。
            </div>
            <div class="text-red-300 text-sm mb-4 font-bold">此操作不可撤销！</div>
            <div class="mb-4">
                <label class="text-gray-400 text-sm mb-1 block">输入 "DELETE" 确认:</label>
                <input id="clear-confirm-input" class="input" type="text" placeholder="DELETE">
            </div>
            <div class="flex justify-end gap-2">
                <button id="clear-cancel" class="btn btn-secondary">取消</button>
                <button id="clear-confirm" class="btn bg-red-600 hover:bg-red-700 text-white">删除所有数据</button>
            </div>
        `;

        Utils.showModal(content);

        content.querySelector('#clear-cancel').addEventListener('click', () => Utils.hideModal());
        content.querySelector('#clear-confirm').addEventListener('click', async () => {
            const inputVal = content.querySelector('#clear-confirm-input').value;
            if (inputVal !== 'DELETE') {
                Utils.toast('请输入 DELETE 确认', 'error');
                return;
            }
            if (!confirm('确定要删除所有数据吗？此操作不可撤销。')) return;

            Utils.hideModal();
            Utils.showLoading('正在清空数据...');
            try {
                for (const store of ALL_STORES) {
                    await DB.clear(store);
                }
                try {
                    await chrome.storage.local.clear();
                } catch (e) { /* ignore */ }
                Utils.hideLoading();
                Utils.toast('所有数据已清空', 'success');
                await this.loadSettings();
                await this.render();
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`清空失败: ${e.message}`, 'error');
            }
        });
    }
};
