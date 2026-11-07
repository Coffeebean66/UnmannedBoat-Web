/* 震动事件只依赖有效遥测，不使用油门指令推测电机是否已经起动。 */
const DEFAULTS = Object.freeze({ enabled: true, attitudeThresholdDegrees: 10 });
function normalizeSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' ||
      !Number.isInteger(value.attitudeThresholdDegrees) || value.attitudeThresholdDegrees < 1 || value.attitudeThresholdDegrees > 90) return null;
  return { enabled: value.enabled, attitudeThresholdDegrees: value.attitudeThresholdDegrees };
}
const angleDelta = (a, b) => Math.abs(((a - b + 540) % 360 + 360) % 360 - 180);
class HapticEvents {
  constructor() { this.reset(); }
  reset() { this.motors = []; this.poses = []; this.poseStamp = null; this.lastAt = null; this.lastMotor = -Infinity; this.lastPose = -Infinity; }
  update(value, now, threshold) {
    if (!Number.isFinite(now)) return null;
    if (this.lastAt !== null && (now - this.lastAt > 1000 || now < this.lastAt)) this.reset();
    this.lastAt = now;
    let motorStart = false;
    for (let i = 0; i < 2; i++) {
      const motor = value.motors?.[i], rpm = motor?.Rpm;
      if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm < 0) { this.motors[i] = null; continue; }
      let state = this.motors[i];
      const stamp = motor.Sequence;
      if (stamp === undefined || stamp === null || stamp === '--') { this.motors[i] = null; continue; }
      if (!state) state = this.motors[i] = { running: true, low: null, high: null, stamp: null };
      if (state.stamp === stamp) continue; // 同一遥测重复绘制不会推进防抖计时。
      state.stamp = stamp;
      if (rpm <= 30) {
        state.high = null; state.low ??= now;
        if (now - state.low >= 300) state.running = false;
      } else if (rpm >= 60) {
        state.low = null; state.high ??= now;
        if (now - state.high >= 200 && !state.running) { motorStart = true; state.running = true; }
      } else { state.low = null; state.high = null; }
    }
    const imu = value.imu;
    let poseChange = false;
    if (!imu?.eulerFresh || ![imu.rollDegrees, imu.pitchDegrees, imu.yawDegrees].every(Number.isFinite) ||
        Math.abs(imu.rollDegrees) > 180 || Math.abs(imu.pitchDegrees) > 90 || Math.abs(imu.yawDegrees) > 180 ||
        imu.sequence === undefined || imu.sequence === null || imu.sequence === '--') {
      this.poses = []; this.poseStamp = null;
    } else if (imu.sequence !== this.poseStamp) {
      this.poseStamp = imu.sequence;
      this.poses = this.poses.filter(pose => now - pose.at <= 500);
      const pose = { at: now, angles: [imu.rollDegrees, imu.pitchDegrees, imu.yawDegrees] };
      poseChange = this.poses.some(previous => pose.angles.some((angle, i) => angleDelta(angle, previous.angles[i]) >= threshold));
      this.poses.push(pose);
      if (this.poses.length > 64) this.poses.shift();
    }
    // 姿态告警优先；独立冷却限制连续颠簸或两电机错开起动造成的频繁震动。
    if (poseChange && now - this.lastPose >= 1500) { this.lastPose = now; this.poses = this.poses.slice(-1); return 'attitude'; }
    if (motorStart && now - this.lastMotor >= 800) { this.lastMotor = now; return 'motor'; }
    return null;
  }
}
module.exports = { DEFAULTS, normalizeSettings, angleDelta, HapticEvents };
