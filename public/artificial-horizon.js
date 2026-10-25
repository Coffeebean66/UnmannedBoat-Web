/* 轻量人工地平仪：只在遥测或页面刷新时更新 SVG，不启动动画循环。 */
(function (scope) {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const CENTER = 120;
  const PITCH_PIXELS_PER_DEGREE = 2;
  let instrumentSequence = 0;

  function horizonPose(view) {
    if (!view || !view.eulerFresh) return null;
    const roll = view.rollDegrees;
    const pitch = view.pitchDegrees;
    // 只接受原始数值；显示占位符、数字字符串和过期数据不能变成零姿态。
    if (typeof roll !== 'number' || typeof pitch !== 'number' ||
        !Number.isFinite(roll) || !Number.isFinite(pitch) ||
        Math.abs(roll) > 180 || Math.abs(pitch) > 90) return null;
    return { roll, pitch };
  }

  function unwrapAngle(previous, next) {
    if (!Number.isFinite(previous)) return next;
    const difference = ((next - previous + 180) % 360 + 360) % 360 - 180;
    return previous + difference;
  }

  function pitchOffset(pitch) {
    // 船体 X前 / Y左 / Z上、Rz·Ry·Rx：正 pitch 为船头向下，地平线上移。
    return -pitch * PITCH_PIXELS_PER_DEGREE;
  }

  function polar(angle, radius) {
    const radians = angle * Math.PI / 180;
    return { x: CENTER + Math.sin(radians) * radius,
      y: CENTER - Math.cos(radians) * radius };
  }

  class ArtificialHorizon {
    constructor(hostElement) {
      if (!hostElement || typeof hostElement.appendChild !== 'function')
        throw new TypeError('人工地平仪需要一个有效容器');
      this.host = hostElement;
      this.document = hostElement.ownerDocument || scope.document;
      this.host.classList.add('ah-instrument');
      this.clipId = `ah-clip-${++instrumentSequence}`;
      this.build();
      this.reset();
    }

    svgNode(name, attributes = {}, parent) {
      const node = this.document.createElementNS(SVG_NS, name);
      for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
      if (parent) parent.appendChild(node);
      return node;
    }

    build() {
      this.svg = this.svgNode('svg', {
        class: 'ah-svg', viewBox: '0 0 240 240', role: 'img',
        focusable: 'false', preserveAspectRatio: 'xMidYMid meet'
      }, this.host);
      const defs = this.svgNode('defs', {}, this.svg);
      const clip = this.svgNode('clipPath', { id: this.clipId }, defs);
      this.svgNode('circle', { cx: CENTER, cy: CENTER, r: 87 }, clip);
      this.svgNode('circle', {
        class: 'ah-face', cx: CENTER, cy: CENTER, r: 113, fill: '#121d2d'
      }, this.svg);

      const window = this.svgNode('g', { 'clip-path': `url(#${this.clipId})` }, this.svg);
      this.rollGroup = this.svgNode('g', { class: 'ah-roll-disc' }, window);
      this.pitchGroup = this.svgNode('g', { class: 'ah-pitch-disc' }, this.rollGroup);
      this.svgNode('rect', {
        class: 'ah-sky', x: -600, y: -600, width: 1440, height: 720, fill: '#288bd0'
      }, this.pitchGroup);
      this.svgNode('rect', {
        class: 'ah-ground', x: -600, y: CENTER, width: 1440, height: 720, fill: '#98633e'
      }, this.pitchGroup);
      this.svgNode('line', {
        class: 'ah-horizon-line', x1: -600, x2: 840, y1: CENTER, y2: CENTER,
        stroke: '#fff', 'stroke-width': 2
      }, this.pitchGroup);

      for (let angle = -90; angle <= 90; angle += 5) {
        if (angle === 0) continue;
        const major = angle % 10 === 0;
        const halfWidth = major ? 25 : 14;
        const y = CENTER - pitchOffset(angle);
        this.svgNode('line', {
          class: `ah-pitch-line${major ? ' ah-pitch-major' : ''}${angle < 0 ? ' ah-pitch-negative' : ''}`,
          'data-angle': angle, x1: CENTER - halfWidth, x2: CENTER + halfWidth, y1: y, y2: y,
          stroke: '#fff', 'stroke-width': major ? 1.5 : 1
        }, this.pitchGroup);
        if (major) {
          for (const side of [-1, 1]) {
            const label = this.svgNode('text', {
              class: 'ah-pitch-label', x: CENTER + side * 33, y,
              'text-anchor': side < 0 ? 'end' : 'start', 'dominant-baseline': 'middle',
              fill: '#fff', 'font-size': 9
            }, this.pitchGroup);
            label.textContent = String(angle);
          }
        }
      }

      this.svgNode('circle', {
        class: 'ah-window-rim', cx: CENTER, cy: CENTER, r: 87,
        fill: 'none', stroke: '#64748b', 'stroke-width': 1
      }, this.svg);
      const scale = this.svgNode('g', { class: 'ah-roll-scale' }, this.svg);
      this.svgNode('path', {
        class: 'ah-roll-arc', d: 'M 21.2 73.9 A 109 109 0 0 1 218.8 73.9',
        fill: 'none', stroke: '#94a3b8', 'stroke-width': 0.7
      }, scale);
      for (const angle of [-60, -45, -30, -20, -10, 0, 10, 20, 30, 45, 60]) {
        const major = angle === 0 || Math.abs(angle) === 30 || Math.abs(angle) === 60;
        const inner = polar(angle, major ? 101 : 104);
        const outer = polar(angle, 110);
        this.svgNode('line', {
          class: `ah-roll-tick${major ? ' ah-roll-major' : ''}`,
          'data-angle': angle, x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y,
          stroke: '#e2e8f0', 'stroke-width': major ? 2 : 1.2
        }, scale);
        // 横滚读数置于盘外，缩小屏幕时也不与盘内的俯仰梯重叠。
        if ([10, 30, 60].includes(Math.abs(angle))) {
          const point = polar(angle, 94);
          const label = this.svgNode('text', {
            class: 'ah-roll-label', x: point.x, y: point.y,
            'text-anchor': 'middle', 'dominant-baseline': 'middle',
            fill: '#e2e8f0', 'font-size': 7
          }, scale);
          label.textContent = String(Math.abs(angle));
        }
      }
      // 外圈刻度和机翼固定；横滚指针向右表示右倾，地平线反向旋转。
      this.svgNode('path', {
        class: 'ah-zero-index', d: 'M 117 10 L 123 10 L 120 15 Z', fill: '#f7cb66'
      }, this.svg);
      this.bankPointer = this.svgNode('g', { class: 'ah-bank-pointer' }, this.svg);
      this.svgNode('path', {
        d: 'M 115 30 L 125 30 L 120 23 Z', fill: '#f7cb66',
        stroke: '#172033', 'stroke-width': 0.7
      }, this.bankPointer);
      this.svgNode('path', {
        class: 'ah-aircraft-shadow', d: 'M 76 120 H 103 L 112 126 H 128 L 137 120 H 164',
        fill: 'none', stroke: '#172033', 'stroke-width': 6, 'stroke-linejoin': 'round'
      }, this.svg);
      this.svgNode('path', {
        class: 'ah-aircraft', d: 'M 76 120 H 103 L 112 126 H 128 L 137 120 H 164',
        fill: 'none', stroke: '#ffdb7a', 'stroke-width': 3, 'stroke-linejoin': 'round'
      }, this.svg);
      this.svgNode('circle', {
        class: 'ah-aircraft-center', cx: CENTER, cy: CENTER, r: 3,
        fill: '#ffdb7a', stroke: '#172033', 'stroke-width': 1
      }, this.svg);
      this.svgNode('circle', {
        class: 'ah-bezel', cx: CENTER, cy: CENTER, r: 113,
        fill: 'none', stroke: '#475569', 'stroke-width': 2
      }, this.svg);
      this.status = this.document.createElement('span');
      this.status.className = 'ah-status';
      this.host.appendChild(this.status);
    }

    setPose(roll, pitch) {
      // 与现有 3D 姿态保持一致：正 roll 为右倾，正 pitch 为船头向下。
      this.rollGroup.setAttribute('transform', `rotate(${-roll} 120 120)`);
      this.pitchGroup.setAttribute('transform', `translate(0 ${pitchOffset(pitch)})`);
      this.bankPointer.setAttribute('transform', `rotate(${roll} 120 120)`);
    }

    update(view) {
      const pose = horizonPose(view);
      if (pose) {
        this.roll = unwrapAngle(this.hasPose ? this.roll : NaN, pose.roll);
        this.hasPose = true;
        this.setPose(this.roll, pose.pitch);
        this.host.setAttribute('data-valid', 'true');
        this.host.setAttribute('data-state', 'live');
        this.host.setAttribute('data-roll', String(pose.roll));
        this.host.setAttribute('data-pitch', String(pose.pitch));
        this.status.textContent = '实时姿态';
        this.svg.setAttribute('aria-label',
          `人工地平仪，横滚 ${pose.roll.toFixed(1)} 度，俯仰 ${pose.pitch.toFixed(1)} 度`);
        return;
      }
      // 过期后冻结最后的可信姿态，不能回零伪装成船体已经恢复水平。
      const reason = view && typeof view.status === 'string' ? view.status : '无有效 IMU 欧拉角数据';
      this.host.setAttribute('data-valid', 'false');
      this.host.setAttribute('data-state', this.hasPose ? 'stale' : 'waiting');
      this.status.textContent = this.hasPose ? `${reason} · 保持最后姿态` :
        view && typeof view.status === 'string' ? reason : '等待有效姿态';
      this.svg.setAttribute('aria-label', `人工地平仪，${reason}，${this.status.textContent}`);
    }

    setTelemetry(view) {
      this.update(view);
    }

    reset() {
      this.hasPose = false;
      this.roll = 0;
      this.setPose(0, 0);
      this.host.setAttribute('data-roll', '--');
      this.host.setAttribute('data-pitch', '--');
      this.update(null);
    }
  }

  if (typeof module === 'object' && module.exports)
    module.exports = { ArtificialHorizon, horizonPose, unwrapAngle, pitchOffset };
  if (scope) {
    scope.ArtificialHorizon = ArtificialHorizon;
    scope.BoatArtificialHorizon = ArtificialHorizon;
  }
})(typeof window !== 'undefined' ? window : globalThis);
