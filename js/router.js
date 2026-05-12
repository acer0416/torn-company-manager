/**
 * router.js - Hash-based SPA Router
 * Defines window.Router for single-page navigation
 */

window.Router = {
  /** @type {Object<string, {init?: Function, render: Function, _initialized?: boolean}>} */
  pages: {},

  /** @type {string|null} */
  currentPage: null,

  /**
   * Register a page in the router
   * @param {string} name - Page name (matches hash after #/)
   * @param {Object} pageObj - Page object with init() and render() methods
   */
  register(name, pageObj) {
    this.pages[name] = pageObj;
  },

  /**
   * Initialize the router - listen for hash changes and navigate to current hash
   */
  init() {
    window.addEventListener('hashchange', () => {
      this.navigate(location.hash);
    });

    // Navigate to current hash or default
    const hash = location.hash || '#/dashboard';
    this.navigate(hash);
  },

  /**
   * Navigate to a hash route
   * @param {string} hash - Hash string (e.g. '#/dashboard')
   */
  navigate(hash) {
    // Parse hash: '#/page' -> 'page', '#/page/sub' -> 'page'
    const hashStr = hash.replace(/^#\/?/, '');
    const pageName = hashStr.split('/')[0] || 'dashboard';

    const page = this.pages[pageName];
    if (!page) {
      console.warn(`[Router] Page not found: ${pageName}`);
      // Fall back to dashboard if the requested page doesn't exist
      if (pageName !== 'dashboard' && this.pages['dashboard']) {
        location.hash = '#/dashboard';
        return;
      }
      return;
    }

    // Call init() on first visit
    if (!page._initialized && typeof page.init === 'function') {
      try {
        page.init();
      } catch (err) {
        console.error(`[Router] Error initializing page "${pageName}":`, err);
      }
      page._initialized = true;
    }

    // Render the page
    this.currentPage = pageName;
    try {
      page.render();
    } catch (err) {
      console.error(`[Router] Error rendering page "${pageName}":`, err);
      const content = document.getElementById('page-content');
      if (content) {
        content.innerHTML = `
          <div class="text-center py-20 text-torn-accent">
            <i class="fas fa-exclamation-triangle text-3xl mb-3"></i>
            <p>页面加载错误: ${err.message}</p>
          </div>
        `;
      }
    }

    // Update sidebar nav active states
    this._updateNavActive(pageName);
  },

  /**
   * Re-render the current page
   */
  refresh() {
    if (this.currentPage && this.pages[this.currentPage]) {
      const page = this.pages[this.currentPage];
      try {
        page.render();
      } catch (err) {
        console.error(`[Router] Error refreshing page "${this.currentPage}":`, err);
      }
    }
  },

  /**
   * Update active state on sidebar nav items
   * @private
   * @param {string} activePage - Name of the active page
   */
  _updateNavActive(activePage) {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
      const href = item.getAttribute('href') || item.dataset.page || '';
      const itemName = href.replace(/^#\/?/, '').split('/')[0];
      if (itemName === activePage) {
        item.classList.add('active');
      } else {
        item.classList.remove('active');
      }
    });
  }
};
