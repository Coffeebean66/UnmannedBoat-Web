/* 管理员按船选择服务器图传通道，WVP 的登录凭据始终留在服务器。 */
(() => {
  'use strict';
  class BoatVideoSourceSettingsPanel {
    constructor({ document = window.document, auth = window.BoatAuth, fetcher = window.fetch.bind(window), onSaved = () => {} } = {}) {
      this.document = document; this.auth = auth; this.fetch = fetcher; this.onSaved = onSaved;
      this.nodes = Object.fromEntries(['videoSourceSettings', 'videoSourceRead', 'videoSourceForm', 'videoSourceBoat', 'videoSourceProvider', 'videoSourceWvpFields', 'videoSourceWvpDevice', 'videoSourceWvpChannel', 'videoSourceSave', 'videoSourceStatus', 'videoSourceCurrent'].map(id => [id, document.getElementById(id)]));
      this.opened = false; this.destroyed = false; this.busy = false; this.generation = 0; this.channelGeneration = 0;
      this.state = null; this.devices = []; this.channels = []; this.requests = new Set(); this.listeners = [];
      this.identity = this.authIdentity();
      this.authChanged = () => { const identity = this.authIdentity(); if (identity !== this.identity) { this.identity = identity; this.reset(); if (this.opened && this.admin()) this.read(); } this.render(); };
      auth?.addEventListener('change', this.authChanged);
      this.listen('videoSourceRead', 'click', () => this.read());
      this.listen('videoSourceBoat', 'change', () => this.selectBoat());
      this.listen('videoSourceProvider', 'change', () => this.render());
      this.listen('videoSourceWvpDevice', 'change', () => this.readChannels());
      this.listen('videoSourceWvpChannel', 'change', () => this.render());
      this.listen('videoSourceForm', 'submit', event => { event.preventDefault(); this.save(); });
      this.notice('按船选择图传接收通道；服务器会同步切换播放与录像。'); this.render();
    }
    listen(id, event, handler) { this.nodes[id].addEventListener(event, handler); this.listeners.push([this.nodes[id], event, handler]); }
    authIdentity() { return JSON.stringify([this.auth?.generation, this.auth?.ready, this.auth?.enabled, this.auth?.user?.username, this.auth?.user?.role]); }
    admin() { return !this.destroyed && this.auth?.ready && this.auth.enabled && this.auth.user?.role === 'admin'; }
    current(token) { return this.opened && this.admin() && token === this.generation; }
    notice(message, tone = 'neutral') { this.nodes.videoSourceStatus.textContent = message; this.nodes.videoSourceStatus.dataset.tone = tone; }
    reset() { ++this.generation; ++this.channelGeneration; for (const controller of this.requests) controller.abort(); this.requests.clear(); this.busy = false; this.state = null; this.devices = []; this.channels = []; }
    open() { this.opened = true; this.render(); if (this.admin() && !this.state && !this.busy) return this.read(); }
    close() { this.opened = false; this.reset(); this.render(); }
    async request(route, { method = 'GET', body } = {}) {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 35000); this.requests.add(controller);
      try {
        const response = await this.fetch('/api/video/sources' + route, { method, credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
          headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = await response.json();
        if (!response.ok) throw Error(data.error || '图传通道读取失败');
        return data;
      } finally { clearTimeout(timer); this.requests.delete(controller); }
    }
    options(node, values, placeholder, selected = '') {
      const option = (value, text) => { const item = this.document.createElement('option'); item.value = value; item.textContent = text; return item; };
      node.replaceChildren(option('', placeholder), ...values.map(item => option(item.id, item.name)));
      if (selected && !values.some(item => item.id === selected)) node.append(option(selected, selected + ' · 已绑定，当前列表未找到'));
      node.value = selected;
    }
    render() {
      const n = this.nodes, usable = this.admin() && this.state?.enabled === true && !this.state.error;
      n.videoSourceSettings.hidden = !this.admin(); n.videoSourceForm.hidden = !this.state?.enabled;
      n.videoSourceRead.disabled = !this.admin() || this.busy;
      for (const id of ['videoSourceBoat', 'videoSourceProvider', 'videoSourceWvpDevice', 'videoSourceWvpChannel']) n[id].disabled = !usable || this.busy;
      n.videoSourceWvpFields.hidden = n.videoSourceProvider.value !== 'wvp';
      n.videoSourceSave.disabled = !usable || this.busy || !n.videoSourceBoat.value || n.videoSourceProvider.value === 'wvp' && (!n.videoSourceWvpDevice.value || !n.videoSourceWvpChannel.value);
      const boat = this.state?.boats?.find(item => item.deviceId === n.videoSourceBoat.value);
      n.videoSourceCurrent.textContent = boat ? '服务器当前来源：' + boat.label + (boat.error ? ' · ' + boat.error : boat.applied ? ' · 已应用' : ' · 等待应用') : '先选择无人船，再选择接收通道。';
    }
    async read() {
      if (!this.opened || !this.admin() || this.busy) return;
      const token = ++this.generation, previous = this.nodes.videoSourceBoat.value; this.busy = true; this.notice('正在读取服务器视频来源…'); this.render();
      try {
        const state = await this.request(''); if (!this.current(token)) return;
        this.state = state;
        if (!state.enabled || state.error) { this.notice(state.error || '服务器尚未启用 WVP 接入', 'warning'); return; }
        this.options(this.nodes.videoSourceBoat, state.boats.map(item => ({ id: item.deviceId, name: item.deviceId })), '选择无人船', state.boats.some(item => item.deviceId === previous) ? previous : state.boats[0]?.deviceId || '');
        try {
          const data = await this.request('/wvp/devices'); if (!this.current(token)) return;
          this.devices = data.devices; this.notice(this.devices.length ? '已读取 ' + this.devices.length + ' 台 WVP 设备。选择通道后保存，即对所有用户生效。' : 'WVP 已连接，尚无注册设备。请先在 WVP 注册摄像头，再点击重新读取。', this.devices.length ? 'neutral' : 'warning');
        } catch (error) { if (!this.current(token)) return; this.devices = []; this.notice(error.message + '；仍可切回原 SRT / UDP 通道。', 'warning'); }
        if (this.current(token)) await this.selectBoat();
      } catch (error) { if (this.current(token)) this.notice(error.message || '图传通道读取失败', 'danger'); }
      finally { if (this.current(token)) { this.busy = false; this.render(); } }
    }
    async selectBoat() {
      const n = this.nodes, boat = this.state?.boats?.find(item => item.deviceId === n.videoSourceBoat.value);
      n.videoSourceProvider.value = boat?.provider || 'direct';
      this.options(n.videoSourceWvpDevice, this.devices.map(item => ({ id: item.deviceId, name: item.name + (item.online ? ' · 在线' : ' · 离线') })), '选择 WVP 设备', boat?.wvpDeviceId || '');
      await this.readChannels(boat?.channelId || ''); this.render();
    }
    async readChannels(selected = '') {
      const n = this.nodes, id = n.videoSourceWvpDevice.value, token = this.generation, sequence = ++this.channelGeneration;
      this.channels = []; this.options(n.videoSourceWvpChannel, [], id ? '正在读取通道…' : '先选择 WVP 设备'); this.render();
      if (!id) return;
      try {
        const data = await this.request('/wvp/devices/' + encodeURIComponent(id) + '/channels');
        if (!this.current(token) || sequence !== this.channelGeneration || id !== n.videoSourceWvpDevice.value) return;
        this.channels = data.channels;
        this.options(n.videoSourceWvpChannel, data.channels.map(item => ({ id: item.channelId, name: item.name + (item.online ? ' · 在线' : ' · 离线') })), '选择摄像头通道', selected);
      } catch (error) { if (this.current(token) && sequence === this.channelGeneration) { this.options(n.videoSourceWvpChannel, [], '通道读取失败', selected); this.notice(error.message, 'warning'); } }
      finally { if (this.current(token) && sequence === this.channelGeneration) this.render(); }
    }
    async save() {
      const n = this.nodes;
      if (n.videoSourceSave.disabled || !this.admin() || this.busy) return;
      const token = this.generation, id = n.videoSourceBoat.value, provider = n.videoSourceProvider.value;
      const body = { revision: this.state.revision, provider, ...(provider === 'wvp' ? { deviceId: n.videoSourceWvpDevice.value, channelId: n.videoSourceWvpChannel.value } : {}) };
      this.busy = true; this.notice('正在保存并切换图传来源，摄像头点播可能需要数秒…'); this.render();
      try {
        const data = await this.request('/boats/' + encodeURIComponent(id), { method: 'PUT', body }); if (!this.current(token)) return;
        this.state = data; this.notice(data.selected.error ? '选择已保存；' + data.selected.error + '。服务器会自动重试。' : '已切换 ' + id + ' 的视频来源，播放页会自动重新连接。', data.selected.error ? 'warning' : 'success');
        this.onSaved(id);
      } catch (error) { if (this.current(token)) this.notice(error.message || '图传通道保存失败，请重新读取后重试', 'danger'); }
      finally { if (this.current(token)) { this.busy = false; this.render(); } }
    }
    destroy() { this.close(); this.destroyed = true; this.auth?.removeEventListener('change', this.authChanged); for (const [node, event, handler] of this.listeners) node.removeEventListener(event, handler); }
  }
  window.BoatVideoSourceSettingsPanel = BoatVideoSourceSettingsPanel;
})();
