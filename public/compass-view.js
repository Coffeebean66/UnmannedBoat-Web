/* 船头向上的真北罗盘：SVG 只构建一次，随遥测更新旋转，不启动常驻动画循环。 */
(function (scope) {
  'use strict';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CENTER = 160;
  const SOURCES = { fused: '控制器航向', rtk: 'RTK 航向' };

  function normalizeDegrees(value) {
    return typeof value === 'number' && Number.isFinite(value) ? ((value % 360) + 360) % 360 : null;
  }

  function unwrapDegrees(previous, value) {
    if (!Number.isFinite(previous)) return value;
    return previous + ((value - previous + 540) % 360 + 360) % 360 - 180;
  }

  function point(angle, radius) {
    const radians = angle * Math.PI / 180;
    return { x: CENTER + Math.sin(radians) * radius, y: CENTER - Math.cos(radians) * radius };
  }

  function bearingName(angle) {
    return ['北', '东北', '东', '东南', '南', '西南', '西', '西北'][Math.floor((angle + 22.5) / 45) % 8];
  }

  function angleText(angle) {
    // 保留一位小数时先归一化舍入，359.99° 显示为 000.0°，不出现 360°。
    return angle === null ? '--' : ((Math.round(angle * 10) % 3600) / 10).toFixed(1).padStart(5, '0') + '°';
  }

  class BoatCompassView {
    constructor(hostElement) {
      if (!hostElement || typeof hostElement.appendChild !== 'function') throw new TypeError('罗盘需要有效的容器');
      this.host = hostElement;
      this.document = hostElement.ownerDocument || scope.document;
      this.host.classList.add('boat-compass');
      this.destroyed = false;
      this.build();
      this.reset();
    }

    node(name, className, parent, text) {
      const element = this.document.createElement(name);
      if (className) element.className = className;
      if (text !== undefined) element.textContent = text;
      if (parent) parent.appendChild(element);
      return element;
    }

    svgNode(name, attributes, parent) {
      const element = this.document.createElementNS(SVG_NS, name);
      for (const [key, value] of Object.entries(attributes || {})) element.setAttribute(key, String(value));
      if (parent) parent.appendChild(element);
      return element;
    }

    build() {
      this.root = this.node('div', 'compass-shell', this.host);
      const reference = this.node('div', 'compass-reference', this.root);
      this.node('span', 'compass-reference-label', reference, 'HEAD UP · 船头向上');
      this.source = this.node('span', 'compass-source', reference, '等待航向');
      const stage = this.node('div', 'compass-stage', this.root);
      this.svg = this.svgNode('svg', {
        class: 'compass-svg', viewBox: '0 0 320 320', role: 'img',
        focusable: 'false', preserveAspectRatio: 'xMidYMid meet'
      }, stage);
      this.svgNode('circle', { class: 'compass-bezel', cx: CENTER, cy: CENTER, r: 153 }, this.svg);
      this.svgNode('circle', { class: 'compass-face', cx: CENTER, cy: CENTER, r: 147 }, this.svg);
      this.svgNode('circle', { class: 'compass-inner-ring', cx: CENTER, cy: CENTER, r: 83 }, this.svg);
      this.svgNode('circle', { class: 'compass-range-ring', cx: CENTER, cy: CENTER, r: 58 }, this.svg);
      this.svgNode('path', { class: 'compass-body-axis', d: 'M160 73V247 M73 160H247' }, this.svg);

      this.rose = this.svgNode('g', { class: 'compass-rose' }, this.svg);
      // 五度细刻度、十度长刻度与三十度数字；方位字母单列在内圈。
      for (let angle = 0; angle < 360; angle += 5) {
        const major = angle % 10 === 0;
        const a = point(angle, major ? 130 : 136), b = point(angle, 141);
        this.svgNode('line', {
          class: 'compass-tick' + (major ? ' compass-tick-major' : ''),
          x1: a.x, y1: a.y, x2: b.x, y2: b.y
        }, this.rose);
        if (angle % 30 === 0) {
          const label = point(angle, 119);
          this.svgNode('text', {
            class: 'compass-degree', x: label.x, y: label.y,
            'text-anchor': 'middle', 'dominant-baseline': 'central',
            transform: `rotate(${angle} ${label.x} ${label.y})`
          }, this.rose).textContent = String(angle).padStart(3, '0');
        }
      }
      ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'].forEach((label, index) => {
        const angle = index * 45, position = point(angle, index % 2 ? 99 : 95);
        this.svgNode('text', {
          class: 'compass-cardinal' + (index % 2 ? ' compass-intercardinal' : '') + (index === 0 ? ' compass-north' : ''),
          x: position.x, y: position.y, 'text-anchor': 'middle', 'dominant-baseline': 'central',
          transform: `rotate(${angle} ${position.x} ${position.y})`
        }, this.rose).textContent = label;
      });
      this.svgNode('path', { class: 'compass-north-diamond', d: 'M160 22L164 29L160 36L156 29Z' }, this.rose);

      // 航迹指针取 RTK 东/北速度方向，不能用它替代船头朝向。
      this.coursePointer = this.svgNode('g', { class: 'compass-course-pointer' }, this.svg);
      this.svgNode('path', { class: 'compass-course-line', d: 'M160 140V74' }, this.coursePointer);
      this.svgNode('path', { class: 'compass-course-head', d: 'M160 63L166 75H154Z' }, this.coursePointer);
      this.targetPointer = this.svgNode('g', { class: 'compass-target-pointer' }, this.svg);
      this.svgNode('path', { class: 'compass-target-line', d: 'M160 137V53' }, this.targetPointer);
      this.svgNode('path', { class: 'compass-target-head', d: 'M160 42L167 52L160 62L153 52Z' }, this.targetPointer);

      this.svgNode('path', { class: 'compass-lubber', d: 'M154 12H166L160 23Z' }, this.svg);
      this.svgNode('path', { class: 'compass-heading-line', d: 'M160 132V113' }, this.svg);
      this.svgNode('circle', { class: 'compass-hull-halo', cx: CENTER, cy: CENTER, r: 25 }, this.svg);
      this.svgNode('path', {
        class: 'compass-hull', d: 'M160 135Q167 143 170 154L168 176Q160 181 152 176L150 154Q153 143 160 135Z'
      }, this.svg);
      this.svgNode('path', { class: 'compass-hull-detail', d: 'M156 153H164V169H156Z M160 140V148' }, this.svg);
      const heading = this.node('div', 'compass-heading', stage);
      this.headingValue = this.node('strong', 'compass-heading-value', heading, '--');
      this.headingName = this.node('span', 'compass-heading-name', heading, '船头航向 / HDG');

      const readouts = this.node('dl', 'compass-readouts', this.root);
      const readout = (kind, label) => {
        const group = this.node('div', 'compass-readout compass-readout-' + kind, readouts);
        this.node('dt', '', group, label);
        return this.node('dd', 'compass-' + kind + '-value', group, '--');
      };
      this.targetValue = readout('target', '目标航向');
      this.courseValue = readout('course', '航迹方向');
      this.speedValue = readout('speed', '对地船速');
      const footer = this.node('div', 'compass-footer', this.root);
      this.status = this.node('span', 'compass-status', footer, '等待有效航向');
      this.turnValue = this.node('span', 'compass-turn-value', footer, '--');
      this.turnValue.title = '目标航向相对船头的最短角差；正值向右、负值向左';
    }

    rotate(element, degrees, smooth) {
      element.style.transition = smooth ? '' : 'none';
      element.style.transform = `rotate(${degrees}deg)`;
      element.setAttribute('data-angle', String(degrees));
    }

    setTelemetry(view) {
      if (this.destroyed) return;
      const connected = view?.connected === true;
      const heading = connected ? normalizeDegrees(view.headingDegrees) : null;
      const target = connected ? normalizeDegrees(view.targetDegrees) : null;
      const course = connected ? normalizeDegrees(view.courseDegrees) : null;
      const speed = connected && typeof view.speedMps === 'number' && Number.isFinite(view.speedMps) && view.speedMps >= 0 ? view.speedMps : null;
      const live = heading !== null;
      const source = live && Object.hasOwn(SOURCES, view.headingSource) ? view.headingSource : 'none';
      this.host.dataset.valid = String(live);
      this.host.dataset.connected = String(connected);
      this.host.dataset.heading = live ? String(heading) : '--';
      this.host.dataset.target = target === null ? '--' : String(target);
      this.host.dataset.course = course === null ? '--' : String(course);
      this.host.dataset.source = source;
      this.host.dataset.state = live ? 'live' : this.hasHeading ? 'stale' : 'waiting';
      if (live) {
        const unwrapped = unwrapDegrees(this.lastHeading, heading);
        this.rotate(this.rose, -unwrapped, this.live);
        this.lastHeading = unwrapped;
        this.hasHeading = true;
      } else this.lastHeading = null;

      const pointer = (element, value, previousKey) => {
        const visible = live && value !== null;
        element.style.display = visible ? '' : 'none';
        if (visible) {
          const shortest = ((value - heading + 540) % 360 + 360) % 360 - 180;
          const relative = unwrapDegrees(this[previousKey], shortest);
          this.rotate(element, relative, this.live && this[previousKey] !== null);
          this[previousKey] = relative;
        } else this[previousKey] = null;
      };
      pointer(this.targetPointer, target, 'lastTarget');
      pointer(this.coursePointer, course, 'lastCourse');
      this.headingValue.textContent = angleText(heading);
      this.headingName.textContent = live ? `${bearingName(heading)} · 船头航向 / HDG` : '船头航向 / HDG';
      this.targetValue.textContent = angleText(target);
      this.courseValue.textContent = angleText(course);
      this.speedValue.textContent = speed === null ? '--' : speed.toFixed(2) + ' m/s';
      this.source.textContent = SOURCES[source] || '等待航向';
      const status = typeof view?.status === 'string' && view.status.trim() ? view.status : live ? '实时航向' : connected ? '等待有效航向' : '未连接';
      this.status.textContent = status;
      const turn = live && target !== null && typeof view.turnDegrees === 'number' && Number.isFinite(view.turnDegrees) && Math.abs(view.turnDegrees) <= 180 ? view.turnDegrees : null;
      this.turnValue.textContent = turn === null ? '--' : Math.abs(turn) < .05 ? '已对准目标' : `${turn > 0 ? '右转' : '左转'} ${Math.abs(turn).toFixed(1)}°`;
      this.svg.setAttribute('aria-label', live ?
        `真北罗盘，船头航向 ${angleText(heading)}，${SOURCES[source] || '有效航向'}，目标航向 ${angleText(target)}，航迹方向 ${angleText(course)}，${status}` :
        `真北罗盘，${status}，当前船头航向不可用`);
      this.live = live;
    }

    reset() {
      if (this.destroyed) return;
      this.hasHeading = false;
      this.live = false;
      this.lastHeading = this.lastTarget = this.lastCourse = null;
      this.rotate(this.rose, 0, false);
      this.rotate(this.targetPointer, 0, false);
      this.rotate(this.coursePointer, 0, false);
      this.setTelemetry({ connected: false, status: '等待有效航向' });
    }

    destroy() {
      if (this.destroyed) return;
      this.reset();
      this.root.remove();
      this.host.classList.remove('boat-compass');
      this.destroyed = true;
    }
  }

  if (typeof module === 'object' && module.exports) module.exports = { BoatCompassView, normalizeDegrees, unwrapDegrees, bearingName, angleText };
  if (scope) scope.BoatCompassView = BoatCompassView;
})(typeof window !== 'undefined' ? window : globalThis);
