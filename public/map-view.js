/* 地图提供方适配：所有公开接口均接收 RTK 原始 WGS84，地图内部只转换一次。 */
(function (scope) {
  'use strict';

  const SDK_TIMEOUT_MS = 15000;
  const MAP_READY_TIMEOUT_MS = 15000;
  const CONFIG_TIMEOUT_MS = 5000;
  const PROVIDER_PREFERENCE = 'boat.map.provider';
  const POLICY_WARNING = '高德地图资源被 CSP 安全策略拦截，底图可能不完整；可切换至 OSM';
  let callbackSequence = 0;

  function fix(value) {
    const latitude = Array.isArray(value) ? value[0] : value?.latitude ?? value?.lat;
    const longitude = Array.isArray(value) ? value[1] : value?.longitude ?? value?.lng;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
        Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return { latitude, longitude };
  }

  class BoatMapView {
    constructor(containerId = 'map') {
      this.container = typeof containerId === 'string' ? scope.document.getElementById(containerId) : containerId;
      this.ready = false;
      this.switching = false;
      this.provider = 'osm';
      this.status = { message: '正在准备地图', tone: 'loading' };
      this.map = null;
      this.lastTrackLines = [];
      this._events = new Map();
      this._markers = new Set();
      this._trackLayers = [];
      this._mapEvents = [];
      this._destroyed = false;
      this._amapPolicyBlocked = false;
      this._policyViolation = event => {
        if (this._destroyed || this.provider !== 'amap' || !this.map) return;
        const related = [event.sourceFile, event.blockedURI].some(uri =>
          /^https:\/\/(?:[\w-]+\.)*(?:amap\.com|autonavi\.com)(?:[/:]|$)/i.test(uri || ''));
        if (!related) return;
        this._amapPolicyBlocked = true;
        this._setStatus(POLICY_WARNING, 'warning');
      };
      scope.document?.addEventListener?.('securitypolicyviolation', this._policyViolation);
      this._pageHide = () => this.destroy();
      scope.addEventListener?.('pagehide', this._pageHide, { once: true });
    }

    on(name, listener) {
      if (!this._events.has(name)) this._events.set(name, new Set());
      this._events.get(name).add(listener);
      return this;
    }

    off(name, listener) {
      this._events.get(name)?.delete(listener);
      return this;
    }

    _emit(name, value) {
      for (const listener of this._events.get(name) || []) listener(value);
    }

    _setStatus(message, tone = 'neutral') {
      this.status = { message, tone };
      this._emit('status', this.status);
    }

    _setSwitching(value) {
      this.switching = value;
      this._emit('switching', value);
    }

    _readPreference() {
      try { return scope.localStorage?.getItem(PROVIDER_PREFERENCE); } catch (_) { return null; }
    }

    _osmStatus() {
      return (this.config?.configured ? '' : '高德未配置 · ') + 'OpenStreetMap · WGS84';
    }

    _mapReadyStatus() {
      if (this.provider === 'amap' && this._amapPolicyBlocked) {
        this._setStatus(POLICY_WARNING, 'warning');
        return;
      }
      this._setStatus(this.provider === 'amap' ? '高德地图 · GCJ-02（RTK 原始 WGS84）' : this._osmStatus(),
        this.provider === 'amap' ? 'success' : 'neutral');
    }

    _requireAmap(config) {
      if (config.enabled !== true || config.configured !== true ||
          typeof config.key !== 'string' || !config.key.trim() ||
          typeof config.securityJsCode !== 'string' || !config.securityJsCode.trim()) {
        throw new Error('高德地图尚未配置，请管理员在“设置 → 平台地图设置”填写 Key 与安全密钥');
      }
    }

    initialize() {
      if (!this._initialization) this._initialization = this._initialize();
      return this._initialization;
    }

    async _initialize() {
      if (this._destroyed) return this;
      this._setSwitching(true);
      this._setStatus('正在读取地图配置', 'loading');
      try {
        if (!this.container) throw new Error('找不到地图容器');
        const config = await this._loadConfig();
        if (this._destroyed) return this;
        this.config = config;
        if (config.enabled === true && config.configured === true && this._readPreference() !== 'osm') {
          this.provider = 'amap';
          this._requireAmap(config);
          this._setStatus('正在加载高德地图', 'loading');
          await this._loadSdk(config);
          if (this._destroyed) return this;
          await this._createAmap();
          if (this._destroyed) return this;
          this.ready = true;
        } else {
          this.provider = 'osm';
          this.configurationReason = config.reason || '尚未填写高德 Key 与安全密钥';
          this._createOsm();
          this.ready = true;
        }
        this._mapReadyStatus();
        this._emit('ready', this);
      } catch (error) {
        if (!this._destroyed) {
          this._disposeMap();
          this._setStatus((this.provider === 'amap' ? '高德地图加载失败：' : '地图不可用：') +
            (error?.message || '未知错误') + '；RTK 原始经纬度仍可查看', 'error');
        }
      } finally { this._setSwitching(false); }
      return this;
    }

    async switchProvider(provider) {
      if (provider !== 'amap' && provider !== 'osm') throw new Error('不支持的地图类型');
      if (this._destroyed || this.switching) return false;
      if (this.ready && provider === this.provider) return true;
      this._setSwitching(true);
      const previous = this.provider;
      let viewport, tracks, rebuilding = false;
      try {
        // 高德鉴权及 SDK 在旧地图仍可用时准备，失败不会清空现有船位和轨迹。
        this._setStatus('正在切换至' + (provider === 'amap' ? '高德地图' : ' OpenStreetMap'), 'loading');
        if (provider === 'amap') {
          const config = await this._loadConfig();
          if (this._destroyed) return false;
          this._requireAmap(config);
          this.config = config;
          await this._loadSdk(config);
        }
        if (this._destroyed) return false;
        viewport = { center: this.getCenter(), zoom: this.getZoom() };
        tracks = this.lastTrackLines;
        rebuilding = true;
        this._disposeMap(true);
        this.provider = provider;
        await this._restoreMap(viewport, tracks);
        if (this._destroyed) return false;
        try { scope.localStorage?.setItem(PROVIDER_PREFERENCE, provider); } catch (_) {}
        this._mapReadyStatus();
        this._emit('providerchange', { provider });
        this._emit('resize');
        return true;
      } catch (error) {
        if (this._destroyed) return false;
        if (rebuilding) {
          this._disposeMap(true);
          this.provider = previous;
          try { await this._restoreMap(viewport, tracks); } catch (_) { this._disposeMap(true); }
          if (this._destroyed) return false;
        }
        this._setStatus('地图切换失败：' + (error?.message || '未知错误') +
          (this.ready ? '；继续使用' + (this.provider === 'amap' ? '高德地图' : ' OpenStreetMap') : ''),
          this.ready ? 'warning' : 'error');
        throw error;
      } finally { this._setSwitching(false); }
    }

    async _restoreMap(viewport, tracks) {
      if (this.provider === 'amap') await this._createAmap(); else this._createOsm();
      if (this._destroyed) return;
      this.ready = true;
      if (viewport.center) this.setView(viewport.center, Math.max(3, Math.min(this.provider === 'amap' ? 20 : 19, viewport.zoom)), { animate: false });
      for (const marker of this._markers) marker._mount();
      this.setTrackLines(tracks);
    }

    _loadConfig() {
      return new Promise((resolve, reject) => {
        let settled = false;
        const controller = scope.AbortController ? new scope.AbortController() : null;
        const finish = (error, config) => {
          if (settled) return;
          settled = true;
          scope.clearTimeout(timer);
          this._cancelConfig = null;
          if (error) reject(error); else resolve(config);
        };
        const timer = scope.setTimeout(() => {
          finish(new Error('地图配置请求超时'));
          controller?.abort();
        }, CONFIG_TIMEOUT_MS);
        this._cancelConfig = () => {
          finish(new Error('地图已关闭'));
          controller?.abort();
        };
        Promise.resolve().then(() => scope.fetch('/api/map/config', {
          credentials: 'same-origin', cache: 'no-store', ...(controller ? { signal: controller.signal } : {})
        })).then(response => {
          if (!response.ok) throw new Error('地图配置请求失败（HTTP ' + response.status + '）');
          return response.json();
        }).then(config => {
          if (!config || typeof config !== 'object') throw new Error('地图配置格式错误');
          finish(null, config);
        }).catch(error => finish(error));
      });
    }

    _loadSdk(config) {
      // 必须在 SDK 执行之前设置安全密钥；只使用高德官方 JS API，不拼接私有瓦片地址。
      scope._AMapSecurityConfig = { ...scope._AMapSecurityConfig, securityJsCode: config.securityJsCode };
      if (scope.AMap && typeof scope.AMap.Map === 'function') return Promise.resolve();
      return new Promise((resolve, reject) => {
        const callback = '__boatAmapReady' + (++callbackSequence) + '_' + Date.now();
        const script = scope.document.createElement('script');
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          scope.clearTimeout(timer);
          script.onerror = null;
          script.remove();
          delete scope[callback];
          this._cancelSdk = null;
          if (error) reject(error); else resolve();
        };
        const timer = scope.setTimeout(() => finish(new Error('SDK 加载超时，请检查网络或域名白名单')), SDK_TIMEOUT_MS);
        this._cancelSdk = () => finish(new Error('地图已关闭'));
        scope[callback] = () => finish(scope.AMap && typeof scope.AMap.Map === 'function' ? null : new Error('SDK 未就绪'));
        script.async = true;
        script.onerror = () => finish(new Error('SDK 请求失败，请检查网络、Key 和域名白名单'));
        script.src = 'https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(config.key) +
          '&callback=' + encodeURIComponent(callback);
        scope.document.head.appendChild(script);
      });
    }

    _bindMap(name, callback) {
      this.map.on(name, callback);
      this._mapEvents.push([name, callback]);
    }

    _createAmap() {
      this._amapPolicyBlocked = false;
      this._setStatus('正在加载高德底图', 'loading');
      const center = this.project({ latitude: 31.23, longitude: 121.47 });
      this.map = new scope.AMap.Map(this.container, {
        viewMode: '2D', zoom: 5, center: [center.longitude, center.latitude],
        rotation: 0, pitch: 0, rotateEnable: false, pitchEnable: false,
        showLabel: true, zooms: [3, 20]
      });
      this._bindMap('dragstart', event => this._emit('dragstart', event));
      this._bindMap('resize', event => this._emit('resize', event));
      const currentMap = this.map;
      // SDK 下载成功、构造函数返回都不代表底图已绘制；必须收到真实 complete。
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = error => {
          if (settled) return;
          settled = true;
          scope.clearTimeout(timer);
          this._cancelMapReady = null;
          if (error) reject(error); else resolve();
        };
        const timer = scope.setTimeout(() => finish(new Error('高德底图加载超时，请检查 Key、域名白名单、网络和 CSP 安全策略')), MAP_READY_TIMEOUT_MS);
        this._cancelMapReady = () => finish(new Error('地图已关闭'));
        this._bindMap('complete', () => {
          if (!this._destroyed && this.map === currentMap) finish();
        });
        this._bindMap('error', () => {
          if (this._destroyed || this.map !== currentMap) return;
          const message = '高德底图加载异常，请检查 Key、域名白名单、网络和 CSP 安全策略';
          if (!settled) finish(new Error(message));
          else this._setStatus(message + '；RTK 原始经纬度仍可查看', 'warning');
        });
        try {
          this.setTheme(scope.document.documentElement?.dataset.theme);
          this._createZoomControls();
        } catch (error) { finish(error); }
      });
    }

    _createZoomControls() {
      const controls = scope.document.createElement('div');
      controls.className = 'boat-map-zoom';
      for (const [text, label, delta] of [['+', '地图放大', 1], ['−', '地图缩小', -1]]) {
        const button = scope.document.createElement('button');
        button.type = 'button';
        button.textContent = text;
        button.setAttribute('aria-label', label);
        button.title = label;
        button.addEventListener('click', event => {
          event.stopPropagation();
          this.setZoom(Math.max(3, Math.min(20, this.getZoom() + delta)));
        });
        controls.appendChild(button);
      }
      for (const name of ['pointerdown', 'dblclick']) controls.addEventListener(name, event => event.stopPropagation());
      this.container.appendChild(controls);
      this._zoomControls = controls;
    }

    _createOsm() {
      if (!scope.L?.map) throw new Error('本地地图组件未加载');
      this.map = scope.L.map(this.container, { zoomControl: true }).setView([31.23, 121.47], 5);
      this._bindMap('dragstart', event => this._emit('dragstart', event));
      this._bindMap('resize', event => this._emit('resize', event));
      const currentMap = this.map;
      this._tiles = scope.L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>'
      });
      this._tiles.on('loading', () => { this._tileFailed = false; })
        .on('tileerror', () => {
          this._tileFailed = true;
          if (!this._destroyed && this.map === currentMap) this._setStatus((this.config?.configured ? '' : '高德未配置 · ') + 'OSM 底图网络不可用，坐标与轨迹仍有效', 'warning');
        }).on('load', () => {
          if (!this._destroyed && this.map === currentMap && !this._tileFailed) this._setStatus(this._osmStatus(), 'neutral');
        }).addTo(this.map);
    }

    project(value) {
      const raw = fix(value);
      if (!raw) return null;
      if (this.provider !== 'amap') return raw;
      const convert = scope.BoatModules?.mapCoordinates?.wgs84ToGcj02;
      if (typeof convert !== 'function') throw new Error('WGS84/GCJ-02 坐标转换组件未加载');
      return convert(raw.latitude, raw.longitude);
    }

    createMarker(value, options = {}) {
      const raw = fix(value);
      if (!this.ready || !raw) return null;
      const element = scope.document.createElement('div');
      element.className = options.className || '';
      element.innerHTML = options.html || '';
      const size = options.iconSize || [30, 30], anchor = options.iconAnchor || [15, 15];
      const view = this;
      let native, nativeProvider, attached = false, removed = false, opacity = 1;
      const wrapper = {
        native: null, position: raw, mapPosition: null,
        _mount() {
          if (removed || !view.ready) return;
          const point = this.mapPosition = view.project(this.position);
          nativeProvider = view.provider;
          if (nativeProvider === 'amap') {
            element.style.width = size[0] + 'px';
            element.style.height = size[1] + 'px';
            const x = anchor[0] ? -anchor[0] : 0, y = anchor[1] ? -anchor[1] : 0;
            const offset = scope.AMap.Pixel ? new scope.AMap.Pixel(x, y) : { x, y };
            native = new scope.AMap.Marker({
              position: [point.longitude, point.latitude], content: element, offset, anchor: 'top-left',
              zIndex: 120 + (options.zIndexOffset || 0), clickable: options.interactive !== false, bubble: true
            });
            this.native = native;
            native.setMap(view.map);
          } else {
            native = scope.L.marker([point.latitude, point.longitude], {
              icon: scope.L.divIcon({ className: options.className || '', html: element.innerHTML, iconSize: size, iconAnchor: anchor }),
              interactive: options.interactive !== false, keyboard: options.interactive !== false,
              zIndexOffset: options.zIndexOffset || 0
            });
            this.native = native;
            native.addTo(view.map);
          }
          attached = true;
          if (typeof native.setOpacity === 'function' && element.style.opacity) element.style.opacity = '';
          if (opacity !== 1) this.setOpacity(opacity);
        },
        _detach() {
          if (!native) return;
          const current = this.getElement();
          if (typeof current?.innerHTML === 'string') element.innerHTML = current.innerHTML;
          if (nativeProvider === 'amap') native.setMap(null); else native.remove();
          attached = false;
        },
        setPosition(value) {
          const next = fix(value);
          if (removed || !next) return this;
          this.position = next;
          this.mapPosition = view.project(next);
          if (attached) {
            if (nativeProvider === 'amap') native.setPosition([this.mapPosition.longitude, this.mapPosition.latitude]);
            else native.setLatLng([this.mapPosition.latitude, this.mapPosition.longitude]);
          }
          return this;
        },
        setLatLng(value) { return this.setPosition(value); },
        getLatLng() { return { lat: this.position.latitude, lng: this.position.longitude }; },
        setOpacity(value) {
          opacity = value;
          if (!removed && attached) {
            if (typeof native.setOpacity === 'function') native.setOpacity(value);
            else {
              const node = this.getElement();
              if (node) node.style.opacity = String(value);
            }
          }
          return this;
        },
        getElement() { return removed || !attached ? null : nativeProvider === 'amap' ? element : native.getElement(); },
        remove() {
          if (removed) return;
          this._detach();
          removed = true;
          view._markers.delete(this);
        }
      };
      this._markers.add(wrapper);
      wrapper._mount();
      return wrapper;
    }

    setTrackLines(lines) {
      if (!this.ready) return this;
      this._clearTrackLines();
      this.lastTrackLines = [];
      for (const line of lines || []) {
        let points = [];
        const addPart = () => {
          if (points.length < 2) { points = []; return; }
          const rawPoints = points;
          this.lastTrackLines.push({ ...line, points: rawPoints });
          const path = rawPoints.map(point => this.project(point));
          const layer = this.provider === 'amap' ? new scope.AMap.Polyline({
            path: path.map(point => [point.longitude, point.latitude]), strokeColor: line.color,
            strokeWeight: line.width || 4, strokeOpacity: 1, lineJoin: 'round', lineCap: 'round', zIndex: 100
          }) : scope.L.polyline(path.map(point => [point.latitude, point.longitude]), {
            color: line.color, weight: line.width || 4
          });
          if (this.provider === 'amap') layer.setMap(this.map); else layer.addTo(this.map);
          this._trackLayers.push(layer);
          points = [];
        };
        for (const value of line.points || []) {
          const point = fix(value);
          if (point) points.push(point); else addPart();
        }
        addPart();
      }
      return this;
    }

    _clearTrackLines() {
      for (const layer of this._trackLayers) {
        if (this.provider === 'amap') layer.setMap(null); else layer.remove();
      }
      this._trackLayers = [];
    }

    setView(value, zoom, options = {}) {
      if (!this.ready) return this;
      const point = this.project(value);
      if (!point) return this;
      if (this.provider === 'amap') {
        if (Number.isFinite(zoom)) this.map.setZoomAndCenter(zoom, [point.longitude, point.latitude], options.animate === false);
        else this.map.setCenter([point.longitude, point.latitude], options.animate === false);
      } else this.map.setView([point.latitude, point.longitude], zoom, options);
      return this;
    }

    getCenter() {
      const center = this.map?.getCenter?.();
      const point = fix(center ? { latitude: center.lat ?? center.getLat?.(), longitude: center.lng ?? center.getLng?.() } : null);
      if (!point || this.provider !== 'amap') return point;
      // 仅为保留用户平移后的视野作近似反算；RTK 记录始终保留原始 WGS84。
      let raw = { ...point };
      for (let i = 0; i < 6; i++) {
        const projected = this.project(raw);
        const latitudeError = projected.latitude - point.latitude;
        const longitudeError = projected.longitude - point.longitude;
        raw.latitude -= latitudeError;
        raw.longitude -= longitudeError;
        if (Math.max(Math.abs(latitudeError), Math.abs(longitudeError)) < 1e-8) break;
      }
      return raw;
    }

    getZoom() { return this.map?.getZoom() ?? 5; }
    setZoom(zoom) { if (this.ready && Number.isFinite(zoom)) this.map.setZoom(zoom); return this; }

    panBy(offset, options) {
      if (this.ready) {
        if (this.provider === 'amap') this.map.panBy(offset[0], offset[1]);
        else this.map.panBy(offset, options);
      }
      return this;
    }

    getSize() {
      const size = this.map?.getSize();
      return { x: size?.x ?? size?.width ?? size?.getWidth?.() ?? this.container?.clientWidth ?? 0,
        y: size?.y ?? size?.height ?? size?.getHeight?.() ?? this.container?.clientHeight ?? 0 };
    }

    latLngToContainerPoint(value) {
      if (!this.ready) return null;
      const point = this.project(value);
      if (!point) return null;
      if (this.provider === 'osm') return this.map.latLngToContainerPoint([point.latitude, point.longitude]);
      const pixel = this.map.lngLatToContainer([point.longitude, point.latitude]);
      return { x: pixel.x ?? pixel.getX(), y: pixel.y ?? pixel.getY() };
    }

    setTheme(theme) {
      if (this.provider === 'amap') this.map?.setMapStyle?.(theme === 'dark' ? 'amap://styles/darkblue' : 'amap://styles/normal');
      return this;
    }

    invalidateSize(options = {}) {
      if (this.ready) {
        if (this.provider === 'amap') this.map.resize?.();
        else this.map.invalidateSize(options);
      }
      return this;
    }

    _disposeMap(preserveMarkers = false) {
      this._cancelMapReady?.();
      this.ready = false;
      for (const marker of this._markers) {
        if (preserveMarkers) marker._detach(); else marker.remove();
      }
      this._clearTrackLines();
      for (const [name, callback] of this._mapEvents) this.map?.off?.(name, callback);
      this._mapEvents = [];
      this._zoomControls?.remove();
      this._zoomControls = null;
      this._tiles?.off?.();
      if (this.provider === 'amap') this.map?.destroy?.(); else this.map?.remove?.();
      this.map = null;
      this._tiles = null;
      this._amapPolicyBlocked = false;
    }

    destroy() {
      if (this._destroyed) return;
      this._destroyed = true;
      this._cancelConfig?.();
      this._cancelSdk?.();
      this._disposeMap();
      this.lastTrackLines = [];
      scope.removeEventListener?.('pagehide', this._pageHide);
      scope.document?.removeEventListener?.('securitypolicyviolation', this._policyViolation);
      this._events.clear();
    }
  }

  scope.BoatMapView = BoatMapView;
  if (typeof module === 'object' && module.exports) module.exports = { BoatMapView };
})(typeof window === 'object' ? window : globalThis);
