// Training Page - Company training management
// Uses innerHTML pattern with Components (return HTML strings)
window.TrainingPage = {
    employees: [],
    records: [],
    config: { weekly_free_trains: 0, train_price_k: 50 },
    _trainsAvailable: 0,
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
        const price = await DB.get('training_config', 'train_price_k');
        this.config.weekly_free_trains = cfg?.value ?? 0;
        this.config.train_price_k = price?.value ?? 50;

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
            this._trainsAvailable = detail?.trains_available ?? detail?.company?.trains_available ?? 0;
        } catch (e) {
            this._trainsAvailable = '-';
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
                        <div class="text-gray-400 text-sm mb-1">训练价格 (千$/次)</div>
                        <input type="number" min="0" class="input" id="cfg-train-price" value="${this.config.train_price_k}" />
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
        const totalTrains = records.reduce((s, r) => s + (r.trains_count || 0), 0);
        const freeGiven = records.filter(r => r.type === 'free').reduce((s, r) => s + (r.trains_count || 0), 0);
        const sold = records.filter(r => r.type === 'sold' || r.type === 'paid').reduce((s, r) => s + (r.trains_count || 0), 0);
        const revenue = records.filter(r => r.type === 'sold' || r.type === 'paid').reduce((s, r) => s + (r.amount_paid || 0), 0);

        return `
            <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                ${UI.kpiCard('fas fa-dumbbell', '本周训练总次数', totalTrains, '所有训练', 'accent')}
                ${UI.kpiCard('fas fa-gift', '免费赠送', freeGiven, '免费训练', 'green')}
                ${UI.kpiCard('fas fa-coins', '付费/已售', sold, '付费训练', 'gold')}
                ${UI.kpiCard('fas fa-dollar-sign', '收入', Utils.formatMoney(revenue), '训练收入', 'blue')}
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
                        <input type="number" min="0" class="input" id="calc-amount" placeholder="e.g. 5000000" />
                    </div>
                    <button class="btn btn-primary" data-action="calculate">
                        <i class="fas fa-calculator"></i> 计算
                    </button>
                    <div class="flex-1 min-w-[200px]">
                        <label class="text-gray-400 text-sm mb-1 block">应付训练次数</label>
                        <div class="text-torn-gold text-2xl font-bold py-2" id="calc-result">0</div>
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
        const rows = this.employees.map(emp => {
            const empRecords = records.filter(r => String(r.player_id) === String(emp.player_id));
            const totalTrains = empRecords.reduce((s, r) => s + (r.trains_count || 0), 0);
            const types = [...new Set(empRecords.map(r => r.type))];
            const totalPaid = empRecords.reduce((s, r) => s + (r.amount_paid || 0), 0);

            const typeBadges = types.length
                ? types.map(t => {
                    const cls = t === 'free' ? 'badge-green' : t === 'sold' ? 'badge-gold' : 'badge-blue';
                    return `<span class="badge ${cls}">${t}</span>`;
                }).join(' ')
                : '<span class="badge badge-gray">无</span>';

            return {
                id: emp.player_id,
                name: `<a href="https://www.torn.com/profiles.php?XID=${emp.player_id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`,
                position: emp.position,
                trainsCount: totalTrains,
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
                : rec.type === 'sold'
                    ? '<span class="badge badge-gold">sold</span>'
                    : `<span class="badge badge-blue">${rec.type}</span>`;

            return {
                id: rec.id,
                date: rec.date || '-',
                playerName: rec.player_name || '-',
                trainsCount: rec.trains_count || 0,
                type: typeBadge,
                amountPaid: Utils.formatMoney(rec.amount_paid || 0),
                actions: `<button class="btn btn-xs btn-secondary" data-action="delete-record" data-record-id="${rec.id}"><i class="fas fa-trash"></i></button>`
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
        const trainPrice = parseInt(document.getElementById('cfg-train-price')?.value) || 0;
        this.config.weekly_free_trains = freeTrains;
        this.config.train_price_k = trainPrice;
        await DB.put('training_config', { key: 'weekly_free_trains', value: freeTrains });
        await DB.put('training_config', { key: 'train_price_k', value: trainPrice });
        Utils.toast('训练配置已保存', 'success');
    },

    _calculate() {
        const amount = parseFloat(document.getElementById('calc-amount')?.value) || 0;
        const pricePer = (this.config.train_price_k || 1) * 1000;
        const trains = Math.floor(amount / pricePer);
        const resultEl = document.getElementById('calc-result');
        if (resultEl) resultEl.textContent = String(trains);
    },

    async _deleteRecord(recordId) {
        if (!confirm('确定删除此训练记录？')) return;
        await DB.delete('training_records', recordId);
        Utils.toast('记录已删除', 'info');
        await this.render();
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
                            <option value="sold">sold (出售)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">已付金额 ($)</label>
                        <input type="number" min="0" class="input" id="modal-amount-input" value="0" />
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" onclick="Utils.hideModal()">取消</button>
                        <button class="btn btn-primary" id="modal-save-btn">保存</button>
                    </div>
                </div>
            </div>
        `;

        Utils.showModal(html);

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
                amount_paid: parseInt(document.getElementById('modal-amount-input')?.value) || 0
            };
            await DB.put('training_records', record);
            Utils.toast('训练记录已保存', 'success');
            Utils.hideModal();
            await this.render();
        });
    }
};
