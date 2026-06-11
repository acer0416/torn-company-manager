import React, { useState, useEffect, useRef } from "react";
import {
  Plus,
  Trash2,
  TrendingUp,
  DollarSign,
  Activity,
  ChevronDown,
  ChevronUp,
  Calendar,
  Zap,
  Megaphone,
  Save,
  Download,
  Upload,
  ArrowUpRight,
  ArrowDownRight,
  Minus,
} from "lucide-react";

// --- 存储功能模块 (整合在同一文件中以避免导入错误) ---

const STORAGE_KEYS = {
  ITEMS: "price_tracker_items",
  RECORDS: "price_tracker_records",
  GLOBAL_STATS: "price_tracker_global_stats",
};

// 保存数据
const saveToStorage = (key, data) => {
  try {
    const serializedData = JSON.stringify(data);
    localStorage.setItem(key, serializedData);
  } catch (error) {
    console.error("Error saving data:", error);
  }
};

// 读取数据
const loadFromStorage = (key, defaultValue) => {
  try {
    const serializedData = localStorage.getItem(key);
    if (serializedData === null) {
      return defaultValue;
    }
    return JSON.parse(serializedData);
  } catch (error) {
    console.error("Error loading data:", error);
    return defaultValue;
  }
};

// 导出数据为JSON文件 (备份功能)
const exportDataToFile = (data) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `price_tracker_backup_${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

// --- 主组件 ---

const PriceTracker = () => {
  // --- 初始配置数据 (这些通常不变) ---
  const defaultItems = [
    { id: 1, name: "Knickers", cost: 4, rrp: 20 },
    { id: 2, name: "Stockings", cost: 8, rrp: 32 },
    { id: 3, name: "Thong", cost: 10, rrp: 48 },
    { id: 4, name: "Bra", cost: 21, rrp: 64 },
    { id: 5, name: "Suspenders", cost: 30, rrp: 72 },
    { id: 6, name: "Corset", cost: 40, rrp: 125 },
  ];

  // --- 状态管理 ---

  // 1. 物品销售记录: { itemId: [ { id, date, price, sales } ] }
  const [records, setRecords] = useState(() =>
    loadFromStorage(STORAGE_KEYS.RECORDS, {})
  );

  // 2. 全局参数 (按日期索引): { "2023-10-27": { efficiency: 100, adCost: 500 } }
  const [globalStats, setGlobalStats] = useState(() =>
    loadFromStorage(STORAGE_KEYS.GLOBAL_STATS, {})
  );

  // 3. 当前操作日期 (默认为今天)
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().slice(0, 10)
  );

  // 4. UI 状态
  const [expandedItem, setExpandedItem] = useState(null);
  const [newEntry, setNewEntry] = useState({ price: "", sales: "" });

  // 5. 文件上传引用
  const fileInputRef = useRef(null);

  // --- 数据持久化副作用 ---
  // 每当 records 或 globalStats 改变时，自动保存到 localStorage
  useEffect(() => {
    saveToStorage(STORAGE_KEYS.RECORDS, records);
  }, [records]);

  useEffect(() => {
    saveToStorage(STORAGE_KEYS.GLOBAL_STATS, globalStats);
  }, [globalStats]);

  // --- 新增：自动填充全局参数逻辑 ---
  // 当切换日期时，如果该日期没有设置过广告费/效率，则自动填入最近一次的数据
  useEffect(() => {
    // 如果当前日期已经有数据，不进行任何操作（避免覆盖用户刚输入的数据）
    if (globalStats[selectedDate]) return;

    // 获取所有有数据的日期并排序
    const dates = Object.keys(globalStats).sort();

    // 找到当前日期之前的最近一个日期
    const prevDates = dates.filter((d) => d < selectedDate);
    const lastDate = prevDates[prevDates.length - 1];

    if (lastDate) {
      const lastStats = globalStats[lastDate];
      // 自动填充为上一天的数据
      setGlobalStats((prev) => ({
        ...prev,
        [selectedDate]: { ...lastStats },
      }));
    }
  }, [selectedDate, globalStats]);

  // --- 辅助函数 ---
  const formatNumber = (num) => new Intl.NumberFormat("en-US").format(num);
  const formatMoney = (num) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(num);

  // 格式化差额显示
  const formatDiff = (val, isMoney = false) => {
    if (val === null || val === undefined) return null;
    if (val === 0)
      return <span className="text-gray-600 text-[10px] ml-1">-</span>;

    const isPositive = val > 0;
    const colorClass = isPositive ? "text-green-500" : "text-red-400";
    const text = isMoney
      ? formatMoney(Math.abs(val))
      : formatNumber(Math.abs(val));

    return (
      <span
        className={`inline-flex items-center ml-1.5 ${colorClass} text-[10px] opacity-80`}
      >
        ({isPositive ? "+" : "-"}
        {text})
      </span>
    );
  };

  // 获取指定日期的全局参数，如果不存在则返回默认值
  const getGlobalStatsForDate = (date) => {
    return globalStats[date] || { efficiency: 100, adCost: 0 };
  };

  // 更新全局参数
  const updateGlobalStats = (key, value) => {
    setGlobalStats((prev) => ({
      ...prev,
      [selectedDate]: {
        ...getGlobalStatsForDate(selectedDate),
        [key]: parseFloat(value) || 0,
      },
    }));
  };

  // 处理展开/收起逻辑，并自动填入昨日价格
  const toggleExpand = (itemId) => {
    if (expandedItem === itemId) {
      setExpandedItem(null);
      setNewEntry({ price: "", sales: "" });
    } else {
      setExpandedItem(itemId);

      // 查找该物品最近的一条记录作为默认价格
      const itemRecords = records[itemId] || [];
      // 按日期倒序排列，取第一个
      const sortedRecords = [...itemRecords].sort(
        (a, b) => new Date(b.date) - new Date(a.date)
      );
      const latestPrice =
        sortedRecords.length > 0 ? sortedRecords[0].price : "";

      setNewEntry({ price: latestPrice, sales: "" });
    }
  };

  // 添加物品销售记录
  const handleAddRecord = (itemId) => {
    if (!newEntry.price || !newEntry.sales) return;

    const newRecord = {
      id: Date.now(),
      date: selectedDate, // 关键：记录关联当前选择的日期
      price: parseInt(newEntry.price),
      sales: parseInt(newEntry.sales),
    };

    setRecords((prev) => {
      const itemRecords = prev[itemId] || [];
      return {
        ...prev,
        [itemId]: [...itemRecords, newRecord].sort(
          (a, b) => new Date(b.date) - new Date(a.date)
        ), // 按日期倒序
      };
    });

    // 提交后不清空价格，保留当前价格以便连续录入，只清空销量
    setNewEntry((prev) => ({ ...prev, sales: "" }));
  };

  const handleDeleteRecord = (itemId, recordId) => {
    setRecords((prev) => ({
      ...prev,
      [itemId]: prev[itemId].filter((r) => r.id !== recordId),
    }));
  };

  // 分析单个物品数据
  const analyzeItem = (item) => {
    const itemRecords = records[item.id] || [];

    // 1. 先按日期正序排列，以便计算差额
    const sortedByDate = [...itemRecords].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    // 2. 计算每条记录的详细数据和差额
    const recordsWithAnalysis = sortedByDate.map((r, index) => {
      const stats = getGlobalStatsForDate(r.date);
      const revenue = r.price * r.sales; // 改为计算销售额 (单价 * 销量)

      // 获取上一条记录（即前一个日期的数据）
      const prevRecord = index > 0 ? sortedByDate[index - 1] : null;

      // 计算差额
      let salesDiff = null;
      let revenueDiff = null;

      if (prevRecord) {
        const prevRevenue = prevRecord.price * prevRecord.sales;
        salesDiff = r.sales - prevRecord.sales;
        revenueDiff = revenue - prevRevenue;
      }

      return {
        ...r,
        revenue,
        efficiencyRef: stats.efficiency,
        adCostRef: stats.adCost,
        salesDiff,
        revenueDiff,
      };
    });

    // 3. 找到最高销售额记录
    const maxRevenueRecord = recordsWithAnalysis.reduce(
      (max, curr) => (curr.revenue > (max?.revenue || 0) ? curr : max),
      null
    );

    return {
      records: recordsWithAnalysis,
      bestPrice: maxRevenueRecord?.price || 0,
      bestRevenue: maxRevenueRecord?.revenue || 0,
    };
  };

  // 导出所有数据
  const handleExport = () => {
    const backupData = {
      records,
      globalStats,
      exportDate: new Date().toISOString(),
    };
    exportDataToFile(backupData);
  };

  // 触发文件选择
  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  // 处理文件导入
  const handleFileChange = (event) => {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target.result);

        // 简单的数据验证
        if (data.records && data.globalStats) {
          if (
            window.confirm(
              "导入将覆盖当前所有数据（包括效率和广告费设置），确定要继续吗？"
            )
          ) {
            setRecords(data.records);
            setGlobalStats(data.globalStats);
            alert("数据导入成功！");
          }
        } else {
          alert("文件格式不正确：缺少必要的记录数据。");
        }
      } catch (error) {
        console.error("Import error:", error);
        alert("导入失败：文件解析错误，请确保选择的是正确的备份文件。");
      }
    };
    reader.readAsText(file);
    event.target.value = "";
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-100 p-4 md:p-8 font-sans">
      <div className="max-w-6xl mx-auto">
        {/* Header & Global Controls */}
        <div className="mb-8 space-y-6">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 border-b border-gray-700 pb-4">
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2 text-white">
                <Activity className="w-8 h-8 text-blue-400" />
                定价与销售跟踪系统
              </h1>
              <p className="text-gray-400 text-sm mt-1">
                数据将自动保存至本地浏览器
              </p>
            </div>
            <div className="flex gap-3">
              <input
                type="file"
                ref={fileInputRef}
                onChange={handleFileChange}
                className="hidden"
                accept=".json"
              />
              <button
                onClick={handleImportClick}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors border border-gray-600 text-blue-300 border-blue-900/50"
              >
                <Upload size={16} />
                导入数据
              </button>
              <button
                onClick={handleExport}
                className="flex items-center gap-2 px-4 py-2 bg-gray-800 hover:bg-gray-700 rounded-lg text-sm transition-colors border border-gray-600"
              >
                <Download size={16} />
                备份数据
              </button>
            </div>
          </div>

          {/* 全局每日参数控制面板 */}
          <div className="bg-gray-800/50 rounded-xl p-4 border border-blue-900/30">
            <div className="flex items-center gap-2 mb-4 text-blue-300 font-semibold">
              <Calendar size={20} />
              <span>每日全局设置</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              {/* 日期选择 */}
              <div>
                <label className="block text-xs text-gray-400 mb-1">
                  选择操作日期
                </label>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => setSelectedDate(e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-blue-500 outline-none"
                />
              </div>

              {/* 效率输入 */}
              <div>
                <label className="block text-xs text-gray-400 mb-1 flex items-center gap-1">
                  <Zap size={12} /> 当日效率 (%) - 仅供参考
                </label>
                <input
                  type="number"
                  value={getGlobalStatsForDate(selectedDate).efficiency}
                  onChange={(e) =>
                    updateGlobalStats("efficiency", e.target.value)
                  }
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-yellow-500 outline-none"
                />
              </div>

              {/* 广告费输入 */}
              <div>
                <label className="block text-xs text-gray-400 mb-1 flex items-center gap-1">
                  <Megaphone size={12} /> 当日广告费 ($) - 仅供参考
                </label>
                <input
                  type="number"
                  value={getGlobalStatsForDate(selectedDate).adCost}
                  onChange={(e) => updateGlobalStats("adCost", e.target.value)}
                  className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white focus:border-green-500 outline-none"
                />
              </div>
            </div>
          </div>
        </div>

        {/* 物品列表 */}
        <div className="grid gap-4">
          {defaultItems.map((item) => {
            const { records, bestPrice, bestRevenue } = analyzeItem(item);
            const isExpanded = expandedItem === item.id;

            return (
              <div
                key={item.id}
                className={`bg-gray-800 rounded-xl border transition-all duration-200 ${
                  isExpanded
                    ? "border-blue-500 shadow-lg shadow-blue-900/20"
                    : "border-gray-700 hover:border-gray-600"
                }`}
              >
                {/* 摘要行 */}
                <div
                  className="p-4 flex flex-col md:flex-row items-start md:items-center justify-between cursor-pointer gap-4"
                  onClick={() => toggleExpand(item.id)}
                >
                  <div className="flex items-center gap-4 min-w-[200px]">
                    <div
                      className={`p-3 rounded-lg ${
                        isExpanded
                          ? "bg-blue-500/20 text-blue-300"
                          : "bg-gray-700 text-gray-400"
                      }`}
                    >
                      <DollarSign className="w-6 h-6" />
                    </div>
                    <div>
                      <h3 className="font-bold text-lg text-white">
                        {item.name}
                      </h3>
                      <div className="text-xs text-gray-400">
                        成本: ${item.cost} | RRP: ${item.rrp}
                      </div>
                    </div>
                  </div>

                  <div className="flex-1 flex gap-4">
                    <div className="bg-gray-900/50 p-2 px-4 rounded border border-gray-700/50">
                      <div className="text-[10px] uppercase text-gray-500">
                        建议定价
                      </div>
                      <div className="text-lg font-mono text-green-400 font-bold">
                        ${bestPrice > 0 ? bestPrice : "-"}
                      </div>
                    </div>
                    <div className="bg-gray-900/50 p-2 px-4 rounded border border-gray-700/50">
                      <div className="text-[10px] uppercase text-gray-500">
                        最高日销售额
                      </div>
                      <div className="text-lg font-mono text-green-400">
                        {bestRevenue > 0 ? formatMoney(bestRevenue) : "-"}
                      </div>
                    </div>
                  </div>

                  <div className="text-gray-500">
                    {isExpanded ? <ChevronUp /> : <ChevronDown />}
                  </div>
                </div>

                {/* 展开详情 */}
                {isExpanded && (
                  <div className="border-t border-gray-700 bg-gray-900/30 p-4 md:p-6 animate-in slide-in-from-top-2">
                    {/* 添加新记录区域 */}
                    <div className="bg-blue-900/10 p-4 rounded-lg border border-blue-900/30 mb-6">
                      <div className="text-xs text-blue-300 mb-2 font-semibold">
                        添加数据 - 日期: {selectedDate} (效率:{" "}
                        {getGlobalStatsForDate(selectedDate).efficiency}%, 广告:
                        ${getGlobalStatsForDate(selectedDate).adCost})
                      </div>
                      <div className="flex gap-4 items-end">
                        <div className="flex-1">
                          <label className="block text-[10px] text-blue-300/70 mb-1">
                            今日定价 ($)
                          </label>
                          <input
                            type="number"
                            value={newEntry.price}
                            onChange={(e) =>
                              setNewEntry({
                                ...newEntry,
                                price: e.target.value,
                              })
                            }
                            placeholder="输入价格"
                            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white font-mono"
                          />
                        </div>
                        <div className="flex-1">
                          <label className="block text-[10px] text-blue-300/70 mb-1">
                            今日销量
                          </label>
                          <input
                            type="number"
                            value={newEntry.sales}
                            onChange={(e) =>
                              setNewEntry({
                                ...newEntry,
                                sales: e.target.value,
                              })
                            }
                            placeholder="输入销量"
                            className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-2 text-white font-mono"
                          />
                        </div>
                        <button
                          onClick={() => handleAddRecord(item.id)}
                          disabled={!newEntry.price || !newEntry.sales}
                          className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed h-[42px]"
                        >
                          <Plus size={18} />
                          <span className="hidden md:inline">保存</span>
                        </button>
                      </div>
                    </div>

                    {/* 数据表格 */}
                    <div className="overflow-x-auto rounded-lg border border-gray-700">
                      <table className="w-full text-left text-sm">
                        <thead className="bg-gray-900/80 text-gray-400 uppercase text-xs">
                          <tr>
                            <th className="px-4 py-3">日期</th>
                            <th className="px-4 py-3 text-center text-yellow-500">
                              效率(Ref)
                            </th>
                            <th className="px-4 py-3 text-center text-green-500">
                              广告费(Ref)
                            </th>
                            <th className="px-4 py-3">定价</th>
                            <th className="px-4 py-3">销量 (变化)</th>
                            <th className="px-4 py-3 text-right">
                              销售额 (变化)
                            </th>
                            <th className="px-4 py-3 w-10"></th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-gray-800">
                          {records
                            .sort((a, b) => b.revenue - a.revenue)
                            .map((record) => {
                              const isBest =
                                record.revenue === bestRevenue &&
                                bestRevenue > 0;
                              return (
                                <tr
                                  key={record.id}
                                  className={`hover:bg-gray-800/50 ${
                                    isBest ? "bg-green-900/10" : ""
                                  }`}
                                >
                                  <td className="px-4 py-3 text-gray-400 whitespace-nowrap">
                                    {record.date}
                                  </td>
                                  <td className="px-4 py-3 text-center text-gray-500">
                                    {record.efficiencyRef}%
                                  </td>
                                  <td className="px-4 py-3 text-center text-gray-500">
                                    ${record.adCostRef}
                                  </td>
                                  <td className="px-4 py-3 font-mono text-white">
                                    ${record.price}
                                    {isBest && (
                                      <span className="ml-2 text-[10px] bg-green-500 text-black px-1 rounded font-bold">
                                        BEST
                                      </span>
                                    )}
                                  </td>
                                  <td className="px-4 py-3 font-mono text-gray-300">
                                    {formatNumber(record.sales)}
                                    {formatDiff(record.salesDiff)}
                                  </td>
                                  <td
                                    className={`px-4 py-3 text-right font-mono font-bold ${
                                      isBest
                                        ? "text-green-400"
                                        : "text-gray-300"
                                    }`}
                                  >
                                    {formatMoney(record.revenue)}
                                    {formatDiff(record.revenueDiff, true)}
                                  </td>
                                  <td className="px-4 py-3 text-center">
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        handleDeleteRecord(item.id, record.id);
                                      }}
                                      className="text-gray-600 hover:text-red-400"
                                    >
                                      <Trash2 size={16} />
                                    </button>
                                  </td>
                                </tr>
                              );
                            })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default PriceTracker;
