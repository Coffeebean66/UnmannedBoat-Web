// 同时检查 MCU 反馈年龄与手机收帧后经过的时间，断流时不显示旧船速。
function prepareBoatDisplay(frame, receivedAt, now, connected) {
  const b = frame && frame.boat;
  const elapsed = Math.max(0, now - receivedAt);
  // fresh描述控制器反馈可用性，current仅描述手机是否还在收到船体帧。
  // MCU仍周期发送旧反馈状态时，不能只靠手机最近收包时间判断速度有效。
  const fresh = !!(connected && b && b.received && b.feedbackValid &&
    b.ageMs !== null && b.ageMs + elapsed < 1000);
  const current = !!(connected && b && elapsed < 1000);
  // 新帧提供0/1/2三种模式；旧船速帧只有闭环标志，因此只能还原PWM或速度模式。
  const mode = b && b.controlMode !== undefined ? b.controlMode : b && b.speedLoop ? 1 : 0;
  const headingMode = current && mode === 2;
  // 船体帧未单列航向年龄，此处还要求船速样本年龄可用，采取保守展示条件。
  const headingFresh = !!(current && b.headingValid && b.ageMs !== null && b.ageMs + elapsed < 1000);
  // 闭环分支先展示遥控/反馈异常，再显示正常闭环；开环分支只显示开环标记。
  const status = !connected ? '未连接' : !b ? '等待船速控制数据' : !current ? '通信超时'
    : !b.speedLoop ? '开环' : !b.sbusValid ? '遥控失联' : b.controlEnabled === false ? '低档停推'
      : headingMode && !headingFresh ? '航向无效，停止推进' : !fresh ? '等待有效船速'
        : !b.motorsValid ? '电调反馈超时' : b.reversing ? '等待停稳换向'
          : headingMode ? '航向与船速闭环' : '船速闭环';
  return {
    fresh, current, status,
    modeText: current ? ['PWM 模式', '速度模式', '角度模式'][mode] : '--',
    headingMode, headingFresh,
    targetHeading: headingMode ? b.targetHeading.toFixed(2) : '--',
    actualHeading: headingMode && headingFresh ? b.actualHeading.toFixed(2) : '--',
    headingError: headingMode && headingFresh ? b.headingError.toFixed(2) : '--',
    // 目标卡显示速率幅值，正负命令另外转换为“前进/后退”；不能据此推断漂移方向。
    target: current ? Math.abs(b.targetMps).toFixed(3) : '--',
    actual: fresh ? b.actualMps.toFixed(3) : '--',
    requested: current ? Math.abs(b.requestedMps).toFixed(3) : '--',
    direction: current ? (b.targetMps < 0 ? '后退' : b.targetMps > 0 ? '前进' : '停止推进') : '--',
    common: current ? b.commonPercent.toFixed(1) : '--',
    turn: current ? b.turnPercent.toFixed(1) : '--'
  };
}
module.exports = { prepareBoatDisplay };
