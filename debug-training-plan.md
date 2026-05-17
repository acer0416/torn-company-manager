# 排查方案：Content Script 训练数据抓取问题

## 数据流概览

```
TrainingPage._refetchTrainData()
  → chrome.runtime.sendMessage({ action: 'scrapeTraining' })
    → background/service-worker.js: scrapeTrainingFromPage()
      → 查找/创建 Torn 公司页面 tab
      → chrome.tabs.sendMessage(tabId, { action: 'scrape-training-data' })
        → content/training-scraper.js: scrapeTrainingData()
          → 点击 "Training" 按钮
          → parseTrainingTable() / parseTrainingText()
          → 返回 { count, entries, scrapedAt, source }
      ← sendResponse({ ok: true, data: result })
    → saveTrainingSnapshot(data) → IndexedDB 'training_snapshots'
  ← { ok: true, count, scrapedAt, source }

TrainingPage 读取快照:
  → chrome.runtime.sendMessage({ action: 'getTrainingSnapshot' })
    → background: getTrainingSnapshot() → IndexedDB 'training_snapshots'
  ← { ok: true, snapshot: { entries, count, ... } }

TrainingPage 匹配:
  → _matchEmployee(entry) → 4 策略匹配
  → 生成 counts[player_id] → 更新 _apiTrainCounts
```

## 问题现象

1. 日志显示"抓到 50 条"——但 Torn 公司页面默认只加载 ~25 条，需要滚动才能加载更多
2. 匹配员工结果为 0

---

## 排查阶段一：验证 Content Script 实际抓取到的原始数据

### 目标
确认 content script 到底从 DOM 中提取了什么内容，以及 `entries` 数组中的每个条目长什么样。

### 步骤 1.1：在 content script 中输出完整抓取结果

**文件**: [`js/content/training-scraper.js`](js/content/training-scraper.js)

在 `scrapeTrainingData()` 函数的 return 之前（约第 85-90 行），添加详细日志：

```javascript
// 在 return 之前添加（约第 85 行）
console.log('[TrainingScraper] === RAW SCRAPE RESULT ===');
console.log('[TrainingScraper] Total entries:', entries.length);
console.log('[TrainingScraper] Source:', entries.length > 0 ? 'dom' : 'alternative');
// 输出前 5 条完整数据样本
console.log('[TrainingScraper] First 5 entries:', JSON.stringify(entries.slice(0, 5), null, 2));
// 输出所有条目的 playerName 列表
console.log('[TrainingScraper] All playerNames:', entries.map(e => e.playerName));
// 输出所有条目的 rawText 前 100 字符
console.log('[TrainingScraper] All rawTexts:', entries.map(e => e.rawText?.substring(0, 100)));
```

### 步骤 1.2：验证 DOM 选择器是否命中

在 [`parseTrainingTable()`](js/content/training-scraper.js:167) 中，每个策略分支添加计数日志：

```javascript
// 策略1 结束后（约第 186 行）
console.log('[TrainingScraper] Strategy 1 (table rows) found:', entries.length, 'entries');

// 策略2 结束后（约第 205 行）
console.log('[TrainingScraper] Strategy 2 (list items) found:', entries.length, 'entries');

// 策略3 结束后（约第 219 行）
console.log('[TrainingScraper] Strategy 3 (div/p/span) found:', entries.length, 'entries');
```

### 步骤 1.3：验证 `parseTrainingText()` 的正则匹配

在 [`parseTrainingText()`](js/content/training-scraper.js:232) 中，每个正则分支添加日志：

```javascript
// 在每个 match 分支中
console.log('[TrainingScraper] parseTrainingText matched pattern 1 (has been trained by):', match[1], '|', match[2]);
// pattern 2
console.log('[TrainingScraper] parseTrainingText matched pattern 2 (has trained):', match[1], '|', match[2]);
// pattern 3
console.log('[TrainingScraper] parseTrainingText matched pattern 3 (You trained):', match[1]);
// pattern 4
console.log('[TrainingScraper] parseTrainingText matched pattern 4 (was trained):', match[1], '|', match[2]);
```

同时在函数末尾（return null 之前）添加未匹配文本的日志：

