// Finance Page - Transactions, Tax, Fund Flow
// Uses innerHTML pattern with Components (return HTML strings)
window.FinancePage = {
    activeTab: 'overview',
    transactions: [],
    employees: [],
    config: { weekly_tax_amount: 0, weekly_tax_enabled: true },
    latestSnapshot: null,
    taxWeeks: [],
    taxCarryovers: [],
    selectedWeekKey: '',
    employeeTaxList: [],
    employeeTaxRates: [],

    // Filters for transactions tab
    txFilterEmp: '',
    txFilterTime: 'week',

    // State for auto-detect modal
    adLogs: [],
    adFilterEmp: '',
    adFilterTime: 'week',
    itemNameCache: {},  // item ID -> name lookup

    async init() {
        await this._loadData();
        // 初始化周选择器状态
        this.selectedWeekKey = Utils.weekKey(); // 默认为当前周
        // 检查未迁移的旧数据（无 week_key 的 tax 交易）
        var self = this;
        var unmigratedTxs = this.transactions.filter(function(tx) {
            return self._isTaxTx(tx) && !tx.week_key;
        });
        if (unmigratedTxs.length > 0) {
            console.log('[Finance] Found ' + unmigratedTxs.length + ' unmigrated transactions, running migration...');
            await DB.migrateV3toV4();
            await this._loadData();
        }
        await this._ensureWeekExists(this.selectedWeekKey);
        await this._recalculateWeek(this.selectedWeekKey);
        await this.render();
    },

    async render() {
        const c = document.getElementById('page-content');
        if (!c) return;
        Utils.showLoading('加载财务数据...');
        try {
            await this._loadData();
            // 确保 tax_weeks 基于最新的员工数据和税务配置重新计算
            await this._ensureWeekExists(this.selectedWeekKey);
            await this._recalculateWeek(this.selectedWeekKey);
            Utils.hideLoading();
            c.innerHTML = this._buildHTML();
            this._bindEvents();
            var self = this;
            setTimeout(function() {
                self._bindWeekSelectorEvents();
                self._bindTaxTabEvents();
            }, 50);
        } catch (e) {
            Utils.hideLoading();
            c.innerHTML = `
                <div class="flex items-center justify-between mb-6">
                    <h2 class="text-xl font-bold text-white">
                        <i class="fas fa-wallet mr-2 text-torn-accent"></i>财务管理
                    </h2>
                </div>
                <div class="text-red-400 p-4">Error: ${e.message}</div>
            `;
        }
    },

    async _loadData() {
        // Load tax config (from tax_config store, with migration from training_config)
        try {
            var taxAmt = await DB.get('tax_config', 'weekly_tax_amount');
            if (!taxAmt) {
                // 迁移：从 training_config 读取旧值
                taxAmt = await DB.get('training_config', 'weekly_tax_amount');
                if (taxAmt) {
                    await DB.put('tax_config', { key: 'weekly_tax_amount', value: taxAmt.value });
                    await DB.delete('training_config', 'weekly_tax_amount');
                }
            }
            this.config.weekly_tax_amount = taxAmt?.value ?? 0;

            var taxEnabled = await DB.get('tax_config', 'weekly_tax_enabled');
            if (!taxEnabled) {
                taxEnabled = await DB.get('training_config', 'weekly_tax_enabled');
                if (taxEnabled) {
                    await DB.put('tax_config', { key: 'weekly_tax_enabled', value: taxEnabled.value });
                    await DB.delete('training_config', 'weekly_tax_enabled');
                }
            }
            this.config.weekly_tax_enabled = taxEnabled?.value ?? true;
        } catch (e) {
            // 回退：直接读取 training_config
            const taxAmtFallback = await DB.get('training_config', 'weekly_tax_amount');
            this.config.weekly_tax_amount = taxAmtFallback?.value ?? 0;
            const taxEnabledFallback = await DB.get('training_config', 'weekly_tax_enabled');
            this.config.weekly_tax_enabled = taxEnabledFallback?.value ?? true;
        }

        // Load all transactions
        this.transactions = (await DB.getAll('transactions')) || [];
        this.taxWeeks = await DB.getAll('tax_weeks') || [];
        this.taxCarryovers = await DB.getAll('tax_carryover') || [];
        this.employeeTaxList = await DB.getAll('employee_tax') || [];
        this.employeeTaxRates = await DB.getAll('employee_tax_rates') || [];

        // 重置员工列表，防止 _loadData() 被多次调用时累积重复数据
        this.employees = [];

        // Load employees from employees_master DB (统一使用 Number 类型的 player_id)
        try {
            const masterEmployees = await DB.getAll('employees_master');
            if (masterEmployees && masterEmployees.length) {
                // 过滤/修正混合 keyType 残留：只保留 Number 类型的 player_id
                const dedupMap = new Map();
                for (const emp of masterEmployees) {
                    const pid = Number(emp.player_id);
                    if (!pid) continue;
                    // 保留最新的一条（last_seen 最大的），覆盖 string key 残留
                    const existing = dedupMap.get(pid);
                    if (!existing || (emp.last_seen || '') > (existing.last_seen || '')) {
                        dedupMap.set(pid, { ...emp, player_id: pid });
                    }
                }
                this.employees = Array.from(dedupMap.values());
            }
        } catch (e) { /* fallback */ }

        // 补充或回退：使用缓存 + 统一 API 获取最新员工数据
        let apiEmployees = AppCache.get('employees');
        if (!apiEmployees) {
            try {
                apiEmployees = await AppCache.getOrFetch('employees', () => TornAPI.getEmployeesUnified());
            } catch (e) {
                apiEmployees = [];
            }
        }

        // 用 API 数据补充/更新 employees 列表（保留 employees_master 中已离职员工信息）
        // 统一使用 Number 类型的 player_id 作为 key
        const masterMap = new Map();
        (this.employees || []).forEach(emp => masterMap.set(Number(emp.player_id), emp));

        for (const emp of (apiEmployees || [])) {
            const pid = Number(emp.id || emp.player_id);
            if (!pid) continue;
            if (masterMap.has(pid)) {
                // 更新活跃员工的最新信息
                const existing = masterMap.get(pid);
                existing.name = emp.name || existing.name;
                existing.position = emp.position?.name || emp.position || existing.position;
                existing.status = emp.status || existing.status;
                existing.effectiveness = emp.effectiveness || existing.effectiveness;
                existing.player_id = pid; // 确保 player_id 为 Number 类型
                // 保留 employees_master 的特有字段（first_seen, last_seen, left_date）
            } else {
                // 新员工：加入列表
                this.employees.push({
                    player_id: pid,
                    name: emp.name || `ID:${pid}`,
                    position: emp.position?.name || emp.position || 'N/A',
                    first_seen: Utils.todayKey(),
                    last_seen: Utils.todayKey(),
                    left_date: null,
                    status: emp.status || {},
                    effectiveness: emp.effectiveness || {}
                });
            }
        }

        // 同步员工到 employees_master（幂等，不标记离职）
        await Utils.syncEmployeesMaster(apiEmployees);

        // Load latest snapshot for API data
        try {
            const snapshots = await DB.getAll('snapshots');
            if (snapshots && snapshots.length) {
                // sort by timestamp descending
                snapshots.sort((a, b) => b.timestamp - a.timestamp);
                this.latestSnapshot = snapshots[0];
            }
        } catch (e) {
            this.latestSnapshot = null;
        }

        // 如果没有快照，直接从 API 获取公司详细数据（确保概览 Tab 首次打开即显示数据）
        if (!this.latestSnapshot) {
            try {
                const detail = await AppCache.getOrFetch('companyDetailed', () => TornAPI.getCompanyDetailed());
                if (detail?.company_detailed) {
                    this.latestSnapshot = { detailed: detail.company_detailed };
                }
            } catch (e) {
                console.warn('[FinancePage] Failed to fetch company detailed:', e);
            }
        }
    },

    // ========== 周税务状态层函数 ==========

    // 判断交易是否为税务类型（兼容 category 和 type 字段）
    _isTaxTx: function(tx) {
        return (tx.category === 'tax') || (tx.type === 'tax');
    },

    // 自动匹配交易到周
    // force=true 时忽略已有 week_key，始终从 timestamp/date 重算（用于 _scanAllTx 全量修复）
    _autoMatchWeek: function(tx, force) {
        // 仅为 tax 类型交易自动匹配
        if (!this._isTaxTx(tx)) return tx.week_key;
        // 非强制模式下，已有 week_key 则保留（向后兼容手动分配）
        if (!force && tx.week_key) return tx.week_key;
        // 优先使用 date 字段（YYYY-MM-DD，本地日期），避免 UTC 时间戳跨天问题
        if (tx.date && /^\d{4}-\d{2}-\d{2}$/.test(tx.date)) {
            return Utils.weekKey(new Date(tx.date + 'T00:00:00'));
        }
        if (tx.timestamp && tx.timestamp > 0) {
            // 归一化时间戳：毫秒 (>= 1e12) 直接用，秒 (< 1e12) 转毫秒
            var ts = tx.timestamp >= 1e12 ? tx.timestamp : tx.timestamp * 1000;
            return Utils.weekKey(new Date(ts));
        }
        return '__unassigned__';
    },

    // 获取指定周的所有税务交易
    _getWeekTransactions: function(weekKey) {
        var self = this;
        return this.transactions.filter(function(tx) {
            return self._isTaxTx(tx) && tx.week_key === weekKey;
        });
    },

    // 获取指定员工税率（优先个人配置，回退全局）
    _getEmployeeTaxRate: function(playerId) {
        var config = this.employeeTaxRates.find(function(r) { return String(r.player_id) === String(playerId); });
        if (config && config.tax_amount != null) {
            return Number(config.tax_amount) || 0;
        }
        return (this.config && this.config.weekly_tax_amount) || 0;
    },

    // 核心算法：重新计算指定周的税务数据并写入 tax_weeks
    _recalculateWeek: async function(weekKey) {
        var weekTxs = this._getWeekTransactions(weekKey);
        
        // 计算实缴总额
        var taxPaid = weekTxs.reduce(function(sum, tx) {
            return sum + (Number(tx.amount) || 0);
        }, 0);
        
        // 获取员工数（活跃员工）
        var activeEmployees = this.employees.filter(function(emp) {
            return emp.left_date === null || emp.left_date === undefined;
        });
        var employeeCount = activeEmployees.length;
        
        // 计算应缴税额
        var taxDue = 0;
        if (this.config && this.config.weekly_tax_enabled) {
            taxDue = (Number(this.config.weekly_tax_amount) || 0) * employeeCount;
        }
        
        // 获取结转转入（从 tax_carryover 计算）
        var carryoverIn = this.taxCarryovers
            .filter(function(c) { return c.to_week_key === weekKey && !c.deleted; })
            .reduce(function(sum, c) { return sum + (Number(c.amount) || 0); }, 0);
        
        // 计算净应缴和当前余额
        var netDue = Math.max(0, taxDue - carryoverIn);
        var balance = taxPaid - netDue;
        
        // 计算结转输出（超额部分自动结转至下周）
        // 注意：实际 carryover 记录在员工级别重算后创建，以便附带 per_employee_surplus
        var carryoverOut = 0;
        if (balance > 0 && weekKey !== Utils.weekKey()) {
            carryoverOut = balance;
        }
        
        // 确定状态
        var status = 'current';
        if (balance >= 0) {
            status = 'paid';
        } else if (balance < 0 && weekKey < Utils.weekKey()) {
            status = 'overdue';
        }
        
        // 写入 tax_weeks
        var weekRecord = {
            week_key: weekKey,
            year: parseInt(weekKey.split('-W')[0], 10),
            tax_due: taxDue,
            tax_paid: taxPaid,
            carryover_in: carryoverIn,
            carryover_out: carryoverOut,
            employee_count: employeeCount,
            net_due: netDue,
            balance: balance,
            status: status,
            calculated_at: Date.now()
        };
        
        await DB.put('tax_weeks', weekRecord);
        
        // 更新内存缓存
        var existingIdx = this.taxWeeks.findIndex(function(w) { return w.week_key === weekKey; });
        if (existingIdx >= 0) {
            this.taxWeeks[existingIdx] = weekRecord;
        } else {
            this.taxWeeks.push(weekRecord);
        }

        // --- 员工级别重算 ---
        var self = this;

        // 按员工分组汇总 paid_amount
        var paidByEmployee = {};
        for (var i = 0; i < weekTxs.length; i++) {
            var tx = weekTxs[i];
            var pid = String(tx.player_id);
            if (!paidByEmployee[pid]) {
                paidByEmployee[pid] = { paid: 0, name: tx.player_name || '' };
            }
            paidByEmployee[pid].paid += Number(tx.amount) || 0;
        }

        // --- 分配结转转入到员工级别 ---
        // 从上一周的结转记录中提取 per_employee_surplus 并加到当前周每位员工的实缴中
        var incomingCarryovers = this.taxCarryovers.filter(function(c) {
            return c.to_week_key === weekKey && !c.deleted;
        });
        for (var ci = 0; ci < incomingCarryovers.length; ci++) {
            var ic = incomingCarryovers[ci];
            var surplusMap = ic.per_employee_surplus;
            if (surplusMap && typeof surplusMap === 'object') {
                for (var spid in surplusMap) {
                    if (surplusMap.hasOwnProperty(spid)) {
                        if (!paidByEmployee[spid]) {
                            paidByEmployee[spid] = { paid: 0, name: '' };
                        }
                        paidByEmployee[spid].paid += Number(surplusMap[spid]) || 0;
                    }
                }
            }
        }

        // 获取活跃员工列表
        var empList = this.employees || [];

        // 合并：有交易的员工 + 活跃员工
        var allEmployeeIds = new Set();
        for (var a = 0; a < empList.length; a++) {
            allEmployeeIds.add(String(empList[a].player_id));
        }
        for (var pKey in paidByEmployee) {
            if (paidByEmployee.hasOwnProperty(pKey)) {
                allEmployeeIds.add(pKey);
            }
        }

        // 删除旧记录
        var oldRecords = await DB.getByIndex('employee_tax', 'week_key', weekKey);
        for (var o = 0; o < oldRecords.length; o++) {
            await DB.delete('employee_tax', oldRecords[o].id);
        }

        // 创建新记录
        var allIdsArr = Array.from(allEmployeeIds);
        for (var e = 0; e < allIdsArr.length; e++) {
            var playerId = allIdsArr[e];
            var emp = empList.find(function(em) { return String(em.player_id) === playerId; });
            var name = emp ? emp.name : (paidByEmployee[playerId] ? paidByEmployee[playerId].name : 'Unknown');
            var paid = paidByEmployee[playerId] ? paidByEmployee[playerId].paid : 0;
            var taxAmount = self._getEmployeeTaxRate(playerId);

            // 检查是否有旧的销账状态需要保留
            var oldRec = null;
            for (var or = 0; or < oldRecords.length; or++) {
                if (String(oldRecords[or].player_id) === playerId) {
                    oldRec = oldRecords[or];
                    break;
                }
            }
            var isWrittenOff = oldRec ? oldRec.is_written_off : false;
            var writtenOffAt = oldRec ? oldRec.written_off_at : null;

            // 如果已销账但后来实缴超过了应缴，自动取消销账
            var finalWrittenOff = isWrittenOff && (paid >= taxAmount) ? false : isWrittenOff;

            await DB.put('employee_tax', {
                week_key: weekKey,
                player_id: playerId,
                player_name: name,
                tax_amount: taxAmount,
                paid_amount: paid,
                is_written_off: finalWrittenOff,
                written_off_at: finalWrittenOff ? writtenOffAt : null,
                calculated_at: Date.now()
            });
        }

        // --- 构建 per_employee_surplus 并创建/更新自动结转记录 ---
        if (carryoverOut > 0) {
            // 计算每位员工在缴纳应缴后还有多少盈余（= paid - taxAmount，仅正值）
            var perEmployeeSurplus = {};
            var allIdsArr2 = Array.from(allEmployeeIds);
            for (var es = 0; es < allIdsArr2.length; es++) {
                var spid = allIdsArr2[es];
                var spaid = paidByEmployee[spid] ? paidByEmployee[spid].paid : 0;
                var sTaxAmount = self._getEmployeeTaxRate(spid);
                var surplus = Math.max(0, spaid - sTaxAmount);
                if (surplus > 0) {
                    perEmployeeSurplus[spid] = surplus;
                }
            }

            // 计算下一周的 key
            var coRange = Utils.weekDateRange(weekKey);
            var coNextWeekDay = new Date(coRange.end.getTime() + 24 * 60 * 60 * 1000);
            var coNextWeekKey = Utils.weekKey(coNextWeekDay);

            var existingCarryover = self.taxCarryovers.find(function(c) {
                return c.from_week_key === weekKey && !c.deleted;
            });

            if (existingCarryover) {
                existingCarryover.amount = carryoverOut;
                existingCarryover.per_employee_surplus = perEmployeeSurplus;
                existingCarryover.to_week_key = coNextWeekKey;
                existingCarryover.updated_at = Date.now();
                existingCarryover.note = '更新自动结转（含员工明细）：' + Utils.weekLabel(weekKey) + ' 超额 → ' + Utils.weekLabel(coNextWeekKey);
                await DB.put('tax_carryover', existingCarryover);
            } else {
                var carryoverRecord = {
                    from_week_key: weekKey,
                    to_week_key: coNextWeekKey,
                    amount: carryoverOut,
                    per_employee_surplus: perEmployeeSurplus,
                    type: 'auto',
                    created_at: Date.now(),
                    note: '自动结转（含员工明细）：' + Utils.weekLabel(weekKey) + ' 超额 → ' + Utils.weekLabel(coNextWeekKey),
                    deleted: false
                };
                await DB.put('tax_carryover', carryoverRecord);
                self.taxCarryovers.push(carryoverRecord);
            }
        }

        // 刷新内存中的 employeeTaxList
        self.employeeTaxList = await DB.getAll('employee_tax') || [];

        return weekRecord;
    },

    // 确保周记录存在，不存在则计算
    _ensureWeekExists: async function(weekKey) {
        var existing = this.taxWeeks.find(function(w) { return w.week_key === weekKey; });
        if (!existing) {
            await this._recalculateWeek(weekKey);
        }
    },

    // 周切换核心函数
    _navigateToWeek: async function(weekKey) {
        this.selectedWeekKey = weekKey;
        await this._ensureWeekExists(weekKey);
        await this._recalculateWeek(weekKey);
        this.render();
    },

    // 获取所有已知周 Key 列表
    _getAllWeekKeys: function() {
        var weekKeys = new Set();
        // 从交易中收集
        var self = this;
        this.transactions.forEach(function(tx) {
            if (self._isTaxTx(tx) && tx.week_key) {
                weekKeys.add(tx.week_key);
            }
        });
        // 从 tax_weeks 中收集
        this.taxWeeks.forEach(function(w) {
            if (w.week_key) weekKeys.add(w.week_key);
        });
        var keys = Array.from(weekKeys).sort();
        return keys;
    },

    // 结转处理：将指定周的超额缴纳结转至下周
    _processCarryover: async function(weekKey) {
        var weekRecord = this.taxWeeks.find(function(w) { return w.week_key === weekKey; });
        if (!weekRecord) return null;
        
        var balance = Number(weekRecord.balance) || 0;
        
        // 只有结余 > 0 且非当前周才结转
        if (balance <= 0 || weekKey === Utils.weekKey()) return null;
        
        // 计算下一周
        var range = Utils.weekDateRange(weekKey);
        var nextWeekDay = new Date(range.end.getTime() + 24 * 60 * 60 * 1000);
        var nextWeekKey = Utils.weekKey(nextWeekDay);
        
        // 从 employee_tax 计算 per_employee_surplus
        var empTaxRecords = this.employeeTaxList.filter(function(r) {
            return r.week_key === weekKey;
        });
        var perEmployeeSurplus = {};
        for (var eti = 0; eti < empTaxRecords.length; eti++) {
            var etr = empTaxRecords[eti];
            var etPaid = Number(etr.paid_amount) || 0;
            var etTaxAmt = Number(etr.tax_amount) || 0;
            var etSurplus = Math.max(0, etPaid - etTaxAmt);
            if (etSurplus > 0) {
                perEmployeeSurplus[String(etr.player_id)] = etSurplus;
            }
        }
        
        // 检查是否已有结转
        var existingCarryover = this.taxCarryovers.find(function(c) {
            return c.from_week_key === weekKey && !c.deleted;
        });
        
        if (existingCarryover) {
            // 更新金额
            existingCarryover.amount = balance;
            existingCarryover.per_employee_surplus = perEmployeeSurplus;
            existingCarryover.updated_at = Date.now();
            existingCarryover.note = '更新结转：' + Utils.weekLabel(weekKey) + ' 超额 → ' + Utils.weekLabel(nextWeekKey);
            await DB.put('tax_carryover', existingCarryover);
        } else {
            // 创建新记录
            var carryoverRecord = {
                from_week_key: weekKey,
                to_week_key: nextWeekKey,
                amount: balance,
                per_employee_surplus: perEmployeeSurplus,
                type: 'manual',
                created_at: Date.now(),
                note: '手动结转：' + Utils.weekLabel(weekKey) + ' 超额 → ' + Utils.weekLabel(nextWeekKey),
                deleted: false
            };
            
            var id = await DB.put('tax_carryover', carryoverRecord);
            carryoverRecord.id = id;
            this.taxCarryovers.push(carryoverRecord);
        }
        
        // 更新周记录
        weekRecord.carryover_out = balance;
        await DB.put('tax_weeks', weekRecord);
        
        // 级联重算下一周
        await this._ensureWeekExists(nextWeekKey);
        await this._recalculateWeek(nextWeekKey);
        
        return weekRecord;
    },

    // 级联重算：从指定周开始，按时间顺序重算所有后续周（带深度限制 ≤ 53）
    _cascadeRecalculate: async function(startWeekKey, depth) {
        depth = depth || 0;
        if (depth > 53) {
            console.warn('[Finance] _cascadeRecalculate: max depth reached');
            return;
        }
        
        await this._recalculateWeek(startWeekKey);
        
        // 获取下一周
        var range = Utils.weekDateRange(startWeekKey);
        var nextWeekDay = new Date(range.end.getTime() + 24 * 60 * 60 * 1000);
        var nextWeekKey = Utils.weekKey(nextWeekDay);
        
        // 检查下一周是否有数据
        var self = this;
        var hasData = this.transactions.some(function(tx) {
            return self._isTaxTx(tx) && tx.week_key === nextWeekKey;
        }) || this.taxCarryovers.some(function(c) {
            return c.to_week_key === nextWeekKey && !c.deleted;
        });
        
        var currentWeek = Utils.weekKey();
        if (hasData && nextWeekKey <= currentWeek) {
            await this._cascadeRecalculate(nextWeekKey, depth + 1);
        }
    },

    // 一键扫描全部税务交易：修正 week_key、创建历史周记录、级联重算
    _scanAllTx: async function() {
        Utils.showLoading('正在扫描全部交易...');
        try {
            // 重新加载全部交易
            var allTxs = await DB.getAll('transactions') || [];
            this.transactions = allTxs;
            var fixedCount = 0;
            var affectedWeeks = {};

            for (var i = 0; i < allTxs.length; i++) {
                var tx = allTxs[i];
                if (!this._isTaxTx(tx)) continue;
                
                var oldWeekKey = tx.week_key;
                // force=true: 忽略已有 week_key，始终从 timestamp 重算
                var newWeekKey = this._autoMatchWeek(tx, true);
                
                // 标记旧周受影响（交易从旧周移出）
                if (oldWeekKey && oldWeekKey !== '__unassigned__') {
                    affectedWeeks[oldWeekKey] = true;
                }
                // 标记新周受影响
                if (newWeekKey && newWeekKey !== '__unassigned__') {
                    affectedWeeks[newWeekKey] = true;
                }
                
                if (newWeekKey !== oldWeekKey) {
                    tx.week_key = newWeekKey;
                    await DB.put('transactions', tx);
                    fixedCount++;
                }
            }

            // 对受影响周排序，初始化并级联重算
            var sortedWeeks = Object.keys(affectedWeeks).sort();
            for (var w = 0; w < sortedWeeks.length; w++) {
                await this._ensureWeekExists(sortedWeeks[w]);
            }
            if (sortedWeeks.length > 0) {
                await this._cascadeRecalculate(sortedWeeks[0]);
            }

            // 重新加载 tax_weeks / tax_carryovers
            this.taxWeeks = await DB.getAll('tax_weeks') || [];
            this.taxCarryovers = await DB.getAll('tax_carryover') || [];

            Utils.hideLoading();
            Utils.toast('扫描完成：修正 ' + fixedCount + ' 笔交易，' + sortedWeeks.length + ' 个周已更新', 'success');

            // 切换到本周视图
            this.selectedWeekKey = Utils.weekKey();
            await this.render();
        } catch (e) {
            Utils.hideLoading();
            Utils.toast('扫描失败: ' + e.message, 'error');
        }
    },

    // 构建员工纳税明细表格 HTML
    _employeeTaxSectionHTML: function() {
        var self = this;
        var weekKey = this.selectedWeekKey;

        // 获取当前周员工税务记录
        var empTaxRecords = this.employeeTaxList.filter(function(r) {
            return r.week_key === weekKey;
        });

        // 也纳入有交易的但可能不在 employeeTaxList 中的活跃员工
        var activeEmployees = this.employees || [];
        var displayedRecords = [];

        // 以 employeeTaxList 中的记录为基础
        var seenPlayerIds = {};
        for (var i = 0; i < empTaxRecords.length; i++) {
            var rec = empTaxRecords[i];
            seenPlayerIds[String(rec.player_id)] = true;
            displayedRecords.push(rec);
        }

        // 补充活跃员工中没有记录的人员
        for (var j = 0; j < activeEmployees.length; j++) {
            var emp = activeEmployees[j];
            var pid = String(emp.player_id);
            if (!seenPlayerIds[pid]) {
                displayedRecords.push({
                    week_key: weekKey,
                    player_id: pid,
                    player_name: emp.name || 'Unknown',
                    tax_amount: self._getEmployeeTaxRate(pid),
                    paid_amount: 0,
                    is_written_off: false,
                    written_off_at: null
                });
                seenPlayerIds[pid] = true;
            }
        }

        if (displayedRecords.length === 0) {
            return '<p class="text-xs text-gray-500 text-center py-4">暂无员工纳税数据</p>';
        }

        // 按名称排序
        displayedRecords.sort(function(a, b) {
            return (a.player_name || '').localeCompare(b.player_name || '');
        });

        var html = '<div class="emp-tax-section">';
        html += '<div class="flex items-center justify-between mb-3">';
        html += '<h4 class="text-sm font-semibold text-gray-300">📋 员工纳税明细</h4>';
        html += '<button class="btn btn-xs btn-secondary" data-action="open-emp-tax-rates">员工税率管理</button>';
        html += '</div>';

        // 表头
        html += '<div class="emp-tax-header">';
        html += '<div class="emp-tax-col-dot"></div>';
        html += '<div>员工</div>';
        html += '<div class="text-right">应缴</div>';
        html += '<div class="text-right">已缴</div>';
        html += '<div class="text-right">差额</div>';
        html += '<div class="text-center">状态</div>';
        html += '<div class="text-center">操作</div>';
        html += '</div>';

        // 行
        for (var k = 0; k < displayedRecords.length; k++) {
            var row = displayedRecords[k];
            var taxAmt = Number(row.tax_amount) || 0;
            var paidAmt = Number(row.paid_amount) || 0;
            var diff = paidAmt - taxAmt;
            var isWrittenOff = row.is_written_off === true;

            // 状态判断
            var rowClass = '';
            var dotClass = '';
            var statusText = '';
            var statusBadgeClass = '';

            if (isWrittenOff) {
                rowClass = 'emp-tax-row-writeoff';
                dotClass = 'status-dot-writeoff';
                statusText = '📋 已销账';
                statusBadgeClass = 'emp-tax-status-writeoff';
            } else if (paidAmt >= taxAmt && taxAmt > 0) {
                dotClass = 'status-dot-paid';
                statusText = '✅ 已缴清';
                statusBadgeClass = 'emp-tax-status-paid';
            } else if (paidAmt <= 0) {
                rowClass = 'emp-tax-row-unpaid';
                dotClass = 'status-dot-unpaid';
                statusText = '🔴 未缴';
                statusBadgeClass = 'emp-tax-status-unpaid';
            } else {
                rowClass = 'emp-tax-row-partial';
                dotClass = 'status-dot-partial';
                statusText = '⚠️ 欠费';
                statusBadgeClass = 'emp-tax-status-partial';
            }

            var diffText = diff >= 0 ? ('+' + Utils.formatCurrency(diff)) : Utils.formatCurrency(diff);
            var diffColor = diff >= 0 ? 'text-green-400' : 'text-red-400';

            html += '<div class="emp-tax-row ' + rowClass + '">';
            // 状态点
            html += '<div class="emp-tax-col-dot"><span class="' + dotClass + '"></span></div>';
            // 员工名
            html += '<div class="truncate text-gray-200">' + (row.player_name || 'Unknown') + '</div>';
            // 应缴（可编辑）
            html += '<div class="text-right">';
            html += '<span class="emp-tax-amount-editable" data-action="edit-emp-tax" data-player-id="' + row.player_id + '" data-week-key="' + weekKey + '" title="点击编辑应缴税额">' + Utils.formatCurrency(taxAmt) + '</span>';
            html += '</div>';
            // 已缴
            html += '<div class="text-right text-white">' + Utils.formatCurrency(paidAmt) + '</div>';
            // 差额
            html += '<div class="text-right ' + diffColor + '">' + diffText + '</div>';
            // 状态
            html += '<div class="text-center">';
            html += '<span class="emp-tax-status-badge ' + statusBadgeClass + '">' + statusText + '</span>';
            html += '</div>';
            // 操作
            html += '<div class="text-center">';
            if (isWrittenOff) {
                html += '<button class="btn btn-xs btn-secondary" data-action="cancel-writeoff" data-player-id="' + row.player_id + '" data-week-key="' + weekKey + '">取消销账</button>';
            } else {
                html += '<button class="btn btn-xs btn-secondary" data-action="write-off-emp" data-player-id="' + row.player_id + '" data-week-key="' + weekKey + '">销账</button>';
            }
            html += '</div>';
            html += '</div>';
        }

        html += '</div>'; // .emp-tax-section
        return html;
    },

    // 构建员工税率管理模态框 HTML
    _employeeTaxRatesModalHTML: function() {
        var self = this;
        var activeEmployees = this.employees || [];
        var globalTax = (this.config && this.config.weekly_tax_amount) || 0;

        var html = '<div class="p-6">';
        html += '<h3 class="text-lg font-bold text-white mb-4">员工税率管理</h3>';
        html += '<p class="text-xs text-gray-500 mb-4">为每个员工设置个性化每周应缴税额。留空的员工将使用全局税率 (' + Utils.formatCurrency(globalTax) + ')。</p>';

        html += '<div class="emp-tax-rates-list mb-4">';
        for (var i = 0; i < activeEmployees.length; i++) {
            var emp = activeEmployees[i];
            var pid = String(emp.player_id);
            var rateConfig = self.employeeTaxRates.find(function(r) { return String(r.player_id) === pid; });
            var currentRate = rateConfig ? rateConfig.tax_amount : '';
            var isCustom = rateConfig && rateConfig.tax_amount != null;

            html += '<div class="emp-tax-rate-row">';
            html += '<span class="text-gray-200 text-sm truncate flex-1">' + (emp.name || 'Unknown') + '</span>';
            html += '<span class="text-xs text-gray-500 mr-2">' + (isCustom ? '自定义' : '全局(' + Utils.formatCurrency(globalTax) + ')') + '</span>';
            html += '<input type="text" class="input input-sm emp-tax-rate-input money-input" data-player-id="' + pid + '" value="' + (currentRate !== '' ? Number(currentRate).toLocaleString('en-US') : '') + '" placeholder="留空=全局" style="width:120px;text-align:right" />';
            html += '</div>';
        }
        html += '</div>';

        html += '<div class="flex gap-2 justify-between">';
        html += '<div>';
        html += '<button class="btn btn-sm btn-secondary" data-action="apply-default-tax-all">应用全局税率</button>';
        html += '</div>';
        html += '<div class="flex gap-2">';
        html += '<button class="btn btn-secondary" id="emp-tax-rates-cancel">取消</button>';
        html += '<button class="btn btn-primary" id="emp-tax-rates-save">保存</button>';
        html += '</div>';
        html += '</div>';

        html += '</div>';
        return html;
    },

    // 构建结转记录展示 HTML
    _buildCarryoverHTML: function() {
        var self = this;
        
        // 获取与当前周相关的结转记录
        var relatedCarryovers = this.taxCarryovers.filter(function(c) {
            return (c.from_week_key === self.selectedWeekKey || c.to_week_key === self.selectedWeekKey) && !c.deleted;
        });
        
        if (relatedCarryovers.length === 0) return '';
        
        var html = '<div class="bg-torn-card rounded-lg p-4 mt-4">';
        html += '<h4 class="text-sm font-semibold text-gray-300 mb-3">📋 结转记录</h4>';
        html += '<div class="space-y-2">';
        
        relatedCarryovers.forEach(function(c) {
            var isOutgoing = c.from_week_key === self.selectedWeekKey;
            var icon = isOutgoing ? '↗' : '↘';
            var color = isOutgoing ? 'text-orange-400' : 'text-blue-400';
            var label = isOutgoing ? '转出至 ' + Utils.weekLabel(c.to_week_key) : '来自 ' + Utils.weekLabel(c.from_week_key);
            
            html += '<div class="flex items-center justify-between py-2 border-b border-gray-700 text-xs">';
            html += '<div><span class="' + color + ' font-bold mr-2">' + icon + '</span>';
            html += '<span class="text-gray-300">' + label + '</span>';
            html += '<span class="text-gray-500 ml-2">' + (c.type === 'auto' ? '自动' : '手动') + '</span>';
            html += '</div>';
            html += '<span class="' + color + ' font-medium">' + Utils.formatCurrency(c.amount) + '</span>';
            html += '</div>';
        });
        
        html += '</div></div>';
        return html;
    },

    // ---- Full Page HTML ----

    _buildHTML() {
        const headerHTML = `
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-xl font-bold text-white">
                    <i class="fas fa-wallet mr-2 text-torn-accent"></i>财务管理
                </h2>
                <div class="flex gap-2">
                    <button class="btn btn-primary" data-action="add-transaction">
                        <i class="fas fa-plus"></i> 添加交易
                    </button>
                    <button class="btn btn-secondary" data-action="refresh">
                        <i class="fas fa-sync-alt"></i> 刷新
                    </button>
                </div>
            </div>
        `;

        const tabsHTML = UI.tabNav([
            { id: 'overview', label: '财务概览', icon: 'fas fa-chart-pie' },
            { id: 'transactions', label: '交易记录', icon: 'fas fa-exchange-alt' },
            { id: 'tax', label: '税务管理', icon: 'fas fa-file-invoice-dollar' }
        ], this.activeTab, 'finance-tabs');

        let tabContent = '';
        switch (this.activeTab) {
            case 'overview':     tabContent = this._overviewTabHTML(); break;
            case 'transactions': tabContent = this._transactionsTabHTML(); break;
            case 'tax':          tabContent = this._taxTabHTML(); break;
        }

        return `${headerHTML}${tabsHTML}<div id="finance-tab-content">${tabContent}</div>`;
    },

    // ---- Tab: 财务概览 ----

    _overviewTabHTML() {
        const now = new Date();
        const dayOfWeek = now.getDay() || 7; // 1-7 (Mon-Sun)
        const startOfWeek = new Date(now);
        startOfWeek.setDate(now.getDate() - dayOfWeek + 1);
        startOfWeek.setHours(0, 0, 0, 0);

        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Calculate transaction sums
        let weekTax = 0, weekTrain = 0, weekBoost = 0, weekOther = 0;
        let monthTax = 0, monthTrain = 0, monthBoost = 0, monthOther = 0;

        for (const tx of this.transactions) {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 100000000000) ts *= 1000; // normalize seconds to ms

            if (ts >= startOfWeek.getTime()) {
                if (this._isTaxTx(tx)) weekTax += tx.amount;
                else if (tx.category === 'train') weekTrain += tx.amount;
                else if (tx.category === 'boost') weekBoost += tx.amount;
                else weekOther += tx.amount;
            }
            if (ts >= startOfMonth.getTime()) {
                if (this._isTaxTx(tx)) monthTax += tx.amount;
                else if (tx.category === 'train') monthTrain += tx.amount;
                else if (tx.category === 'boost') monthBoost += tx.amount;
                else monthOther += tx.amount;
            }
        }

        // Get API data from snapshot
        const detailed = this.latestSnapshot?.detailed || {};
        const dailyIncome = detailed.daily_income || 0;
        const dailyAdFee = detailed.advertising_budget || 0;
        
        let dailyCost = detailed.daily_cost_of_goods || 0;
        if (!dailyCost && detailed.daily_income && detailed.daily_profit) {
            const wages = detailed.daily_wages || 0;
            dailyCost = Math.max(0, detailed.daily_income - detailed.daily_profit - dailyAdFee - wages);
        }

        // Calculate Weekly
        const weekIncomeAPI = dailyIncome * 7;
        const weekAdFeeAPI = dailyAdFee * 7;
        const weekCostAPI = dailyCost * 7;
        
        const weekTotalIncome = weekTax + weekTrain + weekOther + weekIncomeAPI;
        const weekTotalExpense = weekBoost + weekCostAPI + weekAdFeeAPI;
        const weekNetProfit = weekTotalIncome - weekTotalExpense;

        // Calculate Monthly (当月已发生的数据 + 本周的预测数据)
        const monthTotalIncome = monthTax + monthTrain + monthOther + weekIncomeAPI;
        const monthTotalExpense = monthBoost + weekCostAPI + weekAdFeeAPI;
        const monthNetProfit = monthTotalIncome - monthTotalExpense;

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-calendar-week mr-2 text-torn-accent"></i>本周概览 (日历周预估)
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    ${UI.kpiCard('fas fa-arrow-down', '总支出', Utils.formatMoney(weekTotalExpense), '成本+广告+Boost', 'red')}
                    ${UI.kpiCard('fas fa-arrow-up', '总收入', Utils.formatMoney(weekTotalIncome), '税费+训练+其他+日收入', 'green')}
                    ${UI.kpiCard('fas fa-balance-scale', '净利润', Utils.formatMoney(weekNetProfit), '收入 - 支出', weekNetProfit >= 0 ? 'accent' : 'red')}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- Expenses -->
                    <div class="bg-torn-surface border border-torn-border rounded p-4">
                        <h4 class="text-md font-bold text-red-400 border-b border-torn-border pb-2 mb-3">本周支出明细</h4>
                        <div class="space-y-2 text-sm">
                            <div class="flex justify-between text-gray-300">
                                <span>商品成本预估 (API计算):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekCostAPI)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>广告费预估 (API):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekAdFeeAPI)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>购买 Boost 记录 (手动/日志):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekBoost)}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Income -->
                    <div class="bg-torn-surface border border-torn-border rounded p-4">
                        <h4 class="text-md font-bold text-torn-green border-b border-torn-border pb-2 mb-3">本周收入明细</h4>
                        <div class="space-y-2 text-sm">
                            <div class="flex justify-between text-gray-300">
                                <span>员工税费 (记录):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekTax)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>员工训练费 (记录):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekTrain)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>其他收入 (记录):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekOther)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>公司日收入预估 (API):</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekIncomeAPI)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Monthly Overview -->
            <div class="card">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-calendar-alt mr-2 text-torn-accent"></i>月度概览 (日历月预估)
                </h3>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度总支出预估</div>
                        <div class="text-red-400 font-bold">${Utils.formatMoney(monthTotalExpense)}</div>
                    </div>
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度总收入预估</div>
                        <div class="text-torn-green font-bold">${Utils.formatMoney(monthTotalIncome)}</div>
                    </div>
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度净利润预估</div>
                        <div class="${monthNetProfit >= 0 ? 'text-torn-gold' : 'text-red-400'} font-bold">${Utils.formatMoney(monthNetProfit)}</div>
                    </div>
                </div>
                <div class="text-xs text-gray-500 text-right">计算公式：当月实际交易记录 + 本周API预测数据</div>
            </div>
        `;
    },

    // ---- Tab: 交易记录 ----

    _transactionsTabHTML() {
        const empOptions = this.employees.map(e => `<option value="${e.player_id}" ${this.txFilterEmp === String(e.player_id) ? 'selected' : ''}>${e.name}</option>`).join('');

        const headers = [
            { key: 'select', label: '<input type="checkbox" id="tx-select-all" class="cursor-pointer" />', sortable: false },
            { key: 'date', label: '日期', sortable: true },
            { key: 'employee', label: '员工', sortable: true },
            { key: 'amount', label: '金额', sortable: true },
            { key: 'category', label: '分类' },
            { key: 'note', label: '备注', width: '200px' },
            { key: 'actions', label: '操作', sortable: false }
        ];

        let filteredTx = this.transactions;
        if (this.txFilterEmp) {
            filteredTx = filteredTx.filter(t => String(t.player_id) === this.txFilterEmp);
        }

        const now = new Date();
        if (this.txFilterTime === 'week') {
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - (now.getDay() || 7) + 1);
            startOfWeek.setHours(0, 0, 0, 0);
            filteredTx = filteredTx.filter(t => {
                let ts = t.timestamp || 0;
                if (ts > 0 && ts < 100000000000) ts *= 1000;
                return ts >= startOfWeek.getTime();
            });
        } else if (this.txFilterTime === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            filteredTx = filteredTx.filter(t => {
                let ts = t.timestamp || 0;
                if (ts > 0 && ts < 100000000000) ts *= 1000;
                return ts >= startOfMonth.getTime();
            });
        }

        const sortedTx = [...filteredTx].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        const rows = sortedTx.map(tx => {
            const cat = tx.category || 'other';
            const catSelect = `
                <select class="input input-xs bg-torn-surface border border-torn-border cursor-pointer tx-cat-select max-w-[80px]" data-tx-id="${tx.id}">
                    <option value="train" ${cat === 'train' ? 'selected' : ''}>训练</option>
                    <option value="tax" ${cat === 'tax' ? 'selected' : ''}>税务</option>
                    <option value="other" ${cat === 'other' ? 'selected' : ''}>其他</option>
                </select>
            `;
            return {
                select: `<input type="checkbox" class="tx-row-cb cursor-pointer" data-tx-id="${tx.id}" />`,
                id: tx.id,
                date: tx.date || '-',
                employee: tx.player_name || '-',
                amount: Utils.formatMoney(tx.amount || 0),
                category: catSelect,
                note: tx.note
                    ? `<span class="truncate block max-w-[200px]" title="${tx.note.replace(/"/g, '"')}">${tx.note}</span>`
                    : '-',
                actions: `
                    <div class="flex gap-1">
                        <button class="btn btn-xs btn-secondary" data-action="edit-tx" data-tx-id="${tx.id}" title="编辑">
                            <i class="fas fa-edit"></i>
                        </button>
                        <button class="btn btn-xs btn-secondary" data-action="split-tx" data-tx-id="${tx.id}" title="拆分">
                            <i class="fas fa-cut"></i>
                        </button>
                        <button class="btn btn-xs btn-secondary" data-action="delete-tx" data-tx-id="${tx.id}" title="删除">
                            <i class="fas fa-trash"></i>
                        </button>
                    </div>
                `
            };
        });

        return `
            <div class="card">
                <div class="mb-4">
                    <h3 class="text-lg font-bold text-white mb-3">
                        <i class="fas fa-exchange-alt mr-2 text-torn-accent"></i>交易记录
                    </h3>
                    <div class="flex items-center gap-2 overflow-x-auto pb-1 hide-scrollbar">
                        <select id="tx-filter-time" class="input input-sm shrink-0 truncate" style="max-width: 90px;">
                            <option value="week" ${this.txFilterTime === 'week' ? 'selected' : ''}>本周</option>
                            <option value="month" ${this.txFilterTime === 'month' ? 'selected' : ''}>本月</option>
                            <option value="all" ${this.txFilterTime === 'all' ? 'selected' : ''}>全部时间</option>
                        </select>
                        <select id="tx-filter-emp" class="input input-sm shrink-0 truncate" style="max-width: 120px;">
                            <option value="">全部员工</option>
                            ${empOptions}
                        </select>
                        <button class="btn btn-sm btn-secondary whitespace-nowrap shrink-0" data-action="auto-detect">
                            <i class="fas fa-search"></i> 自动检测
                        </button>
                        <button class="btn btn-sm btn-secondary whitespace-nowrap shrink-0" data-action="bulk-edit-category">
                            <i class="fas fa-tag"></i> 批量分类
                        </button>
                        <button class="btn btn-sm bg-red-900/50 hover:bg-red-900 text-red-200 border border-red-800 whitespace-nowrap shrink-0" data-action="bulk-delete-tx">
                            <i class="fas fa-trash"></i> 批量删除
                        </button>
                    </div>
                </div>
                ${UI.dataTable({
                    headers,
                    rows,
                    id: 'transactions-table',
                    emptyText: '暂无符合条件的交易记录'
                })}
            </div>
        `;
    },

    // ---- Tab: 税务管理 ----

    _taxTabHTML() {
        var self = this;
        var html = '';

        // 周选择器
        html += this._weekSelectorHTML();

        // 获取当前周数据
        var weekRecord = this.taxWeeks.find(function(w) { return w.week_key === self.selectedWeekKey; });
        var weekTxs = this._getWeekTransactions(this.selectedWeekKey);

        // === 税务配置卡片 ===
        var weeklyTax = this.config.weekly_tax_amount || 0;

        // === 税务概览卡片 (使用周数据) ===
        var taxDue = weekRecord ? (Number(weekRecord.tax_due) || 0) : 0;
        var taxPaid = weekRecord ? (Number(weekRecord.tax_paid) || 0) : 0;
        var carryoverIn = weekRecord ? (Number(weekRecord.carryover_in) || 0) : 0;
        var netDue = weekRecord ? (Number(weekRecord.net_due) || 0) : 0;
        var balance = weekRecord ? (Number(weekRecord.balance) || 0) : 0;
        var status = weekRecord ? weekRecord.status : 'current';
        var employeeCount = weekRecord ? weekRecord.employee_count : 0;

        var statusText = status === 'paid' ? '已缴清' : (status === 'overdue' ? '未缴清' : '进行中');
        var statusColor = status === 'paid' ? 'text-green-400' : (status === 'overdue' ? 'text-red-400' : 'text-yellow-400');

        html += '<div class="tax-summary grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">';
        // 应缴税额
        html += '<div class="bg-torn-card rounded-lg p-3 text-center">';
        html += '<div class="text-xs text-gray-400 mb-1">应缴税额</div>';
        html += '<div class="text-lg font-bold text-white">' + Utils.formatCurrency(taxDue) + '</div>';
        html += '<div class="text-xs text-gray-500">' + employeeCount + ' 名员工</div>';
        html += '</div>';
        // 实缴税额
        html += '<div class="bg-torn-card rounded-lg p-3 text-center">';
        html += '<div class="text-xs text-gray-400 mb-1">实缴税额</div>';
        html += '<div class="text-lg font-bold text-white">' + Utils.formatCurrency(taxPaid) + '</div>';
        html += '</div>';
        // 结转转入
        html += '<div class="bg-torn-card rounded-lg p-3 text-center">';
        html += '<div class="text-xs text-gray-400 mb-1">结转转入</div>';
        html += '<div class="text-lg font-bold text-blue-400">' + Utils.formatCurrency(carryoverIn) + '</div>';
        html += '</div>';
        // 余额
        html += '<div class="bg-torn-card rounded-lg p-3 text-center">';
        html += '<div class="text-xs text-gray-400 mb-1">余额</div>';
        html += '<div class="text-lg font-bold ' + (balance >= 0 ? 'text-green-400' : 'text-red-400') + '">' + Utils.formatCurrency(balance) + '</div>';
        html += '</div>';
        html += '</div>';

        // === 员工纳税明细 ===
        html += this._employeeTaxSectionHTML();

        // 状态栏
        html += '<div class="bg-torn-card rounded-lg p-3 mb-4 flex items-center justify-between">';
        html += '<span class="text-sm text-gray-300">周状态: <span class="' + statusColor + ' font-semibold">● ' + statusText + '</span></span>';
        html += '<span class="text-xs text-gray-500">净应缴: ' + Utils.formatCurrency(netDue) + '</span>';
        html += '</div>';

        // === 税务配置 ===
        html += '<div class="card mb-4">';
        html += '<h3 class="text-lg font-bold text-white mb-4">';
        html += '<i class="fas fa-file-invoice-dollar mr-2 text-torn-accent"></i>税务配置';
        html += '</h3>';
        html += '<div class="flex items-end gap-4">';
        html += '<div class="flex-1 max-w-xs">';
        html += '<label class="text-gray-400 text-sm mb-1 block">每周应缴税款 ($)</label>';
        html += '<input type="text" class="input money-input" id="cfg-weekly-tax" value="' + weeklyTax + '" placeholder="支持 k/m/b 后缀" />';
        html += '</div>';
        html += '<button class="btn btn-primary" data-action="save-tax-config">';
        html += '<i class="fas fa-save"></i> 保存';
        html += '</button>';
        html += '<button class="btn btn-sm btn-secondary ml-2" data-action="scan-tax" title="扫描全部交易记录，自动匹配周归属并建立历史周数据">';
        html += '<i class="fas fa-sync-alt"></i> 重新扫描全部交易';
        html += '</button>';
        html += '</div></div>';

        // === 归属周修改面板 ===
        html += '<div class="bg-torn-card rounded-lg p-4 mb-4">';
        html += '<h4 class="text-sm font-semibold text-gray-300 mb-3">归属周批量修改</h4>';
        html += '<p class="text-xs text-gray-500 mb-3">选择下方未归类或归属错误的交易，批量修改其归属周。</p>';
        html += '<div class="flex gap-2 items-center flex-wrap">';
        html += '<select id="batch-week-select" class="bg-torn-bg text-white px-3 py-2 rounded text-sm border border-gray-600">';
        // 生成可选周列表
        var allWeekKeys = this._getAllWeekKeys();
        allWeekKeys.forEach(function(wk) {
            var label = Utils.weekLabel(wk);
            html += '<option value="' + wk + '">' + label + '</option>';
        });
        html += '</select>';
        html += '<button id="batch-assign-week" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors">应用到选中</button>';
        html += '<span id="batch-selected-count" class="text-xs text-gray-500 ml-2">已选 0 笔</span>';
        html += '</div></div>';

        // === 该周全部税务交易明细 ===
        html += '<div class="bg-torn-card rounded-lg p-4">';
        html += '<h4 class="text-sm font-semibold text-gray-300 mb-3">交易明细</h4>';

        if (weekTxs.length === 0) {
            html += '<p class="text-xs text-gray-500 text-center py-4">暂无交易记录</p>';
        } else {
            // 列标题行（与 _buildTaxTransactionRow 的 grid 列对齐）
            html += '<div class="tax-tx-row text-gray-500 text-[11px] border-b border-gray-600 pb-1 mb-1" style="border-bottom-style:solid">';
            html += '<div class="tax-tx-col tax-tx-col-cb"></div>';
            html += '<div class="tax-tx-col tax-tx-col-info">员工 / 日期</div>';
            html += '<div class="tax-tx-col tax-tx-col-amount text-right">金额</div>';
            html += '<div class="tax-tx-col tax-tx-col-week">归属周</div>';
            html += '<div class="tax-tx-col tax-tx-col-note">备注</div>';
            html += '</div>';
            html += '<div class="space-y-0">';
            weekTxs.forEach(function(tx) {
                html += self._buildTaxTransactionRow(tx);
            });
            html += '</div>';
        }
        html += '</div>';

        html += this._buildCarryoverHTML();

        return html;
    },

    // ---- Week Selector UI ----

    _weekSelectorHTML: function() {
        var isCurrentWeek = this.selectedWeekKey === Utils.weekKey();
        var weekLabelText = Utils.weekLabel(this.selectedWeekKey);
        var self = this;

        // 查找当前周的记录以确定状态
        var weekRecord = self.taxWeeks.find(function(w) { return w.week_key === self.selectedWeekKey; });

        var statusDotColor = 'text-gray-400';
        var statusText = '无数据';
        if (weekRecord) {
            switch (weekRecord.status) {
                case 'paid':
                    statusDotColor = 'text-green-400';
                    statusText = '已缴清';
                    break;
                case 'overdue':
                    statusDotColor = 'text-red-400';
                    statusText = '未缴清';
                    break;
                case 'current':
                    statusDotColor = 'text-yellow-400';
                    statusText = '进行中';
                    break;
                default:
                    statusDotColor = 'text-gray-400';
                    statusText = '无数据';
                    break;
            }
        }

        var nextDisabledClass = isCurrentWeek ? 'opacity-50 cursor-not-allowed' : '';
        var nextDisabledAttr = isCurrentWeek ? ' disabled' : '';

        var html = '<div class="week-selector flex items-center justify-center gap-3 mb-4 p-4 bg-torn-card rounded-lg">';
        html += '<button class="week-nav-btn px-6 py-4 bg-torn-bg hover:bg-torn-accent hover:text-white rounded transition-colors text-2xl font-bold min-w-[52px]" data-action="prev-week" title="上一周">«</button>';
        html += '<div class="week-label flex flex-col items-center min-w-[300px]">';
        html += '<span class="text-base font-semibold text-torn-accent" id="week-label-text">' + weekLabelText + '</span>';
        html += '<span class="text-xs mt-1 ' + statusDotColor + '" id="week-status-text">● ' + statusText + '</span>';
        html += '</div>';
        html += '<button class="week-nav-btn px-6 py-4 bg-torn-bg hover:bg-torn-accent hover:text-white rounded transition-colors text-2xl font-bold min-w-[52px] ' + nextDisabledClass + '" data-action="next-week"' + nextDisabledAttr + ' title="下一周">»</button>';
        if (!isCurrentWeek) {
            html += '<button class="week-today-btn px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded text-sm transition-colors" data-action="goto-today">回到本周</button>';
        }
        html += '</div>';

        return html;
    },

    _bindWeekSelectorEvents: function() {
        var self = this;

        // 清理旧事件监听器（防止 render 多次调用造成事件堆积 / 双击跳两周）
        if (self._weekNavPrevHandler) {
            var oldPrevBtn = document.querySelector('[data-action="prev-week"]');
            if (oldPrevBtn) oldPrevBtn.removeEventListener('click', self._weekNavPrevHandler);
        }
        if (self._weekNavNextHandler) {
            var oldNextBtn = document.querySelector('[data-action="next-week"]');
            if (oldNextBtn) oldNextBtn.removeEventListener('click', self._weekNavNextHandler);
        }
        if (self._weekNavTodayHandler) {
            var oldTodayBtn = document.querySelector('[data-action="goto-today"]');
            if (oldTodayBtn) oldTodayBtn.removeEventListener('click', self._weekNavTodayHandler);
        }

        // 上一周按钮：用 range.start - 1天 精确跳到上一周
        var prevBtn = document.querySelector('[data-action="prev-week"]');
        if (prevBtn) {
            self._weekNavPrevHandler = async function() {
                var range = Utils.weekDateRange(self.selectedWeekKey);
                // 前一天必然属于上一周（比 range.start - 7天 更稳健，避免跨年/闰秒边界跳两周）
                var prevDay = new Date(range.start.getTime() - 24 * 60 * 60 * 1000);
                var prevWeekKey = Utils.weekKey(prevDay);
                await self._navigateToWeek(prevWeekKey);
            };
            prevBtn.addEventListener('click', self._weekNavPrevHandler);
        }

        // 下一周按钮：用 range.end + 1天 精确跳到下一周
        var nextBtn = document.querySelector('[data-action="next-week"]');
        if (nextBtn) {
            self._weekNavNextHandler = async function() {
                var range = Utils.weekDateRange(self.selectedWeekKey);
                // 后一天必然属于下一周
                var nextDay = new Date(range.end.getTime() + 24 * 60 * 60 * 1000);
                var nextWeekKey = Utils.weekKey(nextDay);
                // 不能超过当前周
                var currentWeek = Utils.weekKey();
                if (nextWeekKey <= currentWeek) {
                    await self._navigateToWeek(nextWeekKey);
                }
            };
            nextBtn.addEventListener('click', self._weekNavNextHandler);
        }

        // 回到本周按钮
        var todayBtn = document.querySelector('[data-action="goto-today"]');
        if (todayBtn) {
            self._weekNavTodayHandler = async function() {
                await self._navigateToWeek(Utils.weekKey());
            };
            todayBtn.addEventListener('click', self._weekNavTodayHandler);
        }
    },

    // ---- 税务 Tab 辅助函数 ----

    _buildTaxTransactionRow: function(tx) {
        // 时间戳归一化：毫秒 (>= 1e12) 直接用，秒 (< 1e12) 转毫秒
        var ts = tx.timestamp;
        var dateStr;
        if (!ts) {
            dateStr = '无日期';
        } else {
            var ms = ts >= 1e12 ? ts : ts * 1000;
            dateStr = new Date(ms).toLocaleDateString('zh-CN');
        }
        var weekKey = tx.week_key || '__unassigned__';
        var weekLabel = weekKey === '__unassigned__' ? '未归类' : Utils.weekLabel(weekKey);

        // 使用 CSS Grid 固定列宽，确保每行列对齐
        // 列：复选框 | 员工+日期 | 金额 | 归属周 | 备注
        var html = '<div class="tax-tx-row">';
        // 列1：复选框
        html += '<div class="tax-tx-col tax-tx-col-cb">';
        html += '<input type="checkbox" class="batch-tx-checkbox" data-tx-id="' + tx.id + '" />';
        html += '</div>';
        // 列2：员工 + 日期
        html += '<div class="tax-tx-col tax-tx-col-info">';
        html += '<span class="text-gray-300 truncate block">' + (tx.player_name || '未知') + '</span>';
        html += '<span class="text-gray-500 text-[10px] block">' + dateStr + '</span>';
        html += '</div>';
        // 列3：金额
        html += '<div class="tax-tx-col tax-tx-col-amount text-right">';
        html += '<span class="text-white font-medium">' + Utils.formatCurrency(tx.amount) + '</span>';
        html += '</div>';
        // 列4：归属周选择器
        html += '<div class="tax-tx-col tax-tx-col-week">';
        html += '<select class="week-assign-select bg-torn-bg text-white text-xs px-1 py-1 rounded border border-gray-600 w-full" data-tx-id="' + tx.id + '">';
        html += '<option value="' + weekKey + '" selected>' + weekLabel + '</option>';
        if (weekKey !== '__unassigned__') {
            html += '<option value="__unassigned__">未归类</option>';
        }
        var allWeeks = this._getAllWeekKeys();
        var self = this;
        allWeeks.forEach(function(wk) {
            if (wk !== weekKey) {
                html += '<option value="' + wk + '">' + Utils.weekLabel(wk) + '</option>';
            }
        });
        html += '</select>';
        html += '</div>';
        // 列5：备注（截断超长文本，hover 显示全文）
        html += '<div class="tax-tx-col tax-tx-col-note">';
        if (tx.note) {
            html += '<span class="text-gray-500 text-xs italic truncate block" title="' + tx.note.replace(/"/g, '"') + '">' + tx.note + '</span>';
        }
        html += '</div>';
        html += '</div>';
        return html;
    },

    _bindTaxTabEvents: function() {
        var self = this;

        // 归属周下拉变更 - 立即保存
        document.querySelectorAll('.week-assign-select').forEach(function(select) {
            select.addEventListener('change', async function() {
                var txId = this.dataset.txId;
                var newWeekKey = this.value;
                await self._assignTransactionWeek(txId, newWeekKey);
            });
        });

        // 批量选择计数
        var batchCheckboxes = document.querySelectorAll('.batch-tx-checkbox');
        var selectedCountEl = document.getElementById('batch-selected-count');
        batchCheckboxes.forEach(function(cb) {
            cb.addEventListener('change', function() {
                var count = document.querySelectorAll('.batch-tx-checkbox:checked').length;
                if (selectedCountEl) {
                    selectedCountEl.textContent = '已选 ' + count + ' 笔';
                }
            });
        });

        // 批量应用归属周
        var batchBtn = document.getElementById('batch-assign-week');
        if (batchBtn) {
            batchBtn.addEventListener('click', async function() {
                var targetWeek = document.getElementById('batch-week-select').value;
                var checked = document.querySelectorAll('.batch-tx-checkbox:checked');
                if (checked.length === 0) {
                    alert('请先选择交易');
                    return;
                }
                for (var i = 0; i < checked.length; i++) {
                    var txId = checked[i].dataset.txId;
                    await self._assignTransactionWeek(txId, targetWeek);
                }
                self.render();
            });
        }

        // === 员工纳税明细事件 ===

        // 行内编辑应缴税额点击
        document.querySelectorAll('[data-action="edit-emp-tax"]').forEach(function(span) {
            span.addEventListener('click', function(e) {
                e.preventDefault();
                var playerId = this.dataset.playerId;
                var weekKey = this.dataset.weekKey;
                var currentText = this.textContent.replace(/[$,]/g, '').trim();
                var currentVal = parseFloat(currentText.replace(/[kKmMbB]$/, function(m) {
                    if (m === 'k' || m === 'K') return '000';
                    if (m === 'm' || m === 'M') return '000000';
                    if (m === 'b' || m === 'B') return '000000000';
                    return '';
                })) || 0;

                var input = document.createElement('input');
                input.type = 'text';
                input.className = 'emp-tax-amount-input money-input';
                input.value = Number(currentVal).toLocaleString('en-US');
                input.dataset.playerId = playerId;
                input.dataset.weekKey = weekKey;

                var parent = this.parentNode;
                parent.replaceChild(input, this);
                input.focus();
                input.select();

                var saveEdit = async function() {
                    var newVal = Utils.parseMoneyInput(input.value);
                    if (isNaN(newVal) || newVal < 0) {
                        Utils.toast('请输入有效金额', 'warning');
                        return;
                    }

                    // 更新 employee_tax 记录
                    var records = self.employeeTaxList.filter(function(r) {
                        return r.week_key === weekKey && String(r.player_id) === String(playerId);
                    });

                    var record;
                    if (records.length > 0) {
                        record = records[0];
                        record.tax_amount = newVal;
                        record.calculated_at = Date.now();
                        await DB.put('employee_tax', record);
                    } else {
                        // 创建新记录
                        record = {
                            week_key: weekKey,
                            player_id: playerId,
                            player_name: '',
                            tax_amount: newVal,
                            paid_amount: 0,
                            is_written_off: false,
                            written_off_at: null,
                            calculated_at: Date.now()
                        };
                        await DB.put('employee_tax', record);
                        self.employeeTaxList.push(record);
                    }

                    // 重新渲染
                    self.render();
                    Utils.toast('应缴税额已更新', 'success');
                };

                input.addEventListener('blur', saveEdit);
                input.addEventListener('keydown', function(ev) {
                    if (ev.key === 'Enter') {
                        ev.preventDefault();
                        input.blur();
                    }
                    if (ev.key === 'Escape') {
                        ev.preventDefault();
                        self.render();
                    }
                });
            });
        });
    },

    _assignTransactionWeek: async function(txId, newWeekKey) {
        var tx = this.transactions.find(function(t) { return String(t.id) === String(txId); });
        if (!tx) return;

        var oldWeekKey = tx.week_key;
        tx.week_key = newWeekKey;

        // 保存到 DB
        await DB.put('transactions', tx);

        // 重算旧周（从旧周开始级联）
        if (oldWeekKey && oldWeekKey !== newWeekKey) {
            await this._cascadeRecalculate(oldWeekKey);
        }
        // 也重算新周（如果新周早于旧周，从新周开始级联）
        if (newWeekKey < oldWeekKey) {
            await this._cascadeRecalculate(newWeekKey);
        } else if (newWeekKey !== oldWeekKey) {
            await this._recalculateWeek(newWeekKey);
        }
    },

    // ---- Event Binding ----

    _bindEvents() {
        const c = document.getElementById('page-content');
        if (!c) return;

        // Delegated Change Events
        if (this._changeHandler) c.removeEventListener('change', this._changeHandler);
        this._changeHandler = async (e) => {
            if (e.target.id === 'tx-filter-emp') {
                this.txFilterEmp = e.target.value;
                this.render();
            } else if (e.target.id === 'tx-filter-time') {
                this.txFilterTime = e.target.value;
                this.render();
            } else if (e.target.id === 'tx-select-all') {
                const checkboxes = c.querySelectorAll('.tx-row-cb');
                checkboxes.forEach(cb => cb.checked = e.target.checked);
            } else if (e.target.classList.contains('tx-cat-select')) {
                const txId = Number(e.target.dataset.txId);
                const tx = this.transactions.find(t => t.id === txId);
                if (tx) {
                    var oldWeekKey = tx.week_key;
                    tx.category = e.target.value;
                    tx.week_key = this._autoMatchWeek(tx);
                    await DB.put('transactions', tx);
                    // 更新为税务分类后触发重算，确保税务管理界面显示最新数据
                    if (tx.week_key && tx.week_key !== '__unassigned__') {
                        await this._cascadeRecalculate(tx.week_key);
                    }
                    if (oldWeekKey && oldWeekKey !== tx.week_key && oldWeekKey !== '__unassigned__') {
                        await this._cascadeRecalculate(oldWeekKey);
                    }
                    Utils.toast('分类已更新', 'success');
                }
            }
        };
        c.addEventListener('change', this._changeHandler);

        // Remove old listeners to prevent stacking
        if (this._clickHandler) c.removeEventListener('click', this._clickHandler);

        this._clickHandler = async (e) => {
            const btn = e.target.closest('[data-action]');
            if (!btn) return;
            e.preventDefault();

            const action = btn.dataset.action;
            switch (action) {
                case 'refresh':
                    await this.render();
                    break;
                case 'add-transaction':
                    this._showAddTransactionModal();
                    break;
                case 'save-tax-config':
                    await this._saveTaxConfig();
                    break;
                case 'auto-detect':
                    await this._autoDetect();
                    break;
                case 'edit-tx':
                    this._showEditModal(Number(btn.dataset.txId));
                    break;
                case 'split-tx':
                    this._showSplitModal(Number(btn.dataset.txId));
                    break;
                case 'delete-tx':
                    await this._deleteTx(Number(btn.dataset.txId));
                    break;
                case 'bulk-edit-category':
                    await this._bulkEditCategory();
                    break;
                case 'bulk-delete-tx':
                    await this._bulkDeleteTx();
                    break;
                case 'scan-tax':
                    await this._scanAllTx();
                    break;
                case 'open-emp-tax-rates':
                    await this._openEmployeeTaxRatesModal();
                    break;
                case 'write-off-emp':
                    await this._writeOffEmployee(btn.dataset.playerId, btn.dataset.weekKey);
                    break;
                case 'cancel-writeoff':
                    await this._cancelWriteOff(btn.dataset.playerId, btn.dataset.weekKey);
                    break;
            }
        };
        c.addEventListener('click', this._clickHandler);

        // Tab switching via tabNav (uses data-tab attribute)
        if (this._tabHandler) c.removeEventListener('click', this._tabHandler);
        this._tabHandler = (e) => {
            const tabItem = e.target.closest('.tab-item[data-tab]');
            if (!tabItem) return;
            this.activeTab = tabItem.dataset.tab;
            this.render();
        };
        c.addEventListener('click', this._tabHandler);

        // Init sortable tables
        UI.initSortable('transactions-table');
        UI.initSortable('tax-table');
    },

    // ---- Actions ----

    async _saveTaxConfig() {
        const amount = Utils.parseMoneyInput(document.getElementById('cfg-weekly-tax')?.value);
        this.config.weekly_tax_amount = amount;
        try {
            await DB.put('tax_config', { key: 'weekly_tax_amount', value: amount });
        } catch (e) { /* ignore */ }
        Utils.toast('税务配置已保存', 'success');
        await this._cascadeRecalculate(this.selectedWeekKey);
    },

    // --- 员工税务销账/税率管理 ---

    async _writeOffEmployee(playerId, weekKey) {
        var records = this.employeeTaxList.filter(function(r) {
            return r.week_key === weekKey && String(r.player_id) === String(playerId);
        });
        if (records.length === 0) {
            // 创建新记录
            var emp = this.employees.find(function(e) { return String(e.player_id) === String(playerId); });
            var record = {
                week_key: weekKey,
                player_id: playerId,
                player_name: emp ? emp.name : 'Unknown',
                tax_amount: this._getEmployeeTaxRate(playerId),
                paid_amount: 0,
                is_written_off: true,
                written_off_at: Date.now(),
                calculated_at: Date.now()
            };
            await DB.put('employee_tax', record);
            this.employeeTaxList.push(record);
        } else {
            var rec = records[0];
            rec.is_written_off = true;
            rec.written_off_at = Date.now();
            rec.calculated_at = Date.now();
            await DB.put('employee_tax', rec);
        }
        Utils.toast('已标记为销账', 'success');
        this.render();
    },

    async _cancelWriteOff(playerId, weekKey) {
        var records = this.employeeTaxList.filter(function(r) {
            return r.week_key === weekKey && String(r.player_id) === String(playerId);
        });
        if (records.length > 0) {
            var rec = records[0];
            rec.is_written_off = false;
            rec.written_off_at = null;
            rec.calculated_at = Date.now();
            await DB.put('employee_tax', rec);
        }
        Utils.toast('已取消销账', 'info');
        this.render();
    },

    _openEmployeeTaxRatesModal: function() {
        var html = this._employeeTaxRatesModalHTML();
        Utils.showModal(html);

        var self = this;

        // 取消按钮
        document.getElementById('emp-tax-rates-cancel')?.addEventListener('click', function() {
            Utils.hideModal();
        });

        // 保存按钮
        document.getElementById('emp-tax-rates-save')?.addEventListener('click', async function() {
            var inputs = document.querySelectorAll('.emp-tax-rate-input');
            for (var i = 0; i < inputs.length; i++) {
                var inp = inputs[i];
                var playerId = inp.dataset.playerId;
                var rawVal = inp.value.trim();

                if (rawVal === '') {
                    // 删除个人配置，回退到全局
                    var existing = self.employeeTaxRates.find(function(r) { return String(r.player_id) === String(playerId); });
                    if (existing) {
                        await DB.delete('employee_tax_rates', playerId);
                        self.employeeTaxRates = self.employeeTaxRates.filter(function(r) { return String(r.player_id) !== String(playerId); });
                    }
                } else {
                    var val = Utils.parseMoneyInput(rawVal);
                    if (isNaN(val) || val < 0) {
                        Utils.toast('请输入有效金额', 'warning');
                        return;
                    }
                    // 获取员工名称
                    var emp = self.employees.find(function(e) { return String(e.player_id) === String(playerId); });

                    var config = self.employeeTaxRates.find(function(r) { return String(r.player_id) === String(playerId); });
                    if (config) {
                        config.tax_amount = val;
                        config.updated_at = Date.now();
                        await DB.put('employee_tax_rates', config);
                    } else {
                        var newConfig = {
                            player_id: playerId,
                            player_name: emp ? emp.name : '',
                            tax_amount: val,
                            updated_at: Date.now()
                        };
                        await DB.put('employee_tax_rates', newConfig);
                        self.employeeTaxRates.push(newConfig);
                    }
                }
            }

            // 重算当前周
            await self._recalculateWeek(self.selectedWeekKey);

            Utils.hideModal();
            Utils.toast('员工税率已保存', 'success');
            self.render();
        });

        // 应用全局税率按钮（在模态框内事件委托处理）
        var modalContent = document.getElementById('modal-content');
        if (modalContent) {
            modalContent.addEventListener('click', async function(e) {
                var applyBtn = e.target.closest('[data-action="apply-default-tax-all"]');
                if (!applyBtn) return;
                e.preventDefault();

                // 清空所有输入框
                var inputs = document.querySelectorAll('.emp-tax-rate-input');
                for (var i = 0; i < inputs.length; i++) {
                    inputs[i].value = '';
                }
            });
        }
    },

    async _deleteTx(txId) {
        if (!confirm('确定删除此交易？')) return;
        await DB.delete('transactions', txId);
        Utils.toast('交易已删除', 'info');
        await this.render();
    },

    async _bulkDeleteTx() {
        const checkboxes = document.querySelectorAll('.tx-row-cb:checked');
        if (!checkboxes.length) {
            Utils.toast('请先选中要删除的记录', 'warning');
            return;
        }
        if (!confirm(`确定要删除选中的 ${checkboxes.length} 条记录吗？`)) return;
        
        for (const cb of checkboxes) {
            const txId = Number(cb.dataset.txId);
            await DB.delete('transactions', txId);
        }
        Utils.toast(`已成功删除 ${checkboxes.length} 条记录`, 'success');
        await this.render();
    },

    async _bulkEditCategory() {
        const checkboxes = document.querySelectorAll('.tx-row-cb:checked');
        if (!checkboxes.length) {
            Utils.toast('请先选中要修改分类的记录', 'warning');
            return;
        }

        const count = checkboxes.length;
        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">批量修改分类</h3>
                <div class="text-gray-400 text-sm mb-4">已选中 <span class="text-torn-accent font-bold">${count}</span> 条记录</div>
                <div class="mb-6">
                    <label class="text-gray-400 text-sm mb-1 block">目标分类</label>
                    <select class="input" id="bulk-edit-cat">
                        <option value="train">训练 (train)</option>
                        <option value="tax">税务 (tax)</option>
                        <option value="other">其他 (other)</option>
                    </select>
                </div>
                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="bulk-edit-cancel">取消</button>
                    <button class="btn btn-primary" id="bulk-edit-save">确认修改</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('bulk-edit-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('bulk-edit-save')?.addEventListener('click', async () => {
            const newCat = document.getElementById('bulk-edit-cat')?.value || 'other';
            const taxAmount = this.config.weekly_tax_amount || 0;

            // When targeting 'tax' with a configured tax amount, detect over-amount items
            if (newCat === 'tax' && taxAmount > 0) {
                const allSelected = [];
                for (const cb of checkboxes) {
                    const txId = Number(cb.dataset.txId);
                    const tx = this.transactions.find(t => t.id === txId);
                    if (tx) allSelected.push(tx);
                }

                const overTaxItems = allSelected.filter(tx => tx.amount > taxAmount);
                const directTaxItems = allSelected.filter(tx => tx.amount <= taxAmount);

                if (overTaxItems.length > 0) {
                    Utils.hideModal();
                    this._showBulkTaxSplitModal(overTaxItems, directTaxItems, taxAmount);
                    return;
                }
            }

            // Default: directly set category for all
            let updated = 0;
            var bulkAffectedWeeks = {};
            for (const cb of checkboxes) {
                const txId = Number(cb.dataset.txId);
                const tx = this.transactions.find(t => t.id === txId);
                if (tx) {
                    tx.category = newCat;
                    tx.week_key = this._autoMatchWeek(tx);
                    await DB.put('transactions', tx);
                    if (tx.week_key && tx.week_key !== '__unassigned__') {
                        bulkAffectedWeeks[tx.week_key] = true;
                    }
                    updated++;
                }
            }
            // 对所有受影响的周进行级联重算
            var bulkSortedWeeks = Object.keys(bulkAffectedWeeks).sort();
            if (bulkSortedWeeks.length > 0) {
                await this._cascadeRecalculate(bulkSortedWeeks[0]);
            }
            Utils.toast(`已成功修改 ${updated} 条记录的分类`, 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showBulkTaxSplitModal(overTaxItems, directTaxItems, taxAmount) {
        var self = this;
        // Build rows: one per over-tax item
        const rowHTML = overTaxItems.map(tx => {
            const remaining = tx.amount - taxAmount;
            return `
                <div class="flex items-center gap-3 p-3 bg-torn-surface border border-torn-border rounded">
                    <input type="checkbox" class="split-tax-cb" data-tx-id="${tx.id}" checked />
                    <div class="flex-1 min-w-0">
                        <div class="text-white text-sm truncate">${tx.player_name || 'N/A'}</div>
                        <div class="text-gray-500 text-xs">原金额: ${Utils.formatMoney(tx.amount)}</div>
                    </div>
                    <div class="text-sm text-gray-400 whitespace-nowrap">
                        税务: <span class="text-torn-gold font-mono">${Utils.formatMoney(taxAmount)}</span>
                    </div>
                    <div class="text-sm whitespace-nowrap">
                        剩余: <span class="text-torn-green font-mono">${Utils.formatMoney(remaining)}</span>
                    </div>
                    <select class="input input-xs bg-torn-surface border border-torn-border split-remainder-cat" style="max-width:100px">
                        <option value="train">train</option>
                        <option value="other">other</option>
                    </select>
                    <input type="hidden" class="split-remainder-amount" value="${remaining}" />
                </div>
            `;
        }).join('');

        const directCount = directTaxItems.length;
        const directNote = directCount > 0
            ? `<div class="text-gray-400 text-sm mb-2">另有 <span class="text-torn-accent">${directCount}</span> 条金额 ≤ 税款的记录将直接设为"税务"</div>`
            : '';

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-2">智能拆分建议</h3>
                <div class="text-gray-400 text-sm mb-4">
                    以下 <span class="text-torn-accent font-bold">${overTaxItems.length}</span> 条记录金额超过周税设置 (${Utils.formatMoney(taxAmount)})，建议拆分为税务 + 其他分类
                </div>
                ${directNote}
                <div class="text-xs text-gray-500 mb-3">取消勾选的记录将直接设为"税务"分类（不拆分）</div>

                <div class="space-y-2 max-h-60 overflow-y-auto mb-4" id="split-tax-list">
                    ${rowHTML}
                </div>

                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="split-tax-cancel">取消</button>
                    <button class="btn btn-primary" id="split-tax-confirm">确认拆分</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('split-tax-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('split-tax-confirm')?.addEventListener('click', async () => {
            let splitCount = 0;
            let directCount = 0;

            for (const tx of overTaxItems) {
                const cb = document.querySelector(`.split-tax-cb[data-tx-id="${tx.id}"]`);
                if (cb && cb.checked) {
                    // Split: delete original, create tax + remainder records
                    const row = cb.closest('.flex.items-center.gap-3');
                    const remainingCat = row?.querySelector('.split-remainder-cat')?.value || 'train';
                    const remaining = tx.amount - taxAmount;
                    const originalLogId = tx.log_id;

                    await DB.delete('transactions', tx.id);

                    var taxPartTx = {
                        player_id: tx.player_id,
                        player_name: tx.player_name,
                        date: tx.date,
                        timestamp: tx.timestamp,
                        amount: taxAmount,
                        category: 'tax',
                        note: (tx.note ? tx.note + ' | ' : '') + `税务部分 | 拆分自 ${Utils.formatDateTime(tx.timestamp)} (${Utils.formatMoney(tx.amount)})`,
                        split_from: tx.id,
                        log_id: originalLogId
                    };
                    taxPartTx.week_key = self._autoMatchWeek(taxPartTx);
                    await DB.put('transactions', taxPartTx);

                    var remainderPartTx = {
                        player_id: tx.player_id,
                        player_name: tx.player_name,
                        date: tx.date,
                        timestamp: tx.timestamp,
                        amount: remaining,
                        category: remainingCat,
                        note: (tx.note ? tx.note + ' | ' : '') + `剩余部分 | 拆分自 ${Utils.formatDateTime(tx.timestamp)} (${Utils.formatMoney(tx.amount)})`,
                        split_from: tx.id,
                        log_id: originalLogId
                    };
                    remainderPartTx.week_key = self._autoMatchWeek(remainderPartTx);
                    await DB.put('transactions', remainderPartTx);

                    splitCount++;
                } else {
                    // Not split: directly set to tax
                    tx.category = 'tax';
                    tx.week_key = self._autoMatchWeek(tx);
                    await DB.put('transactions', tx);
                    directCount++;
                }
            }

            // Process directTaxItems (amount <= taxAmount)
            var splitAffectedWeeks = {};
            for (const tx of directTaxItems) {
                tx.category = 'tax';
                tx.week_key = self._autoMatchWeek(tx);
                await DB.put('transactions', tx);
                if (tx.week_key && tx.week_key !== '__unassigned__') {
                    splitAffectedWeeks[tx.week_key] = true;
                }
                directCount++;
            }

            // 也收集拆分的税部分的周
            for (const tx of overTaxItems) {
                var wk = self._autoMatchWeek(tx);
                if (wk && wk !== '__unassigned__') {
                    splitAffectedWeeks[wk] = true;
                }
            }

            var splitSortedWeeks = Object.keys(splitAffectedWeeks).sort();
            if (splitSortedWeeks.length > 0) {
                await self._cascadeRecalculate(splitSortedWeeks[0]);
            }

            Utils.toast(`已拆分 ${splitCount} 条, 直接设税 ${directCount} 条`, 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    // ---- Modals ----

    _showAddTransactionModal() {
        const empOptions = this.employees.map(e =>
            `<option value="${e.player_id}">${e.name}</option>`
        ).join('');

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">添加交易</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">员工</label>
                        <select class="input" id="modal-tx-emp">
                            <option value="">-- 选择员工 --</option>
                            ${empOptions}
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">金额 ($)</label>
                        <input type="text" class="input money-input" id="modal-tx-amount" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-tx-cat">
                            <option value="train">训练 (train)</option>
                            <option value="tax">税务 (tax)</option>
                            <option value="other">其他 (other)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">备注</label>
                        <textarea class="input" id="modal-tx-note" rows="2"></textarea>
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" id="modal-tx-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-tx-save">保存</button>
                    </div>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-tx-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('modal-tx-save')?.addEventListener('click', async () => {
            const empId = document.getElementById('modal-tx-emp')?.value;
            const emp = this.employees.find(e => String(e.player_id) === String(empId));
            const tx = {
                player_id: empId,
                player_name: emp?.name || '',
                date: Utils.todayKey(),
                timestamp: Date.now(),
                amount: Utils.parseMoneyInput(document.getElementById('modal-tx-amount')?.value),
                category: document.getElementById('modal-tx-cat')?.value || 'other',
                note: document.getElementById('modal-tx-note')?.value || ''
            };
            tx.week_key = this._autoMatchWeek(tx);
            await DB.put('transactions', tx);
            // 交易保存后重算对应周
            if (tx.week_key && tx.week_key !== '__unassigned__') {
                await this._cascadeRecalculate(tx.week_key);
            }
            Utils.toast('交易已保存', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showEditModal(txId) {
        const tx = this.transactions.find(t => String(t.id) === String(txId));
        if (!tx) return;

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">编辑交易</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">金额 ($)</label>
                        <input type="text" class="input money-input" id="modal-edit-amount" value="${tx.amount || 0}" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-edit-cat">
                            <option value="train" ${tx.category === 'train' ? 'selected' : ''}>训练 (train)</option>
                            <option value="tax" ${tx.category === 'tax' ? 'selected' : ''}>税务 (tax)</option>
                            <option value="other" ${tx.category === 'other' ? 'selected' : ''}>其他 (other)</option>
                        </select>
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">备注</label>
                        <textarea class="input" id="modal-edit-note" rows="2">${tx.note || ''}</textarea>
                    </div>
                    <div class="flex justify-end gap-2 mt-6">
                        <button class="btn btn-secondary" id="modal-edit-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-edit-save">保存</button>
                    </div>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-edit-cancel')?.addEventListener('click', () => Utils.hideModal());

        document.getElementById('modal-edit-save')?.addEventListener('click', async () => {
            tx.amount = Utils.parseMoneyInput(document.getElementById('modal-edit-amount')?.value);
            tx.category = document.getElementById('modal-edit-cat')?.value || 'other';
            tx.note = document.getElementById('modal-edit-note')?.value || '';
            var editOldWeekKey = tx.week_key;
            tx.week_key = this._autoMatchWeek(tx);
            await DB.put('transactions', tx);
            // 交易更新后重算新周和旧周
            if (tx.week_key && tx.week_key !== '__unassigned__') {
                await this._cascadeRecalculate(tx.week_key);
            }
            if (editOldWeekKey && editOldWeekKey !== tx.week_key && editOldWeekKey !== '__unassigned__') {
                await this._cascadeRecalculate(editOldWeekKey);
            }
            Utils.toast('交易已更新', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showSplitModal(txId) {
        const tx = this.transactions.find(t => String(t.id) === String(txId));
        if (!tx) return;

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-2">拆分交易</h3>
                <div class="text-gray-400 text-sm mb-4">原始: ${Utils.formatMoney(tx.amount)} - ${tx.player_name || 'N/A'}</div>
                <div id="split-parts" class="space-y-3 mb-4">
                    ${this._splitPartHTML(1)}
                    ${this._splitPartHTML(2)}
                </div>
                <div class="text-sm font-bold text-torn-accent mb-4" id="split-remainder">
                    剩余待分配金额: ${Utils.formatMoney(tx.amount)}
                </div>
                <button class="btn btn-xs btn-secondary mb-4" data-action="add-split-part">+ 添加部分</button>
                <div class="flex justify-end gap-2">
                    <button class="btn btn-secondary" id="modal-split-cancel">取消</button>
                    <button class="btn btn-primary" id="modal-split-save">拆分</button>
                </div>
            </div>
        `;

        Utils.showModal(html);

        document.getElementById('modal-split-cancel')?.addEventListener('click', () => Utils.hideModal());

        // Add split part
        const modalContent = document.getElementById('modal-content');
        modalContent?.querySelector('[data-action="add-split-part"]')?.addEventListener('click', () => {
            const parts = document.getElementById('split-parts');
            if (!parts) return;
            const count = parts.querySelectorAll('.split-amount').length + 1;
            parts.insertAdjacentHTML('beforeend', this._splitPartHTML(count));
        });

        // Add input listener for remainder calculation
        document.getElementById('split-parts')?.addEventListener('input', (e) => {
            if (e.target.classList.contains('split-amount')) {
                const amounts = [...document.querySelectorAll('.split-amount')].map(el => Utils.parseMoneyInput(el.value));
                const total = amounts.reduce((s, a) => s + a, 0);
                const remainder = tx.amount - total;
                const remEl = document.getElementById('split-remainder');
                if (remEl) {
                    const color = remainder < 0 ? 'text-red-500' : 'text-torn-green';
                    remEl.innerHTML = `剩余待分配金额: <span class="${color}">${Utils.formatMoney(remainder)}</span>`;
                }
            }
        });

        // Add click listener for fill remainder buttons
        document.getElementById('split-parts')?.addEventListener('click', (e) => {
            if (e.target.classList.contains('split-fill-rem')) {
                e.preventDefault();
                const amounts = [...document.querySelectorAll('.split-amount')].map(el => Utils.parseMoneyInput(el.value));
                const total = amounts.reduce((s, a) => s + a, 0);
                const remainder = tx.amount - total;
                if (remainder > 0) {
                    const input = e.target.closest('.flex-1').querySelector('.split-amount');
                    if (input) {
                        const curVal = Utils.parseMoneyInput(input.value);
                        input.value = Utils.formatMoney(curVal + remainder).replace('$', '');
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                }
            }
        });

        // Save split
        document.getElementById('modal-split-save')?.addEventListener('click', async () => {
            const amounts = [...document.querySelectorAll('.split-amount')].map(el => Utils.parseMoneyInput(el.value));
            const cats = [...document.querySelectorAll('.split-cat')].map(el => el.value);
            const notes = [...document.querySelectorAll('.split-note')].map(el => el.value);

            const total = amounts.reduce((s, a) => s + a, 0);
            if (total > tx.amount + 1) {
                Utils.toast('拆分金额超过原始金额', 'error');
                return;
            }
            if (total < tx.amount) {
                Utils.toast('拆分不完整，存在未分配的余额', 'error');
                return;
            }

            // 🔍 DIAGNOSTIC LOG: 拆分 timestamp 对比
            console.log('[SPLIT-DEBUG] 原始交易:', {
                id: tx.id,
                date: tx.date,
                timestamp: tx.timestamp,
                tsAsDate: new Date(tx.timestamp >= 1e12 ? tx.timestamp : tx.timestamp * 1000).toISOString(),
                week_key: tx.week_key
            });

            // Delete original
            const originalLogId = tx.log_id;
            var splitOldWeekKey = tx.week_key;
            await DB.delete('transactions', tx.id);

            // Add split parts — 使用原始 timestamp 而非 Date.now()
            for (let i = 0; i < amounts.length; i++) {
                if (amounts[i] > 0) {
                    var partTx = {
                        player_id: tx.player_id,
                        player_name: tx.player_name,
                        date: tx.date,
                        timestamp: tx.timestamp,
                        amount: amounts[i],
                        category: cats[i] || 'other',
                        note: notes[i] || `拆分自 ${Utils.formatDateTime(tx.timestamp)} (${Utils.formatMoney(tx.amount)})`,
                        split_from: tx.id,
                        log_id: originalLogId
                    };
                    partTx.week_key = this._autoMatchWeek(partTx);
                    console.log('[SPLIT-DEBUG] 拆分部分', i, ':', {
                        amount: amounts[i],
                        date: partTx.date,
                        timestamp: partTx.timestamp,
                        week_key: partTx.week_key
                    });
                    await DB.put('transactions', partTx);
                }
            }

            // 重算对应的周（拆分后的税务部分需要更新 tax_weeks）
            if (splitOldWeekKey && splitOldWeekKey !== '__unassigned__') {
                await this._cascadeRecalculate(splitOldWeekKey);
            }

            Utils.toast('交易已拆分', 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _splitPartHTML(index, amount = '') {
        return `
            <div class="flex gap-2 items-end">
                <div class="flex-1">
                    <div class="flex justify-between items-center mb-1">
                        <label class="text-gray-400 text-xs block">部分${index} 金额</label>
                        <a href="#" class="text-torn-accent text-xs hover:underline split-fill-rem" tabindex="-1">填入余额</a>
                    </div>
                    <input type="text" class="input input-sm split-amount money-input" placeholder="支持 k/m/b" value="${amount}" />
                </div>
                <div class="flex-1">
                    <label class="text-gray-400 text-xs block">分类</label>
                    <select class="input input-sm split-cat">
                        <option value="train">train</option>
                        <option value="tax">tax</option>
                        <option value="other">other</option>
                    </select>
                </div>
                <div class="flex-1">
                    <label class="text-gray-400 text-xs block">备注</label>
                    <input type="text" class="input input-sm split-note" />
                </div>
            </div>
        `;
    },

    _parseItemsFromData(d) {
        const results = [];
        const cache = this.itemNameCache || {};

        const itemEntries = [];
        if (Array.isArray(d.item)) itemEntries.push(...d.item);
        if (Array.isArray(d.items)) itemEntries.push(...d.items);

        for (const it of itemEntries) {
            const entry = cache[it.id];
            const name = entry ? entry.name : `物品#${it.id}`;
            const qty = it.qty || it.quantity || 1;
            results.push(qty > 1 ? `${name} x${qty}` : name);
        }

        if (typeof d.item === 'number') {
            const entry = cache[d.item];
            const name = entry ? entry.name : `物品#${d.item}`;
            const qty = d.quantity || 1;
            results.push(qty > 1 ? `${name} x${qty}` : name);
        }

        return results;
    },

    // Calculate total monetary value of items in log data
    _calculateItemsValue(d) {
        let total = 0;
        const cache = this.itemNameCache || {};

        const itemEntries = [];
        if (Array.isArray(d.item)) itemEntries.push(...d.item);
        if (Array.isArray(d.items)) itemEntries.push(...d.items);

        for (const it of itemEntries) {
            const entry = cache[it.id];
            if (entry && entry.value) {
                const qty = it.qty || it.quantity || 1;
                total += entry.value * qty;
            }
        }

        if (typeof d.item === 'number') {
            const entry = cache[d.item];
            if (entry && entry.value) {
                const qty = d.quantity || 1;
                total += entry.value * qty;
            }
        }

        return total;
    },

    _calculateItemsValueFromList(items) {
        let total = 0;
        const cache = this.itemNameCache || {};
        for (const it of items) {
            const entry = cache[it.id];
            if (entry && entry.value) {
                total += entry.value * (it.qty || 1);
            }
        }
        return total;
    },

    // Fetch and cache all Torn item names (id -> name)
    // Loads from bundled static file first, only calls API for missing IDs
    async _loadItemNames() {
        if (Object.keys(this.itemNameCache).length > 0) return;
        try {
            // Load bundled static item names
            const url = chrome.runtime.getURL('data/item_names.json');
            const resp = await fetch(url);
            const data = await resp.json();
            this.itemNameCache = data;
            console.log(`[FinancePage] Loaded ${Object.keys(this.itemNameCache).length} item names from static file`);
        } catch (e) {
            console.warn('[FinancePage] Failed to load static item names, falling back to API:', e);
            try {
                const data = await TornAPI.v1('items', 'torn');
                if (data && data.items) {
                    for (const [id, info] of Object.entries(data.items)) {
                        this.itemNameCache[id] = { name: info.name, value: info.market_value || 0 };
                    }
                }
            } catch (e2) {
                console.warn('[FinancePage] API fallback also failed:', e2);
            }
        }
    },

    // Look up a single item name, fetch from API if not in cache
    async _getItemName(itemId) {
        const id = String(itemId);
        if (this.itemNameCache[id]) return this.itemNameCache[id].name;
        // Not in cache, try API for this single item
        try {
            const data = await TornAPI.v1('items', 'torn');
            if (data && data.items) {
                for (const [k, info] of Object.entries(data.items)) {
                    this.itemNameCache[k] = { name: info.name, value: info.market_value || 0 };
                }
            }
        } catch (e) { /* ignore */ }
        return this.itemNameCache[id] ? this.itemNameCache[id].name : `物品#${id}`;
    },

    async _autoDetect() {
        Utils.showLoading('加载物品数据...');
        await this._loadItemNames();
        Utils.showLoading('获取交易日志...');
        try {
            const existingLogIds = new Set(this.transactions.map(t => String(t.log_id)).filter(id => id && id !== 'undefined'));
            const allRelevant = [];

            const currentEmployeeIds = new Set(this.employees.map(e => String(e.player_id)));

            // V2 log batches - each batch max 10 log type IDs
            const batches = [
                '4800,4810,4815,4820,6284',           // money + company deposit
                '4100,4101,4102,4103,4104,4105,4120,4121,4122,4123', // items
                '4400,4401,4406,4410,4420,4430,4431,4440,4441,4445', // trades 1 (added 4420: Trade expire)
                '4446,4447,4448,4449,4450,4451,4452,4480,4482'      // trades 2
            ];

            for (const batch of batches) {
                try {
                    const logData = await TornAPI.getUserLogByTypes(batch);
                    if (!logData || !logData.log || !logData.log.length) continue;

                    for (const entry of logData.log) {
                        const logId = entry.id;
                        if (!logId || existingLogIds.has(logId)) continue;

                        const logType = entry.details?.id || 0;
                        const isTrade = logType >= 4400 && logType <= 4499;

                        // Extract player ID from data
                        const d = entry.data || {};
                        // V2 logs can use user, sender, receiver, or even target in some cases
                        const empId = d.user || d.sender || d.receiver || d.target || 0;
                        const empIdStr = String(empId);

                        // Only include logs related to current employees
                        if (empIdStr !== '0' && currentEmployeeIds.has(empIdStr)) {
                            const emp = this.employees.find(e => String(e.player_id) === empIdStr);
                            allRelevant.push({
                                log_id: logId,
                                entry: entry,
                                empName: emp ? emp.name : '员工',
                                empId: empId,
                                isTrade: isTrade
                            });
                        }
                    }
                } catch (e) {
                    console.warn('[FinancePage] V2 log batch failed:', e);
                }
            }

            Utils.hideLoading();

            // Deduplicate trades
            const deduped = this._deduplicateTrades(allRelevant);

            if (!deduped.length) {
                Utils.toast('未找到新的相关日志条目', 'info');
                return;
            }

            deduped.forEach((item, idx) => item.idx = idx);
            this.adLogs = deduped;
            this.adFilterEmp = '';
            this.adFilterTime = 'week';

            const html = `
                <div class="p-6">
                    <h3 class="text-lg font-bold text-white mb-4">自动检测往来记录</h3>

                    <div class="flex items-center gap-2 mb-4 bg-torn-surface p-2 rounded border border-torn-border overflow-x-auto hide-scrollbar">
                        <select id="modal-ad-filter-time" class="input input-sm shrink-0 truncate" style="max-width: 90px;">
                            <option value="week">本周</option>
                            <option value="month">本月</option>
                            <option value="all">全部时间</option>
                        </select>
                        <select id="modal-ad-filter-emp" class="input input-sm shrink-0 truncate" style="max-width: 120px;">
                            <option value="">全部员工</option>
                            ${this.employees.map(e => `<option value="${e.player_id}">${e.name}</option>`).join('')}
                        </select>
                        <div class="flex items-center gap-2 ml-auto mr-2 whitespace-nowrap shrink-0">
                            <input type="checkbox" id="modal-ad-select-all" class="cursor-pointer" checked />
                            <label for="modal-ad-select-all" class="text-sm text-gray-300 cursor-pointer">全选</label>
                        </div>
                    </div>

                    <div id="modal-ad-list" class="space-y-2 max-h-64 overflow-y-auto mb-4"></div>

                    <div class="flex justify-end gap-2">
                        <button class="btn btn-secondary" id="modal-ad-cancel">取消</button>
                        <button class="btn btn-primary" id="modal-import-btn">导入选中</button>
                    </div>
                </div>
            `;

            Utils.showModal(html);
            this._renderAutoDetectList();

            document.getElementById('modal-ad-filter-time')?.addEventListener('change', (e) => {
                this.adFilterTime = e.target.value;
                this._renderAutoDetectList();
            });

            document.getElementById('modal-ad-filter-emp')?.addEventListener('change', (e) => {
                this.adFilterEmp = e.target.value;
                this._renderAutoDetectList();
            });

            document.getElementById('modal-ad-select-all')?.addEventListener('change', (e) => {
                const checkboxes = document.querySelectorAll('.log-entry-cb');
                checkboxes.forEach(cb => cb.checked = e.target.checked);
            });

            document.getElementById('modal-ad-cancel')?.addEventListener('click', () => Utils.hideModal());

            document.getElementById('modal-import-btn')?.addEventListener('click', async () => {
                const checked = [...document.querySelectorAll('.log-entry-cb:checked')];
                for (const cb of checked) {
                    const idx = parseInt(cb.dataset.idx);
                    const item = this.adLogs[idx];
                    if (!item) continue;

                    const entry = item.entry;
                    const d = entry.data || {};

                    // Handle synthetic trade entries (aggregated from multiple steps)
                    let cashAmount, absAmount, note;
                    if (entry._finalMoney !== undefined || entry._finalItems) {
                        cashAmount = entry._finalMoney || 0;
                        const tradeItems = entry._finalItems || [];
                        const itemsValue = this._calculateItemsValueFromList(tradeItems);
                        absAmount = Math.abs(cashAmount) || itemsValue;
                        const tradeId = entry._tradeId || '';
                        const itemDescs = tradeItems.map(it => {
                            const name = this.itemNameCache[it.id]?.name || `物品#${it.id}`;
                            return it.qty > 1 ? `${name} x${it.qty}` : name;
                        });
                        note = `交易 #${tradeId}${absAmount > 0 ? ' (' + Utils.formatMoney(absAmount) + (itemDescs.length ? ', ' + itemDescs.join(', ') : '') + ')' : ''}`;
                    } else {
                        // Regular V2 log entry
                        cashAmount = Math.abs(d.money || d.amount || d.cost || d.value || d.withdrawn || 0);
                        const itemsValue = this._calculateItemsValue(d);
                        absAmount = cashAmount || itemsValue;
                        const parts = [];
                        if (cashAmount) parts.push(Utils.formatMoney(cashAmount));
                        const itemDescs = this._parseItemsFromData(d);
                        parts.push(...itemDescs);
                        const title = entry.details?.title || '自动检测';
                        note = title + (parts.length ? ` (${parts.join(', ')})` : '');
                    }

                    let cat = 'other';
                    if (absAmount > 0 && absAmount === Number(this.config.weekly_tax_amount)) {
                        cat = 'tax';
                        note += ' (自动匹配税费)';
                    }

                    let ts = entry.timestamp || Date.now();
                    if (ts < 100000000000) ts *= 1000;
                    const txDate = new Date(ts).toISOString().slice(0, 10);

                    var tx = {
                        log_id: item.log_id,
                        player_id: item.empId,
                        player_name: item.empName,
                        date: txDate,
                        timestamp: ts,
                        amount: absAmount,
                        category: cat,
                        note: note
                    };
                    tx.week_key = this._autoMatchWeek(tx);

                    // 🔍 DIAGNOSTIC: 自动检测导入时间戳验证
                    console.log('[AUTO-DETECT-IMPORT]', {
                        log_id: item.log_id,
                        isTrade: item.isTrade,
                        hasItems: !!(entry._finalItems && entry._finalItems.length),
                        entryTimestamp: entry.timestamp,
                        entryTimestampType: typeof entry.timestamp,
                        tsAfterConversion: ts,
                        tsAsDate: new Date(ts).toISOString(),
                        txDate: txDate,
                        txTimestamp: tx.timestamp,
                        week_key: tx.week_key,
                        category: cat,
                        amount: absAmount
                    });

                    await DB.put('transactions', tx);
                }
                // 重新加载交易数据（导入后 DB 已更新，但内存数组未同步）
                this.transactions = await DB.getAll('transactions') || [];
                // 收集所有受影响的周，级联重算 tax_weeks
                var affectedWeeks = {};
                for (const cb of checked) {
                    const idx = parseInt(cb.dataset.idx);
                    const item = this.adLogs[idx];
                    if (!item) continue;
                    var ts2 = item.entry.timestamp || Date.now();
                    if (ts2 < 100000000000) ts2 *= 1000;
                    var wk = Utils.weekKey(new Date(ts2));
                    if (wk && wk !== '__unassigned__') affectedWeeks[wk] = true;
                }
                var sortedWeeks = Object.keys(affectedWeeks).sort();
                for (var w = 0; w < sortedWeeks.length; w++) {
                    await this._ensureWeekExists(sortedWeeks[w]);
                }
                if (sortedWeeks.length > 0) {
                    await this._cascadeRecalculate(sortedWeeks[0]);
                }
                // 重新从 DB 加载以确保 tax_weeks 是最新的
                this.taxWeeks = await DB.getAll('tax_weeks') || [];
                this.taxCarryovers = await DB.getAll('tax_carryover') || [];
                Utils.toast(`已导入 ${checked.length} 条交易`, 'success');
                Utils.hideModal();
                await this.render();
            });
        } catch (e) {
            Utils.hideLoading();
            Utils.toast(`获取日志失败: ${e.message}`, 'error');
        }
    },

    _deduplicateTrades(allRelevant) {
        const tradeEntries = [];
        const nonTrade = [];

        for (const item of allRelevant) {
            if (item.isTrade) {
                tradeEntries.push(item);
            } else {
                nonTrade.push(item);
            }
        }

        // Group trade entries by trade ID
        const byTradeId = {};
        for (const item of tradeEntries) {
            // Try both parsed_trade_id and trade_id
            let tradeId = item.entry?.data?.parsed_trade_id || item.entry?.data?.trade_id;
            // If trade_id is a string with HTML (common in some API responses), extract the numeric ID
            if (typeof tradeId === 'string' && tradeId.includes('ID=')) {
                const match = tradeId.match(/ID=(\d+)/);
                if (match) tradeId = match[1];
            }

            if (!tradeId) {
                // Skip orphaned trade logs that don't have a trade ID
                continue;
            }
            if (!byTradeId[tradeId]) byTradeId[tradeId] = [];
            byTradeId[tradeId].push(item);
        }

        const dedupedTrade = [];
        for (const [tradeId, steps] of Object.entries(byTradeId)) {
            steps.sort((a, b) => (a.entry.timestamp || 0) - (b.entry.timestamp || 0));

            // Only include completed trades: must have 'total' field AND not expired/cancelled
            const hasTotal = steps.some(s => s.entry?.data?.total !== undefined);
            if (!hasTotal) continue;

            // Skip trades that ended in expire (4420) or cancel (4410)
            const isExpiredOrCancelled = steps.some(s => {
                const logType = s.entry?.details?.id || 0;
                return logType === 4410 || logType === 4420;
            });
            if (isExpiredOrCancelled) continue;

            // Aggregate money and items from all steps
            let totalMoney = 0;
            const allItems = [];
            const traderUser = steps[0]?.entry?.data?.user || 0;

            for (const step of steps) {
                const d = step.entry?.data || {};
                if (d.money) totalMoney += d.money;
                if (d.items) allItems.push(...d.items);
            }

            // Merge duplicate items
            const merged = {};
            for (const it of allItems) {
                const k = `${it.id}_${it.uid || ''}`;
                merged[k] = merged[k] ? { ...merged[k], qty: merged[k].qty + it.qty } : { ...it };
            }

            dedupedTrade.push({
                log_id: `trade_final_${tradeId}`,
                entry: {
                    ...steps[steps.length - 1].entry,
                    _tradeId: tradeId,
                    _finalMoney: totalMoney,
                    _finalItems: Object.values(merged)
                },
                empName: this.employees.find(e => String(e.player_id) === String(traderUser))?.name || '交易对方',
                empId: traderUser,
                isTrade: true
            });
        }

        return [...nonTrade, ...dedupedTrade];
    },

    _renderAutoDetectList() {
        const listContainer = document.getElementById('modal-ad-list');
        if (!listContainer) return;

        let filtered = this.adLogs;

        if (this.adFilterEmp) {
            filtered = filtered.filter(item => String(item.empId) === this.adFilterEmp);
        }

        const now = new Date();
        if (this.adFilterTime === 'week') {
            const startOfWeek = new Date(now);
            startOfWeek.setDate(now.getDate() - (now.getDay() || 7) + 1);
            startOfWeek.setHours(0, 0, 0, 0);
            filtered = filtered.filter(item => (item.entry.timestamp || 0) >= startOfWeek.getTime() / 1000);
        } else if (this.adFilterTime === 'month') {
            const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
            filtered = filtered.filter(item => (item.entry.timestamp || 0) >= startOfMonth.getTime() / 1000);
        }

        if (!filtered.length) {
            listContainer.innerHTML = '<div class="text-gray-500 text-sm p-4 text-center">暂无符合条件的记录</div>';
            return;
        }

        const getDetails = (entry) => {
            const d = entry.data || {};
            const money = Math.abs(d.money || d.cost || d.amount || d.value || 0);
            const itemsValue = this._calculateItemsValue(d);
            
            let parts = [];
            if (money) parts.push(`${Utils.formatMoney(money)}`);
            if (itemsValue && !money) parts.push(`价值 ${Utils.formatMoney(itemsValue)}`);
            
            // Parse items from all possible API formats
            const itemDescriptions = this._parseItemsFromData(d);
            parts.push(...itemDescriptions);
            
            return parts.length ? `<span class="text-torn-green ml-2 font-mono font-bold">${parts.join(', ')}</span>` : '';
        };

        listContainer.innerHTML = filtered.map(item => `
            <label class="flex items-center gap-3 p-2 rounded hover:bg-torn-surface cursor-pointer">
                <input type="checkbox" class="log-entry-cb" data-idx="${item.idx}" checked />
                <div class="flex-1">
                    <div class="text-white text-sm">
                        <span class="text-torn-gold mr-1">[${item.empName}]</span>${item.isTrade ? 'Trade' : (item.entry.title || item.entry.details?.title || '日志条目')}${getDetails(item.entry)}
                    </div>
                    <div class="text-gray-500 text-xs">${Utils.formatDateTime(item.entry.timestamp)}</div>
                </div>
            </label>
        `).join('');

        const selectAllCb = document.getElementById('modal-ad-select-all');
        if (selectAllCb) selectAllCb.checked = true;
    }
};

// Global real-time conversion for money inputs (k, m, b)
document.body.addEventListener('input', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('money-input')) {
        const val = e.target.value.toLowerCase().trim();
        if (val.endsWith('k') || val.endsWith('m') || val.endsWith('b')) {
            const parsed = Utils.parseMoneyInput(val);
            if (parsed && !isNaN(parsed)) {
                e.target.value = parsed.toLocaleString('en-US');
            }
        }
    }
});
