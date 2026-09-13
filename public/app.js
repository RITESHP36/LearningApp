/**
 * LearningApp — Doom-scroll book reader
 *
 * Two modes:
 * 1. REELS (default) — vertical scroll, random page order, like TikTok/Reels
 * 2. BOOK — horizontal swipe, sequential order, classic reader
 *
 * Features:
 * - Pinch-to-zoom on every page (custom touch handler)
 * - Lazy loading with preload buffer
 * - Bookmarks (localStorage)
 * - Reading position memory
 * - Dark / Light / Sepia themes
 */

(function () {
  "use strict";

  // ── Config ──
  const REELS_BUFFER = 10;       // How many reel cards to keep loaded at once
  const REELS_LOAD_AHEAD = 3;    // Load N cards ahead of current
  const BOOK_PRELOAD = 4;        // Preload N pages ahead in book mode

  // ── State ──
  let totalPages = 0;
  let mode = "reels";            // "reels" or "book"
  let bookmarks = new Set();
  let barsVisible = false;

  // Reels state
  let reelOrder = [];            // Shuffled page numbers
  let reelIndex = 0;             // Current position in reelOrder
  let reelCards = [];             // Currently rendered card metadata

  // Book state
  let bookPage = 1;

  // Zoom state (per-card)
  let activeZoom = null;         // { wrapper, img, scale, tx, ty, ... }

  // ── DOM refs ──
  const readerReels = document.getElementById("reader-reels");
  const readerBook = document.getElementById("reader-book");
  const pageIndicator = document.getElementById("page-indicator");
  const progressFill = document.getElementById("progress-fill");
  const progressBar = document.getElementById("progress-bar");
  const topbar = document.getElementById("topbar");
  const loader = document.getElementById("loader");
  const loaderFill = loader.querySelector(".loader-fill");
  const pagePill = document.getElementById("page-pill");

  const btnMode = document.getElementById("btn-mode");
  const btnBookmark = document.getElementById("btn-bookmark");
  const btnSettings = document.getElementById("btn-settings");
  const btnToc = document.getElementById("btn-toc");

  const bookmarksPanel = document.getElementById("bookmarks-panel");
  const bookmarksList = document.getElementById("bookmarks-list");
  const closeBookmarks = document.getElementById("close-bookmarks");

  const settingsPanel = document.getElementById("settings-panel");
  const closeSettings = document.getElementById("close-settings");
  const themeSelect = document.getElementById("theme-select");

  const pageSliderContainer = document.getElementById("page-slider-container");
  const pageSlider = document.getElementById("page-slider");
  const sliderLabel = document.getElementById("slider-label");

  const overlay = document.getElementById("overlay");

  // ═══════════════════════════
  // INIT
  // ═══════════════════════════
  async function init() {
    loadSettings();
    loadBookmarks();

    try {
      const resp = await fetch("pages/manifest.json");
      if (!resp.ok) throw new Error("No manifest");
      const manifest = await resp.json();
      totalPages = manifest.total_pages;
    } catch {
      totalPages = await probePageCount();
    }

    if (totalPages === 0) {
      loaderFill.style.width = "100%";
      loader.querySelector(".loader-text").textContent =
        "No pages found. Run the extraction script first.";
      return;
    }

    pageSlider.max = totalPages;

    // Restore mode
    const savedMode = localStorage.getItem("la-mode") || "reels";
    mode = savedMode;

    if (mode === "reels") {
      initReels();
    } else {
      initBook();
    }

    updateModeUI();
    hideLoader();
    setupGlobalEvents();
  }

  async function probePageCount() {
    let lo = 0, hi = 1000;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      try {
        const r = await fetch(`pages/page-${String(mid).padStart(3, "0")}.webp`, { method: "HEAD" });
        if (r.ok) lo = mid; else hi = mid - 1;
      } catch { hi = mid - 1; }
    }
    return lo;
  }

  function hideLoader() {
    loaderFill.style.width = "100%";
    setTimeout(() => loader.classList.add("hidden"), 300);
  }

  // ═══════════════════════════
  // IMAGE LOADING
  // ═══════════════════════════
  function pageUrl(num) {
    return `pages/page-${String(num).padStart(3, "0")}.webp`;
  }

  function createPageImage(pageNum, card) {
    const wrapper = document.createElement("div");
    wrapper.className = "zoom-wrapper";

    const img = new Image();
    img.className = "loading";
    img.alt = `Page ${pageNum}`;
    img.decoding = "async";
    img.src = pageUrl(pageNum);

    img.onload = () => {
      img.classList.remove("loading");
      img.classList.add("loaded");
    };

    wrapper.appendChild(img);
    setupPinchZoom(wrapper, img);
    return wrapper;
  }

  // ═══════════════════════════
  // PINCH-TO-ZOOM
  // ═══════════════════════════
  function setupPinchZoom(wrapper, img) {
    let scale = 1, lastScale = 1;
    let tx = 0, ty = 0, lastTx = 0, lastTy = 0;
    let startDist = 0, startMidX = 0, startMidY = 0;
    let isPinching = false;

    function getDistance(t1, t2) {
      const dx = t1.clientX - t2.clientX;
      const dy = t1.clientY - t2.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getMidpoint(t1, t2) {
      return {
        x: (t1.clientX + t2.clientX) / 2,
        y: (t1.clientY + t2.clientY) / 2
      };
    }

    function clampTranslation() {
      if (scale <= 1) { tx = 0; ty = 0; return; }
      const rect = wrapper.getBoundingClientRect();
      const imgW = img.naturalWidth * (rect.width / img.naturalWidth) * scale;
      const imgH = img.naturalHeight * (rect.height / img.naturalHeight) * scale;
      const maxTx = Math.max(0, (imgW - rect.width) / 2);
      const maxTy = Math.max(0, (imgH - rect.height) / 2);
      tx = Math.max(-maxTx, Math.min(maxTx, tx));
      ty = Math.max(-maxTy, Math.min(maxTy, ty));
    }

    function applyTransform() {
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      img.style.transformOrigin = "center center";
    }

    function resetZoom() {
      scale = 1; lastScale = 1;
      tx = 0; ty = 0; lastTx = 0; lastTy = 0;
      img.style.transform = "";
      // Re-enable scroll snap on the parent
      wrapper.closest(".reel-card, .book-card")?.style.removeProperty("scroll-snap-align");
    }

    wrapper.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        isPinching = true;
        startDist = getDistance(e.touches[0], e.touches[1]);
        const mid = getMidpoint(e.touches[0], e.touches[1]);
        startMidX = mid.x;
        startMidY = mid.y;
        lastScale = scale;
        lastTx = tx;
        lastTy = ty;
        e.preventDefault();
      }
    }, { passive: false });

    wrapper.addEventListener("touchmove", (e) => {
      if (isPinching && e.touches.length === 2) {
        e.preventDefault();
        const dist = getDistance(e.touches[0], e.touches[1]);
        const mid = getMidpoint(e.touches[0], e.touches[1]);

        scale = Math.max(1, Math.min(5, lastScale * (dist / startDist)));

        // Pan follows the midpoint
        tx = lastTx + (mid.x - startMidX);
        ty = lastTy + (mid.y - startMidY);

        clampTranslation();
        applyTransform();

        // Disable scroll snap while zoomed to allow panning
        if (scale > 1) {
          const card = wrapper.closest(".reel-card, .book-card");
          if (card) card.style.scrollSnapAlign = "none";
        }
      } else if (e.touches.length === 1 && scale > 1) {
        // Single finger pan while zoomed
        e.preventDefault();
        const touch = e.touches[0];
        if (!wrapper._lastTouch) {
          wrapper._lastTouch = { x: touch.clientX, y: touch.clientY };
          return;
        }
        tx += touch.clientX - wrapper._lastTouch.x;
        ty += touch.clientY - wrapper._lastTouch.y;
        wrapper._lastTouch = { x: touch.clientX, y: touch.clientY };
        clampTranslation();
        applyTransform();
      }
    }, { passive: false });

    wrapper.addEventListener("touchend", (e) => {
      isPinching = false;
      wrapper._lastTouch = null;
      if (scale <= 1.05) {
        resetZoom();
      }
    });

    // Double-tap to zoom in/out
    let lastTap = 0;
    wrapper.addEventListener("touchend", (e) => {
      if (e.touches.length > 0) return;
      const now = Date.now();
      if (now - lastTap < 300) {
        e.preventDefault();
        if (scale > 1) {
          resetZoom();
        } else {
          scale = 2.5;
          // Zoom toward the tap point
          const rect = wrapper.getBoundingClientRect();
          const tapX = e.changedTouches[0].clientX - rect.left;
          const tapY = e.changedTouches[0].clientY - rect.top;
          tx = (rect.width / 2 - tapX) * (scale - 1);
          ty = (rect.height / 2 - tapY) * (scale - 1);
          clampTranslation();
          applyTransform();
          const card = wrapper.closest(".reel-card, .book-card");
          if (card) card.style.scrollSnapAlign = "none";
        }
        lastTap = 0;
      } else {
        lastTap = now;
      }
    });

    // Expose reset for mode switching
    wrapper._resetZoom = resetZoom;
  }

  // ═══════════════════════════
  // REELS MODE
  // ═══════════════════════════
  function shuffleArray(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function initReels() {
    // Create shuffled order of all pages
    reelOrder = shuffleArray(
      Array.from({ length: totalPages }, (_, i) => i + 1)
    );

    // Restore position if available
    const savedIdx = parseInt(localStorage.getItem("la-reel-index") || "0", 10);
    const savedOrder = localStorage.getItem("la-reel-order");
    if (savedOrder) {
      try {
        const parsed = JSON.parse(savedOrder);
        if (parsed.length === totalPages) {
          reelOrder = parsed;
          reelIndex = Math.min(savedIdx, reelOrder.length - 1);
        }
      } catch { /* use fresh shuffle */ }
    }

    readerReels.innerHTML = "";
    reelCards = [];

    // Build initial cards
    const start = Math.max(0, reelIndex - 1);
    const end = Math.min(reelOrder.length, reelIndex + REELS_BUFFER);
    for (let i = start; i < end; i++) {
      appendReelCard(i);
    }

    // Scroll to current
    requestAnimationFrame(() => {
      const targetCard = readerReels.querySelector(`[data-reel-idx="${reelIndex}"]`);
      if (targetCard) {
        readerReels.scrollTo({ top: targetCard.offsetTop, behavior: "instant" });
      }
    });

    setupReelsEvents();
    updateReelsUI();
  }

  function appendReelCard(orderIdx) {
    if (orderIdx < 0 || orderIdx >= reelOrder.length) return;
    // Don't duplicate
    if (readerReels.querySelector(`[data-reel-idx="${orderIdx}"]`)) return;

    const pageNum = reelOrder[orderIdx];
    const card = document.createElement("div");
    card.className = "reel-card";
    card.dataset.reelIdx = orderIdx;
    card.dataset.page = pageNum;

    const wrapper = createPageImage(pageNum, card);
    card.appendChild(wrapper);

    // Page label
    const label = document.createElement("div");
    label.className = "reel-page-label";
    label.textContent = `p. ${pageNum}`;
    card.appendChild(label);

    readerReels.appendChild(card);
    reelCards.push({ orderIdx, pageNum, el: card });
  }

  function loadMoreReels() {
    // Add cards ahead of current position
    const lastIdx = reelCards.length > 0
      ? Math.max(...reelCards.map(c => c.orderIdx))
      : reelIndex;

    for (let i = lastIdx + 1; i <= lastIdx + REELS_LOAD_AHEAD && i < reelOrder.length; i++) {
      appendReelCard(i);
    }

    // If we're running low on pages, reshuffle and append more
    if (lastIdx + REELS_LOAD_AHEAD >= reelOrder.length) {
      const moreShuffle = shuffleArray(
        Array.from({ length: totalPages }, (_, i) => i + 1)
      );
      reelOrder.push(...moreShuffle);
    }
  }

  function setupReelsEvents() {
    let scrollTimeout;
    let pillTimeout;

    readerReels.addEventListener("scroll", () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const scrollTop = readerReels.scrollTop;
        const cardHeight = window.innerHeight;
        const newIdx = Math.round(scrollTop / cardHeight);

        // Find the card at this scroll position
        const cards = readerReels.querySelectorAll(".reel-card");
        if (cards[newIdx]) {
          const idx = parseInt(cards[newIdx].dataset.reelIdx, 10);
          if (idx !== reelIndex) {
            reelIndex = idx;
            updateReelsUI();
            saveReelsState();
            loadMoreReels();
          }
        }
      }, 60);

      // Show page pill briefly
      const scrollTop = readerReels.scrollTop;
      const cardHeight = window.innerHeight;
      const visibleIdx = Math.round(scrollTop / cardHeight);
      const cards = readerReels.querySelectorAll(".reel-card");
      if (cards[visibleIdx]) {
        const pg = cards[visibleIdx].dataset.page;
        pagePill.textContent = `Page ${pg}`;
        pagePill.classList.remove("hidden");
        clearTimeout(pillTimeout);
        pillTimeout = setTimeout(() => pagePill.classList.add("hidden"), 800);
      }
    }, { passive: true });

    // Tap center to toggle bars
    readerReels.addEventListener("click", (e) => {
      if (e.target.closest(".icon-btn")) return;
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      if (x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75) {
        toggleBars();
      }
    });
  }

  function updateReelsUI() {
    const pageNum = reelOrder[reelIndex] || 1;
    pageIndicator.textContent = `Page ${pageNum}`;
    btnBookmark.textContent = bookmarks.has(pageNum) ? "🔖" : "📑";
  }

  function saveReelsState() {
    localStorage.setItem("la-reel-index", String(reelIndex));
    // Only save first 1000 entries of the order to avoid quota issues
    localStorage.setItem("la-reel-order", JSON.stringify(reelOrder.slice(0, 1000)));
  }

  function getCurrentPageNum() {
    if (mode === "reels") return reelOrder[reelIndex] || 1;
    return bookPage;
  }

  // ═══════════════════════════
  // BOOK MODE
  // ═══════════════════════════
  function initBook() {
    readerBook.innerHTML = "";

    for (let i = 1; i <= totalPages; i++) {
      const card = document.createElement("div");
      card.className = "book-card";
      card.dataset.page = i;

      const placeholder = document.createElement("div");
      placeholder.className = "reel-placeholder";
      placeholder.textContent = `Page ${i}`;
      card.appendChild(placeholder);

      readerBook.appendChild(card);
    }

    // Restore position
    const saved = parseInt(localStorage.getItem("la-book-page") || "1", 10);
    bookPage = Math.max(1, Math.min(totalPages, saved));

    loadBookPages();

    requestAnimationFrame(() => {
      const card = readerBook.children[bookPage - 1];
      if (card) readerBook.scrollTo({ left: card.offsetLeft, behavior: "instant" });
    });

    setupBookEvents();
    updateBookUI();
  }

  function loadBookPages() {
    const start = Math.max(1, bookPage - 1);
    const end = Math.min(totalPages, bookPage + BOOK_PRELOAD);
    for (let i = start; i <= end; i++) {
      loadBookPage(i);
    }
  }

  function loadBookPage(num) {
    const card = readerBook.children[num - 1];
    if (!card || card.dataset.loaded) return;

    const wrapper = createPageImage(num, card);
    card.innerHTML = "";
    card.appendChild(wrapper);
    card.dataset.loaded = "true";
  }

  function setupBookEvents() {
    let scrollTimeout;
    readerBook.addEventListener("scroll", () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const scrollLeft = readerBook.scrollLeft;
        const pageWidth = window.innerWidth;
        const newPage = Math.round(scrollLeft / pageWidth) + 1;
        if (newPage !== bookPage && newPage >= 1 && newPage <= totalPages) {
          bookPage = newPage;
          updateBookUI();
          loadBookPages();
          localStorage.setItem("la-book-page", String(bookPage));
        }
      }, 80);
    }, { passive: true });

    // Tap center to toggle bars + slider
    readerBook.addEventListener("click", (e) => {
      if (e.target.closest(".icon-btn")) return;
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      if (x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75) {
        toggleBars();
        pageSliderContainer.classList.toggle("hidden");
      }
    });
  }

  function updateBookUI() {
    pageIndicator.textContent = `${bookPage} / ${totalPages}`;
    progressFill.style.width = `${(bookPage / totalPages) * 100}%`;
    pageSlider.value = bookPage;
    sliderLabel.textContent = `Page ${bookPage}`;
    btnBookmark.textContent = bookmarks.has(bookPage) ? "🔖" : "📑";
  }

  function goToBookPage(num) {
    if (num < 1 || num > totalPages) return;
    bookPage = num;
    loadBookPages();
    const card = readerBook.children[num - 1];
    if (card) readerBook.scrollTo({ left: card.offsetLeft, behavior: "smooth" });
    updateBookUI();
    localStorage.setItem("la-book-page", String(bookPage));
  }

  // ═══════════════════════════
  // MODE SWITCHING
  // ═══════════════════════════
  function switchMode() {
    // Reset any active zoom
    document.querySelectorAll(".zoom-wrapper").forEach(w => {
      if (w._resetZoom) w._resetZoom();
    });

    if (mode === "reels") {
      mode = "book";
      readerReels.classList.add("hidden");
      readerBook.classList.remove("hidden");
      progressBar.classList.remove("hidden");
      pagePill.classList.add("hidden");

      if (readerBook.children.length === 0) initBook();
      else updateBookUI();
    } else {
      mode = "reels";
      readerBook.classList.add("hidden");
      readerReels.classList.remove("hidden");
      progressBar.classList.add("hidden");
      pageSliderContainer.classList.add("hidden");

      if (reelCards.length === 0) initReels();
      else updateReelsUI();
    }

    localStorage.setItem("la-mode", mode);
    updateModeUI();
  }

  function updateModeUI() {
    if (mode === "reels") {
      readerReels.classList.remove("hidden");
      readerBook.classList.add("hidden");
      progressBar.classList.add("hidden");
      pageSliderContainer.classList.add("hidden");
      btnMode.textContent = "📖";
      btnMode.title = "Switch to Book mode";
    } else {
      readerReels.classList.add("hidden");
      readerBook.classList.remove("hidden");
      progressBar.classList.remove("hidden");
      btnMode.textContent = "🔀";
      btnMode.title = "Switch to Reels mode";
    }
  }

  // ═══════════════════════════
  // BARS / UI TOGGLE
  // ═══════════════════════════
  function toggleBars() {
    barsVisible = !barsVisible;
    topbar.classList.toggle("hidden", !barsVisible);
  }

  // ═══════════════════════════
  // BOOKMARKS
  // ═══════════════════════════
  function toggleBookmark() {
    const pg = getCurrentPageNum();
    if (bookmarks.has(pg)) bookmarks.delete(pg);
    else bookmarks.add(pg);
    saveBookmarks();
    if (mode === "reels") updateReelsUI();
    else updateBookUI();
  }

  function renderBookmarks() {
    if (bookmarks.size === 0) {
      bookmarksList.innerHTML =
        '<p class="empty-msg">No bookmarks yet. Tap 📑 to add one.</p>';
      return;
    }
    const sorted = [...bookmarks].sort((a, b) => a - b);
    bookmarksList.innerHTML = sorted
      .map(p => `
        <div class="bookmark-item" data-page="${p}">
          <span class="page-num">Page ${p}</span>
          <button class="delete-btn" data-del="${p}">✕</button>
        </div>`)
      .join("");
  }

  function loadBookmarks() {
    try {
      const raw = localStorage.getItem("la-bookmarks");
      if (raw) bookmarks = new Set(JSON.parse(raw));
    } catch { /* ignore */ }
  }

  function saveBookmarks() {
    localStorage.setItem("la-bookmarks", JSON.stringify([...bookmarks]));
  }

  // ═══════════════════════════
  // SETTINGS
  // ═══════════════════════════
  function loadSettings() {
    const theme = localStorage.getItem("la-theme") || "dark";
    document.body.className = `theme-${theme}`;
    themeSelect.value = theme;
  }

  // ═══════════════════════════
  // PANELS
  // ═══════════════════════════
  function openPanel(panel) {
    panel.classList.remove("hidden");
    overlay.classList.remove("hidden");
  }

  function closePanels() {
    bookmarksPanel.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    overlay.classList.add("hidden");
  }

  // ═══════════════════════════
  // GLOBAL EVENTS
  // ═══════════════════════════
  function setupGlobalEvents() {
    // Mode toggle
    btnMode.addEventListener("click", switchMode);

    // Bookmark
    btnBookmark.addEventListener("click", toggleBookmark);

    // Settings
    btnSettings.addEventListener("click", () => openPanel(settingsPanel));
    closeSettings.addEventListener("click", closePanels);

    themeSelect.addEventListener("change", () => {
      document.body.className = `theme-${themeSelect.value}`;
      localStorage.setItem("la-theme", themeSelect.value);
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
        if (mode === "reels") updateReelsUI();
        else updateBookUI();
        return;
      }
      const item = e.target.closest("[data-page]");
      if (item) {
        closePanels();
        const pg = parseInt(item.dataset.page, 10);
        if (mode === "book") {
          goToBookPage(pg);
        }
        // In reels mode, bookmarks are for reference — can't jump to a random position easily
      }
    });

    // Overlay
    overlay.addEventListener("click", closePanels);

    // Page slider (book mode)
    pageSlider.addEventListener("input", () => {
      sliderLabel.textContent = `Page ${pageSlider.value}`;
    });
    pageSlider.addEventListener("change", () => {
      goToBookPage(parseInt(pageSlider.value, 10));
    });

    // Keyboard (desktop testing)
    document.addEventListener("keydown", (e) => {
      if (mode === "book") {
        if (e.key === "ArrowRight") goToBookPage(bookPage + 1);
        if (e.key === "ArrowLeft") goToBookPage(bookPage - 1);
      }
      if (e.key === "ArrowDown" && mode === "reels") {
        readerReels.scrollBy({ top: window.innerHeight, behavior: "smooth" });
      }
      if (e.key === "ArrowUp" && mode === "reels") {
        readerReels.scrollBy({ top: -window.innerHeight, behavior: "smooth" });
      }
    });
  }

  // ── Boot ──
  init();
})();