```javascript
// 在 return null 之前
if (cleaned.length > 10) {
  console.warn('[TrainingScraper] UNMATCHED text:', cleaned.substring(0, 200));
}
```

### 预期发现

- 如果 `entries` 为空或 `playerName` 格式异常，问题在 DOM 解析层
- 如果 `entries` 有数据但 `playerName` 包含 HTML 标签（如 `<a href=...>Name</a>`），说明 `textContent` 提取有问题
- 如果 `rawText` 包含 `XID=` 但 `playerName` 是纯文本，说明正则匹配正确但后续匹配需要依赖 `rawText`

---

## 排查阶段二：验证 Torn 页面实际显示了多少条记录

### 目标
确认 Torn 公司页面 Training 标签页的 DOM 中到底有多少条训练记录，是否需要滚动加载。

### 步骤 2.1：在 content script 中添加 DOM 诊断

在 [`scrapeTrainingData()`](js/content/training-scraper.js:39) 中，点击 Training 按钮并等待后，添加 DOM 结构诊断：

```javascript
// 在 waitForTrainingContent 之后、parseTrainingTable 之前添加（约第 66 行）
console.log('[TrainingScraper] === DOM DIAGNOSTICS ===');

// 统计页面中所有可能包含训练数据的元素
const allTables = document.querySelectorAll('table');
console.log('[TrainingScraper] Tables found:', allTables.length);
allTables.forEach((t, i) => {
  console.log(`[TrainingScraper]   Table ${i}: rows=${t.rows?.length}, text contains "trained": ${/\btrained\b/i.test(t.textContent || '')}`);
});

const allLists = document.querySelectorAll('ul, ol, [class*="list"]');
console.log('[TrainingScraper] Lists found:', allLists.length);
allLists.forEach((l, i) => {
  const liCount = l.querySelectorAll('li').length;
  console.log(`[TrainingScraper]   List ${i}: li=${liCount}, text contains "trained": ${/\btrained\b/i.test(l.textContent || '')}`);
});

// 统计包含 "trained" 关键词的元素总数
const trainedElements = document.querySelectorAll('*');
let trainedCount = 0;
trainedElements.forEach(el => {
  if (el.children.length === 0 && /\btrained\b/i.test(el.textContent || '')) {
    trainedCount++;
  }
});
console.log('[TrainingScraper] Leaf elements containing "trained":', trainedCount);

// 检查是否有滚动容器和"加载更多"按钮
const scrollContainers = document.querySelectorAll('[class*="scroll"], [class*="infinite"], [class*="virtual"]');
console.log('[TrainingScraper] Scroll containers found:', scrollContainers.length);

const loadMoreButtons = document.querySelectorAll('button, a');
let loadMoreFound = false;
loadMoreButtons.forEach(btn => {
  const text = btn.textContent?.trim().toLowerCase() || '';
  if (text.includes('load more') || text.includes('more') || text.includes('加载更多')) {
    console.log('[TrainingScraper] Load more button found:', text);
    loadMoreFound = true;
  }
});
if (!loadMoreFound) {
  console.log('[TrainingScraper] No "load more" button found');
}
```

### 步骤 2.2：手动验证（用户操作）

1. 打开 Torn 公司页面 `https://www.torn.com/companies.php?step=your&type=1`
2. 点击 "Training" 标签
3. 打开浏览器 DevTools (F12) → Console
4. 执行以下命令：

```javascript
// 统计包含 "trained" 的可见文本元素
document.querySelectorAll('*').forEach(el => {
  if (el.children.length === 0 && /\btrained\b/i.test(el.textContent || '')) {
    console.log(el.textContent?.substring(0, 150));
  }
});

// 检查是否有虚拟滚动（只渲染可见项）
const listContainer = document.querySelector('[class*="list"], ul, ol, [class*="news"]');
if (listContainer) {
  console.log('List container children count:', listContainer.children.length);
  console.log('List container scrollHeight:', listContainer.scrollHeight);
  console.log('List container clientHeight:', listContainer.clientHeight);
}
```

### 预期发现

