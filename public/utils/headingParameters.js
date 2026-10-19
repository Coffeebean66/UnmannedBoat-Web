// 与固件 heading_control.h 对齐。增益用 X100 整数输入，保留0.01的调节分辨率。
// 七项顺序与UART4参数区末尾一致：协议编码、设置表单和范围校验共同引用此表。
// name/range/unit/description/advice同时用于整组说明和每项独立的“说明”弹窗。
const HEADING_PARAMETER_HELP = [
  { key: 'headingKpX100', name: '航向 KP', min: 0, max: 10000,
    range: '0 - 10000，默认 200', unit: 'X100：200 = 2 X2/度 = 1% PWM/度',
    description: '按目标与实测航向的最短角差产生差速。359°到1°按+2°修正，不会绕大圈。P越大，转向越有力。',
    advice: '先用默认200和较小差速上限低速测试，每次增减20～50；来回摆头时降低。速度KP只控制前后推进，与此项独立。' },
  { key: 'headingKiX100', name: '航向 KI', min: 0, max: 10000,
    range: '0 - 10000，默认 0', unit: 'X100：100 = 1 X2/(度·秒)',
    description: '累积持续航向偏差，用于抵消风流或两侧推力不一致。仅新反馈样本积分，混控受限或换向等待时停止同向积累。',
    advice: '先保持0。P稳定后仍有持续偏差，再从5～10小步增加；缓慢来回摆头时降低，并检查积分限幅。' },
  { key: 'headingKdX100', name: '航向 KD', min: 0, max: 10000,
    range: '0 - 10000，默认 0', unit: 'X100：100 = 1 X2/(度/秒)',
    description: '按实际航向角速度产生阻尼，跨0°取短角差；旋转目标旋钮不会直接产生微分冲击。',
    advice: '先保持0；存在可重复过冲且航向稳定时从10小步增加。航向噪声大时D会放大抖动，优先降低。' },
  { key: 'headingIntegralLimitX2', name: '航向积分限幅', min: 0, max: 200,
    range: '0 - 200 X2，默认 30', unit: '2 X2 = 1% PWM；默认15%',
    description: '限制航向I项累积的最大差速贡献。KI为0时此项不会产生额外推力。',
    advice: '先保持30；不要靠很大的积分弥补错误的转向方向。进入误差死区、关闭控制或反馈失效时积分清零。' },
  { key: 'headingOutputLimitX2', name: '自动转向输出上限', min: 1, max: 200,
    range: '1 - 200 X2，默认 60', unit: '每侧差速上限；60 X2 = 30% PWM',
    description: '航向PID最多产生的差速。电机1=共同推进+差速，电机2=共同推进−差速；混合后仍受总输出上限及PWM步长限制。',
    advice: '先在低速确认方向。这个上限太小会转弯慢，太大会急转甚至触发电机换向等待；不受人工“满速差速比例”控制。' },
  { key: 'headingDeadbandCdeg', name: '航向误差死区', min: 0, max: 3000,
    range: '0 - 3000（0～30°），默认 200', unit: '0.01°；200 = 2°',
    description: '绝对航向误差不超过此值时，航向PID输出和积分归零，降低测量噪声引起的左右抖动；实际PWM仍按步长回落。',
    advice: '先试2°；船头抖动可增加到3～5°，确认航向反馈精度后再缩小。设为0可能持续微调。' },
  { key: 'headingReversed', name: '自动转向方向', min: 0, max: 1,
    range: '正常 / 反向，默认正常', unit: '只反转航向PID产生的差速',
    description: '正常时正角差增大电机1、减小电机2；反向时相反。用于适配左右电机布局和上位机航向角增加的方向，不改变人工左右杆。',
    advice: 'CH6低档停稳后才能修改。首次低速测试小角差，若越修正偏差越大，应立即CH6低档停推，再反转本项；不要靠增大P纠正方向。' }
];
// 从单一字段表生成键名和范围，避免新增字段只在界面显示、却未进入读写校验。
const HEADING_PARAMETER_KEYS = HEADING_PARAMETER_HELP.map(item => item.key);
const HEADING_PARAMETER_RANGES = {};
HEADING_PARAMETER_HELP.forEach(item => { HEADING_PARAMETER_RANGES[item.key] = [item.min, item.max]; });
module.exports = { HEADING_PARAMETER_KEYS, HEADING_PARAMETER_HELP, HEADING_PARAMETER_RANGES };
