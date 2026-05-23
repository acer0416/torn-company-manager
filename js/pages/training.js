// Training Page - Company training management
// Uses innerHTML pattern with Components (return HTML strings)
window.TrainingPage = {
    employees: [],
    records: [],
    config: { weekly_free_trains: 0, train_price: 50000 },
    _trainsAvailable: 0,
    _apiTrainCounts: {},
    _eventsBound: false,
    _selectedRecordIds: new Set(),
    _allRecords: [],
    _nameFilterValue: '',
    _trainFundSummary: new Map(),
    _currentWeek: null,

    async init() {
        this._currentWeek = Utils.weekKey();
        console.log('[TrainingPage.init] _selectedRecordIds initialized:', this._selectedRecordIds instanceof Set);
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
        const wk = this._currentWeek;
        this._allRecords = (allRecords || []).filter(r => r.week === wk);
        this.records = [...this._allRecords];
        console.log('[TrainingPage._loadData] _allRecords count:', this._allRecords.length, '_selectedRecordIds:', this._selectedRecordIds ? 'Set' : 'UNDEFINED');

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

        // 统一使用本地 training_records 作为唯一数据源计算看板和员工列表的训练次数
        this._apiTrainCounts = {};
        for (const r of this.records) {
            const pid = String(r.player_id);
            const count = Number(r.trains_count) || 1;
            this._apiTrainCounts[pid] = (this._apiTrainCounts[pid] || 0) + count;
        }

        try {
            const allTx = await DB.getAll('transactions') || [];
            const allAllocations = await DB.getAll('train_fund_allocations') || [];
            const allTrainTxs = allTx.filter(tx => tx.category === 'train');
            
            // For revenue overview (this week only)
            const wkStart = Utils.weekDateRange(this._currentWeek).start.getTime();
            this._trainTransactions = allTrainTxs.filter(tx => {
                let ts = tx.timestamp || 0;
                if (ts > 0 && ts < 1e12) ts *= 1000;
                return ts >= wkStart;
            });

            // Auto-Sync Train Transactions to Train Fund Allocations
            const allocsByFinanceId = new Map();
            allAllocations.forEach(a => {
                if (a.financeRecordId) allocsByFinanceId.set(String(a.financeRecordId), a);
            });

            const txIds = new Set(allTrainTxs.map(tx => String(tx.id)));
            let syncChanged = false;

            // 1. Auto-Create
            for (const tx of allTrainTxs) {
                if (!allocsByFinanceId.has(String(tx.id))) {
                    // Create new allocation
                    const trainPrice = this.config.train_price || 50000;
                    const amount = Number(tx.amount) || 0;
                    const expectedCount = Math.floor(amount / trainPrice);
                    
                    if (expectedCount > 0) {
                        const allocationId = 'fund_auto_' + tx.id;
                        let txTs = tx.timestamp || Date.now();
                        if (txTs < 1e12) txTs *= 1000;
                        const txDateObj = new Date(txTs);
                        const wk = Utils.weekKey(txDateObj);
                        
                        const record = {
                            id: allocationId,
                            employeeId: String(tx.player_id),
                            employeeName: tx.player_name || ('ID:' + tx.player_id),
                            amount: amount,
                            trainPrice: trainPrice,
                            expectedCount: expectedCount,
                            fulfilledCount: 0,
                            weekKey: wk,
                            note: tx.note || '自动同步',
                            createdAt: Date.now(),
                            financeRecordId: String(tx.id)
                        };
                        
                        await DB.put('train_fund_allocations', record);
                        allAllocations.push(record);
                        syncChanged = true;
                    }
                }
            }

            // 2. Auto-Delete
            for (let i = allAllocations.length - 1; i >= 0; i--) {
                const alloc = allAllocations[i];
                if (alloc.financeRecordId && !txIds.has(String(alloc.financeRecordId))) {
                    // Transaction was deleted, remove allocation
                    await DB.delete('train_fund_allocations', alloc.id);
                    allAllocations.splice(i, 1);
                    
                    const allTrainingRecords = await DB.getAll('training_records') || [];
                    const fundNote = 'fund:' + alloc.id;
                    for (const rec of allTrainingRecords) {
                        if (rec.note === fundNote) {
                            // Revert matched records to free
                            rec.type = 'free';
                            rec.amount_paid = 0;
                            rec.note = '';
                            await DB.put('training_records', rec);
                        }
                    }
                    syncChanged = true;
                }
            }
            
            // 3. Auto-Match Unassigned API Trainings
            let allTrainingRecords = await DB.getAll('training_records') || [];
            
            // Migration: Fix timestamps stored in seconds instead of ms, and their generated weeks
            let dirtyRecords = false;
            for (const r of allTrainingRecords) {
                if (r.timestamp && r.timestamp < 10000000000) { // Timestamp in seconds (year < 2286)
                    r.timestamp = r.timestamp * 1000;
                    r.raw_date = new Date(r.timestamp).toISOString();
                    r.week = Utils.weekKey(new Date(r.timestamp));
                    await DB.put('training_records', r);
                    dirtyRecords = true;
                }
            }
            if (dirtyRecords) {
                allTrainingRecords = await DB.getAll('training_records') || [];
            }
            
            allTrainingRecords.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0)); // 按时间正序，优先抵扣历史欠训
            for (const alloc of allAllocations) {
                if (alloc.weekKey !== this._currentWeek) continue;
                const actualFulfilled = allTrainingRecords.filter(r => r.note === 'fund:' + alloc.id).length;
                let needed = alloc.expectedCount - actualFulfilled;
                if (needed > 0) {
                    const empRecords = allTrainingRecords.filter(r => 
                        String(r.player_id) === String(alloc.employeeId) && 
                        r.week <= alloc.weekKey && // 允许跨周匹配之前的未付款训练
                        !(r.note && r.note.startsWith('fund:')) &&
                        r.type !== 'paid'
                    );
                    
                    for (let i = 0; i < empRecords.length && needed > 0; i++) {
                        const rec = empRecords[i];
                        rec.type = 'paid';
                        rec.amount_paid = alloc.trainPrice;
                        rec.note = 'fund:' + alloc.id;
                        await DB.put('training_records', rec);
                        needed--;
                        syncChanged = true;
                    }
                }
            }
            
            // If sync generated, deleted or matched records, reload local state
            if (syncChanged) {
                const updatedRecords = await DB.getAll('training_records');
                const wk = this._currentWeek;
                this._allRecords = (updatedRecords || []).filter(r => r.week === wk);
                this.records = [...this._allRecords];
            }

        } catch (e) {
            console.error('[TrainingPage] Sync error:', e);
            this._trainTransactions = [];
        }

        // 加载训练资金分配汇总，并更新 fulfilledCount
        this._trainFundSummary = await this._loadTrainFundSummary();
        
        // 加载所有自动生成的分配，用于展示
        const finalAllocs = await DB.getAll('train_fund_allocations') || [];
        this._trainFundAllocations = finalAllocs.filter(a => a.weekKey === this._currentWeek);
    },

    // 从 IndexedDB 加载当前周的训练资金分配汇总
    // 返回 Map<employeeId, { expectedCount, fulfilledCount, remaining }>
    async _loadTrainFundSummary() {
        const wk = this._currentWeek;
        const summary = new Map();

        try {
            const allAllocations = await DB.getAll('train_fund_allocations');
            const wkAllocations = (allAllocations || []).filter(a => a.weekKey === wk);

            // 获取全部训练记录（跨周），因为可能抵扣了历史记录
            const allRecords = await DB.getAll('training_records') || [];
            const fundRecords = allRecords.filter(r => r.note && r.note.startsWith('fund:'));

            for (const alloc of wkAllocations) {
                const empId = String(alloc.employeeId);
                const expectedCount = alloc.expectedCount || 0;

                // 计算 fulfilledCount：精确匹配当前资金的分配 ID
                const fulfilledCount = fundRecords.filter(r => r.note === 'fund:' + alloc.id).length;

                // 如果 fulfilledCount 与存储值不同，更新到 DB
                if (fulfilledCount !== (alloc.fulfilledCount || 0)) {
                    alloc.fulfilledCount = fulfilledCount;
                    try {
                        await DB.put('train_fund_allocations', alloc);
                    } catch (e) {
                        console.warn('[TrainingPage] Failed to update fulfilledCount for', empId, e.message);
                    }
                }

                const remaining = Math.max(0, expectedCount - fulfilledCount);

                if (!summary.has(empId)) {
                    summary.set(empId, { expectedCount: 0, fulfilledCount: 0, remaining: 0 });
                }
                const entry = summary.get(empId);
                entry.expectedCount += expectedCount;
                entry.fulfilledCount += fulfilledCount;
                entry.remaining += remaining;
            }
        } catch (e) {
            console.warn('[TrainingPage] _loadTrainFundSummary:', e.message);
        }

        return summary;
    },

    // ---- HTML Builders ----

    _headerHTML() {
        const isCurrentWeek = this._currentWeek >= Utils.weekKey();
        return `
            <div class="flex items-center justify-between mb-6">
                <div class="flex items-center gap-4">
                    <h2 class="text-xl font-bold text-white">
                        <i class="fas fa-dumbbell mr-2 text-torn-accent"></i>训练管理
                    </h2>
                    <div class="flex items-center bg-torn-surface rounded border border-torn-border px-2 py-1">
                        <button class="btn btn-xs btn-secondary" data-action="prev-week" title="上一周"><i class="fas fa-chevron-left"></i></button>
                        <span class="text-sm text-gray-300 px-3 font-mono">${this._currentWeek}</span>
                        <button class="btn btn-xs btn-secondary" data-action="next-week" title="下一周" ${isCurrentWeek ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>
                    </div>
                </div>
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

        // 计算待完成训练总数
        const fundSummary = this._trainFundSummary || new Map();
        let pendingTotal = 0;
        for (const entry of fundSummary.values()) {
            pendingTotal += entry.remaining;
        }

        return `
            <div class="grid grid-cols-2 md:grid-cols-5 gap-3 mb-6">
                ${UI.kpiCard('fas fa-dumbbell', '本周训练总次数', apiTotalTrains, '来自 Torn API', 'accent')}
                ${UI.kpiCard('fas fa-gift', '免费赠送', freeGiven, '本地记录', 'green')}
                ${UI.kpiCard('fas fa-coins', '付费训练', paid, '本地记录', 'gold')}
                ${UI.kpiCard('fas fa-dollar-sign', '训练收入', Utils.formatMoney(totalRevenue), `记录: ${Utils.formatMoney(recordRevenue)} | 交易: ${Utils.formatMoney(txRevenue)}`, 'blue')}
                ${UI.kpiCard('fas fa-clock', '待完成训练', pendingTotal, '所有员工剩余应训练次数之和', 'orange')}
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
            { key: 'remaining', label: '剩余应训', sortable: true },
            { key: 'amountPaid', label: '已付金额', sortable: true },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const records = this.records;
        const apiCounts = this._apiTrainCounts || {};
        const fundSummary = this._trainFundSummary || new Map();
        const rows = this.employees.map(emp => {
            const empRecords = records.filter(r => String(r.player_id) === String(emp.player_id));
            const apiCount = apiCounts[String(emp.player_id)];
            const trainsCount = apiCount !== undefined && apiCount !== null ? apiCount : 0;
            const totalPaid = empRecords.reduce((s, r) => s + (r.amount_paid || 0), 0);

            // 计算剩余应训练次数
            const fundEntry = fundSummary.get(String(emp.player_id));
            let remainingHTML = '<span class="text-gray-500">-</span>';
            if (fundEntry) {
                const remaining = fundEntry.remaining;
                if (remaining > 0) {
                    remainingHTML = `<span class="font-bold text-orange-400">${remaining}</span>`;
                } else {
                    remainingHTML = `<span class="font-bold text-green-400">已完成</span>`;
                }
            }

            return {
                id: emp.player_id,
                name: `<a href="https://www.torn.com/profiles.php?XID=${emp.player_id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`,
                position: emp.position,
                trainsCount: `<span class="font-bold text-white">${trainsCount}</span>`,
                remaining: remainingHTML,
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
            { key: '_checkbox', label: '<input type="checkbox" id="select-all-records" />', sortable: false, width: '40px' },
            { key: 'date', label: '日期', sortable: true },
            { key: 'playerName', label: '员工', sortable: true },
            { key: 'trainsCount', label: '训练次数', sortable: true },
            { key: 'type', label: '训练类型' },
            { key: 'amountPaid', label: '已付金额', sortable: true },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const rows = this.records.map(rec => {
            const isChecked = (this._selectedRecordIds && this._selectedRecordIds.has(rec.id)) ? 'checked' : '';
            const isFundRecord = rec.note && rec.note.startsWith('fund:');
            const fundIcon = isFundRecord ? ' 💰' : '';
            const typeBadge = rec.type === 'free'
                ? '<span class="badge badge-green">free</span>'
                : `<span class="badge badge-blue">${rec.type}${fundIcon}</span>`;

            return {
                id: rec.id,
                _checkbox: `<input type="checkbox" class="record-checkbox" data-record-id="${rec.id}" ${isChecked} />`,
                date: rec.date || '-',
                playerName: rec.player_name || '-',
                trainsCount: rec.trains_count || 0,
                type: typeBadge,
                amountPaid: Utils.formatMoney(rec.amount_paid || 0),
                actions: `<button class="btn btn-xs btn-secondary" data-action="edit-record" data-record-id="${rec.id}"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-xs btn-secondary" data-action="delete-record" data-record-id="${rec.id}"><i class="fas fa-trash"></i></button>`
            };
        });

        const batchBar = `
            <div class="batch-actions-bar flex items-center justify-between mb-3" id="batch-actions-bar" style="display: none;">
                <span class="text-sm text-gray-400">
                    已选择 <span id="selected-count" class="text-torn-accent font-bold">0</span> 条记录
                </span>
                <div class="flex gap-2">
                    <button class="btn btn-xs btn-accent" data-action="batch-set-category" id="btn-batch-set-category">
                        <i class="fas fa-folder"></i> 批量设置分类
                    </button>
                    <button class="btn btn-xs btn-danger" data-action="batch-delete" id="btn-batch-delete">
                        <i class="fas fa-trash"></i> 批量删除
                    </button>
                </div>
            </div>
        `;

        const nameFilterBar = `
            <div class="flex items-center gap-2 mb-3" id="name-filter-bar">
                <div class="relative flex-1 max-w-xs">
                    <input type="text" class="input" id="train-name-filter" placeholder="按员工名称筛选..." value="${this._nameFilterValue || ''}" />
                    ${this._nameFilterValue ? `<button class="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-white" id="clear-name-filter" style="background:none;border:none;cursor:pointer;line-height:1;">&times;</button>` : ''}
                </div>
            </div>
        `;

        return `
            <div class="card">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-list mr-2 text-torn-accent"></i>训练记录 - 第 ${this._currentWeek.split('W')[1] || this._currentWeek} 周
                </h3>
                ${nameFilterBar}
                ${batchBar}
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'train-records-table',
                    emptyText: '本周暂无训练记录'
                })}
            </div>
        `;
    },

    _trainFundHTML() {
        const allocations = this._trainFundAllocations || [];
        if (allocations.length === 0) return '';
        
        const headers = [
            { key: 'employeeName', label: '员工名称', sortable: true },
            { key: 'amount', label: '资金总额', sortable: true },
            { key: 'trainPrice', label: '单价', sortable: true },
            { key: 'expectedCount', label: '预期', sortable: true },
            { key: 'fulfilledCount', label: '已完成', sortable: true },
            { key: 'progress', label: '进度', sortable: true },
            { key: 'note', label: '备注', width: '200px' },
            { key: 'actions', label: '操作', sortable: false }
        ];

        // 合并同一个员工的多条资金分配记录
        const mergedMap = new Map();
        allocations.forEach(a => {
            const empId = a.employeeId;
            if (!mergedMap.has(empId)) {
                mergedMap.set(empId, {
                    empId: empId,
                    employeeName: a.employeeName,
                    amount: 0,
                    trainPrice: a.trainPrice, // 以第一条的单价为准
                    expectedCount: 0,
                    fulfilledCount: 0,
                    notes: []
                });
            }
            const m = mergedMap.get(empId);
            m.amount += (Number(a.amount) || 0);
            m.expectedCount += (Number(a.expectedCount) || 0);
            m.fulfilledCount += (Number(a.fulfilledCount) || 0);
            if (a.note) m.notes.push(a.note);
        });

        const mergedAllocations = Array.from(mergedMap.values());

        const rows = mergedAllocations.map(a => {
            const expected = a.expectedCount || 0;
            const fulfilled = a.fulfilledCount || 0;
            const pct = expected > 0 ? Math.round(fulfilled / expected * 100) : 0;
            const progressBar = '<div class="w-full bg-gray-700 rounded-full h-2.5">' +
                '<div class="bg-torn-accent h-2.5 rounded-full" style="width:' + pct + '%"></div>' +
                '</div>' +
                '<span class="text-xs text-gray-400">' + fulfilled + '/' + expected + ' (' + pct + '%)</span>';
            
            const combinedNote = a.notes.join(' | ');

            return {
                employeeName: a.employeeName || '-',
                amount: Utils.formatCurrency(a.amount || 0),
                trainPrice: Utils.formatCurrency(a.trainPrice || 0),
                expectedCount: expected,
                fulfilledCount: fulfilled,
                progress: progressBar,
                note: combinedNote ? '<span class="truncate block max-w-[200px]" title="' + combinedNote.replace(/"/g, '&quot;') + '">' + combinedNote + '</span>' : '-',
                actions: `<button class="btn btn-xs btn-primary" data-action="view-fund-details" data-emp-id="${a.empId}">查看明细</button>`
            };
        });

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-2">
                    <i class="fas fa-hand-holding-usd mr-2 text-torn-accent"></i>训练资金自动同步状态
                </h3>
                <p class="text-xs text-gray-400 mb-4">自动同步自财务管理的“训练”类交易。如需修改或删除，请前往财务管理操作。</p>
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'train-fund-table',
                    emptyText: '本周暂无训练资金交易'
                })}
            </div>
        `;
    },

    async _showFundDetailsModal(empId) {
        const emp = this.employees.find(e => String(e.player_id) === String(empId));
        if (!emp) return;

        const allAllocations = await DB.getAll('train_fund_allocations') || [];
        const wkAllocations = allAllocations.filter(a => a.weekKey === this._currentWeek && String(a.employeeId) === String(empId));
        
        if (wkAllocations.length === 0) {
            Utils.toast('未找到本周的资金分配记录', 'info');
            return;
        }

        const allocIds = wkAllocations.map(a => a.id);
        const allRecords = await DB.getAll('training_records') || [];
        
        // 筛选出被抵扣到这些资金分配上的记录
        const matchedRecords = allRecords.filter(r => r.note && allocIds.some(id => r.note === 'fund:' + id));

        const html = `
            <div class="p-6 w-[800px] max-w-[90vw]">
                <h3 class="text-lg font-bold text-white mb-2">资金抵扣明细 - ${emp.name}</h3>
                <div class="text-gray-400 text-sm mb-4">展示本周该员工名下资金所匹配的所有训练记录</div>
                <div class="overflow-x-auto">
                    <table class="w-full text-left border-collapse">
                        <thead>
                            <tr class="bg-torn-surface text-gray-400 text-sm border-b border-torn-border">
                                <th class="p-2">训练时间</th>
                                <th class="p-2">归属周</th>
                                <th class="p-2">分类</th>
                                <th class="p-2">抵扣金额</th>
                                <th class="p-2 text-right">操作</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${matchedRecords.length === 0 ? `
                                <tr><td colspan="5" class="p-4 text-center text-gray-500 text-sm">暂无匹配记录</td></tr>
                            ` : matchedRecords.map(r => `
                                <tr class="border-b border-torn-border/50 hover:bg-torn-surface/50 text-sm">
                                    <td class="p-2 text-white">${Utils.formatDateTime(r.timestamp) || r.raw_date}</td>
                                    <td class="p-2 text-gray-300">${r.week}</td>
                                    <td class="p-2 text-gray-300">${(window.TRAIN_CATEGORIES.find(c => c.id === (r.category || 'other')) || {name: r.category || 'other'}).name}</td>
                                    <td class="p-2 text-torn-green font-bold">${Utils.formatMoney(r.amount_paid || 0)}</td>
                                    <td class="p-2 text-right">
                                        <button class="btn btn-xs btn-secondary" data-action="unmatch-fund-record" data-record-id="${r.id}">解除抵扣</button>
                                    </td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
                <div class="flex justify-end mt-6">
                    <button class="btn btn-secondary" id="modal-fund-close">关闭</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-fund-close')?.addEventListener('click', () => Utils.hideModal());

        // unbind previous delegated events on modal content if any
        const modalContent = document.getElementById('modal-content');
        if (modalContent) {
            const unmatchHandler = async (e) => {
                const btn = e.target.closest('[data-action="unmatch-fund-record"]');
                if (!btn) return;
                
                if (!confirm('确定要解除这条记录的抵扣状态吗？\n它将被恢复为“免费训练”。')) return;

                const idStr = String(btn.dataset.recordId);
                const id = isNaN(Number(idStr)) ? idStr : Number(idStr);

                const rec = await DB.get('training_records', id);
                if (rec) {
                    rec.type = 'free';
                    rec.amount_paid = 0;
                    rec.note = 'api_sync'; // Restore to default api sync note
                    await DB.put('training_records', rec);
                    Utils.toast('已解除抵扣', 'success');
                    Utils.hideModal();
                    await this.render();
                }
            };
            
            // simple hack to bind event uniquely
            modalContent.onclick = unmatchHandler;
        }
    },

    _buildHTML() {
        return `
            ${this._headerHTML()}
            ${this._configHTML()}
            ${this._kpiHTML()}
            ${this._calculatorHTML()}
            ${this._trainFundHTML()}
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
                if (Router.currentPage !== 'training') return;

                const btn = e.target.closest('[data-action]');
                if (!btn) return;

                const action = btn.dataset.action;
                switch (action) {
                    case 'refresh':
                        await this.render();
                        break;
                    case 'prev-week':
                        await this._goToPrevWeek();
                        break;
                    case 'next-week':
                        await this._goToNextWeek();
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
                    case 'batch-delete':
                        await this._batchDeleteRecords();
                        break;
                    case 'batch-set-category':
                        await this._batchSetCategory();
                        break;
                    case 'view-fund-details':
                        await this._showFundDetailsModal(btn.dataset.empId);
                        break;
                }
            });

            c.addEventListener('input', (e) => {
                if (Router.currentPage !== 'training') return;
                if (e.target.id === 'train-name-filter') {
                    this._filterRecordsByNameDebounced();
                }
            });

            c.addEventListener('click', (e) => {
                if (Router.currentPage !== 'training') return;
                if (e.target.id === 'clear-name-filter') {
                    const filterInput = document.getElementById('train-name-filter');
                    if (filterInput) {
                        filterInput.value = '';
                        this._nameFilterValue = '';
                        this._filterRecordsByName();
                    }
                }
            });
        }

        // 全选/取消全选 checkbox
        const selectAll = document.getElementById('select-all-records');
        if (selectAll) {
            selectAll.addEventListener('change', () => {
                const checkboxes = document.querySelectorAll('.record-checkbox');
                checkboxes.forEach(cb => {
                    cb.checked = selectAll.checked;
                    const idStr = cb.dataset.recordId;
                    const id = isNaN(Number(idStr)) ? idStr : Number(idStr);
                    if (selectAll.checked) {
                        this._selectedRecordIds.add(id);
                    } else {
                        this._selectedRecordIds.delete(id);
                    }
                });
                this._updateBatchBar();
            });
        }

        // 单个 checkbox 变化
        document.querySelectorAll('.record-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const idStr = cb.dataset.recordId;
                const id = isNaN(Number(idStr)) ? idStr : Number(idStr);
                if (cb.checked) {
                    this._selectedRecordIds.add(id);
                } else {
                    this._selectedRecordIds.delete(id);
                }
                const allCb = document.getElementById('select-all-records');
                if (allCb) {
                    const total = document.querySelectorAll('.record-checkbox').length;
                    allCb.checked = this._selectedRecordIds.size === total && total > 0;
                    allCb.indeterminate = this._selectedRecordIds.size > 0 && this._selectedRecordIds.size < total;
                }
                this._updateBatchBar();
            });
        });

        this._updateBatchBar();

        // Init sortable tables
        UI.initSortable('train-emp-table');
        UI.initSortable('train-records-table');
    },

    // ---- Actions ----

    async _goToPrevWeek() {
        this._currentWeek = Utils.weekKeyAdd(this._currentWeek, -1);
        if (this._selectedRecordIds) this._selectedRecordIds.clear();
        await this.render();
    },

    async _goToNextWeek() {
        if (this._currentWeek >= Utils.weekKey()) return;
        this._currentWeek = Utils.weekKeyAdd(this._currentWeek, 1);
        if (this._selectedRecordIds) this._selectedRecordIds.clear();
        await this.render();
    },

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
        const idStr = String(recordId);
        const id = isNaN(Number(idStr)) ? idStr : Number(idStr);
        await DB.delete('training_records', id);
        Utils.toast('记录已删除', 'info');
        await this.render();
    },

    async _mergeApiEntriesToRecords(entries) {
        if (!entries || entries.length === 0) return;
        const allRecords = await DB.getAll('training_records') || [];
        
        let newCount = 0;
        let updateCount = 0;
        
        for (const entry of entries) {
            // entry = { playerId, playerName, timestamp, details: { title, category, stat_before, stat_after, stat_gain }, logId, newsId }
            let existing = null;
            if (entry.logId) {
                existing = allRecords.find(r => r.note === `log:${entry.logId}`);
            }
            if (!existing && entry.newsId) {
                existing = allRecords.find(r => r.note === `news:${entry.newsId}`);
            }
            
            if (existing) {
                // Update missing details if needed
                let changed = false;
                if (!existing.timestamp && entry.timestamp) {
                    existing.timestamp = entry.timestamp * 1000;
                    changed = true;
                }
                
                // 自动修复现有记录中错误的员工名称（如 "Company train send"）
                const empObj = this._matchEmployee(entry);
                if (empObj && existing.player_name !== empObj.name) {
                    existing.player_name = empObj.name;
                    existing.player_id = empObj.player_id;
                    changed = true;
                }

                if (changed) {
                    await DB.put('training_records', existing);
                    updateCount++;
                }
            } else {
                // Determine week key from timestamp
                const wk = Utils.weekKey(new Date(entry.timestamp * 1000));
                const empObj = this._matchEmployee(entry);
                const record = {
                    id: Date.now() + Math.random().toString(36).substr(2, 9),
                    week: wk,
                    player_id: empObj ? empObj.player_id : entry.playerId,
                    player_name: empObj ? empObj.name : entry.playerName,
                    type: 'free', // 默认免费，loadData 的匹配逻辑会自动改为 paid
                    trains_count: 1, // 每次 API 同步产生一条记录，对应 1 次训练
                    amount_paid: 0,
                    category: entry.details?.category || 'other',
                    raw_text: entry.details?.title || entry.rawText,
                    raw_date: new Date(entry.timestamp * 1000).toISOString(),
                    timestamp: entry.timestamp * 1000,
                    note: entry.logId ? `log:${entry.logId}` : (entry.newsId ? `news:${entry.newsId}` : 'api_sync'),
                    created_at: Date.now()
                };
                await DB.put('training_records', record);
                allRecords.push(record);
                newCount++;
            }
        }
        
        console.log(`[TrainingPage] Synced API entries: ${newCount} new, ${updateCount} updated.`);
    },

    async _refetchTrainData() {
        Utils.showLoading('正在从 Torn API (v2 /user/log) 拉取训练数据...');
        try {
            const activeEmployees = this.employees.filter(e => !e.left_date);
            const empIds = activeEmployees.map(e => e.player_id);
            const range = Utils.weekDateRange(this._currentWeek);
            const entries = await TornAPI.getTrainingFromAllEmployees(empIds, range.start.getTime(), range.end.getTime());

            await this._mergeApiEntriesToRecords(entries);

            // 更新可用训练次数
            try {
                const detail = await TornAPI.getCompanyDetailed();
                this._trainsAvailable = detail?.company_detailed?.trains_available
                    ?? detail?.trains_available
                    ?? detail?.company?.trains_available
                    ?? 0;
            } catch (e2) {
                console.warn('[TrainingPage] refetch detailed:', e2.message);
            }

            Utils.hideLoading();
            Utils.toast('已成功拉取最新训练数据', 'success');
            
            await this.render();
        } catch(e) {
            Utils.hideLoading();
            Utils.toast(`拉取失败: ${e.message}`, 'error');
            console.error('[TrainingPage] _refetchTrainData failed:', e);
        }
    },

    /**
     * 将 content script 抓取的训练条目匹配到本地员工列表
     * 支持多种匹配策略：
     * 1. 从 rawText 中提取 XID= 格式的玩家 ID（与 Torn API news 格式一致）
     * 2. 从 playerName 中提取 [数字] 格式的 ID
     * 3. 纯名称匹配（去除 [数字] 后缀后比较）
     * @param {Object} entry - { playerName, trainer, action, rawText }
     * @returns {Object|null} 匹配的员工对象或 null
     */
    /**
     * 剥离 Torn 职位前缀（与 content script 的 stripJobTitle 保持一致）
     */
    _stripJobTitle(name) {
      if (!name) return name;
      const titles = [
        'Store Manager', 'Salesperson', 'Marketing Director', 'Operations Director',
        'Finance Director', 'Human Resources Director', 'Cleaner', 'Secretary',
        'Lingerie Model', 'Manager', 'Director', 'Supervisor', 'Assistant',
        'Janitor', 'Clerk', 'Intern', 'Trainee'
      ];
      let result = name.trim();
      for (const title of titles) {
        if (result.toLowerCase().startsWith(title.toLowerCase() + ' ')) {
          result = result.substring(title.length + 1).trim();
          break;
        }
      }
      return result;
    },
  
    _matchEmployee(entry) {
      if (!entry || !this.employees.length) return null;

      // 策略1: 从 rawText 中提取 XID= 格式的玩家 ID（Torn news HTML 格式）
      if (entry.rawText) {
        const xidMatch = entry.rawText.match(/XID=(\d+)/i);
        if (xidMatch) {
          const pid = String(xidMatch[1]);
          const emp = this.employees.find(e => String(e.player_id) === pid);
          if (emp) return emp;
        }
      }

      // 策略1b: 从 entry.playerId 直接匹配（content script 已从 DOM 提取）
      if (entry.playerId) {
        const pid = String(entry.playerId);
        const emp = this.employees.find(e => String(e.player_id) === pid);
        if (emp) return emp;
      }

      // 策略2: 从 playerName 中提取 [数字] 格式的 ID
      if (entry.playerName) {
        const bracketMatch = entry.playerName.match(/\[(\d+)\]/);
        if (bracketMatch) {
          const pid = String(bracketMatch[1]);
          const emp = this.employees.find(e => String(e.player_id) === pid);
          if (emp) return emp;
        }
      }

      // 策略3: 纯名称匹配（去除 [数字] 后缀和职位前缀）
      if (entry.playerName) {
        let cleanName = entry.playerName.replace(/\s*\[\d+\]\s*/, '').trim();
        cleanName = this._stripJobTitle(cleanName).toLowerCase();
        if (cleanName) {
          const emp = this.employees.find(e =>
            e.name && e.name.toLowerCase() === cleanName
          );
          if (emp) return emp;
        }
      }

      // 策略4: 原始 playerName 精确匹配（兼容旧格式，剥离职位前缀）
      if (entry.playerName) {
        const strippedName = this._stripJobTitle(entry.playerName).toLowerCase();
        const emp = this.employees.find(e =>
          e.name && e.name.toLowerCase() === strippedName
        );
        if (emp) return emp;
      }

      return null;
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
    },

    // ---- 名称筛选 ----

    _applyNameFilter(records) {
        const filterValue = (this._nameFilterValue || '').trim().toLowerCase();
        if (!filterValue) return records;
        return records.filter(r => {
            const name = (r.player_name || '').toLowerCase();
            return name.includes(filterValue);
        });
    },

    _filterRecordsByName() {
        const filterInput = document.getElementById('train-name-filter');
        this._nameFilterValue = filterInput ? filterInput.value : '';
        this.records = this._applyNameFilter(this._allRecords);
        const card = document.querySelector('#page-content .card:last-of-type');
        if (card) {
            card.outerHTML = this._recordsTableHTML();
            this._rebindCheckboxes();
            UI.initSortable('train-records-table');
        }
    },

    _filterRecordsByNameDebounced() {
        if (this._nameFilterDebounce) {
            clearTimeout(this._nameFilterDebounce);
        }
        this._nameFilterDebounce = setTimeout(() => {
            this._filterRecordsByName();
        }, 300);
    },

    _rebindCheckboxes() {
        const selectAll = document.getElementById('select-all-records');
        if (selectAll) {
            selectAll.addEventListener('change', () => {
                const checkboxes = document.querySelectorAll('.record-checkbox');
                checkboxes.forEach(cb => {
                    cb.checked = selectAll.checked;
                    const idStr = cb.dataset.recordId;
                    const id = isNaN(Number(idStr)) ? idStr : Number(idStr);
                    if (selectAll.checked) {
                        this._selectedRecordIds.add(id);
                    } else {
                        this._selectedRecordIds.delete(id);
                    }
                });
                this._updateBatchBar();
            });
        }

        document.querySelectorAll('.record-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const idStr = cb.dataset.recordId;
                const id = isNaN(Number(idStr)) ? idStr : Number(idStr);
                if (cb.checked) {
                    this._selectedRecordIds.add(id);
                } else {
                    this._selectedRecordIds.delete(id);
                }
                const allCb = document.getElementById('select-all-records');
                if (allCb) {
                    const total = document.querySelectorAll('.record-checkbox').length;
                    allCb.checked = this._selectedRecordIds.size === total && total > 0;
                    allCb.indeterminate = this._selectedRecordIds.size > 0 && this._selectedRecordIds.size < total;
                }
                this._updateBatchBar();
            });
        });

        this._updateBatchBar();
    },

    // ---- 批量管理 ----

    _updateBatchBar() {
        const bar = document.getElementById('batch-actions-bar');
        const countEl = document.getElementById('selected-count');
        if (!bar || !countEl) return;

        const count = this._selectedRecordIds ? this._selectedRecordIds.size : 0;
        if (count > 0) {
            bar.style.display = 'flex';
            countEl.textContent = count;
        } else {
            bar.style.display = 'none';
        }
    },

    async _batchDeleteRecords() {
        if (!this._selectedRecordIds || this._selectedRecordIds.size === 0) return;
        const count = this._selectedRecordIds.size;

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-exclamation-triangle text-red-400 mr-2"></i>确认批量删除
                </h3>
                <p class="text-gray-300 mb-2">确定要删除选中的 <span class="text-torn-accent font-bold">${count}</span> 条训练记录吗？</p>
                <p class="text-red-400 text-sm mb-6">此操作不可撤销！</p>
                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="batch-delete-cancel">取消</button>
                    <button class="btn btn-danger" id="batch-delete-confirm">确认删除</button>
                </div>
            </div>
        `;
        Utils.showModal(html);

        document.getElementById('batch-delete-cancel')?.addEventListener('click', () => {
            Utils.hideModal();
        });

        document.getElementById('batch-delete-confirm')?.addEventListener('click', async () => {
            Utils.hideModal();
            Utils.showLoading('正在批量删除...');
            try {
                let deleted = 0;
                for (const id of this._selectedRecordIds) {
                    try {
                        await DB.delete('training_records', id);
                        deleted++;
                    } catch (e) {
                        console.warn(`[TrainingPage] Failed to delete record ${id}:`, e.message);
                    }
                }
                this._selectedRecordIds = new Set();
                Utils.hideLoading();
                Utils.toast(`已删除 ${deleted} 条记录`, deleted === count ? 'success' : 'warning');
                await this.render();
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`批量删除失败: ${e.message}`, 'error');
            }
        });
    },

    async _batchSetCategory() {
        if (!this._selectedRecordIds || this._selectedRecordIds.size === 0) {
            Utils.toast('请先选择要设置分类的记录', 'warning');
            return;
        }
        const count = this._selectedRecordIds.size;

        const categories = window.TRAIN_CATEGORIES || [];
        const categoryOptions = categories.map(cat =>
            `<option value="${cat.value}">${cat.label}</option>`
        ).join('');

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-folder mr-2 text-torn-accent"></i>批量设置训练分类
                </h3>
                <p class="text-gray-300 mb-4">将为选中的 <span class="text-torn-accent font-bold">${count}</span> 条记录设置分类：</p>
                <div class="mb-4">
                    <label class="text-gray-400 text-sm mb-1 block">训练分类</label>
                    <select class="input" id="batch-category-select">
                        ${categoryOptions}
                    </select>
                </div>
                <div class="flex justify-end gap-2 mt-6">
                    <button class="btn btn-secondary" id="batch-category-cancel">取消</button>
                    <button class="btn btn-primary" id="batch-category-confirm">确认设置</button>
                </div>
            </div>
        `;
        Utils.showModal(html);

        document.getElementById('batch-category-cancel')?.addEventListener('click', () => {
            Utils.hideModal();
        });

        document.getElementById('batch-category-confirm')?.addEventListener('click', async () => {
            const category = document.getElementById('batch-category-select')?.value;
            if (!category) {
                Utils.toast('请选择训练分类', 'warning');
                return;
            }

            Utils.hideModal();
            Utils.showLoading('正在批量设置分类...');
            try {
                let updated = 0;
                let failed = 0;
                for (const id of this._selectedRecordIds) {
                    try {
                        const record = await DB.get('training_records', id);
                        if (record) {
                            record.type = category;
                            await DB.put('training_records', record);
                            updated++;
                        } else {
                            failed++;
                            console.warn(`[TrainingPage] Record not found for batch category update: ${id}`);
                        }
                    } catch (e) {
                        failed++;
                        console.warn(`[TrainingPage] Failed to update category for record ${id}:`, e.message);
                    }
                }
                this._selectedRecordIds = new Set();
                Utils.hideLoading();
                const msg = failed > 0
                    ? `已更新 ${updated} 条记录的分类，${failed} 条失败`
                    : `已更新 ${updated} 条记录的分类`;
                Utils.toast(msg, updated > 0 ? 'success' : 'warning');
                await this.render();
            } catch (e) {
                Utils.hideLoading();
                Utils.toast(`批量设置分类失败: ${e.message}`, 'error');
            }
        });
    }
};