- 如果 DOM 中确实只有 ~25 条记录，说明 Torn 使用了虚拟滚动/分页，content script 需要滚动加载
- 如果 DOM 中有 50 条但 content script 只解析出部分，说明选择器或正则有问题
- 如果存在"加载更多"按钮或滚动加载机制，需要实现自动滚动

---

## 排查阶段三：验证数据传递链路是否有丢失或变形

### 目标
确认数据从 content script → background → IndexedDB → TrainingPage 的每个环节是否完整。

### 步骤 3.1：在 background service worker 中添加数据完整性日志

**文件**: [`background/service-worker.js`](background/service-worker.js)

在 [`scrapeTrainingFromPage()`](background/service-worker.js:281) 收到 content script 响应后（约第 327 行），添加：

```javascript
// 在 const response = await chrome.tabs.sendMessage(...) 之后
console.log('[ScrapeTraining] Content script response received');
console.log('[ScrapeTraining] Response structure:', Object.keys(response || {}));
console.log('[ScrapeTraining] response.data keys:', Object.keys(response?.data || {}));
console.log('[ScrapeTraining] response.data.count:', response?.data?.count);
console.log('[ScrapeTraining] response.data.entries length:', response?.data?.entries?.length);
if (response?.data?.entries?.length > 0) {
  console.log('[ScrapeTraining] First entry sample:', JSON.stringify(response.data.entries[0]));
  console.log('[ScrapeTraining] Last entry sample:', JSON.stringify(response.data.entries[response.data.entries.length - 1]));
}
```

在 [`saveTrainingSnapshot()`](background/service-worker.js:411) 中，存储前后添加：

```javascript
console.log('[ScrapeTraining] Saving snapshot - entries count:', data.entries?.length);
console.log('[ScrapeTraining] Snapshot to save:', JSON.stringify({
  date: snapshot.date,
  count: snapshot.count,
  entriesCount: snapshot.entries?.length,
  source: snapshot.source,
  firstEntry: snapshot.entries?.[0],
  lastEntry: snapshot.entries?.[snapshot.entries?.length - 1]
}));
```

在 [`getTrainingSnapshot()`](background/service-worker.js:434) 中，读取后添加：

```javascript
// 在 return 之前
console.log('[ScrapeTraining] getTrainingSnapshot - all snapshots count:', all.length);
if (all.length > 0) {
  const latest = all.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
  console.log('[ScrapeTraining] Latest snapshot:', {
    date: latest.date,
    count: latest.count,
    entriesCount: latest.entries?.length,
    source: latest.source,
    firstEntry: latest.entries?.[0]
  });
}
```

### 步骤 3.2：在 TrainingPage 中添加接收数据日志

**文件**: [`js/pages/training.js`](js/pages/training.js)

在 [`_refetchTrainData()`](js/pages/training.js:398) 中，收到 snapshot 后（约第 412 行），添加：

```javascript
// 在 const snapshot = snapshotResult.snapshot; 之后
console.log('[TrainingPage] Snapshot received from background:');
console.log('[TrainingPage]   date:', snapshot.date);
console.log('[TrainingPage]   count:', snapshot.count);
console.log('[TrainingPage]   entries.length:', snapshot.entries?.length);
console.log('[TrainingPage]   source:', snapshot.source);
if (snapshot.entries?.length > 0) {
  console.log('[TrainingPage]   First 3 entries:', JSON.stringify(snapshot.entries.slice(0, 3)));
  console.log('[TrainingPage]   All playerNames:', snapshot.entries.map(e => e.playerName));
  console.log('[TrainingPage]   All rawTexts (first 80 chars):', snapshot.entries.map(e => e.rawText?.substring(0, 80)));
}
```

### 步骤 3.3：对比各环节数据

在浏览器 DevTools 中，按以下顺序查看日志：

1. **Content script 日志**（在 Torn 公司页面的 DevTools 中）：`[TrainingScraper]`
2. **Background service worker 日志**（在 `chrome://extensions` → 检查视图 → Service Worker）：`[ScrapeTraining]`
3. **Popup 页面日志**（在 popup 的 DevTools 中）：`[TrainingPage]`

对比三处的 `entries.length`、`firstEntry`、`playerName` 是否一致。

