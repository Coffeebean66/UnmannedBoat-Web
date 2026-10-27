const { prepareBoatDisplay } = require('./boatDisplay');

// 与固件一致，角差范围为 [-180, 180)，参数顺序为“目标、实际”。
function shortestAngleError(target, actual) {
  return ((target - actual + 180) % 360 + 360) % 360 - 180;
}

function validHeading(value) {
  return Number.isFinite(value) && value >= 0 && value < 360;
}

function unfoldAngle(value, previousValue, previousPlot) {
  return Number.isFinite(value) ? (Number.isFinite(previousPlot) ?
    previousPlot + shortestAngleError(value, previousValue) : value) : null;
}

// 一条历史同时记录船速和航向，切换图表只改变展示，不丢弃另一种数据。
function createBoatChartSample(frame, receivedAt, timestamp, connected, previous, maxGapMs = 1000) {
  const b = frame && frame.boat;
  const view = prepareBoatDisplay(frame, receivedAt, timestamp, connected);
  const headingTarget = view.headingMode && validHeading(b.targetHeading) ? b.targetHeading : null;
  const headingActual = view.headingMode && view.headingFresh && validHeading(b.actualHeading) ?
    b.actualHeading : null;
  // 实时流间隔达到 1 秒时重建展开基准；历史回放按服务器采样周期设置连续阈值。
  const adjacent = previous && timestamp >= previous.timestamp && timestamp - previous.timestamp < maxGapMs;
  const headingTargetPlot = unfoldAngle(headingTarget,
    adjacent ? previous.headingTarget : null, adjacent ? previous.headingTargetPlot : null);
  let headingActualPlot = unfoldAngle(headingActual,
    adjacent ? previous.headingActual : null, adjacent ? previous.headingActualPlot : null);
  if (Number.isFinite(headingActual) && (!adjacent || !Number.isFinite(previous.headingActualPlot)) &&
      Number.isFinite(headingTargetPlot)) {
    // 新的实际线段从目标附近开始，例如目标 1°、实际 359° 绘为 1°、-1°。
    headingActualPlot = headingTargetPlot + shortestAngleError(headingActual, headingTarget);
  }
  return {
    timestamp, gapMs: maxGapMs,
    target: view.current && b.speedLoop ? Math.abs(b.targetMps) : null,
    actual: view.fresh && b.speedLoop ? b.actualMps : null,
    headingTarget, headingActual, headingTargetPlot, headingActualPlot
  };
}

function prepareBoatChartSummary(latest, mode) {
  const heading = mode === 'heading';
  const target = latest && latest[heading ? 'headingTarget' : 'target'];
  const actual = latest && latest[heading ? 'headingActual' : 'actual'];
  const precision = heading ? 2 : 3;
  return {
    target: Number.isFinite(target) ? target.toFixed(precision) : '--',
    actual: Number.isFinite(actual) ? actual.toFixed(precision) : '--',
    error: Number.isFinite(target) && Number.isFinite(actual) ?
      (heading ? shortestAngleError(target, actual) : actual - target).toFixed(precision) : '--'
  };
}

function prepareBoatChart(history, mode) {
  const heading = mode === 'heading';
  const summary = prepareBoatChartSummary(history[history.length - 1], mode);
  const samples = history.map(sample => ({
    timestamp: sample.timestamp, gapMs: sample.gapMs || 1000,
    target: sample[heading ? 'headingTargetPlot' : 'target'],
    actual: sample[heading ? 'headingActualPlot' : 'actual']
  }));
  const values = [];
  samples.forEach(sample => {
    if (Number.isFinite(sample.target)) values.push(sample.target);
    if (Number.isFinite(sample.actual)) values.push(sample.actual);
  });
  let minValue = 0;
  let maxValue = heading ? 360 : 0.6;
  if (values.length && heading) {
    const low = Math.min(...values);
    const high = Math.max(...values);
    const center = (low + high) / 2;
    const halfSpan = Math.max(20, high - low) * 1.15 / 2;
    // 航向纵轴允许负角和超过 360° 的展开角，保留至少 20° 范围观察小幅修正。
    minValue = Math.floor(center - halfSpan);
    maxValue = Math.ceil(center + halfSpan);
  } else if (values.length) {
    maxValue = Math.ceil(Math.max(0.5, ...values) * 1.15 * 10) / 10;
  }
  return { summary, samples, minValue, maxValue, hasValues: values.length > 0 };
}

module.exports = { shortestAngleError, createBoatChartSample, prepareBoatChartSummary, prepareBoatChart };
