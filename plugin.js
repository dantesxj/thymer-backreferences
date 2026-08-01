// @generated BEGIN thymer-plugin-settings (source: plugins/public repo/plugin-settings/ThymerPluginSettingsRuntime.js — run: npm run embed-plugin-settings)
/**
 * ThymerPluginSettings — workspace **Plugin Backend** collection + optional localStorage mirror
 * for global plugins that do not own a collection. (Legacy name **Plugin Settings** is still found until renamed.)
 *
 * Edit this file, then from repo root: npm run embed-plugin-settings
 *
 * Debug: console filter `[ThymerExt/PluginBackend]`. Off by default; to enable:
 *   localStorage.setItem('thymerext_debug_collections', '1'); location.reload();
 *
 * Create dedupe: Web Locks + **per-workspace** localStorage lease/recent-create keys (workspaceGuid from
 * `data.getActiveUsers()[0]`), plus abort if an exact-named Plugin Backend collection already exists.
 *
 * Rows:
 * - **Vault** (`record_kind` = `vault`): one per `plugin_id` — holds synced localStorage payload JSON.
 * - **Other rows** (`record_kind` = `log`, `config`, …): same **Plugin** field (`plugin`) for filtering;
 *   use a **distinct** `plugin_id` per row (e.g. `habit-tracker:log:2026-04-24`) so vault lookup stays unambiguous.
 *
 * API: ThymerPluginSettings.init({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.scheduleFlush(plugin, mirrorKeys)
 *      ThymerPluginSettings.flushNow(data, pluginId, mirrorKeys)
 *      ThymerPluginSettings.openStorageDialog({ plugin, pluginId, modeKey, mirrorKeys, label, data, ui })
 *      ThymerPluginSettings.listRows(data, { pluginSlug, recordKind? })
 *      ThymerPluginSettings.createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle?, settingsDoc? })
 *      ThymerPluginSettings.upgradeCollectionSchema(data) — merge missing `plugin` / `record_kind` fields into existing collection
 *      ThymerPluginSettings.registerPluginSlug(data, { slug, label? }) — ensure `plugin` choice includes this slug (call once per plugin)
 */
(function pluginSettingsRuntime(g) {
  if (g.ThymerPluginSettings) return;

  const COL_NAME = 'Plugin Backend';
  const COL_NAME_LEGACY = 'Plugin Settings';
  const KIND_VAULT = 'vault';
  const FIELD_PLUGIN = 'plugin';
  const FIELD_KIND = 'record_kind';
  const q = [];
  let busy = false;

  /**
   * Collection ensure diagnostics (read browser console for `[ThymerExt/PluginBackend]`.
   * Opt-in: `localStorage.setItem('thymerext_debug_collections','1')` then reload.
   * Opt-out: remove the key or set to `0` / `off` / `false`.
   */
  const DEBUG_COLLECTIONS = (() => {
    try {
      const o = localStorage.getItem('thymerext_debug_collections');
      if (o === '0' || o === 'off' || o === 'false') return false;
      return o === '1' || o === 'true' || o === 'on';
    } catch (_) {}
    return false;
  })();
  const DEBUG_PATHB_ID =
    'pb-' + (Date.now() & 0xffffffff).toString(16) + '-' + Math.random().toString(36).slice(2, 7);

  /** In-flight dedupe: parallel plugin `init()` calls share one `getAllCollections()` snapshot. */
  const DATA_GET_ALL_P = '__thymerExtGetAllCollectionsInflight';

  function preferDeferredHeavyWork() {
    try {
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
    } catch (_) {}
    try {
      return Number(navigator?.maxTouchPoints) > 0;
    } catch (_) {}
    return false;
  }

  const MOBILE_GRACE_UNTIL_KEY = '__thymerExtMobileGraceUntil';
  const MOBILE_HIDDEN_AT_KEY = '__thymerExtMobileHiddenAt';
  const MOBILE_INTERACT_THROTTLE_AT_KEY = '__thymerExtMobileInteractThrottleAt';
  /** Mobile: brief bootstrap — end early on first user interaction (see endMobileLoadGrace). */
  const MOBILE_GRACE_MS = 6000;
  const MOBILE_RESUME_GRACE_MS = 6000;
  const MOBILE_RESUME_AWAY_MS = 15000;
  /** Interaction only pauses the heavy-work queue briefly — do not extend MOBILE_GRACE. */
  const MOBILE_HEAVY_PAUSE_ON_INTERACT_MS = 5000;
  /** Desktop: brief heavy-work pause after first click during startup storm. */
  const DESKTOP_HEAVY_PAUSE_ON_INTERACT_MS = 6000;
  const MOBILE_INTERACTION_THROTTLE_MS = 2500;
  const HEAVY_QUEUE_PAUSED_UNTIL_KEY = '__thymerExtHeavyQueuePausedUntil';

  /** Cross-platform: defer vault scans / footer data populate while Thymer syncs; shells may still mount. */
  const STARTUP_STORM_UNTIL_KEY = '__thymerExtStartupStormUntil';
  const STARTUP_STORM_MOBILE_MS = 14000;
  const STARTUP_STORM_DESKTOP_MS = 14000;

  // Heavy work scheduler: many plugins "wake up" together after mobile grace ends.
  // Running them concurrently causes long-task storms that block navigation.
  const HEAVY_Q_KEY = '__thymerExtHeavyWorkQueue';
  const HEAVY_BUSY_KEY = '__thymerExtHeavyWorkBusy';

  function ensureStartupStormWindow(extraMs) {
    const ms =
      extraMs > 0
        ? extraMs
        : preferDeferredHeavyWork()
          ? STARTUP_STORM_MOBILE_MS
          : STARTUP_STORM_DESKTOP_MS;
    const until = Date.now() + ms;
    try {
      if (!g[STARTUP_STORM_UNTIL_KEY] || g[STARTUP_STORM_UNTIL_KEY] < until) {
        g[STARTUP_STORM_UNTIL_KEY] = until;
      }
    } catch (_) {}
    installStartupStormInteractionListener();
  }

  function inStartupStormWindow() {
    try {
      return Date.now() < (g[STARTUP_STORM_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  function endStartupStormWindow() {
    try {
      g[STARTUP_STORM_UNTIL_KEY] = 0;
    } catch (_) {}
  }

  function scheduleAfterStartupStorm(run, opts) {
    if (typeof run !== 'function') return;
    if (!inStartupStormWindow()) {
      try {
        run();
      } catch (_) {}
      return;
    }
    const pollMs = Math.max(120, Number(opts?.pollMs) || 400);
    const maxWaitMs = Math.max(pollMs, Number(opts?.maxWaitMs) || 120000);
    const started = Date.now();
    const tick = () => {
      if (!inStartupStormWindow() || Date.now() - started >= maxWaitMs) {
        try {
          run();
        } catch (_) {}
        return;
      }
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  }

  function endMobileLoadGrace() {
    try {
      g[MOBILE_GRACE_UNTIL_KEY] = 0;
    } catch (_) {}
  }

  function installStartupStormInteractionListener() {
    g.__thymerExtStormOnInteract = () => {
      try {
        endStartupStormWindow();
        endMobileLoadGrace();
        pauseHeavyWorkQueue(
          preferDeferredHeavyWork() ? MOBILE_HEAVY_PAUSE_ON_INTERACT_MS : DESKTOP_HEAVY_PAUSE_ON_INTERACT_MS
        );
      } catch (_) {}
    };
    if (g.__thymerExtStormInteractInstalled) return;
    g.__thymerExtStormInteractInstalled = true;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    const onInteract = () => {
      try {
        g.__thymerExtStormOnInteract?.();
      } catch (_) {}
    };
    for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
      try {
        document.addEventListener(ev, onInteract, { passive: true, capture: true });
      } catch (_) {}
    }
  }

  function ensureMobileLoadGraceStarted(extraMs) {
    if (!preferDeferredHeavyWork()) return;
    ensureStartupStormWindow();
    const until = Date.now() + (extraMs > 0 ? extraMs : MOBILE_GRACE_MS);
    try {
      if (!g[MOBILE_GRACE_UNTIL_KEY] || g[MOBILE_GRACE_UNTIL_KEY] < until) {
        g[MOBILE_GRACE_UNTIL_KEY] = until;
      }
    } catch (_) {}
    installStartupStormInteractionListener();
    installMobileInteractionGraceListener();
  }

  function inMobileLoadGrace() {
    if (!preferDeferredHeavyWork()) return false;
    try {
      return Date.now() < (g[MOBILE_GRACE_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  function bumpMobileLoadGrace(ms) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (ms > 0 ? ms : MOBILE_RESUME_GRACE_MS);
    try {
      if (!g[MOBILE_GRACE_UNTIL_KEY] || g[MOBILE_GRACE_UNTIL_KEY] < until) {
        g[MOBILE_GRACE_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function installMobileResumeGraceListener() {
    if (g.__thymerExtMobileGraceListenerInstalled) return;
    g.__thymerExtMobileGraceListenerInstalled = true;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    document.addEventListener(
      'visibilitychange',
      () => {
        try {
          if (document.visibilityState === 'hidden') {
            g[MOBILE_HIDDEN_AT_KEY] = Date.now();
          } else if (document.visibilityState === 'visible') {
            const hiddenAt = g[MOBILE_HIDDEN_AT_KEY] || 0;
            const away = hiddenAt ? Date.now() - hiddenAt : 0;
            if (away >= MOBILE_RESUME_AWAY_MS) bumpMobileLoadGrace(MOBILE_RESUME_GRACE_MS);
          }
        } catch (_) {}
      },
      { passive: true }
    );
  }

  function pauseHeavyWorkQueue(ms) {
    if (!preferDeferredHeavyWork()) return;
    const until = Date.now() + (ms > 0 ? ms : MOBILE_HEAVY_PAUSE_ON_INTERACT_MS);
    try {
      if (!g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] || g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] < until) {
        g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] = until;
      }
    } catch (_) {}
  }

  function isHeavyWorkQueuePaused() {
    try {
      return Date.now() < (g[HEAVY_QUEUE_PAUSED_UNTIL_KEY] || 0);
    } catch (_) {
      return false;
    }
  }

  /**
   * True during the brief startup window — use only to skip *background* sync scans,
   * not user-initiated panel.navigated mounts (those should still schedule with debounce).
   */
  function shouldDeferPanelFooterWork() {
    return inMobileLoadGrace();
  }

  /** Run `fn` now, or poll until mobile load grace ends (for one-shot startup scans that must not be dropped). */
  function scheduleAfterMobileLoadGrace(run, opts) {
    if (typeof run !== 'function') return;
    if (!preferDeferredHeavyWork() || !inMobileLoadGrace()) {
      try {
        run();
      } catch (_) {}
      return;
    }
    const pollMs = Math.max(120, Number(opts?.pollMs) || 350);
    const maxWaitMs = Math.max(pollMs, Number(opts?.maxWaitMs) || 90000);
    const started = Date.now();
    const tick = () => {
      if (!inMobileLoadGrace() || Date.now() - started >= maxWaitMs) {
        try {
          run();
        } catch (_) {}
        return;
      }
      setTimeout(tick, pollMs);
    };
    setTimeout(tick, pollMs);
  }

  function installMobileInteractionGraceListener() {
    if (g.__thymerExtMobileInteractGraceInstalled) return;
    g.__thymerExtMobileInteractGraceInstalled = true;
    if (!preferDeferredHeavyWork()) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;

    const onInteract = () => {
      try {
        const now = Date.now();
        const prev = g[MOBILE_INTERACT_THROTTLE_AT_KEY] || 0;
        if (now - prev < MOBILE_INTERACTION_THROTTLE_MS) return;
        g[MOBILE_INTERACT_THROTTLE_AT_KEY] = now;
        endStartupStormWindow();
        endMobileLoadGrace();
        pauseHeavyWorkQueue(MOBILE_HEAVY_PAUSE_ON_INTERACT_MS);
      } catch (_) {}
    };

    for (const ev of ['pointerdown', 'touchstart', 'keydown']) {
      try {
        document.addEventListener(ev, onInteract, { passive: true, capture: true });
      } catch (_) {}
    }
  }

  async function yieldToHostOneTick() {
    await new Promise((r) => {
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } catch (_) {
        setTimeout(r, 0);
      }
    });
  }

  async function runNextHeavyWork() {
    if (g[HEAVY_BUSY_KEY]) return;
    const q = g[HEAVY_Q_KEY];
    if (!Array.isArray(q) || q.length === 0) return;
    g[HEAVY_BUSY_KEY] = true;
    try {
      while (Array.isArray(g[HEAVY_Q_KEY]) && g[HEAVY_Q_KEY].length) {
        if (inMobileLoadGrace() || isHeavyWorkQueuePaused()) break;
        const job = g[HEAVY_Q_KEY].shift();
        if (!job || typeof job.run !== 'function') continue;
        try {
          await yieldToHostOneTick();
        } catch (_) {}
        // Prefer running during idle; fallback is still serialized.
        try {
          if (typeof requestIdleCallback === 'function') {
            await new Promise((resolve) => requestIdleCallback(resolve, { timeout: 1200 }));
          }
        } catch (_) {}
        try {
          await job.run();
        } catch (_) {}
        // Yield after each heavy job so navigation events can be processed.
        try {
          await yieldToHostOneTick();
        } catch (_) {}
      }
    } finally {
      g[HEAVY_BUSY_KEY] = false;
      // If we stopped due to grace, try again later.
      if (Array.isArray(g[HEAVY_Q_KEY]) && g[HEAVY_Q_KEY].length) {
        setTimeout(() => runNextHeavyWork(), inMobileLoadGrace() ? 450 : 200);
      }
    }
  }

  function enqueueHeavyWork(run, opts) {
    if (typeof run !== 'function') return;
    if (!g[HEAVY_Q_KEY]) g[HEAVY_Q_KEY] = [];
    const delayMs = Math.max(0, Number(opts?.delayMs) || 0);
    const push = () => {
      try {
        g[HEAVY_Q_KEY].push({ run });
      } catch (_) {}
      setTimeout(() => runNextHeavyWork(), 0);
    };
    if (delayMs > 0) setTimeout(push, delayMs);
    else push();
  }

  async function yieldToHostBeforePathB() {
    await new Promise((r) => {
      try {
        requestAnimationFrame(() => requestAnimationFrame(() => r()));
      } catch (_) {
        r();
      }
    });
    await new Promise((resolve) => {
      try {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => resolve(), {
            timeout: preferDeferredHeavyWork() ? 8000 : 1500,
          });
        } else {
          setTimeout(resolve, preferDeferredHeavyWork() ? 48 : 16);
        }
      } catch (_) {
        setTimeout(resolve, 32);
      }
    });
  }

  async function getAllCollectionsDeduped(data) {
    if (!data || typeof data.getAllCollections !== 'function') return [];
    const inflight = data[DATA_GET_ALL_P];
    if (inflight && typeof inflight.then === 'function') {
      try {
        return await inflight;
      } catch (_) {
        // fall through to fresh fetch
      }
    }
    const p = Promise.resolve()
      .then(() => data.getAllCollections())
      .then((all) => (Array.isArray(all) ? all : []))
      .finally(() => {
        try {
          if (data[DATA_GET_ALL_P] === p) delete data[DATA_GET_ALL_P];
        } catch (_) {}
      });
    data[DATA_GET_ALL_P] = p;
    return p;
  }

  /** If true, Thymer ignores programmatic field updates — force off on every schema save. */
  const MANAGED_UNLOCK = { fields: false, views: false, sidebar: false };

  /**
   * Ensure Plugin Backend collection without duplicate `createCollection` calls.
   * Sibling **plugin iframes** are often not `window` siblings — walking `parent` can stop at
   * each plugin’s *own* frame, so a promise on “hierarchy best” is **not** one shared object.
   * **`window.top` is the same** for all same-tab iframes and, when not cross-origin, is the
   * one place to attach a cross-iframe lock. Fallback: walk the parent chain for opaque frames.
   */
  function getSharedDeduplicationWindow() {
    try {
      if (typeof window === 'undefined') return g;
      const t = window.top;
      if (t) {
        void t.document;
        return t;
      }
    } catch (_) {
      /* cross-origin top */
    }
    try {
      let w = typeof window !== 'undefined' ? window : null;
      let best = w || g;
      while (w) {
        try {
          void w.document;
          best = w;
        } catch (_) {
          break;
        }
        if (w === w.top) break;
        w = w.parent;
      }
      return best;
    } catch (_) {
      return typeof window !== 'undefined' ? window : g;
    }
  }

  const PB_ENSURE_GLOBAL_P = '__thymerPluginBackendEnsureGlobalP';
  const SERIAL_DATA_CREATE_P = '__thymerExtSerializedDataCreateP_v1';
  /** `getAllCollections` can briefly return [] (host UI / race) after a valid non-empty read — refuse create in that window. */
  const GETALL_COLLECTIONS_SANITY = '__thymerExtGetAllCollectionsSanityV1';
  function touchGetAllSanityFromCount(len) {
    const n = Number(len) || 0;
    const h = getSharedDeduplicationWindow();
    if (!h[GETALL_COLLECTIONS_SANITY]) h[GETALL_COLLECTIONS_SANITY] = { nLast: 0, tLast: 0 };
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (n > 0) {
      s.nLast = n;
      s.tLast = Date.now();
    }
  }
  function isSuspiciousEmptyAfterRecentNonEmptyList(currentLen) {
    const c = Number(currentLen) || 0;
    if (c > 0) {
      touchGetAllSanityFromCount(c);
      return false;
    }
    const h = getSharedDeduplicationWindow();
    const s = h[GETALL_COLLECTIONS_SANITY];
    if (!s || s.nLast <= 0 || !s.tLast) return false;
    return Date.now() - s.tLast < 60_000;
  }

  function chainPluginBackendEnsure(data, work) {
    const root = getSharedDeduplicationWindow();
    try {
      if (!root[PB_ENSURE_GLOBAL_P]) root[PB_ENSURE_GLOBAL_P] = Promise.resolve();
    } catch (_) {
      return Promise.resolve().then(work);
    }
    root[PB_ENSURE_GLOBAL_P] = root[PB_ENSURE_GLOBAL_P].catch(() => {}).then(work);
    return root[PB_ENSURE_GLOBAL_P];
  }

  function withUnlockedManaged(base) {
    return { ...(base && typeof base === 'object' ? base : {}), managed: MANAGED_UNLOCK };
  }

  /** Index of the “Plugin” column (`id` **plugin**, or legacy label match). */
  function findPluginColumnFieldIndex(fields) {
    const arr = Array.isArray(fields) ? fields : [];
    let i = arr.findIndex((f) => f && f.id === FIELD_PLUGIN);
    if (i >= 0) return i;
    i = arr.findIndex(
      (f) =>
        f &&
        String(f.label || '')
          .trim()
          .toLowerCase() === 'plugin' &&
        (f.type === 'text' || f.type === 'plaintext' || f.type === 'string')
    );
    return i;
  }

  /** Keep internal column identity when replacing field shape (text → choice). */
  function copyStableFieldKeys(prev, next) {
    if (!prev || !next || typeof prev !== 'object' || typeof next !== 'object') return;
    for (const k of ['guid', 'colguid', 'colGuid', 'field_guid']) {
      if (prev[k] != null && next[k] == null) next[k] = prev[k];
    }
  }

  function getPluginFieldDef(coll) {
    if (!coll || typeof coll.getConfiguration !== 'function') return null;
    try {
      const fields = coll.getConfiguration()?.fields || [];
      const i = findPluginColumnFieldIndex(fields);
      return i >= 0 ? fields[i] : null;
    } catch (_) {
      return null;
    }
  }

  function pluginColumnPropId(coll, requestedId) {
    if (requestedId !== FIELD_PLUGIN || !coll) return requestedId;
    const f = getPluginFieldDef(coll);
    return (f && f.id) || FIELD_PLUGIN;
  }

  function cloneFieldDef(f) {
    if (!f || typeof f !== 'object') return f;
    try {
      return structuredClone(f);
    } catch (_) {
      try {
        return JSON.parse(JSON.stringify(f));
      } catch (__) {
        return { ...f };
      }
    }
  }

  const PLUGIN_SETTINGS_SHAPE = {
    ver: 1,
    name: COL_NAME,
    icon: 'ti-adjustments',
    color: null,
    home: false,
    page_field_ids: [FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at', 'settings_json'],
    item_name: 'Setting, Config, or Log',
    description: 'Workspace storage for plugins: Use the Plugin column to filter by plugin.',
    show_sidebar_items: true,
    show_cmdpal_items: false,
    fields: [
      {
        icon: 'ti-apps',
        id: FIELD_PLUGIN,
        label: 'Plugin',
        type: 'choice',
        read_only: false,
        active: true,
        many: false,
        choices: [
          { id: 'quick-notes', label: 'quick-notes', color: '0', active: true },
          { id: 'habit-tracker', label: 'Habit Tracker', color: '0', active: true },
          { id: 'ynab', label: 'ynab', color: '0', active: true },
        ],
      },
      {
        icon: 'ti-category',
        id: FIELD_KIND,
        label: 'Record kind',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-id',
        id: 'plugin_id',
        label: 'Plugin ID',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-clock-plus',
        id: 'created_at',
        label: 'Created',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-clock-edit',
        id: 'updated_at',
        label: 'Modified',
        many: false,
        read_only: true,
        active: true,
        type: 'datetime',
      },
      {
        icon: 'ti-code',
        id: 'settings_json',
        label: 'Settings JSON',
        type: 'text',
        read_only: false,
        active: true,
        many: false,
      },
      {
        icon: 'ti-abc',
        id: 'title',
        label: 'Title',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
      {
        icon: 'ti-photo',
        id: 'banner',
        label: 'Banner',
        many: false,
        read_only: false,
        active: true,
        type: 'banner',
      },
      {
        icon: 'ti-align-left',
        id: 'icon',
        label: 'Icon',
        many: false,
        read_only: false,
        active: true,
        type: 'text',
      },
    ],
    sidebar_record_sort_dir: 'desc',
    sidebar_record_sort_field_id: 'updated_at',
    managed: { fields: false, views: false, sidebar: false },
    custom: {},
    views: [
      {
        id: 'V0YBPGDDZ0MHRSQ',
        shown: true,
        icon: 'ti-table',
        label: 'All',
        description: '',
        field_ids: ['title', FIELD_PLUGIN, FIELD_KIND, 'plugin_id', 'created_at', 'updated_at'],
        type: 'table',
        read_only: false,
        group_by_field_id: null,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
      {
        id: 'VPGAWVGVKZD57C9',
        shown: true,
        icon: 'ti-layout-kanban',
        label: 'By Plugin...',
        description: '',
        field_ids: ['title', FIELD_KIND, 'created_at', 'updated_at'],
        type: 'board',
        read_only: false,
        group_by_field_id: FIELD_PLUGIN,
        sort_dir: 'desc',
        sort_field_id: 'updated_at',
        opts: {},
      },
    ],
  };

  function cloneShape() {
    try {
      return structuredClone(PLUGIN_SETTINGS_SHAPE);
    } catch (_) {
      return JSON.parse(JSON.stringify(PLUGIN_SETTINGS_SHAPE));
    }
  }

  /** Append default views from the canonical shape when the workspace collection is missing them (by view `id`). */
  function mergeViewsArray(baseViews, desiredViews) {
    const desired = Array.isArray(desiredViews) ? desiredViews.map((v) => cloneFieldDef(v)) : [];
    const cur = Array.isArray(baseViews) ? baseViews.map((v) => cloneFieldDef(v)) : [];
    if (cur.length === 0) {
      return { views: desired, changed: desired.length > 0 };
    }
    const ids = new Set(cur.map((v) => v && v.id).filter(Boolean));
    let changed = false;
    for (const v of desired) {
      if (v && v.id && !ids.has(v.id)) {
        cur.push(cloneFieldDef(v));
        ids.add(v.id);
        changed = true;
      }
    }
    return { views: cur, changed };
  }

  /** Slug before first colon, else whole id (e.g. `habit-tracker:log:2026-04-24` → `habit-tracker`). */
  function inferPluginSlugFromPid(pid) {
    if (!pid) return '';
    const s = String(pid).trim();
    const i = s.indexOf(':');
    if (i <= 0) return s;
    return s.slice(0, i);
  }

  function inferRecordKindFromPid(pid, slug) {
    if (!pid || !slug) return '';
    const p = String(pid);
    if (p === slug) return KIND_VAULT;
    if (p === `${slug}:config`) return 'config';
    if (p.startsWith(`${slug}:log:`)) return 'log';
    return '';
  }

  function colorForSlug(slug) {
    const colors = ['0', '1', '2', '3', '4', '5', '6', '7'];
    let h = 0;
    const s = String(slug || '');
    for (let i = 0; i < s.length; i++) h = (h + s.charCodeAt(i) * (i + 1)) % colors.length;
    return colors[h];
  }

  /** Normalize Thymer choice option (object or legacy string). */
  function normalizeChoiceOption(c) {
    if (c == null) return null;
    if (typeof c === 'string') {
      const s = c.trim();
      if (!s) return null;
      return { id: s, label: s, color: colorForSlug(s), active: true };
    }
    const id = String(c.id ?? c.label ?? '')
      .trim();
    if (!id) return null;
    return {
      id,
      label: String(c.label ?? id).trim() || id,
      color: String(c.color != null ? c.color : colorForSlug(id)),
      active: c.active !== false,
    };
  }

  /**
   * Fresh choice field object (no legacy keys). Thymer often ignores `type` changes when merging
   * onto an existing text field’s full config — same pattern as markdown importer choice fields.
   */
  function cleanPluginChoiceField(prev, desiredPlugin, choicesList) {
    const fieldId = (prev && prev.id) || FIELD_PLUGIN;
    const next = {
      id: fieldId,
      label: (prev && prev.label) || desiredPlugin.label || 'Plugin',
      icon: (prev && prev.icon) || desiredPlugin.icon || 'ti-apps',
      type: 'choice',
      many: false,
      read_only: false,
      active: prev ? prev.active !== false : true,
      choices: Array.isArray(choicesList) ? choicesList : [],
    };
    copyStableFieldKeys(prev, next);
    return next;
  }

  /**
   * Ensure the `plugin` field is a choice field and its options cover every slug
   * already present on rows (migrates legacy `type: 'text'` definitions).
   */
  async function reconcilePluginFieldAsChoice(coll, curFields, desired) {
    const desiredPlugin = desired.fields.find((f) => f && f.id === FIELD_PLUGIN);
    if (!desiredPlugin) return { fields: curFields, changed: false };

    const idx = findPluginColumnFieldIndex(curFields);
    const prev = idx >= 0 ? curFields[idx] : null;

    const choices = [];
    const seen = new Set();
    const pushOpt = (opt) => {
      const n = normalizeChoiceOption(opt);
      if (!n || seen.has(n.id)) return;
      seen.add(n.id);
      choices.push(n);
    };

    if (prev && prev.type === 'choice' && Array.isArray(prev.choices)) {
      for (const c of prev.choices) pushOpt(c);
    }

    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {}

    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    const slugSet = new Set();
    for (const r of records) {
      const a = rowField(r, plugCol);
      if (a) slugSet.add(a.trim());
      const inf = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (inf) slugSet.add(inf);
    }
    for (const slug of [...slugSet].sort()) {
      if (!slug) continue;
      pushOpt({ id: slug, label: slug, color: colorForSlug(slug), active: true });
    }

    const useClean = !prev || prev.type !== 'choice';
    const nextPluginField = useClean
      ? cleanPluginChoiceField(prev, desiredPlugin, choices)
      : (() => {
          const merged = {
            ...desiredPlugin,
            type: 'choice',
            choices,
            icon: (prev && prev.icon) || desiredPlugin.icon,
            label: (prev && prev.label) || desiredPlugin.label,
            id: (prev && prev.id) || desiredPlugin.id || FIELD_PLUGIN,
          };
          copyStableFieldKeys(prev, merged);
          return merged;
        })();

    let changed = false;
    if (idx < 0) {
      curFields.push(nextPluginField);
      changed = true;
    } else if (JSON.stringify(prev) !== JSON.stringify(nextPluginField)) {
      curFields[idx] = nextPluginField;
      changed = true;
    }

    return { fields: curFields, changed };
  }

  async function registerPluginSlug(data, { slug, label } = {}) {
    const id = (slug || '').trim();
    if (!id || !data) return;
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    await upgradePluginSettingsSchema(data, coll);
    let slugRegisterSavedOk = false;
    try {
      const base = coll.getConfiguration() || {};
      const fields = Array.isArray(base.fields) ? [...base.fields] : [];
      const idx = findPluginColumnFieldIndex(fields);
      if (idx < 0) {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prev = fields[idx];
      if (prev.type !== 'choice') {
        await rewritePluginChoiceCells(coll);
        return;
      }
      const prevChoices = Array.isArray(prev.choices) ? prev.choices : [];
      const normalized = prevChoices.map((c) => normalizeChoiceOption(c)).filter(Boolean);
      const byId = new Map(normalized.map((c) => [c.id, c]));
      const existing = byId.get(id);
      if (existing) {
        if (label && String(existing.label) !== String(label)) {
          byId.set(id, { ...existing, label: String(label) });
        } else {
          await rewritePluginChoiceCells(coll);
          return;
        }
      } else {
        byId.set(id, { id, label: label || id, color: colorForSlug(id), active: true });
      }
      const prevOrder = normalized.map((c) => c.id);
      const out = [];
      const used = new Set();
      for (const pid of prevOrder) {
        if (byId.has(pid) && !used.has(pid)) {
          out.push(byId.get(pid));
          used.add(pid);
        }
      }
      for (const [pid, opt] of byId) {
        if (!used.has(pid)) {
          out.push(opt);
          used.add(pid);
        }
      }
      const next = { ...prev, type: 'choice', choices: out };
      if (JSON.stringify(prev) !== JSON.stringify(next)) {
        fields[idx] = next;
        const ok = await coll.saveConfiguration(withUnlockedManaged({ ...base, fields }));
        if (ok === false) console.warn('[ThymerPluginSettings] registerPluginSlug: saveConfiguration returned false');
        else slugRegisterSavedOk = true;
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] registerPluginSlug', e);
    }
    if (slugRegisterSavedOk) await rewritePluginChoiceCells(coll);
  }

  /**
   * Merge missing field definitions into the Plugin Backend collection
   * (e.g. after Thymer auto-created a minimal schema, or older two-field configs).
   */
  async function upgradePluginSettingsSchema(data, collOpt) {
    await ensurePluginSettingsCollection(data);
    const coll = collOpt || (await findColl(data));
    if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') return;
    try {
      let base = coll.getConfiguration() || {};
      try {
        if (typeof coll.getExistingCodeAndConfig === 'function') {
          const pack = coll.getExistingCodeAndConfig();
          if (pack && pack.json && typeof pack.json === 'object') {
            base = { ...base, ...pack.json };
          }
        }
      } catch (_) {}
      const desired = cloneShape();
      const curFields = Array.isArray(base.fields) ? base.fields.map((f) => cloneFieldDef(f)) : [];
      const curIds = new Set(curFields.map((f) => (f && f.id ? f.id : null)).filter(Boolean));
      let changed = false;
      for (const f of desired.fields) {
        if (!f || !f.id || curIds.has(f.id)) continue;
        if (f.id === FIELD_PLUGIN && findPluginColumnFieldIndex(curFields) >= 0) continue;
        curFields.push(cloneFieldDef(f));
        curIds.add(f.id);
        changed = true;
      }
      const rec = await reconcilePluginFieldAsChoice(coll, curFields, desired);
      if (rec.changed) changed = true;
      const finalFields = rec.fields;

      const vMerge = mergeViewsArray(base.views, desired.views);
      if (vMerge.changed) changed = true;
      const finalViews = vMerge.views;

      const curPages = [...(base.page_field_ids || [])];
      const wantPages = [...(desired.page_field_ids || [])];
      const mergedPages = [...new Set([...wantPages, ...curPages])];
      if (JSON.stringify(curPages) !== JSON.stringify(mergedPages)) changed = true;
      if ((base.description || '') !== desired.description) changed = true;
      if ((base.item_name || '') !== (desired.item_name || '')) changed = true;
      if (String(base.name || '').trim() !== COL_NAME) changed = true;
      if (changed) {
        const merged = withUnlockedManaged({
          ...base,
          name: COL_NAME,
          description: desired.description,
          fields: finalFields,
          page_field_ids: mergedPages.length ? mergedPages : wantPages,
          item_name: desired.item_name || base.item_name,
          icon: desired.icon || base.icon,
          color: desired.color !== undefined ? desired.color : base.color,
          home: desired.home !== undefined ? desired.home : base.home,
          views: finalViews,
          sidebar_record_sort_field_id: desired.sidebar_record_sort_field_id || base.sidebar_record_sort_field_id,
          sidebar_record_sort_dir: desired.sidebar_record_sort_dir || base.sidebar_record_sort_dir,
        });
        const ok = await coll.saveConfiguration(merged);
        if (ok === false) console.warn('[ThymerPluginSettings] saveConfiguration returned false (schema not applied?)');
        else {
          try {
            const pf = getPluginFieldDef(coll);
            if (pf && pf.type !== 'choice') {
              console.error(
                '[ThymerPluginSettings] saveConfiguration succeeded but "plugin" field is still type',
                pf.type,
                '— check collection General tab or re-import plugins/public repo/plugin-settings/Plugin Backend.json.'
              );
            }
          } catch (_) {}
        }
      }
      if (changed) await rewritePluginChoiceCells(coll);
    } catch (e) {
      console.error('[ThymerPluginSettings] upgrade schema', e);
    }
  }

  /** Re-apply `plugin` via setChoice so rows are not stuck as “(Other)” after text→choice migration. */
  async function rewritePluginChoiceCells(coll) {
    if (!coll || typeof coll.getAllRecords !== 'function') return;
    try {
      const pluginField = getPluginFieldDef(coll);
      if (!pluginField || pluginField.type !== 'choice') return;
    } catch (_) {
      return;
    }
    let records = [];
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    for (const r of records) {
      let slug = inferPluginSlugFromPid(rowField(r, 'plugin_id'));
      if (!slug) slug = rowField(r, pluginColumnPropId(coll, FIELD_PLUGIN));
      if (!slug) continue;
      setRowField(r, FIELD_PLUGIN, slug, coll);
      // Rows written while setRowField wrongly skipped p.set() for plugin_id (setChoice branch).
      const pidNow = rowField(r, 'plugin_id').trim();
      if (!pidNow) {
        const kind = (rowField(r, FIELD_KIND) || '').trim();
        let legacyVault = false;
        if (!kind) {
          try {
            const raw = rowField(r, 'settings_json');
            if (raw && String(raw).includes('"storageMode"')) legacyVault = true;
          } catch (_) {}
        }
        if (kind === KIND_VAULT || legacyVault) {
          setRowField(r, 'plugin_id', slug, coll);
        } else if (kind === 'config') {
          setRowField(r, 'plugin_id', `${slug}:config`, coll);
        } else if (kind === 'log') {
          let ds = '';
          try {
            const raw = rowField(r, 'settings_json');
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.date) ds = String(j.date).trim();
            }
          } catch (_) {}
          if (!/^\d{4}-\d{2}-\d{2}$/.test(ds) && typeof r.getName === 'function') {
            ds = String(r.getName() || '').trim();
          }
          if (/^\d{4}-\d{2}-\d{2}$/.test(ds)) {
            setRowField(r, 'plugin_id', `${slug}:log:${ds}`, coll);
          }
        }
      }
    }
  }

  function rowField(r, id) {
    if (!r) return '';
    try {
      const p = r.prop?.(id);
      if (p && typeof p.choice === 'function') {
        const c = p.choice();
        if (c != null && String(c).trim() !== '') return String(c).trim();
      }
    } catch (_) {}
    let v = '';
    try {
      v = r.text?.(id);
    } catch (_) {}
    if (v != null && String(v).trim() !== '') return String(v).trim();
    try {
      const p = r.prop?.(id);
      if (p && typeof p.get === 'function') {
        const g = p.get();
        return g == null ? '' : String(g).trim();
      }
      if (p && typeof p.text === 'function') {
        const t = p.text();
        return t == null ? '' : String(t).trim();
      }
    } catch (_) {}
    return '';
  }

  /** Thymer `setChoice` matches option **label** (see YNAB plugins); return label for slug `id`, else slug. */
  function pluginChoiceSetName(coll, slug) {
    const s = String(slug || '').trim();
    if (!s || !coll || typeof coll.getConfiguration !== 'function') return s;
    try {
      const f = getPluginFieldDef(coll);
      if (!f || f.type !== 'choice' || !Array.isArray(f.choices)) return s;
      const opt = f.choices.find((c) => c && String(c.id || '').trim() === s);
      if (opt && opt.label != null && String(opt.label).trim() !== '') return String(opt.label).trim();
    } catch (_) {}
    return s;
  }

  /**
   * @param coll Optional collection — pass when writing `plugin` so setChoice uses the correct option **label**.
   */
  function setRowField(r, id, value, coll = null) {
    if (!r) return;
    const raw = value == null ? '' : String(value);
    const s = raw.trim();
    const propId = pluginColumnPropId(coll, id);
    try {
      const p = r.prop?.(propId);
      if (!p) return;
      // Thymer exposes setChoice on many property types; it returns false for non-choice fields.
      // Only use setChoice for the Plugin **slug** column — otherwise we return early and never p.set().
      const isPluginChoiceCol = id === FIELD_PLUGIN;
      if (isPluginChoiceCol && typeof p.setChoice === 'function') {
        if (!s) {
          if (typeof p.set === 'function') p.set('');
          return;
        }
        const nameTry = coll != null ? pluginChoiceSetName(coll, s) : s;
        if (p.setChoice(nameTry)) return;
        if (nameTry !== s && p.setChoice(s)) return;
        if (typeof p.set === 'function') {
          try {
            p.set(s);
            return;
          } catch (_) {
            /* continue to warn */
          }
        }
        console.warn('[ThymerPluginSettings] setChoice: no option matched field', id, 'slug', s, 'tried', nameTry);
        return;
      }
      if (typeof p.set === 'function') p.set(raw);
    } catch (e) {
      console.warn('[ThymerPluginSettings] setRowField', id, e);
    }
  }

  /** True for the single mirror row per logical plugin (plugin_id === pluginId and kind vault or legacy). */
  function isVaultRow(r, pluginId) {
    const pid = rowField(r, 'plugin_id');
    if (pid !== pluginId) return false;
    const kind = rowField(r, FIELD_KIND);
    if (kind === KIND_VAULT) return true;
    if (!kind) return true;
    return false;
  }

  /** Parse ISO-ish timestamps for vault row scoring (duplicates: pick freshest, not first in list). */
  function parseVaultIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function vaultRowFreshnessScore(r) {
    let score = 0;
    let raw = '';
    try {
      raw = rowField(r, 'settings_json');
    } catch (_) {}
    if (raw && String(raw).trim()) {
      try {
        const j = JSON.parse(raw);
        if (j && typeof j.updatedAt === 'string') {
          const ms = parseVaultIsoMs(j.updatedAt);
          if (ms > score) score = ms;
        }
      } catch (_) {}
    }
    try {
      const ua = rowField(r, 'updated_at');
      if (ua) {
        const ms = parseVaultIsoMs(ua);
        if (ms > score) score = ms;
      }
    } catch (_) {}
    return score;
  }

  function settingsJsonPayloadLen(r) {
    try {
      return String(rowField(r, 'settings_json') || '').length;
    } catch (_) {
      return 0;
    }
  }

  /**
   * Prefer the **newest** vault row when duplicates exist (same `plugin_id`, multiple vault-shaped rows).
   * Previously the first list match could be stale while a newer row held the real payload.
   */
  function findVaultRecord(records, pluginId) {
    if (!records) return null;
    let best = null;
    let bestScore = -1;
    for (const x of records) {
      if (!isVaultRow(x, pluginId)) continue;
      const sc = vaultRowFreshnessScore(x);
      if (sc > bestScore) {
        bestScore = sc;
        best = x;
      } else if (sc === bestScore && best) {
        const lenX = settingsJsonPayloadLen(x);
        const lenB = settingsJsonPayloadLen(best);
        if (lenX > lenB) best = x;
      }
    }
    return best;
  }

  function applyVaultRowMeta(r, pluginId, coll) {
    setRowField(r, 'plugin_id', pluginId);
    setRowField(r, FIELD_PLUGIN, pluginId, coll);
    setRowField(r, FIELD_KIND, KIND_VAULT);
  }

  function drain() {
    if (busy || !q.length) return;
    busy = true;
    const job = q.shift();
    Promise.resolve(typeof job === 'function' ? job() : job)
      .catch((e) => console.error('[ThymerPluginSettings]', e))
      .finally(() => {
        busy = false;
        if (q.length) setTimeout(drain, 450);
      });
  }

  function enqueue(job) {
    q.push(job);
    drain();
  }

  /** Sidebar / command palette title may be `getName()` or only `getConfiguration().name`. */
  function collectionDisplayName(c) {
    if (!c) return '';
    let s = '';
    try {
      s = String(c.getName?.() || '').trim();
    } catch (_) {}
    if (s) return s;
    try {
      s = String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {}
    return s;
  }

  /** Configured collection name only (avoids duplicating `collectionDisplayName` fallbacks). */
  function collectionBackendConfiguredTitle(c) {
    if (!c) return '';
    try {
      return String(c.getConfiguration?.()?.name || '').trim();
    } catch (_) {
      return '';
    }
  }

  /**
   * When plugin iframes are opaque (blob/sandbox), `navigator.locks` and `window.top` globals do not
   * dedupe across realms. First `localStorage` we can reach on the Thymer app origin is shared.
   */
  function getSharedThymerLocalStorage() {
    const seen = new Set();
    const tryWin = (w) => {
      if (!w || seen.has(w)) return null;
      seen.add(w);
      try {
        const ls = w.localStorage;
        void ls.length;
        return ls;
      } catch (_) {
        return null;
      }
    };
    try {
      const t = tryWin(window.top);
      if (t) return t;
    } catch (_) {}
    try {
      const t = tryWin(window);
      if (t) return t;
    } catch (_) {}
    try {
      let w = window;
      for (let i = 0; i < 10 && w; i++) {
        const t = tryWin(w);
        if (t) return t;
        if (w === w.parent) break;
        w = w.parent;
      }
    } catch (_) {}
    return null;
  }

  /** Unscoped keys (legacy); runtime uses {@link scopedPbLsKey} per workspace. */
  const LS_CREATE_LEASE_BASE = 'thymerext_plugin_backend_create_lease_v1';
  const LS_RECENT_CREATE_BASE = 'thymerext_plugin_backend_recent_create_v1';
  const LS_RECENT_CREATE_ATTEMPT_BASE = 'thymerext_plugin_backend_recent_create_attempt_v1';

  function workspaceSlugFromData(data) {
    try {
      const u = data && typeof data.getActiveUsers === 'function' ? data.getActiveUsers() : null;
      const g = u && u[0] && u[0].workspaceGuid;
      const s = g != null ? String(g).trim() : '';
      if (s) return s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 120);
    } catch (_) {}
    return '_unknown_ws';
  }

  function scopedPbLsKey(base, data) {
    return `${base}__${workspaceSlugFromData(data)}`;
  }

  /** Count collections whose sidebar/title name is exactly Plugin Backend (or legacy). */
  async function countExactPluginBackendNamedCollections(data) {
    let all;
    try {
      all = await getAllCollectionsDeduped(data);
    } catch (_) {
      return 0;
    }
    if (!Array.isArray(all)) return 0;
    let n = 0;
    for (const c of all) {
      try {
        const nm = collectionDisplayName(c);
        if (nm === COL_NAME || nm === COL_NAME_LEGACY) n += 1;
      } catch (_) {}
    }
    return n;
  }

  /**
   * Cross-realm mutex for `createCollection` + first `saveConfiguration` only.
   * Lease keys are **per workspace** so switching workspaces does not inherit another vault’s lease / cooldown.
   * @returns {{ denied: boolean, release: () => void }}
   */
  async function acquirePluginBackendCreationLease(maxWaitMs, data) {
    const locksOk =
      typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function';
    const noop = { denied: false, release() {} };
    const ls = getSharedThymerLocalStorage();
    if (!ls) {
      if (locksOk) return noop;
      if (DEBUG_COLLECTIONS) {
        dlogPathB('lease_denied_no_localstorage_no_locks', { ws: workspaceSlugFromData(data) });
      }
      return { denied: true, release() {} };
    }
    const leaseKey = scopedPbLsKey(LS_CREATE_LEASE_BASE, data);
    const holder =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const deadline = Date.now() + (Number(maxWaitMs) > 0 ? maxWaitMs : 12000);
    let acquired = false;
    let sawContention = false;
    while (Date.now() < deadline) {
      try {
        const raw = ls.getItem(leaseKey);
        let busy = false;
        if (raw) {
          let j = null;
          try {
            j = JSON.parse(raw);
          } catch (_) {
            j = null;
          }
          if (j && typeof j.exp === 'number' && j.h !== holder && j.exp > Date.now()) busy = true;
        }
        if (busy) {
          sawContention = true;
          await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 70)));
          continue;
        }
        const exp = Date.now() + 45000;
        const payload = JSON.stringify({ h: holder, exp });
        ls.setItem(leaseKey, payload);
        await new Promise((r) => setTimeout(r, 0));
        if (ls.getItem(leaseKey) === payload) {
          acquired = true;
          if (DEBUG_COLLECTIONS) dlogPathB('lease_acquired', { via: 'localStorage', sawContention, leaseKey });
          break;
        }
      } catch (_) {
        return locksOk ? noop : { denied: true, release() {} };
      }
      await new Promise((r) => setTimeout(r, 30 + Math.floor(Math.random() * 50)));
    }
    if (!acquired) {
      if (DEBUG_COLLECTIONS) dlogPathB('lease_timeout_abort_create', { sawContention, leaseKey });
      return { denied: true, release() {} };
    }
    return {
      denied: false,
      release() {
        if (!acquired) return;
        acquired = false;
        try {
          const cur = ls.getItem(leaseKey);
          if (!cur) return;
          let j = null;
          try {
            j = JSON.parse(cur);
          } catch (_) {
            return;
          }
          if (j && j.h === holder) ls.removeItem(leaseKey);
        } catch (_) {}
      },
    };
  }

  function noteRecentPluginBackendCreate(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  function noteRecentPluginBackendCreateAttempt(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return;
    try {
      ls.setItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data), String(Date.now()));
    } catch (_) {}
  }

  function getRecentPluginBackendCreateAttemptAgeMs(data) {
    const ls = getSharedThymerLocalStorage();
    if (!ls || !data) return null;
    try {
      const raw = ls.getItem(scopedPbLsKey(LS_RECENT_CREATE_ATTEMPT_BASE, data));
      const ts = Number(raw);
      if (!Number.isFinite(ts) || ts <= 0) return null;
      return Date.now() - ts;
    } catch (_) {
      return null;
    }
  }

  /** When Thymer omits names on `getAllCollections()` entries, match our Path B schema. */
  function pathBCollectionScore(c) {
    if (!c) return 0;
    try {
      const conf = c.getConfiguration?.() || {};
      const fields = Array.isArray(conf.fields) ? conf.fields : [];
      const ids = new Set(fields.map((f) => f && f.id).filter(Boolean));
      if (!ids.has('plugin_id') || !ids.has('settings_json')) return 0;
      let s = 2;
      if (ids.has(FIELD_PLUGIN)) s += 2;
      if (ids.has(FIELD_KIND)) s += 1;
      const nm = collectionDisplayName(c).toLowerCase();
      if (nm && (nm.includes('plugin') && (nm.includes('backend') || nm.includes('setting')))) s += 1;
      return s;
    } catch (_) {
      return 0;
    }
  }

  function pickPathBCollectionHeuristic(all) {
    const list = Array.isArray(all) ? all : [];
    const cands = [];
    let bestS = 0;
    for (const c of list) {
      const sc = pathBCollectionScore(c);
      if (sc > bestS) {
        bestS = sc;
        cands.length = 0;
        cands.push(c);
      } else if (sc === bestS && sc >= 2) {
        cands.push(c);
      }
    }
    if (!cands.length) return null;
    const named = cands.find((c) => {
      const n = collectionDisplayName(c);
      const cfg = collectionBackendConfiguredTitle(c);
      return n === COL_NAME || n === COL_NAME_LEGACY || cfg === COL_NAME || cfg === COL_NAME_LEGACY;
    });
    return named || cands[0];
  }

  function pickCollFromAll(all) {
    try {
      const pick = (allIn) => {
        const list = Array.isArray(allIn) ? allIn : [];
        return (
          list.find((c) => collectionDisplayName(c) === COL_NAME) ||
          list.find((c) => collectionDisplayName(c) === COL_NAME_LEGACY) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME) ||
          list.find((c) => collectionBackendConfiguredTitle(c) === COL_NAME_LEGACY) ||
          null
        );
      };
      return pick(all) || pickPathBCollectionHeuristic(all) || null;
    } catch (_) {
      return null;
    }
  }

  function hasPluginBackendInAll(all) {
    if (!Array.isArray(all) || all.length === 0) return false;
    for (const c of all) {
      const nm = collectionDisplayName(c);
      if (nm === COL_NAME || nm === COL_NAME_LEGACY) return true;
      const cfg = collectionBackendConfiguredTitle(c);
      if (cfg === COL_NAME || cfg === COL_NAME_LEGACY) return true;
    }
    return !!pickPathBCollectionHeuristic(all);
  }

  async function findColl(data) {
    try {
      const all = await getAllCollectionsDeduped(data);
      return pickCollFromAll(all);
    } catch (_) {
      return null;
    }
  }

  /** Brute list scan — catches a Backend another iframe just created if `findColl` lags. */
  async function hasPluginBackendOnWorkspace(data) {
    try {
      const all = await getAllCollectionsDeduped(data);
      return hasPluginBackendInAll(all);
    } catch (_) {
      return false;
    }
  }

  const PB_LOCK_NAME = 'thymer-ext-plugin-backend-ensure-v1';
  const DATA_ENSURE_P = '__thymerExtDataPluginBackendEnsureP';
  /** Per-workspace: Plugin Backend already ensured — skip repeat bodies (avoids getAllCollections / lock storms). */
  const WS_ENSURE_OK_MAP = '__thymerExtPbWorkspaceEnsureOkMap_v1';

  function markWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      if (!h[WS_ENSURE_OK_MAP] || typeof h[WS_ENSURE_OK_MAP] !== 'object') h[WS_ENSURE_OK_MAP] = Object.create(null);
      h[WS_ENSURE_OK_MAP][slug] = true;
    } catch (_) {}
  }

  function isWorkspacePluginBackendEnsureDone(data) {
    try {
      const slug = workspaceSlugFromData(data);
      const h = getSharedDeduplicationWindow();
      const m = h[WS_ENSURE_OK_MAP];
      return !!(m && m[slug]);
    } catch (_) {
      return false;
    }
  }

  function dlogPathB(phase, extra) {
    if (!DEBUG_COLLECTIONS) return;
    try {
      const row = { runId: DEBUG_PATHB_ID, phase, t: (typeof performance !== 'undefined' && performance.now) ? +performance.now().toFixed(1) : 0, ...extra };
      console.info('[ThymerExt/PluginBackend]', row);
    } catch (_) {
      void 0;
    }
  }

  function pathBWindowSnapshot() {
    const snap = { runId: DEBUG_PATHB_ID, topReadable: null, hasLocks: null };
    try {
      if (typeof window !== 'undefined' && window.top) {
        void window.top.document;
        snap.topReadable = true;
      }
    } catch (e) {
      snap.topReadable = false;
      try {
        snap.topErr = String((e && e.name) || e) || 'top-doc-threw';
      } catch (_) {
        snap.topErr = 'top-doc-threw';
      }
    }
    const host = getSharedDeduplicationWindow();
    try {
      snap.hasLocks = !!(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request);
    } catch (_) {
      snap.hasLocks = 'err';
    }
    try {
      snap.locationHref = typeof location !== 'undefined' ? String(location.href) : '';
    } catch (_) {
      snap.locationHref = '';
    }
    try {
      snap.hasSelf = typeof self !== 'undefined' && self === window;
      snap.selfIsTop = typeof window !== 'undefined' && window === window.top;
      snap.hostIsTop = host === (typeof window !== 'undefined' ? window.top : null);
      snap.hostIsSelf = host === (typeof window !== 'undefined' ? window : null);
      snap.hostType = (host && host.constructor && host.constructor.name) || '';
    } catch (_) {
      void 0;
    }
    try {
      snap.gHasPbP = host && host[PB_ENSURE_GLOBAL_P] != null;
      snap.gHasCreateQ = host && host[SERIAL_DATA_CREATE_P] != null;
    } catch (_) {
      void 0;
    }
    return snap;
  }

  function queueDataCreateOnSharedWindow(factory) {
    const host = getSharedDeduplicationWindow();
    if (DEBUG_COLLECTIONS) {
      dlogPathB('queueDataCreate_enter', { ...pathBWindowSnapshot() });
    }
    try {
      if (!host[SERIAL_DATA_CREATE_P] || typeof host[SERIAL_DATA_CREATE_P].then !== 'function') {
        host[SERIAL_DATA_CREATE_P] = Promise.resolve();
      }
      const out = (host[SERIAL_DATA_CREATE_P] = host[SERIAL_DATA_CREATE_P].catch(() => {}).then(factory));
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_chained', { gHasCreateQ: !!host[SERIAL_DATA_CREATE_P] });
      return out;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('queueDataCreate_fallback', { err: String((e && e.message) || e) });
      return factory();
    }
  }

  async function runPluginBackendEnsureBody(data) {
    if (data && isWorkspacePluginBackendEnsureDone(data)) return;
    if (DEBUG_COLLECTIONS) {
      dlogPathB('ensureBody_start', { pathB: pathBWindowSnapshot() });
      try {
        if (data && data.getAllCollections) {
          const a = await getAllCollectionsDeduped(data);
          const list = Array.isArray(a) ? a : [];
          const collNames = list.map((c) => {
            try { return String(collectionDisplayName(c) || '').trim() || '(no-name)'; } catch (__) { return '(err)'; }
          });
          dlogPathB('ensureBody_collections', { count: (collNames && collNames.length) || 0, names: (collNames || []).slice(0, 40) });
          if (data && data.getAllCollections) touchGetAllSanityFromCount((collNames && collNames.length) || 0);
          const dupExact = list.filter((c) => {
            try {
              const nm = collectionDisplayName(c);
              return nm === COL_NAME || nm === COL_NAME_LEGACY;
            } catch (__) {
              return false;
            }
          });
          if (dupExact.length > 1) {
            dlogPathB('duplicate_plugin_backend_named_collections', {
              count: dupExact.length,
              guids: dupExact.map((c) => {
                try {
                  return c.getGuid?.() || null;
                } catch (__) {
                  return null;
                }
              }),
              doc: 'docs/PLUGIN_BACKEND_DUPLICATE_HYGIENE.md',
            });
          }
        }
      } catch (e) {
        dlogPathB('ensureBody_getAll_failed', { err: String((e && e.message) || e) });
      }
    }
    try {
      const markPbOk = () => markWorkspacePluginBackendEnsureDone(data);
      let existing = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        let allAttempt;
        try {
          allAttempt = await getAllCollectionsDeduped(data);
        } catch (_) {
          allAttempt = null;
        }
        if (allAttempt != null) {
          existing = pickCollFromAll(allAttempt);
          if (existing) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allAttempt)) {
            markPbOk();
            return;
          }
        } else {
          existing = await findColl(data);
          if (existing) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 50 + attempt * 50));
      }
      let allPost;
      try {
        allPost = await getAllCollectionsDeduped(data);
      } catch (_) {
        allPost = null;
      }
      if (allPost != null) {
        existing = pickCollFromAll(allPost);
        if (existing) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allPost)) {
          markPbOk();
          return;
        }
      } else {
        existing = await findColl(data);
        if (existing) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      await new Promise((r) => setTimeout(r, 120));
      let allAfterWait;
      try {
        allAfterWait = await getAllCollectionsDeduped(data);
      } catch (_) {
        allAfterWait = null;
      }
      if (allAfterWait != null) {
        if (pickCollFromAll(allAfterWait)) {
          markPbOk();
          return;
        }
        if (hasPluginBackendInAll(allAfterWait)) {
          markPbOk();
          return;
        }
      } else {
        if (await findColl(data)) {
          markPbOk();
          return;
        }
        if (await hasPluginBackendOnWorkspace(data)) {
          markPbOk();
          return;
        }
      }
      let preCreateLen = 0;
      try {
        if (data && data.getAllCollections) {
          const all0 = await getAllCollectionsDeduped(data);
          preCreateLen = Array.isArray(all0) ? all0.length : 0;
          if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
        }
        if (preCreateLen === 0) {
          await new Promise((r) => setTimeout(r, 150));
          if (data && data.getAllCollections) {
            const all1 = await getAllCollectionsDeduped(data);
            preCreateLen = Array.isArray(all1) ? all1.length : 0;
            if (preCreateLen > 0) touchGetAllSanityFromCount(preCreateLen);
          }
        }
        if (preCreateLen > 0) {
          let allPre;
          try {
            allPre = await getAllCollectionsDeduped(data);
          } catch (_) {
            allPre = null;
          }
          if (allPre != null) {
            if (pickCollFromAll(allPre)) {
              markPbOk();
              return;
            }
            if (hasPluginBackendInAll(allPre)) {
              markPbOk();
              return;
            }
          } else {
            if (await findColl(data)) {
              markPbOk();
              return;
            }
            if (await hasPluginBackendOnWorkspace(data)) {
              markPbOk();
              return;
            }
          }
        }
        if (isSuspiciousEmptyAfterRecentNonEmptyList(preCreateLen) && preCreateLen === 0) {
          if (DEBUG_COLLECTIONS) {
            try {
              const h = getSharedDeduplicationWindow();
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot(), s: h[GETALL_COLLECTIONS_SANITY] || null });
            } catch (_) {
              dlogPathB('refuse_create_flaky_getall_empty', { pathB: pathBWindowSnapshot() });
            }
          }
          return;
        }
      } catch (_) {
        void 0;
      }
      if (DEBUG_COLLECTIONS) dlogPathB('ensureBody_about_to_create', { pathB: pathBWindowSnapshot() });
      const lease = await acquirePluginBackendCreationLease(14000, data);
      if (lease.denied) return;
      try {
        let allLease;
        try {
          allLease = await getAllCollectionsDeduped(data);
        } catch (_) {
          allLease = null;
        }
        if (allLease != null) {
          if (pickCollFromAll(allLease)) {
            markPbOk();
            return;
          }
          if (hasPluginBackendInAll(allLease)) {
            markPbOk();
            return;
          }
        } else {
          if (await findColl(data)) {
            markPbOk();
            return;
          }
          if (await hasPluginBackendOnWorkspace(data)) {
            markPbOk();
            return;
          }
        }
        const recentAttemptAge = getRecentPluginBackendCreateAttemptAgeMs(data);
        if (recentAttemptAge != null && recentAttemptAge >= 0 && recentAttemptAge < 120000) {
          // Another plugin iframe attempted creation very recently. Avoid burst duplicate creates.
          for (let i = 0; i < 10; i++) {
            await new Promise((r) => setTimeout(r, 130 + i * 70));
            let allCont;
            try {
              allCont = await getAllCollectionsDeduped(data);
            } catch (_) {
              allCont = null;
            }
            if (allCont != null) {
              if (pickCollFromAll(allCont)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allCont)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
          return;
        }
        const recentAge = getRecentPluginBackendCreateAgeMs(data);
        if (recentAge != null && recentAge >= 0 && recentAge < 90000) {
          // Another plugin/runtime likely just created it; let collection list/indexing settle first.
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 120 + i * 60));
            let allSettle;
            try {
              allSettle = await getAllCollectionsDeduped(data);
            } catch (_) {
              allSettle = null;
            }
            if (allSettle != null) {
              if (pickCollFromAll(allSettle)) {
                markPbOk();
                return;
              }
              if (hasPluginBackendInAll(allSettle)) {
                markPbOk();
                return;
              }
            } else {
              if (await findColl(data)) {
                markPbOk();
                return;
              }
              if (await hasPluginBackendOnWorkspace(data)) {
                markPbOk();
                return;
              }
            }
          }
        }
        noteRecentPluginBackendCreateAttempt(data);
        const exactN = await countExactPluginBackendNamedCollections(data);
        if (exactN >= 1) {
          if (DEBUG_COLLECTIONS) {
            dlogPathB('abort_create_exact_backend_name_exists', { exactN, ws: workspaceSlugFromData(data) });
          }
          markPbOk();
          return;
        }
        const coll = await queueDataCreateOnSharedWindow(() => data.createCollection());
        if (!coll || typeof coll.getConfiguration !== 'function' || typeof coll.saveConfiguration !== 'function') {
          return;
        }
        const conf = cloneShape();
        const base = coll.getConfiguration();
        if (base && typeof base.ver === 'number') conf.ver = base.ver;
        let ok = await coll.saveConfiguration(conf);
        if (ok === false) {
          // Transient host races can reject the first save; retry before giving up.
          await new Promise((r) => setTimeout(r, 180));
          ok = await coll.saveConfiguration(conf);
        }
        if (ok === false) return;
        noteRecentPluginBackendCreate(data);
        markPbOk();
        await new Promise((r) => setTimeout(r, 250));
      } finally {
        try {
          lease.release();
        } catch (_) {}
      }
    } catch (e) {
      console.error('[ThymerPluginSettings] ensure collection', e);
    }
  }

  function runPluginBackendEnsureWithLocksOrChain(data) {
    try {
      if (typeof navigator !== 'undefined' && navigator.locks && typeof navigator.locks.request === 'function') {
        if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'locks', lockName: PB_LOCK_NAME, pathB: pathBWindowSnapshot() });
        return navigator.locks.request(PB_LOCK_NAME, () => runPluginBackendEnsureBody(data));
      }
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('ensure_locks_threw', { err: String((e && e.message) || e) });
    }
    if (DEBUG_COLLECTIONS) dlogPathB('ensure_route', { via: 'hierarchyChain', pathB: pathBWindowSnapshot() });
    return chainPluginBackendEnsure(data, () => runPluginBackendEnsureBody(data));
  }

  function ensurePluginSettingsCollection(data) {
    if (!data || typeof data.getAllCollections !== 'function' || typeof data.createCollection !== 'function') {
      return Promise.resolve();
    }
    if (isWorkspacePluginBackendEnsureDone(data)) {
      return Promise.resolve();
    }
    if (DEBUG_COLLECTIONS) {
      let dHint = 'no-data';
      try {
        dHint = data
          ? `ctor=${(data && data.constructor && data.constructor.name) || '?'},eqPrev=${(data && data === g.__th_lastDataPb) || false},keys=${
            Object.keys(data).filter((k) => k && (k.includes('thymer') || k.includes('__'))).length
          }`
          : 'null';
        g.__th_lastDataPb = data;
      } catch (_) {
        dHint = 'err';
      }
      dlogPathB('ensurePluginSettingsCollection', { dataHint: dHint, dataExpand: (() => { try { if (!data) return { ok: false }; return { hasDataEnsure: !!data[DATA_ENSURE_P] }; } catch (_) { return { ok: 'throw' }; } })(), pathB: pathBWindowSnapshot() });
    }
    try {
      if (!data[DATA_ENSURE_P] || typeof data[DATA_ENSURE_P].then !== 'function') {
        data[DATA_ENSURE_P] = Promise.resolve();
      }
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_chained', { hasPriorTail: true });
      const next = data[DATA_ENSURE_P]
        .catch(() => {})
        .then(() => runPluginBackendEnsureWithLocksOrChain(data));
      data[DATA_ENSURE_P] = next;
      return next;
    } catch (e) {
      if (DEBUG_COLLECTIONS) dlogPathB('data_ensure_p_throw', { err: String((e && e.message) || e) });
      return runPluginBackendEnsureWithLocksOrChain(data);
    }
  }

  async function readDoc(data, pluginId) {
    const coll = await findColl(data);
    if (!coll) return null;
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return null;
    }
    const r = findVaultRecord(records, pluginId);
    if (!r) return null;
    let raw = '';
    try {
      raw = r.text?.('settings_json') || '';
    } catch (_) {}
    if (!raw || !String(raw).trim()) return null;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return null;
    }
  }

  async function writeDoc(data, pluginId, doc) {
    const coll = await findColl(data);
    if (!coll) return;
    await upgradePluginSettingsSchema(data, coll);
    const json = JSON.stringify(doc);
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return;
    }
    let r = findVaultRecord(records, pluginId);
    if (!r) {
      let guid = null;
      try {
        guid = coll.createRecord?.(pluginId);
      } catch (_) {}
      if (guid) {
        for (let i = 0; i < 30; i++) {
          await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
          try {
            const again = await coll.getAllRecords();
            r = again.find((x) => x.guid === guid) || findVaultRecord(again, pluginId);
            if (r) break;
          } catch (_) {}
        }
      }
    }
    if (!r) return;
    applyVaultRowMeta(r, pluginId, coll);
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
  }

  const LOCAL_MIRROR_META_PREFIX = 'thymerext_ps_local_meta_v1:';

  function localMirrorMetaKey(pluginId) {
    return LOCAL_MIRROR_META_PREFIX + encodeURIComponent(String(pluginId || 'unknown'));
  }

  function parseIsoMs(s) {
    const n = Date.parse(String(s || ''));
    return Number.isFinite(n) ? n : 0;
  }

  function readLocalMirrorMeta(pluginId) {
    try {
      const raw = localStorage.getItem(localMirrorMetaKey(pluginId));
      const parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (_) {}
    return {};
  }

  function writeLocalMirrorMeta(pluginId, meta) {
    try {
      localStorage.setItem(localMirrorMetaKey(pluginId), JSON.stringify(meta || {}));
    } catch (_) {}
  }

  function markLocalMirrorKeys(pluginId, keys, updatedAt) {
    if (!pluginId || !Array.isArray(keys)) return;
    const meta = readLocalMirrorMeta(pluginId);
    const ts = updatedAt || new Date().toISOString();
    let changed = false;
    for (const k of keys) {
      if (!k) continue;
      let exists = false;
      try {
        exists = localStorage.getItem(k) !== null;
      } catch (_) {}
      if (!exists) continue;
      meta[k] = { updatedAt: ts };
      changed = true;
    }
    if (changed) writeLocalMirrorMeta(pluginId, meta);
  }

  function collectLocalMirrorPayload(keys) {
    const payload = {};
    if (!Array.isArray(keys)) return payload;
    for (const k of keys) {
      if (!k) continue;
      try {
        const v = localStorage.getItem(k);
        if (v !== null) payload[k] = v;
      } catch (_) {}
    }
    return payload;
  }

  function localPayloadMatchesRemote(keys, remote) {
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return false;
    if (!Array.isArray(keys)) return true;
    for (const k of keys) {
      if (!k) continue;
      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}
      const remoteValue = remote.payload[k];
      if (localValue === null && typeof remoteValue !== 'string') continue;
      if (localValue !== remoteValue) return false;
    }
    return true;
  }

  function applyRemoteMirrorPayload(pluginId, keys, remote) {
    const result = { needsFlush: false };
    if (!remote || !remote.payload || typeof remote.payload !== 'object') return result;
    const meta = readLocalMirrorMeta(pluginId);
    const remoteUpdatedAt = String(remote.updatedAt || '');
    const remoteMs = parseIsoMs(remoteUpdatedAt);
    let metaChanged = false;
    for (const k of keys) {
      if (!k) continue;
      const remoteValue = remote.payload[k];
      if (typeof remoteValue !== 'string') continue;

      let localValue = null;
      try {
        localValue = localStorage.getItem(k);
      } catch (_) {}

      if (localValue === remoteValue) {
        if (remoteUpdatedAt && (!meta[k] || !meta[k].updatedAt)) {
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        }
        continue;
      }

      if (localValue === null) {
        try {
          localStorage.setItem(k, remoteValue);
          if (remoteUpdatedAt) {
            meta[k] = { updatedAt: remoteUpdatedAt };
            metaChanged = true;
          }
        } catch (_) {}
        continue;
      }

      const localMs = parseIsoMs(meta[k]?.updatedAt);
      if (localMs && remoteMs && remoteMs > localMs + 1000) {
        try {
          localStorage.setItem(k, remoteValue);
          meta[k] = { updatedAt: remoteUpdatedAt };
          metaChanged = true;
        } catch (_) {}
        continue;
      }

      // When freshness is ambiguous, preserve the browser's current settings and let flushNow repair the vault row.
      result.needsFlush = true;
      if (!localMs) {
        meta[k] = { updatedAt: new Date().toISOString() };
        metaChanged = true;
      }
      console.warn('[ThymerPluginSettings] Kept local settings instead of overwriting with older/ambiguous synced payload', {
        pluginId,
        key: k,
        localUpdatedAt: meta[k]?.updatedAt || null,
        remoteUpdatedAt: remoteUpdatedAt || null,
      });
    }
    if (metaChanged) writeLocalMirrorMeta(pluginId, meta);
    return result;
  }

  function shouldFlushMirrorOnInit(keys, remote, applyResult) {
    if (applyResult?.needsFlush) return true;
    if (remote && remote.payload && typeof remote.payload === 'object') {
      return !localPayloadMatchesRemote(keys, remote);
    }
    return Object.keys(collectLocalMirrorPayload(keys)).length > 0;
  }

  async function listRows(data, { pluginSlug, recordKind } = {}) {
    const slug = (pluginSlug || '').trim();
    if (!slug) return [];
    const coll = await findColl(data);
    if (!coll) return [];
    let records;
    try {
      records = await coll.getAllRecords();
    } catch (_) {
      return [];
    }
    const plugCol = pluginColumnPropId(coll, FIELD_PLUGIN);
    return records.filter((r) => {
      const pid = rowField(r, 'plugin_id');
      let rowSlug = rowField(r, plugCol);
      if (!rowSlug) rowSlug = inferPluginSlugFromPid(pid);
      if (rowSlug !== slug) return false;
      if (recordKind != null && String(recordKind) !== '') {
        const rk = rowField(r, FIELD_KIND) || inferRecordKindFromPid(pid, slug);
        return rk === String(recordKind);
      }
      return true;
    });
  }

  async function createDataRow(data, { pluginSlug, recordKind, rowPluginId, recordTitle, settingsDoc } = {}) {
    const ps = (pluginSlug || '').trim();
    const rid = (rowPluginId || '').trim();
    const kind = (recordKind || '').trim();
    if (!ps || !rid || !kind) {
      console.warn('[ThymerPluginSettings] createDataRow: pluginSlug, recordKind, and rowPluginId are required');
      return null;
    }
    if (rid === ps && kind !== KIND_VAULT) {
      console.warn('[ThymerPluginSettings] createDataRow: rowPluginId must differ from plugin slug unless record_kind is vault');
    }
    await ensurePluginSettingsCollection(data);
    const coll = await findColl(data);
    if (!coll) return null;
    await upgradePluginSettingsSchema(data, coll);
    const title = (recordTitle || rid).trim() || rid;
    let guid = null;
    try {
      guid = coll.createRecord?.(title);
    } catch (e) {
      console.error('[ThymerPluginSettings] createDataRow createRecord', e);
      return null;
    }
    if (!guid) return null;
    let r = null;
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, i < 8 ? 100 : 200));
      try {
        const again = await coll.getAllRecords();
        r = again.find((x) => x.guid === guid) || again.find((x) => rowField(x, 'plugin_id') === rid);
        if (r) break;
      } catch (_) {}
    }
    if (!r) return null;
    setRowField(r, 'plugin_id', rid);
    setRowField(r, FIELD_PLUGIN, ps, coll);
    setRowField(r, FIELD_KIND, kind);
    const json =
      settingsDoc !== undefined && settingsDoc !== null
        ? typeof settingsDoc === 'string'
          ? settingsDoc
          : JSON.stringify(settingsDoc)
        : '{}';
    try {
      const pj = r.prop?.('settings_json');
      if (pj && typeof pj.set === 'function') pj.set(json);
    } catch (_) {}
    return r;
  }

  function showFirstRunDialog(ui, label, preferred, onPick) {
    const id = 'thymerext-ps-first-' + Math.random().toString(36).slice(2);
    const box = document.createElement('div');
    box.id = id;
    box.style.cssText =
      'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
    const card = document.createElement('div');
    card.style.cssText =
      'max-width:420px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);';
    const title = document.createElement('div');
    title.textContent = label + ' — where to store settings?';
    title.style.cssText = 'font-weight:700;font-size:15px;margin-bottom:10px;';
    const hint = document.createElement('div');
    hint.textContent = 'Change later via Command Palette → “Storage location…”';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:16px;line-height:1.45;';
    const mk = (t, sub, prim) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.style.cssText =
        'display:block;width:100%;text-align:left;padding:12px 14px;margin-bottom:10px;border-radius:8px;cursor:pointer;font-size:14px;border:1px solid var(--border-default,#3f3f46);background:' +
        (prim ? 'rgba(167,139,250,0.25)' : 'transparent') +
        ';color:inherit;';
      const x = document.createElement('div');
      x.textContent = t;
      x.style.fontWeight = '600';
      b.appendChild(x);
      if (sub) {
        const s = document.createElement('div');
        s.textContent = sub;
        s.style.cssText = 'font-size:11px;opacity:0.75;margin-top:4px;line-height:1.35;';
        b.appendChild(s);
      }
      return b;
    };
    const bLoc = mk('This device only', 'Browser localStorage only.', preferred === 'local');
    const bSyn = mk(
      'Sync across devices',
      'Store in the workspace “' + COL_NAME + '” collection (same account on any browser).',
      preferred === 'synced'
    );
    const fin = (m) => {
      try {
        box.remove();
      } catch (_) {}
      onPick(m);
    };
    bLoc.addEventListener('click', () => fin('local'));
    bSyn.addEventListener('click', () => fin('synced'));
    card.appendChild(title);
    card.appendChild(hint);
    card.appendChild(bLoc);
    card.appendChild(bSyn);
    box.appendChild(card);
    document.body.appendChild(box);
  }

  g.ThymerPluginSettings = {
    COL_NAME,
    COL_NAME_LEGACY,
    FIELD_PLUGIN,
    FIELD_RECORD_KIND: FIELD_KIND,
    RECORD_KIND_VAULT: KIND_VAULT,
    enqueue,
    rowField,
    findVaultRecord,
    listRows,
    createDataRow,
    upgradeCollectionSchema: (data) => upgradePluginSettingsSchema(data),
    registerPluginSlug,
    preferDeferredHeavyWork,
    yieldToHostBeforePathB,
    ensureMobileLoadGraceStarted,
    inMobileLoadGrace,
    bumpMobileLoadGrace,
    installMobileResumeGraceListener,

    async init(opts) {
      ensureStartupStormWindow();
      installMobileResumeGraceListener();
      installMobileInteractionGraceListener();
      await yieldToHostBeforePathB();
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;

      let mode = null;
      try {
        mode = localStorage.getItem(modeKey);
      } catch (_) {}

      const remote = await readDoc(data, pluginId);
      if (!mode && remote && (remote.storageMode === 'synced' || remote.storageMode === 'local')) {
        mode = remote.storageMode;
        try {
          localStorage.setItem(modeKey, mode);
        } catch (_) {}
      }

      if (!mode) {
        const coll = await findColl(data);
        const preferred = coll ? 'synced' : 'local';
        await new Promise((r) => {
          requestAnimationFrame(() => requestAnimationFrame(() => r()));
        });
        await new Promise((outerResolve) => {
          enqueue(async () => {
            const picked = await new Promise((r) => {
              showFirstRunDialog(ui, label, preferred, r);
            });
            try {
              localStorage.setItem(modeKey, picked);
            } catch (_) {}
            outerResolve(picked);
          });
        });
        try {
          mode = localStorage.getItem(modeKey);
        } catch (_) {}
      }

      plugin._pluginSettingsSyncMode = mode === 'synced' ? 'synced' : 'local';
      plugin._pluginSettingsPluginId = pluginId;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      let initFlushNeeded = false;

      if (plugin._pluginSettingsSyncMode === 'synced' && remote && remote.payload && typeof remote.payload === 'object') {
        const applyResult = applyRemoteMirrorPayload(pluginId, keys, remote);
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, applyResult);
      } else if (plugin._pluginSettingsSyncMode === 'synced') {
        initFlushNeeded = shouldFlushMirrorOnInit(keys, remote, null);
      }

      if (plugin._pluginSettingsSyncMode === 'synced' && initFlushNeeded) {
        try {
          markLocalMirrorKeys(pluginId, keys);
          await g.ThymerPluginSettings.flushNow(data, pluginId, keys);
        } catch (_) {}
      }
    },

    scheduleFlush(plugin, mirrorKeys) {
      if (plugin._pluginSettingsSyncMode !== 'synced') return;
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      markLocalMirrorKeys(plugin._pluginSettingsPluginId, keys);
      if (plugin._pluginSettingsFlushTimer) clearTimeout(plugin._pluginSettingsFlushTimer);
      plugin._pluginSettingsFlushTimer = setTimeout(() => {
        plugin._pluginSettingsFlushTimer = null;
        const pdata = plugin.data;
        const pid = plugin._pluginSettingsPluginId;
        if (!pid || !pdata) return;
        g.ThymerPluginSettings.flushNow(pdata, pid, keys).catch((e) => console.error('[ThymerPluginSettings] flush', e));
      }, 500);
    },

    async flushNow(data, pluginId, mirrorKeys) {
      await ensurePluginSettingsCollection(data);
      await upgradePluginSettingsSchema(data);
      const keys = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      const payload = {};
      for (const k of keys) {
        try {
          const v = localStorage.getItem(k);
          if (v !== null) payload[k] = v;
        } catch (_) {}
      }
      const doc = {
        v: 1,
        storageMode: 'synced',
        updatedAt: new Date().toISOString(),
        payload,
      };
      await writeDoc(data, pluginId, doc);
    },

    async openStorageDialog(opts) {
      const { plugin, pluginId, modeKey, mirrorKeys, label, data, ui } = opts;
      const cur = plugin._pluginSettingsSyncMode === 'synced' ? 'synced' : 'local';
      const pick = await new Promise((resolve) => {
        const close = (v) => {
          try {
            box.remove();
          } catch (_) {}
          resolve(v);
        };
        const box = document.createElement('div');
        box.style.cssText =
          'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;padding:16px;';
        box.addEventListener('click', (e) => {
          if (e.target === box) close(null);
        });
        const card = document.createElement('div');
        card.style.cssText =
          'max-width:400px;width:100%;background:var(--panel-bg-color,#1d1915);border:1px solid var(--border-default,#3f3f46);border-radius:12px;padding:18px;';
        card.addEventListener('click', (e) => e.stopPropagation());
        const t = document.createElement('div');
        t.textContent = label + ' — storage';
        t.style.cssText = 'font-weight:700;margin-bottom:12px;';
        const b1 = document.createElement('button');
        b1.type = 'button';
        b1.textContent = 'This device only';
        const b2 = document.createElement('button');
        b2.type = 'button';
        b2.textContent = 'Sync across devices';
        [b1, b2].forEach((b) => {
          b.style.cssText =
            'display:block;width:100%;padding:10px 12px;margin-bottom:8px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;text-align:left;';
        });
        b1.addEventListener('click', () => close('local'));
        b2.addEventListener('click', () => close('synced'));
        const bx = document.createElement('button');
        bx.type = 'button';
        bx.textContent = 'Cancel';
        bx.style.cssText =
          'margin-top:8px;padding:8px 14px;border-radius:8px;cursor:pointer;border:1px solid var(--border-default,#3f3f46);background:transparent;color:inherit;';
        bx.addEventListener('click', () => close(null));
        card.appendChild(t);
        card.appendChild(b1);
        card.appendChild(b2);
        card.appendChild(bx);
        box.appendChild(card);
        document.body.appendChild(box);
      });
      if (!pick || pick === cur) return;
      try {
        localStorage.setItem(modeKey, pick);
      } catch (_) {}
      plugin._pluginSettingsSyncMode = pick === 'synced' ? 'synced' : 'local';
      const keyList = typeof mirrorKeys === 'function' ? mirrorKeys() : mirrorKeys;
      if (pick === 'synced') {
        markLocalMirrorKeys(pluginId, keyList);
        await g.ThymerPluginSettings.flushNow(data, pluginId, keyList);
      }
      ui.addToaster?.({
        title: label,
        message: pick === 'synced' ? 'Settings will sync across devices.' : 'Settings stay on this device only.',
        dismissible: true,
        autoDestroyTime: 3500,
      });
    },
  };

  g.thymerExtEnsureMobileLoadGrace = ensureMobileLoadGraceStarted;
  g.thymerExtInMobileLoadGrace = inMobileLoadGrace;
  g.thymerExtEndMobileLoadGrace = endMobileLoadGrace;
  g.thymerExtPreferDeferredHeavyWork = preferDeferredHeavyWork;
  g.thymerExtShouldDeferPanelFooterWork = shouldDeferPanelFooterWork;
  g.thymerExtBumpMobileLoadGrace = bumpMobileLoadGrace;
  g.thymerExtPauseHeavyWorkQueue = pauseHeavyWorkQueue;
  g.thymerExtInstallMobileResumeGrace = installMobileResumeGraceListener;
  g.thymerExtInstallMobileInteractionGrace = installMobileInteractionGraceListener;
  g.thymerExtEnqueueHeavyWork = enqueueHeavyWork;
  g.thymerExtScheduleAfterMobileLoadGrace = scheduleAfterMobileLoadGrace;
  g.thymerExtEnsureStartupStormWindow = ensureStartupStormWindow;
  g.thymerExtInStartupStormWindow = inStartupStormWindow;
  g.thymerExtEndStartupStormWindow = endStartupStormWindow;
  g.thymerExtScheduleAfterStartupStorm = scheduleAfterStartupStorm;
})(typeof globalThis !== 'undefined' ? globalThis : window);
// @generated END thymer-plugin-settings

const BACKREFS_PLUGIN_ID = 'backreferences';
const BACKREFS_MODE_KEY = 'thymerext_ps_mode_backreferences';
const BACKREFS_PLUGIN_LABEL = 'Backreferences';

class Plugin extends AppPlugin {
  onLoad() {
    // NOTE: Thymer strips top-level code outside the Plugin class.
    this._panelStates = new Map();
    this._eventHandlerIds = [];
    this._maxStoredPageViewRecords = 400;
    this._maxStoredSortByRecords = 400;
    this._maxStoredPropGroupStates = 160;
    this._maxStoredRecordGroupStates = 600;

    this._storageKeyVisibility = 'thymer_backreferences_visibility_v1';
    this._visibilityConfig = this.loadVisibilityConfig();

    this._storageKeyPageViewByRecord = 'thymer_backreferences_page_view_by_record_v1';
    this._pageViewByRecord = this.loadPageViewByRecordSetting();

    this._storageKeyPropGroupCollapsed = 'thymer_backreferences_prop_group_collapsed_v2';
    this._legacyStorageKeyPropGroupCollapsed = null;
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();

    this._storageKeyRecordGroupCollapsed = 'thymer_backreferences_record_group_collapsed_v1';
    this._legacyStorageKeyRecordGroupCollapsed = null;
    this._recordGroupCollapsed = this.loadRecordGroupCollapsedSetting();

    this._defaultSortBy = 'journal_page';
    this._defaultSortDir = 'desc';
    this._storageKeySortByRecord = 'thymer_backreferences_sort_by_record_v1';
    this._legacyStorageKeySortByRecord = 'thymer_backlinks_sort_by_record_v1';
    this._sortByRecord = this.loadSortByRecordSetting();

    // Layout grouping for the unified backlinks list — remembered per collection
    // (all People pages share one setting; all journal days share another).
    this._defaultGroupBy = 'none';
    this._storageKeyGroupByScope = 'thymer_backreferences_group_by_scope_v1';
    this._legacyStorageKeyGroupByRecord = 'thymer_backreferences_group_by_record_v1';
    this._groupByScope = this.loadGroupByScopeSetting();

    this._storageKeyTimeMachine = 'thymer_backreferences_timemachine_v1';
    this._timeMachineSettings = this.loadTimeMachineSettings();

    this._storageKeyExcludedSources = 'thymer_backreferences_excluded_sources_v1';
    this._excludedSources = this.loadExcludedSourcesConfig();

    this._defaultMaxResults = 200;
    this._refreshDebounceMs = 350;
    /** Known backlink sources: content-only edits cannot change the backlink list. */
    this._knownSourceRefreshDebounceMs = 8000;
    this._typingIdleRefreshMs = 1400;
    this._queryFilterDebounceMs = 180;
    this._defaultQueryFilterMaxResults = 1000;
    this._propertyIndexStatus = 'idle';
    this._propertyIndexByTargetGuid = new Map();
    this._propertyIndexSourceEntriesByRecordGuid = new Map();
    this._propertyIndexStats = this.createEmptyPropertyIndexStats();
    this._propertyIndexError = '';
    this._propertyIndexPromise = null;
    this._propertyIndexBuildSeq = 0;
    this._propertyIndexRebuildTimer = null;
    this._propertyIndexNeedsRebuild = false;
    this._propertyIndexInitialDeferHandle = null;
    this._propertyIndexInitialDeferIsIdle = false;
    /** null = unknown; true = use record.getBackReferenceRecords(); false = legacy workspace index */
    this._propertyIndexSdkMode = null;
    /**
     * Records whose incremental index update was deferred (e.g. because a full
     * build was in progress, the record wasn't retrievable yet, or the index
     * was 'idle'). Drained at the end of every successful `buildPropertyIndex`
     * via `drainPendingRecordReindex`. This replaces the previous behaviour of
     * scheduling a full workspace rebuild for every deferred record event,
     * which created a feedback loop: rebuild-in-progress → events deferred →
     * rebuild-queued → rebuild-finishes → rebuild-starts → repeat. With many
     * records and many active plugins, that loop pegged the main thread at
     * ~30% indefinitely (300ms long task every ~600ms).
     */
    this._pendingRecordReindex = new Set();
    this._queryAutocompleteCatalog = null;
    this._queryAutocompleteCatalogPromise = null;
    this._queryStandaloneFilters = [
      'task', 'todo', 'done', 'due', 'overdue', 'assigned', 'unassigned', 'scheduled',
      'inprogress', 'wip', 'waiting', 'billing', 'important', 'discuss', 'alert', 'starred',
      'document', 'page', 'record', 'heading', 'text', 'quote', 'list', 'image', 'file',
      'me', 'mention', 'today', 'tomorrow', 'yesterday', 'thisweek', 'nextweek', 'lastweek',
      'thismonth', 'thisyear'
    ];
    this._queryBuiltInKeys = [
      'created_at', 'modified_at', 'created_by', 'modified_by', 'text', 'type', 'date',
      'due', 'time', 'mention', 'scheduled', 'hashtag', 'link', 'collection', 'guid',
      'pguid', 'rguid', 'backref', 'linkto'
    ];

    this.injectCss();
    this.applyBuiltInBacklinksVisibility();

    this._cmdRebuildIndex = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Rebuild Graph Index',
      icon: 'refresh',
      onSelected: () => {
        this.rebuildPropertyIndex({ reason: 'cmdpal-rebuild-index' }).catch(() => {
          // The error state is rendered in the footer.
        });
      }
    });
    this._cmdDiagnoseRefs = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Diagnose links on this page',
      icon: 'ti-bug',
      onSelected: () => {
        void this.diagnoseActiveRecordBackReferences();
      }
    });
    this._cmdToggleDefaultVisibility = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Toggle Globally',
      icon: 'eye',
      onSelected: () => this.toggleDefaultVisibility()
    });
    this._cmdToggleCollectionVisibility = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Toggle in Current Collection',
      icon: 'eye',
      onSelected: () => this.toggleVisibilityForActiveCollection()
    });
    this._cmdTimeMachineSettings = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Time Machine settings…',
      icon: 'ti-hourglass',
      onSelected: () => this.openTimeMachineSettings()
    });
    this._cmdExcludedSources = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Excluded collections…',
      icon: 'ti-filter-off',
      onSelected: () => { void this.openExcludedSourcesSettings(); }
    });
    this._cmdStorage = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Storage location…',
      icon: 'ti-database',
      onSelected: () => {
        void this._backrefsEnsurePathBReady().then(() => {
          globalThis.ThymerPluginSettings?.openStorageDialog?.({
            plugin: this,
            pluginId: BACKREFS_PLUGIN_ID,
            modeKey: BACKREFS_MODE_KEY,
            mirrorKeys: () => this._backrefsMirrorKeys(),
            label: BACKREFS_PLUGIN_LABEL,
            data: this.data,
            ui: this.ui,
          });
        });
      },
    });

    this._backrefsPathBReadyPromise = null;

    // Hydrate/sync prefs (group-by scope, sort, Time Machine, …) via Plugin Backend
    // after the startup storm — without waiting for the Storage dialog.
    try {
      if (typeof globalThis.thymerExtScheduleAfterStartupStorm === 'function') {
        globalThis.thymerExtScheduleAfterStartupStorm(() => {
          void this._backrefsEnsurePathBReady();
        }, { reason: 'backrefs-pathb' });
      } else {
        setTimeout(() => { void this._backrefsEnsurePathBReady(); }, 2800);
      }
    } catch (_) {
      setTimeout(() => { void this._backrefsEnsurePathBReady(); }, 2800);
    }

    this._eventHandlerIds.push(
      this.events.on('panel.navigated', (ev) => this.handlePanelChanged(ev.panel, 'panel.navigated'))
    );
    this._eventHandlerIds.push(
      this.events.on('panel.focused', (ev) => this.handlePanelChanged(ev.panel, 'panel.focused'))
    );
    this._eventHandlerIds.push(
      this.events.on('panel.closed', (ev) => this.handlePanelClosed(ev.panel))
    );
    this._eventHandlerIds.push(
      this.events.on('reload', () => this.refreshAllPanels({ force: true, reason: 'reload' }))
    );

    // Keep backreferences reasonably fresh when references are created/edited elsewhere.
    this._eventHandlerIds.push(this.events.on('lineitem.created', (ev) => this.handleLineItemCreated(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.updated', (ev) => this.handleLineItemUpdated(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.moved', (ev) => this.handleLineItemMoved(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.undeleted', (ev) => this.handleLineItemUndeleted(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.deleted', (ev) => this.handleLineItemDeleted(ev)));
    this._eventHandlerIds.push(this.events.on('record.created', (ev) => this.handleRecordCreated(ev)));
    this._eventHandlerIds.push(this.events.on('record.updated', (ev) => this.handleRecordUpdated(ev)));
    this._eventHandlerIds.push(this.events.on('record.moved', (ev) => this.handleRecordMoved(ev)));

    try {
      globalThis.thymerExtEnsureMobileLoadGrace?.();
      globalThis.thymerExtInstallMobileResumeGrace?.();
      globalThis.thymerExtEnsureStartupStormWindow?.();
    } catch (_) {}
    const bootRecord = this.ui.getActivePanel?.()?.getActiveRecord?.() || null;
    if (this.noteSdkPropertyBacklinksFromRecord(bootRecord)) {
      try {
        console.info('[Backreferences] property backlinks: SDK (no workspace index)');
      } catch (_) {}
    } else {
      const probeDelayMs = this.preferDeferredHeavyWork() ? 900 : 220;
      setTimeout(() => {
        try {
          const latePanel = this.ui.getActivePanel?.();
          const lateRecord = latePanel?.getActiveRecord?.() || null;
          if (this.noteSdkPropertyBacklinksFromRecord(lateRecord)) {
            try {
              console.info('[Backreferences] property backlinks: SDK (late probe, no workspace index)');
            } catch (_) {}
            return;
          }
        } catch (_) {}
        try {
          console.info(
            '[Backreferences] property backlinks: legacy — workspace index starts when a visible backreferences footer opens'
          );
        } catch (_) {}
      }, probeDelayMs);
    }
    const kickInitialPanel = () => {
      try {
        const p = this.ui.getActivePanel?.();
        if (p) this.handlePanelChanged(p, 'initial-delayed');
      } catch (_) {}
    };
    if (this.inMobileLoadGrace()) {
      this._scheduleMobileGraceDrain();
    } else {
      const panel = this.ui.getActivePanel?.();
      if (panel) this.handlePanelChanged(panel, 'initial');
      setTimeout(kickInitialPanel, 250);
    }
  }

  inMobileLoadGrace() {
    try {
      if (typeof globalThis.thymerExtInMobileLoadGrace === 'function') {
        return globalThis.thymerExtInMobileLoadGrace();
      }
    } catch (_) {}
    return false;
  }

  _backrefsMirrorKeys() {
    const keys = [
      this._storageKeyVisibility,
      this._storageKeyPageViewByRecord,
      this._storageKeyPropGroupCollapsed,
      this._storageKeyRecordGroupCollapsed,
      this._storageKeySortByRecord,
      this._storageKeyGroupByScope,
      this._storageKeyTimeMachine,
      this._storageKeyExcludedSources,
    ];
    if (this._legacyStorageKeySortByRecord) keys.push(this._legacyStorageKeySortByRecord);
    if (this._legacyStorageKeyGroupByRecord) keys.push(this._legacyStorageKeyGroupByRecord);
    return keys;
  }

  _backrefsScheduleSettingsFlush() {
    // Ensure Path B has resolved sync mode before flush; otherwise scheduleFlush no-ops.
    void this._backrefsEnsurePathBReady().then(() => {
      globalThis.ThymerPluginSettings?.scheduleFlush?.(this, () => this._backrefsMirrorKeys());
    });
  }

  /** Path B / Plugin Backend init on demand — deferred off the journal critical path. */
  _backrefsEnsurePathBReady() {
    if (this._backrefsPathBReadyPromise) return this._backrefsPathBReadyPromise;
    this._backrefsPathBReadyPromise = this._backrefsDeferredPathBBoot().catch(() => {});
    return this._backrefsPathBReadyPromise;
  }

  async _backrefsDeferredPathBBoot() {
    await (globalThis.ThymerPluginSettings?.yieldToHostBeforePathB?.() ?? Promise.resolve());
    await (globalThis.ThymerPluginSettings?.init?.({
      plugin: this,
      pluginId: BACKREFS_PLUGIN_ID,
      modeKey: BACKREFS_MODE_KEY,
      mirrorKeys: () => this._backrefsMirrorKeys(),
      label: BACKREFS_PLUGIN_LABEL,
      data: this.data,
      ui: this.ui,
    }) ?? Promise.resolve());
    try {
      await globalThis.ThymerPluginSettings?.registerPluginSlug?.(this.data, {
        slug: BACKREFS_PLUGIN_ID,
        label: BACKREFS_PLUGIN_LABEL,
      });
    } catch (_) {}
    this._visibilityConfig = this.loadVisibilityConfig();
    this._pageViewByRecord = this.loadPageViewByRecordSetting();
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();
    this._recordGroupCollapsed = this.loadRecordGroupCollapsedSetting();
    this._sortByRecord = this.loadSortByRecordSetting();
    this._groupByScope = this.loadGroupByScopeSetting();
    this._timeMachineSettings = this.loadTimeMachineSettings();
    this._excludedSources = this.loadExcludedSourcesConfig();
    this.applyBuiltInBacklinksVisibility();
    this._reapplyGroupByPreferencesToOpenPanels();
  }

  /** After vault hydrate, restamp open footers with the synced collection-scoped group-by. */
  _reapplyGroupByPreferencesToOpenPanels() {
    for (const s of this._panelStates?.values?.() || []) {
      if (!s?.recordGuid) continue;
      const next = this.getGroupByPreferenceForRecord(s.recordGuid, s.panel);
      if ((this.normalizeGroupBy(s.groupBy) || this._defaultGroupBy) === next) {
        this.syncGroupModeControls(s);
        continue;
      }
      s.groupBy = next;
      try {
        this.renderSortMenu(s);
        this.syncSortControlState(s);
        this.syncGroupModeControls(s);
        this.renderFromCache(s);
      } catch (e) { /* ignore */ }
    }
  }

  _shouldLoadBackrefsData(state, metrics) {
    if (!state) return false;
    const m = metrics || this.getCollapseMetrics(state.lastResults);
    return !this.isFooterCollapsed(state, m);
  }

  _loadBackrefsDataForPanel(panel, state, reason) {
    if (!panel || !state) return;
    if (state._backrefsDataLoaded === true && reason !== 'footer-expanded' && reason !== 'record-changed') {
      return;
    }
    state._backrefsDataLoaded = true;
    if (!this.usesSdkPropertyBacklinks()) {
      this.ensurePropertyIndexStarted(reason || 'panel-visible');
    }
    const recordChanged = reason === 'record-changed';
    this.scheduleRefreshForPanel(panel, {
      force: recordChanged || reason === 'mobile-grace-end' || reason === 'footer-expanded',
      reason: reason || 'load-data',
    });
  }

  _scheduleMobileGraceDrain() {
    const pollMs = 350;
    if (this._mobileGraceDrainTimer) return;
    const tick = () => {
      if (this.inMobileLoadGrace()) {
        this._mobileGraceDrainTimer = setTimeout(tick, pollMs);
        return;
      }
      this._mobileGraceDrainTimer = null;
      this._drainDeferredWorkAfterMobileGrace();
    };
    this._mobileGraceDrainTimer = setTimeout(tick, pollMs);
  }

  _drainDeferredWorkAfterMobileGrace() {
    const enqueue = typeof globalThis.thymerExtEnqueueHeavyWork === 'function'
      ? globalThis.thymerExtEnqueueHeavyWork
      : null;
    const run = async () => {
      for (const state of this._panelStates.values()) {
        if (!state?._backrefsDeferredWork || !state.panel) continue;
        state._backrefsDeferredWork = false;
        try {
          if (!this.isPanelVisible(state.panel)) continue;
          if (!this._shouldLoadBackrefsData(state)) continue;
          this._loadBackrefsDataForPanel(state.panel, state, 'mobile-grace-end');
          // Yield between panels to keep navigation responsive.
          await new Promise((r) => setTimeout(r, 0));
        } catch (_) {}
      }
      try {
        const p = this.ui.getActivePanel?.();
        if (p) this.handlePanelChanged(p, 'mobile-grace-end');
      } catch (_) {}
    };
    if (enqueue) enqueue(run, { delayMs: 3500 });
    else void run();
  }

  onUnload() {
    for (const id of this._eventHandlerIds || []) {
      try {
        this.events.off(id);
      } catch (e) {
        // ignore
      }
    }
    this._eventHandlerIds = [];

    this._cmdRebuildIndex?.remove?.();
    this._cmdDiagnoseRefs?.remove?.();
    this._cmdToggleDefaultVisibility?.remove?.();
    this._cmdToggleCollectionVisibility?.remove?.();
    this._cmdTimeMachineSettings?.remove?.();
    this._cmdExcludedSources?.remove?.();
    this._cmdStorage?.remove?.();
    this._backrefsPathBReadyPromise = null;
    try { document.documentElement.classList.remove('tlr-hide-native-backrefs'); } catch (e) { /* ignore */ }

    if (this._mobileGraceDrainTimer) {
      clearTimeout(this._mobileGraceDrainTimer);
      this._mobileGraceDrainTimer = null;
    }
    if (this._propertyIndexRebuildTimer) {
      clearTimeout(this._propertyIndexRebuildTimer);
      this._propertyIndexRebuildTimer = null;
    }
    this.cancelInitialPropertyIndexDefer();
    this._pendingRecordReindex?.clear?.();

    for (const panelId of Array.from(this._panelStates?.keys?.() || [])) {
      this.disposePanelState(panelId);
    }
    this._panelStates?.clear?.();
  }

  // ---------- Panel lifecycle ----------

  handlePanelChanged(panel, reason) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;

    const panelEl = panel?.getElement?.() || null;
    if (this.shouldSuppressInPanel(panel, panelEl)) {
      this.disposePanelState(panelId);
      return;
    }

    const mountContainer = this.findMountContainer(panelEl);
    if (!mountContainer) {
      this.disposePanelState(panelId);
      return;
    }

    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;

    if (!recordGuid) {
      // If the panel no longer shows a record, remove our footer.
      this.disposePanelState(panelId);
      return;
    }

    const state = this.getOrCreatePanelState(panel);
    if (!state.sectionCollapsed || typeof state.sectionCollapsed !== 'object') {
      state.sectionCollapsed = this.createDefaultSectionCollapsedState();
    }
    if (state.footerCollapsed !== true && state.footerCollapsed !== false) {
      state.footerCollapsed = null;
    }
    const recordChanged = state.recordGuid !== recordGuid;
    state.recordGuid = recordGuid;
    if (this.inMobileLoadGrace()) {
      state._backrefsDeferredWork = true;
      if (this.isPanelVisible(panel)) {
        this.mountFooter(panel, state);
      }
      this._scheduleMobileGraceDrain();
      return;
    }
    if (recordChanged) {
      const viewPrefs = this.getPageViewPreference(recordGuid);
      state.footerCollapsed = viewPrefs.footerCollapsed;
      state.sectionCollapsed = this.cloneSectionCollapsedState(viewPrefs.sections);
      this.resetTimeMachineState(state);
    }

    if (recordChanged) {
      state._backrefsDataLoaded = false;
    }

    if (recordChanged || !this.isValidSortBy(state.sortBy) || !this.isValidSortDir(state.sortDir)) {
      state.linkedContextByLine = new Map();
      state.searchAutocompleteItems = [];
      state.searchAutocompleteSelectedIndex = 0;
      state.searchAutocompleteOpen = false;
      state.liveBaselineSnapshot = null;
      state.liveCurrentSnapshot = null;
      state.liveNewKeys = new Set();
      state.liveRemoteBadgesByKey = new Map();
      state.pendingRemoteSync = false;
      state.pendingRemoteUsers = new Set();
      if (state.queryFilterTimer) {
        clearTimeout(state.queryFilterTimer);
        state.queryFilterTimer = null;
      }
      state.queryFilterState = null;
      const pref = this.getSortPreferenceForRecord(recordGuid);
      state.sortBy = pref.sortBy;
      state.sortDir = pref.sortDir;
      state.groupBy = this.getGroupByPreferenceForRecord(recordGuid, panel);
      state.sortMenuOpen = false;
      state.searchOpen = Boolean((state.searchQuery || '').trim());
    }

    if (this.isPanelVisible(panel)) {
      this.mountFooter(panel, state);
      if (!this._shouldLoadBackrefsData(state)) {
        return;
      }
      // Do not full-refresh on panel.focused / panel.navigated when the record is unchanged —
      // that fought the editor during typing and Cmd+I (see docs/EXPANDABLE_PREVIEW_PATTERN.md §7).
      const needsDataRefresh = recordChanged || !state.lastResults;
      if (needsDataRefresh) {
        this._loadBackrefsDataForPanel(
          panel,
          state,
          reason || (recordChanged ? 'record-changed' : 'initial-load')
        );
      }
    } else {
      this.unmountFooterForHiddenPanel(state);
      return;
    }
  }

  shouldSuppressInPanel(panel, panelEl) {
    const panelType = typeof panel?.getType === 'function' ? (panel.getType() || '').trim() : '';
    const nav = panel?.getNavigation?.() || null;
    const navType = nav && typeof nav.type === 'string' ? nav.type.trim() : '';

    if (panelType && panelType !== 'edit_panel') return true;

    // Keep suppression conservative: nav.type labels can vary across builds.
    // We hard-suppress known custom panel nav types and any Search surface,
    // which can share editor-panel containers but should never host footer UI.
    if (navType === 'custom' || navType === 'custom_panel') return true;
    if (panelEl?.matches?.('.search-panel') || panelEl?.closest?.('.search-panel')) return true;

    return false;
  }

  getVisibilityInstallDefault() {
    const cfg = this.getConfiguration?.() || {};
    if (typeof cfg?.custom?.defaultVisible === 'boolean') {
      return cfg.custom.defaultVisible;
    }
    return true;
  }

  normalizeVisibilityConfig(value, fallbackDefaultVisible) {
    const fallback = fallbackDefaultVisible === false ? false : true;
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaultVisible = typeof source.defaultVisible === 'boolean'
      ? source.defaultVisible
      : fallback;
    const collections = {};
    const rawCollections = source.collections && typeof source.collections === 'object' && !Array.isArray(source.collections)
      ? source.collections
      : {};

    for (const [guid, visible] of Object.entries(rawCollections)) {
      const key = typeof guid === 'string' ? guid.trim() : '';
      if (!key || typeof visible !== 'boolean') continue;
      if (visible === defaultVisible) continue;
      collections[key] = visible;
    }

    const updatedAt = Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0
      ? Math.floor(Number(source.updatedAt))
      : 0;

    return {
      version: 1,
      defaultVisible,
      collections,
      updatedAt
    };
  }

  loadVisibilityConfig() {
    const fallback = this.getVisibilityInstallDefault();
    return this.normalizeVisibilityConfig(this.readJsonStorage(this._storageKeyVisibility), fallback);
  }

  saveVisibilityConfig(config) {
    const next = this.normalizeVisibilityConfig(config, this.getVisibilityInstallDefault());
    next.updatedAt = Date.now();
    this._visibilityConfig = next;
    this.writeJsonStorage(this._storageKeyVisibility, next);
    return next;
  }

  getPanelCollection(panel) {
    try {
      return panel?.getActiveCollection?.() || null;
    } catch (e) {
      return null;
    }
  }

  getCollectionGuid(collection) {
    const guid = typeof collection?.getGuid === 'function'
      ? collection.getGuid()
      : (collection?.guid || collection?.id || '');
    return typeof guid === 'string' ? guid.trim() : '';
  }

  getCollectionName(collection) {
    const name = typeof collection?.getName === 'function'
      ? collection.getName()
      : (collection?.name || '');
    return (typeof name === 'string' && name.trim()) ? name.trim() : 'current collection';
  }

  isCollectionVisible(collection) {
    const cfg = this._visibilityConfig || this.loadVisibilityConfig();
    const guid = this.getCollectionGuid(collection);
    if (guid && Object.prototype.hasOwnProperty.call(cfg.collections || {}, guid)) {
      return cfg.collections[guid] !== false;
    }
    return cfg.defaultVisible !== false;
  }

  isPanelVisible(panel) {
    return this.isCollectionVisible(this.getPanelCollection(panel));
  }

  defaultExcludedSourcesConfig() {
    return {
      version: 1,
      collections: [],
      hideBuiltInBacklinks: true,
      updatedAt: 0
    };
  }

  normalizeExcludedSourcesConfig(raw, fallback = null) {
    const base = fallback || this.defaultExcludedSourcesConfig();
    const source = raw && typeof raw === 'object' ? raw : {};
    const list = Array.isArray(source.collections)
      ? source.collections
      : (Array.isArray(source.excludedCollections) ? source.excludedCollections : base.collections);
    const collections = [];
    const seen = new Set();
    for (const entry of list || []) {
      const name = String(entry || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      collections.push(name);
    }
    return {
      version: 1,
      collections,
      hideBuiltInBacklinks: source.hideBuiltInBacklinks !== false,
      updatedAt: Number(source.updatedAt) || base.updatedAt || 0
    };
  }

  loadExcludedSourcesConfig() {
    let next = this.normalizeExcludedSourcesConfig(
      this.readJsonStorage(this._storageKeyExcludedSources),
      this.defaultExcludedSourcesConfig()
    );
    // One-time migrate from Time Machine's old free-text exclusion list.
    if (!next.collections.length) {
      try {
        const tm = this.normalizeTimeMachineSettings(this._timeMachineSettings || this.loadTimeMachineSettings());
        const migrated = (tm.excludedCollections || []).map((n) => String(n || '').trim()).filter(Boolean);
        if (migrated.length) {
          next = this.normalizeExcludedSourcesConfig({ ...next, collections: migrated });
          this.writeJsonStorage(this._storageKeyExcludedSources, next);
        }
      } catch (e) {
        // ignore
      }
    }
    return next;
  }

  saveExcludedSourcesConfig(config) {
    const next = this.normalizeExcludedSourcesConfig(config, this.defaultExcludedSourcesConfig());
    next.updatedAt = Date.now();
    this._excludedSources = next;
    this.writeJsonStorage(this._storageKeyExcludedSources, next);
    // Keep Time Machine's mirrored list in sync (single menu owns both).
    try {
      const tm = this.normalizeTimeMachineSettings(this._timeMachineSettings || this.loadTimeMachineSettings());
      if (JSON.stringify(tm.excludedCollections || []) !== JSON.stringify(next.collections)) {
        this.saveTimeMachineSettings({ ...tm, excludedCollections: [...next.collections] });
      }
    } catch (e) {
      // ignore
    }
    this.applyBuiltInBacklinksVisibility();
    this._backrefsScheduleSettingsFlush?.();
    return next;
  }

  shouldHideBuiltInBacklinks() {
    const cfg = this._excludedSources || this.loadExcludedSourcesConfig();
    return cfg.hideBuiltInBacklinks !== false;
  }

  applyBuiltInBacklinksVisibility() {
    try {
      document.documentElement.classList.toggle(
        'tlr-hide-native-backrefs',
        this.shouldHideBuiltInBacklinks()
      );
    } catch (e) {
      // ignore
    }
  }

  getExcludedSourceCollectionSet() {
    const cfg = this._excludedSources || this.loadExcludedSourcesConfig();
    return new Set((cfg.collections || []).map((n) => String(n || '').trim().toLowerCase()).filter(Boolean));
  }

  /**
   * True when this source record's collection is in the excluded list
   * (e.g. YNAB / Contacts Tracker date-stamped noise on journal days).
   */
  isExcludedSourceRecord(record) {
    const excluded = this.getExcludedSourceCollectionSet();
    if (!excluded.size) return false;
    const label = (this.getRecordCollectionLabel(record) || '').trim().toLowerCase();
    if (label && excluded.has(label)) return true;
    try {
      const coll = record?.getCollection?.() || null;
      const name = (this.getCollectionName(coll) || '').trim().toLowerCase();
      if (name && name !== 'current collection' && excluded.has(name)) return true;
    } catch (e) {
      // ignore
    }
    return false;
  }

  showToast(title) {
    const text = typeof title === 'string' ? title.trim() : '';
    if (!text) return;
    try {
      this.ui?.addToaster?.({
        title: text,
        dismissible: true,
        autoDestroyTime: 1800
      });
    } catch (e) {
      // ignore
    }
  }

  /**
   * Reports what the host back-reference API returns for the open record, so a link the
   * built-in backlinks panel shows but this footer drops can be traced to a ref shape
   * the linked-group builder rejects (unexpected kind, or a missing lineItemGuid).
   */
  async diagnoseActiveRecordBackReferences() {
    const record = this.ui?.getActivePanel?.()?.getActiveRecord?.() || null;
    if (!record) {
      this.showToast('Backreferences diag: no active record');
      return;
    }

    let refs = null;
    try {
      refs = await this.fetchDetailedBackReferences(record);
    } catch (e) {
      console.error('[Backreferences/diag] getBackReferences threw', e);
      this.showToast('Backreferences diag: back-reference lookup failed (see console)');
      return;
    }

    if (refs === null) {
      this.showToast('Backreferences diag: host back-reference API unavailable');
      return;
    }

    const rows = (refs || []).map((ref) => ({
      kind: ref?.kind === undefined ? '(undefined)' : String(ref.kind),
      lineItemGuid: (ref?.lineItemGuid || '').trim(),
      propertyId: ref?.propertyId || '',
      source: (ref?.record?.getName?.() || '').trim() || ref?.record?.guid || '(unknown)'
    }));

    const kinds = Object.create(null);
    for (const row of rows) kinds[row.kind] = (kinds[row.kind] || 0) + 1;
    const droppedLineRefs = rows.filter((r) => r.kind === 'line' && !r.lineItemGuid).length;

    console.info('[Backreferences/diag]', {
      record: (record.getName?.() || '').trim() || record.guid,
      guid: record.guid,
      totalRefs: rows.length,
      kinds,
      lineRefsMissingLineItemGuid: droppedLineRefs,
      rows
    });

    const kindSummary = Object.keys(kinds).map((k) => k + ' x' + kinds[k]).join(', ') || 'none';
    this.showToast(`Backreferences diag: ${rows.length} refs (${kindSummary}) — details in console`);
  }

  toggleDefaultVisibility() {
    const current = this._visibilityConfig || this.loadVisibilityConfig();
    const nextVisible = current.defaultVisible === false;
    this.saveVisibilityConfig({
      version: 1,
      defaultVisible: nextVisible,
      collections: {},
      updatedAt: Date.now()
    });
    this.showToast(`Backreferences ${nextVisible ? 'shown' : 'hidden'} globally`);
    this.reconcileAllPanelsVisibility({ refreshVisible: nextVisible, reason: 'toggle-global-visibility' });
  }

  toggleVisibilityForActiveCollection() {
    const panel = this.ui?.getActivePanel?.() || null;
    const collection = this.getPanelCollection(panel);
    const guid = this.getCollectionGuid(collection);
    if (!guid) {
      this.showToast('No active collection for Backreferences');
      return;
    }

    const current = this._visibilityConfig || this.loadVisibilityConfig();
    const currentVisible = this.isCollectionVisible(collection);
    const nextVisible = !currentVisible;
    const collections = { ...(current.collections || {}) };
    if (nextVisible === current.defaultVisible) {
      delete collections[guid];
    } else {
      collections[guid] = nextVisible;
    }

    this.saveVisibilityConfig({
      ...current,
      collections,
      updatedAt: Date.now()
    });

    const name = this.getCollectionName(collection);
    this.showToast(`Backreferences ${nextVisible ? 'shown' : 'hidden'} for ${name}`);
    this.reconcileAllPanelsVisibility({
      refreshVisible: nextVisible,
      reason: 'toggle-collection-visibility',
      collectionGuid: guid
    });
  }

  getKnownPanels() {
    const panels = [];
    const seen = new Set();
    const addPanel = (panel) => {
      const id = panel?.getId?.() || null;
      if (!id || seen.has(id)) return;
      seen.add(id);
      panels.push(panel);
    };

    try {
      const openPanels = this.ui?.getPanels?.() || [];
      for (const panel of openPanels) addPanel(panel);
    } catch (e) {
      // ignore
    }

    for (const state of this._panelStates?.values?.() || []) {
      addPanel(state?.panel || null);
    }

    return panels;
  }

  reconcileAllPanelsVisibility({ refreshVisible, reason, collectionGuid } = {}) {
    for (const panel of this.getKnownPanels()) {
      if (collectionGuid) {
        const guid = this.getCollectionGuid(this.getPanelCollection(panel));
        if (guid !== collectionGuid) continue;
      }
      this.handlePanelChanged(panel, reason || 'visibility-changed');
    }
  }

  handlePanelClosed(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    this.disposePanelState(panelId);
  }

  getOrCreatePanelState(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) {
      return this.createPanelState('unknown', null);
    }

    let state = this._panelStates.get(panelId) || null;
    if (state) {
      state.panel = panel;
      return state;
    }

    state = this.createPanelState(panelId, panel);

    this._panelStates.set(panelId, state);
    return state;
  }

  createPanelState(panelId, panel) {
    return {
      panelId: panelId || 'unknown',
      panel: panel || null,
      recordGuid: null,
      mountedIn: null,
      rootEl: null,
      bodyEl: null,
      statusSlotEl: null,
      propertySlotEl: null,
      linkedSlotEl: null,
      unlinkedSlotEl: null,
      timeMachineSlotEl: null,
      timeMachineToggleEl: null,
      timeMachineCollapsed: true,
      timeMachineLoading: false,
      timeMachineResults: null,
      timeMachineJournalKey: '',
      countEl: null,
      footerToggleEl: null,
      sortToggleEl: null,
      sortMenuEl: null,
      groupModesEl: null,
      searchToggleEl: null,
      searchRowEl: null,
      searchWrapEl: null,
      searchInputEl: null,
      searchHighlightTextEl: null,
      searchClearEl: null,
      searchRefreshEl: null,
      searchAutocompleteEl: null,
      searchAutocompleteItems: [],
      searchAutocompleteSelectedIndex: 0,
      searchAutocompleteOpen: false,
      searchAutocompleteDismissHandler: null,
      searchAutocompleteRequestSeq: 0,
      searchQuery: '',
      searchOpen: false,
      footerCollapsed: null,
      sectionCollapsed: this.createDefaultSectionCollapsedState(),
      linkedContextByLine: new Map(),
      recordExpandedState: new Map(),
      liveBaselineSnapshot: null,
      liveCurrentSnapshot: null,
      liveNewKeys: new Set(),
      liveRemoteBadgesByKey: new Map(),
      liveRenderVersion: 0,
      pendingRemoteSync: false,
      pendingRemoteUsers: new Set(),
      linkedContextRenderVersion: 0,
      renderSectionKeys: null,
      sortBy: this._defaultSortBy,
      sortDir: this._defaultSortDir,
      groupBy: this._defaultGroupBy,
      sortMenuOpen: false,
      sortMenuDismissHandler: null,
      sortMenuKeyHandler: null,
      queryFilterTimer: null,
      queryFilterSeq: 0,
      queryFilterState: null,
      contextPreloadTimer: null,
      contextPreloadSeq: 0,
      lastResults: null,
      observer: null,
      refreshTimer: null,
      refreshSeq: 0,
      isLoading: false
    };
  }

  disposePanelState(panelId) {
    const state = this._panelStates.get(panelId) || null;
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }

    if (state.contextPreloadTimer) {
      clearTimeout(state.contextPreloadTimer);
      state.contextPreloadTimer = null;
    }
    state.contextPreloadSeq = (state.contextPreloadSeq || 0) + 1;

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

    this.setSortMenuOpen(state, false);
    this.setSearchAutocompleteOpen(state, false);

    try {
      state.rootEl?.remove?.();
    } catch (e) {
      // ignore
    }

    this._panelStates.delete(panelId);
  }

  unmountFooterForHiddenPanel(state) {
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }

    if (state.contextPreloadTimer) {
      clearTimeout(state.contextPreloadTimer);
      state.contextPreloadTimer = null;
    }
    state.contextPreloadSeq = (state.contextPreloadSeq || 0) + 1;

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

    this.setSortMenuOpen(state, false);
    this.setSearchAutocompleteOpen(state, false);

    try {
      state.rootEl?.remove?.();
    } catch (e) {
      // ignore
    }

    state.mountedIn = null;
    state.rootEl = null;
    state.bodyEl = null;
    state.statusSlotEl = null;
    state.propertySlotEl = null;
    state.linkedSlotEl = null;
    state.unlinkedSlotEl = null;
    state.countEl = null;
    state.footerToggleEl = null;
    state.sortToggleEl = null;
    state.sortMenuEl = null;
    state.groupModesEl = null;
    state.searchToggleEl = null;
    state.searchRowEl = null;
    state.searchWrapEl = null;
    state.searchInputEl = null;
    state.searchHighlightTextEl = null;
    state.searchClearEl = null;
    state.searchRefreshEl = null;
    state.searchAutocompleteEl = null;
    state.renderSectionKeys = null;
  }

  // ---------- Mounting ----------

  mountFooter(panel, state) {
    if (!this.isPanelVisible(panel)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    const panelEl = panel?.getElement?.() || null;
    if (!panelEl) return;

    const container = this.findMountContainer(panelEl);
    if (!container) return;

    // If Thymer re-rendered and dropped our node, rebuild.
    const needsRebuild = !state.rootEl || !state.rootEl.isConnected;
    if (needsRebuild) {
      state.rootEl = this.buildFooterRoot(state);
      state.bodyEl = state.rootEl.querySelector('[data-role="body"]');
      state.statusSlotEl = state.rootEl.querySelector('[data-role="status-slot"]');
      state.propertySlotEl = state.rootEl.querySelector('[data-role="property-slot"]');
      state.linkedSlotEl = state.rootEl.querySelector('[data-role="linked-slot"]');
      state.unlinkedSlotEl = state.rootEl.querySelector('[data-role="unlinked-slot"]');
      state.timeMachineSlotEl = state.rootEl.querySelector('[data-role="time-machine-slot"]');
      state.timeMachineToggleEl = state.rootEl.querySelector('[data-action="toggle-time-machine"]');
      state.countEl = state.rootEl.querySelector('[data-role="count"]');
      state.renderSectionKeys = null;
      this.setSearchOpen(state, state.searchOpen === true || Boolean((state.searchQuery || '').trim()));
      this.syncSearchAutocompleteControlState(state);
      this.renderSearchAutocomplete(state);
      this.setSearchAutocompleteOpen(state, state.searchOpen === true && state.searchAutocompleteOpen === true);
      this.renderSortMenu(state);
      this.syncSortControlState(state);
      this.setSortMenuOpen(state, state.sortMenuOpen === true);
      if (state.lastResults) {
        this.renderReferences(state, state.lastResults);
      }
    }

    // Ensure it is mounted in the right container.
    if (state.rootEl && state.rootEl.parentElement !== container) {
      container.appendChild(state.rootEl);
      state.mountedIn = container;
    }

    this.renderSortMenu(state);
    this.syncSortControlState(state);

    // Remount only when our footer node is removed from the mount container — not on every
    // editor line DOM tick (subtree:true on the panel caused occasional caret fights).
    if (!state.observer) {
      const observedContainer = container;
      state.observer = new MutationObserver(() => {
        if (state.rootEl && !state.rootEl.isConnected) {
          setTimeout(() => this.mountFooter(panel, state), 0);
        }
      });
      try {
        state.observer.observe(observedContainer, { childList: true });
      } catch (_) {
        try { state.observer.disconnect(); } catch (_) {}
        state.observer = null;
      }
    }
  }

  findMountContainer(panelEl) {
    return this.findMountContainerDetails(panelEl).element || null;
  }

  findMountContainerDetails(panelEl) {
    if (!panelEl) return { element: null, selector: null };

    const checks = ['.page-content', '.editor-wrapper', '.editor-panel', '#editor'];
    for (const selector of checks) {
      if (panelEl?.matches?.(selector)) return { element: panelEl, selector };
      const child = panelEl.querySelector?.(selector) || null;
      if (child) return { element: child, selector };
    }

    return { element: null, selector: null };
  }

  buildFooterRoot(state) {
    const root = document.createElement('div');
    root.className = 'tlr-footer tlr-footer--native';
    root.dataset.panelId = state.panelId;

    const headerField = document.createElement('div');
    headerField.className = 'tlr-header-field';

    const header = document.createElement('div');
    header.className = 'tlr-header form-field-row';

    const headerMain = document.createElement('div');
    headerMain.className = 'tlr-header-main';

    const headerControls = document.createElement('div');
    headerControls.className = 'tlr-header-controls';

    // Built-in style: one summary pill (chevron + "N backlinks in M pages").
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tlr-btn tlr-toggle tlr-summary-pill button-none button-small button-minimal-hover';
    toggleBtn.type = 'button';
    toggleBtn.dataset.action = 'toggle';
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.setAttribute('aria-label', 'Collapse');
    toggleBtn.setAttribute('aria-expanded', 'true');

    const pillIcon = document.createElement('span');
    pillIcon.className = 'tlr-title-icon';
    pillIcon.setAttribute('aria-hidden', 'true');
    const pillGlyph = this.buildInlineIcon('affiliate', 15);
    if (pillGlyph) pillIcon.appendChild(pillGlyph);
    const pillLabel = document.createElement('span');
    pillLabel.className = 'tlr-pill-label';
    pillLabel.textContent = 'backlinks';

    const count = document.createElement('span');
    count.className = 'tlr-count';
    count.dataset.role = 'count';
    count.textContent = '0';

    // Icon → label → count → chevron, matching the Highlights pill.
    toggleBtn.appendChild(pillIcon);
    toggleBtn.appendChild(pillLabel);
    toggleBtn.appendChild(count);
    toggleBtn.appendChild(this.buildChevronIcon(false, 'tlr-toggle-caret'));

    const filterWrap = document.createElement('div');
    filterWrap.className = 'tlr-filter-wrap';

    const filterToggle = document.createElement('button');
    filterToggle.className = 'tlr-btn tlr-filter-toggle tlr-search-toggle button-none button-small button-minimal-hover tooltip id--filter-button';
    filterToggle.type = 'button';
    filterToggle.dataset.action = 'toggle-search';
    filterToggle.setAttribute('aria-expanded', state.searchOpen === true ? 'true' : 'false');
    filterToggle.setAttribute('aria-label', 'Filter');
    filterToggle.setAttribute('data-tooltip', 'Filter');
    filterToggle.setAttribute('data-tooltip-dir', 'top');
    try {
      const filterIcon = this.ui.createIcon('ti-filter');
      filterIcon.classList.add('id--filter-icon');
      filterToggle.appendChild(filterIcon);
    } catch (e) {
      filterToggle.textContent = 'Filter';
    }
    filterWrap.appendChild(filterToggle);

    const searchRow = document.createElement('div');
    searchRow.className = 'tlr-search-row form-field';

    const searchRowInner = document.createElement('div');
    searchRowInner.className = 'tlr-search-row-inner form-field-row';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'tlr-search-wrap tlr-query-input query-input';

    const queryWrap = document.createElement('div');
    queryWrap.className = 'query-input--wrapper';

    const highlight = document.createElement('div');
    highlight.className = 'query-input--highlight';

    const highlightText = document.createElement('span');
    highlight.appendChild(highlightText);

    const input = document.createElement('input');
    input.className = 'tlr-search-input query-input--field w-full form-input is-collection-filter';
    input.type = 'text';
    input.name = 'backreferences-filter';
    input.placeholder = 'Search text, or use @Collection.property = "value"';
    input.title = 'Search current backreferences with plain text, or use Thymer query syntax like @Collection.property = "value" and AND/OR/NOT';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = state.searchQuery || '';

    const stopKeys = (e) => {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    input.addEventListener('keydown', (e) => {
      stopKeys(e);
      if (state.searchAutocompleteOpen === true) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.moveSearchAutocompleteSelection(state, 1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.moveSearchAutocompleteSelection(state, -1);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          this.applySelectedSearchAutocompleteItem(state);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this.applySelectedSearchAutocompleteItem(state);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.setSearchAutocompleteOpen(state, false);
          return;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        const q = (state.searchQuery || '').trim();
        if (q) {
          state.searchQuery = '';
          input.value = '';
          this.handleSearchQueryChanged(state, { immediate: true });
        } else {
          input.blur();
        }
        return;
      }

      if (e.key === 'Enter') {
        const mode = this.getSearchMode(state.searchQuery || '');
        if (mode === 'query') {
          if (this.isIncompleteQueryDraft(state.searchQuery || '')) return;
          e.preventDefault();
          this.scheduleQueryFilterRefresh(state, { immediate: true, reason: 'enter' });
        }
      }
    });

    input.addEventListener('focus', () => {
      this.updateSearchFieldState(state);
      this.updateSearchAutocomplete(state);
    });

    input.addEventListener('click', () => {
      this.updateSearchFieldState(state);
      this.updateSearchAutocomplete(state);
    });

    input.addEventListener('blur', () => {
      this.updateSearchFieldState(state);
    });

    input.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        return;
      }
      this.updateSearchFieldState(state);
      this.updateSearchAutocomplete(state);
    });

    input.addEventListener('input', () => {
      state.searchQuery = input.value;
      this.updateSearchFieldState(state);
      this.handleSearchQueryChanged(state, { immediate: false });
      this.updateSearchAutocomplete(state);
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tlr-search-clear query-input--clear-btn button-none button-small button-minimal-hover tooltip';
    clearBtn.type = 'button';
    clearBtn.dataset.action = 'clear-search';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.setAttribute('data-tooltip', 'Clear search');
    clearBtn.setAttribute('data-tooltip-dir', 'top');
    try {
      clearBtn.appendChild(this.ui.createIcon('ti-x'));
    } catch (e) {
      clearBtn.textContent = 'x';
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'tlr-search-refresh query-input--refresh-btn button-none button-small button-minimal-hover tooltip';
    refreshBtn.type = 'button';
    refreshBtn.dataset.action = 'refresh-search';
    refreshBtn.setAttribute('aria-label', 'Refresh now');
    refreshBtn.setAttribute('data-tooltip', 'Refresh now');
    refreshBtn.setAttribute('data-tooltip-dir', 'top');
    try {
      refreshBtn.appendChild(this.ui.createIcon('ti-refresh'));
    } catch (e) {
      refreshBtn.textContent = 'Refresh';
    }

    const autocomplete = document.createElement('div');
    autocomplete.className = 'tlr-search-autocomplete cmdpal--inline dropdown active focused-component';
    autocomplete.setAttribute('role', 'listbox');

    queryWrap.appendChild(highlight);
    queryWrap.appendChild(input);
    queryWrap.appendChild(clearBtn);
    queryWrap.appendChild(refreshBtn);
    searchWrap.appendChild(queryWrap);
    searchWrap.appendChild(autocomplete);

    const sortWrap = document.createElement('div');
    sortWrap.className = 'tlr-sort-wrap';

    const sortToggle = document.createElement('button');
    sortToggle.className = 'tlr-btn tlr-sort-toggle button-none button-small button-minimal-hover';
    sortToggle.type = 'button';
    sortToggle.dataset.action = 'toggle-sort-menu';
    sortToggle.setAttribute('aria-label', 'Sort options');
    sortToggle.setAttribute('aria-haspopup', 'menu');
    sortToggle.setAttribute('aria-expanded', state.sortMenuOpen === true ? 'true' : 'false');
    sortToggle.title = 'Sort options';
    const sortGlyph = document.createElement('span');
    sortGlyph.className = 'tlr-sort-glyph';
    sortGlyph.setAttribute('aria-hidden', 'true');
    const sortBars = document.createElement('span');
    sortBars.className = 'tlr-sort-glyph-bars';
    const sortArrows = document.createElement('span');
    sortArrows.className = 'tlr-sort-glyph-arrows';
    sortGlyph.appendChild(sortBars);
    sortGlyph.appendChild(sortArrows);
    sortToggle.appendChild(sortGlyph);

    const sortMenu = document.createElement('div');
    sortMenu.className = 'tlr-sort-menu cmdpal--inline dropdown active focused-component';
    sortMenu.setAttribute('role', 'menu');
    sortMenu.setAttribute('aria-label', 'Backreferences sort options');

    sortWrap.appendChild(sortToggle);
    sortWrap.appendChild(sortMenu);

    headerMain.appendChild(toggleBtn);

    const groupModes = this.buildGroupModeControls();
    state.groupModesEl = groupModes;

    const tmToggle = document.createElement('button');
    tmToggle.type = 'button';
    tmToggle.className = 'tlr-btn tlr-tm-toggle button-none button-small button-minimal-hover tooltip';
    tmToggle.dataset.action = 'toggle-time-machine';
    tmToggle.title = 'Time Machine';
    tmToggle.setAttribute('aria-label', 'Time Machine');
    tmToggle.setAttribute('data-tooltip', 'Time Machine');
    tmToggle.setAttribute('data-tooltip-dir', 'top');
    tmToggle.setAttribute('aria-pressed', 'false');
    try { tmToggle.appendChild(this.ui.createIcon('ti-hourglass')); }
    catch (e) { tmToggle.textContent = '⏳'; }
    state.timeMachineToggleEl = tmToggle;

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'tlr-btn tlr-hover-action tlr-settings-cog button-none button-small button-minimal-hover tooltip';
    settingsBtn.dataset.action = 'open-settings';
    settingsBtn.title = 'Backreferences settings';
    settingsBtn.setAttribute('aria-label', 'Backreferences settings');
    settingsBtn.setAttribute('data-tooltip', 'Settings');
    settingsBtn.setAttribute('data-tooltip-dir', 'top');
    try { settingsBtn.appendChild(this.ui.createIcon('ti-settings')); }
    catch (e) { settingsBtn.textContent = '⚙'; }
    state.settingsCogEl = settingsBtn;

    headerControls.appendChild(settingsBtn);
    headerControls.appendChild(groupModes);
    headerControls.appendChild(tmToggle);
    headerControls.appendChild(filterWrap);
    headerControls.appendChild(sortWrap);

    header.appendChild(headerMain);
    header.appendChild(headerControls);
    headerField.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tlr-body';
    body.dataset.role = 'body';

    const statusSlot = document.createElement('div');
    statusSlot.className = 'tlr-status-slot';
    statusSlot.dataset.role = 'status-slot';

    const propertySlot = document.createElement('div');
    propertySlot.className = 'tlr-section-slot tlr-section-slot-property';
    propertySlot.dataset.role = 'property-slot';

    const linkedSlot = document.createElement('div');
    linkedSlot.className = 'tlr-section-slot tlr-section-slot-linked';
    linkedSlot.dataset.role = 'linked-slot';

    const unlinkedSlot = document.createElement('div');
    unlinkedSlot.className = 'tlr-section-slot tlr-section-slot-unlinked';
    unlinkedSlot.dataset.role = 'unlinked-slot';

    const timeMachineSlot = document.createElement('div');
    timeMachineSlot.className = 'tlr-section-slot tlr-section-slot-tm';
    timeMachineSlot.dataset.role = 'time-machine-slot';
    timeMachineSlot.hidden = true;

    searchRowInner.appendChild(searchWrap);
    searchRow.appendChild(searchRowInner);
    root.appendChild(headerField);
    root.appendChild(searchRow);
    body.appendChild(statusSlot);
    body.appendChild(propertySlot);
    body.appendChild(linkedSlot);
    body.appendChild(unlinkedSlot);
    body.appendChild(timeMachineSlot);
    root.appendChild(body);

    root.addEventListener('click', (e) => this.handleFooterClick(e));

    state.rootEl = root;
    state.footerToggleEl = toggleBtn;
    this.syncFooterCollapsedState(state, this.isFooterCollapsed(state, this.getCollapseMetrics(state.lastResults)));
    root.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);

    state.sortToggleEl = sortToggle;
    state.sortMenuEl = sortMenu;
    state.searchToggleEl = filterToggle;
    state.searchRowEl = searchRow;
    state.searchWrapEl = searchWrap;
    state.searchInputEl = input;
    state.searchHighlightTextEl = highlightText;
    state.searchClearEl = clearBtn;
    state.searchRefreshEl = refreshBtn;
    state.searchAutocompleteEl = autocomplete;
    state.statusSlotEl = statusSlot;
    state.propertySlotEl = propertySlot;
    state.linkedSlotEl = linkedSlot;
    state.unlinkedSlotEl = unlinkedSlot;
    state.timeMachineSlotEl = timeMachineSlot;
    state.renderSectionKeys = null;
    this.syncTimeMachineControl(state);
    this.renderTimeMachineSection(state);
    return root;
  }

  // ---------- Click handling ----------

  handleFooterClick(e) {
    const root = e.currentTarget;
    if (!root) return;

    const actionEl = e.target?.closest?.('[data-action]') || null;
    if (!actionEl) return;

    const action = actionEl.dataset.action || '';
    const panelId = root.dataset.panelId || null;
    if (!panelId) return;

    const state = this._panelStates.get(panelId) || null;

    if (action === 'toggle') {
      if (!state) return;
      const nextCollapsed = !this.isFooterCollapsed(state, this.getCollapseMetrics(state.lastResults));
      this.applyFooterCollapsedPreferenceForRecord(state.recordGuid, nextCollapsed);
      if (!nextCollapsed) {
        const panel = state.panel || this.ui.getActivePanel?.() || null;
        if (panel) this._loadBackrefsDataForPanel(panel, state, 'footer-expanded');
      }
      return;
    }

    if (action === 'toggle-prop-group') {
      const propName = (actionEl.dataset.propName || '').trim();
      if (!propName) return;

      const groupEl = actionEl.closest?.('.tlr-prop-group') || null;
      const isCollapsed = groupEl ? groupEl.classList.contains('tlr-prop-collapsed') : this.isPropGroupCollapsed(propName);
      const nextCollapsed = !isCollapsed;

      this.setPropGroupCollapsed(propName, nextCollapsed);
      if (groupEl) groupEl.classList.toggle('tlr-prop-collapsed', nextCollapsed);
      const propControls = groupEl?.querySelectorAll?.('[data-action="toggle-prop-group"]') || [];
      propControls.forEach((el) => {
        el.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
        if (el.classList?.contains?.('tlr-prop-toggle')) {
          el.title = nextCollapsed ? 'Expand' : 'Collapse';
          el.setAttribute?.('aria-label', nextCollapsed ? 'Expand' : 'Collapse');
        }
      });
      this.syncChevronIcon(groupEl?.querySelector?.('.tlr-prop-caret') || null, nextCollapsed);
      return;
    }

    if (action === 'toggle-record-group') {
      const sectionId = this.normalizeRecordGroupSectionId(actionEl.dataset.groupSectionId);
      const recordGuid = (actionEl.dataset.recordGuid || '').trim();
      const targetRecordGuid = (actionEl.dataset.targetRecordGuid || state?.recordGuid || '').trim();
      if (!sectionId || !recordGuid || !targetRecordGuid) return;

      const groupEl = actionEl.closest?.('.tlr-group') || null;
      const isCollapsed = groupEl ? groupEl.classList.contains('tlr-group-collapsed') : this.isRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid);
      const nextCollapsed = !isCollapsed;

      this.setRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid, nextCollapsed);
      if (groupEl) groupEl.classList.toggle('tlr-group-collapsed', nextCollapsed);
      actionEl.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
      actionEl.title = nextCollapsed ? 'Expand' : 'Collapse';
      actionEl.setAttribute?.('aria-label', nextCollapsed ? 'Expand' : 'Collapse');
      this.syncChevronIcon(actionEl.querySelector?.('.tlr-group-caret') || null, nextCollapsed);
      return;
    }

    if (action === 'expand-record') {
      if (!state) return;
      const guid = (actionEl.dataset.recordGuid || '').trim();
      if (!guid) return;
      e.stopPropagation();
      const groupEl = actionEl.closest?.('.tlr-group') || null;
      if (groupEl) this.toggleRecordExpansion(state, guid, groupEl).catch(() => {});
      return;
    }

    if (action === 'toggle-preview-node') {
      if (!state) return;
      const nodeGuid = (actionEl.dataset.nodeGuid || '').trim();
      const recordGuid = (actionEl.dataset.recordGuid || '').trim();
      if (!nodeGuid || !recordGuid) return;
      const cached = state.recordExpandedState.get(recordGuid);
      if (!cached?.allItems) return;
      if (cached.collapsedNodes.has(nodeGuid)) cached.collapsedNodes.delete(nodeGuid);
      else cached.collapsedNodes.add(nodeGuid);
      const groupEl = actionEl.closest?.('.tlr-group') || null;
      const previewEl = groupEl?.querySelector('.tlr-record-preview') || null;
      if (previewEl) this.renderRecordPreview(previewEl, cached.allItems, recordGuid, cached.collapsedNodes);
      return;
    }

    if (action === 'toggle-section') {
      if (!state) return;
      const sectionId = this.normalizeSectionId(actionEl.dataset.sectionId);
      if (!sectionId) return;

      const nextCollapsed = !this.isSectionCollapsed(state, sectionId, this.getCollapseMetrics(state.lastResults));
      this.applySectionCollapsedPreferenceForRecord(state.recordGuid, sectionId, nextCollapsed);
      return;
    }

    if (action === 'toggle-search') {
      if (!state) return;
      this.setSearchOpen(state, state.searchOpen !== true);
      return;
    }

    if (action === 'toggle-sort-menu') {
      if (!state) return;
      if (state.sortMenuOpen === true) {
        this.setSortMenuOpen(state, false);
      } else {
        this.setSortMenuOpen(state, true);
      }
      return;
    }

    if (action === 'refresh-search') {
      if (!state) return;
      this.scheduleRefreshForPanel(state.panel, { force: true, reason: 'search-refresh' });
      return;
    }

    if (action === 'rebuild-property-index') {
      this.rebuildPropertyIndex({ reason: 'footer-rebuild-index' }).catch(() => {
        // The error state is rendered in the footer.
      });
      return;
    }

    if (action === 'set-sort-by') {
      if (!state) return;
      const nextSortBy = this.normalizeSortBy(actionEl.dataset.sortBy);
      if (!nextSortBy) return;
      this.applySortPreferenceForRecord(state.recordGuid, nextSortBy, state.sortDir);
      this.setSortMenuOpen(state, true);
      return;
    }

    if (action === 'set-sort-dir') {
      if (!state) return;
      const nextSortDir = this.normalizeSortDir(actionEl.dataset.sortDir);
      if (!nextSortDir) return;
      this.applySortPreferenceForRecord(state.recordGuid, state.sortBy, nextSortDir);
      this.setSortMenuOpen(state, true);
      return;
    }

    if (action === 'set-group-by') {
      if (!state) return;
      const requested = this.normalizeGroupBy(actionEl.dataset.groupBy);
      if (!requested) return;
      const current = this.normalizeGroupBy(state.groupBy) || this._defaultGroupBy;
      const fromMenu = Boolean(actionEl.closest?.('.tlr-sort-menu'));
      // Clicking the lit icon toggles grouping back off.
      const nextGroupBy = !fromMenu && requested === current ? 'none' : requested;
      // Date headings would contradict a non-date order, so move the sort with it.
      if (nextGroupBy === 'time' && !this.isDateSortKey(state.sortBy)) {
        this.applySortPreferenceForRecord(state.recordGuid, 'journal_page', state.sortDir);
      }
      this.applyGroupByPreferenceForRecord(state.recordGuid, nextGroupBy);
      if (fromMenu) this.setSortMenuOpen(state, true);
      return;
    }

    if (action === 'toggle-time-machine') {
      if (!state) return;
      e.stopPropagation();
      this.toggleTimeMachine(state).catch(() => {});
      return;
    }

    if (action === 'open-settings') {
      e.stopPropagation();
      e.preventDefault();
      this.openBackreferencesSettingsMenu(actionEl);
      return;
    }

    if (action === 'clear-search') {
      if (!state) return;
      const q = (state.searchQuery || '').trim();
      if (q) {
        state.searchQuery = '';
        if (state.searchInputEl) state.searchInputEl.value = '';
        this.handleSearchQueryChanged(state, { immediate: true, keepFocus: true });
      } else {
        state.searchInputEl?.blur?.();
      }
      return;
    }

    if (
      action === 'toggle-context-more' ||
      action === 'toggle-context-above' ||
      action === 'toggle-context-below'
    ) {
      if (!state) return;
      this.handleLinkedContextAction(
        state,
        action,
        actionEl.dataset.lineGuid || null
      ).catch(() => {
        // ignore
      });
      return;
    }

    if (action === 'link-unlinked') {
      if (!state) return;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!lineGuid) return;
      this.setSortMenuOpen(state, false);
      this.linkUnlinkedReference(state, lineGuid).catch(() => {
        // ignore
      });
      return;
    }

    const panel = state?.panel || null;
    if (!panel) return;

    if (action === 'open-here' || action === 'open-side') {
      const guid = actionEl.dataset.recordGuid || null;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!guid) return;
      e.stopPropagation();
      this.setSortMenuOpen(state, false);
      this.openRecord(
        panel,
        guid,
        lineGuid || null,
        action === 'open-side' ? { openInSide: true } : { openInSide: false }
      );
      return;
    }

    if (action === 'open-record') {
      const guid = actionEl.dataset.recordGuid || null;
      if (!guid) return;
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, null, e);
      return;
    }

    if (action === 'open-line') {
      const guid = actionEl.dataset.recordGuid || null;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!guid) return;
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, lineGuid || null, e);
      return;
    }

    if (action === 'open-ref') {
      const guid = actionEl.dataset.refGuid || null;
      if (!guid) return;
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, null, e);
      return;
    }
  }

  wantsSidePanelOpen(e) {
    if (!e || typeof e !== 'object') return false;
    if (e.openInSide === true) return true;
    if (e.openInSide === false) return false;
    return !!(e.metaKey || e.ctrlKey);
  }

  navigatePanelToRecord(panel, recordGuid, lineGuid, workspaceGuid) {
    if (!lineGuid) {
      panel.navigateTo({
        type: 'edit_panel',
        rootId: recordGuid,
        subId: null,
        workspaceGuid
      });
      return Promise.resolve(true);
    }

    try {
      const result = panel.navigateTo({
        itemGuid: lineGuid,
        highlight: true
      });

      if (result && typeof result.then === 'function') {
        return result.then((found) => found !== false);
      }

      return Promise.resolve(result !== false);
    } catch (_err) {
      return Promise.resolve(false);
    }
  }

  waitForPanelNavigationFrame() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  waitForPanelRecord(panel, recordGuid, timeoutMs = 1800) {
    return new Promise((resolve) => {
      const startedAt = Date.now();

      const check = () => {
        const activeRecordGuid = panel?.getActiveRecord?.()?.guid || null;
        if (activeRecordGuid && (!recordGuid || activeRecordGuid === recordGuid)) {
          resolve(true);
          return;
        }

        if ((Date.now() - startedAt) >= timeoutMs) {
          resolve(false);
          return;
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(check);
          return;
        }

        setTimeout(check, 16);
      };

      check();
    });
  }

  async openRecord(panel, recordGuid, lineGuid, e) {
    const workspaceGuid = this.getWorkspaceGuid?.() || null;
    if (!workspaceGuid) return;

    const openInNew = this.wantsSidePanelOpen(e);

    if (openInNew) {
      try {
        const newPanel = await this.ui.createPanel({ afterPanel: panel });
        if (!newPanel) return;
        this.ui.setActivePanel(newPanel);
        await this.waitForPanelNavigationFrame();
        await this.navigatePanelToRecord(newPanel, recordGuid, null, workspaceGuid);
        await this.waitForPanelRecord(newPanel, recordGuid);

        if (lineGuid) {
          await this.navigatePanelToRecord(newPanel, recordGuid, lineGuid, workspaceGuid);
          await this.waitForPanelNavigationFrame();
          await this.waitForPanelNavigationFrame();
        }
      } catch (_err) {
        // ignore
      }
      return;
    }

    this.navigatePanelToRecord(panel, recordGuid, lineGuid || null, workspaceGuid);
    this.ui.setActivePanel(panel);
  }

  panelNavSvg(kind) {
    const n = 14;
    if (kind === 'side') {
      return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5" opacity="0.35"/><path d="M14 5v14"/><path d="M7 12h4"/><path d="m9 10 2 2-2 2"/></svg>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>';
  }

  buildPanelNavButton(action, recordGuid, lineGuid, label, kind) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-panel-nav-btn button-none button-small button-minimal-hover tooltip';
    btn.dataset.action = action;
    btn.dataset.recordGuid = recordGuid || '';
    if (lineGuid) btn.dataset.lineGuid = lineGuid;
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.setAttribute('data-tooltip', label);
    btn.setAttribute('data-tooltip-dir', 'top');

    const wrap = document.createElement('span');
    wrap.className = 'tlr-panel-nav-icon';
    wrap.innerHTML = this.panelNavSvg(kind);
    btn.appendChild(wrap);

    return btn;
  }

  buildPanelNavActions(recordGuid, lineGuid = '') {
    const wrap = document.createElement('div');
    wrap.className = 'tlr-panel-nav-actions';
    wrap.appendChild(this.buildPanelNavButton('open-here', recordGuid, lineGuid, 'Open in this panel', 'here'));
    wrap.appendChild(this.buildPanelNavButton('open-side', recordGuid, lineGuid, 'Open in side panel', 'side'));
    return wrap;
  }

  applyCollapsedState(root, collapsed) {
    if (!root) return;
    root.classList.toggle('tlr-collapsed', collapsed === true);
  }

  createDefaultSectionCollapsedState() {
    return {};
  }

  cloneSectionCollapsedState(sectionCollapsed) {
    const out = {};
    for (const id of ['property', 'linked', 'unlinked']) {
      if (typeof sectionCollapsed?.[id] === 'boolean') out[id] = sectionCollapsed[id];
    }
    return out;
  }

  getCollapseMetrics(results) {
    if (!results || typeof results !== 'object') {
      return {
        ready: false,
        propertyCount: 0,
        linkedCount: 0,
        unlinkedCount: 0,
        propertyError: false,
        linkedError: false,
        unlinkedError: false,
        propertyIndexPending: false,
        propertyIndexError: false,
        unlinkedDeferred: false
      };
    }

    const propertyGroups = Array.isArray(results.propertyGroups) ? results.propertyGroups : [];
    const linkedGroups = Array.isArray(results.linkedGroups) ? results.linkedGroups : [];
    const unlinkedGroups = Array.isArray(results.unlinkedGroups) ? results.unlinkedGroups : [];

    return {
      ready: true,
      propertyCount: propertyGroups.reduce((n, group) => n + (group?.records?.length || 0), 0),
      linkedCount: this.countLinkedReferences(linkedGroups),
      unlinkedCount: this.countLinkedReferences(unlinkedGroups),
      propertyError: Boolean(results.propertyError),
      linkedError: Boolean(results.linkedError),
      unlinkedError: Boolean(results.unlinkedError),
      propertyIndexPending: results.propertyIndexStatus === 'idle' || results.propertyIndexStatus === 'indexing',
      propertyIndexError: results.propertyIndexStatus === 'error',
      unlinkedDeferred: results.unlinkedDeferred === true
    };
  }

  getDefaultFooterCollapsed(metrics) {
    if (!metrics?.ready) return this.preferDeferredHeavyWork();
    if (metrics.propertyError || metrics.linkedError || metrics.propertyIndexPending || metrics.propertyIndexError) return false;
    return (metrics.propertyCount + metrics.linkedCount) === 0;
  }

  isFooterCollapsed(state, metrics) {
    if (state?.footerCollapsed === true || state?.footerCollapsed === false) {
      return state.footerCollapsed;
    }
    return this.getDefaultFooterCollapsed(metrics);
  }

  syncFooterCollapsedState(state, collapsed) {
    if (!state?.rootEl) return;
    const nextCollapsed = collapsed === true;
    this.applyCollapsedState(state.rootEl, nextCollapsed);
    if (state.searchRowEl) {
      state.searchRowEl.style.display = state.searchOpen === true && nextCollapsed !== true ? 'block' : 'none';
    }

    const btn = state.footerToggleEl || state.rootEl.querySelector?.('[data-action="toggle"]') || null;
    if (!btn) return;
    btn.title = nextCollapsed ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-label', nextCollapsed ? 'Expand' : 'Collapse');
    btn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
    this.syncChevronIcon(btn.querySelector?.('.tlr-toggle-caret') || null, nextCollapsed);
  }

  normalizeSectionId(sectionId) {
    return sectionId === 'property' || sectionId === 'linked' || sectionId === 'unlinked'
      ? sectionId
      : null;
  }

  getDefaultSectionCollapsed(sectionId, metrics) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return false;
    if (!metrics?.ready) return false;
    const isTrulyEmpty = !metrics.propertyError
      && !metrics.linkedError
      && !metrics.unlinkedError
      && !metrics.propertyIndexPending
      && !metrics.propertyIndexError
      && metrics.propertyCount === 0
      && metrics.linkedCount === 0
      && metrics.unlinkedCount === 0;
    if (isTrulyEmpty) {
      if (id === 'unlinked') return metrics.unlinkedDeferred === true;
      return false;
    }
    if (id === 'unlinked') return true;
    if (id === 'property') return (metrics.propertyError || metrics.propertyIndexPending || metrics.propertyIndexError)
      ? false
      : metrics.propertyCount === 0;
    if (id === 'linked') return metrics.linkedError ? false : metrics.linkedCount === 0;
    return false;
  }

  isSectionCollapsed(state, sectionId, metrics) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return false;
    const current = state?.sectionCollapsed?.[id];
    if (typeof current === 'boolean') return current;
    return this.getDefaultSectionCollapsed(id, metrics);
  }

  setSectionCollapsed(state, sectionId, collapsed) {
    if (!state) return;
    const id = this.normalizeSectionId(sectionId);
    if (!id) return;
    if (!state.sectionCollapsed || typeof state.sectionCollapsed !== 'object') {
      state.sectionCollapsed = this.createDefaultSectionCollapsedState();
    }
    state.sectionCollapsed[id] = collapsed === true;
  }

  getSearchMode(rawQuery) {
    const query = (rawQuery || '').trim();
    if (!query) return 'none';
    if (query.includes('@') || query.includes('#') || query.includes('"')) return 'query';
    if (query.includes('(') || query.includes(')')) return 'query';
    if (query.includes('&&') || query.includes('||')) return 'query';
    if (/\b(?:AND|OR|NOT)\b/.test(query)) return 'query';
    return 'text';
  }

  getQueryAutocompleteCatalogSync() {
    return this._queryAutocompleteCatalog || {
      collections: [],
      users: []
    };
  }

  async ensureQueryAutocompleteCatalog() {
    if (this._queryAutocompleteCatalog) return this._queryAutocompleteCatalog;
    if (this._queryAutocompleteCatalogPromise) return this._queryAutocompleteCatalogPromise;

    this._queryAutocompleteCatalogPromise = (async () => {
      let collections = [];
      try {
        collections = await this.data.getAllCollections();
      } catch (e) {
        collections = [];
      }

      const catalogCollections = [];
      for (const collection of collections || []) {
        const name = (collection?.getName?.() || '').trim();
        const guid = (collection?.getGuid?.() || '').trim();
        if (!name || !guid) continue;

        const config = collection?.getConfiguration?.() || null;
        const fields = [];
        for (const field of config?.fields || []) {
          const label = (field?.label || '').trim();
          if (!label || field?.active === false) continue;
          fields.push({
            id: (field?.id || '').trim(),
            label,
            type: (field?.type || '').trim()
          });
        }

        fields.sort((a, b) => a.label.localeCompare(b.label));
        catalogCollections.push({ name, guid, fields });
      }

      catalogCollections.sort((a, b) => a.name.localeCompare(b.name));

      const catalogUsers = [];
      for (const user of this.data.getActiveUsers?.() || []) {
        const name = (user?.getDisplayName?.() || '').trim();
        const guid = (user?.guid || '').trim();
        if (!name || !guid) continue;
        catalogUsers.push({ name, guid });
      }

      catalogUsers.sort((a, b) => a.name.localeCompare(b.name));

      this._queryAutocompleteCatalog = {
        collections: catalogCollections,
        users: catalogUsers
      };
      this._queryAutocompleteCatalogPromise = null;
      return this._queryAutocompleteCatalog;
    })();

    return this._queryAutocompleteCatalogPromise;
  }

  quoteQueryIdentifier(name) {
    const value = String(name || '');
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  formatQueryIdentifier(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    return /^[A-Za-z0-9_]+$/.test(value) ? value : this.quoteQueryIdentifier(value);
  }

  getBuiltInQueryKeys() {
    return Array.from(this._queryBuiltInKeys || []);
  }

  getStandaloneQueryFilters() {
    return Array.from(this._queryStandaloneFilters || []);
  }

  isBuiltInQueryKey(name) {
    const value = String(name || '').trim().toLowerCase();
    return value ? this._queryBuiltInKeys.includes(value) : false;
  }

  isQueryOperatorToken(token) {
    return token === '=' || token === '!=' || token === '<' || token === '<=' || token === '>' || token === '>=';
  }

  buildSearchAutocompleteItem({ label, icon, detail, insertText, replaceStart, replaceEnd } = {}) {
    return {
      label: String(label || ''),
      icon: icon || null,
      detail: String(detail || ''),
      insertText: String(insertText || ''),
      replaceStart: Number.isFinite(replaceStart) ? replaceStart : 0,
      replaceEnd: Number.isFinite(replaceEnd) ? replaceEnd : 0
    };
  }

  dedupeSearchAutocompleteItems(items) {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      const key = `${item?.label || ''}\n${item?.detail || ''}\n${item?.insertText || ''}\n${item?.replaceStart || 0}\n${item?.replaceEnd || 0}`;
      if (!item?.label || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  parseQueryFieldContext(query, caret) {
    const before = String(query || '').slice(0, caret);
    const match = before.match(/(?:^|[\s(])@(?:("(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+))\.((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_]*)$/);
    if (!match) return null;
    const collectionToken = match[1] || '';
    const fieldToken = match[2] || '';
    const replaceEnd = caret;
    const replaceStart = replaceEnd - fieldToken.length;
    const rawCollection = collectionToken.startsWith('"') && collectionToken.endsWith('"')
      ? collectionToken.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : collectionToken;
    const normalizedCollection = rawCollection.trim().toLowerCase();
    return {
      collectionToken,
      collectionName: rawCollection,
      normalizedCollection,
      fieldToken,
      fieldPrefix: fieldToken.startsWith('"') ? fieldToken.slice(1).toLowerCase() : fieldToken.toLowerCase(),
      replaceStart,
      replaceEnd
    };
  }

  parseQueryOperatorContext(query, caret) {
    const before = String(query || '').slice(0, caret);
    const match = before.match(/(?:^|[\s(])@(?:("(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)(?:\.((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_]+))?)\s*$/);
    if (!match) return null;

    const keyToken = match[1] || '';
    const fieldToken = match[2] || '';
    const rawKey = keyToken.startsWith('"') && keyToken.endsWith('"')
      ? keyToken.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : keyToken;
    if (!fieldToken && !this.isBuiltInQueryKey(rawKey)) return null;

    return {
      replaceStart: caret,
      replaceEnd: caret
    };
  }

  parseQueryTokenContext(query, caret) {
    const before = String(query || '').slice(0, caret);
    const match = before.match(/(?:^|[\s(])@((?:"(?:[^"\\]|\\.)*")|[^\s()]*)$/);
    if (!match) return null;
    const token = match[1] || '';
    if (token.includes('.')) return null;
    const replaceEnd = caret;
    const replaceStart = replaceEnd - token.length;
    const unquoted = token.startsWith('"') ? token.slice(1) : token;
    return {
      token,
      prefix: unquoted.toLowerCase(),
      replaceStart,
      replaceEnd,
      quoted: token.startsWith('"')
    };
  }

  getSearchAutocompleteItems(query, caret, catalog) {
    const items = [];
    const fieldContext = this.parseQueryFieldContext(query, caret);
    if (fieldContext) {
      const collection = (catalog?.collections || []).find((entry) => entry.name.trim().toLowerCase() === fieldContext.normalizedCollection) || null;
      const exactFieldMatch = (collection?.fields || []).some((field) => field.label.trim().toLowerCase() === fieldContext.fieldPrefix.trim().toLowerCase());
      const isOpenQuotedField = fieldContext.fieldToken.startsWith('"') && !fieldContext.fieldToken.endsWith('"');
      if (fieldContext.fieldToken && exactFieldMatch && !isOpenQuotedField) {
        const operatorItems = [];
        for (const operator of ['=', '!=', '<=', '>=', '<', '>']) {
          operatorItems.push(this.buildSearchAutocompleteItem({
            label: operator,
            icon: 'ti-math-symbols',
            detail: 'Operator',
            insertText: ` ${operator} `,
            replaceStart: caret,
            replaceEnd: caret
          }));
        }
        return operatorItems;
      }
      for (const field of collection?.fields || []) {
        if (fieldContext.fieldPrefix && !field.label.toLowerCase().includes(fieldContext.fieldPrefix)) continue;
        items.push(this.buildSearchAutocompleteItem({
          label: field.label,
          icon: 'ti-columns-2',
          detail: field.type || 'Field',
          insertText: this.formatQueryIdentifier(field.label),
          replaceStart: fieldContext.replaceStart,
          replaceEnd: fieldContext.replaceEnd
        }));
      }
      return this.dedupeSearchAutocompleteItems(items);
    }

    const operatorContext = this.parseQueryOperatorContext(query, caret);
    if (operatorContext) {
      for (const operator of ['=', '!=', '<=', '>=', '<', '>']) {
        items.push(this.buildSearchAutocompleteItem({
          label: operator,
          icon: 'ti-math-symbols',
          detail: 'Operator',
          insertText: ` ${operator} `,
          replaceStart: operatorContext.replaceStart,
          replaceEnd: operatorContext.replaceEnd
        }));
      }
      return items;
    }

    const tokenContext = this.parseQueryTokenContext(query, caret);
    if (!tokenContext) return [];

    for (const keyword of this.getStandaloneQueryFilters()) {
      if (tokenContext.prefix && !keyword.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${keyword}`,
        icon: 'ti-at',
        detail: 'Filter',
        insertText: keyword,
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    for (const key of this.getBuiltInQueryKeys()) {
      if (tokenContext.prefix && !key.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${key}`,
        icon: 'ti-key',
        detail: 'Built-in key',
        insertText: key,
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    for (const user of catalog?.users || []) {
      if (tokenContext.prefix && !user.name.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${user.name}`,
        icon: 'ti-user',
        detail: 'User',
        insertText: this.formatQueryIdentifier(user.name),
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    for (const collection of catalog?.collections || []) {
      if (tokenContext.prefix && !collection.name.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${collection.name}`,
        icon: 'ti-database',
        detail: 'Collection',
        insertText: this.formatQueryIdentifier(collection.name),
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    return this.dedupeSearchAutocompleteItems(items).slice(0, 12);
  }

  renderSearchAutocomplete(state) {
    const menu = state?.searchAutocompleteEl || null;
    if (!menu) return;

    menu.innerHTML = '';
    const items = Array.isArray(state.searchAutocompleteItems) ? state.searchAutocompleteItems : [];
    if (state.searchAutocompleteOpen !== true || items.length === 0) return;

    const list = document.createElement('div');
    list.className = 'autocomplete clickable';
    const scroll = document.createElement('div');
    scroll.className = 'vscroll-node';
    const content = document.createElement('div');
    content.className = 'vcontent';
    const scrollbar = document.createElement('div');
    scrollbar.className = 'vscrollbar scrollbar';
    const thumb = document.createElement('div');
    thumb.className = 'vscrollbar-thumb scrollbar-thumb clickable';
    thumb.innerHTML = '&nbsp;';

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'autocomplete--option';
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      if (index === state.searchAutocompleteSelectedIndex) {
        row.classList.add('autocomplete--option-selected');
      }

      const iconWrap = document.createElement('span');
      iconWrap.className = 'autocomplete--option-icon';
      if (item.icon) {
        try {
          iconWrap.appendChild(this.ui.createIcon(item.icon));
        } catch (e) {
          iconWrap.textContent = '@';
        }
      }

      const label = document.createElement('span');
      label.className = 'autocomplete--option-label';
      label.textContent = item.label;

      const right = document.createElement('span');
      right.className = 'autocomplete--option-right';
      right.textContent = item.detail || '';

      row.appendChild(iconWrap);
      row.appendChild(label);
      row.appendChild(right);

      row.addEventListener('mouseenter', () => {
        if (state.searchAutocompleteSelectedIndex === index) return;
        state.searchAutocompleteSelectedIndex = index;
        this.syncRenderedSearchAutocompleteSelection(state);
      });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      row.addEventListener('click', (e) => {
        e.preventDefault();
        state.searchAutocompleteSelectedIndex = index;
        this.applySelectedSearchAutocompleteItem(state);
      });

      content.appendChild(row);
    });

    scroll.appendChild(content);
    scroll.addEventListener('scroll', () => {
      this.syncSearchAutocompleteScrollbar(state);
    });

    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startY = e.clientY;
      const startScrollTop = scroll.scrollTop;
      const onMouseMove = (moveEvent) => {
        const trackHeight = scrollbar.clientHeight || scroll.clientHeight || 0;
        const thumbHeight = thumb.clientHeight || 0;
        const maxThumbTop = Math.max(1, trackHeight - thumbHeight);
        const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (maxScrollTop <= 0) return;
        const deltaRatio = (moveEvent.clientY - startY) / maxThumbTop;
        scroll.scrollTop = Math.max(0, Math.min(maxScrollTop, startScrollTop + (deltaRatio * maxScrollTop)));
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
      };

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    });

    list.appendChild(scroll);
    scrollbar.appendChild(thumb);
    list.appendChild(scrollbar);
    menu.appendChild(list);

    const sync = () => {
      this.scrollSelectedSearchAutocompleteItemIntoView(state);
      this.syncSearchAutocompleteScrollbar(state);
    };
    sync();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(sync);
    } else {
      setTimeout(sync, 0);
    }
  }

  scrollSelectedSearchAutocompleteItemIntoView(state) {
    const menu = state?.searchAutocompleteEl || null;
    const scroll = menu?.querySelector?.('.vscroll-node') || null;
    const selected = menu?.querySelector?.(`.autocomplete--option[data-index="${state?.searchAutocompleteSelectedIndex || 0}"]`) || null;
    if (!scroll || !selected) return;

    const rowTop = selected.offsetTop;
    const rowBottom = rowTop + selected.offsetHeight;
    const viewportTop = scroll.scrollTop;
    const viewportBottom = viewportTop + scroll.clientHeight;
    if (rowTop < viewportTop) {
      scroll.scrollTop = rowTop;
    } else if (rowBottom > viewportBottom) {
      scroll.scrollTop = rowBottom - scroll.clientHeight;
    }
  }

  syncRenderedSearchAutocompleteSelection(state) {
    const menu = state?.searchAutocompleteEl || null;
    if (!menu) return;
    const selectedIndex = state?.searchAutocompleteSelectedIndex || 0;
    const rows = menu.querySelectorAll?.('.autocomplete--option[data-index]') || [];
    rows.forEach((row) => {
      const rowIndex = Number(row.dataset.index);
      row.classList.toggle('autocomplete--option-selected', rowIndex === selectedIndex);
    });
  }

  syncSearchAutocompleteScrollbar(state) {
    const menu = state?.searchAutocompleteEl || null;
    const scroll = menu?.querySelector?.('.vscroll-node') || null;
    const scrollbar = menu?.querySelector?.('.vscrollbar') || null;
    const thumb = menu?.querySelector?.('.vscrollbar-thumb') || null;
    if (!scroll || !scrollbar || !thumb) return;

    const viewportHeight = scroll.clientHeight || 0;
    const scrollHeight = scroll.scrollHeight || 0;
    const trackHeight = scrollbar.clientHeight || viewportHeight;
    if (!viewportHeight || !scrollHeight || !trackHeight || scrollHeight <= viewportHeight + 1) {
      scrollbar.classList.remove('has-thumb');
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0px)';
      return;
    }

    const thumbHeight = Math.max(16, Math.round((viewportHeight / scrollHeight) * trackHeight));
    const maxScrollTop = Math.max(1, scrollHeight - viewportHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxThumbTop * (scroll.scrollTop / maxScrollTop);

    scrollbar.classList.add('has-thumb');
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  syncSearchAutocompleteControlState(state) {
    if (!state?.rootEl) return;
    state.rootEl.classList.toggle('tlr-search-autocomplete-open', state.searchAutocompleteOpen === true);
  }

  clearPointerDismissHandler(state, handlerKey) {
    const key = typeof handlerKey === 'string' ? handlerKey.trim() : '';
    if (!state || !key || !state[key]) return;
    try {
      document.removeEventListener('pointerdown', state[key], true);
      document.removeEventListener('mousedown', state[key], true);
    } catch (e) {
      // ignore
    }
    state[key] = null;
  }

  setPointerDismissHandler(state, handlerKey, handler) {
    const key = typeof handlerKey === 'string' ? handlerKey.trim() : '';
    if (!state || !key || typeof handler !== 'function') return;
    this.clearPointerDismissHandler(state, key);
    state[key] = handler;
    try {
      document.addEventListener('pointerdown', handler, true);
      document.addEventListener('mousedown', handler, true);
    } catch (e) {
      // ignore
    }
  }

  setSearchAutocompleteOpen(state, open) {
    if (!state) return;
    state.searchAutocompleteOpen = open === true && (state.searchAutocompleteItems?.length || 0) > 0;

    this.clearPointerDismissHandler(state, 'searchAutocompleteDismissHandler');

    this.syncSearchAutocompleteControlState(state);
    this.renderSearchAutocomplete(state);

    if (state.searchAutocompleteOpen !== true) return;

    const onOutsideMouseDown = (ev) => {
      const menu = state.searchAutocompleteEl || null;
      const input = state.searchInputEl || null;
      const target = ev.target;
      if (!menu || !menu.isConnected || !input || !input.isConnected) {
        this.setSearchAutocompleteOpen(state, false);
        return;
      }
      if (menu.contains(target)) return;
      if (input.contains?.(target)) return;
      this.setSearchAutocompleteOpen(state, false);
    };

    this.setPointerDismissHandler(state, 'searchAutocompleteDismissHandler', onOutsideMouseDown);
  }

  moveSearchAutocompleteSelection(state, delta) {
    const items = state?.searchAutocompleteItems || [];
    if (!state || state.searchAutocompleteOpen !== true || items.length === 0) return;
    const lastIndex = items.length - 1;
    const next = Math.max(0, Math.min(lastIndex, (state.searchAutocompleteSelectedIndex || 0) + delta));
    if (next === state.searchAutocompleteSelectedIndex) return;
    state.searchAutocompleteSelectedIndex = next;
    this.renderSearchAutocomplete(state);
  }

  applySelectedSearchAutocompleteItem(state) {
    const items = state?.searchAutocompleteItems || [];
    const item = items[state?.searchAutocompleteSelectedIndex || 0] || null;
    const input = state?.searchInputEl || null;
    if (!state || !item || !input) return;

    const value = state.searchQuery || '';
    const start = Math.max(0, Math.min(value.length, item.replaceStart || 0));
    const end = Math.max(start, Math.min(value.length, item.replaceEnd || 0));
    const nextValue = `${value.slice(0, start)}${item.insertText}${value.slice(end)}`;
    const caret = start + item.insertText.length;

    state.searchQuery = nextValue;
    input.value = nextValue;
    this.setSearchAutocompleteOpen(state, false);
    this.handleSearchQueryChanged(state, { immediate: false, keepFocus: true });

    setTimeout(() => {
      try {
        input.focus();
        input.setSelectionRange(caret, caret);
      } catch (e) {
        // ignore
      }
      this.updateSearchAutocomplete(state);
    }, 0);
  }

  updateSearchAutocomplete(state) {
    if (!state?.searchInputEl) return;

    const input = state.searchInputEl;
    const query = state.searchQuery || '';
    const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : query.length;
    if (document.activeElement !== input || caret !== query.length) {
      state.searchAutocompleteItems = [];
      state.searchAutocompleteSelectedIndex = 0;
      this.setSearchAutocompleteOpen(state, false);
      return;
    }

    const catalog = this.getQueryAutocompleteCatalogSync();
    const items = this.getSearchAutocompleteItems(query, caret, catalog);
    state.searchAutocompleteItems = items;
    state.searchAutocompleteSelectedIndex = Math.max(0, Math.min(items.length - 1, state.searchAutocompleteSelectedIndex || 0));
    this.setSearchAutocompleteOpen(state, items.length > 0);

    const requestSeq = (state.searchAutocompleteRequestSeq || 0) + 1;
    state.searchAutocompleteRequestSeq = requestSeq;
    this.ensureQueryAutocompleteCatalog()
      .then(() => {
        const liveState = this._panelStates.get(state.panelId) || null;
        if (!liveState || liveState.searchAutocompleteRequestSeq !== requestSeq) return;
        if (document.activeElement !== liveState.searchInputEl) return;
        const liveQuery = liveState.searchQuery || '';
        const liveCaret = Number.isFinite(liveState.searchInputEl?.selectionStart)
          ? liveState.searchInputEl.selectionStart
          : liveQuery.length;
        const liveItems = this.getSearchAutocompleteItems(liveQuery, liveCaret, this.getQueryAutocompleteCatalogSync());
        liveState.searchAutocompleteItems = liveItems;
        liveState.searchAutocompleteSelectedIndex = Math.max(0, Math.min(liveItems.length - 1, liveState.searchAutocompleteSelectedIndex || 0));
        this.setSearchAutocompleteOpen(liveState, liveItems.length > 0);
      })
      .catch(() => {
        // ignore
      });
  }

  isIncompleteQueryDraft(rawQuery) {
    const query = (rawQuery || '').trim();
    if (this.getSearchMode(query) !== 'query') return false;
    if (/(?:^|[\s(])@$/.test(query)) return true;
    if (/(?:^|[\s(])@"(?:[^"\\]|\\.)*$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\.$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\.(?:"(?:[^"\\]|\\.)*|[A-Za-z0-9_]*)$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\s*$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:created_at|modified_at|created_by|modified_by|text|type|date|due|time|mention|scheduled|hashtag|link|collection|guid|pguid|rguid|backref|linkto)\s*$/i.test(query)) {
      return true;
    }
    if (/(?:^|[\s(])@(?:(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)(?:\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+))?)\s*(?:=|!=|<=|>=|<|>)\s*$/i.test(query)) {
      return true;
    }
    return false;
  }

  createQueryFilterState(query, { loading, ready, error, includesUnlinked, matchedRecordGuids, matchedLineGuids, matchedLineRecordGuids } = {}) {
    return {
      query: (query || '').trim(),
      loading: loading === true,
      ready: ready === true,
      error: typeof error === 'string' ? error : '',
      includesUnlinked: includesUnlinked === true,
      matchedRecordGuids: matchedRecordGuids instanceof Set ? matchedRecordGuids : new Set(),
      matchedLineGuids: matchedLineGuids instanceof Set ? matchedLineGuids : new Set(),
      matchedLineRecordGuids: matchedLineRecordGuids instanceof Set ? matchedLineRecordGuids : new Set()
    };
  }

  getQueryFilterState(state, query) {
    const current = state?.queryFilterState || null;
    const normalizedQuery = (query || '').trim();
    if (!current) return null;
    if ((current.query || '') !== normalizedQuery) return null;
    return current;
  }

  clearQueryFilterState(state) {
    if (!state) return;
    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }
    state.queryFilterState = null;
  }

  handleSearchQueryChanged(state, { immediate, keepFocus } = {}) {
    if (!state) return;
    this.syncSearchControlState(state);
    this.syncScopedQueryWithCurrentInput(state, { immediate: immediate === true, reason: 'input' });
    this.renderFromCache(state);
    this.updateSearchAutocomplete(state);

    if (keepFocus === true && state.searchInputEl) {
      setTimeout(() => {
        try {
          state.searchInputEl?.focus?.();
        } catch (e) {
          // ignore
        }
      }, 0);
    }
  }

  syncScopedQueryWithCurrentInput(state, { immediate, reason } = {}) {
    if (!state) return;
    const query = (state.searchQuery || '').trim();
    if (this.getSearchMode(query) !== 'query' || this.isIncompleteQueryDraft(query)) {
      this.clearQueryFilterState(state);
      return;
    }
    this.scheduleQueryFilterRefresh(state, { immediate: immediate === true, reason: reason || 'sync' });
  }

  shouldIncludeUnlinkedInQueryScope(state, results) {
    if (!state || !results) return false;
    if (this.isSectionCollapsed(state, 'unlinked')) return false;
    if (results.unlinkedDeferred === true) return false;
    if (results.unlinkedLoading === true) return false;
    return true;
  }

  collectQueryScopeRecordGuids(results, { includeUnlinked } = {}) {
    const out = [];
    const seen = new Set();

    const add = (record) => {
      const guid = (record?.guid || '').trim();
      if (!guid || seen.has(guid)) return;
      seen.add(guid);
      out.push(guid);
    };

    for (const group of results?.propertyGroups || []) {
      for (const record of group?.records || []) add(record);
    }
    for (const group of results?.linkedGroups || []) add(group?.record || null);
    if (includeUnlinked === true) {
      for (const group of results?.unlinkedGroups || []) add(group?.record || null);
    }

    return out;
  }

  filterPropertyGroups(groups, predicate) {
    const match = typeof predicate === 'function' ? predicate : null;
    if (!match) return [];

    const out = [];
    for (const group of groups || []) {
      const propertyName = (group?.propertyName || '').trim();
      if (!propertyName) continue;
      const records = (group?.records || []).filter((record) => match(record, group));
      if (records.length === 0) continue;
      out.push({ propertyName, records });
    }
    return out;
  }

  filterLineGroups(groups, predicate) {
    const match = typeof predicate === 'function' ? predicate : null;
    if (!match) return [];

    const out = [];
    for (const group of groups || []) {
      const record = group?.record || null;
      if (!record?.guid) continue;
      const lines = (group?.lines || []).filter((line) => match(line, record, group));
      if (lines.length === 0) continue;
      out.push({ record, lines });
    }
    return out;
  }

  scheduleQueryFilterRefresh(state, { immediate, reason } = {}) {
    if (!state) return;

    const query = (state.searchQuery || '').trim();
    if (this.getSearchMode(query) !== 'query' || this.isIncompleteQueryDraft(query)) {
      this.clearQueryFilterState(state);
      return;
    }

    const previous = this.getQueryFilterState(state, query);
    state.queryFilterState = previous
      ? this.createQueryFilterState(query, {
          loading: true,
          ready: previous.ready === true,
          error: '',
          includesUnlinked: previous.includesUnlinked === true,
          matchedRecordGuids: previous.matchedRecordGuids,
          matchedLineGuids: previous.matchedLineGuids,
          matchedLineRecordGuids: previous.matchedLineRecordGuids
        })
      : this.createQueryFilterState(query, { loading: true });

    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }

    const seq = (state.queryFilterSeq || 0) + 1;
    state.queryFilterSeq = seq;
    const delay = immediate === true ? 0 : this._queryFilterDebounceMs;
    state.queryFilterTimer = setTimeout(() => {
      state.queryFilterTimer = null;
      this.refreshScopedQueryFilter(state.panelId, seq, { reason: reason || 'scheduled-query-filter' }).catch(() => {
        // ignore
      });
    }, delay);
  }

  async refreshScopedQueryFilter(panelId, seq, { reason } = {}) {
    const state = this._panelStates.get(panelId) || null;
    if (!state) return;
    if (state.queryFilterSeq !== seq) return;

    const results = state.lastResults || null;
    const query = (state.searchQuery || '').trim();
    if (!results || this.getSearchMode(query) !== 'query' || this.isIncompleteQueryDraft(query)) {
      this.clearQueryFilterState(state);
      this.renderFromCache(state);
      return;
    }

    const includeUnlinked = this.shouldIncludeUnlinkedInQueryScope(state, results);
    const recordGuids = this.collectQueryScopeRecordGuids(results, { includeUnlinked });
    if (recordGuids.length === 0) {
      if (!this._panelStates.has(panelId)) return;
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: true,
        includesUnlinked: includeUnlinked
      });
      this.renderFromCache(state);
      return;
    }

    let result = null;
    let error = '';
    try {
      const { queryFilterMaxResults } = this.getRefreshConfig();
      result = await this.data.searchByQuery(query, queryFilterMaxResults);
      if (typeof result?.error === 'string' && result.error.trim()) error = result.error.trim();
    } catch (e) {
      error = 'Could not apply query filter.';
    }

    if (!this._panelStates.has(panelId)) return;
    if (state.queryFilterSeq !== seq) return;
    if ((state.searchQuery || '').trim() !== query) return;

    const latestResults = state.lastResults || results;
    const latestIncludesUnlinked = this.shouldIncludeUnlinkedInQueryScope(state, latestResults);
    const latestScopedRecordGuids = new Set(
      this.collectQueryScopeRecordGuids(latestResults, { includeUnlinked: latestIncludesUnlinked })
    );

    if (latestScopedRecordGuids.size === 0) {
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: true,
        includesUnlinked: latestIncludesUnlinked
      });
      this.renderFromCache(state);
      return;
    }

    const previous = this.getQueryFilterState(state, query);
    if (error) {
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: previous?.ready === true,
        error,
        includesUnlinked: latestIncludesUnlinked,
        matchedRecordGuids: previous?.matchedRecordGuids,
        matchedLineGuids: previous?.matchedLineGuids,
        matchedLineRecordGuids: previous?.matchedLineRecordGuids
      });
      this.renderFromCache(state);
      return;
    }

    const matchedRecordGuids = new Set();
    const matchedLineGuids = new Set();
    const matchedLineRecordGuids = new Set();

    for (const record of result?.records || []) {
      const guid = (record?.guid || '').trim();
      if (!guid || !latestScopedRecordGuids.has(guid)) continue;
      matchedRecordGuids.add(guid);
      matchedLineRecordGuids.add(guid);
    }

    for (const line of result?.lines || []) {
      const recordGuid = (line?.getRecord?.()?.guid || '').trim();
      if (!recordGuid || !latestScopedRecordGuids.has(recordGuid)) continue;
      const guid = (line?.guid || '').trim();
      if (guid) matchedLineGuids.add(guid);
      matchedLineRecordGuids.add(recordGuid);
    }

    state.queryFilterState = this.createQueryFilterState(query, {
      loading: false,
      ready: true,
      includesUnlinked: latestIncludesUnlinked,
      matchedRecordGuids,
      matchedLineGuids,
      matchedLineRecordGuids
    });
    this.renderFromCache(state);
  }

  filterPropertyGroupsByScopedQuery(groups, queryFilterState) {
    const matchedRecordGuids = queryFilterState?.matchedRecordGuids || new Set();
    const matchedLineRecordGuids = queryFilterState?.matchedLineRecordGuids || new Set();
    return this.filterPropertyGroups(groups, (record) => {
      const guid = (record?.guid || '').trim();
      if (!guid) return false;
      return matchedRecordGuids.has(guid) || matchedLineRecordGuids.has(guid);
    });
  }

  filterLineGroupsByScopedQuery(groups, queryFilterState) {
    const matchedRecordGuids = queryFilterState?.matchedRecordGuids || new Set();
    const matchedLineGuids = queryFilterState?.matchedLineGuids || new Set();
    const out = [];

    for (const group of groups || []) {
      const record = group?.record || null;
      const recordGuid = (record?.guid || '').trim();
      if (!recordGuid) continue;

      if (matchedRecordGuids.has(recordGuid)) {
        out.push({
          record,
          lines: Array.isArray(group?.lines) ? Array.from(group.lines) : []
        });
        continue;
      }

      const lines = (group?.lines || []).filter((line) => matchedLineGuids.has((line?.guid || '').trim()));
      if (lines.length === 0) continue;
      out.push({ record, lines });
    }

    return out;
  }

  hasSearchQuery(state) {
    return Boolean((state?.searchQuery || '').trim());
  }

  updateSearchFieldState(state) {
    if (!state) return;
    const query = state.searchQuery || '';
    const hasValue = query.length > 0;

    if (state.searchInputEl && state.searchInputEl.value !== query) {
      state.searchInputEl.value = query;
    }
    if (state.searchHighlightTextEl) {
      state.searchHighlightTextEl.textContent = query;
    }
    if (state.searchClearEl) {
      state.searchClearEl.style.display = hasValue ? 'flex' : 'none';
    }
    if (state.searchRefreshEl) {
      state.searchRefreshEl.style.display = hasValue ? 'none' : 'flex';
    }
  }

  syncSearchControlState(state) {
    if (!state) return;
    const open = state.searchOpen === true;
    const active = open || this.hasSearchQuery(state);
    const hasQuery = this.hasSearchQuery(state);
    const footerCollapsed = state.rootEl?.classList?.contains?.('tlr-collapsed') === true;

    if (state.rootEl) {
      state.rootEl.classList.toggle('tlr-search-open', open);
      state.rootEl.classList.toggle('tlr-search-active', active);
    }
    if (state.searchRowEl) {
      state.searchRowEl.style.display = open && footerCollapsed !== true ? 'block' : 'none';
    }
    if (state.searchToggleEl) {
      state.searchToggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      state.searchToggleEl.classList.toggle('is-active', active);
      const tooltip = open ? 'Hide filter bar' : hasQuery ? 'Filter (active)' : 'Filter';
      state.searchToggleEl.setAttribute('aria-label', tooltip);
      state.searchToggleEl.setAttribute('data-tooltip', tooltip);
      state.searchToggleEl.title = tooltip;
      const icon = state.searchToggleEl.querySelector?.('.id--filter-icon') || null;
      icon?.classList?.toggle?.('text-primary-icon', active);
      icon?.classList?.toggle?.('bold', active);
    }

    this.updateSearchFieldState(state);
  }

  setSearchOpen(state, open) {
    if (!state) return;
    state.searchOpen = open === true;
    if (state.searchOpen === true) {
      this.setSortMenuOpen(state, false);
    } else {
      this.setSearchAutocompleteOpen(state, false);
      try {
        state.searchInputEl?.blur?.();
      } catch (e) {
        // ignore
      }
    }

    this.syncSearchControlState(state);

    if (state.searchOpen === true && state.searchInputEl) {
      setTimeout(() => {
        try {
          state.searchInputEl?.focus?.();
        } catch (e) {
          // ignore
        }
      }, 0);
    }
  }

  getSortOptions() {
    return [
      { id: 'journal_page', label: 'Journal Page / When' },
      { id: 'page_last_edited', label: 'Page Last Edited' },
      { id: 'page_title', label: 'Page Title' },
      { id: 'reference_count', label: 'Reference Count' }
    ];
  }

  /** Sort keys that carry a date, so time grouping can borrow one. */
  getDateSortKeys() {
    return ['journal_page', 'page_last_edited'];
  }

  isDateSortKey(sortBy) {
    return this.getDateSortKeys().includes(this.normalizeSortBy(sortBy) || '');
  }

  getGroupByOptions() {
    return [
      { id: 'none', label: 'None (flat list)' },
      { id: 'collection', label: 'Collection' },
      { id: 'property', label: 'Property' },
      { id: 'time', label: 'Time' }
    ];
  }

  /** Today's Notes-style icon toggles: click the lit one again to go back to a flat list. */
  getGroupModeButtons() {
    return [
      { id: 'collection', icon: 'ti-folder', label: 'Group by collection' },
      { id: 'time', icon: 'ti-clock', label: 'Group by time' },
      { id: 'property', icon: 'ti-id', label: 'Group by property' }
    ];
  }

  buildGroupModeControls() {
    const wrap = document.createElement('div');
    wrap.className = 'tlr-group-modes';

    for (const mode of this.getGroupModeButtons()) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tlr-btn tlr-group-mode button-none button-small button-minimal-hover tooltip';
      btn.dataset.action = 'set-group-by';
      btn.dataset.groupBy = mode.id;
      btn.title = mode.label;
      btn.setAttribute('aria-label', mode.label);
      btn.setAttribute('data-tooltip', mode.label);
      btn.setAttribute('data-tooltip-dir', 'top');
      btn.setAttribute('aria-pressed', 'false');
      try {
        btn.appendChild(this.ui.createIcon(mode.icon));
      } catch (e) {
        btn.textContent = mode.label.slice(0, 1);
      }
      wrap.appendChild(btn);
    }

    return wrap;
  }

  syncGroupModeControls(state) {
    const wrap = state?.groupModesEl || state?.rootEl?.querySelector?.('.tlr-group-modes') || null;
    if (!wrap) return;
    const groupBy = this.normalizeGroupBy(state?.groupBy) || this._defaultGroupBy;

    for (const mode of this.getGroupModeButtons()) {
      const btn = wrap.querySelector(`[data-group-by="${mode.id}"]`);
      if (!btn) continue;
      const active = mode.id === groupBy;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      const label = active ? `${mode.label} (click to ungroup)` : mode.label;
      btn.title = label;
      btn.setAttribute('data-tooltip', label);
    }
    this.syncTimeMachineControl(state);
  }

  /** One sentence describing order + grouping, so neither setting hides the other. */
  buildSortStateSummary(state) {
    const sortBy = this.normalizeSortBy(state?.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(state?.sortDir) || this._defaultSortDir;
    const groupBy = this.normalizeGroupBy(state?.groupBy) || this._defaultGroupBy;

    const dirLabel = sortBy === 'page_title'
      ? (sortDir === 'asc' ? 'A→Z' : 'Z→A')
      : sortBy === 'reference_count'
        ? (sortDir === 'asc' ? 'fewest first' : 'most first')
        : (sortDir === 'asc' ? 'oldest first' : 'newest first');

    const parts = [this.getSortLabel(sortBy), dirLabel];
    if (groupBy !== 'none') {
      const groupNoun = groupBy === 'time' ? 'month' : groupBy;
      parts.push(`grouped by ${groupNoun}`);
    }
    return parts.join(' · ');
  }

  getGroupByLabel(groupBy) {
    const id = this.normalizeGroupBy(groupBy) || this._defaultGroupBy;
    for (const option of this.getGroupByOptions()) {
      if (option.id === id) return option.label;
    }
    return 'None (flat list)';
  }

  isValidGroupBy(groupBy) {
    if (typeof groupBy !== 'string') return false;
    return this.getGroupByOptions().some((x) => x.id === groupBy);
  }

  normalizeGroupBy(groupBy) {
    return this.isValidGroupBy(groupBy) ? groupBy : null;
  }

  /**
   * Scope key for grouping prefs: journals share one setting; other pages share
   * by collection so People→time sticks across every person, etc.
   */
  getGroupByScopeKey(record, panel) {
    if (record && this.isJournalLikeRecord(record)) return '__journal__';

    const panelColl = panel ? this.getPanelCollection(panel) : null;
    const panelGuid = this.getCollectionGuid(panelColl);
    if (panelGuid) return `c:${panelGuid}`;

    const label = this.getRecordCollectionLabel(record);
    if (label) return `n:${label.toLowerCase()}`;

    const guid = (record?.guid || '').trim();
    return guid ? `r:${guid}` : '';
  }

  getGroupByPreferenceForRecord(recordGuid, panel) {
    const fallback = this._defaultGroupBy;
    let record = null;
    try { record = this.data.getRecord?.((recordGuid || '').trim()) || null; } catch (e) { record = null; }
    const scope = this.getGroupByScopeKey(record, panel || null);
    if (!scope) return fallback;
    const raw = this._groupByScope?.[scope] || null;
    if (!raw || typeof raw !== 'object') return fallback;
    return this.normalizeGroupBy(raw.groupBy) || fallback;
  }

  applyGroupByPreferenceForRecord(recordGuid, groupBy) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;

    const nextGroupBy = this.normalizeGroupBy(groupBy) || this._defaultGroupBy;
    let record = null;
    try { record = this.data.getRecord?.(guid) || null; } catch (e) { record = null; }

    let panel = null;
    for (const s of this._panelStates.values()) {
      if (s?.recordGuid === guid) { panel = s.panel || null; break; }
    }
    const scope = this.getGroupByScopeKey(record, panel);
    if (!scope) return;

    this.setGroupByPreferenceForScope(scope, nextGroupBy);

    for (const s of this._panelStates.values()) {
      if (!s?.recordGuid) continue;
      let other = null;
      try { other = this.data.getRecord?.(s.recordGuid) || null; } catch (e) { other = null; }
      if (this.getGroupByScopeKey(other, s.panel) !== scope) continue;
      s.groupBy = nextGroupBy;
      this.renderSortMenu(s);
      this.syncSortControlState(s);
      this.renderFromCache(s);
    }
  }

  loadGroupByScopeSetting() {
    const normalizePref = (pref) => {
      const groupBy = this.normalizeGroupBy(pref?.groupBy);
      if (!groupBy) return null;
      return {
        groupBy,
        touchedAt: this.normalizeTouchedAt(pref?.touchedAt)
      };
    };

    const current = this.parseStoredRecordMap(
      this.readJsonStorage(this._storageKeyGroupByScope),
      normalizePref
    );
    if (current && Object.keys(current).length) {
      const pruned = this.pruneTouchedRecordMap(current, this._maxStoredSortByRecords);
      if (Object.keys(pruned).length !== Object.keys(current).length) {
        this.writeJsonStorage(this._storageKeyGroupByScope, pruned);
      }
      return pruned;
    }

    // One-time lift of any leftover per-record prefs into collection scopes.
    const legacy = this.parseStoredRecordMap(
      this.readJsonStorage(this._legacyStorageKeyGroupByRecord),
      normalizePref
    ) || {};
    const migrated = {};
    for (const [recordGuid, pref] of Object.entries(legacy)) {
      let record = null;
      try { record = this.data.getRecord?.(recordGuid) || null; } catch (e) { record = null; }
      const scope = this.getGroupByScopeKey(record, null) || `r:${recordGuid}`;
      const prev = migrated[scope];
      if (!prev || (pref.touchedAt || 0) >= (prev.touchedAt || 0)) {
        migrated[scope] = pref;
      }
    }
    if (Object.keys(migrated).length) {
      this.writeJsonStorage(this._storageKeyGroupByScope, migrated);
      return migrated;
    }
    return {};
  }

  saveGroupByScopeSetting() {
    this._groupByScope = this.pruneTouchedRecordMap(
      this._groupByScope || {},
      this._maxStoredSortByRecords
    );
    this.writeJsonStorage(this._storageKeyGroupByScope, this._groupByScope || {});
  }

  setGroupByPreferenceForScope(scopeKey, groupBy) {
    const scope = (scopeKey || '').trim();
    if (!scope) return;

    const nextGroupBy = this.normalizeGroupBy(groupBy) || this._defaultGroupBy;
    if (!this._groupByScope || typeof this._groupByScope !== 'object') {
      this._groupByScope = {};
    }

    if (nextGroupBy === this._defaultGroupBy) {
      delete this._groupByScope[scope];
    } else {
      this._groupByScope[scope] = {
        groupBy: nextGroupBy,
        touchedAt: Date.now()
      };
    }
    this.saveGroupByScopeSetting();
    this._backrefsScheduleSettingsFlush?.();
  }

  getSortLabel(sortBy) {
    const id = this.normalizeSortBy(sortBy) || this._defaultSortBy;
    for (const option of this.getSortOptions()) {
      if (option.id === id) return option.label;
    }
    return 'Journal Page / When';
  }

  isValidSortBy(sortBy) {
    if (typeof sortBy !== 'string') return false;
    return this.getSortOptions().some((x) => x.id === sortBy);
  }

  isValidSortDir(sortDir) {
    return sortDir === 'asc' || sortDir === 'desc';
  }

  normalizeSortBy(sortBy) {
    if (this.isValidSortBy(sortBy)) return sortBy;
    // Retired keys map onto their closest survivor so stored prefs still work.
    const retired = {
      reference_activity: 'page_last_edited',
      page_created_date: 'journal_page'
    };
    const mapped = retired[sortBy];
    return mapped && this.isValidSortBy(mapped) ? mapped : null;
  }

  normalizeSortDir(sortDir) {
    return this.isValidSortDir(sortDir) ? sortDir : null;
  }

  getSortPreferenceForRecord(recordGuid) {
    const guid = (recordGuid || '').trim();
    const fallback = { sortBy: this._defaultSortBy, sortDir: this._defaultSortDir };
    if (!guid) return fallback;

    const raw = this._sortByRecord?.[guid] || null;
    if (!raw || typeof raw !== 'object') return fallback;

    return {
      sortBy: this.normalizeSortBy(raw.sortBy) || fallback.sortBy,
      sortDir: this.normalizeSortDir(raw.sortDir) || fallback.sortDir
    };
  }

  applySortPreferenceForRecord(recordGuid, sortBy, sortDir) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;

    const nextSortBy = this.normalizeSortBy(sortBy) || this._defaultSortBy;
    const nextSortDir = this.normalizeSortDir(sortDir) || this._defaultSortDir;

    this.setSortPreferenceForRecord(guid, nextSortBy, nextSortDir);

    for (const s of this._panelStates.values()) {
      if (!s || s.recordGuid !== guid) continue;
      s.sortBy = nextSortBy;
      s.sortDir = nextSortDir;
      this.renderSortMenu(s);
      this.syncSortControlState(s);
      this.renderFromCache(s);
    }
  }

  renderSortMenu(state) {
    const menu = state?.sortMenuEl || null;
    if (!menu) return;

    const sortBy = this.normalizeSortBy(state.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(state.sortDir) || this._defaultSortDir;
    state.sortBy = sortBy;
    state.sortDir = sortDir;

    menu.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'autocomplete clickable';

    const scroll = document.createElement('div');
    scroll.className = 'vscroll-node';

    const content = document.createElement('div');
    content.className = 'vcontent';

    const scrollbar = document.createElement('div');
    scrollbar.className = 'vscrollbar scrollbar';

    const thumb = document.createElement('div');
    thumb.className = 'vscrollbar-thumb scrollbar-thumb clickable';
    thumb.innerHTML = '&nbsp;';

    const stateLine = document.createElement('div');
    stateLine.className = 'tlr-sort-menu-state';
    stateLine.textContent = this.buildSortStateSummary(state);
    content.appendChild(stateLine);

    const title = document.createElement('div');
    title.className = 'tlr-sort-menu-title text-details';
    title.textContent = 'Sort by';
    content.appendChild(title);

    for (const option of this.getSortOptions()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-sort-option autocomplete--option button-none';
      row.dataset.action = 'set-sort-by';
      row.dataset.sortBy = option.id;
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', option.id === sortBy ? 'true' : 'false');
      if (option.id === sortBy) row.classList.add('autocomplete--option-selected');

      const label = document.createElement('span');
      label.className = 'tlr-sort-option-label autocomplete--option-label';
      label.textContent = option.label;

      row.appendChild(label);
      content.appendChild(row);
    }

    const divider = document.createElement('div');
    divider.className = 'tlr-sort-menu-divider';
    content.appendChild(divider);

    const directionTitle = document.createElement('div');
    directionTitle.className = 'tlr-sort-menu-title text-details';
    directionTitle.textContent = 'Direction';
    content.appendChild(directionTitle);

    const ascBtn = document.createElement('button');
    ascBtn.type = 'button';
    ascBtn.className = 'tlr-sort-option autocomplete--option button-none';
    ascBtn.dataset.action = 'set-sort-dir';
    ascBtn.dataset.sortDir = 'asc';
    ascBtn.setAttribute('role', 'menuitemradio');
    ascBtn.setAttribute('aria-checked', sortDir === 'asc' ? 'true' : 'false');
    ascBtn.textContent = 'Ascending';
    if (sortDir === 'asc') ascBtn.classList.add('autocomplete--option-selected');

    const descBtn = document.createElement('button');
    descBtn.type = 'button';
    descBtn.className = 'tlr-sort-option autocomplete--option button-none';
    descBtn.dataset.action = 'set-sort-dir';
    descBtn.dataset.sortDir = 'desc';
    descBtn.setAttribute('role', 'menuitemradio');
    descBtn.setAttribute('aria-checked', sortDir === 'desc' ? 'true' : 'false');
    descBtn.textContent = 'Descending';
    if (sortDir === 'desc') descBtn.classList.add('autocomplete--option-selected');

    content.appendChild(ascBtn);
    content.appendChild(descBtn);

    // Grouping lives in the header icon toggles, not this menu.
    state.groupBy = this.normalizeGroupBy(state.groupBy) || this._defaultGroupBy;

    scroll.appendChild(content);
    scroll.addEventListener('scroll', () => {
      this.syncSortMenuScrollbar(state);
    });

    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startY = e.clientY;
      const startScrollTop = scroll.scrollTop;
      const onMouseMove = (moveEvent) => {
        const trackHeight = scrollbar.clientHeight || scroll.clientHeight || 0;
        const thumbHeight = thumb.clientHeight || 0;
        const maxThumbTop = Math.max(1, trackHeight - thumbHeight);
        const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (maxScrollTop <= 0) return;
        const deltaRatio = (moveEvent.clientY - startY) / maxThumbTop;
        scroll.scrollTop = Math.max(0, Math.min(maxScrollTop, startScrollTop + (deltaRatio * maxScrollTop)));
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
      };

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    });

    list.appendChild(scroll);
    scrollbar.appendChild(thumb);
    list.appendChild(scrollbar);
    menu.appendChild(list);

    const sync = () => {
      this.syncSortMenuScrollbar(state);
    };
    sync();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(sync);
    } else {
      setTimeout(sync, 0);
    }
  }

  syncSortControlState(state) {
    if (!state) return;
    const sortBy = this.normalizeSortBy(state.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(state.sortDir) || this._defaultSortDir;
    const groupBy = this.normalizeGroupBy(state.groupBy) || this._defaultGroupBy;
    state.sortBy = sortBy;
    state.sortDir = sortDir;
    state.groupBy = groupBy;

    const sortLabel = this.getSortLabel(sortBy);
    const dirLabel = sortDir === 'asc' ? 'Ascending' : 'Descending';
    const groupLabel = this.getGroupByLabel(groupBy);

    if (state.sortToggleEl) {
      state.sortToggleEl.title = `Sort: ${sortLabel} (${dirLabel}) · Group: ${groupLabel}`;
      state.sortToggleEl.setAttribute(
        'aria-label',
        `Sort options: ${sortLabel}, ${dirLabel}. Group by ${groupLabel}`
      );
      state.sortToggleEl.setAttribute('aria-expanded', state.sortMenuOpen === true ? 'true' : 'false');
    }

    if (state.rootEl) {
      state.rootEl.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);
    }

    this.syncGroupModeControls(state);
  }

  setSortMenuOpen(state, open) {
    if (!state) return;
    state.sortMenuOpen = open === true;

    this.clearPointerDismissHandler(state, 'sortMenuDismissHandler');
    if (state.sortMenuKeyHandler) {
      try {
        document.removeEventListener('keydown', state.sortMenuKeyHandler, true);
      } catch (e) {
        // ignore
      }
      state.sortMenuKeyHandler = null;
    }

    this.syncSortControlState(state);

    if (state.sortMenuOpen !== true) return;

    const onOutsideMouseDown = (ev) => {
      const menu = state.sortMenuEl || null;
      const toggle = state.sortToggleEl || null;
      if (!menu || !menu.isConnected) {
        this.setSortMenuOpen(state, false);
        return;
      }

      const target = ev.target;
      if (menu.contains(target)) return;
      if (toggle && toggle.contains(target)) return;
      this.setSortMenuOpen(state, false);
    };

    this.setPointerDismissHandler(state, 'sortMenuDismissHandler', onOutsideMouseDown);

    const onMenuKeyDown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      this.setSortMenuOpen(state, false);
      try {
        state.sortToggleEl?.focus?.();
      } catch (e) {
        // ignore
      }
    };

    state.sortMenuKeyHandler = onMenuKeyDown;
    try {
      document.addEventListener('keydown', onMenuKeyDown, true);
    } catch (e) {
      // ignore
    }
  }

  syncSortMenuScrollbar(state) {
    const menu = state?.sortMenuEl || null;
    const scroll = menu?.querySelector?.('.vscroll-node') || null;
    const scrollbar = menu?.querySelector?.('.vscrollbar') || null;
    const thumb = menu?.querySelector?.('.vscrollbar-thumb') || null;
    if (!scroll || !scrollbar || !thumb) return;

    const viewportHeight = scroll.clientHeight || 0;
    const scrollHeight = scroll.scrollHeight || 0;
    const trackHeight = scrollbar.clientHeight || viewportHeight;
    if (!viewportHeight || !scrollHeight || !trackHeight || scrollHeight <= viewportHeight + 1) {
      scrollbar.classList.remove('has-thumb');
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0px)';
      return;
    }

    const thumbHeight = Math.max(16, Math.round((viewportHeight / scrollHeight) * trackHeight));
    const maxScrollTop = Math.max(1, scrollHeight - viewportHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxThumbTop * (scroll.scrollTop / maxScrollTop);

    scrollbar.classList.add('has-thumb');
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  renderFromCache(state) {
    if (!state) return;
    const cached = state.lastResults || null;
    if (!cached) return;
    this.syncPropertyIndexResultForState(state);

    const panel = state.panel || null;
    if (panel && !this.isPanelVisible(panel)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    if (panel && (!state.rootEl || !state.rootEl.isConnected)) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;
    this.renderReferences(state, cached);
  }

  readJsonStorage(key) {
    const storageKey = typeof key === 'string' ? key.trim() : '';
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (typeof raw !== 'string' || !raw.trim()) return null;
      return JSON.parse(raw);
    } catch (e) {
      // ignore
    }
    return null;
  }

  writeJsonStorage(key, value) {
    const storageKey = typeof key === 'string' ? key.trim() : '';
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (e) {
      // ignore
    }
    this._backrefsScheduleSettingsFlush();
  }

  normalizeTouchedAt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  pruneTouchedRecordMap(value, maxEntries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    const entries = Object.entries(value);
    if (!Number.isFinite(maxEntries) || maxEntries < 1 || entries.length <= maxEntries) {
      return value;
    }

    const kept = entries
      .map(([guid, entry], index) => ({
        guid,
        entry,
        index,
        touchedAt: this.normalizeTouchedAt(entry?.touchedAt)
      }))
      .sort((a, b) => (b.touchedAt - a.touchedAt) || (b.index - a.index))
      .slice(0, maxEntries)
      .sort((a, b) => (a.touchedAt - b.touchedAt) || (a.index - b.index));

    const out = {};
    for (const item of kept) {
      out[item.guid] = item.entry;
    }
    return out;
  }

  parseStoredStringSet(value) {
    if (!Array.isArray(value)) return null;
    const out = new Set();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (text) out.add(text);
    }
    return out;
  }

  pruneStoredSet(set, maxEntries) {
    if (!(set instanceof Set)) return new Set();
    if (!Number.isFinite(maxEntries) || maxEntries < 1 || set.size <= maxEntries) {
      return new Set(set);
    }

    const values = Array.from(set);
    return new Set(values.slice(values.length - maxEntries));
  }

  touchStoredSetEntry(set, value, maxEntries) {
    const text = typeof value === 'string' ? value.trim() : '';
    const out = set instanceof Set ? new Set(set) : new Set();
    if (text) {
      out.delete(text);
      out.add(text);
    }
    return this.pruneStoredSet(out, maxEntries);
  }

  parseStoredRecordMap(value, normalizeEntry) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const normalize = typeof normalizeEntry === 'function' ? normalizeEntry : null;
    const out = {};
    for (const [recordGuid, entry] of Object.entries(value)) {
      const guid = typeof recordGuid === 'string' ? recordGuid.trim() : '';
      if (!guid) continue;
      const normalized = normalize ? normalize(entry) : entry;
      if (normalized == null) continue;
      out[guid] = normalized;
    }
    return out;
  }

  normalizePageViewPreference(pref) {
    const sections = this.cloneSectionCollapsedState(pref?.sections);
    const footerCollapsed = typeof pref?.footerCollapsed === 'boolean' ? pref.footerCollapsed : null;
    const touchedAt = this.normalizeTouchedAt(pref?.touchedAt);
    return { footerCollapsed, sections, touchedAt };
  }

  loadPageViewByRecordSetting() {
    const current = this.parseStoredRecordMap(
      this.readJsonStorage(this._storageKeyPageViewByRecord),
      (pref) => this.normalizePageViewPreference(pref)
    ) || {};
    const pruned = this.pruneTouchedRecordMap(current, this._maxStoredPageViewRecords);
    if (Object.keys(pruned).length !== Object.keys(current).length) {
      this.writeJsonStorage(this._storageKeyPageViewByRecord, pruned);
    }
    return pruned;
  }

  savePageViewByRecordSetting() {
    this._pageViewByRecord = this.pruneTouchedRecordMap(
      this._pageViewByRecord || {},
      this._maxStoredPageViewRecords
    );
    this.writeJsonStorage(this._storageKeyPageViewByRecord, this._pageViewByRecord || {});
  }

  getPageViewPreference(recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return this.normalizePageViewPreference(null);
    return this.normalizePageViewPreference(this._pageViewByRecord?.[guid] || null);
  }

  ensurePageViewPreference(recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return null;
    if (!this._pageViewByRecord || typeof this._pageViewByRecord !== 'object') {
      this._pageViewByRecord = {};
    }
    const nextPref = this.normalizePageViewPreference(this._pageViewByRecord[guid] || null);
    this._pageViewByRecord[guid] = nextPref;
    return nextPref;
  }

  setFooterCollapsedPreferenceForRecord(recordGuid, collapsed) {
    const pref = this.ensurePageViewPreference(recordGuid);
    if (!pref) return;
    pref.footerCollapsed = collapsed === true;
    pref.touchedAt = Date.now();
    this.savePageViewByRecordSetting();
  }

  setSectionCollapsedPreferenceForRecord(recordGuid, sectionId, collapsed) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return;
    const pref = this.ensurePageViewPreference(recordGuid);
    if (!pref) return;
    pref.sections = this.cloneSectionCollapsedState(pref.sections);
    pref.sections[id] = collapsed === true;
    pref.touchedAt = Date.now();
    this.savePageViewByRecordSetting();
  }

  applyFooterCollapsedPreferenceForRecord(recordGuid, collapsed) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;
    this.setFooterCollapsedPreferenceForRecord(guid, collapsed);

    for (const state of this._panelStates.values()) {
      if (!state || state.recordGuid !== guid) continue;
      state.footerCollapsed = collapsed === true;
      this.syncFooterCollapsedState(state, this.isFooterCollapsed(state, this.getCollapseMetrics(state.lastResults)));
    }
  }

  applySectionCollapsedPreferenceForRecord(recordGuid, sectionId, collapsed) {
    const guid = (recordGuid || '').trim();
    const id = this.normalizeSectionId(sectionId);
    if (!guid || !id) return;
    this.setSectionCollapsedPreferenceForRecord(guid, id, collapsed);

    for (const state of this._panelStates.values()) {
      if (!state || state.recordGuid !== guid) continue;
      state.sectionCollapsed = this.cloneSectionCollapsedState(state.sectionCollapsed);
      state.sectionCollapsed[id] = collapsed === true;
      this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: 'section-preference-changed' });
      this.renderFromCache(state);
      if (id === 'unlinked' && collapsed !== true && state.lastResults?.unlinkedDeferred === true) {
        this.ensureDeferredUnlinkedLoaded(state).catch(() => {
          // ignore
        });
      }
    }
  }

  loadPropGroupCollapsedSetting() {
    const current = this.parseStoredStringSet(this.readJsonStorage(this._storageKeyPropGroupCollapsed));
    if (current) {
      const pruned = this.pruneStoredSet(current, this._maxStoredPropGroupStates);
      if (pruned.size !== current.size) {
        this.writeJsonStorage(this._storageKeyPropGroupCollapsed, Array.from(pruned));
      }
      return pruned;
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeyPropGroupCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyPropGroupCollapsed) {
        const set = this.parseStoredStringSet(this.readJsonStorage(legacyKey));
        if (set) {
          const pruned = this.pruneStoredSet(set, this._maxStoredPropGroupStates);
          this.writeJsonStorage(this._storageKeyPropGroupCollapsed, Array.from(pruned));
          return pruned;
        }
      }
    } catch (e) {
      // ignore
    }

    return new Set();
  }

  loadRecordGroupCollapsedSetting() {
    const current = this.parseStoredStringSet(this.readJsonStorage(this._storageKeyRecordGroupCollapsed));
    if (current) {
      const pruned = this.pruneStoredSet(current, this._maxStoredRecordGroupStates);
      if (pruned.size !== current.size) {
        this.writeJsonStorage(this._storageKeyRecordGroupCollapsed, Array.from(pruned));
      }
      return pruned;
    }

    try {
      const legacyKey = this._legacyStorageKeyRecordGroupCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyRecordGroupCollapsed) {
        const set = this.parseStoredStringSet(this.readJsonStorage(legacyKey));
        if (set) {
          const pruned = this.pruneStoredSet(set, this._maxStoredRecordGroupStates);
          this.writeJsonStorage(this._storageKeyRecordGroupCollapsed, Array.from(pruned));
          return pruned;
        }
      }
    } catch (e) {
      // ignore
    }

    return new Set();
  }

  savePropGroupCollapsedSetting() {
    this._propGroupCollapsed = this.pruneStoredSet(
      this._propGroupCollapsed,
      this._maxStoredPropGroupStates
    );
    this.writeJsonStorage(this._storageKeyPropGroupCollapsed, Array.from(this._propGroupCollapsed || []));
  }

  saveRecordGroupCollapsedSetting() {
    this._recordGroupCollapsed = this.pruneStoredSet(
      this._recordGroupCollapsed,
      this._maxStoredRecordGroupStates
    );
    this.writeJsonStorage(this._storageKeyRecordGroupCollapsed, Array.from(this._recordGroupCollapsed || []));
  }

  isPropGroupCollapsed(propName) {
    const name = (propName || '').trim();
    if (!name) return false;
    return this._propGroupCollapsed?.has?.(name) === true;
  }

  setPropGroupCollapsed(propName, collapsed) {
    const name = (propName || '').trim();
    if (!name) return;
    if (!this._propGroupCollapsed) this._propGroupCollapsed = new Set();
    if (collapsed === true) {
      this._propGroupCollapsed = this.touchStoredSetEntry(
        this._propGroupCollapsed,
        name,
        this._maxStoredPropGroupStates
      );
    } else {
      this._propGroupCollapsed.delete(name);
    }
    this.savePropGroupCollapsedSetting();
  }

  normalizeRecordGroupSectionId(sectionId) {
    return sectionId === 'linked' || sectionId === 'unlinked' ? sectionId : null;
  }

  getRecordGroupCollapsedKey(sectionId, targetRecordGuid, recordGuid) {
    const normalizedSectionId = this.normalizeRecordGroupSectionId(sectionId);
    const targetGuid = typeof targetRecordGuid === 'string' ? targetRecordGuid.trim() : '';
    const guid = typeof recordGuid === 'string' ? recordGuid.trim() : '';
    if (!normalizedSectionId || !targetGuid || !guid) return '';
    return `${normalizedSectionId}:${targetGuid}:${guid}`;
  }

  isRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid) {
    const key = this.getRecordGroupCollapsedKey(sectionId, targetRecordGuid, recordGuid);
    if (!key) return false;
    return this._recordGroupCollapsed?.has?.(key) === true;
  }

  setRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid, collapsed) {
    const key = this.getRecordGroupCollapsedKey(sectionId, targetRecordGuid, recordGuid);
    if (!key) return;
    if (!this._recordGroupCollapsed) this._recordGroupCollapsed = new Set();
    if (collapsed === true) {
      this._recordGroupCollapsed = this.touchStoredSetEntry(
        this._recordGroupCollapsed,
        key,
        this._maxStoredRecordGroupStates
      );
    } else {
      this._recordGroupCollapsed.delete(key);
    }
    this.saveRecordGroupCollapsedSetting();
  }

  loadSortByRecordSetting() {
    const normalizeSortPref = (pref) => {
      const sortBy = this.normalizeSortBy(pref?.sortBy);
      const sortDir = this.normalizeSortDir(pref?.sortDir);
      if (!sortBy || !sortDir) return null;
      return {
        sortBy,
        sortDir,
        touchedAt: this.normalizeTouchedAt(pref?.touchedAt)
      };
    };

    const current = this.parseStoredRecordMap(
      this.readJsonStorage(this._storageKeySortByRecord),
      normalizeSortPref
    );
    if (current) {
      const pruned = this.pruneTouchedRecordMap(current, this._maxStoredSortByRecords);
      if (Object.keys(pruned).length !== Object.keys(current).length) {
        this.writeJsonStorage(this._storageKeySortByRecord, pruned);
      }
      return pruned;
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeySortByRecord;
      if (legacyKey && legacyKey !== this._storageKeySortByRecord) {
        const map = this.parseStoredRecordMap(this.readJsonStorage(legacyKey), normalizeSortPref);
        if (map) {
          const pruned = this.pruneTouchedRecordMap(map, this._maxStoredSortByRecords);
          this.writeJsonStorage(this._storageKeySortByRecord, pruned);
          return pruned;
        }
      }
    } catch (e) {
      // ignore
    }

    return {};
  }

  saveSortByRecordSetting() {
    this._sortByRecord = this.pruneTouchedRecordMap(
      this._sortByRecord || {},
      this._maxStoredSortByRecords
    );
    this.writeJsonStorage(this._storageKeySortByRecord, this._sortByRecord || {});
  }

  setSortPreferenceForRecord(recordGuid, sortBy, sortDir) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;

    const nextSortBy = this.normalizeSortBy(sortBy) || this._defaultSortBy;
    const nextSortDir = this.normalizeSortDir(sortDir) || this._defaultSortDir;

    if (!this._sortByRecord || typeof this._sortByRecord !== 'object') {
      this._sortByRecord = {};
    }

    if (nextSortBy === this._defaultSortBy && nextSortDir === this._defaultSortDir) {
      delete this._sortByRecord[guid];
    } else {
      this._sortByRecord[guid] = {
        sortBy: nextSortBy,
        sortDir: nextSortDir,
        touchedAt: Date.now()
      };
    }

    this.saveSortByRecordSetting();
  }

  bumpLinkedContextRenderVersion(state) {
    if (!state) return;
    state.linkedContextRenderVersion = (state.linkedContextRenderVersion || 0) + 1;
  }

  invalidateLinkedContextCache(state) {
    const map = state?.linkedContextByLine;
    if (!(map instanceof Map)) return;
    let changed = false;

    for (const ctx of map.values()) {
      if (!ctx || typeof ctx !== 'object') continue;
      if (
        ctx.loaded === true
        || ctx.loading === true
        || (ctx.descendants || []).length > 0
        || (ctx.aboveItems || []).length > 0
        || (ctx.belowItems || []).length > 0
        || ctx.showMoreContext === true
        || (ctx.siblingAboveCount || 0) > 0
        || (ctx.siblingBelowCount || 0) > 0
        || ctx.error
      ) {
        changed = true;
      }
      ctx.loaded = false;
      ctx.loading = false;
      ctx.loadPromise = null;
      ctx.error = '';
      ctx.descendants = [];
      ctx.depthByGuid = {};
      ctx.relativeDepthByGuid = {};
      ctx.aboveItems = [];
      ctx.belowItems = [];
    }
    if (changed) this.bumpLinkedContextRenderVersion(state);
  }

  getPropertySnapshotKey(propertyName, recordGuid) {
    return `prop:${(propertyName || '').trim()}::${(recordGuid || '').trim()}`;
  }

  getLinkedSnapshotKey(lineGuid) {
    return `line:${(lineGuid || '').trim()}`;
  }

  buildResultsSnapshot(propertyGroups, linkedGroups) {
    const itemsByKey = new Map();
    const sourceRecordGuids = new Set();
    let propertyCount = 0;
    let linkedCount = 0;

    for (const g of propertyGroups || []) {
      const propertyName = (g?.propertyName || '').trim();
      if (!propertyName) continue;
      for (const record of g?.records || []) {
        const recordGuid = record?.guid || null;
        if (!recordGuid) continue;
        const key = this.getPropertySnapshotKey(propertyName, recordGuid);
        itemsByKey.set(key, {
          kind: 'property',
          key,
          signature: key,
          recordGuid,
          propertyName
        });
        sourceRecordGuids.add(recordGuid);
        propertyCount += 1;
      }
    }

    for (const g of linkedGroups || []) {
      const recordGuid = g?.record?.guid || null;
      if (!recordGuid) continue;
      sourceRecordGuids.add(recordGuid);
      for (const line of g?.lines || []) {
        const lineGuid = line?.guid || null;
        if (!lineGuid) continue;
        const key = this.getLinkedSnapshotKey(lineGuid);
        itemsByKey.set(key, {
          kind: 'line',
          key,
          signature: `${recordGuid}|${lineGuid}|${this.segmentsToPlainText(line?.segments || [])}|${this.getLineActivityTimestamp(line)}`,
          recordGuid,
          lineGuid
        });
        linkedCount += 1;
      }
    }

    return {
      itemsByKey,
      sourceRecordGuids,
      propertyCount,
      linkedCount,
      totalCount: propertyCount + linkedCount,
      pageCount: sourceRecordGuids.size
    };
  }

  diffCurrentSnapshotKeys(prevSnapshot, nextSnapshot) {
    const changed = new Set();
    const prevItems = prevSnapshot?.itemsByKey instanceof Map ? prevSnapshot.itemsByKey : new Map();
    const nextItems = nextSnapshot?.itemsByKey instanceof Map ? nextSnapshot.itemsByKey : new Map();

    for (const [key, nextItem] of nextItems.entries()) {
      const prevItem = prevItems.get(key) || null;
      if (!prevItem || prevItem.signature !== nextItem.signature) changed.add(key);
    }

    return changed;
  }

  sameStringSet(a, b) {
    const left = a instanceof Set ? a : new Set();
    const right = b instanceof Set ? b : new Set();
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  sameStringMap(a, b) {
    const left = a instanceof Map ? a : new Map();
    const right = b instanceof Map ? b : new Map();
    if (left.size !== right.size) return false;
    for (const [key, value] of left.entries()) {
      if (!right.has(key)) return false;
      if (right.get(key) !== value) return false;
    }
    return true;
  }

  markStatePendingRemote(state, ev) {
    if (!state || ev?.source?.isLocal !== false) return;
    state.pendingRemoteSync = true;
    if (!(state.pendingRemoteUsers instanceof Set)) state.pendingRemoteUsers = new Set();

    const user = typeof ev.getSourceUser === 'function' ? ev.getSourceUser() : null;
    const name = (user?.getDisplayName?.() || '').trim();
    if (name) state.pendingRemoteUsers.add(name);
  }

  markAllStatesPendingRemote(ev) {
    for (const state of this._panelStates.values()) {
      this.markStatePendingRemote(state, ev);
    }
  }

  getRemoteBadgeTooltip(userNames) {
    const names = Array.from(userNames || []).filter(Boolean);
    if (names.length === 1) return `Changed remotely by ${names[0]}`;
    if (names.length > 1) return `Changed remotely by ${names.join(', ')}`;
    return 'Changed remotely';
  }

  applyLiveSnapshot(state, snapshot) {
    if (!state) return;

    const currentSnapshot = snapshot || this.buildResultsSnapshot([], []);
    const baseline = state.liveBaselineSnapshot;
    const previous = state.liveCurrentSnapshot;
    const prevNewKeys = state.liveNewKeys instanceof Set ? new Set(state.liveNewKeys) : new Set();
    const prevRemoteBadges = state.liveRemoteBadgesByKey instanceof Map
      ? new Map(state.liveRemoteBadgesByKey)
      : new Map();

    if (!baseline || !previous) {
      state.liveBaselineSnapshot = currentSnapshot;
      state.liveCurrentSnapshot = currentSnapshot;
      state.liveNewKeys = new Set();
      state.liveRemoteBadgesByKey = new Map();
      state.liveRenderVersion = (state.liveRenderVersion || 0) + 1;
      state.pendingRemoteSync = false;
      state.pendingRemoteUsers = new Set();
      return;
    }

    const nextNewKeys = new Set();
    for (const key of currentSnapshot.itemsByKey.keys()) {
      if (!baseline.itemsByKey.has(key)) nextNewKeys.add(key);
    }

    const nextRemoteBadges = state.liveRemoteBadgesByKey instanceof Map
      ? new Map(state.liveRemoteBadgesByKey)
      : new Map();

    for (const key of Array.from(nextRemoteBadges.keys())) {
      if (!currentSnapshot.itemsByKey.has(key)) nextRemoteBadges.delete(key);
    }

    if (state.pendingRemoteSync === true) {
      const tooltip = this.getRemoteBadgeTooltip(state.pendingRemoteUsers);
      for (const key of this.diffCurrentSnapshotKeys(previous, currentSnapshot)) {
        if (!currentSnapshot.itemsByKey.has(key)) continue;
        nextRemoteBadges.set(key, tooltip);
      }
    }

    state.liveCurrentSnapshot = currentSnapshot;
    state.liveNewKeys = nextNewKeys;
    state.liveRemoteBadgesByKey = nextRemoteBadges;
    if (!this.sameStringSet(prevNewKeys, nextNewKeys) || !this.sameStringMap(prevRemoteBadges, nextRemoteBadges)) {
      state.liveRenderVersion = (state.liveRenderVersion || 0) + 1;
    }
    state.pendingRemoteSync = false;
    state.pendingRemoteUsers = new Set();
  }

  getLiveBadgesForKey(state, itemKey) {
    const badges = [];
    if (!state || !itemKey) return badges;

    if (state.liveNewKeys instanceof Set && state.liveNewKeys.has(itemKey)) {
      badges.push({ label: 'New', className: 'is-new', tooltip: 'Added since this page was opened' });
    }

    if (state.liveRemoteBadgesByKey instanceof Map && state.liveRemoteBadgesByKey.has(itemKey)) {
      badges.push({ label: 'Changed', className: 'is-remote', tooltip: state.liveRemoteBadgesByKey.get(itemKey) || 'Changed remotely' });
    }

    return badges;
  }

  appendLiveBadges(container, state, itemKey) {
    if (!container) return;

    for (const badge of this.getLiveBadgesForKey(state, itemKey)) {
      container.appendChild(document.createTextNode(' '));
      const el = document.createElement('span');
      el.className = `tlr-live-badge text-details ${badge.className || ''}`.trim();
      el.textContent = badge.label;
      if (badge.tooltip) el.title = badge.tooltip;
      container.appendChild(el);
    }
  }

  handleWorkspaceInvalidation(ev, reason) {
    this.markAllStatesPendingRemote(ev);
    this.refreshAllPanels({ force: false, reason: reason || 'workspace-invalidated' });
  }

  createEmptyPropertyIndexStats() {
    return {
      scannedRecords: 0,
      indexedReferences: 0,
      indexedTargets: 0,
      startedAt: null,
      finishedAt: null
    };
  }

  getPropertyIndexSnapshot() {
    return {
      status: this._propertyIndexStatus || 'idle',
      stats: { ...(this._propertyIndexStats || this.createEmptyPropertyIndexStats()) },
      error: this._propertyIndexError || ''
    };
  }

  getPropertyIndexDisplayMessage(snapshot) {
    const state = snapshot || this.getPropertyIndexSnapshot();
    const scanned = this.coerceNonNegativeInt(state?.stats?.scannedRecords, 0);
    if (state.status === 'indexing') {
      return `Indexing backreferences... ${scanned.toLocaleString()} records scanned`;
    }
    if (state.status === 'idle') {
      return 'Property reference index has not been built yet.';
    }
    if (state.status === 'error') {
      return state.error || 'Error indexing property references.';
    }
    return '';
  }

  notifyPropertyIndexChanged(reason) {
    const isProgress = typeof reason === 'string' && reason.includes('property-index-progress');
    if (isProgress && !this._panelStates?.size) return;
    for (const state of this._panelStates?.values?.() || []) {
      if (!state?.lastResults) continue;
      this.syncPropertyIndexResultForState(state);
      if (isProgress) continue;
      this.renderFromCache(state);
    }
  }

  cancelInitialPropertyIndexDefer() {
    const handle = this._propertyIndexInitialDeferHandle;
    this._propertyIndexInitialDeferHandle = null;
    if (handle == null) return;
    try {
      if (this._propertyIndexInitialDeferIsIdle && typeof cancelIdleCallback === 'function') {
        cancelIdleCallback(handle);
      } else {
        clearTimeout(handle);
      }
    } catch (e) {
      // ignore
    }
    this._propertyIndexInitialDeferIsIdle = false;
  }

  usesSdkPropertyBacklinks() {
    return this._propertyIndexSdkMode === true;
  }

  /**
   * When Thymer exposes host reverse-index APIs, skip the workspace-wide property index.
   * Prefers getBackReferences(); getBackReferenceRecords() alone also enables SDK mode.
   * @returns {boolean} true if SDK mode is now active
   */
  noteSdkPropertyBacklinksFromRecord(record) {
    if (this._propertyIndexSdkMode === true) return true;
    const hasDetailed = typeof record?.getBackReferences === 'function';
    const hasRecords = typeof record?.getBackReferenceRecords === 'function';
    if (!hasDetailed && !hasRecords) return false;
    this._propertyIndexSdkMode = true;
    this.cancelInitialPropertyIndexDefer();
    return true;
  }

  hostBackReferencesAvailable(record) {
    return typeof record?.getBackReferences === 'function'
      || typeof record?.getBackReferenceRecords === 'function';
  }

  scheduleInitialPropertyIndex() {
    if (this.usesSdkPropertyBacklinks()) return;
    this.cancelInitialPropertyIndexDefer();
    const start = () => {
      this._propertyIndexInitialDeferHandle = null;
      this._propertyIndexInitialDeferIsIdle = false;
      if (this._propertyIndexStatus !== 'idle') return;
      this.rebuildPropertyIndex({ reason: 'initial-idle' }).catch(() => {
        // The error state is rendered in the footer.
      });
    };
    const idleTimeout = this.preferDeferredHeavyWork() ? 10000 : 5000;
    try {
      if (typeof requestIdleCallback === 'function') {
        this._propertyIndexInitialDeferIsIdle = true;
        this._propertyIndexInitialDeferHandle = requestIdleCallback(start, { timeout: idleTimeout });
      } else {
        this._propertyIndexInitialDeferIsIdle = false;
        this._propertyIndexInitialDeferHandle = setTimeout(start, this.preferDeferredHeavyWork() ? 3500 : 1500);
      }
    } catch (e) {
      this._propertyIndexInitialDeferIsIdle = false;
      this._propertyIndexInitialDeferHandle = setTimeout(start, 2000);
    }
  }

  ensurePropertyIndexStarted(reason = 'on-demand') {
    if (this.usesSdkPropertyBacklinks()) return;
    if (this.inMobileLoadGrace()) return;
    if (this._propertyIndexStatus === 'ready' || this._propertyIndexStatus === 'indexing') return;
    this.cancelInitialPropertyIndexDefer();
    this.rebuildPropertyIndex({ reason: reason || 'on-demand' }).catch(() => {
      // The error state is rendered in the footer.
    });
  }

  preferDeferredHeavyWork() {
    try {
      if (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) return true;
    } catch (e) {
      // ignore
    }
    try {
      return Number(navigator?.maxTouchPoints) > 0;
    } catch (e) {
      return false;
    }
  }

  syncPropertyIndexResultForState(state) {
    if (this.usesSdkPropertyBacklinks()) return false;
    const results = state?.lastResults || null;
    if (!state || !results) return false;
    const { showSelf } = this.getRefreshConfig();
    const next = this.getPropertyBacklinkResult(state.recordGuid, { showSelf });
    results.propertyGroups = next.propertyGroups;
    results.propertyError = next.propertyError;
    results.propertyIndexStatus = next.propertyIndexStatus;
    results.propertyIndexStats = next.propertyIndexStats;
    results.propertyIndexError = next.propertyIndexError;
    this.applyLiveSnapshot(state, this.buildResultsSnapshot(results.propertyGroups, results.linkedGroups));
    return true;
  }

  async rebuildPropertyIndex({ reason } = {}) {
    if (this._propertyIndexStatus === 'indexing' && this._propertyIndexPromise) {
      this._propertyIndexNeedsRebuild = true;
      return this._propertyIndexPromise;
    }

    const seq = (this._propertyIndexBuildSeq || 0) + 1;
    this._propertyIndexBuildSeq = seq;
    this._propertyIndexStatus = 'indexing';
    this._propertyIndexError = '';
    this._propertyIndexStats = {
      ...this.createEmptyPropertyIndexStats(),
      startedAt: new Date()
    };
    this.notifyPropertyIndexChanged(reason || 'property-index-started');

    const promise = this.buildPropertyIndex(seq, reason)
      .finally(() => {
        if (this._propertyIndexPromise === promise) {
          this._propertyIndexPromise = null;
        }
      });
    this._propertyIndexPromise = promise;
    return promise;
  }

  async buildPropertyIndex(seq, reason) {
    const byTargetGuid = new Map();
    const sourceEntriesByRecordGuid = new Map();

    try {
      if (typeof this.data?.getAllCollections !== 'function') {
        throw new Error('Thymer graph collections are unavailable.');
      }

      const collections = await this.data.getAllCollections();
      if (!Array.isArray(collections)) {
        throw new Error('Thymer graph collections could not be read.');
      }

      let lastNotifyAt = Date.now();
      for (const collection of collections) {
        if (!collection || typeof collection.getAllRecords !== 'function') continue;
        let records = [];
        try {
          records = await collection.getAllRecords();
        } catch (e) {
          continue;
        }
        if (!Array.isArray(records)) continue;

        for (const record of records) {
          if (this._propertyIndexBuildSeq !== seq) return;
          this.indexSourceRecordPropertyRefs(record, byTargetGuid, sourceEntriesByRecordGuid);
          this._propertyIndexStats.scannedRecords += 1;

          const now = Date.now();
          const progressEveryRecords = this.preferDeferredHeavyWork() ? 800 : 400;
          const progressEveryMs = this.preferDeferredHeavyWork() ? 2500 : 1200;
          if (
            this._propertyIndexStats.scannedRecords % progressEveryRecords === 0 ||
            now - lastNotifyAt > progressEveryMs
          ) {
            lastNotifyAt = now;
            this.notifyPropertyIndexChanged(reason || 'property-index-progress');
            await this.waitForIndexYield();
          }
        }
      }

      if (this._propertyIndexBuildSeq !== seq) return;

      this._propertyIndexByTargetGuid = byTargetGuid;
      this._propertyIndexSourceEntriesByRecordGuid = sourceEntriesByRecordGuid;
      this._propertyIndexStats = {
        ...this._propertyIndexStats,
        indexedReferences: this.countPropertyIndexReferences(byTargetGuid),
        indexedTargets: byTargetGuid.size,
        finishedAt: new Date()
      };
      this._propertyIndexStatus = 'ready';
      this._propertyIndexError = '';
      this.notifyPropertyIndexChanged(reason || 'property-index-ready');
      // Re-apply any record events that arrived while the build was running.
      // This replaces the old behaviour of scheduling a *new* full rebuild
      // for every event that came in during the build.
      try {
        this.drainPendingRecordReindex(reason || 'property-index-ready-drain');
      } catch (_) {}
    } catch (e) {
      if (this._propertyIndexBuildSeq !== seq) return;
      this._propertyIndexStatus = 'error';
      this._propertyIndexError = e?.message || 'Error indexing property references.';
      this._propertyIndexStats = {
        ...this._propertyIndexStats,
        finishedAt: new Date()
      };
      this.notifyPropertyIndexChanged(reason || 'property-index-error');
    } finally {
      if (this._propertyIndexBuildSeq === seq && this._propertyIndexNeedsRebuild) {
        this._propertyIndexNeedsRebuild = false;
        this.schedulePropertyIndexRebuild('queued-property-index-rebuild', 0);
      }
    }
  }

  waitForIndexYield() {
    const delayMs = this.preferDeferredHeavyWork() ? 12 : 0;
    return new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  schedulePropertyIndexRebuild(reason, delayMs = 600) {
    if (this._propertyIndexStatus === 'indexing') {
      this._propertyIndexNeedsRebuild = true;
      return;
    }
    if (this._propertyIndexRebuildTimer) {
      clearTimeout(this._propertyIndexRebuildTimer);
      this._propertyIndexRebuildTimer = null;
    }
    this._propertyIndexRebuildTimer = setTimeout(() => {
      this._propertyIndexRebuildTimer = null;
      this.rebuildPropertyIndex({ reason: reason || 'scheduled-property-index-rebuild' }).catch(() => {
        // The error state is rendered in the footer.
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  countPropertyIndexReferences(byTargetGuid = this._propertyIndexByTargetGuid) {
    let total = 0;
    for (const byProp of byTargetGuid?.values?.() || []) {
      for (const records of byProp?.values?.() || []) {
        total += records?.size || 0;
      }
    }
    return total;
  }

  getPropertyReferenceGuids(prop) {
    const out = new Set();
    const linkedRecordGuids = this.getPropertyLinkedRecordGuids(prop);
    for (const guid of linkedRecordGuids || []) {
      const t = (guid || '').trim();
      if (t) out.add(t);
    }
    for (const value of this.getPropertyCandidateValues(prop)) {
      const t = (value || '').trim();
      if (t) out.add(t);
    }
    return out;
  }

  indexSourceRecordPropertyRefs(record, byTargetGuid, sourceEntriesByRecordGuid) {
    const sourceGuid = (record?.guid || '').trim();
    if (!sourceGuid) return 0;
    this.removeSourceRecordFromPropertyIndexMaps(sourceGuid, byTargetGuid, sourceEntriesByRecordGuid);

    let props = [];
    try {
      props = record.getAllProperties?.() || [];
    } catch (e) {
      props = [];
    }
    if (!Array.isArray(props)) props = [];

    const entries = [];
    const seenEntries = new Set();
    for (const prop of props) {
      const propertyName = (prop?.name || '').trim();
      if (!propertyName) continue;

      for (const targetGuid of this.getPropertyReferenceGuids(prop)) {
        const guid = (targetGuid || '').trim();
        if (!guid) continue;
        const entryKey = `${guid}\u0000${propertyName}`;
        if (seenEntries.has(entryKey)) continue;
        seenEntries.add(entryKey);

        let byProp = byTargetGuid.get(guid) || null;
        if (!byProp) {
          byProp = new Map();
          byTargetGuid.set(guid, byProp);
        }
        let bySource = byProp.get(propertyName) || null;
        if (!bySource) {
          bySource = new Map();
          byProp.set(propertyName, bySource);
        }
        bySource.set(sourceGuid, record);
        entries.push({ targetGuid: guid, propertyName });
      }
    }

    if (entries.length > 0) {
      sourceEntriesByRecordGuid.set(sourceGuid, entries);
    } else {
      sourceEntriesByRecordGuid.delete(sourceGuid);
    }

    return entries.length;
  }

  removeSourceRecordFromPropertyIndexMaps(sourceRecordGuid, byTargetGuid, sourceEntriesByRecordGuid) {
    const sourceGuid = (sourceRecordGuid || '').trim();
    if (!sourceGuid) return false;
    const entries = sourceEntriesByRecordGuid?.get?.(sourceGuid) || [];
    for (const entry of entries) {
      const byProp = byTargetGuid?.get?.(entry.targetGuid);
      if (!byProp) continue;
      const bySource = byProp.get(entry.propertyName);
      if (!bySource) continue;
      bySource.delete(sourceGuid);
      if (bySource.size === 0) byProp.delete(entry.propertyName);
      if (byProp.size === 0) byTargetGuid.delete(entry.targetGuid);
    }
    sourceEntriesByRecordGuid?.delete?.(sourceGuid);
    return entries.length > 0;
  }

  removeSourceRecordFromPropertyIndex(sourceRecordGuid) {
    return this.removeSourceRecordFromPropertyIndexMaps(
      sourceRecordGuid,
      this._propertyIndexByTargetGuid,
      this._propertyIndexSourceEntriesByRecordGuid
    );
  }

  updatePropertyIndexForRecord(sourceRecordGuid, sourceRecord) {
    const sourceGuid = ((sourceRecordGuid || sourceRecord?.guid || '') + '').trim();
    if (!sourceGuid) return false;
    /**
     * Defer when the index isn't ready (build-in-progress, idle, error). The
     * record is queued in `_pendingRecordReindex` and re-applied at the end of
     * the next successful build via `drainPendingRecordReindex`. We deliberately
     * do NOT schedule a full workspace rebuild here — that's what created the
     * feedback loop (every record event during a build queued another full
     * build, looping forever once the workspace was non-trivial).
     */
    if (this._propertyIndexStatus !== 'ready') {
      this._pendingRecordReindex.add(sourceGuid);
      return true;
    }

    const record = sourceRecord || this.data.getRecord?.(sourceGuid) || null;
    if (!record) {
      // Record was deleted (or not yet retrievable). Prune any stale entry from
      // the index instead of rebuilding the whole workspace — pruning is O(1)
      // amortised, the prior full rebuild was O(records × properties).
      this.removeSourceRecordFromPropertyIndex(sourceGuid);
      this._propertyIndexStats = {
        ...(this._propertyIndexStats || this.createEmptyPropertyIndexStats()),
        indexedReferences: this.countPropertyIndexReferences(),
        indexedTargets: this._propertyIndexByTargetGuid.size
      };
      this.notifyPropertyIndexChanged('record-property-index-pruned');
      return true;
    }

    this.removeSourceRecordFromPropertyIndex(sourceGuid);
    this.indexSourceRecordPropertyRefs(
      record,
      this._propertyIndexByTargetGuid,
      this._propertyIndexSourceEntriesByRecordGuid
    );
    this._propertyIndexStats = {
      ...(this._propertyIndexStats || this.createEmptyPropertyIndexStats()),
      indexedReferences: this.countPropertyIndexReferences(),
      indexedTargets: this._propertyIndexByTargetGuid.size
    };
    this.notifyPropertyIndexChanged('record-property-index-updated');
    return true;
  }

  /**
   * Re-apply incremental updates for records that were deferred while the index
   * was being (re)built. Called from the success path of `buildPropertyIndex`.
   * We skip notifying per-record (would be O(pending) churn) and emit a single
   * notification at the end if any records were actually applied.
   */
  drainPendingRecordReindex(reason) {
    const pending = this._pendingRecordReindex;
    if (!pending || pending.size === 0) return;
    const guids = Array.from(pending);
    pending.clear();
    if (this._propertyIndexStatus !== 'ready') {
      // The index isn't ready — re-queue and bail. Drain will retry on next
      // successful build.
      for (const g of guids) pending.add(g);
      return;
    }
    let applied = 0;
    for (const guid of guids) {
      try {
        const record = this.data.getRecord?.(guid) || null;
        this.removeSourceRecordFromPropertyIndex(guid);
        if (record) {
          this.indexSourceRecordPropertyRefs(
            record,
            this._propertyIndexByTargetGuid,
            this._propertyIndexSourceEntriesByRecordGuid
          );
        }
        applied += 1;
      } catch (_) {
        // Ignore individual record failures — drain is best-effort.
      }
    }
    if (applied > 0) {
      this._propertyIndexStats = {
        ...(this._propertyIndexStats || this.createEmptyPropertyIndexStats()),
        indexedReferences: this.countPropertyIndexReferences(),
        indexedTargets: this._propertyIndexByTargetGuid.size
      };
      this.notifyPropertyIndexChanged(reason || 'record-property-index-drained');
    }
  }

  getPropertyBacklinkGroupsFromIndex(targetGuid, { showSelf } = {}) {
    const guid = (targetGuid || '').trim();
    if (!guid || this._propertyIndexStatus !== 'ready') return [];

    const byProp = this._propertyIndexByTargetGuid?.get?.(guid) || null;
    if (!byProp) return [];

    const groups = Array.from(byProp.entries()).map(([propertyName, recordMap]) => {
      const records = [];
      const seen = new Set();
      for (const record of recordMap?.values?.() || []) {
        const sourceGuid = (record?.guid || '').trim();
        if (!sourceGuid || seen.has(sourceGuid)) continue;
        if (!showSelf && sourceGuid === guid) continue;
        if (this.isExcludedSourceRecord(record)) continue;
        seen.add(sourceGuid);
        records.push(record);
      }
      return { propertyName, records };
    }).filter((group) => group.records.length > 0);

    groups.sort((a, b) => {
      const an = (a.propertyName || '').toLowerCase();
      const bn = (b.propertyName || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.records.sort((a, b) => {
        const ad = a?.getUpdatedAt?.() || null;
        const bd = b?.getUpdatedAt?.() || null;
        const at = ad ? ad.getTime() : 0;
        const bt = bd ? bd.getTime() : 0;
        if (bt !== at) return bt - at;
        const an = (a?.getName?.() || '').toLowerCase();
        const bn = (b?.getName?.() || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }

    return groups;
  }

  getPropertyBacklinkResult(targetGuid, { showSelf } = {}) {
    const snapshot = this.getPropertyIndexSnapshot();
    return {
      propertyGroups: snapshot.status === 'ready'
        ? this.getPropertyBacklinkGroupsFromIndex(targetGuid, { showSelf })
        : [],
      propertyError: '',
      propertyIndexStatus: snapshot.status,
      propertyIndexStats: snapshot.stats,
      propertyIndexError: snapshot.status === 'error'
        ? (snapshot.error || 'Error indexing property references.')
        : ''
    };
  }

  getUnavailablePropertyBacklinkMessage() {
    return 'Property References require a newer Thymer version. Update Thymer, then refresh references.';
  }

  getPropertyBacklinkErrorMessage(error) {
    const message = (error?.message || '').trim();
    if (message === this.getUnavailablePropertyBacklinkMessage()) return message;
    return 'Property References could not be loaded. Refresh references to try again.';
  }

  async getPropertyBacklinkCandidateRecords(targetRecord) {
    if (typeof targetRecord?.getBackReferences === 'function') {
      const refs = await targetRecord.getBackReferences();
      const out = [];
      const seen = new Set();
      for (const ref of refs || []) {
        if (ref?.kind && ref.kind !== 'property') continue;
        const record = ref?.record || null;
        const guid = record?.guid || '';
        if (!guid || seen.has(guid)) continue;
        seen.add(guid);
        out.push(record);
      }
      return out;
    }
    if (typeof targetRecord?.getBackReferenceRecords !== 'function') {
      throw new Error(this.getUnavailablePropertyBacklinkMessage());
    }
    const records = await targetRecord.getBackReferenceRecords();
    return Array.isArray(records) ? records : [];
  }

  async fetchDetailedBackReferences(targetRecord) {
    if (typeof targetRecord?.getBackReferences === 'function') {
      const refs = await targetRecord.getBackReferences();
      return Array.isArray(refs) ? refs : [];
    }
    if (typeof targetRecord?.getBackReferenceRecords === 'function') {
      const records = await targetRecord.getBackReferenceRecords();
      return (Array.isArray(records) ? records : []).map((record) => ({
        record,
        kind: 'property',
        propertyId: null,
        lineItemGuid: null
      }));
    }
    return null;
  }

  /**
   * `PluginBackReference.propertyId` matches `PluginProperty.guid` (there is no `.id`).
   * Returns '' when the field can't be named — callers then fall back to the
   * name-based property scan so headers never show a raw field id.
   */
  resolvePropertyNameFromRecord(record, propertyId) {
    const id = propertyId == null ? '' : String(propertyId).trim();
    if (!record || !id) return '';

    const readFrom = (props) => {
      for (const prop of props || []) {
        const propGuid = String(prop?.guid || '').trim();
        if (propGuid && propGuid === id) {
          const name = (prop?.name || '').trim();
          if (name) return name;
        }
      }
      return '';
    };

    try {
      const name = readFrom(record.getAllProperties?.() || []);
      if (name) return name;
    } catch (e) {
      // ignore
    }

    try {
      const props = typeof record.getProperties === 'function' ? record.getProperties(null) : [];
      const name = readFrom(props);
      if (name) return name;
    } catch (e) {
      // ignore
    }

    return '';
  }

  mergePropertyBacklinkGroups(base, extra) {
    const byName = new Map();
    for (const group of [...(base || []), ...(extra || [])]) {
      const name = group?.propertyName || '';
      if (!name) continue;
      let bucket = byName.get(name) || null;
      if (!bucket) {
        bucket = new Map();
        byName.set(name, bucket);
      }
      for (const record of group?.records || []) {
        const guid = record?.guid || '';
        if (guid && !bucket.has(guid)) bucket.set(guid, record);
      }
    }

    const groups = Array.from(byName.entries()).map(([propertyName, recordMap]) => ({
      propertyName,
      records: Array.from(recordMap.values())
    }));

    groups.sort((a, b) => {
      const an = (a.propertyName || '').toLowerCase();
      const bn = (b.propertyName || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.records.sort((a, b) => {
        const ad = a?.getUpdatedAt?.() || null;
        const bd = b?.getUpdatedAt?.() || null;
        const at = ad ? ad.getTime() : 0;
        const bt = bd ? bd.getTime() : 0;
        if (bt !== at) return bt - at;
        const an = (a?.getName?.() || '').toLowerCase();
        const bn = (b?.getName?.() || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }

    return groups;
  }

  buildPropertyGroupsFromDetailedRefs(refs, targetGuid, { showSelf } = {}) {
    const byProp = new Map();
    const unresolved = new Map();

    for (const ref of refs || []) {
      if (ref?.kind && ref.kind !== 'property') continue;
      const src = ref?.record || null;
      const srcGuid = src?.guid || '';
      if (!srcGuid) continue;
      if (!showSelf && srcGuid === targetGuid) continue;
      if (this.isExcludedSourceRecord(src)) continue;

      const propName = this.resolvePropertyNameFromRecord(src, ref?.propertyId);
      if (!propName) {
        // Unknown field id — let the name-based scan label this record's groups.
        if (!unresolved.has(srcGuid)) unresolved.set(srcGuid, src);
        continue;
      }

      let group = byProp.get(propName) || null;
      if (!group) {
        group = new Map();
        byProp.set(propName, group);
      }
      group.set(srcGuid, src);
    }

    const resolvedGroups = Array.from(byProp.entries()).map(([propertyName, recordMap]) => ({
      propertyName,
      records: Array.from(recordMap.values())
    }));

    const fallbackGroups = unresolved.size > 0
      ? this.buildPropertyBacklinkGroupsFromRecords(
          Array.from(unresolved.values()),
          targetGuid,
          { showSelf }
        )
      : [];

    return this.mergePropertyBacklinkGroups(resolvedGroups, fallbackGroups);
  }

  indexLineItemsByGuid(items, into = null) {
    const map = into || new Map();
    const walk = (arr) => {
      for (const item of arr || []) {
        const guid = item?.guid || '';
        if (guid) map.set(guid, item);
        const children = item?.children;
        if (Array.isArray(children) && children.length) walk(children);
      }
    };
    walk(items);
    return map;
  }

  async buildLinkedGroupsFromDetailedRefs(refs, targetGuid, { showSelf, maxResults } = {}) {
    const bySource = new Map();
    for (const ref of refs || []) {
      if (ref?.kind && ref.kind !== 'line') continue;
      const record = ref?.record || null;
      const srcGuid = record?.guid || '';
      if (!srcGuid) continue;
      if (!showSelf && srcGuid === targetGuid) continue;
      if (this.isExcludedSourceRecord(record)) continue;
      const lineGuid = (ref?.lineItemGuid || '').trim();
      if (!lineGuid) continue;
      let entry = bySource.get(srcGuid);
      if (!entry) {
        entry = { record, lineGuids: new Set() };
        bySource.set(srcGuid, entry);
      }
      entry.lineGuids.add(lineGuid);
    }

    const lines = [];
    for (const { record, lineGuids } of bySource.values()) {
      let items = [];
      try {
        items = (await record.getLineItems?.()) || [];
      } catch (e) {
        items = [];
      }
      const byGuid = this.indexLineItemsByGuid(items);
      for (const lineGuid of lineGuids) {
        const line = byGuid.get(lineGuid) || null;
        if (line) {
          if (!line.record) {
            try { line.record = record; } catch (e) { /* ignore */ }
          }
          lines.push(line);
        } else {
          lines.push({
            guid: lineGuid,
            record,
            segments: [],
            getCreatedAt: () => null,
            getUpdatedAt: () => null
          });
        }
        if (maxResults && lines.length >= maxResults) break;
      }
      if (maxResults && lines.length >= maxResults) break;
    }

    return this.groupBacklinkLines(lines, targetGuid, { showSelf });
  }

  /**
   * Primary host-index path for linked + property refs.
   * @returns {null|object} null when SDK APIs are unavailable
   */
  async loadHostIndexedReferenceBundle(targetRecord, targetGuid, { showSelf, maxResults } = {}) {
    if (!this.hostBackReferencesAvailable(targetRecord)) return null;
    this.noteSdkPropertyBacklinksFromRecord(targetRecord);

    const startedAt = new Date();
    const stats = {
      ...this.createEmptyPropertyIndexStats(),
      reason: 'sdk-getBackReferences',
      startedAt,
      finishedAt: null
    };

    try {
      const refs = await this.fetchDetailedBackReferences(targetRecord);
      if (refs === null) return null;

      stats.scannedRecords = refs.length;
      let propertyGroups = this.buildPropertyGroupsFromDetailedRefs(refs, targetGuid, { showSelf });
      let linkedGroups = await this.buildLinkedGroupsFromDetailedRefs(refs, targetGuid, {
        showSelf,
        maxResults
      });
      let linkedError = '';

      // Host getBackReferences() can return [] for journal days even when body links
      // exist (built-in backlinks still shows them). Fall back to @linkto search.
      if (!this.countLinkedReferences(linkedGroups)) {
        const searchSettled = await this.runLinkedReferenceSearch(targetGuid, maxResults, {
          targetRecord
        });
        const searched = this.resolveLinkedReferenceSearch(searchSettled, targetGuid, { showSelf });
        if (searched.linkedGroups?.length) {
          linkedGroups = searched.linkedGroups;
          stats.reason = refs.length
            ? 'sdk-getBackReferences+linkto'
            : 'linkto-search';
        } else if (searched.linkedError) {
          linkedError = searched.linkedError;
        }
      }

      // Journal days: When-style dates aren't links, so getBackReferences is empty.
      // Fold in `@date` record hits as property groups (same index Today's Notes uses).
      const dateGroups = await this.loadDatePropertyBacklinkGroups(targetRecord, targetGuid, {
        showSelf,
        maxResults
      });
      if (dateGroups.length) {
        propertyGroups = this.mergePropertyBacklinkGroups(propertyGroups, dateGroups);
        if (stats.reason === 'sdk-getBackReferences') {
          stats.reason = refs.length
            ? 'sdk-getBackReferences+date'
            : 'date-search-journal';
        } else if (stats.reason === 'linkto-search') {
          stats.reason = 'linkto+date-search';
        } else if (stats.reason === 'sdk-getBackReferences+linkto') {
          stats.reason = 'sdk-getBackReferences+linkto+date';
        }
      }

      stats.indexedReferences = propertyGroups.reduce(
        (total, group) => total + (group?.records?.length || 0),
        0
      );
      stats.indexedTargets = stats.indexedReferences > 0 ? 1 : 0;
      stats.finishedAt = new Date();

      return {
        linkedGroups,
        linkedError,
        propertyGroups,
        propertyError: '',
        propertyIndexStatus: 'ready',
        propertyIndexStats: stats,
        propertyIndexError: '',
        fromHostIndex: true
      };
    } catch (e) {
      console.warn('[Backreferences] host getBackReferences failed; falling back to search/index', e);
      return null;
    }
  }

  async loadPropertyBacklinkResult(targetRecord, targetGuid, { showSelf } = {}) {
    const guid = (targetGuid || targetRecord?.guid || '').trim();
    if (!this.noteSdkPropertyBacklinksFromRecord(targetRecord)) {
      const indexed = this.getPropertyBacklinkResult(guid, { showSelf });
      const dateGroups = await this.loadDatePropertyBacklinkGroups(targetRecord, guid, { showSelf });
      if (!dateGroups.length) return indexed;
      return {
        ...indexed,
        propertyGroups: this.mergePropertyBacklinkGroups(indexed.propertyGroups, dateGroups),
        propertyIndexStatus: 'ready'
      };
    }

    const startedAt = new Date();
    const stats = {
      ...this.createEmptyPropertyIndexStats(),
      reason: 'sdk-backreferences',
      startedAt,
      finishedAt: null
    };

    if (!guid) {
      return {
        propertyGroups: [],
        propertyError: '',
        propertyIndexStatus: 'ready',
        propertyIndexStats: { ...stats, finishedAt: new Date() },
        propertyIndexError: ''
      };
    }

    try {
      const refs = await this.fetchDetailedBackReferences(targetRecord);
      let propertyGroups = [];
      if (Array.isArray(refs)) {
        stats.scannedRecords = refs.length;
        propertyGroups = this.buildPropertyGroupsFromDetailedRefs(refs, guid, { showSelf });
      } else {
        const candidateRecords = await this.getPropertyBacklinkCandidateRecords(targetRecord);
        stats.scannedRecords = candidateRecords.length;
        propertyGroups = this.buildPropertyBacklinkGroupsFromRecords(candidateRecords, guid, { showSelf });
      }

      const dateGroups = await this.loadDatePropertyBacklinkGroups(targetRecord, guid, { showSelf });
      if (dateGroups.length) {
        propertyGroups = this.mergePropertyBacklinkGroups(propertyGroups, dateGroups);
        stats.reason = 'sdk-backreferences+date';
      }

      stats.indexedReferences = propertyGroups.reduce(
        (total, group) => total + (group?.records?.length || 0),
        0
      );
      stats.indexedTargets = stats.indexedReferences > 0 ? 1 : 0;
      stats.finishedAt = new Date();
      return {
        propertyGroups,
        propertyError: '',
        propertyIndexStatus: 'ready',
        propertyIndexStats: stats,
        propertyIndexError: ''
      };
    } catch (e) {
      stats.finishedAt = new Date();
      return {
        propertyGroups: [],
        propertyError: '',
        propertyIndexStatus: 'error',
        propertyIndexStats: stats,
        propertyIndexError: this.getPropertyBacklinkErrorMessage(e)
      };
    }
  }

  snapshotIncludesSourceRecord(state, recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return false;
    return state?.liveCurrentSnapshot?.sourceRecordGuids?.has?.(guid) === true;
  }

  // ---------- Refresh orchestration ----------

  isUserEditingRecordBody(panel) {
    if (!panel) return false;
    try {
      const panelEl = panel.getElement?.() || null;
      if (!panelEl || typeof document === 'undefined') return false;
      const active = document.activeElement;
      if (!active || active === document.body) return false;
      if (!panelEl.contains(active)) return false;
      if (active.isContentEditable === true) return true;
      const tag = active.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const type = String(active.type || '').toLowerCase();
        if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'reset' || type === 'file') {
          return false;
        }
        return true;
      }
      return false;
    } catch (_) {
      return false;
    }
  }

  scheduleRefreshForPanel(panel, { force, reason, debounceMs } = {}) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    if (this.inMobileLoadGrace() && force !== true) {
      const state = this._panelStates.get(panelId) || this.getOrCreatePanelState(panel);
      if (state) {
        state._backrefsDeferredWork = true;
        this._scheduleMobileGraceDrain();
      }
      return;
    }
    if (!this.isPanelVisible(panel)) {
      const hiddenState = this._panelStates.get(panelId) || null;
      if (hiddenState) this.unmountFooterForHiddenPanel(hiddenState);
      return;
    }
    let state = this._panelStates.get(panelId) || null;
    if (!state) state = this.getOrCreatePanelState(panel);
    if (!state) return;
    if (force !== true && !this._shouldLoadBackrefsData(state)) {
      return;
    }

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    const delay = force
      ? 0
      : (Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : this._refreshDebounceMs);
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      if (!force && this.isUserEditingRecordBody(panel)) {
        this.scheduleRefreshForPanel(panel, {
          force: false,
          reason: reason || 'deferred-while-typing',
          debounceMs: this._typingIdleRefreshMs,
        });
        return;
      }
      this.refreshPanel(panelId, { reason: reason || 'scheduled', force }).catch(() => {
        // ignore
      });
    }, delay);
  }

  refreshAllPanels({ force, reason }) {
    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel) continue;
      this.scheduleRefreshForPanel(panel, { force: force === true, reason: reason || 'all' });
    }
  }

  getRefreshConfig() {
    const cfg = this.getConfiguration?.() || {};
    const maxResults = this.coercePositiveInt(cfg.custom?.maxResults, this._defaultMaxResults);
    return {
      maxResults,
      queryFilterMaxResults: this.coercePositiveInt(
        cfg.custom?.queryFilterMaxResults,
        Math.max(this._defaultQueryFilterMaxResults, maxResults)
      ),
      showSelf: cfg.custom?.showSelf === true
    };
  }

  isRefreshStateCurrent(panelId, state, seq) {
    if (!panelId || !state) return false;
    if (!this._panelStates.has(panelId)) return false;
    return state.refreshSeq === seq;
  }

  normalizeDateToIso(value) {
    if (!value) return '';

    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return [
        this.padDateTimeNumber(value.getFullYear(), 4),
        this.padDateTimeNumber(value.getMonth() + 1, 2),
        this.padDateTimeNumber(value.getDate(), 2)
      ].join('-');
    }

    if (typeof value === 'string') {
      const compact = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
      const dashed = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
      return '';
    }

    if (value && typeof value === 'object') {
      const source = value.value && typeof value.value === 'object'
        ? value.value
        : value;
      return this.formatDateTimeDate(
        typeof source.d === 'string' ? source.d
          : typeof source.date === 'string' ? source.date
            : source
      );
    }

    return '';
  }

  parseDateIsoFromRecordTitle(recordName) {
    const title = typeof recordName === 'string'
      ? recordName.trim().replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
      : '';
    if (!title) return '';

    const direct = this.normalizeDateToIso(title);
    if (direct) return direct;

    const months = {
      jan: 1, january: 1,
      feb: 2, february: 2,
      mar: 3, march: 3,
      apr: 4, april: 4,
      may: 5,
      jun: 6, june: 6,
      jul: 7, july: 7,
      aug: 8, august: 8,
      sep: 9, sept: 9, september: 9,
      oct: 10, october: 10,
      nov: 11, november: 11,
      dec: 12, december: 12
    };
    const monthFirst = title.match(/^(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    const dayFirst = title.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
    const match = monthFirst || dayFirst;
    if (!match) return '';

    const monthName = (monthFirst ? match[1] : match[2]).toLowerCase();
    const month = months[monthName] || 0;
    const day = Number(monthFirst ? match[2] : match[1]);
    const year = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(day) || month <= 0 || day <= 0 || day > 31) return '';
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return '';
    return `${this.padDateTimeNumber(year, 4)}-${this.padDateTimeNumber(month, 2)}-${this.padDateTimeNumber(day, 2)}`;
  }

  getRecordDateReferenceIso(record) {
    if (!record) return '';

    try {
      const details = typeof record.getJournalDetails === 'function' ? record.getJournalDetails() : null;
      const journalDate = this.normalizeDateToIso(details?.date || null);
      if (journalDate) return journalDate;
    } catch (e) {
      // Fall back to parsing date-like page titles below.
    }

    // Synthetic journal GUIDs end in -YYYYMMDD even when getJournalDetails is absent.
    const guid = (record?.guid || '').trim();
    const guidMatch = guid.match(/(?:^|-)(\d{8})$/);
    if (guidMatch) {
      const raw = guidMatch[1];
      const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      if (this.normalizeDateToIso(iso)) return iso;
    }

    return this.parseDateIsoFromRecordTitle(record.getName?.() || '');
  }

  /**
   * Date properties that land on `dateIso`. Prefer named When/Date fields; fall back to any
   * datetime property on that day. Used for journal-page backlinks, where `getBackReferences`
   * returns nothing because a When datetime is not a link.
   */
  getMatchingDatePropertyNames(record, dateIso) {
    const iso = this.normalizeDateToIso(dateIso);
    if (!record || !iso) return [];

    const preferred = [];
    const other = [];
    let props = [];
    try {
      props = record.getAllProperties?.() || [];
    } catch (e) {
      props = [];
    }

    for (const prop of props) {
      const name = (prop?.name || '').trim();
      if (!name) continue;
      let dateVal = null;
      try {
        if (typeof prop.date === 'function') dateVal = prop.date();
      } catch (e) {
        dateVal = null;
      }
      if (!(dateVal instanceof Date) || Number.isNaN(dateVal.getTime())) continue;
      if (this.normalizeDateToIso(dateVal) !== iso) continue;
      if (/^(when|date)$/i.test(name)) preferred.push(name);
      else other.push(name);
    }

    return preferred.length ? preferred : other;
  }

  isJournalLikeRecord(record) {
    if (!record) return false;
    try {
      if (typeof record.getJournalDetails === 'function') {
        const details = record.getJournalDetails();
        if (details?.date) return true;
      }
    } catch (e) {
      // ignore
    }
    return /(?:^|-)S-.*-\d{8}$/.test((record.guid || '').trim())
      || /-\d{8}$/.test((record.guid || '').trim());
  }

  /**
   * `@date` search finds records whose date properties match a journal day. Host
   * `getBackReferences()` does not — those hits are property refs, not line links.
   */
  async loadDatePropertyBacklinkGroups(targetRecord, targetGuid, { showSelf, maxResults } = {}) {
    const dateIso = this.getRecordDateReferenceIso(targetRecord);
    if (!dateIso) return [];

    const limit = Math.max(50, Number(maxResults) || 200);
    let result = null;
    try {
      result = await this.data.searchByQuery(`@date = "${dateIso}"`, limit);
    } catch (e) {
      return [];
    }
    if (result?.error) return [];

    const records = Array.isArray(result?.records) ? result.records : [];
    if (!records.length) return [];

    const byProp = new Map();
    for (const src of records) {
      const srcGuid = src?.guid || '';
      if (!srcGuid) continue;
      if (!showSelf && srcGuid === targetGuid) continue;
      if (this.isJournalLikeRecord(src)) continue;
      if (this.isExcludedSourceRecord(src)) continue;

      const propNames = this.getMatchingDatePropertyNames(src, dateIso);
      const names = propNames.length ? propNames : ['When'];
      for (const propName of names) {
        let group = byProp.get(propName) || null;
        if (!group) {
          group = new Map();
          byProp.set(propName, group);
        }
        group.set(srcGuid, src);
      }
    }

    return Array.from(byProp.entries()).map(([propertyName, recordMap]) => ({
      propertyName,
      records: Array.from(recordMap.values())
    }));
  }

  getLinkedReferenceSearchSpecs(recordGuid, targetRecord) {
    const guid = (recordGuid || '').trim();
    if (!guid) return [];

    const specs = [{ kind: 'linkto', query: `@linkto = "${guid}"` }];
    const dateIso = this.getRecordDateReferenceIso(targetRecord);
    if (dateIso) {
      specs.push({ kind: 'datetime', query: `@date = "${dateIso}"`, dateIso });
    }
    return specs;
  }

  async runLinkedReferenceSearch(recordGuid, maxResults, { targetRecord } = {}) {
    const specs = this.getLinkedReferenceSearchSpecs(recordGuid, targetRecord);
    const searches = await Promise.all(specs.map(async (spec) => {
      try {
        return {
          ...spec,
          status: 'fulfilled',
          value: await this.data.searchByQuery(spec.query, maxResults)
        };
      } catch (e) {
        return {
          ...spec,
          status: 'rejected',
          reason: e
        };
      }
    }));

    return {
      status: 'fulfilled',
      value: { searches }
    };
  }

  mergeLinkedReferenceSearchLines(searches) {
    const lines = [];
    const seenLineGuids = new Set();

    for (const search of searches || []) {
      if (search?.status !== 'fulfilled' || search?.value?.error) continue;
      for (const line of search.value?.lines || []) {
        const guid = line?.guid || '';
        if (guid && seenLineGuids.has(guid)) continue;
        const sourceRecord = line?.record || null;
        if (sourceRecord && this.isExcludedSourceRecord(sourceRecord)) continue;
        if (guid) seenLineGuids.add(guid);
        lines.push(line);
      }
    }

    return lines;
  }

  resolveLinkedReferenceSearch(searchSettled, recordGuid, { showSelf }) {
    let linkedError = '';
    let linkedGroups = [];

    if (searchSettled?.status === 'fulfilled') {
      const searches = Array.isArray(searchSettled.value?.searches)
        ? searchSettled.value.searches
        : [{ kind: 'linkto', status: 'fulfilled', value: searchSettled.value }];
      const primarySearch = searches.find((search) => search?.kind === 'linkto') || searches[0] || null;
      const primaryResult = primarySearch?.value || null;
      if (primarySearch?.status === 'rejected') {
        linkedError = 'Error loading linked references.';
      } else if (primaryResult?.error) {
        linkedError = primaryResult.error;
      } else {
        const lines = this.mergeLinkedReferenceSearchLines(searches);
        linkedGroups = this.groupBacklinkLines(lines, recordGuid, { showSelf });
      }
    } else {
      linkedError = 'Error loading linked references.';
    }

    return { linkedError, linkedGroups };
  }

  buildLiteralPhraseSearchQuery(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\s+/g, ' ');
    return `"${escaped}"`;
  }

  shouldIncludeMentionAlias(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return true;
    if (/^[A-Z0-9]{2,8}$/.test(text)) return true;
    return text.length >= 8;
  }

  getRecordMentionPhrases(recordName) {
    const out = [];
    const seen = new Set();

    const add = (value) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };

    const title = typeof recordName === 'string' ? recordName.trim() : '';
    if (!title) return out;

    add(title);

    const parentheticalMatch = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (parentheticalMatch) {
      const baseTitle = parentheticalMatch[1].trim();
      const alias = parentheticalMatch[2].trim();
      add(baseTitle);
      if (this.shouldIncludeMentionAlias(alias)) add(alias);
    }

    for (const separator of [' / ', ' | ']) {
      if (!title.includes(separator)) continue;
      const parts = title.split(separator).map((part) => part.trim()).filter(Boolean);
      for (const part of parts) {
        if (this.shouldIncludeMentionAlias(part)) add(part);
      }
    }

    return out;
  }

  getUnlinkedSearchPhrases(recordName) {
    const out = [];
    const seen = new Set();

    const add = (value) => {
      const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };

    for (const phrase of this.getRecordMentionPhrases(recordName)) {
      add(phrase);

      if (/[\/|:_\-\u2010-\u2015]/.test(phrase)) {
        const normalized = this.getPhraseBoundaryTokens(phrase).join(' ');
        if (normalized && normalized.toLowerCase() !== phrase.toLowerCase()) add(normalized);
      }
    }

    return out.slice(0, 6);
  }

  buildUnlinkedSearchQuery(recordName) {
    const phrases = this.getUnlinkedSearchPhrases(recordName)
      .map((phrase) => this.buildLiteralPhraseSearchQuery(phrase))
      .filter(Boolean);
    if (phrases.length === 0) return '';
    if (phrases.length === 1) return phrases[0];
    return phrases.join(' OR ');
  }

  async loadUnlinkedReferenceGroups(recordName, maxResults, { recordGuid, linkedGroups, showSelf }) {
    try {
      const query = this.buildUnlinkedSearchQuery(recordName) || this.buildLiteralPhraseSearchQuery(recordName) || recordName;
      const result = await this.data.searchByQuery(query, maxResults);
      if (result?.error) {
        return { unlinkedError: result.error, unlinkedGroups: [] };
      }

      const lines = Array.isArray(result?.lines) ? result.lines : [];
      return {
        unlinkedError: '',
        unlinkedGroups: this.groupUnlinkedReferenceLines(lines, linkedGroups, recordGuid, recordName, { showSelf })
      };
    } catch (e) {
      return {
        unlinkedError: 'Error loading unlinked references.',
        unlinkedGroups: []
      };
    }
  }

  async loadFollowupReferenceResults(state, record, {
    recordGuid,
    recordName,
    maxResults,
    showSelf,
    linkedGroups
  }) {
    const shouldLoadUnlinked = Boolean(recordName) && !this.isSectionCollapsed(state, 'unlinked');
    const propertyResult = await this.loadPropertyBacklinkResult(record, recordGuid, { showSelf });
    const followupPromises = [
      Promise.resolve(propertyResult)
    ];

    if (shouldLoadUnlinked) {
      followupPromises.push(
        this.loadUnlinkedReferenceGroups(recordName, maxResults, {
          recordGuid,
          linkedGroups,
          showSelf
        })
      );
    }

    const [propertySettled, unlinkedSettled] = await Promise.allSettled(followupPromises);

    let propertyError = '';
    let propertyGroups = [];
    if (propertySettled.status === 'fulfilled') {
      propertyError = propertySettled.value?.propertyError || '';
      propertyGroups = Array.isArray(propertySettled.value?.propertyGroups)
        ? propertySettled.value.propertyGroups
        : [];
    } else {
      propertyError = 'Error loading property references.';
    }

    const unlinkedDeferred = Boolean(recordName) && !shouldLoadUnlinked;
    let unlinkedError = '';
    let unlinkedGroups = [];
    if (recordName && shouldLoadUnlinked) {
      if (unlinkedSettled.status === 'fulfilled') {
        unlinkedError = unlinkedSettled.value?.unlinkedError || '';
        unlinkedGroups = Array.isArray(unlinkedSettled.value?.unlinkedGroups)
          ? unlinkedSettled.value.unlinkedGroups
          : [];
      } else {
        unlinkedError = 'Error loading unlinked references.';
      }
    }

    return {
      propertyError,
      propertyGroups,
      propertyIndexStatus: propertySettled.status === 'fulfilled'
        ? propertySettled.value?.propertyIndexStatus || 'idle'
        : 'error',
      propertyIndexStats: propertySettled.status === 'fulfilled'
        ? propertySettled.value?.propertyIndexStats || this.createEmptyPropertyIndexStats()
        : this.createEmptyPropertyIndexStats(),
      propertyIndexError: propertySettled.status === 'fulfilled'
        ? propertySettled.value?.propertyIndexError || ''
        : 'Error loading property references.',
      unlinkedError,
      unlinkedGroups,
      unlinkedDeferred,
      unlinkedLoading: false,
      maxResults
    };
  }

  applyRefreshedResults(state, results, { reason } = {}) {
    state.lastResults = results;
    if (!this.isPanelVisible(state?.panel || null)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }
    this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: reason || 'refresh' });
    this.applyLiveSnapshot(state, this.buildResultsSnapshot(results.propertyGroups, results.linkedGroups));
    this.invalidateLinkedContextCache(state);
    this.renderFromCache(state);
    this.scheduleContextAvailabilityPreload(state, results, { reason: reason || 'refresh' });
    if (state.lastResults?.unlinkedDeferred === true && !this.isSectionCollapsed(state, 'unlinked')) {
      this.ensureDeferredUnlinkedLoaded(state).catch(() => {
        // ignore
      });
    }
  }

  scheduleContextAvailabilityPreload(state, results, { reason } = {}) {
    if (!state || !results) return;
    if (!this.isPanelVisible(state.panel || null)) return;
    if (state.contextPreloadTimer) {
      clearTimeout(state.contextPreloadTimer);
      state.contextPreloadTimer = null;
    }

    const seq = (state.contextPreloadSeq || 0) + 1;
    state.contextPreloadSeq = seq;
    state.contextPreloadTimer = setTimeout(() => {
      state.contextPreloadTimer = null;
      this.preloadContextAvailability(state.panelId, seq, results, { reason }).catch(() => {
        // Context availability is opportunistic; failed preloads should not disrupt the panel.
      });
    }, 0);
  }

  collectContextPreloadLines(results) {
    const out = [];
    const seen = new Set();
    const appendGroups = (groups) => {
      for (const group of groups || []) {
        for (const line of group?.lines || []) {
          const guid = line?.guid || '';
          if (!guid || seen.has(guid)) continue;
          if (typeof line?.getTreeContext !== 'function') continue;
          seen.add(guid);
          out.push(line);
        }
      }
    };

    appendGroups(results?.linkedGroups || []);
    if (results?.unlinkedDeferred !== true && results?.unlinkedLoading !== true) {
      appendGroups(results?.unlinkedGroups || []);
    }
    return out;
  }

  async preloadContextAvailability(panelId, seq, results) {
    const state = this._panelStates.get(panelId) || null;
    if (!state || state.contextPreloadSeq !== seq || state.lastResults !== results) return;

    for (const line of this.collectContextPreloadLines(results)) {
      if (!this._panelStates.has(panelId)) return;
      if (state.contextPreloadSeq !== seq || state.lastResults !== results) return;
      const ctx = this.getLinkedContextState(state, line?.guid || null);
      if (!ctx || ctx.loaded === true || ctx.loading === true) continue;
      await this.ensureLinkedContextLoaded(state, line, { background: true });
    }
  }

  async refreshPanel(panelId, { reason, force } = {}) {
    const state = this._panelStates.get(panelId) || null;
    const panel = state?.panel || null;
    if (!state || !panel) return;

    const record = panel.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;
    if (!recordGuid) return;

    if (!force && this.isUserEditingRecordBody(panel)) {
      this.scheduleRefreshForPanel(panel, {
        force: false,
        reason: reason || 'deferred-while-typing',
        debounceMs: this._typingIdleRefreshMs,
      });
      return;
    }

    this.noteSdkPropertyBacklinksFromRecord(record);

    // Keep state in sync in case of churn.
    state.recordGuid = recordGuid;

    if (!this.isPanelVisible(panel)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    if (!state.rootEl || !state.rootEl.isConnected) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;

    const seq = (state.refreshSeq || 0) + 1;
    state.refreshSeq = seq;

    const showLoading = force === true || !this.isUserEditingRecordBody(panel);
    if (showLoading) this.setLoadingState(state, true);

    try {
      const { maxResults, showSelf } = this.getRefreshConfig();
      const recordName = (record?.getName?.() || '').trim();

      let linkedError = '';
      let linkedGroups = [];
      let hostBundle = null;

      if (this.hostBackReferencesAvailable(record)) {
        hostBundle = await this.loadHostIndexedReferenceBundle(record, recordGuid, {
          showSelf,
          maxResults
        });
      }

      if (!this.isRefreshStateCurrent(panelId, state, seq)) return;

      if (hostBundle) {
        linkedGroups = Array.isArray(hostBundle.linkedGroups) ? hostBundle.linkedGroups : [];
        linkedError = hostBundle.linkedError || '';

        const shouldLoadUnlinked = Boolean(recordName) && !this.isSectionCollapsed(state, 'unlinked');
        let unlinkedError = '';
        let unlinkedGroups = [];
        const unlinkedDeferred = Boolean(recordName) && !shouldLoadUnlinked;
        if (shouldLoadUnlinked) {
          const unlinked = await this.loadUnlinkedReferenceGroups(recordName, maxResults, {
            recordGuid,
            linkedGroups,
            showSelf
          });
          if (!this.isRefreshStateCurrent(panelId, state, seq)) return;
          unlinkedError = unlinked.unlinkedError || '';
          unlinkedGroups = Array.isArray(unlinked.unlinkedGroups) ? unlinked.unlinkedGroups : [];
        }

        this.applyRefreshedResults(state, {
          propertyError: hostBundle.propertyError || '',
          propertyGroups: Array.isArray(hostBundle.propertyGroups) ? hostBundle.propertyGroups : [],
          propertyIndexStatus: hostBundle.propertyIndexStatus || 'ready',
          propertyIndexStats: hostBundle.propertyIndexStats || null,
          propertyIndexError: hostBundle.propertyIndexError || '',
          linkedGroups,
          linkedError,
          unlinkedGroups,
          unlinkedError,
          unlinkedDeferred,
          unlinkedLoading: false
        }, { reason: reason || 'refresh-host-index' });
      } else {
        const searchSettled = await this.runLinkedReferenceSearch(recordGuid, maxResults, {
          targetRecord: record
        });

        if (!this.isRefreshStateCurrent(panelId, state, seq)) return;

        ({ linkedError, linkedGroups } = this.resolveLinkedReferenceSearch(
          searchSettled,
          recordGuid,
          { showSelf }
        ));

        const followupResults = await this.loadFollowupReferenceResults(state, record, {
          recordGuid,
          recordName,
          maxResults,
          showSelf,
          linkedGroups
        });

        if (!this.isRefreshStateCurrent(panelId, state, seq)) return;

        this.applyRefreshedResults(state, {
          ...followupResults,
          linkedGroups,
          linkedError
        }, { reason: reason || 'refresh' });
      }
    } finally {
      if (showLoading && this.isRefreshStateCurrent(panelId, state, seq)) {
        this.setLoadingState(state, false);
      }
    }
  }

  /**
   * Per-panel lineitem scheduling — see docs/EXPANDABLE_PREVIEW_PATTERN.md §7.
   * Skips the open record; debounces known sources lightly; only fast-refreshes when a new [[ref]] hits this page.
   */
  filterAndScheduleLineEvent(ev, segments, reason) {
    const editedRecordGuid = this.getEventRecordGuid(ev);
    const referencedGuids = this.extractReferencedRecordGuids(segments);

    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel || !state?.recordGuid) continue;

      const targetGuid = (state.recordGuid || '').trim();
      if (!targetGuid) continue;
      if (editedRecordGuid && editedRecordGuid === targetGuid) continue;

      const hitsTargetRecord = referencedGuids instanceof Set && referencedGuids.has(targetGuid);
      const hitsKnownSource = editedRecordGuid
        ? this.snapshotIncludesSourceRecord(state, editedRecordGuid)
        : false;
      if (!hitsTargetRecord && !hitsKnownSource) continue;

      this.markStatePendingRemote(state, ev);
      const debounceMs = hitsTargetRecord
        ? this._refreshDebounceMs
        : this._knownSourceRefreshDebounceMs;
      this.scheduleRefreshForPanel(panel, { force: false, reason: reason || 'lineitem', debounceMs });
    }
  }

  async ensureDeferredUnlinkedLoaded(state) {
    const results = state?.lastResults || null;
    if (!state || !results) return;
    if (results.unlinkedDeferred !== true) return;
    if (results.unlinkedLoading === true) return;

    const panel = state.panel || null;
    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || state.recordGuid || null;
    const recordName = (record?.getName?.() || '').trim();
    if (!recordGuid || !recordName) return;

    const seq = state.refreshSeq || 0;
    results.unlinkedLoading = true;
    results.unlinkedError = '';
    this.renderFromCache(state);

    const { maxResults, showSelf } = this.getRefreshConfig();
    const { unlinkedGroups: nextGroups, unlinkedError: nextError } = await this.loadUnlinkedReferenceGroups(
      recordName,
      maxResults,
      {
        recordGuid,
        linkedGroups: Array.isArray(results.linkedGroups) ? results.linkedGroups : [],
        showSelf
      }
    );

    if (!this._panelStates.has(state.panelId)) return;
    if (state.lastResults !== results) return;
    if (state.refreshSeq !== seq) return;
    if ((state.recordGuid || '') !== recordGuid) return;

    results.unlinkedGroups = nextGroups;
    results.unlinkedError = nextError;
    results.unlinkedDeferred = false;
    results.unlinkedLoading = false;
    this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: 'deferred-unlinked-loaded' });
    this.renderFromCache(state);
    this.scheduleContextAvailabilityPreload(state, results, { reason: 'deferred-unlinked-loaded' });
  }

  setLoadingState(state, isLoading) {
    if (!state?.rootEl) return;
    state.isLoading = isLoading === true;
    state.rootEl.classList.toggle('tlr-loading', isLoading === true);
  }

  // ---------- Event-driven freshness ----------

  getEventRecordGuid(ev) {
    const guid = typeof ev?.recordGuid === 'string'
      ? ev.recordGuid
      : (typeof ev?.guid === 'string' ? ev.guid : '');
    return guid.trim();
  }

  getEventLineSegments(ev) {
    if (!ev) return [];
    if (ev?.hasSegments?.() && typeof ev.getSegments === 'function') {
      return ev.getSegments() || [];
    }
    if (Array.isArray(ev?.segments)) return ev.segments;
    if (Array.isArray(ev?.rawSegments)) return ev.rawSegments;
    return [];
  }

  getStateRecordName(state) {
    return (state?.panel?.getActiveRecord?.()?.getName?.() || '').trim();
  }

  getStateRecordDateReferenceIso(state) {
    const record = state?.panel?.getActiveRecord?.()
      || this.data.getRecord?.(state?.recordGuid || '')
      || null;
    return this.getRecordDateReferenceIso(record);
  }

  recordReferencesGuid(record, targetGuid) {
    const guid = (targetGuid || '').trim();
    if (!guid || !record || typeof record.getAllProperties !== 'function') return false;
    const props = record.getAllProperties() || [];
    for (const prop of props) {
      if (this.propertyReferencesGuid(prop, guid)) return true;
    }
    return false;
  }

  refreshMatchingStates(ev, reason, matcher) {
    const match = typeof matcher === 'function' ? matcher : null;
    let refreshed = 0;

    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel || !state?.recordGuid) continue;
      if (match && match(state) !== true) continue;

      this.markStatePendingRemote(state, ev);
      this.scheduleRefreshForPanel(panel, { force: false, reason: reason || 'workspace-invalidated' });
      refreshed += 1;
    }

    return refreshed;
  }

  recordEventAffectsState(state, sourceRecordGuid, sourceRecord) {
    const targetGuid = (state?.recordGuid || '').trim();
    if (!targetGuid) return false;
    // Same as lineitem: body/property saves on the open page do not change incoming backlinks.
    if (sourceRecordGuid && sourceRecordGuid === targetGuid) return false;
    if (sourceRecordGuid && this.snapshotIncludesSourceRecord(state, sourceRecordGuid)) return true;
    if (sourceRecord && this.recordReferencesGuid(sourceRecord, targetGuid)) return true;
    return false;
  }

  lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids } = {}) {
    const targetGuid = (state?.recordGuid || '').trim();
    if (!targetGuid) return false;
    // Body/format edits on the open record cannot change who backlinks *to* this page.
    // Refreshing here caused editor caret jumps (typing, Cmd+I, etc.) — see docs/EXPANDABLE_PREVIEW_PATTERN.md §7.
    if (sourceRecordGuid && sourceRecordGuid === targetGuid) return false;
    if (sourceRecordGuid && this.snapshotIncludesSourceRecord(state, sourceRecordGuid)) return true;
    if (referencedGuids instanceof Set && referencedGuids.has(targetGuid)) return true;

    const targetDateIso = this.getStateRecordDateReferenceIso(state);
    if (targetDateIso && Array.isArray(segments) && segments.length > 0) {
      if (this.lineHasDateTimeForDate({ segments }, targetDateIso)) return true;
    }

    const targetName = this.getStateRecordName(state);
    if (targetName && Array.isArray(segments) && segments.length > 0) {
      return this.lineHasTextMentionOfRecord({ segments }, targetName);
    }

    return false;
  }

  handleRecordUpdated(ev) {
    // Property-based references (record-link fields) do not emit lineitem events.
    if (!ev) return;
    if (!ev.properties) return;

    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const sourceRecord = sourceRecordGuid ? (this.data.getRecord?.(sourceRecordGuid) || null) : null;
    if (this.usesSdkPropertyBacklinks()) {
      this.refreshMatchingStates(ev, 'record.updated', (state) =>
        this.recordEventAffectsState(state, sourceRecordGuid, sourceRecord)
      );
      return;
    }
    /**
     * `updatePropertyIndexForRecord` now always returns a useful result: it
     * either applies the update, prunes the record, or queues the guid for
     * later drain. We never fall back to scheduling a full workspace rebuild
     * here — that was the original feedback-loop bug.
     */
    this.updatePropertyIndexForRecord(sourceRecordGuid, sourceRecord);
  }

  handleRecordCreated(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const sourceRecord = sourceRecordGuid ? (this.data.getRecord?.(sourceRecordGuid) || null) : null;
    if (this.usesSdkPropertyBacklinks()) {
      const refreshed = this.refreshMatchingStates(ev, 'record.created', (state) =>
        this.recordEventAffectsState(state, sourceRecordGuid, sourceRecord)
      );
      if (refreshed === 0 && !sourceRecordGuid) {
        this.handleWorkspaceInvalidation(ev, 'record.created');
      }
      return;
    }
    if (sourceRecordGuid) {
      // Same as above: queue or apply incrementally; never schedule a full rebuild.
      this.updatePropertyIndexForRecord(sourceRecordGuid, sourceRecord);
    }
    const refreshed = this.refreshMatchingStates(ev, 'record.created', (state) =>
      this.recordEventAffectsState(state, sourceRecordGuid, sourceRecord)
    );
    if (refreshed === 0 && !sourceRecordGuid) {
      this.handleWorkspaceInvalidation(ev, 'record.created');
    }
  }

  handleRecordMoved(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const sourceRecord = sourceRecordGuid ? (this.data.getRecord?.(sourceRecordGuid) || null) : null;
    const refreshed = this.refreshMatchingStates(ev, 'record.moved', (state) =>
      this.recordEventAffectsState(state, sourceRecordGuid, sourceRecord)
    );
    if (refreshed === 0 && !sourceRecordGuid) {
      this.handleWorkspaceInvalidation(ev, 'record.moved');
    }
  }

  handleLineItemUpdated(ev) {
    if (!ev) return;
    this.filterAndScheduleLineEvent(ev, this.getEventLineSegments(ev), 'lineitem.updated');
  }

  handleLineItemCreated(ev) {
    if (!ev) return;
    this.filterAndScheduleLineEvent(ev, this.getEventLineSegments(ev), 'lineitem.created');
  }

  handleLineItemMoved(ev) {
    if (!ev) return;
    this.filterAndScheduleLineEvent(ev, this.getEventLineSegments(ev), 'lineitem.moved');
  }

  handleLineItemUndeleted(ev) {
    if (!ev) return;
    this.filterAndScheduleLineEvent(ev, this.getEventLineSegments(ev), 'lineitem.undeleted');
  }

  handleLineItemDeleted(ev) {
    if (!ev) return;
    // Segments are often unavailable on delete — filter by source record guid only.
    this.filterAndScheduleLineEvent(ev, [], 'lineitem.deleted');
  }

  countLinkedReferences(groups) {
    let total = 0;
    for (const g of groups || []) {
      for (const line of g?.lines || []) {
        total += 1;
      }
    }
    return total;
  }

  getLinkedContextState(state, lineGuid) {
    if (!state) return null;
    if (!(state.linkedContextByLine instanceof Map)) state.linkedContextByLine = new Map();

    const guid = (lineGuid || '').trim();
    if (!guid) return null;

    let ctx = state.linkedContextByLine.get(guid) || null;
    if (ctx) return ctx;

    ctx = {
      lineGuid: guid,
      showMoreContext: false,
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      loaded: false,
      loading: false,
      loadPromise: null,
      error: '',
      descendants: [],
      depthByGuid: {},
      relativeDepthByGuid: {},
      aboveItems: [],
      belowItems: []
    };
    state.linkedContextByLine.set(guid, ctx);
    return ctx;
  }

  hasRequestedLinkedContext(ctx) {
    return Boolean(
      ctx && (ctx.showMoreContext === true || (ctx.siblingAboveCount || 0) > 0 || (ctx.siblingBelowCount || 0) > 0)
    );
  }

  getAvailableAboveContextCount(ctx) {
    if (!ctx || ctx.loaded !== true) return null;
    return Array.isArray(ctx.aboveItems) ? ctx.aboveItems.length : 0;
  }

  getAvailableBelowContextCount(ctx) {
    if (!ctx || ctx.loaded !== true) return null;
    return Array.isArray(ctx.belowItems) ? ctx.belowItems.length : 0;
  }

  getVisibleAboveContextItems(ctx) {
    if (!ctx || ctx.loaded !== true || !Array.isArray(ctx.aboveItems)) return [];
    const available = this.getAvailableAboveContextCount(ctx) || 0;
    const count = Math.max(0, Math.min(ctx.siblingAboveCount || 0, available));
    if (count === 0) return [];
    const start = Math.max(0, ctx.aboveItems.length - count);
    return ctx.aboveItems.slice(start);
  }

  getVisibleBelowContextItems(ctx) {
    if (!ctx || ctx.loaded !== true || !Array.isArray(ctx.belowItems)) return [];
    const available = this.getAvailableBelowContextCount(ctx) || 0;
    const count = Math.max(0, Math.min(ctx.siblingBelowCount || 0, available));
    if (count === 0) return [];
    return ctx.belowItems.slice(0, count);
  }

  hasAnyLinkedContext(ctx) {
    if (!ctx || ctx.loaded !== true) return false;
    return Boolean(
      (ctx.descendants || []).length > 0 ||
      this.getAvailableAboveContextCount(ctx) > 0 ||
      this.getAvailableBelowContextCount(ctx) > 0
    );
  }

  getAboveToggleLabel(ctx) {
    const shown = ctx?.siblingAboveCount || 0;
    const available = this.getAvailableAboveContextCount(ctx);
    if (shown <= 0) return 'Show above';
    if (available === null || shown < available) return 'More above';
    return 'Hide above';
  }

  getBelowToggleLabel(ctx) {
    const shown = ctx?.siblingBelowCount || 0;
    const available = this.getAvailableBelowContextCount(ctx);
    if (shown <= 0) return 'Show below';
    if (available === null || shown < available) return 'More below';
    return 'Hide below';
  }

  adjustContextWindowCount(current, available) {
    const now = Math.max(0, current || 0);
    if (available !== null && available <= 0) return 0;
    if (now <= 0) return 1;
    if (available === null) return now + 1;
    if (now < available) return now + 1;
    return 0;
  }

  resetLinkedContextState(ctx) {
    if (!ctx) return;
    ctx.showMoreContext = false;
    ctx.siblingAboveCount = 0;
    ctx.siblingBelowCount = 0;
    ctx.error = '';
  }

  findContextLineByGuid(state, lineGuid) {
    const target = (lineGuid || '').trim();
    if (!target || !state?.lastResults) return null;
    const groups = [
      ...(Array.isArray(state.lastResults?.linkedGroups) ? state.lastResults.linkedGroups : []),
      ...(Array.isArray(state.lastResults?.unlinkedGroups) ? state.lastResults.unlinkedGroups : [])
    ];

    for (const g of groups) {
      for (const line of g?.lines || []) {
        if ((line?.guid || '') === target) return line;
      }
    }

    return null;
  }

  async collectDescendantContext(line, treeContext = null) {
    const rootGuid = line?.guid || null;
    const tree = treeContext || (typeof line?.getTreeContext === 'function'
      ? await line.getTreeContext().catch(() => null)
      : null);
    const descendants = Array.isArray(tree?.descendants) ? tree.descendants.filter(Boolean) : [];
    const depthByGuid = {};

    if (!rootGuid || descendants.length === 0) {
      return { descendants, depthByGuid };
    }

    const parentByGuid = this.buildParentGuidMap(null, descendants);
    const scopedDescendants = [];

    for (const item of descendants) {
      const guid = item?.guid || null;
      if (!guid) continue;
      const depth = this.getLineDepthFromAncestor(guid, rootGuid, parentByGuid);
      if (depth === null) continue;
      depthByGuid[guid] = depth;
      scopedDescendants.push(item);
    }

    return { descendants: scopedDescendants, depthByGuid };
  }

  async collectBaselineContextItems(line, treeContext = null) {
    if (!line) return { baselineRootGuid: null, items: [] };

    const tree = treeContext || (typeof line?.getTreeContext === 'function'
      ? await line.getTreeContext().catch(() => null)
      : null);
    const ancestors = Array.isArray(tree?.ancestors) ? tree.ancestors.filter(Boolean) : [];
    const baselineRoot = ancestors.length > 0
      ? ancestors[ancestors.length - 1]
      : line;
    const baselineRootGuid = baselineRoot?.guid || line?.guid || null;

    const baselineTree = baselineRootGuid === (line?.guid || null)
      ? tree
      : (typeof baselineRoot?.getTreeContext === 'function'
        ? await baselineRoot.getTreeContext().catch(() => null)
        : null);
    const descendants = Array.isArray(baselineTree?.descendants)
      ? baselineTree.descendants.filter(Boolean)
      : [];
    const items = [];

    if (baselineRoot?.guid) items.push(baselineRoot);
    for (const item of descendants) {
      const guid = item?.guid || null;
      if (!guid || guid === baselineRootGuid) continue;
      items.push(item);
    }

    return { baselineRootGuid, items };
  }

  buildRecordDocumentOrder(record, items) {
    const recordGuid = record?.guid || null;
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!recordGuid || list.length === 0) return list;

    const childrenByParent = new Map();
    const visited = new Set();
    const ordered = [];

    for (const item of list) {
      const guid = item?.guid || null;
      if (!guid) continue;

      const parentGuid = typeof item?.parent_guid === 'string' && item.parent_guid
        ? item.parent_guid
        : recordGuid;
      const key = parentGuid === recordGuid ? recordGuid : parentGuid;

      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(item);
    }

    const walk = (parentGuid) => {
      const children = childrenByParent.get(parentGuid) || [];
      for (const item of children) {
        const guid = item?.guid || null;
        if (!guid || visited.has(guid)) continue;
        visited.add(guid);
        ordered.push(item);
        walk(guid);
      }
    };

    walk(recordGuid);

    for (const item of list) {
      const guid = item?.guid || null;
      if (!guid || visited.has(guid)) continue;
      visited.add(guid);
      ordered.push(item);
    }

    return ordered;
  }

  buildParentGuidMap(record, items) {
    const recordGuid = record?.guid || null;
    const map = new Map();

    for (const item of Array.isArray(items) ? items : []) {
      const guid = item?.guid || null;
      if (!guid) continue;
      const parentGuid = typeof item?.parent_guid === 'string' && item.parent_guid
        ? item.parent_guid
        : recordGuid;
      map.set(guid, parentGuid || null);
    }

    return map;
  }

  getLineDepthFromAncestor(lineGuid, ancestorGuid, parentByGuid) {
    const guid = lineGuid || null;
    const ancestor = ancestorGuid || null;
    if (!guid || !ancestor || !(parentByGuid instanceof Map) || guid === ancestor) return null;

    let depth = 0;
    let currentGuid = guid;
    const seen = new Set();

    while (currentGuid && !seen.has(currentGuid)) {
      seen.add(currentGuid);
      const parentGuid = parentByGuid.get(currentGuid) || null;
      if (!parentGuid) return null;
      depth += 1;
      if (parentGuid === ancestor) return depth;
      currentGuid = parentGuid;
    }

    return null;
  }

  isLineWithinSubtree(lineGuid, subtreeRootGuid, parentByGuid) {
    if (!lineGuid || !subtreeRootGuid) return false;
    if (lineGuid === subtreeRootGuid) return true;
    return this.getLineDepthFromAncestor(lineGuid, subtreeRootGuid, parentByGuid) !== null;
  }

  findBaselineContextRootGuid(record, matchedGuid, parentByGuid) {
    const recordGuid = record?.guid || null;
    let currentGuid = matchedGuid || null;
    if (!recordGuid || !currentGuid || !(parentByGuid instanceof Map)) return currentGuid;

    const seen = new Set();
    while (currentGuid && !seen.has(currentGuid)) {
      seen.add(currentGuid);
      const parentGuid = parentByGuid.get(currentGuid) || null;
      if (!parentGuid || parentGuid === recordGuid) return currentGuid;
      currentGuid = parentGuid;
    }

    return matchedGuid || null;
  }

  scopeContextItemsToBaseline(record, items, matchedGuid) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const parentByGuid = this.buildParentGuidMap(record, list);
    const baselineRootGuid = this.findBaselineContextRootGuid(record, matchedGuid, parentByGuid);
    const scopedItems = baselineRootGuid
      ? list.filter((item) => this.isLineWithinSubtree(item?.guid || null, baselineRootGuid, parentByGuid))
      : list;

    return {
      baselineRootGuid,
      items: scopedItems,
      parentByGuid
    };
  }

  async ensureLinkedContextLoaded(state, line, { background } = {}) {
    const ctx = this.getLinkedContextState(state, line?.guid || null);
    if (!ctx || !line) return null;
    if (ctx.loaded === true) return ctx;
    if (ctx.loading === true && ctx.loadPromise) return ctx.loadPromise;

    ctx.loading = true;
    ctx.backgroundLoading = background === true;
    ctx.error = '';
    if (background !== true) {
      this.renderFromCache(state);
    }

    ctx.loadPromise = (async () => {
      const treeContext = await line.getTreeContext();
      const descendantContext = await this.collectDescendantContext(line, treeContext);
      const matchedGuid = line?.guid || '';
      const record = typeof line?.getRecord === 'function' ? line.getRecord() : (line?.record || null);
      const baselineContext = await this.collectBaselineContextItems(line, treeContext);
      const baselineItems = baselineContext.items.length > 0
        ? baselineContext.items
        : [
          line,
          ...(Array.isArray(descendantContext.descendants) ? descendantContext.descendants : [])
        ];
      const scopedBaseline = this.scopeContextItemsToBaseline(record, baselineItems, matchedGuid);
      const scopedItems = this.buildRecordDocumentOrder(
        record,
        Array.isArray(scopedBaseline?.items) && scopedBaseline.items.length > 0
          ? scopedBaseline.items
          : baselineItems.filter(Boolean)
      );
      const baselineParentByGuid = scopedBaseline?.parentByGuid instanceof Map
        ? scopedBaseline.parentByGuid
        : this.buildParentGuidMap(record, scopedItems);
      const descendants = [];
      const depthByGuid = {};
      const relativeDepthByGuid = {};
      const baselineRootGuid = scopedBaseline?.baselineRootGuid || baselineContext?.baselineRootGuid || null;
      const matchedRootDepth = baselineRootGuid && matchedGuid && baselineRootGuid !== matchedGuid
        ? this.getLineDepthFromAncestor(matchedGuid, baselineRootGuid, baselineParentByGuid)
        : 0;
      const matchedAbsoluteDepth = Number.isFinite(matchedRootDepth) ? matchedRootDepth : 0;

      for (const item of scopedItems) {
        const guid = item?.guid || '';
        if (!guid) continue;
        const absoluteDepth = !baselineRootGuid || guid === baselineRootGuid
          ? 0
          : this.getLineDepthFromAncestor(guid, baselineRootGuid, baselineParentByGuid);
        if (absoluteDepth === null) continue;
        relativeDepthByGuid[guid] = Math.max(0, absoluteDepth - matchedAbsoluteDepth);
      }

      for (const item of scopedItems) {
        const guid = item?.guid || '';
        if (!guid || guid === matchedGuid) continue;
        const depth = this.getLineDepthFromAncestor(guid, matchedGuid, baselineParentByGuid);
        if (depth === null) continue;
        descendants.push(item);
        depthByGuid[guid] = depth;
      }

      if (descendants.length === 0) {
        for (const item of descendantContext.descendants || []) {
          const guid = item?.guid || '';
          if (!guid || guid === matchedGuid || depthByGuid[guid] != null) continue;
          descendants.push(item);
          depthByGuid[guid] = Number(descendantContext.depthByGuid?.[guid] || 1);
          if (relativeDepthByGuid[guid] == null) {
            relativeDepthByGuid[guid] = Number(descendantContext.depthByGuid?.[guid] || 1);
          }
        }
      }

      const matchedIndex = scopedItems.findIndex((item) => (item?.guid || '') === matchedGuid);
      const aboveItems = [];
      const belowItems = [];

      if (matchedIndex >= 0) {
        let subtreeEndIndex = matchedIndex;
        const descendantGuids = new Set(
          descendants
            .map((item) => item?.guid || '')
            .filter(Boolean)
        );

        for (let i = matchedIndex + 1; i < scopedItems.length; i += 1) {
          const guid = scopedItems[i]?.guid || '';
          if (!guid || !descendantGuids.has(guid)) continue;
          subtreeEndIndex = i;
        }

        aboveItems.push(...scopedItems.slice(0, matchedIndex));
        belowItems.push(...scopedItems.slice(subtreeEndIndex + 1));
      }

      ctx.descendants = descendants;
      ctx.depthByGuid = depthByGuid;
      ctx.relativeDepthByGuid = relativeDepthByGuid;
      ctx.aboveItems = aboveItems;
      ctx.belowItems = belowItems;
      ctx.loaded = true;

      const availableAbove = this.getAvailableAboveContextCount(ctx);
      const availableBelow = this.getAvailableBelowContextCount(ctx);
      ctx.siblingAboveCount = Math.max(0, Math.min(ctx.siblingAboveCount || 0, availableAbove || 0));
      ctx.siblingBelowCount = Math.max(0, Math.min(ctx.siblingBelowCount || 0, availableBelow || 0));
      if (!this.hasAnyLinkedContext(ctx)) {
        ctx.showMoreContext = false;
        ctx.siblingAboveCount = 0;
        ctx.siblingBelowCount = 0;
      }
      return ctx;
    })()
      .catch(() => {
        ctx.error = background === true ? '' : 'Could not load line context.';
        ctx.loaded = false;
        return null;
      })
      .finally(() => {
        ctx.loading = false;
        ctx.backgroundLoading = false;
        ctx.loadPromise = null;
        if (this._panelStates.get(state?.panelId) === state) {
          this.bumpLinkedContextRenderVersion(state);
          this.renderFromCache(state);
        }
      });

    return ctx.loadPromise;
  }

  async handleLinkedContextAction(state, action, lineGuid) {
    const line = this.findContextLineByGuid(state, lineGuid);
    if (!line) return;

    const ctx = this.getLinkedContextState(state, lineGuid);
    if (!ctx) return;

    if (action === 'toggle-context-more') {
      if (ctx.showMoreContext === true) {
        this.resetLinkedContextState(ctx);
        this.bumpLinkedContextRenderVersion(state);
        this.renderFromCache(state);
        return;
      }
      ctx.showMoreContext = true;
    } else if (action === 'toggle-context-above') {
      ctx.siblingAboveCount = this.adjustContextWindowCount(ctx.siblingAboveCount, this.getAvailableAboveContextCount(ctx));
    } else if (action === 'toggle-context-below') {
      ctx.siblingBelowCount = this.adjustContextWindowCount(ctx.siblingBelowCount, this.getAvailableBelowContextCount(ctx));
    } else {
      return;
    }

    this.bumpLinkedContextRenderVersion(state);
    this.renderFromCache(state);
    if (!this.hasRequestedLinkedContext(ctx)) return;
    await this.ensureLinkedContextLoaded(state, line);
  }

  extractReferencedRecordGuids(segments) {
    const out = new Set();
    for (const seg of segments || []) {
      if (seg?.type !== 'ref') continue;
      const guid = seg?.text?.guid || null;
      if (!guid) continue;
      const rec = this.data.getRecord?.(guid) || null;
      if (rec) out.add(guid);
    }
    return out;
  }

  // ---------- Grouping + rendering ----------

  async getPropertyBacklinkGroups(targetRecord, targetGuid, { showSelf } = {}) {
    if (this.noteSdkPropertyBacklinksFromRecord(targetRecord)) {
      const candidateRecords = await this.getPropertyBacklinkCandidateRecords(targetRecord);
      return this.buildPropertyBacklinkGroupsFromRecords(candidateRecords, targetGuid, { showSelf });
    }
    return this.getPropertyBacklinkGroupsFromIndex(targetGuid, { showSelf });
  }

  buildPropertyBacklinkGroupsFromRecords(sourceRecords, targetGuid, { showSelf }) {
    const byProp = new Map();
    const seenSourceGuids = new Set();

    for (const src of sourceRecords || []) {
      const srcGuid = src?.guid || null;
      if (!srcGuid) continue;
      if (seenSourceGuids.has(srcGuid)) continue;
      seenSourceGuids.add(srcGuid);
      if (!showSelf && srcGuid === targetGuid) continue;
      if (this.isExcludedSourceRecord(src)) continue;

      const props = src.getAllProperties?.() || [];
      for (const p of props || []) {
        const propName = (p?.name || '').trim();
        if (!propName) continue;
        if (!this.propertyReferencesGuid(p, targetGuid)) continue;

        let group = byProp.get(propName) || null;
        if (!group) {
          group = new Map();
          byProp.set(propName, group);
        }
        group.set(srcGuid, src);
      }
    }

    const groups = Array.from(byProp.entries()).map(([propertyName, recordMap]) => ({
      propertyName,
      records: Array.from(recordMap.values())
    }));

    groups.sort((a, b) => {
      const an = (a.propertyName || '').toLowerCase();
      const bn = (b.propertyName || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.records.sort((a, b) => {
        const ad = a?.getUpdatedAt?.() || null;
        const bd = b?.getUpdatedAt?.() || null;
        const at = ad ? ad.getTime() : 0;
        const bt = bd ? bd.getTime() : 0;
        if (bt !== at) return bt - at;
        const an = (a?.getName?.() || '').toLowerCase();
        const bn = (b?.getName?.() || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }

    return groups;
  }

  propertyReferencesGuid(prop, targetGuid) {
    if (!prop || !targetGuid) return false;

    const values = this.getPropertyCandidateValues(prop);
    for (const v of values) {
      if (v === targetGuid) return true;
    }

    const linkedRecordGuids = this.getPropertyLinkedRecordGuids(prop);
    return linkedRecordGuids?.has?.(targetGuid) === true;
  }

  getPropertyLinkedRecordGuids(prop) {
    if (!prop || typeof prop.linkedRecords !== 'function') return null;

    const out = new Set();
    try {
      const records = prop.linkedRecords() || [];
      for (const record of records) {
        const guid = typeof record?.guid === 'string' ? record.guid.trim() : '';
        if (guid) out.add(guid);
      }
    } catch (e) {
      return null;
    }

    return out;
  }

  getPropertyCandidateValues(prop) {
    const out = [];
    const seen = new Set();

    const push = (v) => {
      if (typeof v !== 'string') return;
      const t = v.trim();
      if (!t) return;
      if (seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };

    let raw = [];
    try {
      if (prop && 'value' in prop) {
        raw.push(prop.value);
      }
    } catch (e) {
      // ignore
    }
    try {
      raw.push(prop.text?.());
    } catch (e) {
      // ignore
    }
    try {
      raw.push(prop.choice?.());
    } catch (e) {
      // ignore
    }
    try {
      const values = prop.values?.();
      if (Array.isArray(values)) raw.push(values);
    } catch (e) {
      // ignore
    }

    for (const r of raw) {
      this.collectPropertyCandidateValues(r, push);
    }

    return out;
  }

  collectPropertyCandidateValues(raw, push) {
    if (raw == null) return;

    if (typeof raw === 'string') {
      for (const v of this.expandPossibleListString(raw)) {
        push(v);
      }
      return;
    }

    if (Array.isArray(raw)) {
      const kind = typeof raw[0] === 'string' ? raw[0].trim().toLowerCase() : '';
      if (raw.length === 2 && kind) {
        if (kind === 'record' || kind === 'records') {
          this.collectPropertyCandidateValues(raw[1], push);
          return;
        }
        if (kind === 'text' || kind === 'url' || kind === 'hashtag' || kind === 'choice'
          || kind === 'datetime' || kind === 'number' || kind === 'banner' || kind === 'file'
          || kind === 'image') {
          this.collectPropertyCandidateValues(raw[1], push);
          return;
        }
      }

      for (const item of raw) {
        this.collectPropertyCandidateValues(item, push);
      }
      return;
    }

    if (typeof raw === 'object') {
      const guidKeys = ['guid', 'recordGuid', 'record_guid', 'targetGuid', 'target_guid'];
      for (const key of guidKeys) {
        const value = raw?.[key];
        if (typeof value === 'string') push(value);
      }

      for (const key of ['value', 'record', 'records', 'linkedRecord', 'linkedRecords', 'target', 'targets', 'item', 'items', 'node', 'nodes', 'ref', 'refs']) {
        if (key in raw) this.collectPropertyCandidateValues(raw[key], push);
      }
    }
  }

  expandPossibleListString(v) {
    if (typeof v !== 'string') return [];
    const t = v.trim();
    if (!t) return [];

    // Some properties may serialize multi-values as JSON.
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((x) => typeof x === 'string')
            .map((x) => x.trim())
            .filter(Boolean);
        }
      } catch (e) {
        // fall through
      }
    }

    // Or as a comma-separated list.
    if (t.includes(',')) {
      return t
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }

    // Or as multi-line text.
    if (t.includes('\n')) {
      return t
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    }

    return [t];
  }

  groupBacklinkLines(lines, targetGuid, { showSelf }) {
    const byRecord = new Map();
    const seenLineGuids = new Set();

    for (const line of lines || []) {
      if (!line || !line.guid || seenLineGuids.has(line.guid)) continue;
      seenLineGuids.add(line.guid);

      const srcRecord = line.record || null;
      const srcGuid = srcRecord?.guid || null;
      if (!srcGuid) continue;
      if (!showSelf && srcGuid === targetGuid) continue;

      const prev = byRecord.get(srcGuid) || { record: srcRecord, lines: [] };
      prev.record = prev.record || srcRecord;
      prev.lines.push(line);
      byRecord.set(srcGuid, prev);
    }

    const groups = Array.from(byRecord.values());
    groups.sort((a, b) => {
      const ad = a.record?.getUpdatedAt?.() || null;
      const bd = b.record?.getUpdatedAt?.() || null;
      const at = ad ? ad.getTime() : 0;
      const bt = bd ? bd.getTime() : 0;
      if (bt !== at) return bt - at;
      const an = (a.record?.getName?.() || '').toLowerCase();
      const bn = (b.record?.getName?.() || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.lines.sort((x, y) => {
        const xd = x?.getCreatedAt?.() || null;
        const yd = y?.getCreatedAt?.() || null;
        const xt = xd ? xd.getTime() : 0;
        const yt = yd ? yd.getTime() : 0;
        return xt - yt;
      });
    }

    return groups;
  }

  groupUnlinkedReferenceLines(lines, linkedGroups, targetGuid, targetName, { showSelf }) {
    const linkedLineGuids = new Set();
    for (const group of linkedGroups || []) {
      for (const line of group?.lines || []) {
        const guid = line?.guid || null;
        if (guid) linkedLineGuids.add(guid);
      }
    }

    const candidates = [];
    for (const line of lines || []) {
      const guid = line?.guid || null;
      if (!guid || linkedLineGuids.has(guid)) continue;

      const srcGuid = line?.record?.guid || null;
      if (!showSelf && srcGuid === targetGuid) continue;
      if (this.lineHasRefToRecord(line, targetGuid)) continue;
      if (!this.lineHasTextMentionOfRecord(line, targetName)) continue;
      candidates.push(line);
    }

    return this.groupBacklinkLines(candidates, targetGuid, { showSelf });
  }

  lineHasRefToRecord(line, recordGuid) {
    const targetGuid = (recordGuid || '').trim();
    if (!targetGuid) return false;

    for (const seg of line?.segments || []) {
      if (seg?.type !== 'ref') continue;
      const textObj = typeof seg?.text === 'string' ? { guid: seg.text } : (seg?.text || {});
      if ((textObj.guid || '') === targetGuid) return true;
    }
    return false;
  }

  dateTimeValueMatchesIso(value, targetIso) {
    const iso = this.normalizeDateToIso(targetIso);
    if (!iso) return false;

    if (typeof value === 'string') {
      return this.normalizeDateToIso(value) === iso;
    }
    if (!value || typeof value !== 'object') return false;

    const startSource = value.start && typeof value.start === 'object'
      ? value.start
      : value.from && typeof value.from === 'object'
        ? value.from
        : value;
    const endSource = value.end && typeof value.end === 'object'
      ? value.end
      : value.to && typeof value.to === 'object'
        ? value.to
        : (value.ed || value.et || value.endDate || value.endTime)
          ? {
              d: value.ed || value.endDate || null,
              t: value.et || value.endTime || null
            }
          : null;

    const startIso = this.normalizeDateToIso(startSource);
    const endIso = this.normalizeDateToIso(endSource);
    if (startIso === iso || endIso === iso) return true;
    if (startIso && endIso) return startIso <= iso && iso <= endIso;
    return false;
  }

  lineHasDateTimeForDate(line, targetIso) {
    const iso = this.normalizeDateToIso(targetIso);
    if (!iso) return false;

    for (const seg of line?.segments || []) {
      if (seg?.type !== 'datetime') continue;
      if (this.dateTimeValueMatchesIso(seg.text, iso)) return true;
    }
    return false;
  }

  lineHasTextMentionOfRecord(line, recordName) {
    const matchers = this.buildRecordMentionMatchers(recordName);
    if (matchers.length === 0) return false;
    const text = this.getLineTextMentionSource(line);
    if (!text) return false;
    return matchers.some((matcher) => matcher.test(text));
  }

  getLineTextMentionSource(line) {
    let out = '';

    for (const seg of line?.segments || []) {
      if (!seg) continue;
      if (seg.type === 'text' || seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code') {
        if (typeof seg.text === 'string') out += seg.text;
      }
    }

    return out;
  }

  getPhraseBoundaryTokens(phrase) {
    const trimmed = typeof phrase === 'string' ? phrase.trim() : '';
    if (!trimmed) return [];
    return trimmed
      .replace(/['’]/g, '')
      .match(/[a-z0-9]+/gi) || [];
  }

  buildPhraseBoundaryPattern(phrase) {
    const tokens = this.getPhraseBoundaryTokens(phrase).map((part) => this.escapeRegExp(part));
    if (tokens.length === 0) return null;

    const separator = `[\\s\\-\\u2010-\\u2015_./,:;!?()[\\]{}"'“”‘’]+`;
    return `(^|[^a-z0-9])(${tokens.join(separator)})(?=$|[^a-z0-9])`;
  }

  buildPhraseBoundaryMatcher(phrase) {
    const pattern = this.buildPhraseBoundaryPattern(phrase);
    if (!pattern) return null;
    return new RegExp(pattern, 'i');
  }

  buildPhraseBoundaryGlobalMatcher(phrase) {
    const pattern = this.buildPhraseBoundaryPattern(phrase);
    if (!pattern) return null;
    return new RegExp(pattern, 'ig');
  }

  buildRecordMentionMatchers(recordName) {
    return this.getRecordMentionPhrases(recordName)
      .map((phrase) => this.buildPhraseBoundaryMatcher(phrase))
      .filter(Boolean);
  }

  buildRecordMentionGlobalMatchers(recordName) {
    return this.getRecordMentionPhrases(recordName)
      .sort((a, b) => b.length - a.length)
      .map((phrase) => this.buildPhraseBoundaryGlobalMatcher(phrase))
      .filter(Boolean);
  }

  findUnlinkedLineByGuid(state, lineGuid) {
    const target = (lineGuid || '').trim();
    if (!target || !state?.lastResults) return null;

    for (const group of state.lastResults?.unlinkedGroups || []) {
      for (const line of group?.lines || []) {
        if ((line?.guid || '') === target) return line;
      }
    }

    return null;
  }

  buildReplacedSegments(segments, recordName, recordGuid) {
    if (!Array.isArray(segments) || !recordGuid) return segments;

    const matchers = this.buildRecordMentionGlobalMatchers(recordName);
    if (matchers.length === 0) return segments;

    const result = [];
    let changed = false;

    for (const seg of segments) {
      if (!seg || !['text', 'bold', 'italic', 'code'].includes(seg.type) || typeof seg.text !== 'string') {
        result.push(seg);
        continue;
      }

      const text = seg.text;
      const matches = [];
      for (const matcher of matchers) {
        matcher.lastIndex = 0;
        let match = null;
        while ((match = matcher.exec(text)) !== null) {
          const prefix = match[1] || '';
          const matchedText = match[2] || '';
          const start = match.index + prefix.length;
          const end = start + matchedText.length;
          matches.push({ start, end, matchedText });
          matcher.lastIndex = end;
        }
      }

      if (matches.length === 0) {
        result.push(seg);
        continue;
      }

      matches.sort((a, b) => (a.start - b.start) || (b.end - a.end));

      let lastIndex = 0;
      let matched = false;

      for (const match of matches) {
        if (match.start < lastIndex) continue;
        matched = true;
        changed = true;

        if (match.start > lastIndex) {
          result.push({ type: seg.type, text: text.slice(lastIndex, match.start) });
        }

        result.push({ type: 'ref', text: { guid: recordGuid, title: match.matchedText } });
        lastIndex = match.end;
      }

      if (!matched) {
        result.push(seg);
        continue;
      }

      if (lastIndex < text.length) {
        result.push({ type: seg.type, text: text.slice(lastIndex) });
      }
    }

    return changed ? result : segments;
  }

  async linkUnlinkedReference(state, lineGuid) {
    const panel = state?.panel || null;
    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = (record?.guid || '').trim();
    const recordName = (record?.getName?.() || '').trim();
    if (!recordGuid || !recordName) return;

    const line = this.findUnlinkedLineByGuid(state, lineGuid);
    if (!line || typeof line.setSegments !== 'function') return;
    if (this.lineHasRefToRecord(line, recordGuid)) return;

    const nextSegments = this.buildReplacedSegments(line.segments || [], recordName, recordGuid);
    if (nextSegments === line.segments) return;

    await line.setSegments(nextSegments);
    this.refreshAllPanels({ force: true, reason: 'link-unlinked' });
  }

  escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  sortPropertyGroupsForRender(groups, sortSpec, sortMetrics) {
    return (groups || []).map((g) => {
      const records = Array.isArray(g?.records) ? Array.from(g.records) : [];
      records.sort((a, b) => this.compareRecordsForSort(a, b, sortSpec, sortMetrics));
      return {
        propertyName: g?.propertyName || '',
        records
      };
    });
  }

  sortLinkedGroupsForRender(groups, sortSpec, sortMetrics) {
    const out = (groups || []).map((g) => ({
      record: g?.record || null,
      lines: Array.isArray(g?.lines) ? Array.from(g.lines) : []
    }));

    out.sort((a, b) => this.compareRecordsForSort(a?.record || null, b?.record || null, sortSpec, sortMetrics));
    return out;
  }

  computeRecordSortMetrics(propertyGroups, linkedGroups) {
    const referenceCountByGuid = new Map();
    const referenceActivityByGuid = new Map();

    const addReferenceCount = (recordGuid, delta) => {
      const guid = (recordGuid || '').trim();
      if (!guid) return;
      const n = Number(delta);
      if (!Number.isFinite(n) || n === 0) return;
      const prev = referenceCountByGuid.get(guid) || 0;
      referenceCountByGuid.set(guid, prev + n);
    };

    const setReferenceActivity = (recordGuid, timestamp) => {
      const guid = (recordGuid || '').trim();
      if (!guid) return;
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || ts <= 0) return;
      const prev = referenceActivityByGuid.get(guid) || 0;
      if (ts > prev) referenceActivityByGuid.set(guid, ts);
    };

    for (const g of propertyGroups || []) {
      for (const record of g?.records || []) {
        const guid = record?.guid || null;
        if (!guid) continue;
        addReferenceCount(guid, 1);
        setReferenceActivity(guid, this.getRecordUpdatedTimestamp(record));
      }
    }

    for (const g of linkedGroups || []) {
      const record = g?.record || null;
      const guid = record?.guid || null;
      if (!guid) continue;

      const lines = Array.isArray(g?.lines) ? g.lines : [];
      if (lines.length === 0) continue;
      addReferenceCount(guid, lines.length);

      let newestLineActivity = 0;
      for (const line of lines) {
        const ts = this.getLineActivityTimestamp(line);
        if (ts > newestLineActivity) newestLineActivity = ts;
      }

      if (newestLineActivity <= 0) {
        newestLineActivity = this.getRecordUpdatedTimestamp(record);
      }
      setReferenceActivity(guid, newestLineActivity);
    }

    return { referenceCountByGuid, referenceActivityByGuid };
  }

  compareRecordsForSort(a, b, sortSpec, sortMetrics) {
    const sortBy = this.normalizeSortBy(sortSpec?.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(sortSpec?.sortDir) || this._defaultSortDir;

    const aGuid = a?.guid || '';
    const bGuid = b?.guid || '';

    let primary = 0;

    if (sortBy === 'page_title') {
      primary = this.compareText(this.getRecordNameForSort(a), this.getRecordNameForSort(b));
    } else if (sortBy === 'page_created_date') {
      primary = this.compareNumbers(this.getRecordCreatedTimestamp(a), this.getRecordCreatedTimestamp(b));
    } else if (sortBy === 'journal_page') {
      primary = this.compareNumbers(this.getRecordJournalPageTimestamp(a), this.getRecordJournalPageTimestamp(b));
    } else if (sortBy === 'reference_count') {
      const ac = sortMetrics?.referenceCountByGuid?.get?.(aGuid) || 0;
      const bc = sortMetrics?.referenceCountByGuid?.get?.(bGuid) || 0;
      primary = this.compareNumbers(ac, bc);
    } else if (sortBy === 'reference_activity') {
      const at = this.getReferenceActivityTimestamp(a, sortMetrics);
      const bt = this.getReferenceActivityTimestamp(b, sortMetrics);
      primary = this.compareNumbers(at, bt);
    } else {
      primary = this.compareNumbers(this.getRecordUpdatedTimestamp(a), this.getRecordUpdatedTimestamp(b));
    }

    if (sortDir === 'desc') primary *= -1;
    if (primary !== 0) return primary;

    const nameTieBreak = this.compareText(this.getRecordNameForSort(a), this.getRecordNameForSort(b));
    if (nameTieBreak !== 0) return nameTieBreak;

    return this.compareText(aGuid, bGuid);
  }

  getRecordNameForSort(record) {
    return (record?.getName?.() || '').trim().toLowerCase();
  }

  getRecordUpdatedTimestamp(record) {
    const d = record?.getUpdatedAt?.() || null;
    return d instanceof Date ? d.getTime() : 0;
  }

  getRecordCreatedTimestamp(record) {
    const d = record?.getCreatedAt?.() || null;
    return d instanceof Date ? d.getTime() : 0;
  }

  /**
   * Chronological key: journal page date, else a `When`-style date property, else a
   * date-like record title. Records with no resolvable date collapse to 0 and keep the
   * name tie-break, so they cluster at one end instead of interleaving.
   */
  getRecordJournalPageTimestamp(record) {
    if (!record) return 0;

    try {
      const details = typeof record.getJournalDetails === 'function' ? record.getJournalDetails() : null;
      const raw = details?.date || null;
      const journalTs = this.timestampFromDateTimeValue(raw);
      if (journalTs > 0) return journalTs;
    } catch (e) {
      // Fall through to property / title lookups.
    }

    const propertyTs = this.getRecordWhenPropertyTimestamp(record);
    if (propertyTs > 0) return propertyTs;

    const titleIso = this.parseDateIsoFromRecordTitle(record.getName?.() || '')
      || this.parseLeadingDateIsoFromRecordTitle(record.getName?.() || '');
    return this.timestampFromIsoParts(titleIso, this.parseLeadingTimeFromRecordTitle(record.getName?.() || ''));
  }

  /** First `When`-style date property on the record, in milliseconds (0 when absent). */
  getRecordWhenPropertyTimestamp(record) {
    const wanted = ['when', 'date'];
    const candidates = [];

    try {
      for (const prop of record.getAllProperties?.() || []) {
        const name = (prop?.name || '').trim().toLowerCase();
        if (wanted.includes(name)) candidates.push(prop);
      }
    } catch (e) {
      // ignore
    }

    if (candidates.length === 0 && typeof record.prop === 'function') {
      for (const name of ['When', 'when', 'Date', 'date']) {
        try {
          const prop = record.prop(name);
          if (prop) candidates.push(prop);
        } catch (e) {
          // ignore
        }
      }
    }

    for (const prop of candidates) {
      const raws = [];
      try { if (typeof prop.date === 'function') raws.push(prop.date()); } catch (e) { /* ignore */ }
      try { if (typeof prop.get === 'function') raws.push(prop.get()); } catch (e) { /* ignore */ }
      try { if (prop && 'value' in prop) raws.push(prop.value); } catch (e) { /* ignore */ }
      try { if (typeof prop.text === 'function') raws.push(prop.text()); } catch (e) { /* ignore */ }

      for (const raw of raws) {
        const ts = this.timestampFromDateTimeValue(raw);
        if (ts > 0) return ts;
      }
    }

    return 0;
  }

  /** Milliseconds for a Date, a `["datetime", {d, t}]` pair, a `{d, t}` object, or a date string. */
  timestampFromDateTimeValue(value) {
    if (!value) return 0;

    if (value instanceof Date) {
      return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        const ts = this.timestampFromDateTimeValue(item);
        if (ts > 0) return ts;
      }
      return 0;
    }

    if (typeof value === 'object') {
      const parts = this.extractDateTimeDisplayParts(value);
      return parts?.date ? this.timestampFromIsoParts(parts.date, parts.time) : 0;
    }

    if (typeof value === 'string') {
      return this.timestampFromIsoParts(this.normalizeDateToIso(value), '');
    }

    return 0;
  }

  timestampFromIsoParts(isoDate, isoTime) {
    const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof isoDate === 'string' ? isoDate.trim() : '');
    if (!date) return 0;

    const time = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(typeof isoTime === 'string' ? isoTime.trim() : '');
    const parsed = new Date(
      Number(date[1]),
      Number(date[2]) - 1,
      Number(date[3]),
      Number(time?.[1] || 0),
      Number(time?.[2] || 0),
      Number(time?.[3] || 0)
    );
    const ms = parsed.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  /** Sort-only: leading `2024.12.06` / `2024-12-06` / `2024/12/06` in a title. */
  parseLeadingDateIsoFromRecordTitle(recordName) {
    const match = /^\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})/.exec(typeof recordName === 'string' ? recordName : '');
    if (!match) return '';

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return '';

    return `${this.padDateTimeNumber(year, 4)}-${this.padDateTimeNumber(month, 2)}-${this.padDateTimeNumber(day, 2)}`;
  }

  /** Sort-only: `08:04` following a leading date, so same-day records stay in order. */
  parseLeadingTimeFromRecordTitle(recordName) {
    const match = /^\s*\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}\.?\s+(\d{1,2}):(\d{2})/.exec(
      typeof recordName === 'string' ? recordName : ''
    );
    if (!match) return '';

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return '';

    return `${this.padDateTimeNumber(hours, 2)}:${this.padDateTimeNumber(minutes, 2)}`;
  }

  getLineActivityTimestamp(line) {
    const updatedAt = line?.getUpdatedAt?.() || null;
    if (updatedAt instanceof Date) return updatedAt.getTime();
    const createdAt = line?.getCreatedAt?.() || null;
    return createdAt instanceof Date ? createdAt.getTime() : 0;
  }

  getReferenceActivityTimestamp(record, sortMetrics) {
    const guid = record?.guid || '';
    if (!guid) return 0;
    const fromLinked = sortMetrics?.referenceActivityByGuid?.get?.(guid) || 0;
    if (fromLinked > 0) return fromLinked;
    return this.getRecordUpdatedTimestamp(record);
  }

  compareNumbers(a, b) {
    const av = Number(a) || 0;
    const bv = Number(b) || 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }

  compareText(a, b) {
    const av = typeof a === 'string' ? a : '';
    const bv = typeof b === 'string' ? b : '';
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }

  renderError(state, message) {
    if (!state?.bodyEl || !state?.countEl) return;
    state.countEl.textContent = '';
    state.bodyEl.innerHTML = '';

    const el = document.createElement('div');
    el.className = 'tlr-error';
    el.textContent = message || 'Error loading references.';
    state.bodyEl.appendChild(el);
  }

  formatCountLabel(count, noun, opts) {
    const totalCount = typeof opts?.totalCount === 'number' ? opts.totalCount : null;
    const useRatio = opts?.scoped === true && totalCount !== null && totalCount !== count;
    const includeZero = opts?.includeZero === true;
    const unit = totalCount !== null ? totalCount : count;

    if (!includeZero && Number(unit) <= 0 && (!useRatio || Number(count) <= 0)) return '';

    if (useRatio) {
      return `${count}/${totalCount} ${noun}${totalCount === 1 ? '' : 's'}`;
    }

    return `${unit} ${noun}${unit === 1 ? '' : 's'}`;
  }

  collectUniquePageGuids(propertyGroups, linkedGroups, unlinkedGroups) {
    const guids = new Set();

    for (const group of propertyGroups || []) {
      for (const record of group?.records || []) {
        const guid = record?.guid || null;
        if (guid) guids.add(guid);
      }
    }

    for (const group of linkedGroups || []) {
      const guid = group?.record?.guid || null;
      if (guid) guids.add(guid);
    }

    for (const group of unlinkedGroups || []) {
      const guid = group?.record?.guid || null;
      if (guid) guids.add(guid);
    }

    return guids;
  }

  filterPropertyGroupsByText(groups, textQueryLower) {
    const nextGroups = [];
    for (const group of groups || []) {
      const propertyName = (group?.propertyName || '').trim();
      if (!propertyName) continue;
      const records = (group?.records || []).filter((record) => {
        const name = (record?.getName?.() || '').toLowerCase();
        return name.includes(textQueryLower);
      });
      if (records.length > 0) nextGroups.push({ propertyName, records });
    }
    return nextGroups;
  }

  filterLineGroupsByText(groups, textQueryLower) {
    const nextGroups = [];
    for (const group of groups || []) {
      const record = group?.record || null;
      const recordGuid = record?.guid || null;
      if (!recordGuid) continue;
      const lines = (group?.lines || []).filter((line) => {
        const text = this.segmentsToPlainText(line?.segments || []);
        return text.toLowerCase().includes(textQueryLower);
      });
      if (lines.length > 0) nextGroups.push({ record, lines });
    }
    return nextGroups;
  }

  filterReferenceGroupsForRender({
    propsAll,
    linkedAll,
    unlinkedAll,
    searchMode,
    textQueryLower,
    queryFilterState,
    canApplyScopedQuery,
    shouldScopeUnlinked
  }) {
    let props = propsAll;
    let linked = linkedAll;
    let unlinked = shouldScopeUnlinked ? unlinkedAll : [];

    if (searchMode === 'query') {
      if (canApplyScopedQuery) {
        props = this.filterPropertyGroupsByScopedQuery(propsAll, queryFilterState);
        linked = this.filterLineGroupsByScopedQuery(linkedAll, queryFilterState);
        unlinked = shouldScopeUnlinked
          ? this.filterLineGroupsByScopedQuery(unlinkedAll, queryFilterState)
          : [];
      }
    } else if (textQueryLower) {
      props = this.filterPropertyGroupsByText(props, textQueryLower);
      linked = this.filterLineGroupsByText(linked, textQueryLower);
      unlinked = this.filterLineGroupsByText(unlinked, textQueryLower);
    }

    return { props, linked, unlinked };
  }

  buildReferenceSummaryParts({
    searchMode,
    incompleteQueryDraft,
    queryFilterState,
    canApplyScopedQuery,
    hasScopedView,
    filteredUniquePagesSize,
    totalUniquePagesSize,
    filteredVisibleRefCount,
    totalVisibleRefCount
  }) {
    // Built-in style: "N backlinks in M pages" (single pill label).
    if (searchMode === 'query') {
      if (incompleteQueryDraft) return ['Continue typing…'];
      if (queryFilterState?.error) return ['Invalid query'];
      if (queryFilterState?.loading === true && canApplyScopedQuery !== true) return ['Applying…'];
    }

    const pages = (searchMode === 'query' && canApplyScopedQuery) || hasScopedView
      ? filteredUniquePagesSize
      : totalUniquePagesSize;
    const refs = (searchMode === 'query' && canApplyScopedQuery) || hasScopedView
      ? filteredVisibleRefCount
      : totalVisibleRefCount;

    if (Number(refs) <= 0 && Number(pages) <= 0) return ['No backlinks'];
    const refNoun = Number(refs) === 1 ? 'backlink' : 'backlinks';
    const pageNoun = Number(pages) === 1 ? 'page' : 'pages';
    return [`${refs} ${refNoun} in ${pages} ${pageNoun}`];
  }

  /**
   * Pill shows a fixed "backlinks" label plus a muted count, so the header does
   * not reflow as counts change. Full "N backlinks in M pages" moves to the tooltip.
   */
  buildReferenceSummaryCount({
    searchMode,
    incompleteQueryDraft,
    queryFilterState,
    canApplyScopedQuery,
    hasScopedView,
    filteredVisibleRefCount,
    totalVisibleRefCount
  }) {
    if (searchMode === 'query') {
      if (incompleteQueryDraft) return '…';
      if (queryFilterState?.error) return '!';
      if (queryFilterState?.loading === true && canApplyScopedQuery !== true) return '…';
    }
    const refs = (searchMode === 'query' && canApplyScopedQuery) || hasScopedView
      ? filteredVisibleRefCount
      : totalVisibleRefCount;
    const n = Number(refs);
    return String(Number.isFinite(n) && n > 0 ? n : 0);
  }

  buildReferenceSectionMeta(visibleCount, totalCount, showScopedCounts) {
    if (showScopedCounts !== true && Number(visibleCount) === 0) return '';
    return this.formatCountLabel(visibleCount, 'ref', {
      totalCount: showScopedCounts ? totalCount : null,
      scoped: showScopedCounts,
      includeZero: true
    });
  }

  buildUnknownReferenceSectionMeta() {
    return '- refs';
  }

  buildReferenceViewState(state, {
    propertyGroups,
    propertyError,
    propertyIndexStatus,
    propertyIndexStats,
    propertyIndexError,
    linkedGroups,
    linkedError,
    unlinkedGroups,
    unlinkedError,
    unlinkedDeferred,
    unlinkedLoading,
    maxResults
  }) {
    const query = (state.searchQuery || '').trim();
    const searchMode = this.getSearchMode(query);
    const incompleteQueryDraft = searchMode === 'query' && this.isIncompleteQueryDraft(query);
    const textQueryLower = searchMode === 'text' ? query.toLowerCase() : '';
    const queryFilterState = searchMode === 'query' ? this.getQueryFilterState(state, query) : null;
    const canApplyScopedQuery = searchMode === 'query' && incompleteQueryDraft !== true && queryFilterState?.ready === true;
    const shouldScopeUnlinked = searchMode === 'query'
      ? this.shouldIncludeUnlinkedInQueryScope(state, state.lastResults || {})
      : true;
    const highlightQuery = searchMode === 'text' ? query : '';
    const normalizedPropertyIndexStatus = propertyIndexStatus || 'ready';
    const normalizedPropertyIndexStats = propertyIndexStats || this.createEmptyPropertyIndexStats();
    const normalizedPropertyIndexError = propertyIndexError || '';

    const propsAll = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linkedAll = Array.isArray(linkedGroups) ? linkedGroups : [];
    const unlinkedAll = Array.isArray(unlinkedGroups) ? unlinkedGroups : [];

    const totalPropRefCount = propsAll.reduce((total, group) => total + (group?.records?.length || 0), 0);
    const totalLinkedRefCount = this.countLinkedReferences(linkedAll);
    const totalUnlinkedRefCount = this.countLinkedReferences(unlinkedAll);
    const collapseMetrics = {
      ready: true,
      propertyCount: totalPropRefCount,
      linkedCount: totalLinkedRefCount,
      unlinkedCount: totalUnlinkedRefCount,
      propertyError: Boolean(propertyError),
      linkedError: Boolean(linkedError),
      unlinkedError: Boolean(unlinkedError),
      propertyIndexPending: normalizedPropertyIndexStatus === 'idle' || normalizedPropertyIndexStatus === 'indexing',
      propertyIndexError: normalizedPropertyIndexStatus === 'error',
      unlinkedDeferred: unlinkedDeferred === true
    };
    const totalUniquePages = this.collectUniquePageGuids(propsAll, linkedAll, []);
    const filteredGroups = this.filterReferenceGroupsForRender({
      propsAll,
      linkedAll,
      unlinkedAll,
      searchMode,
      textQueryLower,
      queryFilterState,
      canApplyScopedQuery,
      shouldScopeUnlinked
    });

    let { props, linked, unlinked } = filteredGroups;
    const filteredPropRefCount = props.reduce((total, group) => total + (group?.records?.length || 0), 0);
    const filteredLinkedRefCount = this.countLinkedReferences(linked);
    const filteredUnlinkedRefCount = this.countLinkedReferences(unlinked);
    const hasScopedView = (searchMode === 'text' && Boolean(textQueryLower)) || (searchMode === 'query' && canApplyScopedQuery);
    const showUnlinkedCounts = searchMode !== 'query' || shouldScopeUnlinked;
    const showScopedCounts = hasScopedView || (searchMode === 'query' && canApplyScopedQuery);
    const totalVisibleRefCount = totalPropRefCount + totalLinkedRefCount;
    const filteredVisibleRefCount = filteredPropRefCount + filteredLinkedRefCount;
    const filteredUniquePages = this.collectUniquePageGuids(props, linked, []);

    const sortSpec = {
      sortBy: this.normalizeSortBy(state?.sortBy) || this._defaultSortBy,
      sortDir: this.normalizeSortDir(state?.sortDir) || this._defaultSortDir
    };
    const sortMetrics = this.computeRecordSortMetrics(props, [...linked, ...unlinked]);
    props = this.sortPropertyGroupsForRender(props, sortSpec, sortMetrics);
    linked = this.sortLinkedGroupsForRender(linked, sortSpec, sortMetrics);
    unlinked = this.sortLinkedGroupsForRender(unlinked, sortSpec, sortMetrics);

    return {
      searchMode,
      incompleteQueryDraft,
      queryFilterState,
      canApplyScopedQuery,
      shouldScopeUnlinked,
      highlightQuery,
      props,
      linked,
      unlinked,
      propertyError,
      propertyIndexStatus: normalizedPropertyIndexStatus,
      propertyIndexStats: normalizedPropertyIndexStats,
      propertyIndexError: normalizedPropertyIndexError,
      propertyIndexMessage: this.getPropertyIndexDisplayMessage({
        status: normalizedPropertyIndexStatus,
        stats: normalizedPropertyIndexStats,
        error: normalizedPropertyIndexError
      }),
      linkedError,
      unlinkedError,
      unlinkedDeferred,
      unlinkedLoading,
      maxResults,
      totalPropRefCount,
      totalLinkedRefCount,
      totalUnlinkedRefCount,
      filteredPropRefCount,
      filteredLinkedRefCount,
      filteredUnlinkedRefCount,
      totalVisibleRefCount,
      filteredVisibleRefCount,
      totalUniquePagesSize: totalUniquePages.size,
      filteredUniquePagesSize: filteredUniquePages.size,
      collapseMetrics,
      hasScopedView,
      showUnlinkedCounts,
      showScopedCounts,
      propertySectionCollapsed: this.isSectionCollapsed(state, 'property', collapseMetrics),
      linkedSectionCollapsed: this.isSectionCollapsed(state, 'linked', collapseMetrics),
      unlinkedSectionCollapsed: this.isSectionCollapsed(state, 'unlinked', collapseMetrics),
      summaryText: this.buildReferenceSummaryParts({
        searchMode,
        incompleteQueryDraft,
        queryFilterState,
        canApplyScopedQuery,
        hasScopedView,
        filteredUniquePagesSize: filteredUniquePages.size,
        totalUniquePagesSize: totalUniquePages.size,
        filteredVisibleRefCount,
        totalVisibleRefCount
      })[0] || '',
      summaryCount: this.buildReferenceSummaryCount({
        searchMode,
        incompleteQueryDraft,
        queryFilterState,
        canApplyScopedQuery,
        hasScopedView,
        filteredVisibleRefCount,
        totalVisibleRefCount
      })
    };
  }

  buildPropertyGroupsSignature(groups) {
    return (groups || []).map((group) => {
      const propertyName = (group?.propertyName || '').trim();
      const records = (group?.records || []).map((record) => {
        const guid = (record?.guid || '').trim();
        return `${guid}@${this.getRecordUpdatedTimestamp(record)}:${record?.getName?.() || ''}`;
      }).join(',');
      return `${propertyName}[${records}]`;
    }).join('||');
  }

  buildLineGroupsSignature(groups) {
    return (groups || []).map((group) => {
      const record = group?.record || null;
      const recordGuid = (record?.guid || '').trim();
      const recordName = record?.getName?.() || '';
      const lines = (group?.lines || []).map((line) => {
        const guid = (line?.guid || '').trim();
        return `${guid}@${this.getLineActivityTimestamp(line)}:${this.getLineContentText(line)}`;
      }).join(',');
      return `${recordGuid}:${recordName}[${lines}]`;
    }).join('||');
  }

  buildReferenceStatusRenderKey(viewState) {
    return [
      viewState.searchMode,
      viewState.incompleteQueryDraft === true ? 'draft' : 'ready',
      viewState.queryFilterState?.error || '',
      viewState.queryFilterState?.loading === true ? 'loading' : 'idle',
      viewState.canApplyScopedQuery === true ? 'scoped' : 'unscoped',
      viewState.propertyIndexStatus || 'idle',
      viewState.propertyIndexStats?.scannedRecords || 0,
      viewState.propertyIndexError || ''
    ].join('|');
  }

  buildPropertySectionRenderKey(state, viewState) {
    return [
      viewState.propertySectionCollapsed === true ? 'collapsed' : 'open',
      viewState.propertyError || '',
      viewState.propertyIndexStatus || 'idle',
      viewState.propertyIndexStats?.scannedRecords || 0,
      viewState.propertyIndexError || '',
      viewState.showScopedCounts === true ? 'scoped' : 'plain',
      viewState.hasScopedView === true ? 'filtered' : 'all',
      viewState.highlightQuery || '',
      viewState.filteredPropRefCount,
      viewState.totalPropRefCount,
      viewState.filteredLinkedRefCount,
      viewState.totalLinkedRefCount,
      viewState.linkedError || '',
      this.normalizeGroupBy(state?.groupBy) || this._defaultGroupBy,
      this.normalizeSortBy(state?.sortBy) || this._defaultSortBy,
      this.normalizeSortDir(state?.sortDir) || this._defaultSortDir,
      this.buildPropertyGroupsSignature(viewState.props),
      this.buildLineGroupsSignature(viewState.linked),
      state?.liveRenderVersion || 0,
      state?.linkedContextRenderVersion || 0
    ].join('|');
  }

  buildLinkedSectionRenderKey(state, viewState) {
    return [
      viewState.linkedSectionCollapsed === true ? 'collapsed' : 'open',
      viewState.linkedError || '',
      viewState.showScopedCounts === true ? 'scoped' : 'plain',
      viewState.hasScopedView === true ? 'filtered' : 'all',
      viewState.highlightQuery || '',
      viewState.filteredLinkedRefCount,
      viewState.totalLinkedRefCount,
      viewState.maxResults || 0,
      this.buildLineGroupsSignature(viewState.linked),
      state?.liveRenderVersion || 0,
      state?.linkedContextRenderVersion || 0
    ].join('|');
  }

  buildUnlinkedSectionRenderKey(state, viewState) {
    return [
      viewState.unlinkedSectionCollapsed === true ? 'collapsed' : 'open',
      viewState.unlinkedError || '',
      viewState.unlinkedDeferred === true ? 'deferred' : 'ready',
      viewState.unlinkedLoading === true ? 'loading' : 'idle',
      viewState.showScopedCounts === true ? 'scoped' : 'plain',
      viewState.showUnlinkedCounts === true ? 'show' : 'hide',
      viewState.hasScopedView === true ? 'filtered' : 'all',
      viewState.highlightQuery || '',
      viewState.filteredUnlinkedRefCount,
      viewState.totalUnlinkedRefCount,
      viewState.maxResults || 0,
      this.buildLineGroupsSignature(viewState.unlinked),
      state?.liveRenderVersion || 0,
      state?.linkedContextRenderVersion || 0
    ].join('|');
  }

  buildReferenceRenderPlan(state, viewState) {
    const currentKeys = state?.renderSectionKeys || {};
    const nextKeys = {
      status: this.buildReferenceStatusRenderKey(viewState),
      property: this.buildPropertySectionRenderKey(state, viewState),
      linked: this.buildLinkedSectionRenderKey(state, viewState),
      unlinked: this.buildUnlinkedSectionRenderKey(state, viewState)
    };
    return {
      nextKeys,
      statusChanged: currentKeys.status !== nextKeys.status,
      propertyChanged: currentKeys.property !== nextKeys.property,
      linkedChanged: currentKeys.linked !== nextKeys.linked,
      unlinkedChanged: currentKeys.unlinked !== nextKeys.unlinked
    };
  }

  appendReferenceStatus(body, viewState) {
    if (viewState.searchMode === 'query' && viewState.incompleteQueryDraft) {
      this.appendNote(body, 'Finish the query to filter the current backreferences.');
    } else if (viewState.searchMode === 'query' && viewState.queryFilterState?.error) {
      this.appendError(body, viewState.queryFilterState.error);
    } else if (viewState.searchMode === 'query' && viewState.queryFilterState?.loading === true) {
      this.appendNote(
        body,
        viewState.canApplyScopedQuery
          ? 'Refreshing query results...'
          : 'Applying query to current backreferences...'
      );
    } else if (viewState.propertyIndexStatus === 'indexing') {
      this.appendNote(body, viewState.propertyIndexMessage);
    } else if (viewState.propertyIndexStatus === 'idle') {
      this.appendNote(body, viewState.propertyIndexMessage);
    }
  }

  renderPropertyReferenceSection(body, state, viewState) {
    // Unified list: property + linked pages together (no equal-weight section titles).
    if (viewState.propertyError) {
      this.appendError(body, viewState.propertyError);
    } else if (viewState.propertyIndexStatus === 'indexing' || viewState.propertyIndexStatus === 'idle') {
      this.appendNote(body, viewState.propertyIndexMessage);
    } else if (viewState.propertyIndexStatus === 'error') {
      this.appendPropertyIndexError(body, viewState.propertyIndexError);
    }

    if (viewState.linkedError) {
      this.appendError(body, viewState.linkedError);
    }

    const propsReady = !viewState.propertyError
      && viewState.propertyIndexStatus !== 'indexing'
      && viewState.propertyIndexStatus !== 'idle'
      && viewState.propertyIndexStatus !== 'error';

    const props = propsReady ? (viewState.props || []) : [];
    const linked = viewState.linkedError ? [] : (viewState.linked || []);

    if (props.length === 0 && linked.length === 0) {
      if (propsReady || viewState.linkedError) {
        // Avoid duplicate empties while the property index is still warming.
        if (propsReady && !viewState.linkedError) {
          this.appendEmpty(
            body,
            viewState.hasScopedView ? 'No matching backlinks.' : 'No backlinks.'
          );
        }
      }
      return;
    }

    this.appendUnifiedBacklinkPages(body, props, linked, {
      query: viewState.highlightQuery,
      state,
      maxResults: viewState.maxResults,
      totalLineCount: viewState.totalLinkedRefCount
    });
  }

  renderLinkedReferenceSection(body, state, viewState) {
    // Linked refs render inside the unified list above.
    return;
  }

  renderUnlinkedReferenceSection(body, state, viewState) {
    const collapsed = viewState.unlinkedSectionCollapsed === true;

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'tlr-unlinked-pill button-none button-minimal-hover';
    pill.dataset.action = 'toggle-section';
    pill.dataset.sectionId = 'unlinked';
    pill.setAttribute('aria-expanded', collapsed ? 'false' : 'true');

    const caret = this.buildChevronIcon(collapsed, 'tlr-unlinked-pill-caret');
    const label = document.createElement('span');
    label.className = 'tlr-unlinked-pill-label';
    if (viewState.unlinkedLoading || (viewState.unlinkedDeferred && !collapsed)) {
      label.textContent = 'Loading unlinked mentions…';
    } else if (collapsed) {
      label.textContent = 'Find unlinked mentions';
    } else {
      const n = viewState.showScopedCounts && viewState.showUnlinkedCounts
        ? viewState.filteredUnlinkedRefCount
        : viewState.totalUnlinkedRefCount;
      label.textContent = Number(n) > 0
        ? `Unlinked mentions · ${n}`
        : 'Unlinked mentions';
    }
    pill.appendChild(caret);
    pill.appendChild(label);
    body.appendChild(pill);

    if (collapsed) return;

    const results = document.createElement('div');
    results.className = 'tlr-unlinked-results';

    if (viewState.unlinkedLoading || viewState.unlinkedDeferred) {
      this.appendNote(results, 'Loading unlinked references...');
      body.appendChild(results);
      return;
    }

    if (viewState.unlinkedError) {
      this.appendError(results, viewState.unlinkedError);
      body.appendChild(results);
      return;
    }

    this.appendLinkedReferenceGroups(results, viewState.unlinked, {
      groupSectionId: 'unlinked',
      state,
      maxResults: viewState.maxResults,
      query: viewState.highlightQuery,
      totalLineCount: viewState.totalUnlinkedRefCount,
      emptyMessage: viewState.hasScopedView ? 'No matching unlinked mentions.' : 'No unlinked mentions.'
    });
    body.appendChild(results);
  }

  appendReferenceDivider(container) {
    const divider = document.createElement('div');
    divider.className = 'tlr-divider';
    container.appendChild(divider);
  }

  renderReferences(state, {
    propertyGroups,
    propertyError,
    propertyIndexStatus,
    propertyIndexStats,
    propertyIndexError,
    linkedGroups,
    linkedError,
    unlinkedGroups,
    unlinkedError,
    unlinkedDeferred,
    unlinkedLoading,
    maxResults
  }) {
    if (!state?.bodyEl || !state?.countEl) return;
    if (!state?.statusSlotEl || !state?.propertySlotEl || !state?.linkedSlotEl || !state?.unlinkedSlotEl) return;

    const viewState = this.buildReferenceViewState(state, {
      propertyGroups,
      propertyError,
      propertyIndexStatus,
      propertyIndexStats,
      propertyIndexError,
      linkedGroups,
      linkedError,
      unlinkedGroups,
      unlinkedError,
      unlinkedDeferred,
      unlinkedLoading,
      maxResults
    });

    this.syncFooterCollapsedState(state, this.isFooterCollapsed(state, viewState.collapseMetrics));

    state.countEl.textContent = viewState.summaryCount;
    if (state.footerToggleEl) {
      state.footerToggleEl.title = viewState.summaryText || 'Collapse/expand';
    }
    const plan = this.buildReferenceRenderPlan(state, viewState);

    if (plan.statusChanged) {
      state.statusSlotEl.innerHTML = '';
      this.appendReferenceStatus(state.statusSlotEl, viewState);
    }
    if (plan.propertyChanged) {
      state.propertySlotEl.innerHTML = '';
      this.renderPropertyReferenceSection(state.propertySlotEl, state, viewState);
    }
    if (plan.linkedChanged) {
      state.linkedSlotEl.innerHTML = '';
      this.renderLinkedReferenceSection(state.linkedSlotEl, state, viewState);
    }
    if (plan.unlinkedChanged) {
      state.unlinkedSlotEl.innerHTML = '';
      this.renderUnlinkedReferenceSection(state.unlinkedSlotEl, state, viewState);
    }

    this.syncTimeMachineControl(state);
    this.renderTimeMachineSection(state);

    state.renderSectionKeys = plan.nextKeys;
  }

  buildChevronIcon(collapsed, extraClass) {
    const iconEl = document.createElement('span');
    iconEl.classList.add('ti', 'tlr-fold-icon');
    if (extraClass) iconEl.classList.add(extraClass);
    this.syncChevronIcon(iconEl, collapsed === true);
    iconEl.setAttribute('aria-hidden', 'true');
    return iconEl;
  }

  syncChevronIcon(iconEl, collapsed) {
    if (!iconEl?.classList) return;
    iconEl.classList.remove('ti-chevron-down', 'ti-chevron-right');
    iconEl.classList.add(collapsed === true ? 'ti-chevron-right' : 'ti-chevron-down');
  }

  appendCollapsibleSection(container, state, { sectionId, title, meta, collapsed }) {
    if (!container) return;

    const id = this.normalizeSectionId(sectionId) || 'property';
    const sectionCollapsed = collapsed === true;

    const sectionEl = document.createElement('div');
    sectionEl.className = 'tlr-section form-field';
    if (sectionCollapsed) sectionEl.classList.add('tlr-section-collapsed');

    const headerEl = document.createElement('div');
    headerEl.className = 'tlr-section-header form-field-row';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'tlr-btn tlr-section-toggle button-none button-small button-minimal-hover';
    toggleBtn.dataset.action = 'toggle-section';
    toggleBtn.dataset.sectionId = id;
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.setAttribute('aria-label', sectionCollapsed ? 'Expand section' : 'Collapse section');
    toggleBtn.setAttribute('aria-expanded', sectionCollapsed ? 'false' : 'true');
    toggleBtn.appendChild(this.buildChevronIcon(sectionCollapsed, 'tlr-section-caret'));

    const titleEl = document.createElement('div');
    titleEl.className = 'tlr-section-title text-details';
    titleEl.textContent = title || '';

    const metaEl = document.createElement('div');
    metaEl.className = 'tlr-section-meta text-details';
    metaEl.textContent = meta || '';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'tlr-section-body';

    headerEl.appendChild(toggleBtn);
    headerEl.appendChild(titleEl);
    headerEl.appendChild(metaEl);
    sectionEl.appendChild(headerEl);
    sectionEl.appendChild(bodyEl);
    container.appendChild(sectionEl);

    return { sectionEl, bodyEl };
  }

  appendError(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-error';
    el.textContent = message || 'Error loading references.';
    container.appendChild(el);
  }

  appendPropertyIndexError(container, message) {
    if (!container) return;
    this.appendError(container, message || 'Error indexing property references.');

    const action = document.createElement('button');
    action.className = 'tlr-btn button-none button-small button-minimal-hover';
    action.type = 'button';
    action.dataset.action = 'rebuild-property-index';
    action.textContent = 'Rebuild graph index';
    container.appendChild(action);
  }

  appendEmpty(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-empty';
    el.textContent = message || '';
    container.appendChild(el);
  }

  appendNote(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-note';
    el.textContent = message || '';
    container.appendChild(el);
  }

  // ---------- Inline record preview (transclusion) ----------

  buildExpandRecordBtn(recordGuid, state) {
    const isExpanded = state?.recordExpandedState?.get?.(recordGuid)?.expanded === true;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-btn tlr-expand-record-btn button-none button-small button-minimal-hover';
    btn.dataset.action = 'expand-record';
    btn.dataset.recordGuid = recordGuid;
    btn.title = isExpanded ? 'Hide record preview' : 'Preview record content inline';
    btn.setAttribute('aria-label', btn.title);
    if (isExpanded) btn.classList.add('is-expanded');
    btn.appendChild(this.buildChevronIcon(!isExpanded, 'tlr-expand-caret'));
    return btn;
  }

  buildRecordPreviewEl(recordGuid, state) {
    const previewEl = document.createElement('div');
    previewEl.className = 'tlr-record-preview';
    previewEl.dataset.previewGuid = recordGuid;
    const cached = state?.recordExpandedState?.get?.(recordGuid);
    if (cached?.expanded && cached?.allItems) {
      this.renderRecordPreview(previewEl, cached.allItems, recordGuid, cached.collapsedNodes || new Set());
    }
    return previewEl;
  }

  async toggleRecordExpansion(state, recordGuid, groupEl) {
    if (!state || !recordGuid || !groupEl) return;

    const expandBtn = groupEl.querySelector(`.tlr-expand-record-btn[data-record-guid="${recordGuid}"]`);
    const previewEl = groupEl.querySelector('.tlr-record-preview');
    const cached = state.recordExpandedState.get(recordGuid);

    const syncExpandCaret = (expanded) => {
      const caret = expandBtn?.querySelector?.('.tlr-expand-caret');
      if (caret) this.syncChevronIcon(caret, !expanded);
      if (expandBtn) {
        expandBtn.classList.toggle('is-expanded', expanded === true);
        expandBtn.title = expanded ? 'Hide record preview' : 'Preview record content inline';
        expandBtn.setAttribute('aria-label', expandBtn.title);
      }
    };

    if (cached?.expanded) {
      state.recordExpandedState.set(recordGuid, { expanded: false, allItems: null, collapsedNodes: new Set() });
      groupEl.classList.remove('tlr-record-expanded');
      syncExpandCaret(false);
      if (previewEl) previewEl.innerHTML = '';
      return;
    }

    if (previewEl) {
      previewEl.innerHTML = '';
      const loading = document.createElement('div');
      loading.className = 'tlr-expand-loading tlr-note';
      loading.textContent = 'Loading…';
      previewEl.appendChild(loading);
    }
    groupEl.classList.add('tlr-record-expanded');

    try {
      const record = this.data.getRecord?.(recordGuid) || null;
      if (!record) throw new Error('Record not found');

      const allItems = await record.getLineItems();
      const collapsedNodes = new Set();

      state.recordExpandedState.set(recordGuid, { expanded: true, allItems, collapsedNodes });

      if (previewEl) this.renderRecordPreview(previewEl, allItems, recordGuid, collapsedNodes);
    } catch (e) {
      if (previewEl) {
        previewEl.innerHTML = '';
        const err = document.createElement('div');
        err.className = 'tlr-error';
        err.textContent = 'Could not load record content.';
        previewEl.appendChild(err);
      }
      state.recordExpandedState.set(recordGuid, { expanded: true, allItems: [], collapsedNodes: new Set() });
    }

    syncExpandCaret(true);
  }

  /**
   * Transclusion/ref rows carry their target's guid somewhere in props or segments.
   * `getLineItems()` already ships the target's line items, so once we know the guid
   * we can render the transcluded subtree instead of an empty row.
   */
  resolveTransclusionTargetGuid(item, byGuid, childrenOf) {
    const candidates = [];
    const pushGuidish = (value) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text.length >= 10 && /^[0-9A-Z][0-9A-Z_-]{9,}$/i.test(text)) candidates.push(text);
    };
    const scan = (value, depth = 0) => {
      if (depth > 3 || value == null) return;
      if (typeof value === 'string') return pushGuidish(value);
      if (Array.isArray(value)) {
        for (const entry of value) scan(entry, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        for (const entry of Object.values(value)) scan(entry, depth + 1);
      }
    };

    scan(item?.props);
    for (const seg of item?.segments || []) scan(seg);

    for (const guid of candidates) {
      if (guid === item?.guid) continue;
      if (byGuid.has(guid) || childrenOf.has(guid)) return guid;
    }
    return '';
  }

  buildPreviewMarker(item, ordinal) {
    const type = item?.type || '';
    const marker = document.createElement('span');
    marker.className = `tlr-preview-marker tlr-preview-marker-${type || 'text'}`;

    if (type === 'task') {
      let done = null;
      try { done = item.isTaskCompleted?.(); } catch (e) { done = null; }
      marker.classList.add('tlr-preview-marker-checkbox');
      if (done === true) marker.classList.add('is-done');
      marker.textContent = done === true ? '✓' : '';
      return marker;
    }
    if (type === 'ulist') {
      marker.textContent = '•';
      return marker;
    }
    if (type === 'olist') {
      marker.textContent = `${ordinal}.`;
      marker.classList.add('tlr-preview-marker-ordinal');
      return marker;
    }
    return null;
  }

  renderRecordPreview(previewEl, allItems, recordGuid, collapsedNodes) {
    if (!previewEl) return;
    previewEl.innerHTML = '';

    if (!allItems || allItems.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'tlr-expand-empty';
      empty.textContent = '(empty)';
      previewEl.appendChild(empty);
      return;
    }

    const childrenOf = new Map();
    const byGuid = new Map();
    for (const item of allItems) {
      const guid = item?.guid || '';
      if (guid) byGuid.set(guid, item);
      const p = item.parent_guid || recordGuid;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      const siblings = childrenOf.get(p);
      // expandReferences can ship the same guid twice under one parent.
      if (guid && siblings.some((s) => s?.guid === guid)) continue;
      siblings.push(item);
    }

    const renderChildren = (parentGuid, visiting) => {
      const children = childrenOf.get(parentGuid) || [];
      if (!children.length) return null;
      const wrap = document.createElement('div');
      wrap.className = 'tlr-preview-children';
      let ordinal = 0;
      for (const child of children) {
        ordinal = child?.type === 'olist' ? ordinal + 1 : 0;
        wrap.appendChild(renderNode(child, ordinal, visiting));
      }
      return wrap;
    };

    const renderNode = (item, ordinal, visiting) => {
      const guid = item.guid || '';
      const type = item?.type || 'text';
      const isCollapsed = collapsedNodes.has(guid);
      // Native editor: `ref` = link pill (no body); `transclusion` = embed with children.
      const isLinkRef = type === 'ref';
      const isTransclusion = type === 'transclusion';

      const nodeEl = document.createElement('div');
      nodeEl.className = 'tlr-preview-node';
      nodeEl.dataset.nodeGuid = guid;
      if (type) nodeEl.dataset.lineType = type;

      const rowEl = document.createElement('div');
      rowEl.className = `tlr-preview-row tlr-preview-row-${type}`;

      let targetGuid = '';
      if ((isTransclusion || isLinkRef) && !visiting.has(guid)) {
        targetGuid = this.resolveTransclusionTargetGuid(item, byGuid, childrenOf);
      }

      const ownChildren = isLinkRef ? [] : (childrenOf.get(guid) || []);
      const targetChildren = (!isLinkRef && targetGuid) ? (childrenOf.get(targetGuid) || []) : [];
      // Prefer the clean target tree when present — ownChildren can be a flattened
      // expandReferences copy that duplicates the same nodes at multiple depths.
      const embeddedParentGuid = targetChildren.length > 0
        ? targetGuid
        : (ownChildren.length > 0 ? guid : '');
      const hasChildren = !!embeddedParentGuid;

      const toggleEl = document.createElement('button');
      toggleEl.type = 'button';
      toggleEl.className = 'tlr-preview-toggle button-none';
      if (hasChildren) {
        toggleEl.dataset.action = 'toggle-preview-node';
        toggleEl.dataset.nodeGuid = guid;
        toggleEl.dataset.recordGuid = recordGuid;
        toggleEl.setAttribute('aria-label', isCollapsed ? 'Expand' : 'Collapse');
        const arrow = document.createElement('span');
        arrow.className = 'tlr-preview-arrow' + (isCollapsed ? ' is-collapsed' : '');
        toggleEl.appendChild(arrow);
      }
      rowEl.appendChild(toggleEl);

      if (!isLinkRef) {
        const marker = this.buildPreviewMarker(item, ordinal);
        if (marker) rowEl.appendChild(marker);
      }

      const lineBtn = document.createElement('button');
      lineBtn.type = 'button';
      lineBtn.className = 'tlr-expand-line button-none';
      if (isLinkRef) lineBtn.classList.add('tlr-preview-link-pill');
      if (isTransclusion) lineBtn.classList.add('tlr-preview-transclusion-title');
      lineBtn.dataset.action = 'open-line';
      lineBtn.dataset.recordGuid = recordGuid;
      lineBtn.dataset.lineGuid = guid;
      this.appendLineText(lineBtn, item, '', { skipPrefix: true });

      if ((isTransclusion || isLinkRef) && !this.lineHasVisibleContent(item)) {
        const targetItem = targetGuid ? byGuid.get(targetGuid) : null;
        if (targetItem) {
          this.appendLineText(lineBtn, targetItem, '', { skipPrefix: true });
        } else if (targetGuid) {
          const name = this.resolveRecordName?.(targetGuid) || '';
          const placeholder = document.createElement('span');
          placeholder.className = 'tlr-preview-embed-note';
          placeholder.textContent = name || (isLinkRef ? 'Linked note' : 'Embedded content');
          lineBtn.appendChild(placeholder);
        } else {
          const placeholder = document.createElement('span');
          placeholder.className = 'tlr-preview-embed-note';
          placeholder.textContent = isLinkRef ? 'Linked note' : 'Embedded content';
          lineBtn.appendChild(placeholder);
        }
      }
      if (isTransclusion || isLinkRef) {
        const glyph = document.createElement('span');
        glyph.className = 'tlr-preview-reference-glyph';
        glyph.textContent = '↗';
        glyph.setAttribute('aria-hidden', 'true');
        lineBtn.appendChild(glyph);
      }
      rowEl.appendChild(lineBtn);

      nodeEl.appendChild(rowEl);

      if (hasChildren && embeddedParentGuid && !visiting.has(embeddedParentGuid)) {
        const nextVisiting = new Set(visiting);
        nextVisiting.add(guid);
        if (targetGuid) nextVisiting.add(targetGuid);

        const childrenEl = renderChildren(embeddedParentGuid, nextVisiting);
        const holder = document.createElement('div');
        holder.className = 'tlr-preview-children-holder' + (isCollapsed ? ' is-hidden' : '');
        if (childrenEl) {
          if (isTransclusion) childrenEl.classList.add('tlr-preview-transcluded');
          holder.appendChild(childrenEl);
        }
        nodeEl.appendChild(holder);
      }

      return nodeEl;
    };

    const roots = childrenOf.get(recordGuid) || [];
    let ordinal = 0;
    for (const root of roots) {
      ordinal = root?.type === 'olist' ? ordinal + 1 : 0;
      previewEl.appendChild(renderNode(root, ordinal, new Set()));
    }
  }

  /** Collection display name from the built-in Collection property when present. */
  getRecordCollectionLabel(record) {
    if (!record || typeof record.prop !== 'function') return '';
    try {
      const prop = record.prop('Collection') || record.prop('collection');
      if (!prop) return '';
      if (typeof prop.choiceLabel === 'function') {
        const label = (prop.choiceLabel() || '').trim();
        if (label) return label;
      }
      if (typeof prop.text === 'function') {
        const text = (prop.text() || '').trim();
        if (text) return text;
      }
    } catch (e) {
      // ignore
    }
    return '';
  }

  /**
   * Thymer's icon font only ships a subset of Tabler, so glyphs like `affiliate` render
   * blank through `ui.createIcon`. These are inlined from the Tabler outline sources.
   */
  inlineIconMarkup(kind, sizePx) {
    const paths = {
      affiliate: '<path d="M5.931 6.936l1.275 4.249m5.607 5.609l4.251 1.275"/><path d="M11.683 12.317l5.759 -5.759"/><path d="M4 5.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/><path d="M17 5.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/><path d="M17 18.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/><path d="M4 15.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0"/>',
      book: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6l0 13"/><path d="M12 6l0 13"/><path d="M21 6l0 13"/>',
      article: '<path d="M3 6a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -12"/><path d="M7 8h10"/><path d="M7 12h10"/><path d="M7 16h10"/>',
      microphone: '<path d="M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3l0 -5"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M8 21l8 0"/><path d="M12 17l0 4"/>',
      video: '<path d="M15 10l4.553 -2.276a1 1 0 0 1 1.447 .894v6.764a1 1 0 0 1 -1.447 .894l-4.553 -2.276v-4"/><path d="M3 8a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v8a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -8"/>'
    };
    const body = paths[kind];
    if (!body) return '';
    const n = sizePx || 15;
    return '<svg xmlns="http://www.w3.org/2000/svg" width="' + n + '" height="' + n
      + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"'
      + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  }

  buildInlineIcon(kind, sizePx) {
    const markup = this.inlineIconMarkup(kind, sizePx);
    if (!markup) return null;
    const wrap = document.createElement('span');
    wrap.className = 'tlr-inline-svg-icon';
    wrap.setAttribute('aria-hidden', 'true');
    wrap.innerHTML = markup;
    return wrap;
  }

  /**
   * Readwise Reference records all share one collection icon, so prefer their
   * `source_category` choice (Books / Articles / Podcasts / Video) when present.
   */
  getCategoryIconKind(record) {
    let raw = '';
    try {
      if (typeof record?.choice !== 'function') return '';
      const ch = record.choice('source_category');
      if (ch == null) return '';
      raw = typeof ch === 'string' ? ch : String(ch.id || ch.label || '');
    } catch (e) {
      return '';
    }
    const k = raw.trim().toLowerCase();
    if (!k) return '';
    if (k.startsWith('book')) return 'book';
    if (k.startsWith('article') || k === 'rss' || k.startsWith('email')) return 'article';
    if (k.startsWith('podcast')) return 'microphone';
    if (k.startsWith('video') || k.startsWith('tweet')) return 'video';
    return '';
  }

  appendRecordIcon(container, record) {
    if (!container || !record) return;

    const categoryKind = this.getCategoryIconKind(record);
    if (categoryKind) {
      const inlineEl = this.buildInlineIcon(categoryKind, 14);
      if (inlineEl) {
        inlineEl.classList.add('tlr-record-icon');
        container.appendChild(inlineEl);
        return;
      }
    }

    let iconName = '';
    try { iconName = record.getIcon?.(true) || record.getIcon?.() || ''; } catch (e) { iconName = ''; }
    if (!iconName) return;
    try {
      const iconEl = this.ui.createIcon(iconName);
      iconEl.classList.add('tlr-record-icon');
      container.appendChild(iconEl);
    } catch (e) {
      const span = document.createElement('span');
      span.className = `ti ${iconName} tlr-record-icon`;
      span.setAttribute('aria-hidden', 'true');
      container.appendChild(span);
    }
  }

  appendTitleMeta(container, metaText) {
    const text = (metaText || '').trim();
    if (!container || !text) return;
    const sep = document.createElement('span');
    sep.className = 'tlr-title-sep';
    sep.textContent = '·';
    const meta = document.createElement('span');
    meta.className = 'tlr-title-meta';
    meta.textContent = text;
    container.appendChild(sep);
    container.appendChild(meta);
  }

  /**
   * Format a property chip like the built-in backlinks: "When → Fri Jul 31".
   */
  /** True when every backlink arrived through the same property. */
  hasUniformProperty(pages) {
    const seen = new Set();
    for (const page of pages || []) {
      for (const propName of page?.properties || []) {
        seen.add(propName);
        if (seen.size > 1) return false;
      }
    }
    return seen.size === 1;
  }

  /**
   * Display value for a property. Link-type values are omitted by default: on a
   * page's own backlink list they are mostly the page itself plus co-participants,
   * which makes every row a different length for no added meaning.
   */
  getPropertyDisplayValue(record, propertyName, opts) {
    if (!record || typeof record.prop !== 'function') return '';
    const name = (propertyName || '').trim();
    if (!name) return '';
    const includeLinks = opts?.includeLinks === true;
    try {
      const prop = record.prop(name);
      if (!prop) return '';

      try {
        if (typeof prop.date === 'function') {
          const d = prop.date();
          if (d instanceof Date && !Number.isNaN(d.getTime())) {
            return this.formatShortDateLabel(d);
          }
        }
      } catch (e) { /* ignore */ }

      // Link-type properties before text(): text() returns raw GUIDs.
      try {
        const linked = typeof prop.linkedRecords === 'function' ? (prop.linkedRecords() || []) : [];
        if (linked.length) {
          if (!includeLinks) return '';
          const names = linked
            .map((r) => (r?.getName?.() || '').trim())
            .filter(Boolean);
          if (names.length) return names.join(', ');
        }
      } catch (e) { /* ignore */ }

      try {
        if (typeof prop.choiceLabel === 'function') {
          const label = this.resolveGuidishLabel(prop.choiceLabel(), includeLinks);
          if (label) return label;
        }
      } catch (e) { /* ignore */ }

      try {
        if (typeof prop.text === 'function') {
          const text = this.resolveGuidishLabel(prop.text(), includeLinks);
          if (text) return text;
        }
      } catch (e) { /* ignore */ }

      try {
        const raw = typeof prop.get === 'function' ? prop.get() : prop.value;
        if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
          return this.formatShortDateLabel(raw);
        }
        if (typeof raw === 'string') {
          const resolved = this.resolveGuidishLabel(raw, includeLinks);
          if (resolved) return resolved;
        }
        if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw);
      } catch (e) { /* ignore */ }
    } catch (e) {
      // ignore
    }
    return '';
  }

  /** Turn a bare record GUID into its page name; blank when it stays unresolvable. */
  resolveGuidishLabel(value, resolveLinks) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    if (!/^[0-9A-Z]{20,32}$/.test(text)) return text;
    if (resolveLinks !== true) return '';
    try {
      const name = (this.data.getRecord?.(text)?.getName?.() || '').trim();
      if (name) return name;
    } catch (e) {
      // ignore
    }
    return '';
  }

  formatShortDateLabel(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric'
      });
    } catch (e) {
      return date.toISOString().slice(0, 10);
    }
  }

  collectUnifiedBacklinkPages(propertyGroups, linkedGroups) {
    const byGuid = new Map();

    for (const g of propertyGroups || []) {
      const propName = (g?.propertyName || '').trim();
      if (!propName) continue;
      for (const r of g?.records || []) {
        const guid = r?.guid || '';
        if (!guid) continue;
        let entry = byGuid.get(guid);
        if (!entry) {
          entry = { record: r, properties: [], lines: [] };
          byGuid.set(guid, entry);
        }
        if (!entry.properties.includes(propName)) entry.properties.push(propName);
      }
    }

    for (const g of linkedGroups || []) {
      const record = g?.record || null;
      const guid = record?.guid || '';
      if (!guid) continue;
      let entry = byGuid.get(guid);
      if (!entry) {
        entry = { record, properties: [], lines: [] };
        byGuid.set(guid, entry);
      } else if (!entry.record && record) {
        entry.record = record;
      }
      const lines = Array.isArray(g?.lines) ? g.lines : [];
      for (const line of lines) {
        const lineGuid = line?.guid || '';
        if (!lineGuid) continue;
        if (!entry.lines.some((x) => x?.guid === lineGuid)) entry.lines.push(line);
      }
    }

    return Array.from(byGuid.values()).filter((p) => p?.record?.guid);
  }

  /** Meta shown after the title as `· parts`; collection is already conveyed by title templates. */
  getUnifiedPageMetaParts(page, groupBy, opts) {
    const parts = [];
    const record = page?.record || null;
    const targetJournalIso = (opts?.targetJournalIso || '').trim();

    if (groupBy !== 'property') {
      const uniformProperty = opts?.uniformProperty === true;
      for (const propName of page?.properties || []) {
        const value = this.getPropertyDisplayValue(record, propName);
        // On a journal page, date props that land on that same day are the reason
        // the row is here — "When → Fri, Jul 31" just restates the page you're on.
        if (value && targetJournalIso && this.propertyDateMatchesIso(record, propName, targetJournalIso)) {
          parts.push(propName);
        } else if (value) {
          parts.push(`${propName} → ${value}`);
        } else if (!uniformProperty) {
          parts.push(propName);
        }
      }
    }

    return parts;
  }

  propertyDateMatchesIso(record, propertyName, dateIso) {
    const iso = this.normalizeDateToIso(dateIso);
    const name = (propertyName || '').trim();
    if (!record || !iso || !name || typeof record.prop !== 'function') return false;
    try {
      const prop = record.prop(name);
      if (!prop || typeof prop.date !== 'function') return false;
      const d = prop.date();
      if (!(d instanceof Date) || Number.isNaN(d.getTime())) return false;
      return this.normalizeDateToIso(d) === iso;
    } catch (e) {
      return false;
    }
  }

  getUnifiedPageBucketKey(page, groupBy, sortBy) {
    if (groupBy === 'collection') {
      return this.getRecordCollectionLabel(page?.record) || 'No collection';
    }
    if (groupBy === 'property') {
      // Caller expands multi-property pages into one bucket per property.
      return (page?.bucketProperty || page?.properties?.[0] || 'Linked references').trim() || 'Linked references';
    }
    if (groupBy === 'time') {
      // Borrow the date the list is already sorted by, so headings can't contradict the order.
      const key = this.normalizeSortBy(sortBy) || this._defaultSortBy;
      const ts = key === 'page_last_edited'
        ? this.getRecordUpdatedTimestamp(page?.record)
        : (this.getRecordJournalPageTimestamp(page?.record) || this.getRecordUpdatedTimestamp(page?.record));
      if (!ts) return 'No date';
      try {
        return this.formatMonthLabel(new Date(ts)) || 'No date';
      } catch (e) {
        return 'No date';
      }
    }
    return '';
  }

  formatMonthLabel(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    try {
      return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    } catch (e) {
      return date.toISOString().slice(0, 7);
    }
  }

  expandPagesForGrouping(pages, groupBy) {
    if (groupBy !== 'property') return pages || [];
    const out = [];
    for (const page of pages || []) {
      const props = page.properties || [];
      const lines = page.lines || [];
      if (props.length === 0) {
        out.push({ ...page, bucketProperty: 'Linked references' });
        continue;
      }
      for (const propName of props) {
        out.push({ ...page, bucketProperty: propName, properties: [propName], lines: [] });
      }
      // Inline mentions belong to their own bucket, not repeated under each property.
      if (lines.length) {
        out.push({ ...page, bucketProperty: 'Linked references', properties: [], lines });
      }
    }
    return out;
  }

  /**
   * Keep the chosen sort order but pull every page of a bucket together, so a
   * bucket heading is emitted once instead of repeating down the list.
   */
  clusterPagesByBucket(pages, groupBy, sortBy) {
    if (groupBy === 'none') return pages || [];
    const buckets = new Map();
    for (const page of pages || []) {
      const key = this.getUnifiedPageBucketKey(page, groupBy, sortBy) || '';
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(page);
    }
    const out = [];
    for (const list of buckets.values()) out.push(...list);
    return out;
  }

  appendUnifiedBucketHeader(container, label) {
    const text = (label || '').trim();
    if (!container || !text) return;
    const head = document.createElement('div');
    head.className = 'tlr-bucket-header text-details';
    head.textContent = text;
    container.appendChild(head);
  }

  /**
   * Unified page-centric backlinks: collection icon + title · meta, property chips,
   * and linked line snippets — optionally bucketed by collection / property / time.
   */
  appendUnifiedBacklinkPages(container, propertyGroups, linkedGroups, opts) {
    if (!container) return;

    const query = (opts?.query || '').trim();
    const state = opts?.state || null;
    const maxResults = opts?.maxResults || 0;
    const totalLineCount = typeof opts?.totalLineCount === 'number' ? opts.totalLineCount : null;
    const groupBy = this.normalizeGroupBy(state?.groupBy) || this._defaultGroupBy;
    const sortSpec = {
      sortBy: this.normalizeSortBy(state?.sortBy) || this._defaultSortBy,
      sortDir: this.normalizeSortDir(state?.sortDir) || this._defaultSortDir
    };

    let targetName = '';
    let targetJournalIso = '';
    try {
      const target = this.data.getRecord?.(state?.recordGuid || '') || null;
      targetName = (target?.getName?.() || '').trim();
      targetJournalIso = this.getRecordDateReferenceIso(target) || '';
    } catch (e) {
      targetName = '';
      targetJournalIso = '';
    }

    let pages = this.collectUnifiedBacklinkPages(propertyGroups, linkedGroups);
    pages.sort((a, b) => this.compareRecordsForSort(a.record, b.record, sortSpec));
    pages = this.expandPagesForGrouping(pages, groupBy);
    pages = this.clusterPagesByBucket(pages, groupBy, sortSpec.sortBy);

    if (pages.length === 0) return;

    const uniformProperty = this.hasUniformProperty(pages);
    let lastBucket = null;
    for (const page of pages) {
      const record = page.record;
      const guid = record?.guid || '';
      if (!guid) continue;

      if (groupBy !== 'none') {
        const bucket = this.getUnifiedPageBucketKey(page, groupBy, sortSpec.sortBy);
        if (bucket && bucket !== lastBucket) {
          this.appendUnifiedBucketHeader(container, bucket);
          lastBucket = bucket;
        }
      }

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group tlr-group-unified';
      if ((page.properties || []).length) groupEl.classList.add('tlr-group-property');
      if ((page.lines || []).length) groupEl.classList.add('tlr-group-linked');
      if ((page.lines || []).length === 1 && !(page.properties || []).length) {
        groupEl.classList.add('tlr-group-single');
      }
      if (state?.recordExpandedState?.get?.(guid)?.expanded === true) {
        groupEl.classList.add('tlr-record-expanded');
      }

      const rowEl = document.createElement('div');
      rowEl.className = 'tlr-group-row tlr-prop-record-row';

      // One chevron per row (preview) — matched lines always stay visible.
      rowEl.appendChild(this.buildExpandRecordBtn(guid, state));

      const titleBtn = document.createElement('button');
      titleBtn.type = 'button';
      titleBtn.className = 'tlr-group-header tlr-prop-record button-none button-minimal-hover';
      titleBtn.dataset.action = 'open-record';
      titleBtn.dataset.recordGuid = guid;

      const titleInner = document.createElement('div');
      titleInner.className = 'tlr-group-title';
      // Always reserve the icon slot so titles line up whether or not one exists.
      const iconSlot = document.createElement('span');
      iconSlot.className = 'tlr-record-icon-slot';
      this.appendRecordIcon(iconSlot, record);
      titleInner.appendChild(iconSlot);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tlr-group-title-text';
      this.appendHighlightedText(nameSpan, record.getName?.() || 'Untitled', query);
      titleInner.appendChild(nameSpan);
      titleBtn.appendChild(titleInner);

      const metaParts = this.getUnifiedPageMetaParts(page, groupBy, {
        uniformProperty,
        targetName,
        targetJournalIso
      });
      if (metaParts.length) {
        const metaEl = document.createElement('div');
        metaEl.className = 'tlr-row-meta';
        for (const part of metaParts) this.appendTitleMeta(metaEl, part);
        titleBtn.appendChild(metaEl);
      }

      if ((page.properties || []).length) {
        this.appendLiveBadges(
          titleBtn,
          state,
          this.getPropertySnapshotKey(page.properties[0] || 'prop', guid)
        );
      }

      rowEl.appendChild(titleBtn);
      groupEl.appendChild(rowEl);
      groupEl.appendChild(this.buildRecordPreviewEl(guid, state));

      if ((page.lines || []).length > 0) {
        const linesEl = document.createElement('div');
        linesEl.className = 'tlr-lines';
        for (const line of page.lines) {
          const entryEl = document.createElement('div');
          entryEl.className = 'tlr-line-entry';

          const ctx = state ? this.getLinkedContextState(state, line.guid) : null;
          if (state && ctx && this.hasRequestedLinkedContext(ctx) && ctx.loaded !== true && ctx.loading !== true) {
            this.ensureLinkedContextLoaded(state, line).catch(() => {});
          }

          this.appendLinkedContextRows(entryEl, guid, ctx, query, 'top');

          const lineEl = document.createElement('button');
          lineEl.type = 'button';
          lineEl.className = 'tlr-line button-none button-minimal-hover';
          lineEl.dataset.action = 'open-line';
          lineEl.dataset.recordGuid = guid;
          lineEl.dataset.lineGuid = line.guid;
          this.appendLineText(lineEl, line, query);
          this.appendLiveBadges(lineEl, state, this.getLinkedSnapshotKey(line.guid));

          const lineCluster = document.createElement('div');
          lineCluster.className = 'tlr-line-title-cluster';
          lineCluster.appendChild(lineEl);

          const mainRowEl = document.createElement('div');
          mainRowEl.className = 'tlr-line-main';
          mainRowEl.appendChild(lineCluster);
          entryEl.appendChild(mainRowEl);

          if (state && ctx) {
            if (ctx.showMoreContext === true) mainRowEl.classList.add('is-context-open');
            const controlsEl = this.buildLinkedContextControls(line.guid, ctx, {
              showLinkAction: false
            });
            if (controlsEl) mainRowEl.appendChild(controlsEl);

            if (ctx.loading === true && ctx.backgroundLoading !== true) {
              const loadingEl = document.createElement('div');
              loadingEl.className = 'tlr-note tlr-context-note';
              loadingEl.textContent = 'Loading context...';
              entryEl.appendChild(loadingEl);
            } else if (ctx.error) {
              const errorEl = document.createElement('div');
              errorEl.className = 'tlr-error tlr-context-note';
              errorEl.textContent = ctx.error;
              entryEl.appendChild(errorEl);
            }
          }

          this.appendLinkedContextRows(entryEl, guid, ctx, query, 'bottom');
          linesEl.appendChild(entryEl);
        }
        groupEl.appendChild(linesEl);
      }

      container.appendChild(groupEl);
    }

    if (maxResults > 0 && (totalLineCount ?? 0) >= maxResults) {
      const note = document.createElement('div');
      note.className = 'tlr-note';
      note.textContent = `Showing first ${maxResults} matches.`;
      container.appendChild(note);
    }
  }

  appendPropertyReferencePages(container, groups, opts) {
    // Legacy entry point — render property-only pages via the unified path.
    return this.appendUnifiedBacklinkPages(container, groups, [], opts);
  }

  appendPropertyReferenceGroups(container, groups, opts) {
    // Kept as a thin alias for any older call sites.
    return this.appendPropertyReferencePages(container, groups, opts);
  }

  appendLinkedReferenceGroups(container, groups, opts) {
    if (!container) return;

    const groupSectionId = this.normalizeRecordGroupSectionId(opts?.groupSectionId) || 'linked';
    const state = opts?.state || null;
    const maxResults = opts?.maxResults || 0;
    const query = (opts?.query || '').trim();
    const totalLineCount = typeof opts?.totalLineCount === 'number' ? opts.totalLineCount : null;
    const emptyMessage = (opts?.emptyMessage || '').trim() || 'No linked references.';

    const pageCount = groups.length;
    const refCount = groups.reduce((n, g) => n + (g?.lines?.length || 0), 0);

    if (pageCount === 0) {
      if (opts?.quietEmpty === true || !emptyMessage) return;
      const empty = document.createElement('div');
      empty.className = 'tlr-empty';
      empty.textContent = emptyMessage;
      container.appendChild(empty);
      return;
    }

    for (const g of groups) {
      const record = g.record || null;
      const recordGuid = record?.guid || null;
      if (!recordGuid) continue;
      const lines = Array.isArray(g.lines) ? g.lines : [];
      const singleRefGroup = lines.length === 1;
      const targetRecordGuid = state?.recordGuid || '';
      const groupCollapsed = this.isRecordGroupCollapsed(groupSectionId, targetRecordGuid, recordGuid);

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';
      groupEl.classList.add(`tlr-group-${groupSectionId}`);
      if (singleRefGroup) groupEl.classList.add('tlr-group-single');
      if (groupCollapsed) groupEl.classList.add('tlr-group-collapsed');
      if (state?.recordExpandedState?.get?.(recordGuid)?.expanded === true) {
        groupEl.classList.add('tlr-record-expanded');
      }

      const rowEl = document.createElement('div');
      rowEl.className = 'tlr-group-row';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'tlr-btn tlr-group-toggle button-none button-small button-minimal-hover';
      toggleBtn.dataset.action = 'toggle-record-group';
      toggleBtn.dataset.groupSectionId = groupSectionId;
      toggleBtn.dataset.targetRecordGuid = targetRecordGuid;
      toggleBtn.dataset.recordGuid = recordGuid;
      toggleBtn.title = groupCollapsed ? 'Expand' : 'Collapse';
      toggleBtn.setAttribute('aria-label', groupCollapsed ? 'Expand' : 'Collapse');
      toggleBtn.setAttribute('aria-expanded', groupCollapsed ? 'false' : 'true');
      toggleBtn.appendChild(this.buildChevronIcon(groupCollapsed, 'tlr-group-caret'));

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-group-header button-none button-minimal-hover';
      header.dataset.action = 'open-record';
      header.dataset.recordGuid = recordGuid;

      const title = document.createElement('div');
      title.className = 'tlr-group-title';
      this.appendRecordIcon(title, record);
      const nameSpan = document.createElement('span');
      nameSpan.className = 'tlr-group-title-text';
      nameSpan.textContent = record.getName?.() || 'Untitled';
      title.appendChild(nameSpan);
      this.appendTitleMeta(title, this.getRecordCollectionLabel(record));

      header.appendChild(title);

      rowEl.appendChild(toggleBtn);
      rowEl.appendChild(this.buildExpandRecordBtn(recordGuid, state));
      rowEl.appendChild(header);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of lines) {
        const entryEl = document.createElement('div');
        entryEl.className = 'tlr-line-entry';

        const ctx = state ? this.getLinkedContextState(state, line.guid) : null;
        if (state && ctx && this.hasRequestedLinkedContext(ctx) && ctx.loaded !== true && ctx.loading !== true) {
          this.ensureLinkedContextLoaded(state, line).catch(() => {
            // ignore
          });
        }

        this.appendLinkedContextRows(entryEl, recordGuid, ctx, query, 'top');

        const lineEl = document.createElement('button');
        lineEl.type = 'button';
        lineEl.className = 'tlr-line button-none button-minimal-hover';
        lineEl.dataset.action = 'open-line';
        lineEl.dataset.recordGuid = recordGuid;
        lineEl.dataset.lineGuid = line.guid;
        this.appendLineText(lineEl, line, query);
        this.appendLiveBadges(lineEl, state, this.getLinkedSnapshotKey(line.guid));
        const lineCluster = document.createElement('div');
        lineCluster.className = 'tlr-line-title-cluster';
        lineCluster.appendChild(lineEl);

        const mainRowEl = document.createElement('div');
        mainRowEl.className = 'tlr-line-main';
        mainRowEl.appendChild(lineCluster);
        entryEl.appendChild(mainRowEl);

        if (state && ctx) {
          if (ctx.showMoreContext === true) mainRowEl.classList.add('is-context-open');
          const controlsEl = this.buildLinkedContextControls(line.guid, ctx, {
            showLinkAction: groupSectionId === 'unlinked'
          });
          if (controlsEl) mainRowEl.appendChild(controlsEl);

          if (ctx.loading === true && ctx.backgroundLoading !== true) {
            const loadingEl = document.createElement('div');
            loadingEl.className = 'tlr-note tlr-context-note';
            loadingEl.textContent = 'Loading context...';
            entryEl.appendChild(loadingEl);
          } else if (ctx.error) {
            const errorEl = document.createElement('div');
            errorEl.className = 'tlr-error tlr-context-note';
            errorEl.textContent = ctx.error;
            entryEl.appendChild(errorEl);
          }
        }

        this.appendLinkedContextRows(entryEl, recordGuid, ctx, query, 'bottom');
        linesEl.appendChild(entryEl);
      }

      groupEl.appendChild(rowEl);
      groupEl.appendChild(this.buildRecordPreviewEl(recordGuid, state));
      groupEl.appendChild(linesEl);
      container.appendChild(groupEl);
    }

    if (maxResults > 0 && (totalLineCount ?? refCount) >= maxResults) {
      const note = document.createElement('div');
      note.className = 'tlr-note';
      note.textContent = `Showing first ${maxResults} matches.`;
      container.appendChild(note);
    }
  }

  buildLinkedContextControls(lineGuid, ctx, opts = {}) {
    const controls = document.createElement('div');
    controls.className = 'tlr-line-actions text-details';

    const group = document.createElement('div');
    group.className = 'tlr-line-actions-group';

    if (opts.showLinkAction === true) {
      group.appendChild(this.buildUnlinkedLinkButton(lineGuid));
    }

    if (ctx?.showMoreContext === true) {
      const availableAbove = this.getAvailableAboveContextCount(ctx);
      const availableBelow = this.getAvailableBelowContextCount(ctx);
      const showingAbove = (ctx?.siblingAboveCount || 0) > 0;
      const showingBelow = (ctx?.siblingBelowCount || 0) > 0;

      if (showingAbove || availableAbove > 0) {
        group.appendChild(this.buildLinkedContextButton('toggle-context-above', lineGuid, {
          icon: 'up',
          label: this.getAboveToggleLabel(ctx),
          disabled: ctx?.loaded === true && availableAbove === 0,
          active: showingAbove
        }));
      }
      if (showingBelow || availableBelow > 0) {
        group.appendChild(this.buildLinkedContextButton('toggle-context-below', lineGuid, {
          icon: 'down',
          label: this.getBelowToggleLabel(ctx),
          disabled: ctx?.loaded === true && availableBelow === 0,
          active: showingBelow
        }));
      }
    }

    const shouldShowContextToggle = ctx?.showMoreContext === true
      || this.hasAnyLinkedContext(ctx);
    if (shouldShowContextToggle) {
      group.appendChild(this.buildLinkedContextButton('toggle-context-more', lineGuid, {
        icon: 'toggle',
        label: ctx?.showMoreContext === true ? 'Hide context' : 'Show more context',
        disabled: ctx?.showMoreContext !== true && ctx?.loaded === true && !this.hasAnyLinkedContext(ctx),
        active: ctx?.showMoreContext === true
      }));
    }

    if (group.children.length === 0) controls.classList.add('is-empty');
    controls.appendChild(group);
    return controls;
  }

  buildUnlinkedLinkButton(lineGuid) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-unlinked-link-btn button-none button-small button-minimal-hover tooltip';
    btn.dataset.action = 'link-unlinked';
    btn.dataset.lineGuid = lineGuid || '';
    btn.title = 'Link mention';
    btn.setAttribute('aria-label', 'Link mention');
    btn.setAttribute('data-tooltip', 'Link mention');
    btn.setAttribute('data-tooltip-dir', 'top');

    let iconEl = null;
    try {
      iconEl = this.ui.createIcon('ti-link');
    } catch (e) {
      iconEl = null;
    }

    if (iconEl) {
      iconEl.classList.add('tlr-unlinked-link-icon');
      btn.appendChild(iconEl);
    } else {
      btn.textContent = 'Link';
      btn.classList.add('tlr-unlinked-link-btn-fallback');
    }

    return btn;
  }

  buildLinkedContextButton(action, lineGuid, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-context-btn button-none button-small button-minimal-hover';
    btn.dataset.action = action;
    btn.dataset.lineGuid = lineGuid || '';
    btn.title = opts?.label || '';
    btn.setAttribute('aria-label', opts?.label || '');
    btn.classList.add(`tlr-context-btn-${opts?.icon || 'more'}`);
    if (opts?.active === true) btn.classList.add('is-active');
    if (opts?.disabled === true) btn.disabled = true;

    btn.appendChild(this.buildLinkedContextGlyph(opts?.icon || 'toggle'));
    return btn;
  }

  buildLinkedContextGlyph(icon) {
    const glyph = document.createElement('span');
    glyph.className = `tlr-context-glyph tlr-context-glyph-${icon}`;
    glyph.setAttribute('aria-hidden', 'true');

    const addChevron = (dir) => {
      let iconEl = null;
      try {
        iconEl = this.ui.createIcon(`ti-chevron-${dir}`);
      } catch (e) {
        iconEl = null;
      }

      if (!iconEl) {
        iconEl = document.createElement('span');
        iconEl.className = `ti ti-chevron-${dir}`;
      }

      glyph.appendChild(iconEl);
    };

    if (icon === 'toggle') {
      addChevron('up');
      addChevron('down');
      return glyph;
    }

    if (icon === 'up' || icon === 'down') {
      addChevron(icon);
      return glyph;
    }

    return glyph;
  }

  lineHasVisibleContent(line) {
    const segments = Array.isArray(line?.segments) ? line.segments : [];
    for (const seg of segments) {
      if ((this.getSegmentDisplayText(seg) || '').trim()) return true;
    }
    return (this.getLineContentText(line) || '').trim().length > 0;
  }

  appendLineText(container, line, query, opts) {
    if (!container) return;

    const prefix = opts?.skipPrefix === true ? '' : this.getLinePrefix(line);
    if (prefix) {
      const p = document.createElement('span');
      p.className = 'tlr-prefix';
      p.textContent = prefix;
      container.appendChild(p);
    }

    const content = document.createElement('span');
    content.className = 'tlr-line-content';
    const segments = Array.isArray(line?.segments) ? line.segments : [];
    if (segments.length > 0) {
      this.appendSegments(content, segments, query);
    } else {
      this.appendHighlightedText(content, this.getLineContentText(line), query);
    }
    container.appendChild(content);
  }

  appendLinkedContextRows(container, recordGuid, ctx, query, position) {
    if (!container || !ctx || ctx.loaded !== true) return;

    const items = [];
    if (position === 'top') {
      for (const line of this.getVisibleAboveContextItems(ctx)) {
        items.push({
          line,
          indent: Number(ctx.relativeDepthByGuid?.[line?.guid] || 0)
        });
      }
    } else {
      if (ctx.showMoreContext === true) {
        for (const line of ctx.descendants || []) {
          items.push({
            line,
            indent: Number(ctx.relativeDepthByGuid?.[line?.guid] || ctx.depthByGuid?.[line?.guid] || 1)
          });
        }
      }

      for (const line of this.getVisibleBelowContextItems(ctx)) {
        items.push({
          line,
          indent: Number(ctx.relativeDepthByGuid?.[line?.guid] || 0)
        });
      }
    }

    if (items.length === 0) return;

    const list = document.createElement('div');
    list.className = `tlr-context-list tlr-context-list-${position}`;

    for (const item of items) {
      const line = item.line || null;
      const guid = line?.guid || null;
      if (!guid) continue;
      if (!this.hasRenderableLineContent(line)) continue;

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-context-line button-none button-minimal-hover';
      row.dataset.action = 'open-line';
      row.dataset.recordGuid = recordGuid || '';
      row.dataset.lineGuid = guid;
      row.style.setProperty('--tlr-context-indent', `${Math.max(0, item.indent || 0) * 12}px`);

      this.appendLineText(row, line, query);
      list.appendChild(row);
    }

    if (list.childElementCount > 0) container.appendChild(list);
  }

  getLinePrefix(line) {
    const t = line?.type || '';
    if (t === 'task') {
      const done = line.isTaskCompleted?.();
      if (done === true) return '[x] ';
      if (done === false) return '[ ] ';
      return '- ';
    }
    if (t === 'ulist') return '- ';
    if (t === 'olist') return '1. ';
    if (t === 'heading') return '# ';
    if (t === 'quote') return '> ';
    return '';
  }

  getSegmentDisplayText(seg) {
    if (!seg) return '';

    if (seg.type === 'text' || seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code' || seg.type === 'link') {
      return typeof seg.text === 'string' ? seg.text : '';
    }

    if (seg.type === 'linkobj') {
      const link = seg.text?.link || '';
      return seg.text?.title || link || '';
    }

    if (seg.type === 'hashtag') {
      const text = typeof seg.text === 'string' ? seg.text : '';
      if (!text) return '';
      return text.startsWith('#') ? text : `#${text}`;
    }

    if (seg.type === 'datetime') {
      return this.formatDateTimeSegment(seg.text);
    }

    if (seg.type === 'mention') {
      return this.formatMention(typeof seg.text === 'string' ? seg.text : '');
    }

    if (seg.type === 'ref') {
      const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
      const guid = textObj.guid || null;
      return textObj.title || (guid ? this.resolveRecordName(guid) : '') || '';
    }

    return typeof seg.text === 'string' ? seg.text : '';
  }

  getSegmentHref(seg) {
    if (!seg) return '';
    if (seg.type === 'link') return typeof seg.text === 'string' ? seg.text : '';
    if (seg.type === 'linkobj') return seg.text?.link || '';
    return '';
  }

  appendSegmentTextElement(container, className, text, query) {
    if (!container) return;
    const el = document.createElement('span');
    el.className = className || '';
    el.textContent = '';
    this.appendHighlightedText(el, text, query);
    container.appendChild(el);
  }

  segmentsToPlainText(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return '';

    let out = '';
    for (const seg of segments) {
      out += this.getSegmentDisplayText(seg);
    }

    return out;
  }

  getLineContentText(line) {
    const segmentText = this.segmentsToPlainText(line?.segments || []);
    if (segmentText) return segmentText;
    return typeof line?.text === 'string' ? line.text : '';
  }

  hasRenderableLineContent(line) {
    return this.getLineContentText(line).trim().length > 0;
  }

  appendHighlightedText(container, text, query) {
    if (!container) return;
    const s = typeof text === 'string' ? text : '';
    if (!s) return;

    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) {
      container.appendChild(document.createTextNode(s));
      return;
    }

    const hayLower = s.toLowerCase();
    const needleLower = q.toLowerCase();
    if (!needleLower) {
      container.appendChild(document.createTextNode(s));
      return;
    }

    let idx = 0;
    while (idx < s.length) {
      const next = hayLower.indexOf(needleLower, idx);
      if (next === -1) break;

      if (next > idx) {
        container.appendChild(document.createTextNode(s.slice(idx, next)));
      }

      const mark = document.createElement('mark');
      mark.className = 'tlr-search-mark';
      mark.textContent = s.slice(next, next + needleLower.length);
      container.appendChild(mark);

      idx = next + needleLower.length;
    }

    if (idx < s.length) {
      container.appendChild(document.createTextNode(s.slice(idx)));
    }
  }

  appendSegments(container, segments, query) {
    if (!container) return;
    if (!Array.isArray(segments) || segments.length === 0) {
      container.textContent = '';
      return;
    }

    for (const seg of segments) {
      if (!seg) continue;
      const text = this.getSegmentDisplayText(seg);

      if (seg.type === 'text') {
        this.appendHighlightedText(container, text, query);
        continue;
      }

      if (seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code') {
        this.appendSegmentTextElement(
          container,
          seg.type === 'bold' ? 'tlr-seg-bold' : seg.type === 'italic' ? 'tlr-seg-italic' : 'tlr-seg-code',
          text,
          query
        );
        continue;
      }

      if (seg.type === 'link') {
        const url = this.getSegmentHref(seg);
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = '';
        this.appendHighlightedText(a, text, query);
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'linkobj') {
        const link = this.getSegmentHref(seg);
        if (!link) continue;
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = '';
        this.appendHighlightedText(a, text, query);
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'hashtag') {
        this.appendSegmentTextElement(container, 'tlr-seg-hashtag', text, query);
        continue;
      }

      if (seg.type === 'datetime') {
        this.appendSegmentTextElement(container, 'tlr-seg-datetime', text, query);
        continue;
      }

      if (seg.type === 'mention') {
        this.appendSegmentTextElement(container, 'tlr-seg-mention', text, query);
        continue;
      }

      if (seg.type === 'ref') {
        const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
        const guid = textObj.guid || null;
        if (!guid) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-ref';
        el.dataset.action = 'open-ref';
        el.dataset.refGuid = guid;
        el.textContent = '';
        this.appendHighlightedText(el, text || '[link]', query);
        container.appendChild(el);
        continue;
      }

      if (text) this.appendHighlightedText(container, text, query);
    }
  }

  resolveRecordName(guid) {
    const rec = this.data.getRecord?.(guid) || null;
    return rec?.getName?.() || null;
  }

  formatMention(userGuid) {
    if (!userGuid) return '@user';
    const users = this.data.getActiveUsers?.() || [];
    const u = users.find((x) => x?.guid === userGuid) || null;
    const name = (u?.getDisplayName?.() || '').trim();
    return name ? `@${name}` : '@user';
  }

  padDateTimeNumber(value, width = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return String(Math.trunc(n)).padStart(width, '0');
  }

  formatDateTimeDate(value) {
    if (typeof value === 'string') {
      const compact = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
      const dashed = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
      return '';
    }

    if (value && typeof value === 'object') {
      const year = Number(value.year);
      const month = Number(value.month);
      const day = Number(value.day);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        const normalizedMonth = month >= 1 ? month : (month + 1);
        return `${this.padDateTimeNumber(year, 4)}-${this.padDateTimeNumber(normalizedMonth, 2)}-${this.padDateTimeNumber(day, 2)}`;
      }
    }

    return '';
  }

  formatDateTimeTime(value, fallbackParts = null) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${this.padDateTimeNumber(value, 2)}:00`;
    }

    if (value && typeof value === 'object') {
      const nested = value.value && typeof value.value === 'object'
        ? value.value
        : value.t && typeof value.t === 'string'
          ? value.t
          : value.time && (typeof value.time === 'string' || typeof value.time === 'number' || typeof value.time === 'object')
            ? value.time
            : null;
      if (nested && nested !== value) {
        const nestedText = this.formatDateTimeTime(nested, value);
        if (nestedText) return nestedText;
      }
    }

    if (typeof value === 'string') {
      const raw = value.trim();
      if (!raw) return '';

      const colon = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (colon) {
        const hours = this.padDateTimeNumber(colon[1], 2);
        const minutes = this.padDateTimeNumber(colon[2], 2);
        const seconds = colon[3] ? this.padDateTimeNumber(colon[3], 2) : '';
        return seconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;
      }

      const digits = raw.replace(/\D+/g, '');
      if (digits.length === 1 || digits.length === 2) {
        return `${digits.padStart(2, '0')}:00`;
      }
      if (digits.length === 3) {
        return `${digits.slice(0, 1).padStart(2, '0')}:${digits.slice(1, 3)}`;
      }
      if (digits.length === 4) {
        return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
      }
      if (digits.length === 6) {
        return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
      }
    }

    if (fallbackParts && typeof fallbackParts === 'object') {
      const hours = Number(fallbackParts.hours ?? fallbackParts.hour ?? fallbackParts.h);
      const minutes = Number(fallbackParts.minutes ?? fallbackParts.minute ?? fallbackParts.m ?? 0);
      const seconds = Number(fallbackParts.seconds ?? fallbackParts.second ?? fallbackParts.s ?? 0);
      if (Number.isFinite(hours)) {
        const hh = this.padDateTimeNumber(hours, 2);
        const mm = this.padDateTimeNumber(minutes, 2);
        const ss = Number.isFinite(seconds) && seconds > 0
          ? this.padDateTimeNumber(seconds, 2)
          : '';
        return ss ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
      }
    }

    return '';
  }

  extractDateTimeDisplayParts(value) {
    if (!value || typeof value !== 'object') return null;

    const source = value.value && typeof value.value === 'object'
      ? value.value
      : value;

    const date = this.formatDateTimeDate(
      typeof source.d === 'string' ? source.d
        : typeof source.date === 'string' ? source.date
          : source
    );
    const time = this.formatDateTimeTime(
      source.t != null ? source.t
        : source.time != null ? source.time
          : null,
      source
    );

    if (!date && !time) return null;
    return { date, time };
  }

  formatDateTimeDisplayParts(parts) {
    if (!parts) return '';
    const date = typeof parts.date === 'string' ? parts.date : '';
    const time = typeof parts.time === 'string' ? parts.time : '';
    if (date && time) return `${date} ${time}`;
    return date || time || '';
  }

  formatDateTimeSegment(v) {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return '';

    const raw = typeof v.raw === 'string' ? v.raw.trim() : '';
    if (raw) return raw;

    const startSource = v.start && typeof v.start === 'object'
      ? v.start
      : v.from && typeof v.from === 'object'
        ? v.from
        : v;
    const endSource = v.end && typeof v.end === 'object'
      ? v.end
      : v.to && typeof v.to === 'object'
        ? v.to
        : (v.ed || v.et || v.endDate || v.endTime)
          ? {
              d: v.ed || v.endDate || null,
              t: v.et || v.endTime || null
            }
          : null;

    const start = this.extractDateTimeDisplayParts(startSource);
    const end = this.extractDateTimeDisplayParts(endSource);

    const startText = this.formatDateTimeDisplayParts(start);
    let endText = this.formatDateTimeDisplayParts(end);
    if (start?.date && !end?.date && end?.time) {
      endText = end.time;
    }

    if (startText && endText) return `${startText} to ${endText}`;
    return startText || endText || '';
  }

  coercePositiveInt(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i <= 0) return fallback;
    return i;
  }

  coerceNonNegativeInt(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i < 0) return fallback;
    return i;
  }

  // ---------- Time Machine ----------

  defaultTimeMachineSettings() {
    return {
      enabled: true,
      filters: [{ id: 'tm_default', field: 'When', op: 'same_day_last_year', value: '' }],
      excludeJournalYearForMonthDay: true,
      groupWithinYear: 'collection',
      excludedCollections: []
    };
  }

  normalizeTimeMachineSettings(raw) {
    const base = this.defaultTimeMachineSettings();
    if (!raw || typeof raw !== 'object') return base;
    const enabled = raw.enabled !== false;
    const filters = Array.isArray(raw.filters) && raw.filters.length
      ? raw.filters.map((f, i) => ({
          id: String(f?.id || `tm_${i}`),
          field: String(f?.field || 'When').trim(),
          op: String(f?.op || 'same_day_last_year').trim(),
          value: f?.value != null ? String(f.value) : ''
        }))
      : base.filters;
    const excludeJournalYearForMonthDay = raw.excludeJournalYearForMonthDay !== false;
    const g = String(raw.groupWithinYear || '').trim().toLowerCase();
    const groupWithinYear = g === 'chrono' ? 'chrono' : 'collection';
    const excludedCollections = Array.isArray(raw.excludedCollections)
      ? raw.excludedCollections.map((n) => String(n || '').trim()).filter(Boolean)
      : base.excludedCollections;
    return { enabled, filters, excludeJournalYearForMonthDay, groupWithinYear, excludedCollections };
  }

  loadTimeMachineSettings() {
    const key = this._storageKeyTimeMachine;
    try {
      const raw = localStorage.getItem(key);
      if (raw) return this.normalizeTimeMachineSettings(JSON.parse(raw));
    } catch (e) { /* ignore */ }

    // Migrate from Today's Notes / Journal Footer Suite so filters survive the suite retirement.
    try {
      const tn = JSON.parse(localStorage.getItem('tn_settings_v1') || 'null');
      if (tn && typeof tn === 'object') {
        const migrated = this.normalizeTimeMachineSettings({
          ...(tn.timeMachine || {}),
          excludedCollections: tn.excludedCollections || []
        });
        this.saveTimeMachineSettings(migrated);
        return migrated;
      }
    } catch (e) { /* ignore */ }

    return this.defaultTimeMachineSettings();
  }

  saveTimeMachineSettings(settings) {
    const normalized = this.normalizeTimeMachineSettings(settings);
    this._timeMachineSettings = normalized;
    try {
      localStorage.setItem(this._storageKeyTimeMachine, JSON.stringify(normalized));
    } catch (e) { /* ignore */ }
    this._backrefsScheduleSettingsFlush?.();
    return normalized;
  }

  timeMachineEnabled() {
    const tm = this.normalizeTimeMachineSettings(this._timeMachineSettings);
    return !!tm.enabled && Array.isArray(tm.filters) && tm.filters.length > 0;
  }

  getJournalYyyymmdd(record) {
    const iso = this.getRecordDateReferenceIso(record);
    if (!iso || iso.length < 10) return '';
    return iso.slice(0, 4) + iso.slice(5, 7) + iso.slice(8, 10);
  }

  journalDateParts(yyyymmdd) {
    const y = parseInt(String(yyyymmdd || '').slice(0, 4), 10);
    const m = parseInt(String(yyyymmdd || '').slice(4, 6), 10);
    const d = parseInt(String(yyyymmdd || '').slice(6, 8), 10);
    return { year: y, month: m, day: d, yyyymmdd: String(yyyymmdd || '') };
  }

  dayRangeFromKey(yyyymmdd) {
    const p = this.journalDateParts(yyyymmdd);
    const start = new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
    const end = new Date(p.year, p.month - 1, p.day, 23, 59, 59, 999);
    return { start, end };
  }

  dayRangeSameDayLastYear(yyyymmdd) {
    const p = this.journalDateParts(yyyymmdd);
    const start = new Date(p.year, p.month - 1, p.day, 0, 0, 0, 0);
    start.setFullYear(start.getFullYear() - 1);
    const end = new Date(p.year, p.month - 1, p.day, 23, 59, 59, 999);
    end.setFullYear(end.getFullYear() - 1);
    return { start, end };
  }

  coerceDateForTm(raw) {
    if (!raw) return null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
    if (typeof raw?.toDate === 'function') {
      const d = raw.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw?.value === 'function') {
      const d = new Date(raw.value());
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'number') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'string' && raw.length >= 8) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  }

  readDateFieldNamed(record, fieldName) {
    const key = String(fieldName || '').trim();
    if (!key || !record) return null;
    try {
      const prop = record.prop?.(key);
      if (!prop) return null;
      if (typeof prop.date === 'function') {
        const d = prop.date();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
      }
      return this.coerceDateForTm(prop.get?.());
    } catch (e) {
      return null;
    }
  }

  readFieldValueSimple(record, fieldName) {
    const key = String(fieldName || '').trim();
    if (!key || !record) return '';
    try {
      const prop = record.prop?.(key);
      if (!prop) return '';
      const raw = prop.get?.();
      if (raw == null) return '';
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      if (raw instanceof Date) {
        return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`;
      }
      if (typeof raw?.label === 'string') return raw.label;
      if (typeof raw?.name === 'string') return raw.name;
      return String(raw);
    } catch (e) {
      return '';
    }
  }

  evaluateTmFilterRule(record, rule, journalParts, dayRange, lastYearRange) {
    const field = String(rule?.field || '').trim();
    const op = String(rule?.op || '').trim();
    const cmpRaw = String(rule?.value || '');
    if (!field) return true;

    const isDateOp = ['on_journal_day', 'not_on_journal_day', 'same_month_day_as_journal', 'same_day_last_year'].includes(op);
    const raw = isDateOp ? this.readDateFieldNamed(record, field) : this.readFieldValueSimple(record, field);
    const value = (v) => {
      if (v == null) return '';
      if (v instanceof Date) {
        return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
      }
      return String(v).toLowerCase();
    };
    const cmp = String(cmpRaw || '').toLowerCase();

    if (op === 'is_empty') {
      if (isDateOp) return !this.coerceDateForTm(raw);
      const vs = this.readFieldValueSimple(record, field);
      return !vs || !String(vs).trim();
    }
    if (op === 'is_not_empty') {
      if (isDateOp) return !!this.coerceDateForTm(raw);
      const vs = this.readFieldValueSimple(record, field);
      return !!vs && !!String(vs).trim();
    }
    if (op === 'same_month_day_as_journal') {
      const d = this.coerceDateForTm(raw);
      if (!d) return false;
      if (d.getMonth() + 1 !== journalParts.month || d.getDate() !== journalParts.day) return false;
      const tmCfg = this.normalizeTimeMachineSettings(this._timeMachineSettings);
      if (tmCfg.excludeJournalYearForMonthDay !== false && d.getFullYear() === journalParts.year) return false;
      return true;
    }
    if (op === 'on_journal_day') {
      const d = this.coerceDateForTm(raw);
      if (!d) return false;
      return d >= dayRange.start && d <= dayRange.end;
    }
    if (op === 'not_on_journal_day') {
      const d = this.coerceDateForTm(raw);
      if (!d) return true;
      return !(d >= dayRange.start && d <= dayRange.end);
    }
    if (op === 'same_day_last_year') {
      const d = this.coerceDateForTm(raw);
      if (!d) return false;
      return d >= lastYearRange.start && d <= lastYearRange.end;
    }

    const v = value(raw);
    if (op === 'eq') return v === cmp;
    if (op === 'neq') return v !== cmp;
    if (op === 'contains') return v.includes(cmp);
    if (op === 'not_contains') return !v.includes(cmp);
    if (op === 'starts_with') return v.startsWith(cmp);
    if (op === 'ends_with') return v.endsWith(cmp);
    return true;
  }

  recordPassesTmFilters(record, journalYyyymmdd) {
    const tm = this.normalizeTimeMachineSettings(this._timeMachineSettings);
    const journalParts = this.journalDateParts(journalYyyymmdd);
    const dayRange = this.dayRangeFromKey(journalYyyymmdd);
    const lastYearRange = this.dayRangeSameDayLastYear(journalYyyymmdd);
    for (const rule of tm.filters || []) {
      if (!this.evaluateTmFilterRule(record, rule, journalParts, dayRange, lastYearRange)) return false;
    }
    return true;
  }

  collectionIconName(coll) {
    if (!coll) return '';
    const candidates = [];
    const push = (v) => {
      if (v == null || typeof v === 'object') return;
      const t = String(v).trim();
      if (t) candidates.push(t);
    };
    try {
      const cfg = coll.getConfiguration?.() || {};
      push(cfg.icon); push(cfg.collection_icon); push(cfg.iconName); push(cfg.emoji);
    } catch (e) { /* ignore */ }
    try {
      const data = coll?.getData?.() || {};
      push(data.icon); push(data.emoji);
    } catch (e) { /* ignore */ }
    push(coll?.icon);
    try { push(coll.getIcon?.()); } catch (e) { /* ignore */ }
    for (const raw of candidates) {
      if (/^ti-photo$/i.test(raw)) continue;
      if (raw.startsWith('ti-')) return raw;
      if (/^[a-z0-9_-]+$/i.test(raw)) return `ti-${raw.replace(/^ti-?/, '').replace(/_/g, '-')}`;
    }
    return '';
  }

  async queryTimeMachineRecords(journalYyyymmdd) {
    const tm = this.normalizeTimeMachineSettings(this._timeMachineSettings);
    const excludedSet = this.getExcludedSourceCollectionSet();
    const journalNames = new Set(['journal', 'journals']);
    let collections = [];
    try { collections = await this.data.getAllCollections(); } catch (e) { collections = []; }
    const out = [];
    const tm0 = tm.filters[0];
    for (const coll of collections) {
      const name = coll.getName?.() || '';
      if (!name || journalNames.has(name.toLowerCase())) continue;
      if (excludedSet.has(name.toLowerCase())) continue;
      let records;
      try { records = await coll.getAllRecords(); } catch (e) { continue; }
      const icon = this.collectionIconName(coll);
      for (const record of records || []) {
        if (!this.recordPassesTmFilters(record, journalYyyymmdd)) continue;
        let dateVal = null;
        if (tm0?.field) dateVal = this.readDateFieldNamed(record, tm0.field);
        if (!dateVal) {
          for (const field of ['When', 'when', 'Date', 'date']) {
            dateVal = this.readDateFieldNamed(record, field);
            if (dateVal) break;
          }
        }
        const d = this.coerceDateForTm(dateVal);
        out.push({ record, collectionName: name, dateVal: d || dateVal || null, collectionIcon: icon });
      }
    }
    out.sort((a, b) => {
      const c = a.collectionName.localeCompare(b.collectionName);
      if (c !== 0) return c;
      const ta = a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime()) ? a.dateVal.getTime() : 0;
      const tb = b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime()) ? b.dateVal.getTime() : 0;
      return ta - tb;
    });
    return out;
  }

  tmItemYear(item) {
    const d = item?.dateVal instanceof Date && !Number.isNaN(item.dateVal.getTime())
      ? item.dateVal
      : this.coerceDateForTm(item?.dateVal);
    if (!d || Number.isNaN(d.getTime())) return null;
    return d.getFullYear();
  }

  groupTmResultsByYearDescending(items) {
    const yearMap = new Map();
    const unknown = [];
    for (const it of items || []) {
      const y = this.tmItemYear(it);
      if (y == null || Number.isNaN(y)) { unknown.push(it); continue; }
      if (!yearMap.has(y)) yearMap.set(y, []);
      yearMap.get(y).push(it);
    }
    const years = Array.from(yearMap.keys()).sort((a, b) => b - a);
    return { yearMap, years, unknown };
  }

  sortTmItemsByTimeAscending(items) {
    return [...(items || [])].sort((a, b) => {
      const ta = a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime()) ? a.dateVal.getTime() : 0;
      const tb = b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime()) ? b.dateVal.getTime() : 0;
      return ta - tb;
    });
  }

  groupTmResultsByCollection(items) {
    const byColl = new Map();
    for (const item of items || []) {
      const name = item?.collectionName || 'Other';
      if (!byColl.has(name)) byColl.set(name, []);
      byColl.get(name).push(item);
    }
    return byColl;
  }

  resetTimeMachineState(state) {
    if (!state) return;
    state.timeMachineCollapsed = true;
    state.timeMachineLoading = false;
    state.timeMachineResults = null;
    state.timeMachineJournalKey = '';
  }

  syncTimeMachineControl(state) {
    const btn = state?.timeMachineToggleEl || state?.rootEl?.querySelector?.('[data-action="toggle-time-machine"]') || null;
    if (!btn) return;
    let record = null;
    try { record = state?.recordGuid ? this.data.getRecord?.(state.recordGuid) : null; } catch (e) { record = null; }
    const journalKey = this.getJournalYyyymmdd(record);
    const enabled = this.timeMachineEnabled() && !!journalKey;
    const open = enabled && state.timeMachineCollapsed !== true;
    btn.classList.toggle('is-active', open);
    btn.classList.toggle('is-disabled', !enabled);
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    btn.disabled = !enabled;
    btn.title = !this.timeMachineEnabled()
      ? 'Time Machine (disabled in settings)'
      : (!journalKey
        ? 'Time Machine (journal pages only)'
        : (open ? 'Hide Time Machine' : 'Show Time Machine'));
    btn.setAttribute('data-tooltip', btn.title);
  }

  async toggleTimeMachine(state) {
    if (!state || !this.timeMachineEnabled()) return;
    let record = null;
    try { record = state.recordGuid ? this.data.getRecord?.(state.recordGuid) : null; } catch (e) { record = null; }
    const journalKey = this.getJournalYyyymmdd(record);
    if (!journalKey) return;

    const nextCollapsed = state.timeMachineCollapsed !== true;
    state.timeMachineCollapsed = nextCollapsed;
    this.syncTimeMachineControl(state);
    if (!nextCollapsed) {
      await this.runTimeMachineGenerate(state);
    } else {
      this.renderTimeMachineSection(state);
    }
  }

  async runTimeMachineGenerate(state) {
    if (!state || !this.timeMachineEnabled()) return;
    let record = null;
    try { record = state.recordGuid ? this.data.getRecord?.(state.recordGuid) : null; } catch (e) { record = null; }
    const journalKey = this.getJournalYyyymmdd(record);
    if (!journalKey) {
      state.timeMachineResults = [];
      this.renderTimeMachineSection(state);
      return;
    }

    if (state.timeMachineLoading) return;
    if (state.timeMachineResults != null && state.timeMachineJournalKey === journalKey) {
      this.renderTimeMachineSection(state);
      this.syncTimeMachineControl(state);
      return;
    }
    state.timeMachineLoading = true;
    state.timeMachineJournalKey = journalKey;
    this.renderTimeMachineSection(state);
    this.syncTimeMachineControl(state);
    try {
      state.timeMachineResults = await this.queryTimeMachineRecords(journalKey);
    } catch (e) {
      console.error('[Backreferences] Time Machine', e);
      state.timeMachineResults = [];
    }
    state.timeMachineLoading = false;
    this.renderTimeMachineSection(state);
    this.syncTimeMachineControl(state);
  }

  buildTimeMachineRow(item, state) {
    const record = item?.record || null;
    const guid = record?.guid || '';
    if (!guid) return document.createElement('div');

    const groupEl = document.createElement('div');
    groupEl.className = 'tlr-group tlr-group-tm';
    if (state?.recordExpandedState?.get?.(guid)?.expanded === true) {
      groupEl.classList.add('tlr-record-expanded');
    }

    const rowEl = document.createElement('div');
    rowEl.className = 'tlr-group-row tlr-prop-record-row';
    rowEl.appendChild(this.buildExpandRecordBtn(guid, state));

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'tlr-group-header tlr-prop-record button-none button-minimal-hover';
    titleBtn.dataset.action = 'open-record';
    titleBtn.dataset.recordGuid = guid;

    const titleInner = document.createElement('div');
    titleInner.className = 'tlr-group-title';
    const iconSlot = document.createElement('span');
    iconSlot.className = 'tlr-record-icon-slot';
    if (item.collectionIcon) {
      try {
        const iconEl = this.ui.createIcon(item.collectionIcon);
        iconEl.classList.add('tlr-record-icon');
        iconSlot.appendChild(iconEl);
      } catch (e) { /* ignore */ }
    } else {
      this.appendRecordIcon(iconSlot, record);
    }
    titleInner.appendChild(iconSlot);
    const nameSpan = document.createElement('span');
    nameSpan.className = 'tlr-group-title-text';
    nameSpan.textContent = record.getName?.() || 'Untitled';
    titleInner.appendChild(nameSpan);
    titleBtn.appendChild(titleInner);

    if (item.collectionName) {
      const metaEl = document.createElement('div');
      metaEl.className = 'tlr-row-meta';
      this.appendTitleMeta(metaEl, item.collectionName);
      titleBtn.appendChild(metaEl);
    }

    rowEl.appendChild(titleBtn);
    groupEl.appendChild(rowEl);
    groupEl.appendChild(this.buildRecordPreviewEl(guid, state));
    return groupEl;
  }

  renderTimeMachineSection(state) {
    const slot = state?.timeMachineSlotEl;
    if (!slot) return;
    slot.innerHTML = '';

    let record = null;
    try { record = state.recordGuid ? this.data.getRecord?.(state.recordGuid) : null; } catch (e) { record = null; }
    const journalKey = this.getJournalYyyymmdd(record);
    if (!this.timeMachineEnabled() || !journalKey || state.timeMachineCollapsed === true) {
      slot.hidden = true;
      return;
    }
    slot.hidden = false;

    const wrap = document.createElement('div');
    wrap.className = 'tlr-tm-section';

    const head = document.createElement('div');
    head.className = 'tlr-tm-head';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'tlr-tm-icon';
    try { iconWrap.appendChild(this.ui.createIcon('ti-hourglass')); }
    catch (e) { iconWrap.textContent = '⏳'; }
    const title = document.createElement('div');
    title.className = 'tlr-tm-title';
    title.textContent = 'Time Machine';
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'tlr-btn tlr-tm-collapse button-none button-small button-minimal-hover';
    collapseBtn.dataset.action = 'toggle-time-machine';
    collapseBtn.title = 'Collapse Time Machine';
    collapseBtn.setAttribute('aria-label', 'Collapse Time Machine');
    try { collapseBtn.appendChild(this.ui.createIcon('ti-chevron-up')); }
    catch (e) { collapseBtn.textContent = '−'; }
    head.append(iconWrap, title, collapseBtn);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'tlr-tm-body';
    wrap.appendChild(body);

    if (state.timeMachineLoading) {
      const loading = document.createElement('div');
      loading.className = 'tlr-note';
      loading.textContent = 'Loading Time Machine…';
      body.appendChild(loading);
      slot.appendChild(wrap);
      return;
    }

    if (state.timeMachineResults == null) {
      slot.appendChild(wrap);
      return;
    }

    if (!state.timeMachineResults.length) {
      const empty = document.createElement('div');
      empty.className = 'tlr-empty';
      empty.textContent = 'No records matched your Time Machine filters.';
      body.appendChild(empty);
      slot.appendChild(wrap);
      return;
    }

    const tmCfg = this.normalizeTimeMachineSettings(this._timeMachineSettings);
    const { yearMap, years, unknown } = this.groupTmResultsByYearDescending(state.timeMachineResults);

    const renderYearBucket = (yearLabel, items) => {
      const yearHead = document.createElement('div');
      yearHead.className = 'tlr-tm-year-head';
      yearHead.textContent = yearLabel;
      body.appendChild(yearHead);

      if (tmCfg.groupWithinYear === 'chrono') {
        for (const item of this.sortTmItemsByTimeAscending(items)) {
          body.appendChild(this.buildTimeMachineRow(item, state));
        }
        return;
      }
      const byColl = this.groupTmResultsByCollection(items);
      const collNames = Array.from(byColl.keys()).sort((a, b) => String(a).localeCompare(String(b)));
      for (const collName of collNames) {
        const subLabel = document.createElement('div');
        subLabel.className = 'tlr-tm-subcoll';
        subLabel.textContent = collName;
        body.appendChild(subLabel);
        for (const item of this.sortTmItemsByTimeAscending(byColl.get(collName) || [])) {
          body.appendChild(this.buildTimeMachineRow(item, state));
        }
      }
    };

    for (const y of years) renderYearBucket(String(y), yearMap.get(y) || []);
    if (unknown.length) renderYearBucket('Other', unknown);
    slot.appendChild(wrap);
  }

  getTimeMachineOpChoices() {
    return [
      ['same_day_last_year', 'Same calendar day, last year'],
      ['on_journal_day', 'On journal day'],
      ['same_month_day_as_journal', 'Same month/day as journal (any year)'],
      ['not_on_journal_day', 'Not on journal day'],
      ['eq', 'Text equals'],
      ['neq', 'Text not equals'],
      ['contains', 'Text contains'],
      ['not_contains', 'Text does not contain'],
      ['starts_with', 'Text starts with'],
      ['ends_with', 'Text ends with'],
      ['is_empty', 'Field empty'],
      ['is_not_empty', 'Field not empty']
    ];
  }

  /** Small popup anchored under the header settings cog. */
  openBackreferencesSettingsMenu(anchorEl) {
    const existing = document.getElementById('tlr-settings-menu');
    if (existing) {
      existing.remove();
      if (existing.dataset.anchorOpen === '1') return;
    }

    const menu = document.createElement('div');
    menu.id = 'tlr-settings-menu';
    menu.className = 'tlr-menu';
    menu.dataset.anchorOpen = '1';

    const close = () => {
      try { menu.remove(); } catch (e) { /* ignore */ }
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const onDocDown = (e) => {
      if (menu.contains(e.target)) return;
      if (anchorEl?.contains?.(e.target)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };

    const addItem = (label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tlr-menu-item button-none';
      btn.textContent = label;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        close();
        onClick();
      });
      menu.appendChild(btn);
      return btn;
    };
    const addSep = () => {
      const sep = document.createElement('div');
      sep.className = 'tlr-menu-sep';
      menu.appendChild(sep);
    };

    addItem('Excluded collections…', () => { void this.openExcludedSourcesSettings(); });
    addItem('Time Machine settings…', () => this.openTimeMachineSettings());
    addSep();
    addItem('Storage location…', () => {
      void this._backrefsEnsurePathBReady().then(() => {
        globalThis.ThymerPluginSettings?.openStorageDialog?.({
          plugin: this,
          pluginId: BACKREFS_PLUGIN_ID,
          modeKey: BACKREFS_MODE_KEY,
          mirrorKeys: () => this._backrefsMirrorKeys(),
          label: BACKREFS_PLUGIN_LABEL,
          data: this.data,
          ui: this.ui,
        });
      });
    });

    document.body.appendChild(menu);
    try {
      const r = anchorEl.getBoundingClientRect();
      const w = menu.offsetWidth || 220;
      const left = Math.max(8, Math.min(window.innerWidth - w - 8, Math.round(r.right - w)));
      const top = Math.round(r.bottom + 6);
      menu.style.left = left + 'px';
      menu.style.top = top + 'px';
    } catch (e) { /* ignore */ }

    setTimeout(() => {
      document.addEventListener('mousedown', onDocDown, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  async openExcludedSourcesSettings() {
    const existing = document.querySelector('.tlr-tm-settings-overlay');
    if (existing) existing.remove();

    const draft = this.normalizeExcludedSourcesConfig(this._excludedSources);
    const selected = new Set((draft.collections || []).map((n) => n.toLowerCase()));

    const overlay = document.createElement('div');
    overlay.className = 'tlr-tm-settings-overlay';
    const panel = document.createElement('div');
    panel.className = 'tlr-tm-settings-panel';

    const h = document.createElement('h3');
    h.textContent = 'Excluded collections';
    panel.appendChild(h);

    const help = document.createElement('p');
    help.className = 'tlr-tm-settings-help';
    help.textContent = 'Checked collections are hidden from Backreferences and Time Machine (shared list). Useful for date-stamped trackers that clutter journal days.';
    panel.appendChild(help);

    const hideRow = document.createElement('label');
    hideRow.className = 'tlr-tm-settings-row';
    const hideCb = document.createElement('input');
    hideCb.type = 'checkbox';
    hideCb.checked = draft.hideBuiltInBacklinks !== false;
    hideCb.addEventListener('change', () => { draft.hideBuiltInBacklinks = hideCb.checked; });
    hideRow.append(hideCb, document.createTextNode(' Hide built-in Backlinks footer'));
    panel.appendChild(hideRow);

    const listWrap = document.createElement('div');
    listWrap.className = 'tlr-excl-list';
    const loading = document.createElement('p');
    loading.className = 'tlr-tm-settings-help';
    loading.textContent = 'Loading collections…';
    listWrap.appendChild(loading);
    panel.appendChild(listWrap);

    const actions = document.createElement('div');
    actions.className = 'tlr-tm-settings-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tlr-tm-settings-primary';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      const names = [];
      for (const row of listWrap.querySelectorAll('label.tlr-excl-item')) {
        const cb = row.querySelector('input[type="checkbox"]');
        const name = row.dataset.name || '';
        if (cb?.checked && name) names.push(name);
      }
      draft.collections = names;
      draft.hideBuiltInBacklinks = hideCb.checked;
      this.saveExcludedSourcesConfig(draft);
      this.reconcileAllPanelsVisibility({ refreshVisible: true, reason: 'excluded-sources-changed' });
      for (const st of this._panelStates?.values?.() || []) {
        this.resetTimeMachineState(st);
        this.syncTimeMachineControl(st);
        this.renderTimeMachineSection(st);
      }
      this.showToast('Exclusions saved');
      overlay.remove();
    });
    actions.append(cancel, save);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);

    let collections = [];
    try {
      collections = await this.data.getAllCollections();
    } catch (e) {
      collections = [];
    }
    const names = [];
    const seen = new Set();
    for (const coll of collections || []) {
      const name = (coll?.getName?.() || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      if (key === 'journal' || key === 'journals') continue;
      seen.add(key);
      names.push(name);
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    // Keep previously excluded names even if the collection was renamed/removed.
    for (const kept of draft.collections || []) {
      if (!seen.has(kept.toLowerCase())) names.push(kept);
    }

    listWrap.replaceChildren();
    if (!names.length) {
      const empty = document.createElement('p');
      empty.className = 'tlr-tm-settings-help';
      empty.textContent = 'No collections found.';
      listWrap.appendChild(empty);
      return;
    }

    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'tlr-tm-settings-input';
    filter.placeholder = 'Filter collections…';
    listWrap.appendChild(filter);

    const itemsHost = document.createElement('div');
    itemsHost.className = 'tlr-excl-items';
    listWrap.appendChild(itemsHost);

    const renderItems = () => {
      const q = filter.value.trim().toLowerCase();
      itemsHost.replaceChildren();
      for (const name of names) {
        if (q && !name.toLowerCase().includes(q)) continue;
        const row = document.createElement('label');
        row.className = 'tlr-excl-item tlr-tm-settings-row';
        row.dataset.name = name;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selected.has(name.toLowerCase());
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(name.toLowerCase());
          else selected.delete(name.toLowerCase());
        });
        row.append(cb, document.createTextNode(' ' + name));
        itemsHost.appendChild(row);
      }
    };
    filter.addEventListener('input', renderItems);
    renderItems();
  }

  openTimeMachineSettings() {
    const existing = document.querySelector('.tlr-tm-settings-overlay');
    if (existing) existing.remove();

    const draft = this.normalizeTimeMachineSettings(this._timeMachineSettings);
    const overlay = document.createElement('div');
    overlay.className = 'tlr-tm-settings-overlay';
    const panel = document.createElement('div');
    panel.className = 'tlr-tm-settings-panel';

    const h = document.createElement('h3');
    h.textContent = 'Time Machine';
    panel.appendChild(h);
    const help = document.createElement('p');
    help.className = 'tlr-tm-settings-help';
    help.textContent = 'Optional journal-page section. Filters use the journal date as context. Settings migrate from Today\'s Notes if present.';
    panel.appendChild(help);

    const en = document.createElement('label');
    en.className = 'tlr-tm-settings-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = draft.enabled !== false;
    cb.addEventListener('change', () => { draft.enabled = cb.checked; });
    en.append(cb, document.createTextNode(' Show Time Machine'));
    panel.appendChild(en);

    const exclBtn = document.createElement('button');
    exclBtn.type = 'button';
    exclBtn.className = 'tlr-tm-settings-secondary';
    exclBtn.textContent = 'Excluded collections…';
    exclBtn.addEventListener('click', () => {
      overlay.remove();
      void this.openExcludedSourcesSettings();
    });
    panel.appendChild(exclBtn);

    const filtersWrap = document.createElement('div');
    filtersWrap.className = 'tlr-tm-filters';
    const opChoices = this.getTimeMachineOpChoices();
    const renderFilters = () => {
      filtersWrap.innerHTML = '';
      draft.filters.forEach((rule, ridx) => {
        const row = document.createElement('div');
        row.className = 'tlr-tm-filter-row';
        const fin = document.createElement('input');
        fin.type = 'text';
        fin.placeholder = 'Field (e.g. When)';
        fin.value = rule.field || '';
        fin.addEventListener('input', () => { draft.filters[ridx].field = fin.value.trim(); });
        const opSel = document.createElement('select');
        for (const [val, lab] of opChoices) {
          const o = document.createElement('option');
          o.value = val; o.textContent = lab;
          opSel.appendChild(o);
        }
        opSel.value = opChoices.some(([v]) => v === rule.op) ? rule.op : 'same_day_last_year';
        opSel.addEventListener('change', () => { draft.filters[ridx].op = opSel.value; });
        const vin = document.createElement('input');
        vin.type = 'text';
        vin.placeholder = 'Compare value';
        vin.value = rule.value || '';
        vin.addEventListener('input', () => { draft.filters[ridx].value = vin.value; });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '✕';
        rm.addEventListener('click', () => { draft.filters.splice(ridx, 1); renderFilters(); });
        row.append(fin, opSel, vin, rm);
        filtersWrap.appendChild(row);
      });
    };
    renderFilters();
    panel.appendChild(filtersWrap);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'tlr-tm-settings-secondary';
    addBtn.textContent = '+ Add filter rule';
    addBtn.addEventListener('click', () => {
      draft.filters.push({ id: `tm_${Date.now()}`, field: 'When', op: 'same_day_last_year', value: '' });
      renderFilters();
    });
    panel.appendChild(addBtn);

    const exclLb = document.createElement('label');
    exclLb.className = 'tlr-tm-settings-row';
    const exclCb = document.createElement('input');
    exclCb.type = 'checkbox';
    exclCb.checked = draft.excludeJournalYearForMonthDay !== false;
    exclCb.addEventListener('change', () => { draft.excludeJournalYearForMonthDay = exclCb.checked; });
    exclLb.append(exclCb, document.createTextNode(' Exclude journal year from “same month/day” results'));
    panel.appendChild(exclLb);

    const groupSel = document.createElement('select');
    groupSel.className = 'tlr-tm-settings-input';
    [['collection', 'Group within year by collection'], ['chrono', 'Group within year by time']].forEach(([val, lab]) => {
      const o = document.createElement('option');
      o.value = val; o.textContent = lab;
      groupSel.appendChild(o);
    });
    groupSel.value = draft.groupWithinYear === 'chrono' ? 'chrono' : 'collection';
    groupSel.addEventListener('change', () => {
      draft.groupWithinYear = groupSel.value === 'chrono' ? 'chrono' : 'collection';
    });
    panel.appendChild(groupSel);

    const actions = document.createElement('div');
    actions.className = 'tlr-tm-settings-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'tlr-tm-settings-primary';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      this.saveTimeMachineSettings(draft);
      for (const st of this._panelStates?.values?.() || []) {
        this.resetTimeMachineState(st);
        this.syncTimeMachineControl(st);
        this.renderTimeMachineSection(st);
      }
      overlay.remove();
    });
    actions.append(cancel, save);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    document.body.appendChild(overlay);
  }

  // ---------- CSS ----------

  injectCss() {
    this.ui.injectCSS(`
      /* Hide Thymer's native backlinks footer when the plugin replaces it. */
      html.tlr-hide-native-backrefs .backrefs-footer {
        display: none !important;
      }

      .tlr-excl-list {
        max-height: 320px;
        overflow: auto;
        margin: 8px 0 4px;
        padding: 4px 0;
      }
      .tlr-excl-items {
        display: flex;
        flex-direction: column;
        gap: 2px;
        margin-top: 8px;
      }
      .tlr-excl-item {
        margin: 0;
        padding: 4px 2px;
        border-radius: 4px;
      }
      .tlr-excl-item:hover {
        background: var(--button-normal-hover-color, var(--bg-hover, transparent));
      }

      .tlr-footer {
        --tlr-child-indent: 26px;
        --tlr-context-rail-gap: 8px;
        --tlr-text-default: var(--text-default, var(--text, inherit));
        --tlr-text-muted: var(--text-muted, var(--text-secondary, var(--tlr-text-default)));
        --tlr-label-color: var(--tlr-text-default);
        --tlr-label-font-size: 14px;
        --tlr-label-font-weight: 700;
        --tlr-border-color: var(--divider-color, var(--cmdpal-border-color, var(--border-subtle, transparent)));
        --tlr-hover-bg: var(--button-normal-hover-color, var(--bg-hover, transparent));
        --tlr-selected-bg: var(--bg-selected, var(--tlr-hover-bg));
        --tlr-editor-font: var(--editor-font-family, var(--font-family, inherit));
        --tlr-editor-size: var(--editor-font-size, 15px);
        margin-top: 14px;
        color: var(--tlr-text-default);
        font-size: 13px;
      }

      .tlr-footer--native .tlr-panel-nav-actions {
        display: none !important;
      }

      /*
       * No card/frame — sit directly on the page like the built-in backlinks.
       * The html + double-class prefix outranks theme plugins that card
       * .tlr-footer with !important (e.g. Theme Architect "Backreferences glass").
       */
      html .tlr-footer.tlr-footer--native {
        padding: 0 !important;
        margin-top: 14px;
      }

      html .tlr-footer.tlr-footer--native,
      .tlr-footer--native .tlr-header-field,
      .tlr-footer--native .tlr-section,
      .tlr-footer--native .tlr-section-slot {
        background: transparent !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }

      /* Left rail runs the length of the list, like the built-in backlinks. */
      .tlr-footer--native .tlr-body {
        background: transparent !important;
        border: none;
        border-left: 1px solid var(--tlr-border-color);
        border-radius: 0 !important;
        box-shadow: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
        margin-left: 10px;
        padding-left: 14px;
      }

      /*
       * Host wrappers (suite shells, theme cards, orphan divs) must not re-frame us.
       * Cover only-child and “footer among siblings” parents up to two levels.
       */
      :where(div):has(> .tlr-footer--native),
      :where(div):has(> :where(div) > .tlr-footer--native) {
        background: transparent !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }

      .tlr-footer--native {
        padding: 0;
        background: transparent !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        -webkit-backdrop-filter: none !important;
        backdrop-filter: none !important;
      }

      .tlr-summary-pill {
        display: inline-flex !important;
        align-items: center;
        gap: 8px;
        width: auto;
        height: auto;
        max-width: 100%;
        padding: 4px 12px 4px 8px !important;
        min-height: 28px;
        border-radius: 999px !important;
        background: var(--button-minimal-bg-color, var(--bg-secondary, rgba(127,127,127,0.14))) !important;
        border: 1px solid var(--tlr-border-color) !important;
        color: var(--tlr-text-default);
      }

      .tlr-summary-pill .tlr-pill-label {
        flex: 0 1 auto;
        font-size: 13px;
        font-weight: 600;
        color: var(--tlr-text-default);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tlr-summary-pill .tlr-count {
        flex: 0 0 auto;
        font-size: 12px;
        font-weight: 500;
        color: var(--tlr-text-muted);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .tlr-summary-pill .tlr-toggle-caret {
        opacity: 0.85;
      }

      .tlr-summary-pill .tlr-title-icon {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        font-size: 14px;
        line-height: 1;
        opacity: 0.9;
        color: var(--tlr-text-muted);
      }

      .tlr-inline-svg-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 0;
        color: inherit;
      }

      .tlr-inline-svg-icon svg {
        display: block;
      }

      .tlr-header {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 28px;
        margin-bottom: 0;
      }

      .tlr-header-field {
        padding-bottom: 0;
      }

      .tlr-header-main {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tlr-header-controls {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      /* Settings cog: hover-reveal like Today's Highlights. */
      .tlr-hover-action {
        opacity: 0;
        transition: opacity 0.12s;
      }
      .tlr-header:hover .tlr-hover-action,
      .tlr-header:focus-within .tlr-hover-action,
      .tlr-hover-action:focus-visible {
        opacity: 1;
      }
      @media (hover: none), (pointer: coarse) {
        .tlr-hover-action { opacity: 0.6; }
      }

      .tlr-settings-cog {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 28px;
        min-height: 24px;
        color: var(--tlr-text-muted);
      }
      .tlr-settings-cog:hover {
        color: var(--tlr-text-default);
      }

      .tlr-menu {
        position: fixed;
        z-index: 100000;
        min-width: 220px;
        padding: 5px;
        border-radius: 10px;
        background: var(--cmdpal-bg-color, var(--panel-bg-color, #1d1915));
        border: 1px solid var(--divider-color, var(--cmdpal-border-color, rgba(255,255,255,0.1)));
        box-shadow: var(--cmdpal-box-shadow, 0 8px 32px rgba(0,0,0,0.45));
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .tlr-menu-item {
        display: block;
        width: 100%;
        padding: 6px 8px;
        border-radius: 6px;
        background: transparent;
        border: none;
        color: var(--tlr-text-default);
        font-size: 13px;
        text-align: left;
        cursor: pointer;
      }
      .tlr-menu-item:hover {
        background: var(--button-normal-hover-color, rgba(255,255,255,0.07));
      }
      .tlr-menu-sep {
        height: 1px;
        margin: 4px 6px;
        background: var(--divider-color, rgba(255,255,255,0.08));
      }

      .tlr-title {
        display: none;
      }

      .tlr-count {
        flex: 1 1 auto;
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        line-height: normal;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .tlr-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        box-sizing: border-box;
      }

      .tlr-search-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
      }

      .tlr-filter-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .tlr-filter-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        min-height: 24px;
        border: 1px solid transparent;
        border-radius: var(--button-radius, 5px);
        transition: background-color 0.15s, border-color 0.15s, color 0.15s;
      }

      .tlr-filter-toggle.is-active {
        background: var(--button-minimal-bg-active-color, var(--tlr-selected-bg));
        border-color: var(--button-minimal-hover-color, var(--button-minimal-border-color, transparent));
        color: var(--button-minimal-fg-color, var(--tlr-text-default));
      }

      .tlr-filter-toggle.is-active .id--filter-icon {
        color: var(--button-primary-icon-color, currentColor);
        font-weight: 700;
      }

      .tlr-sort-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .tlr-sort-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
      }

      .tlr-sort-glyph {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        width: 14px;
        height: 12px;
      }

      .tlr-sort-glyph-bars {
        position: relative;
        width: 8px;
        height: 10px;
      }

      .tlr-sort-glyph-bars::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 8px;
        height: 2px;
        background: currentColor;
        box-shadow: 0 4px 0 currentColor, 0 8px 0 currentColor;
        opacity: 0.9;
      }

      .tlr-sort-glyph-arrows {
        position: relative;
        width: 4px;
        height: 10px;
      }

      .tlr-sort-glyph-arrows::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        border-left: 2px solid transparent;
        border-right: 2px solid transparent;
        border-bottom: 3px solid currentColor;
        opacity: 0.95;
      }

      .tlr-sort-glyph-arrows::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        border-left: 2px solid transparent;
        border-right: 2px solid transparent;
        border-top: 3px solid currentColor;
        opacity: 0.95;
      }

      .tlr-sort-menu {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 260px;
        max-width: min(90vw, 340px);
        z-index: 140;
      }

      .tlr-sort-menu,
      .tlr-search-autocomplete {
        padding: 6px;
        border-radius: var(--radius-normal, 8px);
        border: 1px solid var(--cmdpal-border-color, var(--tlr-border-color));
        background: var(--cmdpal-bg-color, var(--panel-bg-color, var(--bg-default, var(--bg-panel, transparent))));
        box-shadow: var(--cmdpal-box-shadow, 0 12px 34px rgba(0, 0, 0, 0.18));
      }

      .tlr-search-autocomplete {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        width: min(420px, max(260px, 100%));
        max-width: min(90vw, 420px);
        z-index: 140;
      }

      .tlr-search-autocomplete .autocomplete,
      .tlr-sort-menu .autocomplete {
        position: relative;
        overflow: hidden;
        max-height: 300px;
      }

      .tlr-sort-menu .autocomplete {
        max-height: min(80vh, 460px);
      }

      .tlr-search-autocomplete .vscroll-node,
      .tlr-sort-menu .vscroll-node {
        max-height: 300px;
        overflow-y: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
        touch-action: pan-y;
      }

      .tlr-sort-menu .vscroll-node {
        max-height: min(80vh, 460px);
        overflow-y: visible;
      }

      .tlr-search-autocomplete .vscroll-node::-webkit-scrollbar,
      .tlr-sort-menu .vscroll-node::-webkit-scrollbar {
        width: 0;
        height: 0;
      }

      .tlr-search-autocomplete .vcontent,
      .tlr-sort-menu .vcontent {
        position: relative;
      }

      .tlr-search-autocomplete .vscrollbar,
      .tlr-sort-menu .vscrollbar {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 15px;
        user-select: none;
        display: none;
      }

      .tlr-search-autocomplete .vscrollbar.has-thumb,
      .tlr-sort-menu .vscrollbar.has-thumb {
        display: block;
      }

      .tlr-search-autocomplete .vscrollbar-thumb,
      .tlr-sort-menu .vscrollbar-thumb {
        min-height: 16px;
      }

      .tlr-search-autocomplete .autocomplete--option,
      .tlr-sort-menu .autocomplete--option {
        border-radius: 6px;
      }

      .tlr-search-autocomplete .autocomplete--option-right,
      .tlr-sort-menu .autocomplete--option-right {
        color: var(--tlr-text-muted);
        font-size: 11px;
      }

      .tlr-sort-open .tlr-sort-menu {
        display: block;
      }

      .tlr-sort-menu-title {
        margin: 0;
        padding: 8px 10px 4px;
        font-size: 11px;
      }

      .tlr-sort-menu-state {
        padding: 10px 10px 8px;
        margin-bottom: 2px;
        border-bottom: 1px solid var(--tlr-border-color);
        color: var(--tlr-text-muted);
        font-size: 11.5px;
        line-height: 1.45;
      }

      .tlr-sort-option {
        width: 100%;
        display: flex;
        align-items: center;
        min-height: 30px;
        padding: 6px 10px;
        line-height: 1.4;
        text-align: left;
        color: var(--tlr-text-default);
        border-radius: 6px;
        box-sizing: border-box;
      }

      .tlr-sort-option-label {
        flex: 1 1 auto;
      }

      .tlr-sort-menu .tlr-sort-option.autocomplete--option-selected,
      .tlr-sort-menu .tlr-sort-option[aria-checked="true"] {
        background: var(--button-primary-bg-color, var(--accent-bg-color, var(--tlr-selected-bg)));
        color: var(--button-primary-fg-color, var(--text-on-accent, var(--tlr-text-default)));
      }

      .tlr-sort-menu .tlr-sort-option:hover,
      .tlr-sort-menu .tlr-sort-option:focus-visible {
        background: var(--button-normal-hover-color, var(--tlr-hover-bg));
      }

      .tlr-sort-menu .tlr-sort-option.autocomplete--option-selected:hover,
      .tlr-sort-menu .tlr-sort-option.autocomplete--option-selected:focus-visible,
      .tlr-sort-menu .tlr-sort-option[aria-checked="true"]:hover,
      .tlr-sort-menu .tlr-sort-option[aria-checked="true"]:focus-visible {
        background: var(--button-primary-bg-color, var(--accent-bg-color, var(--tlr-selected-bg)));
        color: var(--button-primary-fg-color, var(--text-on-accent, var(--tlr-text-default)));
      }

      .tlr-sort-menu-divider {
        margin: 8px 0;
        border-top: 1px solid var(--cmdpal-border-color, var(--tlr-border-color));
      }

      .tlr-search-row {
        display: none;
        width: 100%;
        padding-top: 0;
      }

      .tlr-search-row-inner {
        width: 100%;
      }

      .tlr-search-open .tlr-search-row {
        display: block;
      }

      .tlr-search-wrap {
        position: relative;
        width: 100%;
      }

      .tlr-query-input {
        position: relative;
        width: 100%;
      }

      .tlr-query-input .query-input--wrapper {
        position: relative;
        display: block;
      }

      .tlr-query-input .query-input--highlight {
        display: none;
      }

      .tlr-search-input {
        width: 100%;
        max-width: none;
        min-width: 0;
        position: relative;
        min-height: 34px;
        border: 1px solid var(--input-border-color, var(--tlr-border-color)) !important;
        outline: none !important;
        background: var(--input-bg-color, var(--cmdpal-input-bg-color, var(--bg-panel, transparent))) !important;
        color: var(--input-fg-color, var(--tlr-text-default)) !important;
        -webkit-text-fill-color: var(--input-fg-color, var(--tlr-text-default)) !important;
        caret-color: var(--input-fg-color, var(--tlr-text-default));
        opacity: 1;
        font-size: 13px;
        line-height: 22px;
        font-family: var(--ed-variable-width-font, inherit);
        font-weight: 400;
        padding: 5px 54px 5px 12px;
        border-radius: var(--radius-normal, 8px);
        box-shadow: none !important;
        transition: border-color 0.15s, box-shadow 0.15s, outline-color 0.15s;
      }

      .tlr-search-input::placeholder {
        color: var(--text-xmuted, var(--tlr-text-muted));
      }

      .tlr-search-input:focus {
        border: var(--input-border-focus, 1px solid var(--input-border-color, var(--tlr-border-color))) !important;
        outline: var(--input-border-focus, 1px solid var(--input-border-color, var(--tlr-border-color))) !important;
        box-shadow: var(--input-border-shadow, none) !important;
      }

      .tlr-search-autocomplete-open .tlr-search-autocomplete {
        display: block;
      }

      .tlr-search-clear,
      .tlr-search-refresh {
        display: none;
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        background: transparent;
        border-radius: 50%;
        cursor: pointer;
        z-index: 2;
        font-size: 12px;
        line-height: 1;
        color: var(--tlr-text-muted);
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        align-items: center;
        justify-content: center;
      }

      .tlr-search-clear:hover,
      .tlr-search-refresh:hover {
        opacity: 1;
        background: var(--tlr-hover-bg);
      }

      .tlr-toggle:not(.tlr-summary-pill) {
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        padding: 0;
        color: var(--tlr-text-muted);
      }

      .tlr-body {
        display: block;
      }

      .tlr-collapsed .tlr-body,
      .tlr-collapsed .tlr-search-row {
        display: none;
      }

      .tlr-empty,
      .tlr-note,
      .tlr-error {
        color: var(--tlr-text-muted);
        padding: 6px 0;
        font-size: 12px;
      }

      .tlr-section-body > .tlr-empty,
      .tlr-section-body > .tlr-note,
      .tlr-section-body > .tlr-error {
        margin-left: 28px;
      }

      .tlr-section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
      }

      .tlr-section-body {
        padding-top: 8px;
      }

      .tlr-section-toggle {
        width: 20px;
        height: 20px;
        padding: 0;
        color: var(--tlr-text-muted);
        flex: 0 0 auto;
      }

      .tlr-section-title {
        flex: 1 1 auto;
        min-width: 0;
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        color: var(--tlr-label-color);
        text-transform: none;
        letter-spacing: 0;
      }

      .tlr-section-meta {
        flex: 0 0 auto;
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .tlr-section-collapsed .tlr-section-body {
        display: none;
      }

      .tlr-divider {
        margin: 12px 0 8px;
        border-top: 1px solid var(--tlr-border-color);
      }

      .tlr-prop-group { margin: 10px 0 12px; }

      .tlr-prop-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tlr-prop-toggle {
        width: 20px;
        height: 20px;
        padding: 0;
        text-align: center;
        font-weight: 700;
        color: var(--tlr-text-muted);
        flex: 0 0 auto;
      }

      .tlr-prop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        flex: 1 1 auto;
        padding: 2px 0 0;
        min-height: 0;
        border: 0;
        background: transparent !important;
        box-shadow: none;
        text-align: left;
        color: var(--tlr-label-color);
      }

      .tlr-fold-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        color: var(--tlr-text-muted);
        opacity: 0.9;
        font-size: 14px;
        line-height: 1;
        transition: transform 140ms ease, color 140ms ease, opacity 140ms ease;
      }

      .tlr-prop-collapsed .tlr-prop-records {
        display: none;
      }

      .tlr-prop-title {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: normal;
        overflow-wrap: anywhere;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-prop-meta {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-prop-records {
        margin-top: 10px;
        margin-left: var(--tlr-child-indent);
        padding-left: 10px;
        border-left: 1px solid var(--tlr-border-color);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tlr-prop-record {
        display: block;
        width: 100%;
        padding: 7px 10px;
        text-align: left;
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        line-height: 1.4;
        white-space: normal;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .tlr-prop-record:hover {
        color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit)))));
        text-decoration: underline;
      }

      .tlr-prop-record-wrap {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }

      .tlr-prop-record-row {
        display: flex;
        align-items: center;
        gap: 6px;
        width: 100%;
        min-width: 0;
      }

      .tlr-prop-record-row .tlr-expand-record-btn {
        flex: 0 0 auto;
      }

      .tlr-prop-record-row .tlr-row-title-cluster {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-prop-record-row .tlr-prop-record {
        flex: 1 1 auto;
        min-width: 0;
        width: auto;
      }

      .tlr-row-title-cluster {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-group-title {
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-line-title-cluster {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-line-title-cluster .tlr-line {
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-panel-nav-actions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
        opacity: 0.72;
        transition: opacity 120ms ease;
      }

      .tlr-group-row:hover .tlr-panel-nav-actions,
      .tlr-group-row:focus-within .tlr-panel-nav-actions,
      .tlr-prop-record-row:hover .tlr-panel-nav-actions,
      .tlr-prop-record-row:focus-within .tlr-panel-nav-actions,
      .tlr-line-main:hover .tlr-panel-nav-actions,
      .tlr-line-main:focus-within .tlr-panel-nav-actions,
      .tlr-group-header:hover .tlr-panel-nav-actions,
      .tlr-group-header:focus-within .tlr-panel-nav-actions {
        opacity: 1;
      }

      .tlr-panel-nav-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border-radius: 5px;
        color: var(--tlr-text-muted);
        line-height: 1;
      }

      .tlr-panel-nav-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
      }

      .tlr-panel-nav-icon svg {
        display: block;
        width: 14px;
        height: 14px;
      }

      .tlr-panel-nav-btn:hover {
        color: var(--tlr-text-default);
        background: var(--tlr-selected-bg);
      }

      .tlr-footer .tlr-prop-record-wrap .tlr-record-preview {
        margin-left: 4px;
      }

      .tlr-expand-record-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        flex: 0 0 auto;
        color: var(--tlr-text-muted);
      }

      .tlr-expand-record-btn:hover {
        color: var(--tlr-text-default);
      }

      .tlr-expand-record-btn.is-expanded {
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
      }

      .tlr-expand-record-btn .tlr-expand-caret {
        font-size: 14px;
        line-height: 1;
      }

      .tlr-record-preview {
        display: none;
        flex-direction: column;
        margin: 2px 0 10px 4px;
        padding: 2px 0 2px 2px;
        gap: 0;
        font-family: var(--tlr-editor-font);
        font-size: var(--tlr-editor-size);
        line-height: 1.6;
        color: var(--tlr-text-default);
      }

      .tlr-record-expanded .tlr-record-preview {
        display: flex;
      }

      .tlr-expand-line {
        display: block;
        width: 100%;
        padding: 1px 6px 1px 2px;
        text-align: left;
        color: var(--tlr-text-default);
        font-family: var(--tlr-editor-font);
        font-size: var(--tlr-editor-size);
        line-height: 1.6;
        border-radius: 4px;
        cursor: pointer;
        transition: background 0.1s, color 0.1s;
      }

      .tlr-expand-line:hover {
        background: var(--tlr-hover-bg);
      }

      .tlr-expand-empty {
        padding: 6px 8px;
        font-size: 12px;
        color: var(--tlr-text-muted);
        font-style: italic;
      }

      .tlr-expand-loading {
        padding: 6px 8px;
      }

      .tlr-preview-node {
        display: flex;
        flex-direction: column;
      }

      .tlr-preview-row {
        display: flex;
        align-items: flex-start;
        gap: 1px;
      }

      .tlr-preview-toggle {
        width: 14px;
        min-width: 14px;
        height: calc(var(--tlr-editor-size) * 1.6);
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        padding: 0;
        color: var(--tlr-text-muted);
        opacity: 0;
        transition: opacity 0.12s ease;
      }

      .tlr-preview-node:hover > .tlr-preview-row > .tlr-preview-toggle,
      .tlr-preview-toggle.is-open,
      .tlr-preview-row:hover > .tlr-preview-toggle {
        opacity: 0.75;
      }

      .tlr-preview-arrow {
        display: block;
        width: 0;
        height: 0;
        border-left: 4px solid transparent;
        border-right: 4px solid transparent;
        border-top: 5px solid currentColor;
        transition: transform 0.12s ease;
      }

      .tlr-preview-arrow.is-collapsed {
        transform: rotate(-90deg);
        opacity: 1;
      }

      /* Collapsed parents keep their affordance visible, like the editor. */
      .tlr-preview-toggle:has(.tlr-preview-arrow.is-collapsed) {
        opacity: 0.75;
      }

      /* Indent guides mirror the editor's vertical rails instead of flat padding. */
      .tlr-preview-children-holder {
        display: flex;
        flex-direction: column;
      }

      .tlr-preview-children-holder.is-hidden {
        display: none;
      }

      .tlr-preview-children {
        display: flex;
        flex-direction: column;
        margin-left: 7px;
        padding-left: 14px;
        border-left: 1px solid var(--tlr-border-color);
      }

      .tlr-preview-row .tlr-expand-line {
        flex: 1;
        min-width: 0;
      }

      .tlr-preview-marker {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 14px;
        height: calc(var(--tlr-editor-size) * 1.6);
        color: var(--tlr-text-muted);
        font-size: 1.08em;
        line-height: 1;
        user-select: none;
      }

      .tlr-preview-marker-ordinal {
        justify-content: flex-end;
        padding-right: 2px;
        font-variant-numeric: tabular-nums;
      }

      .tlr-preview-marker-ulist {
        font-size: 1.3em;
      }

      .tlr-preview-marker-checkbox {
        width: 13px;
        min-width: 13px;
        height: 13px;
        margin-top: calc((var(--tlr-editor-size) * 1.6 - 13px) / 2);
        border: 1px solid var(--tlr-border-color);
        border-radius: 3px;
        font-size: 10px;
        line-height: 1;
      }

      .tlr-preview-marker-checkbox.is-done {
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        border-color: currentColor;
      }

      .tlr-preview-row-task .tlr-expand-line,
      .tlr-preview-row-ulist .tlr-expand-line,
      .tlr-preview-row-olist .tlr-expand-line {
        padding-left: 4px;
      }

      .tlr-preview-row-heading .tlr-expand-line {
        font-weight: 600;
        font-size: calc(var(--tlr-editor-size) * 1.12);
        padding-top: 4px;
      }

      .tlr-preview-row-quote .tlr-expand-line {
        border-left: 2px solid var(--tlr-border-color);
        padding-left: 8px;
        font-style: italic;
        color: var(--tlr-text-muted);
      }

      .tlr-preview-row-ref > .tlr-expand-line,
      .tlr-preview-row-transclusion > .tlr-expand-line {
        color: var(--ed-link-color, var(--link-color, var(--accent, var(--tlr-text-default))));
        font-weight: 500;
      }

      .tlr-preview-link-pill {
        display: inline-flex !important;
        width: auto !important;
        max-width: 100%;
        align-items: center;
        gap: 4px;
        margin: 1px 0;
        padding: 3px 10px 3px 8px !important;
        border-radius: 8px;
        background: color-mix(in srgb, var(--tlr-selected-bg) 70%, var(--tlr-text-default) 14%);
        border: 1px solid color-mix(in srgb, var(--tlr-border-color) 70%, transparent);
      }

      .tlr-preview-transclusion-title {
        font-weight: 600;
      }

      .tlr-preview-reference-glyph {
        display: inline-block;
        margin-left: 5px;
        color: currentColor;
        font-size: 0.82em;
        opacity: 0.72;
        transform: translateY(-0.08em);
      }

      /* Note blocks render as a soft container in the editor; approximate it here. */
      .tlr-preview-node[data-line-type="block"] > .tlr-preview-children-holder > .tlr-preview-children {
        margin: 2px 0 4px 7px;
        padding: 4px 10px;
        border: 1px solid var(--tlr-border-color);
        border-radius: 8px;
        background: color-mix(in srgb, var(--tlr-selected-bg) 70%, #000 18%);
      }

      .tlr-preview-transcluded {
        margin-top: 1px;
        margin-bottom: 3px;
        padding-top: 4px;
        padding-bottom: 4px;
        border-left: 1px solid var(--tlr-border-color) !important;
        border-radius: 0 8px 8px 0;
        background: color-mix(in srgb, var(--tlr-selected-bg) 65%, #000 22%);
      }

      .tlr-preview-embed-note {
        color: var(--tlr-text-muted);
        font-style: italic;
      }

      .tlr-group { margin: 6px 0 10px; }

      .tlr-group-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
      }

      .tlr-group-toggle {
        width: 20px;
        height: 20px;
        padding: 0;
        text-align: center;
        font-weight: 700;
        color: var(--tlr-text-muted);
        flex: 0 0 auto;
        margin-top: 1px;
      }

      .tlr-group-header {
        width: 100%;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 2px 0 0;
        min-height: 0;
        border: 0;
        background: transparent !important;
        box-shadow: none;
        text-align: left;
        color: var(--tlr-label-color);
      }

      .tlr-group-collapsed .tlr-lines {
        display: none;
      }

      .tlr-group-title {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        overflow: visible;
        text-overflow: clip;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.35;
        display: inline-flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0 6px;
      }

      .tlr-record-icon {
        flex: 0 0 auto;
        font-size: 15px;
        line-height: 1;
        color: var(--tlr-text-muted);
        margin-right: 2px;
        transform: translateY(1px);
      }

      .tlr-group-title-text {
        font-weight: 700;
        color: var(--tlr-text-default);
      }

      .tlr-title-sep {
        color: var(--tlr-text-muted);
        font-weight: 500;
        opacity: 0.7;
      }

      .tlr-title-meta {
        color: var(--tlr-text-muted);
        font-weight: 500;
        font-size: 13px;
      }

      .tlr-prop-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin: 6px 0 4px var(--tlr-child-indent);
        padding-left: 4px;
      }

      .tlr-prop-chip {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 5px 10px;
        border-radius: 8px;
        border: 1px solid var(--tlr-border-color);
        background: var(--button-minimal-bg-color, var(--bg-secondary, rgba(127,127,127,0.12)));
        color: var(--tlr-text-muted);
        font-size: 12.5px;
        font-weight: 500;
      }

      .tlr-prop-chip-icon {
        font-size: 14px;
        opacity: 0.85;
      }

      .tlr-bucket-header {
        margin: 12px 0 6px 2px;
        color: var(--tlr-text-muted);
        font-size: 12px;
        font-weight: 600;
        letter-spacing: 0.01em;
        text-transform: none;
      }

      .tlr-bucket-header:first-child {
        margin-top: 4px;
      }

      .tlr-unlinked-pill {
        display: inline-flex !important;
        align-items: center;
        gap: 8px;
        margin-top: 14px;
        padding: 4px 12px 4px 8px !important;
        min-height: 28px;
        border-radius: 999px !important;
        background: var(--button-minimal-bg-color, var(--bg-secondary, rgba(127,127,127,0.14))) !important;
        border: 1px solid var(--tlr-border-color) !important;
        color: var(--tlr-text-default);
        font-size: 13px;
        font-weight: 600;
      }

      .tlr-unlinked-pill-label {
        white-space: nowrap;
      }

      .tlr-unlinked-results {
        margin-top: 10px;
      }

      .tlr-section-slot-property,
      .tlr-section-slot-linked {
        margin-top: 4px;
      }

      .tlr-group-meta {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        flex: 0 0 auto;
      }

      .tlr-group-single .tlr-group-meta {
        display: none;
      }

      .tlr-lines {
        margin-top: 10px;
        margin-left: var(--tlr-child-indent);
        padding-left: 10px;
        border-left: 1px solid var(--tlr-border-color);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .tlr-group .tlr-lines {
        margin-top: 2px;
        gap: 6px;
      }

      .tlr-line-entry {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .tlr-line-main {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        border-radius: var(--radius-normal, 8px);
        border: 1px solid transparent;
        background: transparent;
        transition: background-color 0.15s, border-color 0.15s;
      }

      .tlr-group .tlr-line-main {
        border: 0;
        background: transparent;
      }

      .tlr-line-main:hover,
      .tlr-line-main:focus-within {
        background: var(--tlr-hover-bg);
        border-color: var(--tlr-border-color);
      }

      .tlr-line-main.is-context-open {
        background: var(--tlr-selected-bg);
        border-color: var(--tlr-border-color);
      }

      .tlr-line {
        display: block;
        flex: 1 1 auto;
        min-width: 0;
        padding: 8px 10px 8px 12px;
        text-align: left;
        color: var(--tlr-text-default);
        line-height: 1.35;
        border-radius: inherit;
      }

      .tlr-group .tlr-line {
        padding: 4px 6px 7px 10px;
      }

      .tlr-prefix {
        color: var(--tlr-text-muted);
      }

      .tlr-line-content {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
      }

      .tlr-line-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 82px;
        width: 82px;
        padding: 2px 8px 6px 0;
        min-height: 100%;
        justify-content: flex-end;
      }

      .tlr-group-unlinked .tlr-line-actions {
        flex-basis: 110px;
        width: 110px;
      }

      .tlr-line-actions {
        opacity: 0;
        transition: opacity 120ms ease;
      }

      .tlr-line-main:hover .tlr-line-actions,
      .tlr-line-main:focus-within .tlr-line-actions {
        opacity: 1;
      }

      .tlr-line-actions-group {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-unlinked-link-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border-radius: 6px;
        color: var(--tlr-text-muted);
        line-height: 1;
      }

      .tlr-unlinked-link-btn:hover {
        color: var(--tlr-text-default);
        background: var(--tlr-selected-bg);
      }

      .tlr-unlinked-link-icon {
        width: 14px;
        height: 14px;
      }

      .tlr-unlinked-link-btn-fallback {
        width: auto;
        min-width: 40px;
        padding: 0 8px;
        font-size: 12px;
      }

      .tlr-context-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border-radius: 6px;
        color: var(--tlr-text-muted);
      }

      .tlr-context-btn:hover:not(:disabled),
      .tlr-context-btn.is-active {
        color: var(--tlr-text-default);
        background: var(--tlr-selected-bg);
      }

      .tlr-context-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }

      .tlr-context-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
      }

      .tlr-context-glyph > * {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
      }

      .tlr-context-glyph .ti {
        font-size: 14px;
        line-height: 1;
      }

      .tlr-context-glyph-toggle {
        flex-direction: column;
        gap: 0;
      }

      .tlr-context-glyph-toggle .ti {
        font-size: 12px;
        margin: -3px 0;
      }

      .tlr-context-glyph-toggle > * {
        width: 12px;
        height: 12px;
      }

      .tlr-context-btn-toggle {
        width: 26px;
      }

      .tlr-context-list {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin-left: 0;
        padding-left: 0;
      }

      .tlr-context-line {
        display: block;
        box-sizing: border-box;
        width: calc(100% - var(--tlr-context-indent, 0px));
        margin-left: var(--tlr-context-indent, 0px);
        padding: 5px 10px 5px 12px;
        text-align: left;
        color: var(--tlr-text-default);
        line-height: 1.35;
        border-left: 1px solid var(--tlr-border-color);
        border-radius: 6px;
        transition: background-color 0.15s, border-color 0.15s;
      }

      .tlr-context-line:hover,
      .tlr-context-line:focus-visible {
        background: var(--tlr-hover-bg);
      }

      .tlr-context-note {
        padding: 0 10px 2px;
      }

      .tlr-live-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid var(--tlr-border-color);
        background: var(--tlr-hover-bg);
        color: var(--tlr-text-muted);
        font-size: 11px;
        vertical-align: middle;
      }

      .tlr-live-badge.is-new {
        color: var(--tlr-text-default);
      }

      .tlr-live-badge.is-remote {
        border-style: dashed;
      }

      .tlr-seg-bold { font-weight: 600; }
      .tlr-seg-italic { font-style: italic; }
      .tlr-seg-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
        padding: 1px 4px;
        border-radius: 6px;
      }
      .tlr-seg-link { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); text-decoration: underline; }
      .tlr-seg-link:visited { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-link:hover { color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit))))); }
      .tlr-seg-hashtag { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-datetime { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-mention { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-ref { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); cursor: pointer; text-decoration: underline; }
      .tlr-seg-ref:hover { color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit))))); }

      .tlr-search-mark {
        background: var(--ed-selection-self-bg, var(--selection-bg, rgba(255, 217, 61, 0.35)));
        color: inherit;
        padding: 0 1px;
        border-radius: 4px;
        display: inline;
        line-height: inherit;
      }

      .tlr-loading .tlr-search-wrap { opacity: 0.78; }
      .tlr-loading .tlr-sort-toggle { opacity: 0.6; cursor: default; }

      /* ---------- Native list density (one line per backlink) ---------- */

      .tlr-footer--native .tlr-header-field {
        margin-bottom: 2px;
      }

      .tlr-footer--native .tlr-group {
        margin: 0;
      }

      .tlr-footer--native .tlr-group-row {
        align-items: center;
        gap: 2px;
        padding: 5px 8px 5px 0;
        border-radius: 8px;
      }

      .tlr-footer--native .tlr-group-row:hover {
        background: var(--tlr-hover-bg);
      }

      .tlr-footer--native .tlr-group-header {
        justify-content: space-between;
        align-items: baseline;
        gap: 14px;
        padding: 0;
        min-width: 0;
      }

      .tlr-footer--native .tlr-group-title {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: baseline;
        flex-wrap: nowrap;
        gap: 0;
        white-space: nowrap;
        overflow: hidden;
        font-size: var(--tlr-editor-size);
        font-weight: 600;
        line-height: 1.7;
      }

      .tlr-footer--native .tlr-group-title-text {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      /* Fixed slot keeps every title on the same left edge, icon or not. */
      .tlr-footer--native .tlr-record-icon-slot {
        flex: 0 0 auto;
        width: 20px;
        display: inline-flex;
        justify-content: flex-start;
        align-items: center;
      }

      .tlr-footer--native .tlr-record-icon {
        font-size: 14px;
        margin: 0;
        opacity: 0.7;
      }

      .tlr-footer--native .tlr-row-meta {
        flex: 0 1 auto;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 0 5px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .tlr-footer--native .tlr-title-sep,
      .tlr-footer--native .tlr-title-meta {
        flex: 0 0 auto;
        font-size: 12.5px;
        font-weight: 400;
      }

      .tlr-footer--native .tlr-group-modes {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        margin-right: 2px;
      }

      .tlr-footer--native .tlr-group-mode {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 26px;
        min-height: 24px;
        border-radius: var(--button-radius, 5px);
        color: var(--tlr-text-muted);
        opacity: 0.5;
        transition: opacity 0.15s, background-color 0.15s, color 0.15s;
      }

      .tlr-footer--native .tlr-group-mode:hover {
        opacity: 0.9;
      }

      .tlr-footer--native .tlr-group-mode.is-active {
        opacity: 1;
        color: var(--tlr-text-default);
        background: var(--button-minimal-bg-active-color, var(--tlr-selected-bg));
      }

      .tlr-footer--native .tlr-expand-record-btn {
        width: 16px;
        height: 16px;
        opacity: 0;
        transition: opacity 0.12s;
      }

      .tlr-footer--native .tlr-group-row:hover .tlr-expand-record-btn,
      .tlr-footer--native .tlr-expand-record-btn:focus-visible,
      .tlr-footer--native .tlr-expand-record-btn.is-expanded {
        opacity: 1;
      }

      /* Touch devices never get :hover — keep the caret visible but recessed. */
      @media (hover: none), (pointer: coarse) {
        .tlr-footer--native .tlr-expand-record-btn { opacity: 0.65; }
      }

      .tlr-footer--native .tlr-expand-record-btn .tlr-expand-caret {
        font-size: 12px;
      }

      .tlr-footer--native .tlr-lines {
        margin-top: 0;
        margin-left: 22px;
        padding-left: 8px;
        gap: 2px;
      }

      .tlr-footer--native .tlr-line {
        font-size: 13.5px;
        line-height: 1.5;
        color: var(--tlr-text-muted);
      }

      .tlr-footer--native .tlr-bucket-header {
        margin: 16px 0 4px 0;
        font-size: 11.5px;
        font-weight: 600;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        opacity: 0.55;
      }

      .tlr-footer--native .tlr-bucket-header:first-child {
        margin-top: 4px;
      }

      .tlr-footer--native .tlr-record-preview {
        margin-left: 22px;
      }

      /* Secondary to the list: indented, quieter, lighter than a row title. */
      .tlr-footer--native .tlr-unlinked-pill {
        margin-top: 18px;
        margin-left: 4px;
        padding: 2px 11px 2px 7px !important;
        min-height: 24px;
        gap: 6px;
        font-size: 12px;
        font-weight: 500;
        color: var(--tlr-text-muted);
        background: transparent !important;
        opacity: 0.75;
        transition: opacity 0.15s, background-color 0.15s;
      }

      .tlr-footer--native .tlr-unlinked-pill:hover,
      .tlr-footer--native .tlr-unlinked-pill[aria-expanded="true"] {
        opacity: 1;
        background: var(--tlr-hover-bg) !important;
      }

      .tlr-footer--native .tlr-unlinked-pill-caret {
        font-size: 11px;
      }

      .tlr-tm-toggle.is-active {
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
      }

      .tlr-tm-toggle.is-disabled,
      .tlr-tm-toggle:disabled {
        opacity: 0.35;
        cursor: default;
      }

      .tlr-tm-section {
        margin-top: 18px;
        padding-top: 12px;
        border-top: 1px solid var(--tlr-border-color);
      }

      .tlr-tm-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        color: var(--tlr-text-muted);
      }

      .tlr-tm-icon {
        display: inline-flex;
        width: 16px;
        height: 16px;
        opacity: 0.85;
      }

      .tlr-tm-title {
        flex: 1;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }

      .tlr-tm-year-head {
        margin: 12px 0 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--tlr-border-color);
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--tlr-text-default);
        opacity: 0.85;
      }

      .tlr-tm-year-head:first-child { margin-top: 0; }

      .tlr-tm-subcoll {
        margin: 8px 0 4px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--tlr-text-muted);
      }

      .tlr-tm-settings-overlay {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
      }

      .tlr-tm-settings-panel {
        width: min(560px, 92vw);
        max-height: min(80vh, 720px);
        overflow: auto;
        padding: 18px 18px 14px;
        border-radius: 12px;
        background: var(--bg-default, #18181b);
        color: var(--tlr-text-default);
        border: 1px solid var(--tlr-border-color);
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .tlr-tm-settings-panel h3 { margin: 0; font-size: 16px; }
      .tlr-tm-settings-help { margin: 0; font-size: 12px; color: var(--tlr-text-muted); line-height: 1.4; }
      .tlr-tm-settings-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
      .tlr-tm-settings-input, .tlr-tm-filter-row input, .tlr-tm-filter-row select {
        width: 100%;
        padding: 7px 10px;
        border-radius: 6px;
        font-size: 12px;
        background: var(--bg-default, #18181b);
        color: inherit;
        border: 1px solid var(--border-default, #3f3f46);
      }
      .tlr-tm-filters { display: flex; flex-direction: column; gap: 8px; }
      .tlr-tm-filter-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .tlr-tm-filter-row input, .tlr-tm-filter-row select { width: auto; flex: 1; min-width: 90px; }
      .tlr-tm-settings-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
      .tlr-tm-settings-actions button, .tlr-tm-settings-secondary {
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid var(--tlr-border-color);
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 13px;
      }
      .tlr-tm-settings-primary {
        background: var(--ed-link-color, var(--link-color, #6aa7ff)) !important;
        border-color: transparent !important;
        color: #fff !important;
        font-weight: 700;
      }

      @media (max-width: 760px) {
        .tlr-footer {
          --tlr-child-indent: 22px;
          --tlr-context-rail-gap: 6px;
        }

        .tlr-header {
          gap: 8px;
          align-items: flex-start;
        }

        .tlr-header-main {
          min-width: 0;
        }

        .tlr-count {
          min-width: 0;
        }

        .tlr-sort-menu {
          right: 0;
          left: auto;
          min-width: 240px;
          max-width: min(92vw, 320px);
        }
        .tlr-search-input { max-width: none; }
      }
    `);
  }
}
