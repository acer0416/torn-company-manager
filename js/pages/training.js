// Training Page - Company training management
// Uses innerHTML pattern with Components (return HTML strings)
window.TrainingPage = {
    employees: [],
    records: [],
    config: { weekly_free_trains: 0, train_price: 50000 },
    _trainsAvailable: 0,
    _apiTrainCounts: {},
    _eventsBound: false,

    async init() {
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载训练数据...');
        try {
            await this._loadData();
            Utils.hideLoading();
            c.innerHTML = this._buildHTML();
            this._bindEvents();
        } catch (e) {
            Utils.hideLoading();
            c.innerHTML = `
                ${this._headerHTML()}
                <div class="text-red-400 p-4">Error: ${e.message}</div>
            `;
            this._bindEvents();
        }
    },

    async _loadData() {
        // Load training config from DB
        const cfg = await DB.get('training_config', 'weekly_free_trains');
        let price = await DB.get('training_config', 'train_price');
        // 迁移旧字段 train_price_k -> train_price
        if (!price) {
            const oldPrice = await DB.get('training_config', 'train_price_k');
            if (oldPrice) {
                price = { key: 'train_price', value: (oldPrice.value || 50) * 1000 };
                await DB.put('training_config', price);
                await DB.delete('training_config', 'train_price_k');
            }
        }
        this.config.weekly_free_trains = cfg?.value ?? 0;
        this.config.train_price = price?.value ?? 50000;

        // Load training records for current week
        const allRecords = await DB.getAll('training_records');
        const wk = Utils.weekKey();
        this.records = (allRecords || []).filter(r => r.week === wk);

        // Load employees（使用缓存 + 统一 API）
        try {
            const data = await AppCache.getOrFetch('employees', () => TornAPI.getEmployeesUnified());
            this.employees = (data || []).map(e => ({
                ...e,
                player_id: String(e.id || e.player_id),
                name: e.name || `ID:${e.id || e.player_id}`,
                position: e.position?.name || e.position || 'N/A'
            }));
        } catch (e) {
            this.employees = [];
        }

        // 同步员工到 employees_master（幂等，不标记离职）
        await Utils.syncEmployeesMaster(this.employees);

        // Fetch trains_available from API
        try {
            const detail = await TornAPI.getCompanyDetailed();
            this._trainsAvailable = detail?.company_detailed?.trains_available
                ?? detail?.trains_available
                ?? detail?.company?.trains_available
                ?? 0;
        } catch (e) {
            this._trainsAvailable = '-';
        }

        try {
            this._apiTrainCounts = await TornAPI.getWeeklyEmployeeTrainCounts();
        } catch (e) {
            console.warn('[TrainingPage] getWeeklyEmployeeTrainCounts:', e.message);
            this._apiTrainCounts = {};
        }

        // 从财务 transactions 表获取本周训练类交易（用于概览收入统计）
        try {
            const allTx = await DB.getAll('transactions');
            const wkStart = Utils.weekDateRange(Utils.weekKey()).start.getTime();
            this._trainTransactions = (allTx || []).filter(tx => {
                if (tx.category !== 'train') return false;
                let ts = tx.timestamp || 0;
                if (ts > 0 && ts < 1e12) ts *= 1000;
                return ts >= wkStart;
            });
        } catch (e) {
            this._trainTransactions = [];
        }
    },

    // ---- HTML Builders ----

    _headerHTML() {
        return `
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-xl font-bold text-white">
                    <i class="fas fa-dumbbell mr-2 text-torn-accent"></i>训练管理
                </h2>
                <div class="flex gap-2">
                    <button class="btn btn-primary" data-action="add-record">
                        <i class="fas fa-plus"></i> 添加记录
                    </button>
                    <button class="btn btn-accent" data-action="refetch-train-data">
                        <i class="fas fa-cloud-download-alt"></i> 重新拉取训练数据
                    </button>
                    <button class="btn btn-secondary" data-action="refresh">
                        <i class="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>
        `;
    },

    _configHTML() {
        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-cog mr-2 text-gray-400"></i>训练配置
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <div>
                        <div class="text-gray-400 text-sm mb-1">可用训练次数 (API)</div>
                        <div class="text-torn-gold text-xl font-bold" id="trains-available">${this._trainsAvailable}</div>
                    </div>
                    <div>
                        <div class="text-gray-400 text-sm mb-1">每周免费训练次数</div>
                        <input type="number" min="0" class="input" id="cfg-free-trains" value="${this.config.weekly_free_trains}" />
                    </div>
                    <div>
                        <div class="text-gray-400 text-sm mb-1">训练价格 ($/次)</div>
                        <input type="text" class="input money-input" id="cfg-train-price" value="${(this.config.train_price || 50000).toLocaleString('en-US')}" placeholder="支持 k/m/b 后缀" />
                    </div>
                </div>
                <button class="btn btn-primary mt-4" data-action="save-config">
                    <i class="fas fa-save"></i> 保存配置
                </button>
            </div>
        `;
    },

    _kpiHTML() {
        const records = this.records;
        const apiCounts = this._apiTrainCounts || {};
        const apiTotalTrains = Object.values(apiCounts).reduce((s, n) => s + (Number(n) || 0), 0);
        const freeGiven = records.filter(r => r.type === 'free').reduce((s, r) => s + (r.trains_count || 0), 0);
        const paid = records.filter(r => r.type === 'paid').reduce((s, r) => s + (r.trains_count || 0), 0);
        const recordRevenue = records.filter(r => r.type === 'paid').reduce((s, r) => s + (r.amount_paid || 0), 0);
        const txRevenue = (this._trainTransactions || []).reduce((s, tx) => s + (tx.amount || 0), 0);
        const totalRevenue = txRevenue > 0 ? txRevenue : recordRevenue;

        return `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                ${UI.kpiCard('fas fa-dumbbell', '本周训练总次数', apiTotalTrains, '来自 Torn API', 'accent')}
                ${UI.kpiCard('fas fa-gift', '免费赠送', freeGiven, '本地记录', 'green')}
                ${UI.kpiCard('fas fa-coins', '付费训练', paid, '本地记录', 'gold')}
                ${UI.kpiCard('fas fa-dollar-sign', '训练收入', Utils.formatMoney(totalRevenue), `记录: ${Utils.formatMoney(recordRevenue)} | 交易: ${Utils.formatMoney(txRevenue)}`, 'blue')}
            </div>
        `;
    },

    _calculatorHTML() {
        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-3">
                    <i class="fas fa-calculator mr-2 text-torn-accent"></i>训练计算器
                </h3>
                <div class="flex flex-wrap items-end gap-4">
                    <div class="flex-1 min-w-[200px]">
                        <label class="text-gray-400 text-sm mb-1 block">支付金额 ($)</label>
                        <input type="text" class="input money-input" id="calc-amount" placeholder="支持 k/m/b 后缀，如 5m" />
                    </div>
                    <button class="btn btn-primary" data-action="calculate">
                        <i class="fas fa-calculator"></i> 计算
                    </button>
                    <div class="flex-1 min-w-[200px]">
                        <label class="text-gray-400 text-sm mb-1 block">可训练次数</label>
                        <div class="text-torn-gold text-2xl font-bold py-2" id="calc-result">0</div>
                        <div class="text-xs text-gray-500" id="calc-hint"></div>
                    </div>
                </div>
            </div>
        `;
    },

    _employeeTableHTML() {
        const headers = [
            { key: 'name', label: '姓名', sortable: true },
            { key: 'position', label: '职位', sortable: true },
            { key: 'trainsCount', label: '本周训练次数', sortable: true },
            { key: 'type', label: '训练类型' },
            { key: 'amountPaid', label: '已付金额', sortable: true },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const records = this.records;
        const apiCounts = this._apiTrainCounts || {};
        const rows = this.employees.map(emp => {
            const empRecords = records.filter(r => String(r.player_id) === String(emp.player_id));
            const apiCount = apiCounts[String(emp.player_id)];
            const trainsCount = apiCount !== undefined && apiCount !== null ? apiCount : 0;
            const types = [...new Set(empRecords.map(r => r.type))];
            const totalPaid = empRecords.reduce((s, r) => s + (r.amount_paid || 0), 0);

            const typeBadges = types.length
                ? types.map(t => {
                    const cls = t === 'free' ? 'badge-green' : 'badge-blue';
                    return `<span class="badge ${cls}">${t}</span>`;
                }).join(' ')
                : '<span class="badge badge-gray">无</span>';

            return {
                id: emp.player_id,
                name: `<a href="https://www.torn.com/profiles.php?XID=${emp.player_id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`,
                position: emp.position,
                trainsCount: `<span class="font-bold text-white">${trainsCount}</span>`,
                type: typeBadges,
                amountPaid: Utils.formatMoney(totalPaid),
                actions: `<button class="btn btn-xs btn-primary" data-action="add-for-emp" data-emp-id="${emp.player_id}"><i class="fas fa-plus"></i> 训练</button>`
            };
        });

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-users mr-2 text-torn-accent"></i>员工训练记录 (本周)
                </h3>
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'train-emp-table',
                    emptyText: '暂无员工数据'
                })}
            </div>
        `;
    },

    _recordsTableHTML() {
        const headers = [
            { key: 'date', label: '日期', sortable: true },
            { key: 'playerName', label: '员工', sortable: true },
            { key: 'trainsCount', label: '训练次数', sortable: true },
            { key: 'type', label: '训练类型' },
            { key: 'amountPaid', label: '已付金额', sortable: true },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const rows = this.records.map(rec => {
            const typeBadge = rec.type === 'free'
                ? '<span class="badge badge-green">free</span>'
                : `<span class="badge badge-blue">${rec.type}</span>`;

            return {
                id: rec.id,
                date: rec.date || '-',
                playerName: rec.player_name || '-',
                trainsCount: rec.trains_count || 0,
                type: typeBadge,
                amountPaid: Utils.formatMoney(rec.amount_paid || 0),
                actions: `<button class="btn btn-xs btn-secondary" data-action="edit-record" data-record-id="${rec.id}"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-xs btn-secondary" data-action="delete-record" data-record-id="${rec.id}"><i class="fas fa-trash"></i></button>`
            };
        });

        return `
            <div class="card">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-list mr-2 text-torn-accent"></i>训练记录 - 第 ${Utils.weekKey()} 周
                </h3>
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'train-records-table',
                    emptyText: '本周暂无训练记录'
                })}
            </div>
        `;
    },

    _buildHTML() {
        return `
            ${this._headerHTML()}
            ${this._configHTML()}
            ${this._kpiHTML()}
            ${this._calculatorHTML()}
            ${this._employeeTableHTML()}
            ${this._recordsTableHTML()}
        `;
    },

    // ---- Event Binding ----

    _bindEvents() {
        const c = document.getElementById('page-content');
        if (!c) return;

        // Only bind the delegated click handler once to avoid stacking duplicates
        if (!this._eventsBound) {
            this._eventsBound = true;
            c.addEventListener('click', async (e) => {
                const btn = e.target.closest('[data-action]');
                if (!btn) return;

                const action = btn.dataset.action;
                switch (action) {
                    case 'refresh':
                        await this.render();
                        break;
                    case 'refetch-train-data':
                        await this._refetchTrainData();
                        break;
                    case 'add-record':
                        this.showAddModal();
                        break;
                    case 'add-for-emp':
                        this.showAddModal(btn.dataset.empId);
                        break;
                    case 'save-config':
                        await this._saveConfig();
                        break;
                    case 'calculate':
                        this._calculate();
                        break;
                    case 'edit-record':
                        this._showEditModal(btn.dataset.recordId);
                        break;
                    case 'delete-record':
                        await this._deleteRecord(btn.dataset.recordId);
                        break;
                }
            });
        }

        // Init sortable tables
        UI.initSortable('train-emp-table');
        UI.initSortable('train-records-table');
    },

    // ---- Actions ----

    async _saveConfig() {
        const freeTrains = parseInt(document.getElementById('cfg-free-trains')?.value) || 0;
        const trainPrice = Utils.parseMoneyInput(document.getElementById('cfg-train-price')?.value);
        this.config.weekly_free_trains = freeTrains;
        this.config.train_price = trainPrice;
        await DB.put('training_config', { key: 'weekly_free_trains', value: freeTrains });
        await DB.put('training_config', { key: 'train_price', value: trainPrice });
        Utils.toast('训练配置已保存', 'success');
    },

    _calculate() {
        const amount = Utils.parseMoneyInput(document.getElementById('calc-amount')?.value);
        const priceInput = document.getElementById('cfg-train-price')?.value;
        const pricePer = Utils.parseMoneyInput(priceInput) || this.config.train_price || 0;
        const resultEl = document.getElementById('calc-result');
        const hintEl = document.getElementById('calc-hint');
        if (!resultEl) return;
        if (!amount || amount <= 0) {
            resultEl.textContent = '0';
            if (hintEl) hintEl.textContent = '请输入支付金额';
            return;
        }
        if (!pricePer || pricePer <= 0) {
            resultEl.textContent = '—';
            if (hintEl) hintEl.textContent = '请先设置有效的训练单价';
            return;
        }
        const trains = Math.floor(amount / pricePer);
        const remainder = amount - trains * pricePer;
        resultEl.textContent = String(trains);
        if (hintEl) {
            hintEl.textContent = remainder > 0
                ? `单价 ${Utils.formatMoney(pricePer)}，余 ${Utils.formatMoney(remainder)} 不足 1 次`
                : `单价 ${Utils.formatMoney(pricePer)} × ${trains} 次 = ${Utils.formatMoney(trains * pricePer)}`;
        }
    },

    async _deleteRecord(recordId) {
        if (!confirm('确定删除此训练记录？')) return;
        // training_records store uses autoIncrement (numeric key), but dataset values are strings
        await DB.delete('training_records', Number(recordId));
        Utils.toast('记录已删除', 'info');
        await this.render();
    },

    async _refetchTrainData() {
        Utils.showLoading('正在从 Torn API 重新拉取训练数据...');
        try {
            // 重新获取公司新闻并解析训练计数
            this._apiTrainCounts = await TornAPI.getWeeklyEmployeeTrainCounts();
            // 重新获取公司详情（更新可用训练次数）
            try {
                const detail = await TornAPI.getCompanyDetailed();
                this._trainsAvailable = detail?.company_detailed?.trains_available
                    ?? detail?.trains_available
                    ?? detail?.company?.trains_available
                    ?? 0;
            } catch (e) {
                console.warn('[TrainingPage] refetch detailed:', e.message);
            }
            Utils.hideLoading();
            Utils.toast('训练数据已重新拉取', 'success');
            await this.render();
        } catch (e) {
            Utils.hideLoading();
            Utils.toast(`拉取训练数据失败: ${e.message}`, 'error');
            console.error('[TrainingPage] _refetchTrainData:', e);
        }
    },

    _showEditModal(recordId) {
        const rec = this.records.find(r => String(r.id) === String(recordId));
        if (!rec) {
            Utils.toast('记录不存在', 'warning');
            return;
        }
        const empOptions = this.employees.map(e => {
            const sel = String(e.player_id) === String(rec.player_id) ? 'selected' : '';
            return `<option value="${e.player_id}" ${sel}>${e.name}</option>`;
        }).join('');

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">编辑训练记录</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">员工</label>
                        <select class="input" id="edit-emp-select">${empOptions}</select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">日期</label>
                        <input type="date" class="input" id="edit-date" value="${rec.date || Utils.todayKey()}" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">训练次数</label>
                        <input type="number" min="1" class="input" id="edit-trains" value="${rec.trains_count || 1}" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">类型</label>
                        <select class="input" id="edit-type">
                            <option value="free" ${rec.type === 'free' ? 'selected' : ''}>free (免费)</option>
                            <option value="paid" ${rec.type === 'paid' ? 'selected' : ''}>paid (付费)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">已付金额 ($)</label>
                        <input type="text" class="input money-input" id="edit-amount" value="${rec.amount_paid || 0}" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">备注</label>
                        <input type="text" class="input" id="edit-note" value="${(rec.note || '').replace(/"/g, '&quot;')}" />
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" id="edit-train-cancel">取消</button>
                        <button class="btn btn-primary" id="edit-train-save">保存</button>
                    </div>
                </div>
            </div>
        `
        Utils.showModal(html);

        document.getElementById('edit-train-cancel')?.addEventListener('click', () => Utils.hideModal());
        document.getElementById('edit-train-save')?.addEventListener('click', async () => {
            const empId = document.getElementById('edit-emp-select')?.value;
            const emp = this.employees.find(e => String(e.player_id) === String(empId));
            rec.player_id = empId;
            rec.player_name = emp?.name || rec.player_name;
            rec.date = document.getElementById('edit-date')?.value || rec.date;
            rec.week = Utils.weekKey(new Date(rec.date + 'T12:00:00'));
            rec.trains_count = parseInt(document.getElementById('edit-trains')?.value, 10) || 1;
            rec.type = document.getElementById('edit-type')?.value || 'paid';
            rec.amount_paid = Utils.parseMoneyInput(document.getElementById('edit-amount')?.value);
            rec.note = document.getElementById('edit-note')?.value?.trim() || '';
            await DB.put('training_records', rec);
            Utils.toast('训练记录已更新', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    showAddModal(preselectedEmpId) {
        const empOptions = this.employees.map(e => {
            const sel = String(e.player_id) === String(preselectedEmpId) ? 'selected' : '';
            return `<option value="${e.player_id}" ${sel}>${e.name}</option>`;
        }).join('');

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">添加训练记录</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">员工</label>
                        <select class="input" id="modal-emp-select">
                            <option value="">-- 选择员工 --</option>
                            ${empOptions}
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">训练次数</label>
                        <input type="number" min="1" class="input" id="modal-trains-input" value="1" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">类型</label>
                        <select class="input" id="modal-type-select">
                            <option value="free">free (免费)</option>
                            <option value="paid">paid (付费)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">已付金额 ($)</label>
                        <input type="number" min="0" class="input" id="modal-amount-input" value="0" />
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" id="modal-train-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-save-btn">保存</button>
                    </div>
                </div>
            </div>
        `;

        Utils.showModal(html);

        // 取消按钮：关闭弹窗并重置表单
        document.getElementById('modal-train-cancel')?.addEventListener('click', () => {
            Utils.hideModal();
        });

        document.getElementById('modal-save-btn')?.addEventListener('click', async () => {
            const empId = document.getElementById('modal-emp-select')?.value;
            if (!empId) {
                Utils.toast('请选择员工', 'warning');
                return;
            }
            const emp = this.employees.find(e => String(e.player_id) === empId);
            const record = {
                player_id: empId,
                player_name: emp?.name || '',
                date: Utils.todayKey(),
                week: Utils.weekKey(),
                type: document.getElementById('modal-type-select')?.value || 'free',
                trains_count: parseInt(document.getElementById('modal-trains-input')?.value) || 0,
                amount_paid: Utils.parseMoneyInput(document.getElementById('modal-amount-input')?.value)
            };
            await DB.put('training_records', record);
            Utils.toast('训练记录已保存', 'success');
            Utils.hideModal();
            await this.render();
        });
    }
};
