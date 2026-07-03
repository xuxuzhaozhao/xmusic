(() => {
  "use strict";

  /* ============ 调色板：为每首曲目生成确定性的玻璃渐变封面 ============ */
  const PALETTES = [
    ["#0A84FF", "#BF5AF2"],
    ["#FF375F", "#FF9F0A"],
    ["#30D158", "#0A84FF"],
    ["#BF5AF2", "#FF375F"],
    ["#FF9F0A", "#FFD60A"],
    ["#64D2FF", "#BF5AF2"],
    ["#FF453A", "#FF9F0A"],
    ["#5E5CE6", "#FF375F"],
  ];

  function hashStr(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = (h << 5) - h + str.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h);
  }

  function paletteFor(track) {
    const idx = hashStr(track.title + track.artist) % PALETTES.length;
    return PALETTES[idx];
  }

  function gradientCSS(track, angle = 135) {
    const [a, b] = paletteFor(track);
    return `linear-gradient(${angle}deg, ${a}, ${b})`;
  }

  const NOTE_SVG =
    '<svg viewBox="0 0 24 24" style="width:38%;height:38%;opacity:.9"><path d="M9 3v10.55A4 4 0 108 17.5V7l9-1.8V13a4 4 0 101.5 3.1V0z" fill="white"/></svg>';

  /* ============ IndexedDB ============ */
  const DB_NAME = "glassMusicDB";
  const DB_VERSION = 1;
  let dbPromise = null;

  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("tracks")) {
          const store = db.createObjectStore("tracks", {
            keyPath: "id",
            autoIncrement: true,
          });
          store.createIndex("addedAt", "addedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function dbAdd(record) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", "readwrite");
      const req = tx.objectStore("tracks").add(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbGetAll() {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", "readonly");
      const req = tx.objectStore("tracks").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function dbDelete(id) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction("tracks", "readwrite");
      const req = tx.objectStore("tracks").delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  /* ============ 应用状态 ============ */
  const state = {
    library: [],       // 全部曲目 {id,title,artist,blob,duration,addedAt}
    queue: [],         // 当前播放队列（曲目 id 数组）
    queueIndex: -1,
    shuffle: false,
    repeat: 0,          // 0 off, 1 all, 2 one
    playing: false,
    recentIds: JSON.parse(localStorage.getItem("gm_recent") || "[]"),
    volume: Number(localStorage.getItem("gm_volume") ?? 80),
  };

  const audio = new Audio();
  audio.preload = "metadata";
  let currentObjectURL = null;

  /* ============ DOM 引用 ============ */
  const $ = (id) => document.getElementById(id);
  const els = {
    views: $("views"),
    viewTitle: $("viewTitle"),
    tabbar: $("tabbar"),
    searchToggleBtn: $("searchToggleBtn"),

    recentRow: $("recentRow"),
    recentEmpty: $("recentEmpty"),
    shuffleGrid: $("shuffleGrid"),

    trackCount: $("trackCount"),
    libraryList: $("libraryList"),
    libraryEmpty: $("libraryEmpty"),
    importBtn: $("importBtn"),
    importBtnBig: $("importBtnBig"),
    playAllBtn: $("playAllBtn"),
    fileInput: $("fileInput"),

    searchInput: $("searchInput"),
    searchResults: $("searchResults"),
    searchEmpty: $("searchEmpty"),

    miniPlayer: $("miniPlayer"),
    miniArt: $("miniArt"),
    miniTitle: $("miniTitle"),
    miniArtist: $("miniArtist"),
    miniPlayBtn: $("miniPlayBtn"),
    miniPlayIcon: $("miniPlayIcon"),
    miniNextBtn: $("miniNextBtn"),
    miniProgressFill: $("miniProgressFill"),

    playerSheet: $("playerSheet"),
    collapseBtn: $("collapseBtn"),
    queueBtn: $("queueBtn"),
    playerArt: $("playerArt"),
    playerTitle: $("playerTitle"),
    playerArtist: $("playerArtist"),
    seekSlider: $("seekSlider"),
    timeCurrent: $("timeCurrent"),
    timeDuration: $("timeDuration"),
    shuffleBtn: $("shuffleBtn"),
    prevBtn: $("prevBtn"),
    playBtn: $("playBtn"),
    playIcon: $("playIcon"),
    nextBtn: $("nextBtn"),
    repeatBtn: $("repeatBtn"),
    volumeSlider: $("volumeSlider"),

    queueSheet: $("queueSheet"),
    queueList: $("queueList"),
    closeQueueBtn: $("closeQueueBtn"),

    toast: $("toast"),
  };

  /* ============ 工具函数 ============ */
  function fmtTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60)
      .toString()
      .padStart(2, "0");
    return `${m}:${s}`;
  }

  function parseFilename(name) {
    const base = name.replace(/\.[^.]+$/, "");
    const parts = base.split(" - ");
    if (parts.length >= 2) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(" - ").trim() };
    }
    return { artist: "未知艺人", title: base.trim() };
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 1800);
  }

  function trackById(id) {
    return state.library.find((t) => t.id === id);
  }

  /* ============ 渲染：封面元素 ============ */
  function paintArt(el, track, showNote = true) {
    el.style.background = gradientCSS(track);
    el.innerHTML = showNote ? NOTE_SVG : "";
    if (showNote) {
      el.style.display = "flex";
      el.style.alignItems = "center";
      el.style.justifyContent = "center";
    }
  }

  /* ============ 渲染：资料库列表 ============ */
  function trackRow(track, { showRemove = true } = {}) {
    const li = document.createElement("li");
    li.className = "track-row";
    li.dataset.id = track.id;
    if (state.queue[state.queueIndex] === track.id) li.classList.add("playing");

    const thumb = document.createElement("div");
    thumb.className = "track-thumb";
    paintArt(thumb, track);

    const info = document.createElement("div");
    info.className = "track-info";
    const title = document.createElement("div");
    title.className = "track-title";
    title.textContent = track.title;
    const artist = document.createElement("div");
    artist.className = "track-artist";
    artist.textContent = track.artist + (track.duration ? " · " + fmtTime(track.duration) : "");
    info.append(title, artist);

    li.append(thumb, info);

    if (showRemove) {
      const more = document.createElement("button");
      more.className = "track-more";
      more.innerHTML =
        '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>';
      more.setAttribute("aria-label", "更多");
      more.addEventListener("click", (e) => {
        e.stopPropagation();
        if (confirm(`从资料库删除《${track.title}》？`)) {
          removeTrack(track.id);
        }
      });
      li.append(more);
    }

    li.addEventListener("click", () => {
      const list = li.closest("#queueList")
        ? state.queue
        : state.library.map((t) => t.id);
      const idx = list.indexOf(track.id);
      playQueue(list, idx === -1 ? 0 : idx);
    });

    return li;
  }

  function renderLibrary() {
    els.trackCount.textContent = `${state.library.length} 首歌曲`;
    els.libraryList.innerHTML = "";
    const empty = state.library.length === 0;
    els.libraryEmpty.classList.toggle("show", empty);
    els.libraryList.style.display = empty ? "none" : "flex";

    state.library
      .slice()
      .sort((a, b) => b.addedAt - a.addedAt)
      .forEach((t) => els.libraryList.appendChild(trackRow(t)));

    renderNowView();
  }

  function renderNowView() {
    // 最近播放
    els.recentRow.innerHTML = "";
    const recents = state.recentIds
      .map((id) => trackById(id))
      .filter(Boolean)
      .slice(0, 10);
    els.recentEmpty.style.display = recents.length ? "none" : "block";
    recents.forEach((t) => {
      const card = document.createElement("div");
      card.className = "recent-card";
      const art = document.createElement("div");
      art.className = "recent-art";
      paintArt(art, t);
      const title = document.createElement("div");
      title.className = "recent-title";
      title.textContent = t.title;
      const artist = document.createElement("div");
      artist.className = "recent-artist";
      artist.textContent = t.artist;
      card.append(art, title, artist);
      card.addEventListener("click", () => {
        const ids = state.library.map((x) => x.id);
        playQueue(ids, ids.indexOf(t.id));
      });
      els.recentRow.appendChild(card);
    });

    // 随机重温
    els.shuffleGrid.innerHTML = "";
    const shuffled = state.library.slice().sort(() => Math.random() - 0.5).slice(0, 6);
    shuffled.forEach((t) => {
      const card = document.createElement("div");
      card.className = "grid-card";
      card.style.background = gradientCSS(t, 120);
      const span = document.createElement("span");
      span.textContent = t.title;
      card.appendChild(span);
      card.addEventListener("click", () => {
        const ids = state.library.map((x) => x.id);
        playQueue(ids, ids.indexOf(t.id));
      });
      els.shuffleGrid.appendChild(card);
    });
  }

  function renderQueue() {
    els.queueList.innerHTML = "";
    state.queue.forEach((id) => {
      const t = trackById(id);
      if (!t) return;
      els.queueList.appendChild(trackRow(t, { showRemove: false }));
    });
  }

  function renderSearch(query) {
    const q = query.trim().toLowerCase();
    els.searchResults.innerHTML = "";
    if (!q) {
      els.searchEmpty.style.display = "block";
      els.searchEmpty.textContent = "输入以搜索资料库";
      return;
    }
    const matches = state.library.filter(
      (t) => t.title.toLowerCase().includes(q) || t.artist.toLowerCase().includes(q)
    );
    els.searchEmpty.style.display = matches.length ? "none" : "block";
    els.searchEmpty.textContent = "没有找到相关结果";
    matches.forEach((t) => els.searchResults.appendChild(trackRow(t)));
  }

  /* ============ 曲目库操作 ============ */
  async function importFiles(fileList) {
    const files = Array.from(fileList).filter((f) => f.type.startsWith("audio/"));
    if (!files.length) {
      toast("请选择音频文件");
      return;
    }
    toast(`正在导入 ${files.length} 首曲目…`);
    for (const file of files) {
      const { artist, title } = parseFilename(file.name);
      const duration = await probeDuration(file).catch(() => 0);
      await dbAdd({
        title,
        artist,
        blob: file,
        duration,
        addedAt: Date.now(),
      });
    }
    await loadLibrary();
    toast("导入完成");
  }

  function probeDuration(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const a = new Audio();
      a.preload = "metadata";
      a.src = url;
      a.onloadedmetadata = () => {
        resolve(a.duration || 0);
        URL.revokeObjectURL(url);
      };
      a.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("metadata failed"));
      };
    });
  }

  async function removeTrack(id) {
    await dbDelete(id);
    state.queue = state.queue.filter((qid) => qid !== id);
    if (trackById(id)?.id === state.queue[state.queueIndex]) {
      audio.pause();
    }
    await loadLibrary();
    toast("已删除");
  }

  async function loadLibrary() {
    state.library = await dbGetAll();
    renderLibrary();
    renderQueue();
    if (els.searchInput.value) renderSearch(els.searchInput.value);
  }

  /* ============ 播放核心 ============ */
  function playQueue(ids, index) {
    if (!ids.length) return;
    state.queue = ids.slice();
    state.queueIndex = index;
    loadCurrentTrack(true);
  }

  function loadCurrentTrack(autoplay) {
    const id = state.queue[state.queueIndex];
    const track = trackById(id);
    if (!track) return;

    if (currentObjectURL) URL.revokeObjectURL(currentObjectURL);
    currentObjectURL = URL.createObjectURL(track.blob);
    audio.src = currentObjectURL;
    audio.volume = state.volume / 100;
    if (autoplay) audio.play().catch(() => {});

    updateNowPlayingUI(track);
    pushRecent(id);
    renderLibrary();
    renderQueue();
    openPlayerSheet();
    els.miniPlayer.hidden = false;
  }

  function pushRecent(id) {
    state.recentIds = [id, ...state.recentIds.filter((x) => x !== id)].slice(0, 20);
    localStorage.setItem("gm_recent", JSON.stringify(state.recentIds));
  }

  function updateNowPlayingUI(track) {
    els.miniTitle.textContent = track.title;
    els.miniArtist.textContent = track.artist;
    paintArt(els.miniArt, track, false);
    els.miniArt.style.display = "block";

    els.playerTitle.textContent = track.title;
    els.playerArtist.textContent = track.artist;
    paintArt(els.playerArt, track);

    // 播放器背景光斑跟随当前曲目主色调
    const [a, b] = paletteFor(track);
    document.querySelectorAll(".blob-a").forEach((el) => (el.style.background = a));
    document.querySelectorAll(".blob-b").forEach((el) => (el.style.background = b));
  }

  function setPlayingIcon(isPlaying) {
    const playPath = '<path d="M8 5v14l11-7z"/>';
    const pausePath = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
    els.playIcon.innerHTML = isPlaying ? pausePath : playPath;
    els.miniPlayIcon.innerHTML = isPlaying ? pausePath : playPath;
  }

  function togglePlay() {
    if (!audio.src) {
      if (state.library.length) playQueue(state.library.map((t) => t.id), 0);
      return;
    }
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  }

  function playNext(auto = false) {
    if (!state.queue.length) return;
    if (state.repeat === 2 && auto) {
      audio.currentTime = 0;
      audio.play();
      return;
    }
    let next;
    if (state.shuffle) {
      next = Math.floor(Math.random() * state.queue.length);
    } else {
      next = state.queueIndex + 1;
      if (next >= state.queue.length) {
        if (state.repeat === 1) next = 0;
        else {
          if (auto) { setPlayingIcon(false); return; }
          next = 0;
        }
      }
    }
    state.queueIndex = next;
    loadCurrentTrack(true);
  }

  function playPrev() {
    if (!state.queue.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      return;
    }
    let prev = state.queueIndex - 1;
    if (prev < 0) prev = state.repeat === 1 ? state.queue.length - 1 : 0;
    state.queueIndex = prev;
    loadCurrentTrack(true);
  }

  /* ============ 音频事件 ============ */
  audio.addEventListener("play", () => {
    state.playing = true;
    setPlayingIcon(true);
  });
  audio.addEventListener("pause", () => {
    state.playing = false;
    setPlayingIcon(false);
  });
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    const pct = (audio.currentTime / audio.duration) * 100;
    els.miniProgressFill.style.width = pct + "%";
    if (!els.seekSlider.dragging) {
      els.seekSlider.value = Math.round((audio.currentTime / audio.duration) * 1000);
    }
    els.timeCurrent.textContent = fmtTime(audio.currentTime);
    els.timeDuration.textContent = fmtTime(audio.duration);
  });
  audio.addEventListener("ended", () => playNext(true));

  /* ============ 控件事件绑定 ============ */
  els.playBtn.addEventListener("click", togglePlay);
  els.miniPlayBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    togglePlay();
  });
  els.nextBtn.addEventListener("click", () => playNext(false));
  els.miniNextBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    playNext(false);
  });
  els.prevBtn.addEventListener("click", playPrev);

  els.shuffleBtn.addEventListener("click", () => {
    state.shuffle = !state.shuffle;
    els.shuffleBtn.classList.toggle("active", state.shuffle);
    toast(state.shuffle ? "随机播放已开启" : "随机播放已关闭");
  });

  els.repeatBtn.addEventListener("click", () => {
    state.repeat = (state.repeat + 1) % 3;
    els.repeatBtn.classList.toggle("active", state.repeat !== 0);
    const labels = ["重复播放已关闭", "列表循环已开启", "单曲循环已开启"];
    toast(labels[state.repeat]);
  });

  els.seekSlider.addEventListener("input", () => {
    els.seekSlider.dragging = true;
    if (audio.duration) {
      const t = (els.seekSlider.value / 1000) * audio.duration;
      els.timeCurrent.textContent = fmtTime(t);
    }
  });
  els.seekSlider.addEventListener("change", () => {
    if (audio.duration) {
      audio.currentTime = (els.seekSlider.value / 1000) * audio.duration;
    }
    els.seekSlider.dragging = false;
  });

  els.volumeSlider.value = state.volume;
  els.volumeSlider.addEventListener("input", () => {
    state.volume = Number(els.volumeSlider.value);
    audio.volume = state.volume / 100;
    localStorage.setItem("gm_volume", state.volume);
  });

  /* ============ 面板开合 ============ */
  function openPlayerSheet() {
    els.playerSheet.classList.add("open");
    els.playerSheet.setAttribute("aria-hidden", "false");
  }
  function closePlayerSheet() {
    els.playerSheet.classList.remove("open");
    els.playerSheet.setAttribute("aria-hidden", "true");
  }
  els.miniPlayer.addEventListener("click", () => {
    if (audio.src) openPlayerSheet();
  });
  els.collapseBtn.addEventListener("click", closePlayerSheet);

  els.queueBtn.addEventListener("click", () => {
    renderQueue();
    els.queueSheet.classList.add("open");
  });
  els.closeQueueBtn.addEventListener("click", () =>
    els.queueSheet.classList.remove("open")
  );

  // 简单的下滑关闭手势（抓手 + 玻璃面板）
  function enableSwipeToClose(sheetEl, panelEl, closeFn) {
    let startY = 0,
      dy = 0,
      dragging = false;
    const onStart = (y) => {
      dragging = true;
      startY = y;
      panelEl.style.transition = "none";
    };
    const onMove = (y) => {
      if (!dragging) return;
      dy = Math.max(0, y - startY);
      panelEl.style.transform = `translateY(${dy}px)`;
    };
    const onEnd = () => {
      if (!dragging) return;
      dragging = false;
      panelEl.style.transition = "";
      if (dy > 120) closeFn();
      panelEl.style.transform = "";
      dy = 0;
    };
    panelEl.addEventListener("touchstart", (e) => onStart(e.touches[0].clientY), { passive: true });
    panelEl.addEventListener("touchmove", (e) => onMove(e.touches[0].clientY), { passive: true });
    panelEl.addEventListener("touchend", onEnd);
    panelEl.addEventListener("mousedown", (e) => onStart(e.clientY));
    window.addEventListener("mousemove", (e) => onMove(e.clientY));
    window.addEventListener("mouseup", onEnd);
  }
  enableSwipeToClose(els.playerSheet, els.playerSheet.querySelector(".player-glass"), closePlayerSheet);
  enableSwipeToClose(els.queueSheet, els.queueSheet.querySelector(".queue-glass"), () =>
    els.queueSheet.classList.remove("open")
  );

  /* ============ 标签栏 / 视图切换 ============ */
  const viewTitles = { "view-now": "听现在", "view-library": "资料库", "view-search": "搜索" };
  function switchView(id) {
    document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === id));
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === id));
    els.viewTitle.textContent = viewTitles[id];
    els.views.scrollTop = 0;
  }
  els.tabbar.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
  els.searchToggleBtn.addEventListener("click", () => {
    switchView("view-search");
    setTimeout(() => els.searchInput.focus(), 200);
  });

  /* ============ 搜索 ============ */
  els.searchInput.addEventListener("input", () => renderSearch(els.searchInput.value));

  /* ============ 导入 / 播放全部 ============ */
  [els.importBtn, els.importBtnBig].forEach((btn) =>
    btn.addEventListener("click", () => els.fileInput.click())
  );
  els.fileInput.addEventListener("change", (e) => {
    importFiles(e.target.files);
    e.target.value = "";
  });
  els.playAllBtn.addEventListener("click", () => {
    if (!state.library.length) {
      toast("资料库还没有歌曲");
      return;
    }
    const ids = state.library.slice().sort((a, b) => b.addedAt - a.addedAt).map((t) => t.id);
    playQueue(ids, 0);
  });

  // 拖放导入
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer.files.length) importFiles(e.dataTransfer.files);
  });

  /* ============ PWA：Service Worker 注册 & 安装提示 ============ */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }

  

  /* ============ 媒体会话（锁屏/控制中心）============ */
  if ("mediaSession" in navigator) {
    navigator.mediaSession.setActionHandler("play", () => audio.play());
    navigator.mediaSession.setActionHandler("pause", () => audio.pause());
    navigator.mediaSession.setActionHandler("previoustrack", playPrev);
    navigator.mediaSession.setActionHandler("nexttrack", () => playNext(false));
  }
  function updateMediaSession(track) {
    if (!("mediaSession" in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: "欣和 · Glass Music",
    });
  }
  audio.addEventListener("loadedmetadata", () => {
    const t = trackById(state.queue[state.queueIndex]);
    if (t) updateMediaSession(t);
  });

  /* ============ 初始化 ============ */
  loadLibrary();
})();
