// Settings Page - API key, monitoring, app settings
window.SettingsPage = {
    settings: {},
    showKey: false,
    companyInfo: null,

    async init() {
        await this.loadSettings();
        await this.render();
    },

    async loadSettings() {
        const all = await DB.getAll('settings');
        this.settings = {};
        all.forEach(s => { this.settings[s.key] = s.value; });

        // Also load from chrome.storage.local
        try {
            const result = await chrome.storage.local.get([
                'apiKey', 'monitoringEnabled', 'checkInterval', 'refreshInterval', 'notificationsEnabled'
            ]);
            if (result.apiKey && !this.settings.apiKey) this.settings.apiKey = result.apiKey;
            if (result.monitoringEnabled !== undefined && this.settings.monitoringEnabled === undefined)
                this.settings.monitoringEnabled = result.monitoringEnabled;
            if (result.checkInterval && !this.settings.checkInterval)
                this.settings.checkInterval = result.checkInterval;
            if (result.refreshInterval && !this.settings.refreshInterval)
                this.settings.refreshInterval = result.refreshInterval;
            if (result.notificationsEnabled !== undefined && this.settings.notificationsEnabled === undefined)
                this.settings.notificationsEnabled = result.notificationsEnabled;
        } catch (e) {
            // chrome.storage.local may not be available
        }
    },

    async saveSetting(key, value) {
        this.settings[key] = value;
        await DB.put('settings', { key, value });
        try {
            await chrome.storage.local.set({ [key]: value });
        } catch (e) { /* ignore */ }
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
        if (this.settings.apiKey || TornAPI._key) {
            this._loadCompanyInfo();
        }
    },

    _buildPageHTML() {
        const keyType = this.showKey ? 'text' : 'password';
        const eyeIcon = this.showKey ? 'fa-eye-slash' : 'fa-eye';
        const apiKey = this.settings.apiKey || '';
        const monitoring = this.settings.monitoringEnabled ?? false;
        const notifications = this.settings.notificationsEnabled ?? true;
        const checkInterval = this.settings.checkInterval || 5;
        const refreshInterval = this.settings.refreshInterval || 15;

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
                    <div class="flex justify-between">
                        <span class="text-gray-400">作者</span>
                        <span class="text-white">Built for Torn City company directors</span>
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
            await this.saveSetting('apiKey', key);
            Utils.toast('API密钥已保存', 'success');
        });

        // Validate API key
        document.getElementById('settings-validate-key')?.addEventListener('click', async () => {
            const key = document.getElementById('settings-api-key')?.value.trim() || this.settings.apiKey;
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
            await this.saveSetting('monitoringEnabled', e.target.checked);
            this.notifyAlarms();
            Utils.toast(`康复监控已${e.target.checked ? '开启' : '关闭'}`, 'info');
        });

        // Notifications toggle
        document.getElementById('settings-notifications')?.addEventListener('change', async (e) => {
            await this.saveSetting('notificationsEnabled', e.target.checked);
            this.notifyAlarms();
            Utils.toast(`通知已${e.target.checked ? '开启' : '关闭'}`, 'info');
        });

        // Check interval
        document.getElementById('settings-check-interval')?.addEventListener('change', async (e) => {
            await this.saveSetting('checkInterval', parseInt(e.target.value) || 5);
            this.notifyAlarms();
            Utils.toast('检查间隔已更新', 'info');
        });

        // Refresh interval
        document.getElementById('settings-refresh-interval')?.addEventListener('change', async (e) => {
            await this.saveSetting('refreshInterval', parseInt(e.target.value) || 15);
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