### 预期发现

- 如果三处数据一致但匹配仍为 0，问题在匹配逻辑
- 如果 content script 有 50 条但 background 只有 25 条，说明 `chrome.tabs.sendMessage` 或序列化有问题
- 如果 background 有 50 条但 TrainingPage 只有 25 条，说明 IndexedDB 读写有问题

---

## 排查阶段四：验证匹配逻辑是否正确

### 目标
确认 `_matchEmployee()` 的 4 个策略是否能匹配到实际数据。

### 步骤 4.1：输出员工列表的完整信息

在 [`_refetchTrainData()`](js/pages/training.js:398) 中，匹配循环之前（约第 415 行），添加：

```javascript
console.log('[TrainingPage] === EMPLOYEE LIST ===');
console.log('[TrainingPage] Total employees:', this.employees.length);
this.employees.forEach(e => {
  console.log(`[TrainingPage]   id=${e.player_id}, name="${e.name}", position=${e.position}`);
});
```

### 步骤 4.2：逐条输出匹配过程

在 [`_matchEmployee()`](js/pages/training.js:481) 中，为每个策略添加详细日志：

```javascript
_matchEmployee(entry) {
  if (!entry || !this.employees.length) return null;

  console.log('[TrainingPage] _matchEmployee input:', {
    playerName: entry.playerName,
    trainer: entry.trainer,
    rawText: entry.rawText?.substring(0, 120)
  });

  // 策略1: XID= 匹配
  if (entry.rawText) {
    const xidMatch = entry.rawText.match(/XID=(\d+)/i);
    if (xidMatch) {
      const pid = String(xidMatch[1]);
      console.log('[TrainingPage]   Strategy 1 (XID=): found pid=', pid);
      const emp = this.employees.find(e => String(e.player_id) === pid);
      if (emp) {
        console.log('[TrainingPage]   Strategy 1 MATCHED:', emp.name);
        return emp;
      }
      console.log('[TrainingPage]   Strategy 1: pid', pid, 'not found in employees. Available IDs:', this.employees.map(e => e.player_id));
    } else {
      console.log('[TrainingPage]   Strategy 1: no XID= in rawText');
    }
  }

  // 策略2: [数字] 匹配
  if (entry.playerName) {
    const bracketMatch = entry.playerName.match(/\[(\d+)\]/);
    if (bracketMatch) {
      const pid = String(bracketMatch[1]);
      console.log('[TrainingPage]   Strategy 2 ([id]): found pid=', pid);
      const emp = this.employees.find(e => String(e.player_id) === pid);
      if (emp) {
        console.log('[TrainingPage]   Strategy 2 MATCHED:', emp.name);
        return emp;
      }
      console.log('[TrainingPage]   Strategy 2: pid', pid, 'not found in employees');
    } else {
      console.log('[TrainingPage]   Strategy 2: no [id] in playerName');
    }
  }

  // 策略3: 纯名称匹配
  if (entry.playerName) {
    const cleanName = entry.playerName.replace(/\s*\[\d+\]\s*/, '').trim().toLowerCase();
    console.log('[TrainingPage]   Strategy 3: cleanName="' + cleanName + '"');
    if (cleanName) {
      const emp = this.employees.find(e =>
        e.name && e.name.toLowerCase() === cleanName
      );
      if (emp) {
        console.log('[TrainingPage]   Strategy 3 MATCHED:', emp.name);
        return emp;
      }
      console.log('[TrainingPage]   Strategy 3: no match for "' + cleanName + '". Employee names:', this.employees.map(e => e.name?.toLowerCase()));
    }
  }

  // 策略4: 原始名称精确匹配
  if (entry.playerName) {
    console.log('[TrainingPage]   Strategy 4: exact match on "' + entry.playerName.toLowerCase() + '"');
    const emp = this.employees.find(e =>
      e.name && entry.playerName &&
      e.name.toLowerCase() === entry.playerName.toLowerCase()
    );
    if (emp) {
      console.log('[TrainingPage]   Strategy 4 MATCHED:', emp.name);
      return emp;
    }
    console.log('[TrainingPage]   Strategy 4: no exact match');
  }

  console.warn('[TrainingPage]   ALL STRATEGIES FAILED for entry:', entry.playerName);
  return null;
}
```

