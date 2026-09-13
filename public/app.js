/**
 * LearningApp — Mobile book reader with swipe navigation
 *
 * Features:
 * - Horizontal swipe between pages (CSS scroll-snap)
 * - Lazy image loading with preload-ahead buffer
 * - Bookmarks (localStorage)
 * - Reading position memory (localStorage)
 * - Theme switching (dark / light / sepia)
 * - Page slider for quick jump
 * - Pinch-to-zoom on page images
 */

(function () {
  "use strict";

  // ── State ──
  let totalPages = 0;
  let currentPage = 1;
  let preloadCount = 4;
  let bookmarks = new Set();
  let barsVisible = true;
  let sliderVisible = false;

  // ── DOM refs ──
  const reader = document.getElementById("reader");
  const pageIndicator = document.getElementById("page-indicator");
  const progressFill = document.getElementById("progress-fill");
  const topbar = document.getElementById("topbar");
  const loader = document.getElementById("loader");
  const loaderFill = loader.querySelector(".loader-fill");

  const btnBookmark = document.getElementById("btn-bookmark");
  const btnSettings = document.getElementById("btn-settings");
  const btnToc = document.getElementById("btn-toc");

  const bookmarksPanel = document.getElementById("bookmarks-panel");
  const bookmarksList = document.getElementById("bookmarks-list");
  const closeBookmarks = document.getElementById("close-bookmarks");

  const settingsPanel = document.getElementById("settings-panel");
  const closeSettings = document.getElementById("close-settings");
  const themeSelect = document.getElementById("theme-select");
  const preloadSelect = document.getElementById("preload-select");

  const pageSliderContainer = document.getElementById("page-slider-container");
  const pageSlider = document.getElementById("page-slider");
  const sliderLabel = document.getElementById("slider-label");

  const overlay = document.getElementById("overlay");

  // ── Init ──
  async function init() {
    loadSettings();
    loadBookmarks();

    try {
      const resp = await fetch("pages/manifest.json");
      if (!resp.ok) throw new Error("No manifest");
      const manifest = await resp.json();
      totalPages = manifest.total_pages;
    } catch {
      // Fallback: probe for pages
      totalPages = await probePageCount();
    }

    if (totalPages === 0) {
      loaderFill.style.width = "100%";
      loader.querySelector(".loader-text").textContent =
        "No pages found. Run the extraction script first.";
      return;
    }

    pageSlider.max = totalPages;
    buildPageCards();

    // Restore last reading position
    const saved = localStorage.getItem("la-current-page");
    if (saved) {
      const p = parseInt(saved, 10);
      if (p >= 1 && p <= totalPages) currentPage = p;
    }

    // Load initial + nearby pages
    loadVisiblePages();

    // Jump to saved page
    if (currentPage > 1) {
      const card = reader.children[currentPage - 1];
      if (card) reader.scrollTo({ left: card.offsetLeft, behavior: "instant" });
    }

    updateUI();
    hideLoader();
    setupEvents();
  }

  async function probePageCount() {
    // Binary search for max page
    let lo = 0,
      hi = 1000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      const name = `pages/page-${String(mid).padStart(3, "0")}.webp`;
      try {
        const r = await fetch(name, { method: "HEAD" });
        if (r.ok) lo = mid;
        else hi = mid - 1;
      } catch {
        hi = mid - 1;
      }
    }
    return lo;
  }

  function buildPageCards() {
    const frag = document.createDocumentFragment();
    for (let i = 1; i <= totalPages; i++) {
      const card = document.createElement("div");
      card.className = "page-card";
      card.dataset.page = i;

      const placeholder = document.createElement("div");
      placeholder.className = "page-placeholder";
      placeholder.textContent = `Page ${i}`;
      card.appendChild(placeholder);

      frag.appendChild(card);
    }
    reader.appendChild(frag);
    loaderFill.style.width = "50%";
  }

  // ── Lazy loading ──
  function loadVisiblePages() {
    const start = Math.max(1, currentPage - 1);
    const end = Math.min(totalPages, currentPage + preloadCount);

    for (let i = start; i <= end; i++) {
      loadPage(i);
    }
  }

  function loadPage(num) {
    const card = reader.children[num - 1];
    if (!card || card.dataset.loaded) return;

    const src = `pages/page-${String(num).padStart(3, "0")}.webp`;
    const img = new Image();
    img.className = "loading";
    img.alt = `Page ${num}`;
    img.loading = "lazy";
    img.decoding = "async";

    img.onload = () => {
      img.classList.remove("loading");
      img.classList.add("loaded");
    };
    img.onerror = () => {
      // Keep placeholder visible
    };
    img.src = src;

    // Replace placeholder with image
    card.innerHTML = "";
    card.appendChild(img);
    card.dataset.loaded = "true";
  }

  // ── Scroll / swipe detection ──
  function onScroll() {
    const scrollLeft = reader.scrollLeft;
    const pageWidth = window.innerWidth;
    const newPage = Math.round(scrollLeft / pageWidth) + 1;

    if (newPage !== currentPage && newPage >= 1 && newPage <= totalPages) {
      currentPage = newPage;
      updateUI();
      loadVisiblePages();
      savePosition();
    }
  }

  // ── UI updates ──
  function updateUI() {
    pageIndicator.textContent = `${currentPage} / ${totalPages}`;
    progressFill.style.width = `${(currentPage / totalPages) * 100}%`;
    pageSlider.value = currentPage;
    sliderLabel.textContent = `Page ${currentPage}`;

    // Update bookmark button
    btnBookmark.textContent = bookmarks.has(currentPage) ? "🔖" : "📑";
  }

  function hideLoader() {
    loaderFill.style.width = "100%";
    setTimeout(() => loader.classList.add("hidden"), 300);
  }

  // ── Navigation ──
  function goToPage(num) {
    if (num < 1 || num > totalPages) return;
    currentPage = num;
    const card = reader.children[num - 1];
    if (card) reader.scrollTo({ left: card.offsetLeft, behavior: "smooth" });
    updateUI();
    loadVisiblePages();
    savePosition();
  }

  // ── Bars toggle (tap center of screen) ──
  function toggleBars() {
    barsVisible = !barsVisible;
    topbar.classList.toggle("hidden", !barsVisible);
  }

  function toggleSlider() {
    sliderVisible = !sliderVisible;
    pageSliderContainer.classList.toggle("hidden", !sliderVisible);
  }

  // ── Bookmarks ──
  function toggleBookmark() {
    if (bookmarks.has(currentPage)) {
      bookmarks.delete(currentPage);
    } else {
      bookmarks.add(currentPage);
    }
    saveBookmarks();
    updateUI();
  }

  function renderBookmarks() {
    if (bookmarks.size === 0) {
      bookmarksList.innerHTML =
        '<p class="empty-msg">No bookmarks yet. Tap 📑 to add one.</p>';
      return;
    }
    const sorted = [...bookmarks].sort((a, b) => a - b);
    bookmarksList.innerHTML = sorted
      .map(
        (p) => `
      <div class="bookmark-item" data-page="${p}">
        <span class="page-num">Page ${p}</span>
        <button class="delete-btn" data-del="${p}">✕</button>
      </div>`
      )
      .join("");
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem("la-bookmarks");
      if (raw) bookmarks = new Set(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }

  function saveBookmarks() {
    localStorage.setItem("la-bookmarks", JSON.stringify([...bookmarks]));
  }

  function savePosition() {
    localStorage.setItem("la-current-page", String(currentPage));
  }

  // ── Settings ──
  function loadSettings() {
    const theme = localStorage.getItem("la-theme") || "dark";
    document.body.className = `theme-${theme}`;
    themeSelect.value = theme;

    const pl = localStorage.getItem("la-preload") || "4";
    preloadCount = parseInt(pl, 10);
    preloadSelect.value = pl;
  }

  // ── Panels ──
  function openPanel(panel) {
    panel.classList.remove("hidden");
    overlay.classList.remove("hidden");
  }

  function closePanels() {
    bookmarksPanel.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    overlay.classList.add("hidden");
  }

  // ── Events ──
  function setupEvents() {
    // Scroll-snap based page detection
    let scrollTimeout;
    reader.addEventListener(
      "scroll",
      () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(onScroll, 80);
      },
      { passive: true }
    );

    // Tap center to toggle bars
    reader.addEventListener("click", (e) => {
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      // Center 40% of screen toggles bars
      if (x > 0.3 && x < 0.7 && y > 0.3 && y < 0.7) {
        toggleBars();
        toggleSlider();
      }
    });

    // Bookmark
    btnBookmark.addEventListener("click", toggleBookmark);

    // Settings
    btnSettings.addEventListener("click", () => {
      openPanel(settingsPanel);
    });
    closeSettings.addEventListener("click", closePanels);

    themeSelect.addEventListener("change", () => {
      document.body.className = `theme-${themeSelect.value}`;
      localStorage.setItem("la-theme", themeSelect.value);
    });

    preloadSelect.addEventListener("change", () => {
      preloadCount = parseInt(preloadSelect.value, 10);
      localStorage.setItem("la-preload", preloadSelect.value);
      loadVisiblePages();
    });

    // Bookmarks panel
    btnToc.addEventListener("click", () => {
      renderBookmarks();
      openPanel(bookmarksPanel);
    });
    closeBookmarks.addEventListener("click", closePanels);
    bookmarksList.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) {
        bookmarks.delete(parseInt(del.dataset.del, 10));
        saveBookmarks();
        renderBookmarks();
        updateUI();
        return;
      }
      const item = e.target.closest("[data-page]");
      if (item) {
        closePanels();
        goToPage(parseInt(item.dataset.page, 10));
      }
    });

    // Overlay click closes panels
    overlay.addEventListener("click", closePanels);

    // Page slider
    pageSlider.addEventListener("input", () => {
      sliderLabel.textContent = `Page ${pageSlider.value}`;
    });
    pageSlider.addEventListener("change", () => {
      goToPage(parseInt(pageSlider.value, 10));
    });

    // Keyboard navigation (for desktop testing)
    document.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") goToPage(currentPage + 1);
      if (e.key === "ArrowLeft") goToPage(currentPage - 1);
    });
  }

  // ── Boot ──
  init();
})();
