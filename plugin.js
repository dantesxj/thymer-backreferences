class Plugin extends AppPlugin {
  onLoad() {
    // NOTE: Thymer strips top-level code outside the Plugin class.
    this._version = '0.2.3';
    this._pluginName = 'Backreferences';

    this._panelStates = new Map();
    this._eventHandlerIds = [];

    this._storageKeyCollapsed = 'thymer_backreferences_collapsed_v1';
    this._legacyStorageKeyCollapsed = 'thymer_backlinks_collapsed_v1';
    this._collapsed = this.loadCollapsedSetting();

    this._storageKeyPropGroupCollapsed = 'thymer_backreferences_prop_group_collapsed_v1';
    this._legacyStorageKeyPropGroupCollapsed = 'thymer_backlinks_prop_group_collapsed_v1';
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();

    this._defaultMaxResults = 200;
    this._refreshDebounceMs = 350;

    this.injectCss();

    this._cmdRefresh = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Refresh (Active Page)',
      icon: 'refresh',
      onSelected: () => {
        const panel = this.ui.getActivePanel();
        if (panel) this.scheduleRefreshForPanel(panel, { force: true, reason: 'cmdpal' });
      }
    });

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
    this._eventHandlerIds.push(this.events.on('lineitem.updated', (ev) => this.handleLineItemUpdated(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.deleted', () => this.handleLineItemDeleted()));
    this._eventHandlerIds.push(this.events.on('record.updated', (ev) => this.handleRecordUpdated(ev)));

    const panel = this.ui.getActivePanel();
    if (panel) this.handlePanelChanged(panel, 'initial');
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

    this._cmdRefresh?.remove?.();

    for (const panelId of Array.from(this._panelStates?.keys?.() || [])) {
      this.disposePanelState(panelId);
    }
    this._panelStates?.clear?.();
  }

  // ---------- Panel lifecycle ----------

  handlePanelChanged(panel, reason) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;

    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;

    if (!recordGuid) {
      // If the panel no longer shows a record, remove our footer.
      this.disposePanelState(panelId);
      return;
    }

    const state = this.getOrCreatePanelState(panel);
    const recordChanged = state.recordGuid !== recordGuid;
    state.recordGuid = recordGuid;

    this.mountFooter(panel, state);

    // Always refresh on navigation; on focus we debounce unless already loaded.
    this.scheduleRefreshForPanel(panel, {
      force: recordChanged,
      reason: reason || (recordChanged ? 'record-changed' : 'record-same')
    });
  }

  handlePanelClosed(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    this.disposePanelState(panelId);
  }

  getOrCreatePanelState(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) {
      return {
        panelId: 'unknown',
        recordGuid: null,
        mountedIn: null,
        rootEl: null,
        bodyEl: null,
        countEl: null,
        observer: null,
        refreshTimer: null,
        refreshSeq: 0
      };
    }

    let state = this._panelStates.get(panelId) || null;
    if (state) {
      state.panel = panel;
      return state;
    }

    state = {
      panelId,
      panel,
      recordGuid: null,
      mountedIn: null,
      rootEl: null,
      bodyEl: null,
      countEl: null,
      observer: null,
      refreshTimer: null,
      refreshSeq: 0,
      isLoading: false
    };

    this._panelStates.set(panelId, state);
    return state;
  }

  disposePanelState(panelId) {
    const state = this._panelStates.get(panelId) || null;
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

    try {
      state.rootEl?.remove?.();
    } catch (e) {
      // ignore
    }

    this._panelStates.delete(panelId);
  }

  // ---------- Mounting ----------

  mountFooter(panel, state) {
    const panelEl = panel?.getElement?.() || null;
    if (!panelEl) return;

    const container = this.findMountContainer(panelEl);
    if (!container) return;

    // If Thymer re-rendered and dropped our node, rebuild.
    const needsRebuild = !state.rootEl || !state.rootEl.isConnected;
    if (needsRebuild) {
      state.rootEl = this.buildFooterRoot(state);
      state.bodyEl = state.rootEl.querySelector('[data-role="body"]');
      state.countEl = state.rootEl.querySelector('[data-role="count"]');
    }

    // Ensure it is mounted in the right container.
    if (state.rootEl && state.rootEl.parentElement !== container) {
      container.appendChild(state.rootEl);
      state.mountedIn = container;
    }

    // If the container/panel DOM churns, remount when our root disappears.
    if (!state.observer) {
      state.observer = new MutationObserver(() => {
        if (state.rootEl && !state.rootEl.isConnected) {
          // Remount on next tick so we don't fight Thymer's own DOM updates.
          setTimeout(() => this.mountFooter(panel, state), 0);
        }
      });
      state.observer.observe(panelEl, { childList: true, subtree: true });
    }
  }

  findMountContainer(panelEl) {
    return (
      panelEl.querySelector?.('.page-content') ||
      panelEl.querySelector?.('.editor-wrapper') ||
      panelEl.querySelector?.('#editor') ||
      panelEl
    );
  }

  buildFooterRoot(state) {
    const root = document.createElement('div');
    root.className = 'tlr-footer';
    root.dataset.panelId = state.panelId;

    const header = document.createElement('div');
    header.className = 'tlr-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tlr-btn tlr-toggle';
    toggleBtn.type = 'button';
    toggleBtn.dataset.action = 'toggle';
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.textContent = this._collapsed ? '+' : '-';

    const title = document.createElement('div');
    title.className = 'tlr-title';
    title.textContent = 'Backreferences';

    const count = document.createElement('div');
    count.className = 'tlr-count';
    count.dataset.role = 'count';
    count.textContent = '';

    const spacer = document.createElement('div');
    spacer.className = 'tlr-spacer';

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'tlr-btn';
    refreshBtn.type = 'button';
    refreshBtn.dataset.action = 'refresh';
    refreshBtn.title = 'Refresh';
    refreshBtn.textContent = 'Refresh';

    header.appendChild(toggleBtn);
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(spacer);
    header.appendChild(refreshBtn);

    const body = document.createElement('div');
    body.className = 'tlr-body';
    body.dataset.role = 'body';

    root.appendChild(header);
    root.appendChild(body);

    root.addEventListener('click', (e) => this.handleFooterClick(e));

    this.applyCollapsedState(root, this._collapsed);
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

    if (action === 'toggle') {
      this._collapsed = !this._collapsed;
      this.saveCollapsedSetting(this._collapsed);
      for (const s of this._panelStates.values()) {
        if (!s?.rootEl) continue;
        this.applyCollapsedState(s.rootEl, this._collapsed);
        const btn = s.rootEl.querySelector?.('[data-action="toggle"]') || null;
        if (btn) btn.textContent = this._collapsed ? '+' : '-';
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
      actionEl.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
      return;
    }

    const state = this._panelStates.get(panelId) || null;
    const panel = state?.panel || null;
    if (!panel) return;

    if (action === 'refresh') {
      if (state?.isLoading) return;
      this.scheduleRefreshForPanel(panel, { force: true, reason: 'button' });
      return;
    }

    if (action === 'open-record') {
      const guid = actionEl.dataset.recordGuid || null;
      if (!guid) return;
      this.openRecord(panel, guid, null, e);
      return;
    }

    if (action === 'open-line') {
      const guid = actionEl.dataset.recordGuid || null;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!guid) return;
      this.openRecord(panel, guid, lineGuid || null, e);
      return;
    }

    if (action === 'open-ref') {
      const guid = actionEl.dataset.refGuid || null;
      if (!guid) return;
      this.openRecord(panel, guid, null, e);
      return;
    }
  }

  openRecord(panel, recordGuid, subId, e) {
    const workspaceGuid = this.getWorkspaceGuid?.() || null;
    if (!workspaceGuid) return;

    const openInNew = e?.metaKey || e?.ctrlKey;

    if (openInNew) {
      this.ui
        .createPanel({ afterPanel: panel })
        .then((newPanel) => {
          if (!newPanel) return;
          newPanel.navigateTo({
            type: 'edit_panel',
            rootId: recordGuid,
            subId: subId || null,
            workspaceGuid
          });
          this.ui.setActivePanel(newPanel);
        })
        .catch(() => {
          // ignore
        });
      return;
    }

    panel.navigateTo({
      type: 'edit_panel',
      rootId: recordGuid,
      subId: subId || null,
      workspaceGuid
    });
    this.ui.setActivePanel(panel);
  }

  applyCollapsedState(root, collapsed) {
    if (!root) return;
    root.classList.toggle('tlr-collapsed', collapsed === true);
  }

  loadCollapsedSetting() {
    try {
      const v = localStorage.getItem(this._storageKeyCollapsed);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {
      // ignore
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeyCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyCollapsed) {
        const v = localStorage.getItem(legacyKey);
        if (v === '1' || v === '0') {
          try {
            localStorage.setItem(this._storageKeyCollapsed, v);
          } catch (e) {
            // ignore
          }
          return v === '1';
        }
      }
    } catch (e) {
      // ignore
    }

    const cfg = this.getConfiguration?.() || {};
    return cfg.custom?.collapsedByDefault === true;
  }

  saveCollapsedSetting(collapsed) {
    try {
      localStorage.setItem(this._storageKeyCollapsed, collapsed ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }

  loadPropGroupCollapsedSetting() {
    const parse = (v) => {
      if (typeof v !== 'string' || !v.trim()) return null;
      try {
        const parsed = JSON.parse(v);
        if (!Array.isArray(parsed)) return null;

        const out = new Set();
        for (const x of parsed) {
          if (typeof x !== 'string') continue;
          const t = x.trim();
          if (t) out.add(t);
        }
        return out;
      } catch (e) {
        // ignore
      }
      return null;
    };

    try {
      const v = localStorage.getItem(this._storageKeyPropGroupCollapsed);
      const set = parse(v);
      if (set) return set;
    } catch (e) {
      // ignore
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeyPropGroupCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyPropGroupCollapsed) {
        const v = localStorage.getItem(legacyKey);
        const set = parse(v);
        if (set) {
          try {
            localStorage.setItem(this._storageKeyPropGroupCollapsed, JSON.stringify(Array.from(set)));
          } catch (e) {
            // ignore
          }
          return set;
        }
      }
    } catch (e) {
      // ignore
    }

    return new Set();
  }

  savePropGroupCollapsedSetting() {
    try {
      const arr = Array.from(this._propGroupCollapsed || []);
      localStorage.setItem(this._storageKeyPropGroupCollapsed, JSON.stringify(arr));
    } catch (e) {
      // ignore
    }
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
    if (collapsed === true) this._propGroupCollapsed.add(name);
    else this._propGroupCollapsed.delete(name);
    this.savePropGroupCollapsedSetting();
  }

  // ---------- Refresh orchestration ----------

  scheduleRefreshForPanel(panel, { force, reason }) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    const state = this._panelStates.get(panelId) || null;
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    const delay = force ? 0 : this._refreshDebounceMs;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      this.refreshPanel(panelId, { reason: reason || 'scheduled' }).catch(() => {
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

  async refreshPanel(panelId, { reason }) {
    const state = this._panelStates.get(panelId) || null;
    const panel = state?.panel || null;
    if (!state || !panel) return;

    const record = panel.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;
    if (!recordGuid) return;

    // Keep state in sync in case of churn.
    state.recordGuid = recordGuid;

    if (!state.rootEl || !state.rootEl.isConnected) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;

    const seq = (state.refreshSeq || 0) + 1;
    state.refreshSeq = seq;

    this.setLoadingState(state, true);

    const cfg = this.getConfiguration?.() || {};
    const maxResults = this.coercePositiveInt(cfg.custom?.maxResults, this._defaultMaxResults);
    const showSelf = cfg.custom?.showSelf === true;

    const query = `@linkto = "${recordGuid}"`;
    const [searchSettled, propSettled] = await Promise.allSettled([
      this.data.searchByQuery(query, maxResults),
      this.getPropertyBacklinkGroups(record, recordGuid, { showSelf })
    ]);

    // Ignore stale refreshes.
    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    let linkedError = '';
    let linkedGroups = [];
    if (searchSettled.status === 'fulfilled') {
      const result = searchSettled.value;
      if (result?.error) {
        linkedError = result.error;
      } else {
        const lines = Array.isArray(result?.lines) ? result.lines : [];
        linkedGroups = this.groupBacklinkLines(lines, recordGuid, { showSelf });
      }
    } else {
      linkedError = 'Error loading linked references.';
    }

    let propertyError = '';
    let propertyGroups = [];
    if (propSettled.status === 'fulfilled') {
      propertyGroups = Array.isArray(propSettled.value) ? propSettled.value : [];
    } else {
      propertyError = 'Error loading property references.';
    }

    this.renderReferences(state, {
      propertyGroups,
      propertyError,
      linkedGroups,
      linkedError,
      maxResults
    });
    this.setLoadingState(state, false);
  }

  setLoadingState(state, isLoading) {
    if (!state?.rootEl) return;
    state.isLoading = isLoading === true;
    state.rootEl.classList.toggle('tlr-loading', isLoading === true);
  }

  // ---------- Event-driven freshness ----------

  handleRecordUpdated(ev) {
    // Property-based references (record-link fields) do not emit lineitem events.
    // Refresh footers when key-value properties change so property backlinks stay fresh.
    if (!ev) return;
    if (!ev.properties) return;
    this.refreshAllPanels({ force: false, reason: 'record.updated' });
  }

  handleLineItemUpdated(ev) {
    if (!ev?.hasSegments?.() || typeof ev.getSegments !== 'function') return;

    const segments = ev.getSegments() || [];
    const referenced = this.extractReferencedRecordGuids(segments);
    if (referenced.size === 0) return;

    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel) continue;
      if (!state.recordGuid) continue;
      if (!referenced.has(state.recordGuid)) continue;
      this.scheduleRefreshForPanel(panel, { force: false, reason: 'lineitem.updated' });
    }
  }

  handleLineItemDeleted() {
    // We don't know which record(s) were referenced by the deleted item.
    // This is rare, so we just refresh all visible footers (debounced).
    this.refreshAllPanels({ force: false, reason: 'lineitem.deleted' });
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

  async getPropertyBacklinkGroups(_targetRecord, targetGuid, { showSelf }) {
    if (!targetGuid) return [];

    // NOTE: Thymer's built-in backlinks/backrefs do not include record-link properties,
    // so we scan all records' properties to find record-link fields pointing at targetGuid.
    const allRecords = this.data.getAllRecords?.() || [];
    const byProp = new Map();

    for (const src of allRecords || []) {
      const srcGuid = src?.guid || null;
      if (!srcGuid) continue;
      if (!showSelf && srcGuid === targetGuid) continue;

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
    return false;
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

    // Most record-link properties currently expose their referenced record GUID via .text().
    // We also look at .choice() as a fallback for older/quirky configs.
    let raw = [];
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

    for (const r of raw) {
      for (const v of this.expandPossibleListString(r)) {
        push(v);
      }
    }

    return out;
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

  renderError(state, message) {
    if (!state?.bodyEl || !state?.countEl) return;
    state.countEl.textContent = '';
    state.bodyEl.innerHTML = '';

    const el = document.createElement('div');
    el.className = 'tlr-error';
    el.textContent = message || 'Error loading references.';
    state.bodyEl.appendChild(el);
  }

  renderReferences(state, { propertyGroups, propertyError, linkedGroups, linkedError, maxResults }) {
    if (!state?.bodyEl || !state?.countEl) return;

    const body = state.bodyEl;
    body.innerHTML = '';

    const props = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linked = Array.isArray(linkedGroups) ? linkedGroups : [];

    const propRefCount = props.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const linkedRefCount = linked.reduce((n, g) => n + (g?.lines?.length || 0), 0);

    const uniquePages = new Set();
    for (const g of props) {
      for (const r of g?.records || []) {
        const guid = r?.guid || null;
        if (guid) uniquePages.add(guid);
      }
    }
    for (const g of linked) {
      const guid = g?.record?.guid || null;
      if (guid) uniquePages.add(guid);
    }

    const parts = [];
    if (uniquePages.size > 0) parts.push(`${uniquePages.size} page${uniquePages.size === 1 ? '' : 's'}`);
    if (propRefCount > 0) parts.push(`${propRefCount} prop ref${propRefCount === 1 ? '' : 's'}`);
    if (linkedRefCount > 0) parts.push(`${linkedRefCount} line ref${linkedRefCount === 1 ? '' : 's'}`);
    state.countEl.textContent = parts.join(' | ');

    this.appendSectionTitle(body, 'Property References');
    if (propertyError) {
      this.appendError(body, propertyError);
    } else if (props.length === 0) {
      this.appendEmpty(body, 'No property references.');
    } else {
      this.appendPropertyReferenceGroups(body, props);
    }

    const divider = document.createElement('div');
    divider.className = 'tlr-divider';
    body.appendChild(divider);
    this.appendSectionTitle(body, 'Linked References');

    if (linkedError) {
      this.appendError(body, linkedError);
      return;
    }

    this.appendLinkedReferenceGroups(body, linked, { maxResults });
  }

  appendSectionTitle(container, text) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-section-title';
    el.textContent = text || '';
    container.appendChild(el);
  }

  appendError(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-error';
    el.textContent = message || 'Error loading references.';
    container.appendChild(el);
  }

  appendEmpty(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-empty';
    el.textContent = message || '';
    container.appendChild(el);
  }

  appendPropertyReferenceGroups(container, groups) {
    if (!container) return;

    for (const g of groups || []) {
      const propName = (g?.propertyName || '').trim();
      if (!propName) continue;

      const isCollapsed = this.isPropGroupCollapsed(propName);

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-prop-group';

      if (isCollapsed) groupEl.classList.add('tlr-prop-collapsed');

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-prop-header';
      header.dataset.action = 'toggle-prop-group';
      header.dataset.propName = propName;
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      const caret = document.createElement('span');
      caret.className = 'tlr-prop-caret';
      caret.setAttribute('aria-hidden', 'true');

      const title = document.createElement('div');
      title.className = 'tlr-prop-title';
      title.textContent = `${propName} in...`;

      const meta = document.createElement('div');
      meta.className = 'tlr-prop-meta';
      meta.textContent = `${g?.records?.length || 0}`;

      header.appendChild(caret);
      header.appendChild(title);
      header.appendChild(meta);

      const recsEl = document.createElement('div');
      recsEl.className = 'tlr-prop-records';

      for (const r of g?.records || []) {
        const guid = r?.guid || null;
        if (!guid) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tlr-prop-record';
        btn.dataset.action = 'open-record';
        btn.dataset.recordGuid = guid;
        btn.textContent = r.getName?.() || 'Untitled';
        recsEl.appendChild(btn);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(recsEl);
      container.appendChild(groupEl);
    }
  }

  appendLinkedReferenceGroups(container, groups, { maxResults }) {
    if (!container) return;

    const pageCount = groups.length;
    const refCount = groups.reduce((n, g) => n + (g?.lines?.length || 0), 0);

    if (pageCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'tlr-empty';
      empty.textContent = 'No linked references.';
      container.appendChild(empty);
      return;
    }

    for (const g of groups) {
      const record = g.record || null;
      const recordGuid = record?.guid || null;
      if (!recordGuid) continue;

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-group-header';
      header.dataset.action = 'open-record';
      header.dataset.recordGuid = recordGuid;

      const title = document.createElement('div');
      title.className = 'tlr-group-title';
      title.textContent = record.getName?.() || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'tlr-group-meta';
      meta.textContent = `${g.lines.length}`;

      header.appendChild(title);
      header.appendChild(meta);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of g.lines || []) {
        const lineEl = document.createElement('button');
        lineEl.type = 'button';
        lineEl.className = 'tlr-line';
        lineEl.dataset.action = 'open-line';
        lineEl.dataset.recordGuid = recordGuid;
        lineEl.dataset.lineGuid = line.guid;

        const prefix = this.getLinePrefix(line);
        if (prefix) {
          const p = document.createElement('span');
          p.className = 'tlr-prefix';
          p.textContent = prefix;
          lineEl.appendChild(p);
        }

        const content = document.createElement('span');
        content.className = 'tlr-line-content';
        this.appendSegments(content, line.segments || []);
        lineEl.appendChild(content);

        linesEl.appendChild(lineEl);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(linesEl);
      container.appendChild(groupEl);
    }

    if (refCount >= maxResults) {
      const note = document.createElement('div');
      note.className = 'tlr-note';
      note.textContent = `Showing first ${maxResults} matches.`;
      container.appendChild(note);
    }
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

  appendSegments(container, segments) {
    if (!container) return;
    if (!Array.isArray(segments) || segments.length === 0) {
      container.textContent = '';
      return;
    }

    for (const seg of segments) {
      if (!seg) continue;

      if (seg.type === 'text') {
        container.appendChild(document.createTextNode(typeof seg.text === 'string' ? seg.text : ''));
        continue;
      }

      if (seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code') {
        const el = document.createElement('span');
        el.className = seg.type === 'bold' ? 'tlr-seg-bold' : seg.type === 'italic' ? 'tlr-seg-italic' : 'tlr-seg-code';
        el.textContent = typeof seg.text === 'string' ? seg.text : '';
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'link') {
        const url = typeof seg.text === 'string' ? seg.text : '';
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = url;
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'linkobj') {
        const link = seg.text?.link || '';
        const title = seg.text?.title || link;
        if (!link) continue;
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = title;
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'hashtag') {
        const t = typeof seg.text === 'string' ? seg.text : '';
        if (!t) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-hashtag';
        el.textContent = t.startsWith('#') ? t : `#${t}`;
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'datetime') {
        const el = document.createElement('span');
        el.className = 'tlr-seg-datetime';
        el.textContent = this.formatDateTimeSegment(seg.text);
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'mention') {
        const el = document.createElement('span');
        el.className = 'tlr-seg-mention';
        const guid = typeof seg.text === 'string' ? seg.text : '';
        el.textContent = this.formatMention(guid);
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'ref') {
        const guid = seg.text?.guid || null;
        if (!guid) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-ref';
        el.dataset.action = 'open-ref';
        el.dataset.refGuid = guid;

        const title = seg.text?.title || this.resolveRecordName(guid) || '[link]';
        el.textContent = title;
        container.appendChild(el);
        continue;
      }

      // Fallback: render as plain text when possible.
      if (typeof seg.text === 'string' && seg.text) {
        container.appendChild(document.createTextNode(seg.text));
      }
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

  formatDateTimeSegment(v) {
    if (typeof v === 'string') return v;
    const d = v?.d || null;
    if (typeof d !== 'string' || d.length !== 8) return '';
    // d = YYYYMMDD
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }

  coercePositiveInt(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i <= 0) return fallback;
    return i;
  }

  // ---------- CSS ----------

  injectCss() {
    this.ui.injectCSS(`
      .tlr-footer {
        margin-top: 24px;
        padding-top: 14px;
        border-top: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        color: var(--text, inherit);
        font-size: 13px;
      }

      .tlr-header {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 10px;
      }

      .tlr-title {
        font-weight: 600;
      }

      .tlr-count {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
      }

      .tlr-spacer { flex: 1; }

      .tlr-btn {
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-panel, transparent);
        color: var(--text, inherit);
        padding: 4px 8px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
      }

      .tlr-btn:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .tlr-toggle {
        width: 26px;
        padding: 4px 0;
        text-align: center;
        font-weight: 700;
      }

      .tlr-body { display: block; }

      .tlr-collapsed .tlr-body { display: none; }

      .tlr-empty,
      .tlr-note,
      .tlr-error {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        padding: 8px 0;
      }

      .tlr-section-title {
        margin-top: 12px;
        margin-bottom: 6px;
        font-size: 11px;
        font-weight: 700;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .tlr-divider {
        margin: 12px 0 8px;
        border-top: 2px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
      }

      .tlr-prop-group { margin: 10px 0 14px; }

      .tlr-prop-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        width: 100%;
        padding: 6px 8px;
        border-radius: 10px;
        border: 2px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-panel, transparent);
        cursor: pointer;
        text-align: left;
      }

      .tlr-prop-header:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .tlr-prop-caret {
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid var(--text-muted, rgba(0, 0, 0, 0.6));
        opacity: 0.85;
        transform: rotate(90deg);
        transition: transform 140ms ease;
        flex: 0 0 auto;
      }

      .tlr-prop-collapsed .tlr-prop-caret {
        transform: rotate(0deg);
      }

      .tlr-prop-collapsed .tlr-prop-records {
        display: none;
      }

      .tlr-prop-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-prop-meta {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-prop-records { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }

      .tlr-prop-record {
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        padding: 6px 8px;
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
      }

      .tlr-prop-record:hover {
        border-color: var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
        color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit)))));
        text-decoration: underline;
      }

      .tlr-group { margin: 10px 0 14px; }

      .tlr-group-header {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 6px 8px;
        border-radius: 10px;
        border: 2px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-panel, transparent);
        cursor: pointer;
        text-align: left;
      }

      .tlr-group-header:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .tlr-group-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tlr-group-meta {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
        flex: 0 0 auto;
      }

      .tlr-lines { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }

      .tlr-line {
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        padding: 6px 8px;
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
        color: var(--text, inherit);
      }

      .tlr-line:hover {
        border-color: var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .tlr-prefix {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-line-content {
        white-space: pre-wrap;
        word-break: break-word;
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
      .tlr-seg-hashtag { color: var(--accent, #2b6cb0); }
      .tlr-seg-datetime { color: var(--accent, #2b6cb0); }
      .tlr-seg-mention { color: var(--accent, #2b6cb0); }
      .tlr-seg-ref { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); cursor: pointer; text-decoration: underline; }
      .tlr-seg-ref:hover { color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit))))); }

      .tlr-loading .tlr-btn[data-action="refresh"] { opacity: 0.6; cursor: default; }
    `);
  }
}
