// Content Script - 从 Torn 公司页面抓取完整训练数据
// 注入到 https://www.torn.com/companies.php* 页面
// 通过 chrome.runtime.sendMessage 与 background service worker 通信

(function () {
  'use strict';

  console.log('[TrainingScraper] Content script loaded on', location.href);

  // ---- 消息监听 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === 'scrape-training-data') {
      console.log('[TrainingScraper] Received scrape-training-data command');
      scrapeTrainingData()
        .then((result) => {
          console.log('[TrainingScraper] Scrape complete:', result.count, 'entries');
          sendResponse({ ok: true, data: result });
        })
        .catch((err) => {
          console.error('[TrainingScraper] Scrape failed:', err);
          sendResponse({ ok: false, error: err.message });
        });
      return true; // 保持消息通道开放（异步响应）
    }

    if (msg.action === 'ping') {
      sendResponse({ ok: true, url: location.href });
      return true;
    }
  });

  /**
   * 主抓取流程：
   * 1. 查找并点击 "Training" 标签按钮
   * 2. 等待 DOM 加载训练数据表格
   * 3. 解析表格中的训练记录
   * 4. 返回结构化数据
   */
  async function scrapeTrainingData() {
    // Step 1: 确保在正确的页面 (companies.php?step=your&type=1)
    if (!location.href.includes('companies.php')) {
      throw new Error('当前不在 Torn 公司页面');
    }

    // Step 2: 查找 "Training" 标签按钮
    const trainingBtn = findTrainingButton();
    if (!trainingBtn) {
      throw new Error('未找到 Training 按钮，请确认页面已加载完成且当前为公司页面');
    }

    // Step 3: 如果 Training 标签尚未激活，点击它
    const isActive = trainingBtn.classList.contains('active') ||
      trainingBtn.getAttribute('aria-selected') === 'true' ||
      trainingBtn.parentElement?.classList.contains('active');

    if (!isActive) {
      console.log('[TrainingScraper] Clicking Training button...');
      trainingBtn.click();
      // 等待 React 渲染完成
      await waitForTrainingContent(8000);
    } else {
      console.log('[TrainingScraper] Training tab already active');
      // 仍然等待确保内容已渲染
      await sleep(500);
    }

    // Step 4: 解析训练数据
    const entries = parseTrainingTable();

    if (entries.length === 0) {
      // 尝试备用解析方法：查找页面上的 XHR 响应数据
      console.warn('[TrainingScraper] No entries found in DOM, trying alternative parsing...');
      const altEntries = parseAlternative();
      if (altEntries.length === 0) {
        throw new Error('未能解析到训练数据，页面结构可能已变更');
      }
      return {
        count: altEntries.length,
        entries: altEntries,
        scrapedAt: Date.now(),
        source: 'dom-alternative'
      };
    }

    return {
      count: entries.length,
      entries: entries,
      scrapedAt: Date.now(),
      source: 'dom'
    };
  }

  /**
   * 查找 Training 按钮
   * Torn 使用 React，按钮结构类似：
   * <button class="tab___SJyCS" type="button" i-data="i_552_2170_180_33">Training</button>
   */
  function findTrainingButton() {
    // 策略1: 通过 i-data 属性查找（Torn 的 React 属性）
    const allButtons = document.querySelectorAll('button.tab___SJyCS, button[class*="tab"], [role="tab"]');
    for (const btn of allButtons) {
      if (btn.textContent.trim().toLowerCase() === 'training') {
        return btn;
      }
    }

    // 策略2: 通过文本内容查找所有按钮
    const buttons = document.querySelectorAll('button');
    for (const btn of buttons) {
      if (btn.textContent.trim().toLowerCase() === 'training') {
        return btn;
      }
    }

    // 策略3: 查找包含 "Training" 文本的任意可点击元素
    const allElements = document.querySelectorAll('a, button, [role="tab"], [class*="tab"]');
    for (const el of allElements) {
      if (el.textContent.trim().toLowerCase() === 'training') {
        return el;
      }
    }

    return null;
  }

  /**
   * 等待训练内容加载完成
   * 通过轮询检测 DOM 中是否出现了训练数据表格
   */
  async function waitForTrainingContent(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // 检查是否出现了训练相关的表格或列表
      const tables = document.querySelectorAll('table, [class*="table"], [class*="list"], ul[class*="news"]');
      for (const table of tables) {
        const text = table.textContent || '';
        if (text.includes('trained') || text.includes('Training') || text.includes('has been')) {
          console.log('[TrainingScraper] Training content detected after', Date.now() - start, 'ms');
          await sleep(300); // 额外等待确保完全渲染
          return;
        }
      }

      // 也检查是否有 "No training" 或类似空状态
      const bodyText = document.body.textContent || '';
      if (bodyText.includes('No training') || bodyText.includes('暂无训练')) {
        console.log('[TrainingScraper] Empty training state detected');
        return;
      }

      await sleep(300);
    }
    console.warn('[TrainingScraper] Timeout waiting for training content');
  }

  /**
   * 解析训练数据表格
   * Torn 的训练数据通常以新闻列表形式展示，格式类似：
   * "PlayerName has been trained by the director" 或
   * "Director has trained PlayerName"
   *
   * 尝试多种 DOM 结构：
   * 1. 表格行 <tr> 包含训练信息
   * 2. 列表项 <li> 包含训练信息
   * 3. 新闻条目 <div> 包含训练信息
   */
  function parseTrainingTable() {
    const entries = [];

    // 策略1: 查找表格行
    const rows = document.querySelectorAll('table tr, [class*="table"] [class*="row"], [class*="newsItem"]');
    for (const row of rows) {
      const text = row.textContent || '';
      const entry = parseTrainingText(text);
      if (entry) {
        // 尝试提取时间戳
        const timeEl = row.querySelector('time, [class*="time"], [class*="date"], [data-time]');
        if (timeEl) {
          const dt = timeEl.getAttribute('datetime') || timeEl.getAttribute('data-time') || timeEl.textContent.trim();
          entry.rawDate = dt;
          const ts = Date.parse(dt);
          if (!isNaN(ts)) entry.timestamp = ts;
        }
        entries.push(entry);
      }
    }

    // 策略2: 如果表格行没找到，查找列表项
    if (entries.length === 0) {
      const listItems = document.querySelectorAll('li, [class*="listItem"], [class*="entry"]');
      for (const item of listItems) {
        const text = item.textContent || '';
        const entry = parseTrainingText(text);
        if (entry) {
          const timeEl = item.querySelector('time, [class*="time"], [class*="date"]');
          if (timeEl) {
            const dt = timeEl.getAttribute('datetime') || timeEl.textContent.trim();
            entry.rawDate = dt;
            const ts = Date.parse(dt);
            if (!isNaN(ts)) entry.timestamp = ts;
          }
          entries.push(entry);
        }
      }
    }

    // 策略3: 查找所有包含 "trained" 的文本块
    if (entries.length === 0) {
      const allDivs = document.querySelectorAll('div, p, span');
      for (const div of allDivs) {
        const text = div.textContent || '';
        if (text.length > 20 && text.length < 500 && /\btrained\b/i.test(text)) {
          const entry = parseTrainingText(text);
          if (entry && !entries.some(e => e.playerName === entry.playerName && e.rawText === entry.rawText)) {
            entries.push(entry);
          }
        }
      }
    }

    return entries;
  }

  /**
   * 解析单条训练文本
   * 支持多种格式：
   * - "PlayerName has been trained by the director"
   * - "Director has trained PlayerName"
   * - "You trained PlayerName"
   * - "PlayerName was trained"
   */
  function parseTrainingText(text) {
    if (!text || typeof text !== 'string') return null;

    const cleaned = text.replace(/\s+/g, ' ').trim();

    // 模式1: "X has been trained by Y" 或 "X has been trained"
    const trainedByRe = /(.+?)\s+has\s+been\s+trained(?:\s+by\s+(.+?))?(?:\.|$)/i;
    let match = cleaned.match(trainedByRe);
    if (match) {
      return {
        playerName: match[1].trim(),
        trainer: (match[2] || 'director').trim(),
        action: 'trained',
        rawText: cleaned
      };
    }

    // 模式2: "Y has trained X" 或 "Y trained X"
    const hasTrainedRe = /(.+?)\s+(?:has\s+)?trained\s+(.+?)(?:\.|$)/i;
    match = cleaned.match(hasTrainedRe);
    if (match) {
      return {
        playerName: match[2].trim(),
        trainer: match[1].trim(),
        action: 'trained',
        rawText: cleaned
      };
    }

    // 模式3: "You trained X"
    const youTrainedRe = /(?:You|Director)\s+trained\s+(.+?)(?:\.|$)/i;
    match = cleaned.match(youTrainedRe);
    if (match) {
      return {
        playerName: match[1].trim(),
        trainer: 'director',
        action: 'trained',
        rawText: cleaned
      };
    }

    // 模式4: "X was trained"
    const wasTrainedRe = /(.+?)\s+was\s+trained(?:\s+by\s+(.+?))?(?:\.|$)/i;
    match = cleaned.match(wasTrainedRe);
    if (match) {
      return {
        playerName: match[1].trim(),
        trainer: (match[2] || 'director').trim(),
        action: 'trained',
        rawText: cleaned
      };
    }

    return null;
  }

  /**
   * 备用解析：尝试拦截 XHR 响应
   * 如果 DOM 解析失败，尝试从页面中查找已加载的数据
   */
  function parseAlternative() {
    const entries = [];

    // 尝试查找包含训练数据的 JSON 或 script 标签
    const scripts = document.querySelectorAll('script[type="application/json"], script[data-news]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data && (data.news || data.training || data.entries)) {
          const newsItems = data.news || data.training || data.entries || [];
          for (const item of newsItems) {
            const text = item.text || item.news || item.content || '';
            const entry = parseTrainingText(text);
            if (entry) {
              if (item.timestamp) entry.timestamp = item.timestamp;
              entries.push(entry);
            }
          }
        }
      } catch (e) { /* ignore parse errors */ }
    }

    return entries;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
