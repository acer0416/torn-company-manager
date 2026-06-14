// Training Planner Page - 训练规划工具（移植自 TrainingManager.exe）
// 为每位员工计算最优训练岗位，最大化目标岗位效率提升
// 改造版：自动从 IndexedDB 加载数据，减少 API 调用
window.TrainingPlannerPage = (() => {
  'use strict';

  let _hasBus2110 = false;

  // ---- 效率计算引擎（移植自 TrainingManager efficiency.py）----

  /**
   * 计算员工在某岗位的效率值
   * 公式: min(45, p_stat/p_req*45) + min(45, s_stat/s_req*45) + 5*log2(excess_p) + 5*log2(excess_s)
   * @param {number} pStat 主属性值
   * @param {number} pReq 主属性需求
   * @param {number} sStat 副属性值
   * @param {number} sReq 副属性需求
   * @returns {number} 效率值（0-100+）
   */
  function calculateEfficiency(pStat, pReq, sStat, sReq) {
    try {
      const pBase = pReq > 0 ? Math.min(45, (pStat / pReq) * 45) : 0;
      const sBase = sReq > 0 ? Math.min(45, (sStat / sReq) * 45) : 0;
      const mult = _hasBus2110 ? BUS2110_EFFICIENCY_MULTIPLIER : 1.0;
      const pBonus = (pStat > pReq && pReq > 0) ? Math.floor(5 * Math.log2((pStat / pReq) * mult)) : 0;
      const sBonus = (sStat > sReq && sReq > 0) ? Math.floor(5 * Math.log2((sStat / sReq) * mult)) : 0;
      return pBase + sBase + pBonus + sBonus;
    } catch {
      return 0;
    }
  }

  /**
   * 平滑效率计算（不 floor），用于规划器计算边际改进量
   */
  function calculateEfficiencySmooth(pStat, pReq, sStat, sReq) {
    try {
      const pBase = pReq > 0 ? Math.min(45, (pStat / pReq) * 45) : 0;
      const sBase = sReq > 0 ? Math.min(45, (sStat / sReq) * 45) : 0;
      const mult = _hasBus2110 ? BUS2110_EFFICIENCY_MULTIPLIER : 1.0;
      const pBonus = (pStat > pReq && pReq > 0) ? 5 * Math.log2((pStat / pReq) * mult) : 0;
      const sBonus = (sStat > sReq && sReq > 0) ? 5 * Math.log2((sStat / sReq) * mult) : 0;
      return pBase + sBase + pBonus + sBonus;
    } catch {
      return 0;
    }
  }

  /**
   * 模拟训练后的属性变化
   */
  function simulateTrain(stats, gainPrimaryStat, gainSecondaryStat) {
    const newStats = { ...stats };
    if (gainPrimaryStat in newStats) newStats[gainPrimaryStat] += TRAIN_PRIMARY_BONUS;
    if (gainSecondaryStat in newStats) newStats[gainSecondaryStat] += TRAIN_SECONDARY_BONUS;
    return newStats;
  }

  /**
   * 计算理论最高效能（去除负面削减，settled_in 设为 10）
   */
  function _calcTheoreticalMaxEffectiveness(emp) {
    const eff = emp.effectiveness_detail || {};
    const working_stats = eff.working_stats ?? 0;
    const settled_in = 10;
    const book = eff.book ?? 0;
    const merits = eff.merits ?? 0;
    const director_education = eff.director_education ?? 0;
    const management = eff.management ?? 0;
    return working_stats + settled_in + book + merits + director_education + management;
  }

  /**
   * 为一名员工找到最优训练岗位
   * @param {Object} emp 员工 { manual_labor, intelligence, endurance }
   * @param {Object} targetJob 目标岗位 { primary_req_stat, primary_req_value, secondary_req_stat, secondary_req_value }
   * @param {Array} allJobs 该公司所有岗位
   * @returns {Object} { bestJobName, bestImprovement, allResults, currentEff, currentStats }
   */
  function findBestTrainingJob(emp, targetJob, allJobs) {
    const currentStats = {
      MAN: emp.manual_labor || 0,
      INT: emp.intelligence || 0,
      END: emp.endurance || 0,
    };
    const currentEff = calculateEfficiency(
      currentStats[targetJob.primary_req_stat], targetJob.primary_req_value,
      currentStats[targetJob.secondary_req_stat], targetJob.secondary_req_value
    );
    const currentEffSmooth = calculateEfficiencySmooth(
      currentStats[targetJob.primary_req_stat], targetJob.primary_req_value,
      currentStats[targetJob.secondary_req_stat], targetJob.secondary_req_value
    );

    const currentPosition = emp.position || '';
    let bestJobName = null;
    let bestImprovement = -999;
    const allResults = [];

    for (const job of allJobs) {
      const newStats = simulateTrain(currentStats, job.primary_gain_stat, job.secondary_gain_stat);
      const newEff = calculateEfficiency(
        newStats[targetJob.primary_req_stat], targetJob.primary_req_value,
        newStats[targetJob.secondary_req_stat], targetJob.secondary_req_value
      );
      const newEffSmooth = calculateEfficiencySmooth(
        newStats[targetJob.primary_req_stat], targetJob.primary_req_value,
        newStats[targetJob.secondary_req_stat], targetJob.secondary_req_value
      );
      const improvement = newEffSmooth - currentEffSmooth;
      allResults.push({
        jobName: job.name,
        primaryGain: job.primary_gain_stat,
        secondaryGain: job.secondary_gain_stat,
        improvement
      });
      // 效率提升更大时更新；提升相同时（浮点误差 1e-6）优先选择员工当前岗位
      if (improvement > bestImprovement + 1e-6 ||
          (Math.abs(improvement - bestImprovement) < 1e-6 && job.name === currentPosition && bestJobName !== currentPosition)) {
        bestImprovement = improvement;
        bestJobName = job.name;
      }
    }

    allResults.sort((a, b) => b.improvement - a.improvement);

    // 计算最佳训练岗位的 10 次训练效果
    const bestJob = allJobs.find(j => j.name === bestJobName);
    let improvement10 = 0;
    let trainingsForPlus1 = Infinity;

    if (bestJob) {
      // 模拟 10 次训练
      let stats10 = { ...currentStats };
      for (let i = 0; i < 10; i++) {
        stats10 = simulateTrain(stats10, bestJob.primary_gain_stat, bestJob.secondary_gain_stat);
      }
      const eff10Smooth = calculateEfficiencySmooth(
        stats10[targetJob.primary_req_stat], targetJob.primary_req_value,
        stats10[targetJob.secondary_req_stat], targetJob.secondary_req_value
      );
      improvement10 = eff10Smooth - currentEffSmooth;

      // 计算多少次训练后效率增加 1 点（平滑值）
      const targetEff = currentEffSmooth + 1.0;
      let statsN = { ...currentStats };
      for (let n = 1; n <= 10000; n++) {
        statsN = simulateTrain(statsN, bestJob.primary_gain_stat, bestJob.secondary_gain_stat);
        const effNSmooth = calculateEfficiencySmooth(
          statsN[targetJob.primary_req_stat], targetJob.primary_req_value,
          statsN[targetJob.secondary_req_stat], targetJob.secondary_req_value
        );
        if (effNSmooth >= targetEff - 1e-6) {
          trainingsForPlus1 = n;
          break;
        }
      }
    }

    return { bestJobName, bestImprovement, allResults, currentEff, currentStats, improvement10, trainingsForPlus1 };
  }

  // ---- 页面状态 ----
  let _employees = [];
  let _companyTypeId = null;
  let _planResults = [];
  let _eventsBound = false;
  let _dataSource = ''; // 标记数据来源: 'db' | 'api'

  // ---- 内部方法 ----

  function _getSelectedCompanyTypeId() {
    const sel = document.getElementById('tp-company-type');
    return sel ? parseInt(sel.value, 10) : null;
  }

  function _getTargetJobName(empId) {
    const sel = document.getElementById(`tp-target-${empId}`);
    return sel ? sel.value : null;
  }

  function _formatEff(v) {
    return typeof v === 'number' && !isNaN(v) ? Math.round(v) : 'N/A';
  }

  function _formatImprovement(v) {
    if (typeof v !== 'number' || v <= -999) return 'N/A';
    if (v === 0) return '+0.00';
    if (Math.abs(v) < 0.01) return `+${v.toFixed(4)}`;
    if (Math.abs(v) < 1) return `+${v.toFixed(2)}`;
    return `+${v.toFixed(2)}`;
  }

  function _formatSummaryValue(v) {
    if (typeof v !== 'number' || isNaN(v)) return '0';
    if (v === 0) return '0';
    if (Math.abs(v) < 0.01) return v.toFixed(4);
    return v.toFixed(2);
  }

  function _formatTrainingCount(v) {
    return typeof v === 'number' && v > 0 ? v : '∞';
  }

  function _statBadge(stat, value) {
    const colors = { MAN: 'text-orange-400', INT: 'text-blue-400', END: 'text-green-400' };
    return `<span class="${colors[stat] || 'text-gray-400'} font-mono">${value.toLocaleString()}</span>`;
  }

  // ---- 数据持久化 ----

  /**
   * 从 IndexedDB employee_history 读取最新一批员工数据
   * @returns {boolean} 是否成功加载
   */
  async function _loadFromDB() {
    try {
      const allHistory = await DB.getAll('employee_history');
      if (!allHistory || allHistory.length === 0) return false;

      // 按日期降序找到最新日期的记录
      let latestDate = '';
      for (const r of allHistory) {
        if (r.date && r.date > latestDate) latestDate = r.date;
      }
      if (!latestDate) return false;

      const latestRecords = allHistory.filter(r => r.date === latestDate);
      if (latestRecords.length === 0) return false;

      // 去重：每个 player_id 只保留一条记录（后写入的覆盖先写入的）
      const dedupedMap = new Map();
      for (const r of latestRecords) {
        dedupedMap.set(String(r.player_id), r);
      }

      // 转换为 TrainingPlanner 内部格式
      _employees = Array.from(dedupedMap.values()).map(r => ({
        player_id: String(r.player_id),
        name: r.name || `ID:${r.player_id}`,
        position: r.position || '',
        manual_labor: r.stats?.manual_labor ?? r.manual_labor ?? 0,
        intelligence: r.stats?.intelligence ?? r.intelligence ?? 0,
        endurance: r.stats?.endurance ?? r.endurance ?? 0,
        effectiveness: r.effectiveness || 0,
        effectiveness_detail: r.effectiveness_detail || {},
      }));

      console.log(`[TrainingPlanner] 从 DB 加载 ${_employees.length} 名员工 (日期: ${latestDate})`);
      return true;
    } catch (err) {
      console.warn('[TrainingPlanner] 从 DB 加载失败:', err.message);
      return false;
    }
  }

  /**
   * 将员工数据写入 employee_history store（与 EmployeePage 格式一致）
   * 采用去重策略：如果今天已有数据则跳过
   * @param {Array} employees - API 返回的原始员工数据
   */
  async function _saveToDB(employees) {
    try {
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      // 检查今天是否已有数据（避免重复写入）
      const todayRecords = await DB.getByIndex('employee_history', 'date', today);
      if (todayRecords && todayRecords.length > 0) {
        console.log(`[TrainingPlanner] 今天已有 ${todayRecords.length} 条记录，跳过写入`);
        return;
      }

      // 写入新数据（格式与 EmployeePage 一致）
      for (const e of employees) {
        await DB.put('employee_history', {
          player_id: Number(e.id || e.player_id),
          date: today,
          name: e.name || '',
          position: e.position?.name || e.position || '',
          days_in_company: e.days_in_company || 0,
          effectiveness: typeof e.effectiveness === 'object' ? (e.effectiveness.total || 0) : (parseInt(e.effectiveness) || 0),
          wage: e.wage || 0,
          status: e.status?.state || '',
          stats: {
            manual_labor: parseInt(e.stats?.manual_labor ?? e.manual_labor) || 0,
            intelligence: parseInt(e.stats?.intelligence ?? e.intelligence) || 0,
            endurance: parseInt(e.stats?.endurance ?? e.endurance) || 0
          },
          effectiveness_detail: typeof e.effectiveness === 'object' ? e.effectiveness : {}
        });
      }
      console.log(`[TrainingPlanner] 已写入 ${employees.length} 名员工到 employee_history (${today})`);
    } catch (err) {
      console.warn('[TrainingPlanner] 写入 employee_history 失败:', err.message);
    }
  }

  /**
   * 从 DB 加载保存的公司类型
   */
  async function _loadSavedCompanyType() {
    try {
      const saved = await DB.get('settings', 'training_planner_company_type');
      if (saved && saved.value && COMPANY_JOBS[saved.value]) {
        _companyTypeId = saved.value;
        return true;
      }
    } catch (err) {
      console.warn('[TrainingPlanner] 加载保存的公司类型失败:', err.message);
    }
    return false;
  }

  /**
   * 持久化公司类型到 DB settings
   */
  async function _persistCompanyType(typeId) {
    try {
      await DB.put('settings', { key: 'training_planner_company_type', value: typeId });
    } catch (err) {
      console.warn('[TrainingPlanner] 保存公司类型失败:', err.message);
    }
  }

  // ---- UI 构建 ----

  function _companyTypeSelectorHTML() {
    const options = Object.entries(COMPANY_JOBS)
      .map(([id, c]) => `<option value="${id}" ${parseInt(id) === _companyTypeId ? 'selected' : ''}>${id} - ${c.company_name}</option>`)
      .join('');
    return `
      <div class="flex flex-wrap items-end gap-4 mb-4">
        <div>
          <label class="block text-xs text-gray-400 mb-1">公司行业类型</label>
          <select id="tp-company-type" class="bg-torn-surface border border-torn-border rounded px-3 py-1.5 text-sm text-gray-200 min-w-[220px]">
            ${options}
          </select>
        </div>
        <button id="tp-fetch-btn" class="bg-torn-accent hover:bg-torn-accent/80 text-white px-4 py-1.5 rounded text-sm transition">
          <i class="fas fa-download mr-1"></i>刷新员工数据
        </button>
        <button id="tp-plan-btn" class="bg-green-600 hover:bg-green-700 text-white px-4 py-1.5 rounded text-sm transition hidden">
          <i class="fas fa-calculator mr-1"></i>规划训练
        </button>
        <button id="tp-export-btn" class="bg-gray-600 hover:bg-gray-700 text-white px-4 py-1.5 rounded text-sm transition hidden">
          <i class="fas fa-file-export mr-1"></i>导出报告
        </button>
        <span id="tp-status" class="text-xs text-gray-400 self-center"></span>
      </div>
    `;
  }

  function _employeeTableHTML() {
    if (!_employees.length) {
      return '<div class="text-center text-gray-500 py-10"><i class="fas fa-users text-3xl mb-3 block"></i>正在加载员工数据...</div>';
    }

    const companyData = COMPANY_JOBS[_companyTypeId];
    const jobNames = companyData ? companyData.jobs.map(j => j.name) : [];
    const jobOptions = jobNames.map(n => `<option value="${n}">${n}</option>`).join('');

    const rows = _employees.map(emp => {
      const posName = emp.position || emp._positionName || 'N/A';
      // 查找当前规划结果
      const plan = _planResults.find(p => p.empId === emp.player_id);
      const bestJob = plan ? plan.bestJobName : '';
      const improvement10 = plan ? plan.improvement10 : null;
      const trainingsForPlus1 = plan ? plan.trainingsForPlus1 : null;
      const currentEff = plan ? plan.currentEff : null;
      const targetJobName = plan?.targetJobName || posName;
      const maxEff = _calcTheoreticalMaxEffectiveness(emp);

      return `<tr class="border-t border-torn-border/50 hover:bg-torn-surface/50 transition">
        <td class="px-3 py-2 text-sm">${emp.name}</td>
        <td class="px-3 py-2 text-xs text-gray-400">${posName}</td>
        <td class="px-3 py-2 text-xs">${_statBadge('MAN', emp.manual_labor || 0)}</td>
        <td class="px-3 py-2 text-xs">${_statBadge('INT', emp.intelligence || 0)}</td>
        <td class="px-3 py-2 text-xs">${_statBadge('END', emp.endurance || 0)}</td>
        <td class="px-3 py-2 text-sm text-center font-mono ${currentEff > 80 ? 'text-green-400' : currentEff > 50 ? 'text-yellow-400' : 'text-red-400'}">${_formatEff(currentEff)}</td>
        <td class="px-3 py-2 text-sm text-center font-mono ${maxEff >= 100 ? 'text-green-400' : maxEff >= 80 ? 'text-yellow-400' : 'text-red-400'}">${maxEff}</td>
        <td class="px-3 py-2">
          <select id="tp-target-${emp.player_id}" class="tp-target-select bg-torn-surface border border-torn-border rounded px-2 py-1 text-xs text-gray-200 w-full max-w-[160px]">
            ${jobOptions.replace(`value="${targetJobName}"`, `value="${targetJobName}" selected`)}
          </select>
        </td>
        <td class="px-3 py-2 text-sm font-medium ${bestJob ? 'text-torn-accent' : 'text-gray-500'}">${bestJob || '—'}</td>
        <td class="px-3 py-2 text-sm text-center font-mono ${improvement10 > 0 ? 'text-green-400' : 'text-gray-500'}">${_formatImprovement(improvement10)}</td>
        <td class="px-3 py-2 text-sm text-center font-mono ${typeof trainingsForPlus1 === 'number' && trainingsForPlus1 <= 100 ? 'text-yellow-400' : 'text-gray-500'}">${plan ? _formatTrainingCount(trainingsForPlus1) : '—'}</td>
      </tr>`;
    }).join('');

    return `
      <div class="overflow-x-auto">
        <table class="w-full text-left">
          <thead>
            <tr class="text-xs text-gray-400 border-b border-torn-border">
              <th class="px-3 py-2 font-medium text-left">员工</th>
              <th class="px-3 py-2 font-medium text-left">当前岗位</th>
              <th class="px-3 py-2 font-medium text-left">MAN</th>
              <th class="px-3 py-2 font-medium text-left">INT</th>
              <th class="px-3 py-2 font-medium text-left">END</th>
              <th class="px-3 py-2 font-medium text-center">基础效率</th>
              <th class="px-3 py-2 font-medium text-center">理论最高</th>
              <th class="px-3 py-2 font-medium text-left">目标岗位</th>
              <th class="px-3 py-2 font-medium text-left">推荐训练</th>
              <th class="px-3 py-2 font-medium text-center">10次训练效果</th>
              <th class="px-3 py-2 font-medium text-center">训练至+1效率</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  function _summaryHTML() {
    if (!_planResults.length) return '';

    const hasPlan = _planResults.some(p => p.bestImprovement !== null);
    if (!hasPlan) return '';

    const avgImprovement = _planResults.reduce((s, p) => s + (p.bestImprovement > 0 ? p.bestImprovement : 0), 0) / _planResults.length;
    const maxImprovement = Math.max(..._planResults.map(p => p.bestImprovement || 0));
    const bestEmp = _planResults.find(p => p.bestImprovement === maxImprovement);

    // 统计推荐训练岗位分布
    const jobDistribution = {};
    _planResults.forEach(p => {
      if (p.bestJobName) {
        jobDistribution[p.bestJobName] = (jobDistribution[p.bestJobName] || 0) + 1;
      }
    });
    const distHTML = Object.entries(jobDistribution)
      .sort((a, b) => b[1] - a[1])
      .map(([job, count]) => `<span class="inline-block bg-torn-surface border border-torn-border rounded px-2 py-0.5 text-xs mr-1 mb-1">${job}: <strong class="text-torn-accent">${count}</strong>人</span>`)
      .join('');

    return `
      <div class="bg-torn-card border border-torn-border rounded-lg p-4 mt-4">
        <h3 class="text-sm font-medium text-gray-300 mb-3"><i class="fas fa-chart-pie mr-1 text-torn-accent"></i>规划摘要</h3>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
          <div class="bg-torn-surface rounded p-3">
            <div class="text-xs text-gray-400">平均效率提升</div>
            <div class="text-lg font-bold text-green-400">+${_formatSummaryValue(avgImprovement)}</div>
          </div>
          <div class="bg-torn-surface rounded p-3">
            <div class="text-xs text-gray-400">最大效率提升</div>
            <div class="text-lg font-bold text-torn-accent">+${_formatSummaryValue(maxImprovement)}</div>
            <div class="text-xs text-gray-500">${bestEmp?.empName || ''}</div>
          </div>
          <div class="bg-torn-surface rounded p-3">
            <div class="text-xs text-gray-400">规划员工数</div>
            <div class="text-lg font-bold text-white">${_planResults.length}</div>
          </div>
        </div>
        <div>
          <div class="text-xs text-gray-400 mb-1">训练岗位分布：</div>
          <div>${distHTML}</div>
        </div>
      </div>
    `;
  }

  function _buildHTML() {
    return `
      <div class="mb-4">
        <h2 class="text-lg font-bold text-white"><i class="fas fa-brain mr-2 text-torn-accent"></i>训练规划</h2>
        <p class="text-xs text-gray-400 mt-1">基于效率公式计算每位员工的最优训练岗位（移植自 TrainingManager）</p>
      </div>
      ${_companyTypeSelectorHTML()}
      <div id="tp-employee-table">${_employeeTableHTML()}</div>
      ${_summaryHTML()}
    `;
  }

  // ---- 事件绑定 ----

  function _bindEvents() {
    if (_eventsBound) return;
    _eventsBound = true;

    const container = document.getElementById('page-content');
    if (!container) return;

    // 获取员工数据（手动刷新，强制从 API 获取）
    container.addEventListener('click', async (e) => {
      if (Router.currentPage !== 'training-planner') return;
      const btn = e.target.closest('#tp-fetch-btn');
      if (!btn) return;
      await _fetchFromAPI(true);
    });

    // 规划训练
    container.addEventListener('click', async (e) => {
      if (Router.currentPage !== 'training-planner') return;
      const btn = e.target.closest('#tp-plan-btn');
      if (!btn) return;
      _runPlan();
    });

    // 导出报告
    container.addEventListener('click', (e) => {
      if (Router.currentPage !== 'training-planner') return;
      const btn = e.target.closest('#tp-export-btn');
      if (!btn) return;
      _exportReport();
    });

    // 公司类型变更（持久化到 DB）
    container.addEventListener('change', async (e) => {
      if (Router.currentPage !== 'training-planner') return;
      if (e.target.id === 'tp-company-type') {
        _companyTypeId = _getSelectedCompanyTypeId();
        if (_employees.length) {
          _calculateInitialEfficiencies();
        }
        _renderTable();
        // 持久化公司类型
        if (_companyTypeId) {
          await _persistCompanyType(_companyTypeId);
        }
      }
      // 目标岗位变更时重新计算该员工的基础效率
      if (e.target.classList.contains('tp-target-select')) {
        const empId = e.target.id.replace('tp-target-', '');
        const emp = _employees.find(e => e.player_id === empId);
        if (emp) {
          const companyData = COMPANY_JOBS[_companyTypeId];
          if (companyData) {
            const jobMap = {};
            companyData.jobs.forEach(j => { jobMap[j.name] = j; });
            const targetJob = jobMap[e.target.value] || companyData.jobs[0];
            const currentStats = {
              MAN: emp.manual_labor || 0,
              INT: emp.intelligence || 0,
              END: emp.endurance || 0,
            };
            const currentEff = calculateEfficiency(
              currentStats[targetJob.primary_req_stat], targetJob.primary_req_value,
              currentStats[targetJob.secondary_req_stat], targetJob.secondary_req_value
            );
            const planIdx = _planResults.findIndex(p => p.empId === empId);
            if (planIdx >= 0) {
              _planResults[planIdx].currentEff = currentEff;
              _planResults[planIdx].currentStats = currentStats;
              _planResults[planIdx].targetJobName = targetJob.name;
            }
            _renderTable();
          }
        }
      }
    });
  }

  // ---- 数据获取 ----

  /**
   * 从 API 获取员工数据（手动刷新或自动加载）
   * @param {boolean} forceRefresh - 是否强制刷新（清除 AppCache）
   */
  async function _fetchFromAPI(forceRefresh = false) {
    _companyTypeId = _getSelectedCompanyTypeId();
    const companyData = COMPANY_JOBS[_companyTypeId];
    if (!companyData) {
      Utils.toast('请选择有效的公司类型', 'warning');
      return;
    }

    const statusEl = document.getElementById('tp-status');
    const fetchBtn = document.getElementById('tp-fetch-btn');
    if (statusEl) statusEl.textContent = '正在获取员工数据...';
    if (fetchBtn) fetchBtn.disabled = true;

    try {
      // 强制刷新时清除缓存
      if (forceRefresh) {
        AppCache.invalidate('companyData');
      }

      // 获取公司完整数据（含 company_type 用于自动识别），使用 AppCache 缓存 5 分钟
      const data = await AppCache.getOrFetch('companyData', () => TornAPI.getCompanyData(), 5 * 60 * 1000);

      // 自动识别公司类型
      if (data.profile?.company_type != null) {
        const detectedType = data.profile.company_type;
        if (COMPANY_JOBS[detectedType]) {
          _companyTypeId = detectedType;
          const sel = document.getElementById('tp-company-type');
          if (sel) sel.value = detectedType;
          // 持久化公司类型
          await _persistCompanyType(detectedType);
        }
      }

      // 解析员工数据
      _employees = (data.employees || []).map(e => ({
        player_id: String(e.id || e.player_id),
        name: e.name || `ID:${e.id || e.player_id}`,
        position: e.position?.name || e.position || '',
        manual_labor: parseInt(e.stats?.manual_labor ?? e.manual_labor) || 0,
        intelligence: parseInt(e.stats?.intelligence ?? e.intelligence) || 0,
        endurance: parseInt(e.stats?.endurance ?? e.endurance) || 0,
        effectiveness: typeof e.effectiveness === 'object' ? (e.effectiveness.total || 0) : (parseInt(e.effectiveness) || 0),
        effectiveness_detail: typeof e.effectiveness === 'object' ? e.effectiveness : {},
      }));

      // 写入 employee_history 持久化
      await _saveToDB(data.employees || []);

      _dataSource = 'api';
      _calculateInitialEfficiencies();
      _renderTable();

      // 显示规划按钮
      const planBtn = document.getElementById('tp-plan-btn');
      const exportBtn = document.getElementById('tp-export-btn');
      if (planBtn) planBtn.classList.remove('hidden');
      if (exportBtn) exportBtn.classList.add('hidden');

      if (statusEl) statusEl.textContent = `获取成功: ${_employees.length} 名员工`;
      Utils.toast(`获取到 ${_employees.length} 名员工`, 'success');
    } catch (err) {
      if (statusEl) statusEl.textContent = '获取失败';
      Utils.toast('获取员工数据失败: ' + err.message, 'error');
    } finally {
      if (fetchBtn) fetchBtn.disabled = false;
    }
  }

  // ---- 训练规划 ----

  /**
   * 计算每位员工基于当前岗位的初始效率（不生成规划结果，只用于显示基础效率）
   */
  function _calculateInitialEfficiencies() {
    if (!_employees.length) return;

    const companyData = COMPANY_JOBS[_companyTypeId];
    if (!companyData) return;

    const allJobs = companyData.jobs;
    const jobMap = {};
    allJobs.forEach(j => { jobMap[j.name] = j; });

    _planResults = [];

    for (const emp of _employees) {
      const currentPosName = emp.position || '';
      const targetJob = jobMap[currentPosName] || allJobs[0];

      const currentStats = {
        MAN: emp.manual_labor || 0,
        INT: emp.intelligence || 0,
        END: emp.endurance || 0,
      };
      const currentEff = calculateEfficiency(
        currentStats[targetJob.primary_req_stat], targetJob.primary_req_value,
        currentStats[targetJob.secondary_req_stat], targetJob.secondary_req_value
      );

      _planResults.push({
        empId: emp.player_id,
        empName: emp.name,
        targetJobName: targetJob.name,
        bestJobName: null,
        bestImprovement: null,
        allResults: [],
        currentEff,
        currentStats,
        improvement10: null,
        trainingsForPlus1: null,
      });
    }
  }

  function _runPlan() {
    if (!_employees.length) {
      Utils.toast('请先获取员工数据', 'warning');
      return;
    }

    const companyData = COMPANY_JOBS[_companyTypeId];
    if (!companyData) {
      Utils.toast('请选择有效的公司类型', 'warning');
      return;
    }

    const allJobs = companyData.jobs;
    const jobMap = {};
    allJobs.forEach(j => { jobMap[j.name] = j; });

    _planResults = [];

    for (const emp of _employees) {
      const targetJobName = _getTargetJobName(emp.player_id);
      const targetJob = jobMap[targetJobName] || allJobs[0];

      const plan = findBestTrainingJob(emp, targetJob, allJobs);
      _planResults.push({
        empId: emp.player_id,
        empName: emp.name,
        targetJobName: targetJob.name,
        ...plan
      });
    }

    _renderTable();

    const exportBtn = document.getElementById('tp-export-btn');
    if (exportBtn) exportBtn.classList.remove('hidden');

    const statusEl = document.getElementById('tp-status');
    if (statusEl) statusEl.textContent = '规划完成';
    Utils.toast('训练规划完成', 'success');
  }

  // ---- 报告导出 ----

  function _exportReport() {
    if (!_planResults.length) {
      Utils.toast('请先进行训练规划', 'warning');
      return;
    }

    const companyData = COMPANY_JOBS[_companyTypeId];
    const companyName = companyData?.company_name || 'Unknown';
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);

    let report = `Torn City 员工训练规划报告\n`;
    report += `公司类型: ${companyName} (ID: ${_companyTypeId})\n`;
    report += `生成时间: ${now.toLocaleString()}\n`;
    report += '='.repeat(60) + '\n\n';

    for (const pr of _planResults) {
      const emp = _employees.find(e => e.player_id === pr.empId);
      report += `=== 员工: ${pr.empName} | 目标岗位: ${pr.targetJobName} ===\n`;
      report += `MAN: ${pr.currentStats.MAN} | INT: ${pr.currentStats.INT} | END: ${pr.currentStats.END}\n`;
      report += `基础效率: ${pr.currentEff.toFixed(2)}\n`;
      report += `→ 最佳训练岗位: ${pr.bestJobName} (10次训练效果 +${(pr.improvement10 || 0).toFixed(2)}, 训练至+1效率需 ${pr.trainingsForPlus1 === Infinity ? '∞' : pr.trainingsForPlus1} 次)\n`;
      report += `\n`;
      report += `训练岗位${''.padEnd(20)}主属性   副属性   效率Δ\n`;
      report += '-'.repeat(50) + '\n';
      for (const r of pr.allResults) {
        report += `${r.jobName.padEnd(30)}${r.primaryGain.padEnd(10)}${r.secondaryGain.padEnd(10)}${r.improvement.toFixed(4)}\n`;
      }
      report += '\n';
    }

    // 创建下载
    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `training_plan_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    Utils.toast('报告已导出', 'success');
  }

  // ---- 渲染辅助 ----

  function _renderTable() {
    const tableEl = document.getElementById('tp-employee-table');
    if (tableEl) {
      tableEl.innerHTML = _employeeTableHTML();
    }
    // 更新摘要区域
    const container = document.getElementById('page-content');
    if (container && _planResults.length) {
      // 移除旧摘要
      const oldSummary = container.querySelector('.bg-torn-card.border-torn-border.rounded-lg.p-4.mt-4');
      if (oldSummary) oldSummary.remove();
      // 插入新摘要
      const summaryDiv = document.createElement('div');
      summaryDiv.innerHTML = _summaryHTML();
      while (summaryDiv.firstChild) {
        container.appendChild(summaryDiv.firstChild);
      }
    }
  }

  // ---- 公开接口（IIFE 返回）----

  return {
    async init() {
      // 0. 从 DB 加载教育 BUS2110 状态
      try {
        const saved = await DB.get('settings', 'has_bus2110');
        _hasBus2110 = saved?.value === true;
      } catch (e) {
        _hasBus2110 = false;
      }

      // 1. 从 DB 加载保存的公司类型
      const savedType = await _loadSavedCompanyType();
      console.log(`[TrainingPlanner] init: savedType=${savedType}, _companyTypeId=${_companyTypeId}`);

      // 2. 若无保存的公司类型，尝试从 AppCache 或 API 获取真实公司类型
      if (!_companyTypeId) {
        try {
          // 尝试从 AppCache 获取（其他页面可能已缓存）
          const cached = AppCache.get('companyData');
          if (cached && cached.profile?.company_type != null && COMPANY_JOBS[cached.profile.company_type]) {
            _companyTypeId = cached.profile.company_type;
            console.log(`[TrainingPlanner] 从 AppCache 识别公司类型: ${_companyTypeId}`);
            await _persistCompanyType(_companyTypeId);
          } else {
            // AppCache 无数据，从 API 轻量调用获取公司档案
            const profile = await TornAPI.getCompanyProfile();
            const profileType = profile?.company?.company_type ?? profile?.company_type;
            if (profileType != null && COMPANY_JOBS[profileType]) {
              _companyTypeId = profileType;
              console.log(`[TrainingPlanner] 从 API 识别公司类型: ${_companyTypeId}`);
              await _persistCompanyType(_companyTypeId);
            }
          }
        } catch (err) {
          console.warn('[TrainingPlanner] 获取公司类型失败:', err.message);
        }
      }

      // 3. 若仍无公司类型，使用默认值
      if (!_companyTypeId) {
        const firstKey = Object.keys(COMPANY_JOBS)[0];
        _companyTypeId = parseInt(firstKey, 10);
        console.log(`[TrainingPlanner] 使用默认公司类型: ${_companyTypeId}`);
      }

      _eventsBound = false;
      _planResults = [];
      _employees = [];

      // 4. 先渲染 UI 骨架
      const c = document.getElementById('page-content');
      if (c) {
        c.innerHTML = _buildHTML();
        _bindEvents();
      }

      // 5. 自动加载员工数据：优先从 DB 读取，DB 无数据时从 API 获取
      const statusEl = document.getElementById('tp-status');
      const loadedFromDB = await _loadFromDB();

      if (loadedFromDB && _employees.length > 0) {
        _dataSource = 'db';
        _calculateInitialEfficiencies();
        _renderTable();
        const planBtn = document.getElementById('tp-plan-btn');
        if (planBtn) planBtn.classList.remove('hidden');
        if (statusEl) statusEl.textContent = `已加载 ${_employees.length} 名员工 (本地缓存)`;
      } else {
        // DB 无数据，从 API 获取
        await _fetchFromAPI(false);
      }
    },

    async render() {
      // render 在每次导航到页面时调用
      // 如果已有员工数据（init 时已加载），直接渲染
      if (_employees.length > 0) {
        const c = document.getElementById('page-content');
        if (!c) return;
        c.innerHTML = _buildHTML();
        _bindEvents();
        // 恢复规划结果展示
        if (_planResults.length) {
          _renderTable();
          const planBtn = document.getElementById('tp-plan-btn');
          const exportBtn = document.getElementById('tp-export-btn');
          if (planBtn) planBtn.classList.remove('hidden');
          if (exportBtn) exportBtn.classList.remove('hidden');
          const statusEl = document.getElementById('tp-status');
          if (statusEl) statusEl.textContent = '规划完成';
        }
      } else {
        // 无数据时重新执行 init 流程
        await this.init();
      }
    }
  };
})();
