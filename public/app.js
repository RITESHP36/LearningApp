/**
 * LearningApp — Doom-scroll book reader
 *
 * Two modes:
 * 1. REELS (default) — vertical scroll, random page order, like TikTok/Reels
 * 2. BOOK — horizontal swipe, sequential order, classic reader
 *
 * Features:
 * - Pinch-to-zoom with scroll-lock (prevents page change during zoom)
 * - Zoom +/- buttons and prev/next navigation
 * - Lazy loading with preload buffer
 * - Bookmarks (localStorage)
 * - Reading position memory
 * - Dark / Light / Sepia themes
 */

(function () {
  "use strict";

  // ── Version — bump this to force-clear stale caches ──
  const APP_VERSION = 3;
  const storedVersion = parseInt(localStorage.getItem("la-version") || "0", 10);
  if (storedVersion < APP_VERSION) {
    localStorage.removeItem("la-reel-order");
    localStorage.removeItem("la-reel-index");
    localStorage.removeItem("la-current-page");
    localStorage.setItem("la-version", String(APP_VERSION));
  }

  // ── Config ──
  const CONTENT_START_PAGE = 12;
  const REELS_BUFFER = 10;
  const REELS_LOAD_AHEAD = 3;
  const BOOK_PRELOAD = 4;

  // ── State ──
  let totalPages = 0;
  let mode = "reels";
  let bookmarks = new Set();
  let barsVisible = false;

  // Reels state
  let reelOrder = [];
  let reelIndex = 0;
  let reelCards = [];

  // Book state
  let bookPage = 1;

  // Global zoom lock — prevents scroll-snap from firing during pinch
  let zoomLocked = false;
  let zoomLockTimeout = null;

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
  const btnZoomIn = document.getElementById("btn-zoom-in");
  const btnZoomOut = document.getElementById("btn-zoom-out");
  const btnPrev = document.getElementById("btn-prev");
  const btnNext = document.getElementById("btn-next");

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
  // SCROLL LOCK (prevents page change during zoom)
  // ═══════════════════════════
  function lockScroll() {
    if (zoomLocked) return;
    zoomLocked = true;
    clearTimeout(zoomLockTimeout);
    const reader = mode === "reels" ? readerReels : readerBook;
    reader.style.overflow = "hidden";
    reader.style.scrollSnapType = "none";
  }

  function unlockScroll() {
    // Delay unlock slightly so the snap doesn't fire from residual momentum
    clearTimeout(zoomLockTimeout);
    zoomLockTimeout = setTimeout(() => {
      zoomLocked = false;
      const reader = mode === "reels" ? readerReels : readerBook;
      reader.style.overflow = "";
      reader.style.scrollSnapType = "";
    }, 300);
  }

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

    const savedMode = localStorage.getItem("la-mode") || "reels";
    mode = savedMode;

    if (mode === "reels") initReels();
    else initBook();

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

  function createPageImage(pageNum) {
    const wrapper = document.createElement("div");
    wrapper.className = "zoom-wrapper";
    wrapper.dataset.pageNum = pageNum;

    const img = new Image();
    img.className = "loading";
    img.alt = `Page ${pageNum}`;
    img.decoding = "async";
    img.src = pageUrl(pageNum);
    img.onload = () => { img.classList.remove("loading"); img.classList.add("loaded"); };

    wrapper.appendChild(img);
    setupPinchZoom(wrapper, img);
    return wrapper;
  }

  // ═══════════════════════════
  // PINCH-TO-ZOOM (fixed for mobile scroll)
  // ═══════════════════════════
  function setupPinchZoom(wrapper, img) {
    let scale = 1, lastScale = 1;
    let tx = 0, ty = 0, lastTx = 0, lastTy = 0;
    let startDist = 0, startMidX = 0, startMidY = 0;
    let isPinching = false;

    function dist(t1, t2) {
      return Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    }
    function mid(t1, t2) {
      return { x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 };
    }

    function clamp() {
      if (scale <= 1) { tx = 0; ty = 0; return; }
      const r = wrapper.getBoundingClientRect();
      const maxTx = Math.max(0, (r.width * scale - r.width) / 2);
      const maxTy = Math.max(0, (r.height * scale - r.height) / 2);
      tx = Math.max(-maxTx, Math.min(maxTx, tx));
      ty = Math.max(-maxTy, Math.min(maxTy, ty));
    }

    function apply() {
      img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
      img.style.transformOrigin = "center center";
    }

    function reset() {
      scale = 1; lastScale = 1;
      tx = 0; ty = 0; lastTx = 0; lastTy = 0;
      img.style.transform = "";
      unlockScroll();
    }

    // ── Programmatic zoom (for buttons) ──
    wrapper._zoomTo = function(newScale) {
      lockScroll();
      scale = Math.max(1, Math.min(5, newScale));
      if (scale <= 1) { reset(); return; }
      clamp();
      apply();
    };
    wrapper._getScale = () => scale;
    wrapper._resetZoom = reset;

    // ── Touch handlers ──
    wrapper.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        isPinching = true;
        lockScroll(); // ← KEY: lock the whole scroll container immediately
        startDist = dist(e.touches[0], e.touches[1]);
        const m = mid(e.touches[0], e.touches[1]);
        startMidX = m.x; startMidY = m.y;
        lastScale = scale; lastTx = tx; lastTy = ty;
      }
    }, { passive: false, capture: true });

    wrapper.addEventListener("touchmove", (e) => {
      if (isPinching && e.touches.length === 2) {
        e.preventDefault();
        e.stopPropagation();
        const d = dist(e.touches[0], e.touches[1]);
        const m = mid(e.touches[0], e.touches[1]);
        scale = Math.max(1, Math.min(5, lastScale * (d / startDist)));
        tx = lastTx + (m.x - startMidX);
        ty = lastTy + (m.y - startMidY);
        clamp();
        apply();
      } else if (e.touches.length === 1 && scale > 1) {
        // Single-finger pan while zoomed
        e.preventDefault();
        e.stopPropagation();
        const t = e.touches[0];
        if (wrapper._lt) {
          tx += t.clientX - wrapper._lt.x;
          ty += t.clientY - wrapper._lt.y;
          clamp();
          apply();
        }
        wrapper._lt = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false, capture: true });

    wrapper.addEventListener("touchend", (e) => {
      if (isPinching) {
        isPinching = false;
        wrapper._lt = null;
        if (scale <= 1.05) reset();
        else unlockScroll(); // Stay zoomed but re-enable scroll after delay
        return;
      }
      wrapper._lt = null;
      if (scale <= 1.05 && !isPinching) {
        // Might be end of a single-finger pan — check if zoom is basically 1x
        if (scale <= 1.05) reset();
      }
    });

    // Double-tap to zoom
    let lastTap = 0;
    wrapper.addEventListener("click", (e) => {
      const now = Date.now();
      if (now - lastTap < 350) {
        e.preventDefault();
        if (scale > 1) {
          reset();
        } else {
          lockScroll();
          scale = 2.5;
          const r = wrapper.getBoundingClientRect();
          tx = (r.width / 2 - (e.clientX - r.left)) * (scale - 1);
          ty = (r.height / 2 - (e.clientY - r.top)) * (scale - 1);
          clamp();
          apply();
          // Keep locked until user resets
        }
        lastTap = 0;
      } else {
        lastTap = now;
      }
    });
  }

  // Get the zoom wrapper for the currently visible card
  function getActiveZoomWrapper() {
    const reader = mode === "reels" ? readerReels : readerBook;
    const cards = reader.querySelectorAll(".reel-card, .book-card");
    const scrollPos = mode === "reels" ? reader.scrollTop : reader.scrollLeft;
    const size = mode === "reels" ? window.innerHeight : window.innerWidth;
    const idx = Math.round(scrollPos / size);
    if (cards[idx]) return cards[idx].querySelector(".zoom-wrapper");
    return null;
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
    const contentPages = totalPages - CONTENT_START_PAGE + 1;
    reelOrder = shuffleArray(
      Array.from({ length: contentPages }, (_, i) => i + CONTENT_START_PAGE)
    );

    const savedIdx = parseInt(localStorage.getItem("la-reel-index") || "0", 10);
    const savedOrder = localStorage.getItem("la-reel-order");
    if (savedOrder) {
      try {
        const parsed = JSON.parse(savedOrder);
        if (parsed.length > 0 && parsed[0] >= CONTENT_START_PAGE) {
          reelOrder = parsed;
          reelIndex = Math.min(savedIdx, reelOrder.length - 1);
        }
      } catch { /* fresh shuffle */ }
    }

    readerReels.innerHTML = "";
    reelCards = [];

    const start = Math.max(0, reelIndex - 1);
    const end = Math.min(reelOrder.length, reelIndex + REELS_BUFFER);
    for (let i = start; i < end; i++) appendReelCard(i);

    requestAnimationFrame(() => {
      const t = readerReels.querySelector(`[data-reel-idx="${reelIndex}"]`);
      if (t) readerReels.scrollTo({ top: t.offsetTop, behavior: "instant" });
    });

    setupReelsEvents();
    updateReelsUI();
  }

  function appendReelCard(orderIdx) {
    if (orderIdx < 0 || orderIdx >= reelOrder.length) return;
    if (readerReels.querySelector(`[data-reel-idx="${orderIdx}"]`)) return;

    const pageNum = reelOrder[orderIdx];
    const card = document.createElement("div");
    card.className = "reel-card";
    card.dataset.reelIdx = orderIdx;
    card.dataset.page = pageNum;

    card.appendChild(createPageImage(pageNum));

    const label = document.createElement("div");
    label.className = "reel-page-label";
    label.textContent = `p. ${pageNum}`;
    card.appendChild(label);

    readerReels.appendChild(card);
    reelCards.push({ orderIdx, pageNum, el: card });
  }

  function loadMoreReels() {
    const lastIdx = reelCards.length > 0
      ? Math.max(...reelCards.map(c => c.orderIdx)) : reelIndex;
    for (let i = lastIdx + 1; i <= lastIdx + REELS_LOAD_AHEAD && i < reelOrder.length; i++)
      appendReelCard(i);
    if (lastIdx + REELS_LOAD_AHEAD >= reelOrder.length) {
      const contentPages = totalPages - CONTENT_START_PAGE + 1;
      reelOrder.push(...shuffleArray(
        Array.from({ length: contentPages }, (_, i) => i + CONTENT_START_PAGE)
      ));
    }
  }

  function setupReelsEvents() {
    let scrollTimeout, pillTimeout;
    readerReels.addEventListener("scroll", () => {
      if (zoomLocked) return; // Don't change pages while zoomed
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const cards = readerReels.querySelectorAll(".reel-card");
        const newIdx = Math.round(readerReels.scrollTop / window.innerHeight);
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

      // Page pill
      const visIdx = Math.round(readerReels.scrollTop / window.innerHeight);
      const cards = readerReels.querySelectorAll(".reel-card");
      if (cards[visIdx]) {
        pagePill.textContent = `Page ${cards[visIdx].dataset.page}`;
        pagePill.classList.remove("hidden");
        clearTimeout(pillTimeout);
        pillTimeout = setTimeout(() => pagePill.classList.add("hidden"), 800);
      }
    }, { passive: true });

    readerReels.addEventListener("click", (e) => {
      if (e.target.closest(".icon-btn, .nav-btn, .zoom-btn")) return;
      const x = e.clientX / window.innerWidth;
      const y = e.clientY / window.innerHeight;
      if (x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75) toggleBars();
    });
  }

  function updateReelsUI() {
    const pg = reelOrder[reelIndex] || 1;
    pageIndicator.textContent = `Page ${pg}`;
    btnBookmark.textContent = bookmarks.has(pg) ? "🔖" : "📑";
  }

  function saveReelsState() {
    localStorage.setItem("la-reel-index", String(reelIndex));
    localStorage.setItem("la-reel-order", JSON.stringify(reelOrder.slice(0, 1000)));
  }

  function getCurrentPageNum() {
    return mode === "reels" ? (reelOrder[reelIndex] || 1) : bookPage;
  }

  function goNextReel() {
    readerReels.scrollBy({ top: window.innerHeight, behavior: "smooth" });
  }
  function goPrevReel() {
    readerReels.scrollBy({ top: -window.innerHeight, behavior: "smooth" });
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
      const ph = document.createElement("div");
      ph.className = "reel-placeholder";
      ph.textContent = `Page ${i}`;
      card.appendChild(ph);
      readerBook.appendChild(card);
    }

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
    const s = Math.max(1, bookPage - 1), e = Math.min(totalPages, bookPage + BOOK_PRELOAD);
    for (let i = s; i <= e; i++) loadBookPage(i);
  }

  function loadBookPage(num) {
    const card = readerBook.children[num - 1];
    if (!card || card.dataset.loaded) return;
    card.innerHTML = "";
    card.appendChild(createPageImage(num));
    card.dataset.loaded = "true";
  }

  function setupBookEvents() {
    let scrollTimeout;
    readerBook.addEventListener("scroll", () => {
      if (zoomLocked) return;
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        const p = Math.round(readerBook.scrollLeft / window.innerWidth) + 1;
        if (p !== bookPage && p >= 1 && p <= totalPages) {
          bookPage = p;
          updateBookUI();
          loadBookPages();
          localStorage.setItem("la-book-page", String(bookPage));
        }
      }, 80);
    }, { passive: true });

    readerBook.addEventListener("click", (e) => {
      if (e.target.closest(".icon-btn, .nav-btn, .zoom-btn")) return;
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
    document.querySelectorAll(".zoom-wrapper").forEach(w => w._resetZoom?.());
    if (mode === "reels") {
      mode = "book";
      readerReels.classList.add("hidden");
      readerBook.classList.remove("hidden");
      progressBar.classList.remove("hidden");
      pagePill.classList.add("hidden");
      if (readerBook.children.length === 0) initBook(); else updateBookUI();
    } else {
      mode = "reels";
      readerBook.classList.add("hidden");
      readerReels.classList.remove("hidden");
      progressBar.classList.add("hidden");
      pageSliderContainer.classList.add("hidden");
      if (reelCards.length === 0) initReels(); else updateReelsUI();
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
    document.getElementById("nav-controls").classList.toggle("hidden", !barsVisible);
  }

  // ═══════════════════════════
  // BOOKMARKS
  // ═══════════════════════════
  function toggleBookmark() {
    const pg = getCurrentPageNum();
    if (bookmarks.has(pg)) bookmarks.delete(pg); else bookmarks.add(pg);
    saveBookmarks();
    if (mode === "reels") updateReelsUI(); else updateBookUI();
  }

  function renderBookmarks() {
    if (bookmarks.size === 0) {
      bookmarksList.innerHTML = '<p class="empty-msg">No bookmarks yet. Tap 📑 to add one.</p>';
      return;
    }
    bookmarksList.innerHTML = [...bookmarks].sort((a, b) => a - b)
      .map(p => `<div class="bookmark-item" data-page="${p}">
        <span class="page-num">Page ${p}</span>
        <button class="delete-btn" data-del="${p}">✕</button></div>`).join("");
  }

  function loadBookmarks() {
    try { const r = localStorage.getItem("la-bookmarks"); if (r) bookmarks = new Set(JSON.parse(r)); } catch {}
  }
  function saveBookmarks() { localStorage.setItem("la-bookmarks", JSON.stringify([...bookmarks])); }

  // ═══════════════════════════
  // SETTINGS
  // ═══════════════════════════
  function loadSettings() {
    const theme = localStorage.getItem("la-theme") || "dark";
    document.body.className = `theme-${theme}`;
    themeSelect.value = theme;
  }

  function openPanel(p) { p.classList.remove("hidden"); overlay.classList.remove("hidden"); }
  function closePanels() {
    bookmarksPanel.classList.add("hidden");
    settingsPanel.classList.add("hidden");
    overlay.classList.add("hidden");
  }

  // ═══════════════════════════
  // GLOBAL EVENTS
  // ═══════════════════════════
  function setupGlobalEvents() {
    btnMode.addEventListener("click", switchMode);
    btnBookmark.addEventListener("click", toggleBookmark);
    btnSettings.addEventListener("click", () => openPanel(settingsPanel));
    closeSettings.addEventListener("click", closePanels);
    themeSelect.addEventListener("change", () => {
      document.body.className = `theme-${themeSelect.value}`;
      localStorage.setItem("la-theme", themeSelect.value);
    });

    btnToc.addEventListener("click", () => { renderBookmarks(); openPanel(bookmarksPanel); });
    closeBookmarks.addEventListener("click", closePanels);
    bookmarksList.addEventListener("click", (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { bookmarks.delete(parseInt(del.dataset.del, 10)); saveBookmarks(); renderBookmarks(); if (mode === "reels") updateReelsUI(); else updateBookUI(); return; }
      const item = e.target.closest("[data-page]");
      if (item) { closePanels(); if (mode === "book") goToBookPage(parseInt(item.dataset.page, 10)); }
    });

    overlay.addEventListener("click", closePanels);

    pageSlider.addEventListener("input", () => { sliderLabel.textContent = `Page ${pageSlider.value}`; });
    pageSlider.addEventListener("change", () => goToBookPage(parseInt(pageSlider.value, 10)));

    // Zoom buttons
    btnZoomIn.addEventListener("click", () => {
      const w = getActiveZoomWrapper();
      if (w) w._zoomTo((w._getScale?.() || 1) + 0.5);
    });
    btnZoomOut.addEventListener("click", () => {
      const w = getActiveZoomWrapper();
      if (w) w._zoomTo((w._getScale?.() || 1) - 0.5);
    });

    // Nav buttons
    btnPrev.addEventListener("click", () => {
      if (mode === "reels") goPrevReel(); else goToBookPage(bookPage - 1);
    });
    btnNext.addEventListener("click", () => {
      if (mode === "reels") goNextReel(); else goToBookPage(bookPage + 1);
    });

    // Keyboard (desktop)
    document.addEventListener("keydown", (e) => {
      if (mode === "book") {
        if (e.key === "ArrowRight") goToBookPage(bookPage + 1);
        if (e.key === "ArrowLeft") goToBookPage(bookPage - 1);
      }
      if (e.key === "ArrowDown") { if (mode === "reels") goNextReel(); }
      if (e.key === "ArrowUp") { if (mode === "reels") goPrevReel(); }
      if (e.key === "+" || e.key === "=") btnZoomIn.click();
      if (e.key === "-") btnZoomOut.click();
    });
  }

  init();
})();
