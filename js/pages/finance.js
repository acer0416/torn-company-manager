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
    selectedMonthKey: '',
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

    // State for train fund allocation tab
    _trainFundAllocations: [],
    _trainFundTabActive: false,

    async init() {
        await this._loadData();
        // 初始化周选择器和月选择器状态
        this.selectedWeekKey = Utils.weekKey(); // 默认为当前周
        const now = new Date();
        this.selectedMonthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
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
        this._stockHistory = (await DB.getAll('stock_history')) || [];
        this._snapshots = (await DB.getAll('snapshots')) || [];

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

        const apiIds = new Set();
        for (const emp of (apiEmployees || [])) {
            const pid = Number(emp.id || emp.player_id);
            if (!pid) continue;
            apiIds.add(pid);
            if (masterMap.has(pid)) {
                // 更新活跃员工的最新信息
                const existing = masterMap.get(pid);
                existing.name = emp.name || existing.name;
                existing.position = emp.position?.name || emp.position || existing.position;
                existing.status = emp.status || existing.status;
                existing.effectiveness = emp.effectiveness || existing.effectiveness;
                existing.player_id = pid; // 确保 player_id 为 Number 类型
                // 确保 left_date 为空，因为他们还在 API 列表里
                existing.left_date = null;
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

        // 标记在 employees_master 中但不在 API 列表中的员工为离职
        let needSyncMaster = false;
        if (apiEmployees && apiEmployees.length > 0) {
            for (const emp of this.employees) {
                if (!apiIds.has(Number(emp.player_id)) && !emp.left_date) {
                    emp.left_date = Utils.todayKey();
                    needSyncMaster = true;
                }
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
                const detail = await AppCache.getOrFetch('companyDetailed', () => TornAPI.v1('profile,detailed'));
                if (detail?.company_detailed || detail?.company) {
                    this.latestSnapshot = {
                        profile: detail.company || {},
                        detailed: detail.company_detailed || {}
                    };
                }
            } catch (e) {
                console.warn('[FinancePage] Failed to fetch company detailed:', e);
            }
        }

        try {
            this._overviewStock = await AppCache.getOrFetch('stock', () => TornAPI.getStockUnified());
        } catch (e) {
            this._overviewStock = [];
        }

        // Load configurations for daily projections of Boost, Tax, and Training
        try {
            this._boostSellers = await DB.getAll('boost_sellers') || [];
        } catch (e) {
            this._boostSellers = [];
        }

        try {
            const freeTrainsCfg = await DB.get('training_config', 'weekly_free_trains');
            const priceCfg = await DB.get('training_config', 'train_price');
            const availCfg = await DB.get('training_config', 'weekly_available_trains');

            const freeTrains = freeTrainsCfg?.value ?? 0;
            const trainPrice = priceCfg?.value ?? DEFAULT_TRAIN_PRICE;
            const availTrains = availCfg?.value ?? 0;

            const activeCount = (this.employees || []).filter(e => !e.left_date).length;
            const totalFreeTrains = freeTrains * activeCount;
            const sellableCount = Math.max(0, availTrains - totalFreeTrains);
            this._projDailyTrain = (sellableCount * trainPrice) / 7;
        } catch (e) {
            this._projDailyTrain = 0;
        }
    },

    // ========== 周税务状态层函数 ==========

    _getWeeklyActiveEmployees: function(weekKey) {
        var range = Utils.weekDateRange(weekKey);
        var formatDateStr = function(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        };
        var weekStartStr = formatDateStr(range.start);
        var weekEndStr = formatDateStr(range.end);
        
        return (this.employees || []).filter(function(emp) {
            var firstSeen = emp.first_seen || '1970-01-01';
            var leftDate = emp.left_date || '9999-12-31';
            return firstSeen <= weekEndStr && leftDate >= weekStartStr;
        });
    },

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
        var activeEmployees = this._getWeeklyActiveEmployees(weekKey);
        var employeeCount = activeEmployees.length;
        
        // 计算应缴税额
        var taxDue = 0;
        if (this.config && this.config.weekly_tax_enabled) {
            var range = Utils.weekDateRange(weekKey);
            var formatDateStr = function(d) {
                return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            };
            var weekEndStr = formatDateStr(range.end);

            for (var i = 0; i < activeEmployees.length; i++) {
                var emp = activeEmployees[i];
                // 如果员工已离职，不计入应缴税额中
                if (emp.left_date && emp.left_date <= weekEndStr) {
                    continue;
                }
                taxDue += this._getEmployeeTaxRate(emp.player_id);
            }
        }
        
        // 获取结转转入（从 tax_carryover 计算）
        var carryoverIn = this.taxCarryovers
            .filter(function(c) { return c.to_week_key === weekKey && !c.deleted; })
            .reduce(function(sum, c) { return sum + (Number(c.amount) || 0); }, 0);
        
        // 计算净应缴和当前余额
        var netDue = Math.max(0, taxDue - carryoverIn);
        var balance = taxPaid - netDue;
        
        // 计算结转输出（超额部分自动结转至下周）
        // 注意：实际 carryoverOut 将在后续按员工计算 perEmployeeSurplus 后汇总得出
        var carryoverOut = 0;
        
        // 写入 tax_weeks（周状态在员工明细生成后按每人缴纳情况更新）
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
            status: 'current',
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
        var empList = this._getWeeklyActiveEmployees(weekKey);

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

        var range = Utils.weekDateRange(weekKey);
        var formatDateStr = function(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        };
        var weekStartStr = formatDateStr(range.start);
        var weekEndStr = formatDateStr(range.end);

        // 强硬隔离：过滤掉早在本周之前就已经离职的员工（即使有历史结转，也强制截断不显示）
        var allIdsArr = Array.from(allEmployeeIds).filter(function(pid) {
            var emp = self.employees.find(function(em) { return String(em.player_id) === String(pid); });
            if (emp && emp.left_date && emp.left_date < weekStartStr) {
                return false;
            }
            return true;
        });
        var writtenOffMap = {};
        for (var e = 0; e < allIdsArr.length; e++) {
            var playerId = allIdsArr[e];
            var emp = empList.find(function(em) { return String(em.player_id) === playerId; });
            var allEmp = self.employees.find(function(em) { return String(em.player_id) === playerId; });
            var name = emp ? emp.name : (allEmp ? allEmp.name : (paidByEmployee[playerId] ? paidByEmployee[playerId].name : 'Unknown'));
            var paid = paidByEmployee[playerId] ? paidByEmployee[playerId].paid : 0;

            // 检查是否有旧的记录需要保留状态（销账、手动指定的应缴税）
            var oldRec = null;
            for (var or = 0; or < oldRecords.length; or++) {
                if (String(oldRecords[or].player_id) === playerId) {
                    oldRec = oldRecords[or];
                    break;
                }
            }

            var taxAmount;
            if (oldRec && oldRec.is_manual_tax) {
                taxAmount = oldRec.tax_amount;
            } else {
                var isResigned = allEmp && allEmp.left_date && allEmp.left_date <= weekEndStr;
                taxAmount = (emp && !isResigned) ? self._getEmployeeTaxRate(playerId) : 0;
            }

            var isWrittenOff = oldRec ? oldRec.is_written_off : false;
            var writtenOffAt = oldRec ? oldRec.written_off_at : null;

            // 如果曾因欠费销账，但后来实缴超过了应缴，自动取消销账；如果是盈余销账，则保留销账状态
            var finalWrittenOff = isWrittenOff && (taxAmount > 0 && paid >= taxAmount) ? false : isWrittenOff;
            writtenOffMap[playerId] = finalWrittenOff;

            await DB.put('employee_tax', {
                week_key: weekKey,
                player_id: playerId,
                player_name: name,
                tax_amount: taxAmount,
                paid_amount: paid,
                is_written_off: finalWrittenOff,
                written_off_at: finalWrittenOff ? writtenOffAt : null,
                is_manual_tax: oldRec ? !!oldRec.is_manual_tax : false,
                calculated_at: Date.now()
            });
        }

        // --- 构建 per_employee_surplus 并创建/更新自动结转记录 ---
        var perEmployeeSurplus = {};
        var allIdsArr2 = allIdsArr;
        for (var es = 0; es < allIdsArr2.length; es++) {
            var spid = allIdsArr2[es];
            var spaid = paidByEmployee[spid] ? paidByEmployee[spid].paid : 0;
            var sEmp = empList.find(function(em) { return String(em.player_id) === String(spid); });
            var sTaxAmount = sEmp ? self._getEmployeeTaxRate(spid) : 0;
            
            // 如果已经被销账，则不再产生结转转出！
            if (writtenOffMap[spid]) {
                continue;
            }

            var surplus = Math.max(0, spaid - sTaxAmount);
            if (surplus > 0) {
                perEmployeeSurplus[spid] = surplus;
                carryoverOut += surplus;
            }
        }

        // 更新 weekRecord 的 carryover_out
        weekRecord.carryover_out = carryoverOut;

        if (carryoverOut > 0 && weekKey !== Utils.weekKey()) {
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

        weekRecord.status = self._computeWeekTaxStatusFromEmployees(weekKey);
        await DB.put('tax_weeks', weekRecord);
        var weekIdx = self.taxWeeks.findIndex(function(w) { return w.week_key === weekKey; });
        if (weekIdx >= 0) self.taxWeeks[weekIdx] = weekRecord;

        return weekRecord;
    },

    /** 周税务状态：按每位在职员工是否缴清（含销账），而非总额对比 */
    _computeWeekTaxStatusFromEmployees: function(weekKey) {
        if (!this.config || !this.config.weekly_tax_enabled) return 'current';

        var records = (this.employeeTaxList || []).filter(function(r) {
            return r.week_key === weekKey;
        });
        var activeEmployees = this._getWeeklyActiveEmployees(weekKey);

        var range = Utils.weekDateRange(weekKey);
        var formatDateStr = function(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        };
        var weekEndStr = formatDateStr(range.end);

        var needPay = 0;
        var resolved = 0;

        for (var i = 0; i < activeEmployees.length; i++) {
            var emp = activeEmployees[i];
            var pid = String(emp.player_id);
            var row = records.find(function(r) { return String(r.player_id) === pid; });
            var taxAmt = row != null ? Number(row.tax_amount) : (emp.left_date && emp.left_date <= weekEndStr ? 0 : this._getEmployeeTaxRate(pid));
            if (taxAmt <= 0) continue;
            needPay++;
            var paidAmt = row ? Number(row.paid_amount) || 0 : 0;
            var writtenOff = row && row.is_written_off === true;
            if (writtenOff || paidAmt >= taxAmt) resolved++;
        }

        if (needPay === 0) return 'paid';
        if (resolved >= needPay) return 'paid';
        if (weekKey < Utils.weekKey()) return 'overdue';
        return 'current';
    },

    _refreshWeekTaxStatus: async function(weekKey) {
        var weekRecord = this.taxWeeks.find(function(w) { return w.week_key === weekKey; });
        if (!weekRecord) return;
        weekRecord.status = this._computeWeekTaxStatusFromEmployees(weekKey);
        await DB.put('tax_weeks', weekRecord);
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

    // 根据实际页面大小获取最适合并排显示的周数量
    _getOptimalWeekCount: function() {
        var w = window.innerWidth;
        if (w < 850) return 3;
        if (w < 1050) return 4;
        if (w < 1250) return 5;
        if (w < 1450) return 6;
        return 7;
    },

    // 获取从最早的有记录周到当前周的连续周 Key 列表
    _getContinuousWeekKeys: function() {
        var knownKeys = this._getAllWeekKeys();
        var currentWeek = Utils.weekKey();
        if (knownKeys.length === 0) {
            return [currentWeek];
        }
        var startWeek = knownKeys[0];
        var keys = [];
        var tempWeek = startWeek;
        var maxSafety = 156; // 安全阈值，最多 3 年
        while (tempWeek <= currentWeek && maxSafety > 0) {
            keys.push(tempWeek);
            tempWeek = Utils.weekKeyAdd(tempWeek, 1);
            maxSafety--;
        }
        if (!keys.includes(currentWeek)) {
            keys.push(currentWeek);
        }
        return keys.sort();
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
                // force=false: 不忽略已有 week_key，保留手动分配
                var newWeekKey = this._autoMatchWeek(tx, false);
                
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

            // 为了确保存量数据的结转 (carryover) 全部更新员工明细，收集所有的历史税务周
            var allKnownWeeks = new Set(Object.keys(affectedWeeks));
            for (var t = 0; t < allTxs.length; t++) {
                if (this._isTaxTx(allTxs[t]) && allTxs[t].week_key && allTxs[t].week_key !== '__unassigned__') {
                    allKnownWeeks.add(allTxs[t].week_key);
                }
            }

            // 对受影响周排序，初始化并级联重算
            var sortedWeeks = Array.from(allKnownWeeks).sort();
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

        var range = Utils.weekDateRange(weekKey);
        var formatDateStr = function(d) {
            return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        };
        var weekEndStr = formatDateStr(range.end);

        // 获取当前周员工税务记录
        var empTaxRecords = this.employeeTaxList.filter(function(r) {
            return r.week_key === weekKey;
        });

        // 也纳入有交易的但可能不在 employeeTaxList 中的活跃员工
        var activeEmployees = this._getWeeklyActiveEmployees(weekKey);
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
                var isResigned = emp.left_date && emp.left_date <= weekEndStr;
                displayedRecords.push({
                    week_key: weekKey,
                    player_id: pid,
                    player_name: emp.name || 'Unknown',
                    tax_amount: isResigned ? 0 : self._getEmployeeTaxRate(pid),
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

        // 先按是否在职排序（在职优先，离职排最后），然后按名称排序
        displayedRecords.sort(function(a, b) {
            var empA = self.employees.find(function(e) { return String(e.player_id) === String(a.player_id); });
            var empB = self.employees.find(function(e) { return String(e.player_id) === String(b.player_id); });
            var activeA = empA ? !empA.left_date : true;
            var activeB = empB ? !empB.left_date : true;

            if (activeA !== activeB) {
                return activeA ? -1 : 1;
            }
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
        html += '<div class="text-center">在职</div>';
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
            } else if (paidAmt >= taxAmt) {
                if (taxAmt === 0 && paidAmt > 0) {
                    dotClass = 'status-dot-paid';
                    statusText = '✨ 结余';
                    statusBadgeClass = 'emp-tax-status-paid';
                } else {
                    dotClass = 'status-dot-paid';
                    statusText = '✅ 已缴清';
                    statusBadgeClass = 'emp-tax-status-paid';
                }
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
            var profileUrl = 'https://www.torn.com/profiles.php?XID=' + row.player_id;
            html += '<div class="truncate text-gray-200"><a href="' + profileUrl + '" target="_blank" class="text-torn-accent hover:underline">' + (row.player_name || 'Unknown') + '</a></div>';
            // 是否在职
            var emp = self.employees.find(function(e) { return String(e.player_id) === String(row.player_id); });
            var isActive = emp ? !emp.left_date : true;
            var activeText = isActive ? '<span class="text-green-400">在职</span>' : '<span class="text-gray-500">离职</span>';
            html += '<div class="text-center">' + activeText + '</div>';
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

    _calculateRangeFinancials(startDate, endDate) {
        var totalCost = 0;
        var totalAdFee = 0;
        var totalIncomeAPI = 0;
        var totalTax = 0;
        var totalCarryover = 0;
        var totalTrain = 0;
        var totalBoost = 0;
        const dailyBreakdown = [];
        const todayStr = Utils.todayKey();

        const fin = Utils.resolveCompanyFinancials(this.latestSnapshot, this._overviewStock || []);
        const projDailyCost = fin.dailyCost;
        const projDailyAd = fin.weekAdFee / 7;
        const projDailyIncome = fin.dailyIncome;

        const projectedBoostDates = new Set();
        const projectedBoostPrices = {};

        // Find the latest boost transaction
        const boostTxs = this.transactions.filter(t => t.category === 'boost');
        let latestBoostTx = null;
        if (boostTxs.length > 0) {
            const sorted = [...boostTxs].sort((a, b) => {
                if (a.date && b.date) {
                    return b.date.localeCompare(a.date);
                }
                let tsa = a.timestamp || 0;
                let tsb = b.timestamp || 0;
                if (tsa > 0 && tsa < 100000000000) tsa *= 1000;
                if (tsb > 0 && tsb < 100000000000) tsb *= 1000;
                return tsb - tsa;
            });
            latestBoostTx = sorted[0];
        }

        let nextPurchaseDateStr = todayStr;
        if (latestBoostTx && latestBoostTx.date) {
            const parts = latestBoostTx.date.split('-');
            if (parts.length === 3) {
                let pDate = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
                pDate.setUTCDate(pDate.getUTCDate() + 7);
                let pDateStr = pDate.toISOString().slice(0, 10);
                
                // If it is in the past, advance by 7-day increments until >= todayStr
                while (pDateStr < todayStr) {
                    pDate.setUTCDate(pDate.getUTCDate() + 7);
                    pDateStr = pDate.toISOString().slice(0, 10);
                }
                nextPurchaseDateStr = pDateStr;
            }
        }

        // Initialize simulated seller points tracking
        const simulatedSellers = (this._boostSellers || []).map(s => ({
            id: s.id,
            price_per_boost: Number(s.price_per_boost) || 0,
            initialPoints: (Number(s.total_points) || 0) - (Number(s.points_used) || 0),
            pointsPurchasedSimulated: 0
        }));

        // Fallback purchase price if no seller is qualified
        let fallbackPurchasePrice = 30000000; // default $30m
        if (boostTxs.length > 0) {
            fallbackPurchasePrice = boostTxs.reduce((sum, t) => sum + t.amount, 0) / boostTxs.length;
        }

        // Generate projected purchase dates and choose cheapest qualified seller for each purchase date
        let projDate = new Date(Date.UTC(
            Number(nextPurchaseDateStr.slice(0, 4)),
            Number(nextPurchaseDateStr.slice(5, 7)) - 1,
            Number(nextPurchaseDateStr.slice(8, 10))
        ));

        for (let i = 0; i < 12; i++) {
            const dateStr = projDate.toISOString().slice(0, 10);
            
            // Calculate elapsed days from today to this projected purchase date to estimate seller point regenerations
            const daysElapsed = Math.max(0, Math.round((projDate - new Date(Date.UTC(
                Number(todayStr.slice(0, 4)),
                Number(todayStr.slice(5, 7)) - 1,
                Number(todayStr.slice(8, 10))
            ))) / (24 * 60 * 60 * 1000)));

            // Find all qualified sellers with simulated points >= 250 on this date
            const qualified = [];
            for (const seller of simulatedSellers) {
                if (seller.price_per_boost <= 0) continue;
                // Job points increase by 10 points per day in TORN
                const simulatedPoints = seller.initialPoints + daysElapsed * 10 - seller.pointsPurchasedSimulated;
                if (simulatedPoints >= 250) {
                    qualified.push(seller);
                }
            }

            let chosenPrice = fallbackPurchasePrice;
            if (qualified.length > 0) {
                // Sort by price ascending to pick the cheapest qualified seller
                qualified.sort((a, b) => a.price_per_boost - b.price_per_boost);
                const chosenSeller = qualified[0];
                chosenPrice = chosenSeller.price_per_boost;
                // Deduct 250 points from this seller for subsequent purchases in the simulation
                chosenSeller.pointsPurchasedSimulated += 250;
            }

            projectedBoostDates.add(dateStr);
            projectedBoostPrices[dateStr] = chosenPrice;

            projDate.setUTCDate(projDate.getUTCDate() + 7); // next purchase 7 days later
        }

        // Pre-calculate weekly actual tax transactions and weekly expected tax
        const weekActualPaidMap = new Map();
        const weekExpectedTaxMap = new Map();
        const currentWeekKey = Utils.weekKey(new Date(todayStr + 'T00:00:00'));

        // Group actual tax transactions by week key
        for (const tx of this.transactions) {
            if (this._isTaxTx(tx)) {
                const wk = tx.week_key || Utils.weekKey(new Date(tx.date + 'T00:00:00'));
                if (wk) {
                    weekActualPaidMap.set(wk, (weekActualPaidMap.get(wk) || 0) + (Number(tx.amount) || 0));
                }
            }
        }

        const getWeeklyTaxTotal = (wk) => {
            if (weekExpectedTaxMap.has(wk)) {
                return weekExpectedTaxMap.get(wk);
            }
            let total = 0;
            if (this.config && this.config.weekly_tax_enabled) {
                const activeEmployees = this._getWeeklyActiveEmployees(wk);
                const range = Utils.weekDateRange(wk);
                const formatDateStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
                const weekEndStr = formatDateStr(range.end);
                for (const emp of activeEmployees) {
                    if (emp.left_date && emp.left_date <= weekEndStr) {
                        continue;
                    }
                    total += this._getEmployeeTaxRate(emp.player_id);
                }
            }
            weekExpectedTaxMap.set(wk, total);
            return total;
        };

        const getUnpaidTaxFromRecords = (wk) => {
            const weekRecords = (this.employeeTaxList || []).filter(r => r.week_key === wk);
            if (weekRecords.length === 0) {
                return null;
            }

            const range = Utils.weekDateRange(wk);
            const formatDateStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const weekEndStr = formatDateStr(range.end);

            let unpaidTotal = 0;
            for (const r of weekRecords) {
                if (r.is_written_off) {
                    continue;
                }
                const emp = (this.employees || []).find(e => String(e.player_id) === String(r.player_id));
                const isResigned = emp && emp.left_date && emp.left_date <= weekEndStr;
                if (isResigned) {
                    continue;
                }
                const due = Number(r.tax_amount) || 0;
                const paid = Number(r.paid_amount) || 0;
                unpaidTotal += Math.max(0, due - paid);
            }
            return unpaidTotal;
        };

        const getCarryoverAmount = (wk) => {
            if (!this.config || !this.config.weekly_tax_enabled) {
                return 0;
            }

            const incomingCarryovers = (this.taxCarryovers || []).filter(c => c.to_week_key === wk && !c.deleted);
            if (incomingCarryovers.length === 0) {
                return 0;
            }

            const carryoverEmpIds = new Set();
            for (const ic of incomingCarryovers) {
                const surplusMap = ic.per_employee_surplus;
                if (surplusMap && typeof surplusMap === 'object') {
                    for (const spid in surplusMap) {
                        if (surplusMap.hasOwnProperty(spid) && (Number(surplusMap[spid]) || 0) > 0) {
                            carryoverEmpIds.add(String(spid));
                        }
                    }
                }
            }

            if (carryoverEmpIds.size === 0) {
                return 0;
            }

            const range = Utils.weekDateRange(wk);
            const formatDateStr = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const weekEndStr = formatDateStr(range.end);

            let carryoverTotal = 0;
            for (const pid of carryoverEmpIds) {
                // Check if employee is resigned
                const emp = (this.employees || []).find(e => String(e.player_id) === pid);
                if (emp && emp.left_date && emp.left_date <= weekEndStr) {
                    continue; // Skip if resigned
                }
                
                // Check if employee tax record is written off in this week
                const weekRecords = (this.employeeTaxList || []).filter(r => r.week_key === wk && String(r.player_id) === pid);
                if (weekRecords.length > 0 && weekRecords[0].is_written_off) {
                    continue; // Skip if written off
                }

                carryoverTotal += this._getEmployeeTaxRate(pid);
            }
            return carryoverTotal;
        };

        const start = new Date(Date.UTC(startDate.getFullYear(), startDate.getMonth(), startDate.getDate()));
        const end = new Date(Date.UTC(endDate.getFullYear(), endDate.getMonth(), endDate.getDate()));

        const stockHistory = this._stockHistory || [];
        const snapshots = this._snapshots || [];

        for (let d = new Date(start.getTime()); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
            const dateStr = d.toISOString().slice(0, 10);

            // 1. Stock cost & Ad budget
            let dayCost = 0;
            let dayAd = 0;
            let isCostReal = false;
            let isAdReal = false;

            const dayHistory = stockHistory.filter(h => h.date === dateStr);
            if (dayHistory.length > 0) {
                dayHistory.forEach(h => {
                    dayCost += (Number(h.sold_amount) || 0) * (Number(h.cost) || 0);
                });
                dayAd = Number(dayHistory[0].ad_budget) || 0;
                isCostReal = true;
                isAdReal = true;
            } else {
                if (dateStr >= todayStr) {
                    dayCost = projDailyCost;
                    dayAd = projDailyAd;
                }
            }
            totalCost += dayCost;
            totalAdFee += dayAd;

            // 2. Company Daily Income
            let dayIncome = 0;
            let isIncomeReal = false;
            const daySnapshot = snapshots.find(s => s.date === dateStr);
            if (daySnapshot) {
                const profile = daySnapshot.profile || {};
                const detailed = daySnapshot.detailed || {};
                dayIncome = Number(profile.daily_income ?? detailed.daily_income) || 0;
                if (dayIncome > 0) {
                    isIncomeReal = true;
                } else {
                    const weekIncome = Number(profile.weekly_income ?? detailed.weekly_income) || 0;
                    if (weekIncome > 0) {
                        dayIncome = weekIncome / 7;
                        isIncomeReal = true;
                    } else {
                        dayIncome = projDailyIncome;
                    }
                }
            } else {
                if (dateStr >= todayStr) {
                    dayIncome = projDailyIncome;
                }
            }
            totalIncomeAPI += dayIncome;

            // 3. Boost Expenses
            let dayBoost = 0;
            let isBoostReal = false;
            const dayBoostTxs = this.transactions.filter(tx => tx.category === 'boost' && tx.date === dateStr);
            if (dayBoostTxs.length > 0) {
                dayBoost = dayBoostTxs.reduce((sum, tx) => sum + tx.amount, 0);
                isBoostReal = true;
            } else {
                if (dateStr >= todayStr) {
                    dayBoost = projectedBoostDates.has(dateStr) ? (projectedBoostPrices[dateStr] || 0) : 0;
                }
            }
            totalBoost += dayBoost;

            // 4. Tax Income
            let dayTax = 0;
            let isTaxReal = false;
            let isTaxProj = false;
            const dayTaxTxs = this.transactions.filter(tx => this._isTaxTx(tx) && tx.date === dateStr);
            if (dayTaxTxs.length > 0) {
                dayTax = dayTaxTxs.reduce((sum, tx) => sum + tx.amount, 0);
                isTaxReal = true;
            }

            const weekKey = Utils.weekKey(new Date(dateStr + 'T00:00:00'));
            const isMonday = d.getUTCDay() === 1;

            if (isMonday && weekKey >= currentWeekKey) {
                let unpaidAmount = 0;
                const unpaidFromRecords = getUnpaidTaxFromRecords(weekKey);
                if (unpaidFromRecords !== null) {
                    unpaidAmount = unpaidFromRecords;
                } else {
                    const weeklyTaxTotal = getWeeklyTaxTotal(weekKey);
                    const actualPaid = weekActualPaidMap.get(weekKey) || 0;
                    unpaidAmount = Math.max(0, weeklyTaxTotal - actualPaid);
                }
                if (unpaidAmount > 0) {
                    dayTax += unpaidAmount;
                    isTaxProj = true;
                }
            }
            totalTax += dayTax;

            // 4b. Carryover Income
            let dayCarryover = 0;
            if (isMonday) {
                dayCarryover = getCarryoverAmount(weekKey);
            }
            totalCarryover += dayCarryover;

            // 5. Training Income
            let dayTrain = 0;
            let isTrainReal = false;
            const dayTrainTxs = this.transactions.filter(tx => tx.category === 'train' && tx.date === dateStr);
            if (dayTrainTxs.length > 0) {
                dayTrain = dayTrainTxs.reduce((sum, tx) => sum + tx.amount, 0);
                isTrainReal = true;
            } else {
                if (dateStr >= todayStr) {
                    dayTrain = this._projDailyTrain || 0;
                }
            }
            totalTrain += dayTrain;

            dailyBreakdown.push({
                date: dateStr,
                cost: dayCost,
                isCostReal: isCostReal,
                adFee: dayAd,
                isAdReal: isAdReal,
                income: dayIncome,
                isIncomeReal: isIncomeReal,
                boost: dayBoost,
                isBoostReal: isBoostReal,
                tax: dayTax,
                isTaxReal: isTaxReal,
                isTaxProj: isTaxProj,
                carryover: dayCarryover,
                train: dayTrain,
                isTrainReal: isTrainReal
            });
        }

        return {
            cost: totalCost,
            adFee: totalAdFee,
            income: totalIncomeAPI,
            tax: totalTax,
            carryover: totalCarryover,
            train: totalTrain,
            boost: totalBoost,
            dailyBreakdown: dailyBreakdown
        };
    },

    _overviewTabHTML() {
        const now = new Date();
        const startOfWeek = Utils.startOfCalendarWeek(now);
        const endOfWeek = new Date(startOfWeek);
        endOfWeek.setDate(startOfWeek.getDate() + 6);

        const monthParts = this.selectedMonthKey.split('-');
        const monthYear = parseInt(monthParts[0], 10);
        const monthVal = parseInt(monthParts[1], 10);
        const startOfMonth = new Date(monthYear, monthVal - 1, 1);
        const endOfMonth = new Date(monthYear, monthVal, 0);

        // Calculate other transaction sums
        let weekOther = 0;
        let monthOther = 0;

        for (const tx of this.transactions) {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 100000000000) ts *= 1000; // normalize seconds to ms

            if (ts >= startOfWeek.getTime() && ts <= endOfWeek.getTime() + 86399999) {
                if (!this._isTaxTx(tx) && tx.category !== 'train' && tx.category !== 'boost') {
                    weekOther += tx.amount;
                }
            }
            if (ts >= startOfMonth.getTime() && ts <= endOfMonth.getTime() + 86399999) {
                if (!this._isTaxTx(tx) && tx.category !== 'train' && tx.category !== 'boost') {
                    monthOther += tx.amount;
                }
            }
        }

        // Calculate Weekly using hybrid logic (real history + projections)
        const weekFin = this._calculateRangeFinancials(startOfWeek, endOfWeek);
        const weekIncomeAPI = weekFin.income;
        const weekCostAPI = weekFin.cost;
        const weekAdFeeAPI = weekFin.adFee;
        const weekTax = weekFin.tax;
        const weekCarryover = weekFin.carryover;
        const weekTrain = weekFin.train;
        const weekBoost = weekFin.boost;

        const weekTotalIncome = weekTax + weekTrain + weekOther + weekIncomeAPI + weekCarryover;
        const weekTotalExpense = weekBoost + weekCostAPI + weekAdFeeAPI;
        const weekNetProfit = weekTotalIncome - weekTotalExpense;

        // Calculate Monthly using hybrid logic (real history + projections)
        const monthFin = this._calculateRangeFinancials(startOfMonth, endOfMonth);
        const monthIncomeAPI = monthFin.income;
        const monthCostAPI = monthFin.cost;
        const monthAdFeeAPI = monthFin.adFee;
        const monthTax = monthFin.tax;
        const monthCarryover = monthFin.carryover;
        const monthTrain = monthFin.train;
        const monthBoost = monthFin.boost;

        const monthTotalIncome = monthTax + monthTrain + monthOther + monthIncomeAPI + monthCarryover;
        const monthTotalExpense = monthBoost + monthCostAPI + monthAdFeeAPI;
        const monthNetProfit = monthTotalIncome - monthTotalExpense;

        const isCurrentMonth = this.selectedMonthKey === this._getCurrentMonthKey();
        const nextDisabledClass = isCurrentMonth ? 'opacity-50 cursor-not-allowed' : '';
        const nextDisabledAttr = isCurrentMonth ? ' disabled' : '';

        return `
            <div class="card mb-6">
                <h3 class="text-lg font-bold text-white mb-4">
                    <i class="fas fa-calendar-week mr-2 text-torn-accent"></i>本周概览 (日历周预估)
                </h3>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                    ${UI.kpiCard('fas fa-arrow-down', '总支出', Utils.formatMoney(weekTotalExpense), '成本+广告+Boost', 'red')}
                    ${UI.kpiCard('fas fa-arrow-up', '总收入', Utils.formatMoney(weekTotalIncome), '税费+训练+其他+公司周收入', 'green')}
                    ${UI.kpiCard('fas fa-balance-scale', '净利润', Utils.formatMoney(weekNetProfit), '收入 - 支出', weekNetProfit >= 0 ? 'accent' : 'red')}
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <!-- Expenses -->
                    <div class="bg-torn-surface border border-torn-border rounded p-4">
                        <h4 class="text-md font-bold text-red-400 border-b border-torn-border pb-2 mb-3">本周支出明细</h4>
                        <div class="space-y-2 text-sm">
                            <div class="flex justify-between text-gray-300">
                                <span class="cursor-help border-b border-dashed border-gray-600" data-tooltip-right="记录+预测">商品成本:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekCostAPI)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span class="cursor-help border-b border-dashed border-gray-600" data-tooltip-right="记录+预测">广告费:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekAdFeeAPI)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span class="cursor-help border-b border-dashed border-gray-600" data-tooltip-right="记录+预测">Boost 支出:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekBoost)}</span>
                            </div>
                        </div>
                    </div>

                    <!-- Income -->
                    <div class="bg-torn-surface border border-torn-border rounded p-4">
                        <h4 class="text-md font-bold text-torn-green border-b border-torn-border pb-2 mb-3">本周收入明细</h4>
                        <div class="space-y-2 text-sm">
                            <div class="flex justify-between text-gray-300">
                                <span class="cursor-help border-b border-dashed border-gray-600" data-tooltip-right="记录+预测">员工税费:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekTax)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>结转项:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekCarryover)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span class="cursor-help border-b border-dashed border-gray-600" data-tooltip-right="记录+预测">员工训练费:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekTrain)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span>其他收入:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekOther)}</span>
                            </div>
                            <div class="flex justify-between text-gray-300">
                                <span class="cursor-help border-b border-dashed border-gray-600" data-tooltip-right="记录+预测">公司收入:</span>
                                <span class="font-mono text-white">${Utils.formatMoney(weekIncomeAPI)}</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Monthly Overview -->
            <div class="card">
                <div class="flex items-center justify-between mb-4 flex-wrap gap-2">
                    <h3 class="text-lg font-bold text-white">
                        <i class="fas fa-calendar-alt mr-2 text-torn-accent"></i>月度概览 (日历月预估)
                    </h3>
                    <div class="flex items-center gap-2">
                        <button class="btn btn-xs btn-secondary" data-action="prev-month" title="上一个月">
                            <i class="fas fa-chevron-left"></i>
                        </button>
                        <span class="text-sm font-semibold text-torn-accent font-mono min-w-[70px] text-center" id="month-label-text">${this.selectedMonthKey}</span>
                        <button class="btn btn-xs btn-secondary ${nextDisabledClass}" data-action="next-month"${nextDisabledAttr} title="下一个月">
                            <i class="fas fa-chevron-right"></i>
                        </button>
                        ${!isCurrentMonth ? `<button class="btn btn-xs btn-primary ml-1" data-action="goto-current-month">本月</button>` : ''}
                    </div>
                </div>
                <div class="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center cursor-pointer hover:border-torn-accent transition-colors" data-action="view-month-expense" title="点击查看计算明细">
                        <div class="text-gray-400 text-xs mb-1">月度总支出预估 <i class="fas fa-search-plus text-xs ml-1 opacity-70"></i></div>
                        <div class="text-red-400 font-bold">${Utils.formatMoney(monthTotalExpense)}</div>
                    </div>
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center cursor-pointer hover:border-torn-accent transition-colors" data-action="view-month-income" title="点击查看计算明细">
                        <div class="text-gray-400 text-xs mb-1">月度总收入预估 <i class="fas fa-search-plus text-xs ml-1 opacity-70"></i></div>
                        <div class="text-torn-green font-bold">${Utils.formatMoney(monthTotalIncome)}</div>
                    </div>
                    <div class="p-3 bg-torn-surface border border-torn-border rounded text-center">
                        <div class="text-gray-400 text-xs mb-1">月度净利润预估</div>
                        <div class="${monthNetProfit >= 0 ? 'text-torn-gold' : 'text-red-400'} font-bold">${Utils.formatMoney(monthNetProfit)}</div>
                    </div>
                </div>
                <div class="text-xs text-gray-500 text-right">计算公式：当月实际交易记录 + 公司API历史与预测数据</div>
            </div>
        `;
    },

    async _showMonthExpenseDetails() {
        const monthParts = this.selectedMonthKey.split('-');
        const monthYear = parseInt(monthParts[0], 10);
        const monthVal = parseInt(monthParts[1], 10);
        const startOfMonth = new Date(monthYear, monthVal - 1, 1);
        const endOfMonth = new Date(monthYear, monthVal, 0);

        const monthFin = this._calculateRangeFinancials(startOfMonth, endOfMonth);
        const monthBoost = monthFin.boost;
        const monthTotalExpense = monthBoost + monthFin.cost + monthFin.adFee;
        
        const monthTxs = this.transactions.filter(tx => {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 100000000000) ts *= 1000;
            return ts >= startOfMonth.getTime() && ts <= endOfMonth.getTime() + 86399999;
        });
        const boostTxs = monthTxs.filter(tx => tx.category === 'boost');

        // Group dailyBreakdown by week keys (store full day objects for drill-down)
        const weeklyBreakdown = {};
        monthFin.dailyBreakdown.forEach(day => {
            const parts = day.date.split('-');
            const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
            const wk = Utils.weekKey(dt);
            if (!weeklyBreakdown[wk]) {
                weeklyBreakdown[wk] = {
                    weekKey: wk,
                    cost: 0,
                    hasCostProj: false,
                    hasCostReal: false,
                    adFee: 0,
                    hasAdProj: false,
                    hasAdReal: false,
                    boost: 0,
                    hasBoostProj: false,
                    hasBoostReal: false,
                    days: [],
                    dayObjects: []
                };
            }
            const w = weeklyBreakdown[wk];
            w.days.push(day.date);
            w.dayObjects.push(day);
            w.cost += day.cost;
            if (day.isCostReal) w.hasCostReal = true; else w.hasCostProj = true;
            w.adFee += day.adFee;
            if (day.isAdReal) w.hasAdReal = true; else w.hasAdProj = true;
            w.boost += day.boost;
            if (day.isBoostReal) w.hasBoostReal = true; else w.hasBoostProj = true;
        });
        const weeks = Object.values(weeklyBreakdown).sort((a, b) => a.weekKey.localeCompare(b.weekKey));

        const getCustomWeekLabel = (wk, daysList) => {
            const parts = wk.split('-W');
            const weekNum = parseInt(parts[1], 10);
            const sortedDays = [...daysList].sort();
            const firstDateStr = sortedDays[0];
            const lastDateStr = sortedDays[sortedDays.length - 1];
            
            const firstParts = firstDateStr.split('-');
            const lastParts = lastDateStr.split('-');
            
            const firstYear = parseInt(firstParts[0], 10);
            const firstMonth = parseInt(firstParts[1], 10);
            const firstDay = parseInt(firstParts[2], 10);
            
            const lastMonth = parseInt(lastParts[1], 10);
            const lastDay = parseInt(lastParts[2], 10);
            
            if (firstMonth === lastMonth) {
                return firstYear + '年' + firstMonth + '月' + firstDay + '日 - ' + lastDay + '日 (第' + weekNum + '周)';
            } else {
                return firstYear + '年' + firstMonth + '月' + firstDay + '日 - ' + lastMonth + '月' + lastDay + '日 (第' + weekNum + '周)';
            }
        };

        const getDayLabel = (dateStr) => {
            const parts = dateStr.split('-');
            const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
            const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
            return Number(parts[1]) + '/' + Number(parts[2]) + ' 周' + dayNames[dt.getDay()];
        };

        let html = `
            <div class="p-6">
                <div class="flex justify-between items-center border-b border-torn-border pb-3 mb-4">
                    <h3 class="text-lg font-bold text-white flex items-center">
                        <i class="fas fa-coins text-red-400 mr-2"></i>月度总支出估算明细
                    </h3>
                    <button class="text-gray-400 hover:text-white" onclick="Utils.hideModal()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                
                <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">商品成本</div>
                        <div class="font-mono text-white text-sm font-bold">${Utils.formatMoney(monthFin.cost)}</div>
                    </div>
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">广告费用</div>
                        <div class="font-mono text-white text-sm font-bold">${Utils.formatMoney(monthFin.adFee)}</div>
                    </div>
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">Boost 支出</div>
                        <div class="font-mono text-white text-sm font-bold">${Utils.formatMoney(monthBoost)}</div>
                    </div>
                    <div class="bg-red-950/40 border border-red-500/30 rounded p-2 text-center">
                        <div class="text-red-300 text-xs mb-0.5">总支出预估</div>
                        <div class="font-mono text-red-400 text-sm font-bold">${Utils.formatMoney(monthTotalExpense)}</div>
                    </div>
                </div>
 
                <h4 class="text-sm font-bold text-gray-300 mb-2">每周支出预测与实际明细 <span class="text-xs text-gray-500 font-normal ml-1">点击展开每日明细</span></h4>
                <div class="overflow-y-auto max-h-[400px] border border-torn-border rounded mb-6">
                    <table class="min-w-full text-xs text-left text-gray-300" id="expense-weekly-table">
                        <thead class="bg-torn-surface text-gray-400 sticky top-0">
                            <tr>
                                <th class="p-2 border-b border-torn-border" style="width:24px"></th>
                                <th class="p-2 border-b border-torn-border">周度范围</th>
                                <th class="p-2 border-b border-torn-border">商品成本</th>
                                <th class="p-2 border-b border-torn-border">广告费</th>
                                <th class="p-2 border-b border-torn-border">Boost 支出</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${weeks.map((w, wIdx) => {
                                const costLabel = w.hasCostReal && !w.hasCostProj ? '实' : (!w.hasCostReal && w.hasCostProj ? '预' : '实/预');
                                const costColor = costLabel === '实' ? 'text-torn-green' : (costLabel === '预' ? 'text-gray-500' : 'text-torn-gold');
                                
                                const adLabel = w.hasAdReal && !w.hasAdProj ? '实' : (!w.hasAdReal && w.hasAdProj ? '预' : '实/预');
                                const adColor = adLabel === '实' ? 'text-torn-green' : (adLabel === '预' ? 'text-gray-500' : 'text-torn-gold');
                                
                                const boostLabel = w.hasBoostReal && !w.hasBoostProj ? '实' : (!w.hasBoostReal && w.hasBoostProj ? '预' : '实/预');
                                const boostColor = boostLabel === '实' ? 'text-torn-green' : (boostLabel === '预' ? 'text-gray-500' : 'text-torn-gold');

                                let rowsHtml = `
                                    <tr class="week-expand-row hover:bg-torn-surface/50 border-b border-torn-border/50 cursor-pointer" data-week-idx="${wIdx}">
                                        <td class="p-2 text-center"><i class="fas fa-chevron-right week-expand-icon text-gray-500 transition-transform duration-200" style="font-size:10px"></i></td>
                                        <td class="p-2 font-mono font-semibold">${getCustomWeekLabel(w.weekKey, w.days)}</td>
                                        <td class="p-2 font-mono">${Utils.formatMoney(w.cost)} <span class="text-xs ${costColor}">(${costLabel})</span></td>
                                        <td class="p-2 font-mono">${Utils.formatMoney(w.adFee)} <span class="text-xs ${adColor}">(${adLabel})</span></td>
                                        <td class="p-2 font-mono">${w.boost > 0 ? Utils.formatMoney(w.boost) : '-'} <span class="text-xs ${boostColor}">(${boostLabel})</span></td>
                                    </tr>
                                `;

                                const sortedDays = [...w.dayObjects].sort((a, b) => a.date.localeCompare(b.date));
                                sortedDays.forEach(day => {
                                    const dayCostTag = day.isCostReal ? '<span class="text-torn-green">(实)</span>' : '<span class="text-gray-500">(预)</span>';
                                    const dayAdTag = day.isAdReal ? '<span class="text-torn-green">(实)</span>' : '<span class="text-gray-500">(预)</span>';
                                    const dayBoostTag = day.isBoostReal ? '<span class="text-torn-green">(实)</span>' : '<span class="text-gray-500">(预)</span>';
                                    const todayStr = Utils.todayKey();
                                    const isToday = day.date === todayStr;
                                    const todayClass = isToday ? 'bg-torn-accent/10' : 'bg-torn-bg/60';
                                    rowsHtml += `
                                        <tr class="week-day-row border-b border-torn-border/30 ${todayClass}" data-parent-week="${wIdx}" style="display:none">
                                            <td class="p-1.5"></td>
                                            <td class="p-1.5 pl-6 font-mono text-gray-400">
                                                ${isToday ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-torn-accent mr-1"></span>' : '<span class="inline-block w-1.5 h-1.5 mr-1"></span>'}
                                                ${getDayLabel(day.date)}
                                            </td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.cost > 0 ? Utils.formatMoney(day.cost) : '-'} ${day.cost > 0 ? dayCostTag : ''}</td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.adFee > 0 ? Utils.formatMoney(day.adFee) : '-'} ${day.adFee > 0 ? dayAdTag : ''}</td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.boost > 0 ? Utils.formatMoney(day.boost) : '-'} ${day.boost > 0 ? dayBoostTag : ''}</td>
                                        </tr>
                                    `;
                                });

                                return rowsHtml;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
 
                <h4 class="text-sm font-bold text-gray-300 mb-2">当月 Boost 购买实际记录</h4>
                <div class="overflow-y-auto max-h-[200px] border border-torn-border rounded">
                    <table class="min-w-full text-xs text-left text-gray-300">
                        <thead class="bg-torn-surface text-gray-400 sticky top-0">
                            <tr>
                                <th class="p-2 border-b border-torn-border">日期</th>
                                <th class="p-2 border-b border-torn-border">卖家</th>
                                <th class="p-2 border-b border-torn-border">金额</th>
                                <th class="p-2 border-b border-torn-border">备注</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${boostTxs.length === 0 ? `
                                <tr>
                                    <td colspan="4" class="p-4 text-center text-gray-500">当月无 Boost 实际购买记录</td>
                                </tr>
                            ` : boostTxs.map(tx => `
                                <tr class="hover:bg-torn-surface/50 border-b border-torn-border/50">
                                    <td class="p-2 font-mono">${tx.date || '-'}</td>
                                    <td class="p-2">${tx.player_name || `ID:${tx.player_id}`}</td>
                                    <td class="p-2 font-mono text-red-400">${Utils.formatMoney(tx.amount)}</td>
                                    <td class="p-2 text-gray-400 max-w-[200px] truncate" title="${tx.note || ''}">${tx.note || '-'}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        Utils.showModal(html, 'max-w-3xl');

        // Bind expand/collapse events for weekly rows
        const table = document.getElementById('expense-weekly-table');
        if (table) {
            table.querySelectorAll('.week-expand-row').forEach(row => {
                row.addEventListener('click', () => {
                    const wIdx = row.dataset.weekIdx;
                    const icon = row.querySelector('.week-expand-icon');
                    const dayRows = table.querySelectorAll(`.week-day-row[data-parent-week="${wIdx}"]`);
                    const isExpanded = icon.classList.contains('fa-chevron-down');
                    if (isExpanded) {
                        icon.classList.remove('fa-chevron-down');
                        icon.classList.add('fa-chevron-right');
                        dayRows.forEach(r => r.style.display = 'none');
                    } else {
                        icon.classList.remove('fa-chevron-right');
                        icon.classList.add('fa-chevron-down');
                        dayRows.forEach(r => r.style.display = '');
                    }
                });
            });
        }
    },

    async _showMonthIncomeDetails() {
        const monthParts = this.selectedMonthKey.split('-');
        const monthYear = parseInt(monthParts[0], 10);
        const monthVal = parseInt(monthParts[1], 10);
        const startOfMonth = new Date(monthYear, monthVal - 1, 1);
        const endOfMonth = new Date(monthYear, monthVal, 0);
        const todayStr = Utils.todayKey();
        const currentWeekKey = Utils.weekKey(new Date(todayStr + 'T00:00:00'));

        const monthFin = this._calculateRangeFinancials(startOfMonth, endOfMonth);
        const monthTax = monthFin.tax;
        const monthCarryover = monthFin.carryover;
        const monthTrain = monthFin.train;
        
        const monthTxs = this.transactions.filter(tx => {
            let ts = tx.timestamp || 0;
            if (ts > 0 && ts < 100000000000) ts *= 1000;
            return ts >= startOfMonth.getTime() && ts <= endOfMonth.getTime() + 86399999;
        });

        const taxTxs = monthTxs.filter(tx => this._isTaxTx(tx));
        const trainTxs = monthTxs.filter(tx => tx.category === 'train');
        const otherTxs = monthTxs.filter(tx => !this._isTaxTx(tx) && tx.category !== 'boost' && tx.category !== 'train');

        let monthOther = 0;
        otherTxs.forEach(tx => monthOther += tx.amount);

        const monthTotalIncome = monthTax + monthTrain + monthOther + monthFin.income + monthCarryover;

        // Group dailyBreakdown by week keys
        const weeklyBreakdown = {};
        monthFin.dailyBreakdown.forEach(day => {
            const parts = day.date.split('-');
            const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
            const wk = Utils.weekKey(dt);
            if (!weeklyBreakdown[wk]) {
                weeklyBreakdown[wk] = {
                    weekKey: wk,
                    income: 0,
                    hasIncomeProj: false,
                    hasIncomeReal: false,
                    tax: 0,
                    hasTaxProj: false,
                    hasTaxReal: false,
                    carryover: 0,
                    train: 0,
                    hasTrainProj: false,
                    hasTrainReal: false,
                    days: [],
                    dayObjects: []
                };
            }
            const w = weeklyBreakdown[wk];
            w.days.push(day.date);
            w.dayObjects.push(day);
            w.income += day.income;
            if (day.isIncomeReal) w.hasIncomeReal = true; else w.hasIncomeProj = true;
            w.tax += day.tax;
            if (day.isTaxReal) w.hasTaxReal = true;
            if (day.isTaxProj) w.hasTaxProj = true;
            w.carryover += day.carryover || 0;
            w.train += day.train;
            if (day.isTrainReal) w.hasTrainReal = true; else w.hasTrainProj = true;
        });
        const weeks = Object.values(weeklyBreakdown).sort((a, b) => a.weekKey.localeCompare(b.weekKey));

        const getCustomWeekLabel = (wk, daysList) => {
            const parts = wk.split('-W');
            const weekNum = parseInt(parts[1], 10);
            const sortedDays = [...daysList].sort();
            const firstDateStr = sortedDays[0];
            const lastDateStr = sortedDays[sortedDays.length - 1];
            
            const firstParts = firstDateStr.split('-');
            const lastParts = lastDateStr.split('-');
            
            const firstYear = parseInt(firstParts[0], 10);
            const firstMonth = parseInt(firstParts[1], 10);
            const firstDay = parseInt(firstParts[2], 10);
            
            const lastMonth = parseInt(lastParts[1], 10);
            const lastDay = parseInt(lastParts[2], 10);
            
            if (firstMonth === lastMonth) {
                return firstYear + '年' + firstMonth + '月' + firstDay + '日 - ' + lastDay + '日 (第' + weekNum + '周)';
            } else {
                return firstYear + '年' + firstMonth + '月' + firstDay + '日 - ' + lastMonth + '月' + lastDay + '日 (第' + weekNum + '周)';
            }
        };

        const getDayLabel = (dateStr) => {
            const parts = dateStr.split('-');
            const dt = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
            const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
            return Number(parts[1]) + '/' + Number(parts[2]) + ' 周' + dayNames[dt.getDay()];
        };

        let html = `
            <div class="p-6">
                <div class="flex justify-between items-center border-b border-torn-border pb-3 mb-4">
                    <h3 class="text-lg font-bold text-white flex items-center">
                        <i class="fas fa-coins text-torn-green mr-2"></i>月度总收入估算明细
                    </h3>
                    <button class="text-gray-400 hover:text-white" onclick="Utils.hideModal()">
                        <i class="fas fa-times"></i>
                    </button>
                </div>
                
                <div class="grid grid-cols-2 sm:grid-cols-6 gap-2 mb-6">
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">营业额收入</div>
                        <div class="font-mono text-white text-xs font-bold">${Utils.formatMoney(monthFin.income)}</div>
                    </div>
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">员工税收</div>
                        <div class="font-mono text-white text-xs font-bold">${Utils.formatMoney(monthTax)}</div>
                    </div>
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">结转项</div>
                        <div class="font-mono text-white text-xs font-bold">${Utils.formatMoney(monthCarryover)}</div>
                    </div>
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">训练费用</div>
                        <div class="font-mono text-white text-xs font-bold">${Utils.formatMoney(monthTrain)}</div>
                    </div>
                    <div class="bg-torn-surface border border-torn-border rounded p-2 text-center">
                        <div class="text-gray-400 text-xs mb-0.5">其他收入</div>
                        <div class="font-mono text-white text-xs font-bold">${Utils.formatMoney(monthOther)}</div>
                    </div>
                    <div class="bg-green-950/40 border border-green-500/30 rounded p-2 text-center col-span-2 sm:col-span-1">
                        <div class="text-green-300 text-xs mb-0.5">总收入预估</div>
                        <div class="font-mono text-torn-green text-xs font-bold">${Utils.formatMoney(monthTotalIncome)}</div>
                    </div>
                </div>
 
                <h4 class="text-sm font-bold text-gray-300 mb-2">每周预测与实际收入明细 <span class="text-xs text-gray-500 font-normal ml-1">点击展开每日明细</span></h4>
                <div class="overflow-y-auto max-h-[400px] border border-torn-border rounded mb-6">
                    <table class="min-w-full text-xs text-left text-gray-300" id="income-weekly-table">
                        <thead class="bg-torn-surface text-gray-400 sticky top-0">
                            <tr>
                                <th class="p-2 border-b border-torn-border" style="width:24px"></th>
                                <th class="p-2 border-b border-torn-border">周度范围</th>
                                <th class="p-2 border-b border-torn-border">公司营业额</th>
                                <th class="p-2 border-b border-torn-border">员工税收</th>
                                <th class="p-2 border-b border-torn-border">结转项</th>
                                <th class="p-2 border-b border-torn-border">训练费</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${weeks.map((w, wIdx) => {
                                const incomeLabel = w.hasIncomeReal && !w.hasIncomeProj ? '实' : (!w.hasIncomeReal && w.hasIncomeProj ? '预' : '实/预');
                                const incomeColor = incomeLabel === '实' ? 'text-torn-green' : (incomeLabel === '预' ? 'text-gray-500' : 'text-torn-gold');
                                
                                const taxLabel = w.tax === 0 ? (w.weekKey >= currentWeekKey ? '预' : '实') : (w.hasTaxReal && !w.hasTaxProj ? '实' : (!w.hasTaxReal && w.hasTaxProj ? '预' : '实/预'));
                                const taxColor = taxLabel === '实' ? 'text-torn-green' : (taxLabel === '预' ? 'text-gray-500' : 'text-torn-gold');
                                
                                const trainLabel = w.hasTrainReal && !w.hasTrainProj ? '实' : (!w.hasTrainReal && w.hasTrainProj ? '预' : '实/预');
                                const trainColor = trainLabel === '实' ? 'text-torn-green' : (trainLabel === '预' ? 'text-gray-500' : 'text-torn-gold');

                                let rowsHtml = `
                                    <tr class="week-expand-row hover:bg-torn-surface/50 border-b border-torn-border/50 cursor-pointer" data-week-idx="${wIdx}">
                                        <td class="p-2 text-center"><i class="fas fa-chevron-right week-expand-icon text-gray-500 transition-transform duration-200" style="font-size:10px"></i></td>
                                        <td class="p-2 font-mono font-semibold">${getCustomWeekLabel(w.weekKey, w.days)}</td>
                                        <td class="p-2 font-mono">${Utils.formatMoney(w.income)} <span class="text-xs ${incomeColor}">(${incomeLabel})</span></td>
                                        <td class="p-2 font-mono">${Utils.formatMoney(w.tax)} <span class="text-xs ${taxColor}">(${taxLabel})</span></td>
                                        <td class="p-2 font-mono">${w.carryover > 0 ? Utils.formatMoney(w.carryover) : '-'}</td>
                                        <td class="p-2 font-mono">${Utils.formatMoney(w.train)} <span class="text-xs ${trainColor}">(${trainLabel})</span></td>
                                    </tr>
                                `;

                                const sortedDays = [...w.dayObjects].sort((a, b) => a.date.localeCompare(b.date));
                                sortedDays.forEach(day => {
                                    const dayIncomeTag = day.isIncomeReal ? '<span class="text-torn-green">(实)</span>' : '<span class="text-gray-500">(预)</span>';
                                    const dayTaxTag = day.isTaxReal && day.isTaxProj ? '<span class="text-torn-gold">(实/预)</span>' : (day.isTaxReal ? '<span class="text-torn-green">(实)</span>' : '<span class="text-gray-500">(预)</span>');
                                    const dayTrainTag = day.isTrainReal ? '<span class="text-torn-green">(实)</span>' : '<span class="text-gray-500">(预)</span>';
                                    const todayStr = Utils.todayKey();
                                    const isToday = day.date === todayStr;
                                    const todayClass = isToday ? 'bg-torn-accent/10' : 'bg-torn-bg/60';
                                    rowsHtml += `
                                        <tr class="week-day-row border-b border-torn-border/30 ${todayClass}" data-parent-week="${wIdx}" style="display:none">
                                            <td class="p-1.5"></td>
                                            <td class="p-1.5 pl-6 font-mono text-gray-400">
                                                ${isToday ? '<span class="inline-block w-1.5 h-1.5 rounded-full bg-torn-accent mr-1"></span>' : '<span class="inline-block w-1.5 h-1.5 mr-1"></span>'}
                                                ${getDayLabel(day.date)}
                                            </td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.income > 0 ? Utils.formatMoney(day.income) : '-'} ${day.income > 0 ? dayIncomeTag : ''}</td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.tax > 0 ? Utils.formatMoney(day.tax) : '-'} ${day.tax > 0 ? dayTaxTag : ''}</td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.carryover > 0 ? Utils.formatMoney(day.carryover) : '-'}</td>
                                            <td class="p-1.5 font-mono text-gray-400">${day.train > 0 ? Utils.formatMoney(day.train) : '-'} ${day.train > 0 ? dayTrainTag : ''}</td>
                                        </tr>
                                    `;
                                });

                                return rowsHtml;
                            }).join('')}
                        </tbody>
                    </table>
                </div>

                <h4 class="text-sm font-bold text-gray-300 mb-2">当月实际交易流水 (税收/训练/其他)</h4>
                <div class="overflow-y-auto max-h-[250px] border border-torn-border rounded">
                    <table class="min-w-full text-xs text-left text-gray-300">
                        <thead class="bg-torn-surface text-gray-400 sticky top-0">
                            <tr>
                                <th class="p-2 border-b border-torn-border">日期</th>
                                <th class="p-2 border-b border-torn-border">员工</th>
                                <th class="p-2 border-b border-torn-border">分类</th>
                                <th class="p-2 border-b border-torn-border">金额</th>
                                <th class="p-2 border-b border-torn-border">备注</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${(taxTxs.length + trainTxs.length + otherTxs.length) === 0 ? `
                                <tr>
                                    <td colspan="5" class="p-4 text-center text-gray-500">当月无实际交易流水记录</td>
                                </tr>
                            ` : [...taxTxs, ...trainTxs, ...otherTxs].sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0)).map(tx => {
                                let catLabel = '其他';
                                let catColor = 'text-gray-300';
                                if (this._isTaxTx(tx)) { catLabel = '税收'; catColor = 'text-torn-gold'; }
                                else if (tx.category === 'train') { catLabel = '训练'; catColor = 'text-cyan-400'; }

                                return `
                                <tr class="hover:bg-torn-surface/50 border-b border-torn-border/50">
                                    <td class="p-2 font-mono">${tx.date || '-'}</td>
                                    <td class="p-2">${tx.player_name || `ID:${tx.player_id}`}</td>
                                    <td class="p-2 ${catColor}">${catLabel}</td>
                                    <td class="p-2 font-mono text-torn-green">${Utils.formatMoney(tx.amount)}</td>
                                    <td class="p-2 text-gray-400 max-w-[200px] truncate" title="${tx.note || '-'}">${tx.note || '-'}</td>
                                </tr>
                                `;
                            }).join('')}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
        Utils.showModal(html, 'max-w-3xl');

        // Bind expand/collapse events for weekly rows
        const incomeTable = document.getElementById('income-weekly-table');
        if (incomeTable) {
            incomeTable.querySelectorAll('.week-expand-row').forEach(row => {
                row.addEventListener('click', () => {
                    const wIdx = row.dataset.weekIdx;
                    const icon = row.querySelector('.week-expand-icon');
                    const dayRows = incomeTable.querySelectorAll(`.week-day-row[data-parent-week="${wIdx}"]`);
                    const isExpanded = icon.classList.contains('fa-chevron-down');
                    if (isExpanded) {
                        icon.classList.remove('fa-chevron-down');
                        icon.classList.add('fa-chevron-right');
                        icon.style.transform = '';
                        dayRows.forEach(r => r.style.display = 'none');
                    } else {
                        icon.classList.remove('fa-chevron-right');
                        icon.classList.add('fa-chevron-down');
                        dayRows.forEach(r => r.style.display = '');
                    }
                });
            });
        }
    },

    // ---- Tab: 交易记录 ----

    _transactionsTabHTML() {
        const sortedEmployeesForTx = [...this.employees].sort((a, b) => {
            if (a.left_date && !b.left_date) return 1;
            if (!a.left_date && b.left_date) return -1;
            return a.name.localeCompare(b.name);
        });
        const empOptions = sortedEmployeesForTx.map(e => {
            const nameLabel = e.left_date ? `${e.name}（已离职）` : e.name;
            return `<option value="${e.player_id}" ${this.txFilterEmp === String(e.player_id) ? 'selected' : ''}>${nameLabel}</option>`;
        }).join('');

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
            const startOfWeek = Utils.startOfCalendarWeek(now);
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
                <select class="input input-xs bg-torn-surface border border-torn-border cursor-pointer tx-cat-select max-w-[88px]" data-tx-id="${tx.id}">
                    ${Utils.transactionCategoryOptions(cat)}
                </select>
            `;
            return {
                select: `<input type="checkbox" class="tx-row-cb cursor-pointer" data-tx-id="${tx.id}" />`,
                id: tx.id,
                date: tx.date || '-',
                employee: tx.player_id ? `<a href="https://www.torn.com/profiles.php?XID=${tx.player_id}" target="_blank" class="text-torn-accent hover:underline">${tx.player_name || '-'}</a>` : (tx.player_name || '-'),
                amount: Utils.formatTransactionAmount(tx),
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
        var status = weekRecord ? self._computeWeekTaxStatusFromEmployees(self.selectedWeekKey) : 'current';
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

    // ---- Week Selector UI ----

    _weekSelectorHTML: function() {
        var currentWeek = Utils.weekKey();
        var self = this;

        // 获取连续的所有周 keys
        var allKeys = this._getContinuousWeekKeys();
        var isCurrentWeekSelected = this.selectedWeekKey === currentWeek;

        var html = '<div class="fin-week-selector flex items-center justify-between gap-3 mb-4 p-3 bg-torn-card rounded-lg">';
        
        // 向左滚动按钮
        html += '<button class="week-nav-btn px-3 py-1.5 bg-torn-bg hover:bg-torn-accent hover:text-white rounded transition-colors text-lg font-bold" data-action="scroll-left" title="向左滚动">«</button>';
        
        // 并排显示的周 Tab 列表（渲染所有周，由 Flexbox/CSS 决定溢出）
        html += '<div class="fin-week-tabs-list flex items-center gap-2 overflow-x-auto flex-1 py-1" id="week-tabs-list">';
        allKeys.forEach(function(wk) {
            var parts = wk.split('-W');
            var weekNum = parts[1];
            var year = parts[0];
            var currentYear = String(new Date().getFullYear());
            var weekLabel = 'W' + weekNum;
            if (year !== currentYear) {
                weekLabel = year.slice(2) + '-W' + weekNum;
            }

            var range = Utils.weekDateRange(wk);
            var startStr = String(range.start.getMonth() + 1).padStart(2, '0') + '/' + String(range.start.getDate()).padStart(2, '0');
            var endStr = String(range.end.getMonth() + 1).padStart(2, '0') + '/' + String(range.end.getDate()).padStart(2, '0');
            var dateRange = startStr + ' - ' + endStr;

            var status = self._computeWeekTaxStatusFromEmployees(wk);
            var statusText = '进行中';
            var dotClass = 'current';
            if (status === 'paid') {
                statusText = '已缴清';
                dotClass = 'paid';
            } else if (status === 'overdue') {
                statusText = '未结清';
                dotClass = 'overdue';
            }

            var isSelected = wk === self.selectedWeekKey;
            var tabClasses = ['fin-week-tab'];
            if (isSelected) tabClasses.push('active');
            if (status === 'overdue') tabClasses.push('overdue');

            html += '<div class="' + tabClasses.join(' ') + '" data-week-key="' + wk + '" title="' + Utils.weekLabel(wk) + '">';
            html += '<span class="text-sm font-bold text-white">' + weekLabel + '</span>';
            html += '<span class="text-xs text-gray-400 mt-1">' + dateRange + '</span>';
            html += '<span class="text-xs mt-1 flex items-center gap-1.5 text-gray-300">';
            html += '<span class="fin-week-status-dot ' + dotClass + '"></span>';
            html += statusText;
            html += '</span>';
            html += '</div>';
        });
        html += '</div>';

        // 向右滚动按钮
        html += '<button class="week-nav-btn px-3 py-1.5 bg-torn-bg hover:bg-torn-accent hover:text-white rounded transition-colors text-lg font-bold" data-action="scroll-right" title="向右滚动">»</button>';
        
        // 回到本周按钮
        if (!isCurrentWeekSelected) {
            html += '<button class="week-today-btn px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs transition-colors whitespace-nowrap" data-action="goto-today">回到本周</button>';
        }
        html += '</div>';

        return html;
    },

    _bindWeekSelectorEvents: function() {
        var self = this;

        // 清理旧事件监听器
        if (self._weekNavPrevHandler) {
            var oldPrevBtn = document.querySelector('[data-action="prev-week"]');
            if (oldPrevBtn) oldPrevBtn.removeEventListener('click', self._weekNavPrevHandler);
        }
        if (self._weekNavNextHandler) {
            var oldNextBtn = document.querySelector('[data-action="next-week"]');
            if (oldNextBtn) oldNextBtn.removeEventListener('click', self._weekNavNextHandler);
        }
        if (self._scrollLeftHandler) {
            var oldLeftBtn = document.querySelector('[data-action="scroll-left"]');
            if (oldLeftBtn) oldLeftBtn.removeEventListener('click', self._scrollLeftHandler);
        }
        if (self._scrollRightHandler) {
            var oldRightBtn = document.querySelector('[data-action="scroll-right"]');
            if (oldRightBtn) oldRightBtn.removeEventListener('click', self._scrollRightHandler);
        }
        if (self._weekNavTodayHandler) {
            var oldTodayBtn = document.querySelector('[data-action="goto-today"]');
            if (oldTodayBtn) oldTodayBtn.removeEventListener('click', self._weekNavTodayHandler);
        }
        if (self._weekTabClickHandler) {
            var oldTabsContainer = document.getElementById('week-tabs-list');
            if (oldTabsContainer) oldTabsContainer.removeEventListener('click', self._weekTabClickHandler);
        }

        // 向左滚动按钮
        var leftBtn = document.querySelector('[data-action="scroll-left"]');
        if (leftBtn) {
            self._scrollLeftHandler = function() {
                var tabsContainer = document.getElementById('week-tabs-list');
                if (tabsContainer) {
                    tabsContainer.scrollBy({ left: -300, behavior: 'smooth' });
                }
            };
            leftBtn.addEventListener('click', self._scrollLeftHandler);
        }

        // 向右滚动按钮
        var rightBtn = document.querySelector('[data-action="scroll-right"]');
        if (rightBtn) {
            self._scrollRightHandler = function() {
                var tabsContainer = document.getElementById('week-tabs-list');
                if (tabsContainer) {
                    tabsContainer.scrollBy({ left: 300, behavior: 'smooth' });
                }
            };
            rightBtn.addEventListener('click', self._scrollRightHandler);
        }

        // 回到本周按钮
        var todayBtn = document.querySelector('[data-action="goto-today"]');
        if (todayBtn) {
            self._weekNavTodayHandler = async function() {
                await self._navigateToWeek(Utils.weekKey());
            };
            todayBtn.addEventListener('click', self._weekNavTodayHandler);
        }

        // 周 Tab 点击切换
        var tabsContainer = document.getElementById('week-tabs-list');
        if (tabsContainer) {
            self._weekTabClickHandler = async function(e) {
                var tab = e.target.closest('.fin-week-tab');
                if (tab) {
                    var wk = tab.dataset.weekKey;
                    if (wk && wk !== self.selectedWeekKey) {
                        await self._navigateToWeek(wk);
                    }
                }
            };
            tabsContainer.addEventListener('click', self._weekTabClickHandler);

            // 自动将选中的周 Tab 滚动到可视区域中央
            setTimeout(function() {
                var activeTab = tabsContainer.querySelector('.fin-week-tab.active');
                if (activeTab) {
                    activeTab.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'center' });
                }
            }, 10);
        }
    },

    _getCurrentMonthKey() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    },

    _prevMonth() {
        const parts = this.selectedMonthKey.split('-');
        let year = parseInt(parts[0], 10);
        let month = parseInt(parts[1], 10);
        month--;
        if (month < 1) {
            month = 12;
            year--;
        }
        this.selectedMonthKey = `${year}-${String(month).padStart(2, '0')}`;
    },

    _nextMonth() {
        const parts = this.selectedMonthKey.split('-');
        let year = parseInt(parts[0], 10);
        let month = parseInt(parts[1], 10);
        month++;
        if (month > 12) {
            month = 1;
            year++;
        }
        const nextKey = `${year}-${String(month).padStart(2, '0')}`;
        if (nextKey <= this._getCurrentMonthKey()) {
            this.selectedMonthKey = nextKey;
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
                        record.is_manual_tax = true;
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
                            is_manual_tax: true,
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

        // 窗口尺寸变化事件：动态调整显示的周 Tab 数量
        if (!this._resizeHandlerBound) {
            window.addEventListener('resize', Utils.debounce(() => {
                if (window.Router && window.Router.currentPage === 'finance' && this.activeTab === 'tax') {
                    this.render();
                }
            }, 150));
            this._resizeHandlerBound = true;
        }

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
                    const newCat = e.target.value;
                    const playerTaxRate = this._getEmployeeTaxRate(tx.player_id);

                    if (newCat === 'tax' && playerTaxRate > 0 && tx.amount > playerTaxRate) {
                        const originalValue = tx.category;

                        let trainPrice = null;
                        try {
                            const priceCfg = await DB.get('training_config', 'train_price');
                            if (priceCfg && priceCfg.value !== undefined) {
                                trainPrice = priceCfg.value;
                            }
                        } catch (e) {}

                        // Prepare in-memory tx properties
                        tx.category = 'tax';

                        this._showBulkTaxSplitModal([{ tx, taxAmount: playerTaxRate }], [], trainPrice);

                        // Hook cleanup and listeners
                        const cleanup = () => {
                            tx.category = originalValue;
                            this.render();
                            removeListeners();
                        };
                        const removeListeners = () => {
                            document.removeEventListener('keydown', handleEsc);
                            document.getElementById('modal-overlay')?.removeEventListener('click', handleOverlayClick);
                            confirmBtn?.removeEventListener('click', handleConfirmClick);
                        };
                        const handleEsc = (e) => {
                            if (e.key === 'Escape') cleanup();
                        };
                        const handleOverlayClick = (e) => {
                            if (e.target === e.currentTarget) cleanup();
                        };
                        const handleConfirmClick = () => {
                            removeListeners();
                        };

                        document.addEventListener('keydown', handleEsc);
                        document.getElementById('modal-overlay')?.addEventListener('click', handleOverlayClick);

                        const confirmBtn = document.getElementById('split-tax-confirm');
                        if (confirmBtn) {
                            confirmBtn.addEventListener('click', handleConfirmClick);
                        }
                        const cancelBtn = document.getElementById('split-tax-cancel');
                        if (cancelBtn) {
                            cancelBtn.addEventListener('click', () => {
                                cleanup();
                            });
                        }
                        return;
                    }

                    var oldWeekKey = tx.week_key;
                    tx.category = newCat;
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
                case 'prev-month':
                    this._prevMonth();
                    await this.render();
                    break;
                case 'next-month':
                    this._nextMonth();
                    await this.render();
                    break;
                case 'goto-current-month':
                    this.selectedMonthKey = this._getCurrentMonthKey();
                    await this.render();
                    break;
                case 'view-month-expense':
                    await this._showMonthExpenseDetails();
                    break;
                case 'view-month-income':
                    await this._showMonthIncomeDetails();
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
                case 'allocate-train-fund':
                    await this._allocateTrainFund();
                    break;
                case 'delete-train-fund':
                    await this._deleteTrainFundAllocation(btn.dataset.allocationId);
                    break;
            }
        };
        c.addEventListener('click', this._clickHandler);

        // Tab switching via tabNav (scoped to finance-tabs to prevent cross-page event leak)
        const tabContainer = document.getElementById('finance-tabs');
        if (tabContainer) {
            if (this._tabHandler) tabContainer.removeEventListener('click', this._tabHandler);
            this._tabHandler = (e) => {
                const tabItem = e.target.closest('.tab-item[data-tab]');
                if (!tabItem) return;
                this.activeTab = tabItem.dataset.tab;
                this.render();
            };
            tabContainer.addEventListener('click', this._tabHandler);
        }

        // Init sortable tables
        UI.initSortable('transactions-table');
        UI.initSortable('tax-table');
        UI.initSortable('train-fund-table');
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
        await this._refreshWeekTaxStatus(weekKey);
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
        await this._refreshWeekTaxStatus(weekKey);
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
        const tx = this.transactions.find(t => Number(t.id) === Number(txId));
        await DB.delete('transactions', txId);
        
        if (tx && tx.week_key && tx.week_key !== '__unassigned__') {
            await this._cascadeRecalculate(tx.week_key);
        }
        
        if (tx?.category === 'boost') {
            await Utils.reconcileBoostSellersFromTransactions();
        }
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
        
        let hadBoost = false;
        const affectedWeeks = {};
        for (const cb of checkboxes) {
            const txId = Number(cb.dataset.txId);
            const tx = this.transactions.find(t => Number(t.id) === txId);
            if (tx?.category === 'boost') hadBoost = true;
            if (tx && tx.week_key && tx.week_key !== '__unassigned__') {
                affectedWeeks[tx.week_key] = true;
            }
            await DB.delete('transactions', txId);
        }
        if (hadBoost) await Utils.reconcileBoostSellersFromTransactions();
        
        const sortedWeeks = Object.keys(affectedWeeks).sort();
        if (sortedWeeks.length > 0) {
            await this._cascadeRecalculate(sortedWeeks[0]);
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
                        ${Utils.transactionCategoryOptions('other')}
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

            // When targeting 'tax', detect over-amount items based on employee-specific tax rates
            if (newCat === 'tax') {
                const allSelected = [];
                for (const cb of checkboxes) {
                    const txId = Number(cb.dataset.txId);
                    const tx = this.transactions.find(t => t.id === txId);
                    if (tx) allSelected.push(tx);
                }

                const overTaxItems = [];
                const directTaxItems = [];

                for (const tx of allSelected) {
                    const playerTaxRate = this._getEmployeeTaxRate(tx.player_id);
                    if (playerTaxRate > 0 && tx.amount > playerTaxRate) {
                        overTaxItems.push({ tx, taxAmount: playerTaxRate });
                    } else {
                        directTaxItems.push(tx);
                    }
                }

                if (overTaxItems.length > 0) {
                    Utils.hideModal();
                    let trainPrice = null;
                    try {
                        const priceCfg = await DB.get('training_config', 'train_price');
                        if (priceCfg && priceCfg.value !== undefined) {
                            trainPrice = priceCfg.value;
                        }
                    } catch (e) {}
                    this._showBulkTaxSplitModal(overTaxItems, directTaxItems, trainPrice);
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
            // 对所有受影响 of 周进行级联重算
            var bulkSortedWeeks = Object.keys(bulkAffectedWeeks).sort();
            if (bulkSortedWeeks.length > 0) {
                await this._cascadeRecalculate(bulkSortedWeeks[0]);
            }
            Utils.toast(`已成功修改 ${updated} 条记录的分类`, 'success');
            Utils.hideModal();
            await this.render();
        });
    },

    _showBulkTaxSplitModal(overTaxItems, directTaxItems, trainPrice = null) {
        var self = this;
        // Build rows: one per over-tax item
        const rowHTML = overTaxItems.map(({ tx, taxAmount }) => {
            const remaining = tx.amount - taxAmount;
            const defaultCat = (trainPrice !== null && remaining >= trainPrice) ? 'train' : 'other';
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
                        <option value="train" ${defaultCat === 'train' ? 'selected' : ''}>训练</option>
                        <option value="boost">Boost</option>
                        <option value="other" ${defaultCat === 'other' ? 'selected' : ''}>其他</option>
                    </select>
                    <input type="hidden" class="split-remainder-amount" value="${remaining}" />
                </div>
            `;
        }).join('');

        const directCount = directTaxItems.length;
        const directNote = directCount > 0
            ? `<div class="text-gray-400 text-sm mb-2">另有 <span class="text-torn-accent">${directCount}</span> 条记录将直接设为"税务"（无需拆分）</div>`
            : '';

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-2">智能拆分建议</h3>
                <div class="text-gray-400 text-sm mb-4">
                    以下 <span class="text-torn-accent font-bold">${overTaxItems.length}</span> 条记录金额超过对应的员工税务配置，建议拆分为税务 + 其他分类
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

            for (const { tx, taxAmount } of overTaxItems) {
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
            for (const { tx } of overTaxItems) {
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
        const sortedEmployeesForTx = [...this.employees].sort((a, b) => {
            if (a.left_date && !b.left_date) return 1;
            if (!a.left_date && b.left_date) return -1;
            return a.name.localeCompare(b.name);
        });
        const empOptions = sortedEmployeesForTx.map(e => {
            const nameLabel = e.left_date ? `${e.name}（已离职）` : e.name;
            return `<option value="${e.player_id}">${nameLabel}</option>`;
        }).join('');

        const html = `
            <div class="p-6">
                <h3 class="text-lg font-bold text-white mb-4">添加交易</h3>
                <div class="space-y-4">
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">日期</label>
                        <input type="date" class="input" id="modal-tx-date" value="${Utils.todayKey()}" />
                    </div>
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
                            ${Utils.transactionCategoryOptions('other')}
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
            const dateStr = document.getElementById('modal-tx-date')?.value || Utils.todayKey();
            let ts = Date.now();
            if (dateStr !== Utils.todayKey()) {
                const d = new Date(dateStr);
                if (!isNaN(d.getTime())) {
                    ts = d.getTime();
                }
            }
            const tx = {
                player_id: empId,
                player_name: emp?.name || '',
                date: dateStr,
                timestamp: ts,
                amount: Utils.parseMoneyInput(document.getElementById('modal-tx-amount')?.value),
                category: document.getElementById('modal-tx-cat')?.value || 'other',
                note: document.getElementById('modal-tx-note')?.value || ''
            };

            const playerTaxRate = this._getEmployeeTaxRate(empId);

            if (tx.category === 'tax' && playerTaxRate > 0 && tx.amount > playerTaxRate) {
                // Save it first to get an ID so the split modal can delete it
                tx.week_key = this._autoMatchWeek(tx);
                const savedId = await DB.put('transactions', tx);
                tx.id = savedId;

                Utils.hideModal();
                let trainPrice = null;
                try {
                    const priceCfg = await DB.get('training_config', 'train_price');
                    if (priceCfg && priceCfg.value !== undefined) {
                        trainPrice = priceCfg.value;
                    }
                } catch (e) {}
                this._showBulkTaxSplitModal([{ tx, taxAmount: playerTaxRate }], [], trainPrice);
                return;
            }

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
                        <label class="text-gray-400 text-sm mb-1 block">日期</label>
                        <input type="date" class="input" id="modal-edit-date" value="${tx.date || Utils.todayKey()}" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">金额 ($)</label>
                        <input type="text" class="input money-input" id="modal-edit-amount" value="${tx.amount || 0}" placeholder="支持 k/m/b 后缀" />
                    </div>
                    <div>
                        <label class="text-gray-400 text-sm mb-1 block">分类</label>
                        <select class="input" id="modal-edit-cat">
                            ${Utils.transactionCategoryOptions(tx.category || 'other')}
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
            const amount = Utils.parseMoneyInput(document.getElementById('modal-edit-amount')?.value);
            const category = document.getElementById('modal-edit-cat')?.value || 'other';
            const note = document.getElementById('modal-edit-note')?.value || '';
            const dateStr = document.getElementById('modal-edit-date')?.value;

            const playerTaxRate = this._getEmployeeTaxRate(tx.player_id);

            // Update in-memory properties first so they are ready for split or save
            tx.amount = amount;
            tx.category = category;
            tx.note = note;
            if (dateStr && dateStr !== tx.date) {
                tx.date = dateStr;
                const d = new Date(dateStr);
                if (!isNaN(d.getTime())) {
                    tx.timestamp = d.getTime();
                }
            }

            if (category === 'tax' && playerTaxRate > 0 && amount > playerTaxRate) {
                Utils.hideModal();
                let trainPrice = null;
                try {
                    const priceCfg = await DB.get('training_config', 'train_price');
                    if (priceCfg && priceCfg.value !== undefined) {
                        trainPrice = priceCfg.value;
                    }
                } catch (e) {}
                this._showBulkTaxSplitModal([{ tx, taxAmount: playerTaxRate }], [], trainPrice);
                return;
            }

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
                        ${Utils.transactionCategoryOptions('train')}
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

            const activeEmployees = this.employees.filter(e => !e.left_date);
            const currentEmployeeIds = new Set(activeEmployees.map(e => String(e.player_id)));

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
            const deduped = this._deduplicateTrades(allRelevant, existingLogIds);

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
                            ${activeEmployees.map(e => `<option value="${e.player_id}">${e.name}</option>`).join('')}
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

    _deduplicateTrades(allRelevant, existingLogIds) {
        if (!existingLogIds) {
            existingLogIds = new Set((this.transactions || []).map(t => String(t.log_id)).filter(id => id && id !== 'undefined'));
        }
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
            // Skip if this trade is already in the database
            if (existingLogIds.has(`trade_final_${tradeId}`)) {
                continue;
            }

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

            // Aggregate money and items from final transfer steps (4440, 4441, 4445, 4446)
            let totalMoney = 0;
            const allItems = [];
            const traderUser = steps[0]?.entry?.data?.user || 0;

            const transferSteps = steps.filter(s => {
                const type = s.entry?.details?.id || 0;
                return type === 4440 || type === 4441 || type === 4445 || type === 4446;
            });

            if (transferSteps.length > 0) {
                for (const step of transferSteps) {
                    const d = step.entry?.data || {};
                    if (d.money) totalMoney += d.money;
                    if (d.items) allItems.push(...d.items);
                }
            } else {
                // Fallback: if there are no transfer steps in the logs (e.g. truncated logs),
                // aggregate from workspace steps but exclude completion/acceptance/initiation
                for (const step of steps) {
                    const logType = step.entry?.details?.id || 0;
                    if (logType === 4430 || logType === 4431 || logType === 4400 || logType === 4401) continue;

                    const d = step.entry?.data || {};
                    if (d.money) totalMoney += d.money;
                    if (d.items) allItems.push(...d.items);
                }
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
            const startOfWeek = Utils.startOfCalendarWeek(now);
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
    },

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