### 步骤 4.3：对比 API 方式的匹配结果

在 [`_loadData()`](js/pages/training.js:34) 中，API 方式获取的 `_apiTrainCounts` 已经通过 [`parseTrainingCountsFromNews()`](js/api.js:235) 解析。对比两种方式的匹配结果：

```javascript
// 在 _refetchTrainData 的匹配循环后添加
console.log('[TrainingPage] === MATCH COMPARISON ===');
console.log('[TrainingPage] API-based counts:', this._apiTrainCounts);
console.log('[TrainingPage] Scraper-based counts:', counts);
console.log('[TrainingPage] API matched employees:', Object.keys(this._apiTrainCounts).length);
console.log('[TrainingPage] Scraper matched employees:', Object.keys(counts).length);
```

### 预期发现

- 如果 API 方式能匹配但 scraper 不能，对比两者的 `rawText` 格式差异
- 如果 `rawText` 中没有 `XID=`，说明 content script 的 `textContent` 丢失了 HTML 中的链接属性
- 如果 `playerName` 包含 HTML 标签，说明 `textContent` 提取方式有问题
- 如果员工列表为空，问题在 `_loadData()` 的 employee 加载环节

---

## 根因假设（基于代码分析）

### 假设 A：Torn 页面使用虚拟滚动，DOM 中只有 ~25 条记录

**证据**:
- [`parseTrainingTable()`](js/content/training-scraper.js:167) 只解析当前 DOM 中的元素
- 代码中没有滚动加载逻辑
- 日志显示"抓到 50 条"可能是重复计数（策略 1+2+3 叠加）或解析了非训练数据

**验证方法**: 阶段二的 DOM 诊断日志

### 假设 B：`rawText` 中缺少 `XID=` 导致策略 1 失败

**证据**:
- [`parseTrainingText()`](js/content/training-scraper.js:232) 使用 `textContent` 提取文本，这会丢失 HTML 属性（包括 `href` 中的 `XID=`）
- Torn 的 news API 返回的 `news` 字段包含 HTML（如 `<a href="...XID=123">Name</a>`），但 `textContent` 会剥离标签
- [`_matchEmployee()`](js/pages/training.js:481) 的策略 1 依赖 `rawText` 中的 `XID=`

**验证方法**: 阶段一步骤 1.3 的 `rawText` 日志

### 假设 C：`playerName` 格式与员工 `name` 格式不匹配

**证据**:
- Torn API 返回的员工 `name` 是纯文本（如 `"PlayerName"`）
- Content script 的 `textContent` 可能返回 `"PlayerName [1234567]"` 格式（如果 Torn 页面在训练列表中显示了 ID）
- 策略 3 会去除 `[id]` 后缀，但如果名称中有额外空格或特殊字符，可能匹配失败

**验证方法**: 阶段四的匹配过程日志

### 假设 D：Content script 解析了非训练数据的 DOM 元素

**证据**:
- [`parseTrainingTable()`](js/content/training-scraper.js:167) 策略 3 查找所有包含 "trained" 的 `div/p/span`
- 如果页面其他区域也包含 "trained" 文本（如侧边栏、历史记录摘要），会被误解析
- 这可能导致 `entries.length` 虚高（50 条），但实际训练记录只有 ~25 条

**验证方法**: 阶段一步骤 1.1 的 `rawText` 日志

### 假设 E：`training_snapshots` IndexedDB store 不存在或结构不匹配

**证据**:
- [`saveTrainingSnapshot()`](background/service-worker.js:411) 使用 `training_snapshots` store
- 如果 DB 版本升级时未创建该 store，`store.put()` 会失败
- [`openDB()`](background/service-worker.js:201) 使用 `indexedDB.open('torn-company-manager', 8)`，但没有 `onupgradeneeded` 处理

**验证方法**: 阶段三的 background 日志，检查是否有 IndexedDB 错误

---

## 修复建议

### 修复 1：实现滚动加载以获取完整训练数据

如果 Torn 页面确实使用虚拟滚动/分页：

