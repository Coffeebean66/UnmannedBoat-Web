/* 船队地图只展示仍有效的实时定位，原始坐标继续使用 WGS84。 */
(function (scope) {
  'use strict';

  const DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
  const COLOR_SATURATION = 76;
  const COLOR_LIGHTNESS = 55;

  function deviceColor(id) {
    let hash = 2166136261;
    for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
    const hue = (hash >>> 0) % 360;
    return `hsl(${hue} ${COLOR_SATURATION}% ${COLOR_LIGHTNESS}%)`;
  }

  function freshLocations(state, now) {
    if (state.authenticated !== true || state.enabled === false ||
        state.brokerConnected !== true || state.streamConnected !== true) return [];
    const devices = Array.isArray(state.devices) ? state.devices.slice(0, 64) : [];
    const seen = new Set();
    return devices.flatMap(device => {
      if (!device || typeof device.id !== 'string' || !DEVICE_ID.test(device.id) || device.online !== true) return [];
      if (seen.has(device.id)) return [];
      seen.add(device.id);
      const summary = device.summary;
      if (!summary || !Number.isFinite(summary.receivedAt) ||
          now - summary.receivedAt < -1000 || now - summary.receivedAt >= 1000 ||
          !Number.isFinite(summary.validUntil?.position) || summary.validUntil.position <= now ||
          !Number.isFinite(summary.latitude) || !Number.isFinite(summary.longitude) ||
          Math.abs(summary.latitude) > 90 || Math.abs(summary.longitude) > 180) return [];
      return [{ id: device.id, latitude: summary.latitude, longitude: summary.longitude }];
    });
  }

  class BoatFleetMapView {
    constructor({ document = scope.document, mapView = null, now = Date.now, onSelect = () => {},
      setInterval = scope.setInterval.bind(scope), clearInterval = scope.clearInterval.bind(scope) } = {}) {
      this.document = document;
      this.now = now;
      this.onSelect = onSelect;
      this.clearInterval = clearInterval;
      this.nodes = Object.fromEntries(['fleetMap', 'fleetMapStatus', 'fleetMapLegend', 'fleetMapFit', 'fleetMapFullscreen']
        .map(id => [id, document?.getElementById(id)]));
      this.map = mapView;
      this.markers = new Map();
      this.markerPositions = new Map();
      this.locations = [];
      this.state = { devices: [], authenticated: false, enabled: true, brokerConnected: false,
        streamConnected: false, serverOffset: 0 };
      this.theme = document?.documentElement?.dataset?.theme || 'dark';
      this.mapReady = false;
      this.initialized = false;
      this.initialFitDone = false;
      this.fullscreenActive = false;
      this.destroyed = false;
      this.mapStatus = null;
      this.visible = scope.BoatWorkspace ? scope.BoatWorkspace.current === 'fleet'
        : !document?.getElementById('view-fleet')?.hidden;

      this.onViewChange = event => this._onViewChange(event.detail?.view);
      this.onThemeChange = () => this.setTheme(document?.documentElement?.dataset?.theme || 'dark');
      this.onReady = () => this._onMapReady();
      this.onMapStatus = status => this._onMapStatus(status);
      this.onFit = () => this.fitLocations();
      this.onFullscreen = () => this.toggleFullscreen();
      this.onFullscreenChange = () => this._onFullscreenChange();
      scope.addEventListener?.('boat-view-change', this.onViewChange);
      scope.addEventListener?.('boat-theme-change', this.onThemeChange);
      document?.addEventListener?.('fullscreenchange', this.onFullscreenChange);
      this.nodes.fleetMapFit?.addEventListener('click', this.onFit);
      this.nodes.fleetMapFullscreen?.addEventListener('click', this.onFullscreen);
      this._updateFullscreenButton(false);
      this.timer = setInterval(() => { if (this.visible && !this.document?.hidden) this.render(); }, 500);
      if (this.visible) this._initialize();
    }

    _onViewChange(view) {
      const entering = view === 'fleet';
      if (!entering) { this.visible = false; return; }
      const returning = !this.visible;
      this.visible = true;
      if (!this.initialized) this._initialize();
      else if (returning && this.mapReady) {
        this.map?.invalidateSize?.({ animate: false });
        this.render();
      }
    }

    _initialize() {
      if (this.destroyed || this.initialized) return;
      const container = this.nodes.fleetMap;
      if (!container) { this._setStatus('船队地图容器不可用'); return; }
      if (!this.map) {
        if (typeof scope.BoatMapView !== 'function') { this._setStatus('地图组件尚未加载'); return; }
        this.map = new scope.BoatMapView(container);
      }
      this.initialized = true;
      this.map.on?.('ready', this.onReady);
      this.map.on?.('status', this.onMapStatus);
      this._setStatus('正在加载船队地图');
      let initialization;
      try { initialization = this.map.initialize?.(); }
      catch (error) {
        this._setStatus('船队地图加载失败：' + (error?.message || '未知错误'));
        return;
      }
      Promise.resolve(initialization).then(() => {
        if (this.destroyed) return;
        if (this.map?.ready === true) this._onMapReady();
        else if (this.map?.status?.message) this._onMapStatus(this.map.status);
      }, error => {
        if (!this.destroyed) this._setStatus('船队地图加载失败：' + (error?.message || '未知错误'));
      });
    }

    _onMapReady() {
      if (this.destroyed || !this.map) return;
      if (this.mapReady) { this.render(); return; }
      this.mapReady = true;
      this.map.setTheme?.(this.theme);
      this.map.invalidateSize?.({ animate: false });
      this.render();
    }

    _onMapStatus(status) {
      this.mapStatus = status || null;
      if (status?.tone === 'error' || (status?.tone === 'warning' && this.map?.ready !== true)) {
        this._setStatus(status.message || '船队地图暂不可用');
      } else if (this.map?.ready === true) this.render();
    }

    _setStatus(text) {
      const node = this.nodes.fleetMapStatus;
      if (node && node.textContent !== text) node.textContent = text;
    }

    update(state) {
      if (this.destroyed || !state || typeof state !== 'object') return;
      this.state = { ...this.state, ...state };
      if (this.state.authenticated === false) this.state.devices = [];
      if (this.visible && !this.initialized) this._initialize();
      if (this.mapReady) this.render();
      else this._renderLegend(this._currentLocations());
    }

    _currentLocations() {
      const offset = Number.isFinite(this.state.serverOffset) ? this.state.serverOffset : 0;
      return freshLocations(this.state, this.now() + offset);
    }

    _renderLegend(locations) {
      const legend = this.nodes.fleetMapLegend;
      if (!legend) return;
      legend.replaceChildren?.();
      if (!legend.replaceChildren) while (legend.firstChild) legend.removeChild(legend.firstChild);
      const current = new Set(locations.map(location => location.id));
      const seen = new Set();
      const devices = (Array.isArray(this.state.devices) ? this.state.devices : [])
        .filter(device => {
          if (!device || typeof device.id !== 'string' || !DEVICE_ID.test(device.id) || seen.has(device.id)) return false;
          seen.add(device.id);
          return true;
        }).slice(0, 64)
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const device of devices) {
        const item = this.document.createElement('span');
        item.className = 'fleet-map-legend-item';
        const online = this.state.authenticated === true && this.state.enabled !== false &&
          this.state.brokerConnected === true && this.state.streamConnected === true && device.online === true;
        item.dataset.online = String(online);
        item.dataset.located = String(current.has(device.id));
        const dot = this.document.createElement('span');
        dot.className = 'fleet-map-legend-swatch';
        dot.style.setProperty('--vessel-color', deviceColor(device.id));
        const label = this.document.createElement('span');
        label.className = 'fleet-map-legend-label';
        label.textContent = device.id + (current.has(device.id) ? ' · 定位有效' : ' · 暂无有效定位');
        item.append(dot, label);
        legend.append(item);
      }
    }

    _renderStatus(locations) {
      if (!this.mapReady) {
        this._setStatus(this.mapStatus?.message || '正在加载船队地图');
        return;
      }
      if (this.state.authenticated !== true) { this._setStatus('登录后查看船队定位'); return; }
      if (this.state.enabled === false) { this._setStatus('服务器尚未启用 MQTT 监测'); return; }
      if (this.state.streamConnected !== true) { this._setStatus('船队数据通道已断开，位置标记已清除'); return; }
      if (this.state.brokerConnected !== true) { this._setStatus('服务器与 MQTT 已断开，位置标记已清除'); return; }
      if (locations.length) { this._setStatus('当前有 ' + locations.length + ' 艘船定位有效'); return; }
      if (!(Array.isArray(this.state.devices) && this.state.devices.length)) {
        this._setStatus('暂无已接入无人船'); return;
      }
      this._setStatus('暂无有效定位，历史坐标已隐藏');
    }

    render() {
      if (this.destroyed || !this.mapReady) return;
      const locations = this._currentLocations();
      const active = new Set(locations.map(location => location.id));
      for (const location of locations) {
        const previous = this.markerPositions.get(location.id);
        const changed = !previous || previous.latitude !== location.latitude || previous.longitude !== location.longitude;
        if (this.markers.has(location.id)) {
          if (changed) this.markers.get(location.id).setPosition({ latitude: location.latitude, longitude: location.longitude });
        } else {
          const color = deviceColor(location.id);
          const html = '<span class="fleet-map-pin" style="--vessel-color:' + color + '" role="button" aria-label="查看 ' + location.id + ' 的详情" title="' + location.id + '"><span class="fleet-map-pin-label">' + location.id + '</span></span>';
          const marker = this.map.createMarker?.(location, { className: 'fleet-map-pin-shell', html,
            iconSize: [140, 28], iconAnchor: [70, 14], title: location.id, interactive: true,
            onClick: () => this.onSelect(location.id), zIndexOffset: 30 });
          if (marker) this.markers.set(location.id, marker);
        }
        if (this.markers.has(location.id)) this.markerPositions.set(location.id,
          { latitude: location.latitude, longitude: location.longitude });
      }
      for (const [id, marker] of this.markers) {
        if (active.has(id)) continue;
        marker.remove?.();
        this.markers.delete(id);
        this.markerPositions.delete(id);
      }
      this.locations = locations;
      this._renderLegend(locations);
      this._renderStatus(locations);
      if (locations.length && !this.initialFitDone) {
        this.initialFitDone = this.map.fitLocations?.(locations, { maxZoom: 16, singleZoom: 15, animate: false }) === true;
      }
    }

    fitLocations() {
      if (this.destroyed || !this.mapReady) return false;
      const locations = this._currentLocations();
      if (!locations.length) {
        this.locations = [];
        this.render();
        return false;
      }
      const fitted = this.map.fitLocations?.(locations, { maxZoom: 16, singleZoom: 15, animate: false }) === true;
      if (fitted) this.initialFitDone = true;
      return fitted;
    }

    setTheme(theme) {
      this.theme = theme === 'light' ? 'light' : 'dark';
      this.map?.setTheme?.(this.theme);
    }

    async toggleFullscreen() {
      if (this.destroyed) return false;
      const target = this._fullscreenTarget();
      if (!target) return false;
      try {
        if (this.document?.fullscreenElement === target) {
          if (typeof this.document.exitFullscreen !== 'function') return false;
          await this.document.exitFullscreen();
        } else {
          if (typeof target.requestFullscreen !== 'function') return false;
          await target.requestFullscreen();
        }
        this._onFullscreenChange();
        return true;
      } catch (_) {
        this._setStatus('无法切换地图全屏');
        return false;
      }
    }

    _fullscreenTarget() {
      return this.nodes.fleetMap?.closest?.('.fleet-map-panel') ||
        this.nodes.fleetMap?.closest?.('.fleet-map-frame') || this.nodes.fleetMap;
    }

    _updateFullscreenButton(active) {
      const button = this.nodes.fleetMapFullscreen;
      if (!button) return;
      const label = active ? '退出地图全屏' : '进入地图全屏';
      button.setAttribute('aria-label', label);
      button.setAttribute('title', label);
      button.setAttribute('aria-pressed', String(active));
    }

    _onFullscreenChange() {
      if (this.destroyed) return;
      const target = this._fullscreenTarget(), container = this.nodes.fleetMap;
      const active = !!target && this.document?.fullscreenElement === target;
      if (target?.classList) target.classList.toggle('is-fullscreen', active);
      this._updateFullscreenButton(active);
      if (active === this.fullscreenActive) return;
      this.fullscreenActive = active;
      if (active && container?.style) {
        if (!this.fullscreenStyle) this.fullscreenStyle = { height: container.style.height || '', minHeight: container.style.minHeight || '' };
        container.style.height = 'min(88vh, 960px)';
        container.style.minHeight = '320px';
      } else if (this.fullscreenStyle && container?.style) {
        container.style.height = this.fullscreenStyle.height;
        container.style.minHeight = this.fullscreenStyle.minHeight;
        this.fullscreenStyle = null;
      }
      const resize = () => {
        this._fullscreenFrame = null;
        if (this.destroyed) return;
        this.map?.invalidateSize?.({ animate: false });
        this.render();
      };
      if (typeof scope.requestAnimationFrame === 'function') this._fullscreenFrame = scope.requestAnimationFrame(resize);
      else Promise.resolve().then(resize);
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.clearInterval(this.timer);
      scope.removeEventListener?.('boat-view-change', this.onViewChange);
      scope.removeEventListener?.('boat-theme-change', this.onThemeChange);
      this.document?.removeEventListener?.('fullscreenchange', this.onFullscreenChange);
      this.nodes.fleetMapFit?.removeEventListener('click', this.onFit);
      this.nodes.fleetMapFullscreen?.removeEventListener('click', this.onFullscreen);
      if (this._fullscreenFrame !== null && this._fullscreenFrame !== undefined) scope.cancelAnimationFrame?.(this._fullscreenFrame);
      if (this.fullscreenStyle && this.nodes.fleetMap?.style) {
        this.nodes.fleetMap.style.height = this.fullscreenStyle.height;
        this.nodes.fleetMap.style.minHeight = this.fullscreenStyle.minHeight;
        this._fullscreenTarget()?.classList?.remove('is-fullscreen');
        this.fullscreenStyle = null;
      }
      this.map?.off?.('ready', this.onReady);
      this.map?.off?.('status', this.onMapStatus);
      for (const marker of this.markers.values()) marker.remove?.();
      this.markers.clear();
      this.markerPositions.clear();
      this.locations = [];
      this.map?.destroy?.();
      this.mapReady = false;
    }
  }

  BoatFleetMapView.deviceColor = deviceColor;
  BoatFleetMapView.freshLocations = freshLocations;
  scope.BoatFleetMapView = BoatFleetMapView;
  if (typeof module === 'object' && module.exports) module.exports = { BoatFleetMapView, deviceColor, freshLocations };
})(typeof window === 'object' ? window : globalThis);
