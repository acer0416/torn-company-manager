// Rehab Page - Drug addiction monitoring
// Uses innerHTML pattern with Components (return HTML strings)
window.RehabPage = {
    employees: [],
    rehabRecords: [],
    expandedRows: new Set(),
    _eventsBound: false,

    async init() {
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载戒毒数据...');
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
        }
    },

    async _loadData() {
        const force = this._forceFetch || false;
        this._forceFetch = false;

        // Fetch employees from API（使用缓存 + 统一 API）
        try {
            const data = await AppCache.getOrFetch('employees', () => TornAPI.getEmployeesUnified());
            this.employees = (data || []).map(e => ({
                player_id: String(e.id || e.player_id),
                name: e.name || `ID:${e.id || e.player_id}`,
                position: e.position?.name || e.position || 'N/A',
                status: e.status || {},
                effectiveness: e.effectiveness || {},
                ...e
            }));
        } catch (e) {
            console.error('Failed to load employees:', e);
            this.employees = [];
        }

        // 同步员工到 employees_master（幂等，不标记离职）
        await Utils.syncEmployeesMaster(this.employees);

        // Load rehab records and snapshots from DB
        this.rehabRecords = (await DB.getAll('rehab_records')) || [];
        this.apiSnapshots = (await DB.getAll('rehab_api_snapshots')) || [];

        // Check if we need to fetch personal stats (if today's snapshot doesn't exist for at least one employee)
        const todayStr = Utils.todayKey();
        const todaySnapshotsCount = this.apiSnapshots.filter(s => s.date === todayStr).length;
        if (force || (this.employees.length > 0 && todaySnapshotsCount < this.employees.length)) {
            Utils.showLoading('获取备份监控数据 (API)...');
            await this._fetchRehabBackupStats();
            Utils.hideLoading();
            // Reload rehab records and snapshots because they might have been updated/created by the fetch
            this.rehabRecords = (await DB.getAll('rehab_records')) || [];
            this.apiSnapshots = (await DB.getAll('rehab_api_snapshots')) || [];
        }

        // Load custom addiction threshold (default to 5)
        this.threshold = 5;
        try {
            const stored = await DB.get('settings', 'dash_addiction_threshold');
            if (stored && stored.value != null) {
                this.threshold = Math.abs(Number(stored.value)) || 5;
            }
        } catch (e) { /* ignore */ }

        // Auto-detect rehab: if employee status shows Traveling to Switzerland
        // 去重策略：player_id + date 联合检查（内存 + DB）
        for (const emp of this.employees) {
            if (this._isTravelingToSwitzerland(emp)) {
                // 先检查内存
                const alreadyLoggedMem = this.rehabRecords.some(r =>
                    String(r.player_id) === String(emp.player_id) && r.date === todayStr
                );
                if (alreadyLoggedMem) continue;

                // 再查 DB 确保无竞态条件下的重复记录
                let alreadyLoggedDB = false;
                try {
                    const playerRecords = await DB.getByIndex('rehab_records', 'player_id', emp.player_id);
                    alreadyLoggedDB = (playerRecords || []).some(r => r.date === todayStr);
                } catch (e) { /* 索引查询失败，忽略 */ }

                if (!alreadyLoggedDB) {
                    const record = {
                        player_id: emp.player_id,
                        player_name: emp.name,
                        date: todayStr,
                        timestamp: Date.now(),
                        auto_detected: true
                    };
                    await DB.put('rehab_records', record);
                    this.rehabRecords.push(record);
                }
            }
        }
    },

    async _fetchRehabBackupStats() {
        const apiKey = await TornAPI.getKey();
        if (!apiKey) return;
        
        const todayStr = Utils.todayKey();
        for (const emp of this.employees) {
            try {
                const ps = await TornAPI.getPlayerRehabBackupStats(emp.player_id);
                await this._processRehabStatsSnapshot(emp.player_id, emp.name, todayStr, ps);
            } catch (e) {
                console.error(`Failed to fetch rehab backup stats for ${emp.name}:`, e);
            }
        }
    },

    async _processRehabStatsSnapshot(empId, playerName, today, ps) {
        const db = DB.db;
        if (!db) return;
        
        // 1. Read all needed data in a single readonly transaction
        const readTx = db.transaction(['rehab_api_snapshots', 'rehab_records'], 'readonly');
        
        const allSnapshotsPromise = new Promise((resolve) => {
            const index = readTx.objectStore('rehab_api_snapshots').index('player_id');
            const reqNum = index.getAll(Number(empId));
            reqNum.onsuccess = () => {
                const numResult = reqNum.result || [];
                const reqStr = index.getAll(String(empId));
                reqStr.onsuccess = () => {
                    const strResult = reqStr.result || [];
                    const combined = [...numResult];
                    for (const r of strResult) {
                        if (!combined.some(c => c.id === r.id)) combined.push(r);
                    }
                    resolve(combined);
                };
                reqStr.onerror = () => resolve(numResult);
            };
            reqNum.onerror = () => {
                const reqStr = index.getAll(String(empId));
                reqStr.onsuccess = () => resolve(reqStr.result || []);
                reqStr.onerror = () => resolve([]);
            };
        });
        
        const playerRecordsPromise = new Promise((resolve) => {
            const index = readTx.objectStore('rehab_records').index('player_id');
            const reqNum = index.getAll(Number(empId));
            reqNum.onsuccess = () => {
                const numResult = reqNum.result || [];
                const reqStr = index.getAll(String(empId));
                reqStr.onsuccess = () => {
                    const strResult = reqStr.result || [];
                    const combined = [...numResult];
                    for (const r of strResult) {
                        if (!combined.some(c => c.id === r.id)) combined.push(r);
                    }
                    resolve(combined);
                };
                reqStr.onerror = () => resolve(numResult);
            };
            reqNum.onerror = () => {
                const reqStr = index.getAll(String(empId));
                reqStr.onsuccess = () => resolve(reqStr.result || []);
                reqStr.onerror = () => resolve([]);
            };
        });
        
        const [allSnapshots, playerRecords] = await Promise.all([allSnapshotsPromise, playerRecordsPromise]);
        
        const existingToday = allSnapshots.find(r => r.date === today);
        
        if (existingToday) {
            existingToday.switravel = ps.switravel;
            existingToday.rehabs = ps.rehabs;
            existingToday.xantaken = ps.xantaken;
            existingToday.timestamp = Date.now();
            
            const writeTx = db.transaction('rehab_api_snapshots', 'readwrite');
            writeTx.objectStore('rehab_api_snapshots').put(existingToday);
            await new Promise(resolve => { writeTx.oncomplete = resolve; writeTx.onerror = resolve; });
            return;
        }
        
        allSnapshots.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
        const prevSnapshot = allSnapshots[0];
        
        // 2. Perform all writes in a single readwrite transaction
        const writeTx = db.transaction(['rehab_api_snapshots', 'rehab_records'], 'readwrite');
        const writeSnapshotsStore = writeTx.objectStore('rehab_api_snapshots');
        const writeRecordsStore = writeTx.objectStore('rehab_records');
        
        writeSnapshotsStore.put({
            player_id: Number(empId), // Consistently write as Number
            date: today,
            switravel: ps.switravel,
            rehabs: ps.rehabs,
            xantaken: ps.xantaken,
            timestamp: Date.now()
        });
        
        if (prevSnapshot) {
            const rehabsDiff = ps.rehabs - prevSnapshot.rehabs;
            const switravelDiff = ps.switravel - prevSnapshot.switravel;
            
            const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
            const travelingRecord = playerRecords.find(r => 
                r.timestamp >= twoDaysAgo && 
                r.auto_detected === true && 
                (r.api_verified === undefined || r.api_verified === null) &&
                (!r.source || r.source === 'traveling')
            );
            
            if (rehabsDiff > 0) {
                if (travelingRecord) {
                    travelingRecord.api_verified = true;
                    travelingRecord.rehabs_increment = rehabsDiff;
                    travelingRecord.source = 'traveling';
                    writeRecordsStore.put(travelingRecord);
                } else {
                    writeRecordsStore.put({
                        player_id: Number(empId), // Consistently write as Number
                        player_name: playerName,
                        date: today,
                        timestamp: Date.now(),
                        auto_detected: true,
                        api_verified: true,
                        rehabs_increment: rehabsDiff,
                        source: 'api'
                    });
                }
            } else if (switravelDiff > 0) {
                if (travelingRecord) {
                    travelingRecord.api_verified = false;
                    travelingRecord.rehabs_increment = 0;
                    travelingRecord.source = 'traveling';
                    writeRecordsStore.put(travelingRecord);
                }
            }
        }
        
        await new Promise(resolve => { writeTx.oncomplete = resolve; writeTx.onerror = resolve; });
    },

    _isTravelingToSwitzerland(emp) {
        const status = emp.status || {};
        const state = (status.state || '').toLowerCase();
        const desc = (status.description || '').toLowerCase();
        return (state.includes('traveling') || desc.includes('traveling')) &&
               (desc.includes('switzerland') || desc.includes('瑞士'));
    },

    _getAddictionValue(emp) {
        const eff = emp.effectiveness || {};
        if (eff.addiction !== undefined) return eff.addiction;
        if (eff.settle_bonus !== undefined) return eff.settle_bonus;
        if (typeof eff === 'number') return eff;
        return 0;
    },

    // ---- HTML Builders ----

    _headerHTML() {
        return `
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-xl font-bold text-white">
                    <i class="fas fa-syringe mr-2 text-torn-accent"></i>毒瘾监控
                </h2>
                <div class="flex gap-2">
                    <button class="btn btn-primary" data-action="manual-rehab">
                        <i class="fas fa-pills"></i> 手动记录Rehab
                    </button>
                    <button class="btn btn-secondary" data-action="refresh">
                        <i class="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>
        `;
    },

    _alertBannerHTML() {
        const threshold = this.threshold || 5;
        const critical = this.employees.filter(e => this._getAddictionValue(e) <= -threshold);
        if (!critical.length) return '';

        return `
            <div class="bg-red-900/30 border border-red-500/50 rounded-lg p-4 mb-6 flex items-center gap-3">
                <i class="fas fa-exclamation-triangle text-red-400 text-xl"></i>
                <div>
                    <div class="text-red-400 font-bold">严重毒瘾警报</div>
                    <div class="text-red-300 text-sm">
                        ${critical.length} 名员工毒瘾值 &lt;= -${threshold}: ${critical.map(e => e.name).join(', ')}
                    </div>
                </div>
            </div>
        `;
    },

    _employeeTableHTML() {
        const headers = [
            { key: 'name', label: '姓名', sortable: true },
            { key: 'position', label: '职位', sortable: true },
            { key: 'addiction', label: '毒瘾值', sortable: true },
            { key: 'status', label: '状态' },
            { key: 'switravel', label: '历史飞往瑞士次数', sortable: true },
            { key: 'rehabCount', label: '历史rehab次数', sortable: true },
            { key: 'xantaken', label: 'xan使用数', sortable: true },
            { key: 'daysSince', label: '距上次rehab天数', sortable: true },
            { key: 'avgDays', label: '平均间隔天数', sortable: true },
            { key: 'actions', label: '操作', sortable: false }
        ];

        const rows = this.employees.map(emp => {
            const empRecords = this.rehabRecords
                .filter(r => String(r.player_id) === String(emp.player_id))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            const empSnapshots = (this.apiSnapshots || [])
                .filter(s => String(s.player_id) === String(emp.player_id))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            const latestSnapshot = empSnapshots[0];
            const prevSnapshot = empSnapshots.find(s => s.date !== (latestSnapshot ? latestSnapshot.date : ''));

            const addVal = this._getAddictionValue(emp);
            const addColor = Utils.addictionColor(addVal);

            // Unreliable check: if last snapshot is older than 2 days
            const isUnreliable = !latestSnapshot || (Date.now() - latestSnapshot.timestamp) > 2 * 24 * 60 * 60 * 1000;

            const daysSinceVal = empRecords.length ? Utils.daysSince(empRecords[0].timestamp / 1000) : '-';
            const daysSince = isUnreliable
                ? `<span class="text-yellow-500 font-bold" title="API数据超过2天未更新，数据可能不可靠">⚠️ 数据不可靠</span>`
                : daysSinceVal;

            const rehabCount = latestSnapshot ? latestSnapshot.rehabs : '-';

            // Average interval calculation (last 7 days of confirmed/valid rehab records)
            let avgDays = '-';
            if (isUnreliable) {
                avgDays = `<span class="text-yellow-500 font-bold" title="API数据超过2天未更新，数据可能不可靠">⚠️ 数据不可靠</span>`;
            } else {
                const weekAgoMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
                const recentRecords = empRecords.filter(r => r.timestamp >= weekAgoMs);
                if (recentRecords.length >= 2) {
                    const totalMs = recentRecords[0].timestamp - recentRecords[recentRecords.length - 1].timestamp;
                    avgDays = Math.round(totalMs / 86400000 / (recentRecords.length - 1));
                }
            }

            // Historical Switzerland travel count
            const switravel = latestSnapshot ? latestSnapshot.switravel : '-';

            // Xanax count and growth
            let xantaken = '-';
            if (latestSnapshot) {
                const xanVal = latestSnapshot.xantaken;
                let xanGrowthText = '';
                if (prevSnapshot) {
                    const growth = xanVal - prevSnapshot.xantaken;
                    xanGrowthText = ` (${growth >= 0 ? '+' + growth : growth})`;
                }
                xantaken = `${xanVal}${xanGrowthText}`;
            }

            // Status badge
            const status = emp.status || {};
            const stateColor = Utils.statusColor(status.state || '');
            const statusBadge = `<span class="badge badge-${stateColor}">${status.state || '-'}</span>`;

            // Expanded icon
            const isExpanded = this.expandedRows.has(emp.player_id);
            const chevron = isExpanded ? 'fa-chevron-up' : 'fa-chevron-down';

            return {
                id: emp.player_id,
                name: `<a href="https://www.torn.com/profiles.php?XID=${emp.player_id}" target="_blank" class="text-torn-accent hover:underline">${emp.name}</a>`,
                position: Utils.formatPosition(emp.position),
                addiction: `<span class="font-bold" style="color:${addColor}">${addVal}</span>`,
                status: statusBadge,
                daysSince: String(daysSince),
                rehabCount: String(rehabCount),
                avgDays: String(avgDays),
                switravel: String(switravel),
                xantaken: String(xantaken),
                actions: `
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-primary" data-action="rehab-emp" data-emp-id="${emp.player_id}" title="记录Rehab">
                            <i class="fas fa-pills"></i>
                        </button>
                        <button class="btn btn-xs btn-secondary" data-action="expand-emp" data-emp-id="${emp.player_id}" title="展开历史">
                            <i class="fas ${chevron}"></i>
                        </button>
                    </div>
                `
            };
        });

        const tableId = 'rehab-emp-table';
        const tableHTML = UI.dataTable({
            headers,
            rows,
            id: tableId,
            emptyText: '暂无员工数据'
        });

        // Build expanded detail sections for each expanded employee
        let expandedSections = '';
        for (const emp of this.employees) {
            if (!this.expandedRows.has(emp.player_id)) continue;

            const empRecords = this.rehabRecords
                .filter(r => String(r.player_id) === String(emp.player_id))
                .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

            let rowsHTML = '';
            for (const rec of empRecords.slice(0, 10)) {
                const dateStr = rec.date || Utils.formatDate(rec.timestamp / 1000);
                const grabTime = Utils.formatDateTime(rec.timestamp / 1000);

                let grabMethod = '';
                if (rec.manual) {
                    grabMethod = '<span class="badge badge-blue">手动</span>';
                } else if (rec.source === 'api') {
                    grabMethod = '<span class="badge badge-purple">API快照</span>';
                } else {
                    grabMethod = '<span class="badge badge-gray">定时抓取状态</span>';
                }

                let apiVerified = '-';
                if (rec.manual) {
                    apiVerified = '<span class="text-gray-400">无需查验</span>';
                } else if (rec.api_verified === true) {
                    apiVerified = '<span class="text-green-400"><i class="fas fa-check-circle mr-1"></i>已查验</span>';
                } else if (rec.api_verified === false) {
                    apiVerified = '<span class="text-red-400"><i class="fas fa-times-circle mr-1"></i>未解毒 / 未确认</span>';
                } else {
                    apiVerified = '<span class="text-yellow-400"><i class="fas fa-question-circle mr-1"></i>等待查验</span>';
                }

                const rehabsInc = rec.rehabs_increment !== undefined && rec.rehabs_increment > 0
                    ? `+${rec.rehabs_increment}`
                    : (rec.rehabs_increment === 0 ? '0' : '-');

                rowsHTML += `
                    <tr class="border-b border-torn-border">
                        <td class="px-4 py-2 font-mono text-sm">${dateStr}</td>
                        <td class="px-4 py-2 text-sm text-gray-300">${grabTime}</td>
                        <td class="px-4 py-2 text-sm">${grabMethod}</td>
                        <td class="px-4 py-2 text-sm">${apiVerified}</td>
                        <td class="px-4 py-2 text-sm font-semibold">${rehabsInc}</td>
                    </tr>
                `;
            }

            const historyTableHTML = rowsHTML
                ? `
                <table class="w-full text-left border-collapse">
                    <thead>
                        <tr class="bg-torn-surface border-b border-torn-border text-gray-400 text-xs font-bold uppercase">
                            <th class="px-4 py-2">解毒日期</th>
                            <th class="px-4 py-2">抓取时间</th>
                            <th class="px-4 py-2">抓取方式</th>
                            <th class="px-4 py-2">API是否查验</th>
                            <th class="px-4 py-2">rehabs次数(增长量)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${rowsHTML}
                    </tbody>
                </table>
                `
                : '<div class="text-gray-500 text-sm p-4 text-center">暂无记录</div>';

            expandedSections += `
                <div class="bg-torn-surface p-4 rounded-lg mb-3 border border-torn-border">
                    <div class="text-gray-400 text-sm font-bold mb-3">
                        <i class="fas fa-history mr-1"></i>${emp.name} 的最近10次Rehab记录
                    </div>
                    <div class="overflow-x-auto font-sans">
                        ${historyTableHTML}
                    </div>
                </div>
            `;
        }

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-users mr-2 text-torn-accent"></i>员工毒瘾状态
                </h3>
                ${tableHTML}
            </div>
            ${expandedSections}
        `;
    },

    _buildHTML() {
        return `
            ${this._headerHTML()}
            ${this._alertBannerHTML()}
            ${this._employeeTableHTML()}
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
                if (Router.currentPage !== 'rehab') return;
                const btn = e.target.closest('[data-action]');
                if (!btn) return;

                const action = btn.dataset.action;
                const empId = btn.dataset.empId;

                switch (action) {
                    case 'refresh':
                        this._forceFetch = true;
                        await this.render();
                        break;
                    case 'manual-rehab':
                        this._showManualRehabModal();
                        break;
                    case 'rehab-emp':
                        await this._recordRehab(empId);
                        break;
                    case 'expand-emp':
                        this._toggleExpand(empId);
                        break;
                }
            });
        }

        // Init sortable table (safe to call on each render)
        UI.initSortable('rehab-emp-table');
    },

    // ---- Actions ----

    _toggleExpand(empId) {
        if (this.expandedRows.has(empId)) {
            this.expandedRows.delete(empId);
        } else {
            this.expandedRows.add(empId);
        }
        // Re-render page to show/hide expanded rows
        const c = document.getElementById('page-content');
        if (c) {
            c.innerHTML = this._buildHTML();
            this._bindEvents();
        }
    },

    async _recordRehab(empId) {
        const emp = this.employees.find(e => String(e.player_id) === String(empId));
        if (!emp) return;

        if (!confirm(`确认为 ${emp.name} 记录一次Rehab？`)) return;

        // player_id + date 联合去重
        const todayStr = Utils.todayKey();
        let alreadyLoggedDB = false;
        try {
            const playerRecords = await DB.getByIndex('rehab_records', 'player_id', emp.player_id);
            alreadyLoggedDB = (playerRecords || []).some(r => r.date === todayStr);
        } catch (e) { /* ignore */ }

        if (alreadyLoggedDB) {
            Utils.toast(`${emp.name} 今天已记录过 Rehab`, 'warning');
            return;
        }

        const record = {
            player_id: emp.player_id,
            player_name: emp.name,
            date: todayStr,
            timestamp: Date.now(),
            manual: true
        };
        await DB.put('rehab_records', record);
        Utils.toast(`已为 ${emp.name} 记录Rehab`, 'success');
        await this.render();
    },

    _showManualRehabModal() {
        const empOptions = this.employees.map(e =>
            `<option value="${e.player_id}">${e.name} (${e.position})</option>`
        ).join('');

        const container = document.createElement('div');
        container.className = 'p-6';
        container.innerHTML = `
            <h3 class="text-lg font-bold text-white mb-4">
                <i class="fas fa-pills mr-2 text-torn-accent"></i>手动记录Rehab
            </h3>
            <div class="space-y-4">
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">选择员工</label>
                    <select class="input" id="modal-rehab-emp">
                        <option value="">-- 选择员工 --</option>
                        ${empOptions}
                    </select>
                </div>
                <div>
                    <label class="text-gray-400 text-sm mb-1 block">记录日期</label>
                    <input type="date" class="input" id="modal-rehab-date" value="${Utils.todayKey()}" />
                </div>
                <div class="flex justify-end gap-2 mt-6">
                    <button class="btn btn-secondary" id="modal-rehab-cancel">取消</button>
                    <button class="btn btn-primary" id="modal-rehab-save">确认记录</button>
                </div>
            </div>
        `;

        Utils.showModal(container);

        container.querySelector('#modal-rehab-cancel')?.addEventListener('click', () => Utils.hideModal());

        container.querySelector('#modal-rehab-save')?.addEventListener('click', async () => {
            const empId = container.querySelector('#modal-rehab-emp')?.value;
            if (!empId) {
                Utils.toast('请选择员工', 'warning');
                return;
            }
            const emp = this.employees.find(e => String(e.player_id) === String(empId));
            const dateVal = container.querySelector('#modal-rehab-date')?.value || Utils.todayKey();

            // player_id + date 联合去重
            let alreadyLoggedDB = false;
            try {
                const playerRecords = await DB.getByIndex('rehab_records', 'player_id', empId);
                alreadyLoggedDB = (playerRecords || []).some(r => r.date === dateVal);
            } catch (e) { /* ignore */ }

            if (alreadyLoggedDB) {
                Utils.toast(`${emp?.name || ''} 在 ${dateVal} 已记录过 Rehab`, 'warning');
                return;
            }

            const record = {
                player_id: empId,
                player_name: emp?.name || '',
                date: dateVal,
                timestamp: new Date(dateVal).getTime() || Date.now(),
                manual: true
            };
            await DB.put('rehab_records', record);
            Utils.toast(`已为 ${emp?.name || ''} 记录Rehab (${dateVal})`, 'success');
            Utils.hideModal();
            await this.render();
        });
    }
};