```javascript
// 在 scrapeTrainingData() 中，parseTrainingTable() 之前
async function scrollToLoadAll() {
  const container = findScrollContainer();
  if (!container) return;
  
  let prevCount = 0;
  let sameCount = 0;
  const maxScrolls = 20;
  
  for (let i = 0; i < maxScrolls; i++) {
    container.scrollTop = container.scrollHeight;
    await sleep(800);
    
    const currentCount = document.querySelectorAll('...').length; // 训练条目数
    if (currentCount === prevCount) {
      sameCount++;
      if (sameCount >= 3) break; // 连续 3 次无新数据，停止
    } else {
      sameCount = 0;
    }
    prevCount = currentCount;
  }
}
```

### 修复 2：保留 HTML 内容而非仅提取 textContent

修改 [`parseTrainingTable()`](js/content/training-scraper.js:167) 策略 1，使用 `innerHTML` 而非 `textContent` 来保留 `XID=` 信息：

```javascript
// 当前代码（第 173 行）:
const text = row.textContent || '';

// 建议改为:
const html = row.innerHTML || '';
const text = row.textContent || '';
const entry = parseTrainingText(text, html); // 传入 HTML 用于提取 XID=
```

同时修改 [`parseTrainingText()`](js/content/training-scraper.js:232) 接受第二个参数 `html`，从中提取 `XID=`：

```javascript
function parseTrainingText(text, html) {
  // ... 现有逻辑 ...
  
  // 在返回的 entry 中附加 XID 信息
  if (html) {
    const xidMatch = html.match(/XID=(\d+)/i);
    if (xidMatch) {
      entry.xid = xidMatch[1];
      // 将 XID 附加到 rawText 中，确保后续匹配可用
      entry.rawText = (entry.rawText || '') + ' [XID=' + xidMatch[1] + ']';
    }
  }
}
```

### 修复 3：在 content script 中直接完成 ID 提取

与其依赖 `rawText` 传递 HTML 片段，不如在 content script 中直接从 DOM 元素提取玩家 ID：

```javascript
// 在 parseTrainingTable() 策略 1 中（约第 172 行）
for (const row of rows) {
  const text = row.textContent || '';
  const entry = parseTrainingText(text);
  if (entry) {
    // 直接从 DOM 中查找玩家链接
    const playerLink = row.querySelector('a[href*="XID="]');
    if (playerLink) {
      const href = playerLink.getAttribute('href') || '';
      const xidMatch = href.match(/XID=(\d+)/i);
      if (xidMatch) {
        entry.playerId = xidMatch[1]; // 新增字段
        entry.rawText = (entry.rawText || '') + ' XID=' + xidMatch[1];
      }
    }
    // ... 时间戳提取 ...
    entries.push(entry);
  }
}
```

### 修复 4：确保 IndexedDB store 存在

在 [`openDB()`](background/service-worker.js:201) 中添加 `onupgradeneeded` 处理：

```javascript
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('torn-company-manager', 8);
    req.onupgradeneeded = (event) => {
      const db = event.target.result;
      // 确保 training_snapshots store 存在
      if (!db.objectStoreNames.contains('training_snapshots')) {
        db.createObjectStore('training_snapshots', { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
```

### 修复 5：添加去重逻辑

如果多个解析策略导致同一条训练记录被重复计数：

```javascript
// 在 parseTrainingTable() 返回前
// 使用 rawText 前 100 字符 + playerName 作为去重键
const seen = new Set();
const deduped = entries.filter(e => {
  const key = `${e.playerName}|${(e.rawText || '').substring(0, 100)}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
console.log('[TrainingScraper] Deduped:', entries.length, '→', deduped.length);
return deduped;
```

---

## 排查执行顺序建议

1. **先执行阶段二步骤 2.2**（手动验证，最快）：确认 Torn 页面实际有多少条记录
2. **再执行阶段一**（添加 content script 日志）：确认抓取到的原始数据格式
3. **然后执行阶段四**（添加匹配日志）：确认匹配失败的具体原因
4. **最后执行阶段三**（验证数据传递）：如果前两步数据正常但最终结果异常

这样可以最快定位问题根因，避免盲目修改。
