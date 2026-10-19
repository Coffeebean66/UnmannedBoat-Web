/* 导出当前表单的20项已校验参数，按固件实际默认值定义的位置分组。
 * 保留原始整数单位，方向0/1转换为对应宏，避免手工换算或字段顺序错位。 */
// 每行依次为：小程序字段名、C结构体成员名、导出注释；不按界面排序推断字段。
const BOAT_FIELDS = [
  ['feedforwardX2PerMps', 'feedforward_x2_per_m_s', '船速前馈，X2/(m/s)'],
  ['kpX2PerMps', 'kp_x2_per_m_s', '船速P，X2/(m/s)'],
  ['kiX2PerMpsS', 'ki_x2_per_m_s_s', '船速I，X2/((m/s)·s)'],
  ['kdX2PerMps2', 'kd_x2_per_m_s2', '船速D，X2/(m/s²)'],
  ['integralLimitX2', 'integral_limit_x2', '船速积分限幅，X2'],
  ['correctionLimitX2', 'correction_limit_x2', '船速修正限幅，X2'],
  ['outputLimitX2', 'output_limit_x2', '每侧总输出限幅，X2'],
  ['outputSlewStepX2', 'output_slew_step_x2', 'PWM步长，X2/20 ms']
];
// 航向字段导出为指定成员初始化，即使C结构体成员调整顺序也便于人工核对。
const HEADING_FIELDS = [
  ['headingKpX100', 'kp_x100', '航向P，X100'],
  ['headingKiX100', 'ki_x100', '航向I，X100'],
  ['headingKdX100', 'kd_x100', '航向D，X100'],
  ['headingIntegralLimitX2', 'integral_limit_x2', '航向积分限幅，X2'],
  ['headingOutputLimitX2', 'output_limit_x2', '自动转向上限，X2'],
  ['headingDeadbandCdeg', 'deadband_cdeg', '航向死区，0.01度'],
  ['headingReversed', 'reversed', '自动转向方向，0正常/1反向']
];

// 每行末尾生成C宏续行符，结束花括号不续行；字段注释放在续行符之前。
function initializer(name, entries) {
  const continuation = ' \\';
  return [`#define ${name} {${continuation}`]
    .concat(entries.map(([field, value, note]) =>
      `    .${field} = ${value}, /* ${note} */${continuation}`), ['}']).join('\n');
}

// values由首页共用校验器验证后传入；这里只生成文本，不发送命令或修改参数。
// matchesDevice仅表示与最近一次设备响应一致，不代表已存Flash或刚完成重新读取。
// exportedAt可由检查程序传入固定时间，默认取本次导出的UTC时间。
function formatParameterExport(values, matchesDevice, exportedAt = new Date()) {
  const boat = BOAT_FIELDS.map(([key, field, note]) => [field, `${values[key]}U`, note]);
  // 这两项默认值定义在头文件，初始化表沿用宏名，避免同一参数出现两处数字副本。
  boat.push(['max_target_mm_s', 'BOAT_SPEED_DEFAULT_TARGET_MM_S', '最大目标船速，见头文件']);
  boat.push(['target_slew_step_mm_s', 'BOAT_SPEED_DEFAULT_TARGET_SLEW_STEP_MM_S', '目标步长，见头文件']);
  const heading = HEADING_FIELDS.map(([key, field, note]) => [field, `${values[key]}U`, note]);
  // 手机方向采用0/1协议值；C安装方向宏展开为+1/-1，不能直接把0/1写回方向宏。
  const direction = value => value === 1 ? 'MOTOR_DIRECTION_REVERSE' : 'MOTOR_DIRECTION_FORWARD';
  return [
    '/* 无人船监控平台 · 参数导出（20项，参数协议v5）',
    ` * 导出时间：${exportedAt.toISOString()}（UTC）`,
    ' * 来源：当前表单。',
    matchesDevice
      ? ' * 状态：与最近一次设备响应确认的参数一致；此操作不确认Flash是否已保存。'
      : ' * 状态：包含未写入设备的表单修改（草稿），请确认已完成调试后再用于默认值。',
    ' * 按下列文件路径替换原有同名宏；多行宏需从#define到结束的}完整替换。',
    ' * 单位：2 X2=1% PWM；1000 mm/s=1 m/s；航向增益X100；100 cdeg=1度。',
    ' * 已有合法Flash存档优先于编译默认值；修改代码并烧录后，旧存档仍可能生效。',
    ' * 如需设备采用这组值，请在小程序写入参数，调试确认后显式写入Flash。',
    ' */',
    '',
    '/* 1. Core/Inc/motor_control_config.h：分别替换以下3个宏 */',
    `#define MOTOR1_DIRECTION_SIGN ${direction(values.motor1Reversed)}`,
    `#define MOTOR2_DIRECTION_SIGN ${direction(values.motor2Reversed)}`,
    `#define MOTOR_REMOTE_TURN_AT_FULL_SPEED_PERCENT ${values.turnAtFullSpeedPercent}U`,
    '',
    '/* 2. Core/Inc/boat_speed_control.h：替换最大船速和目标变化步长 */',
    `#define BOAT_SPEED_DEFAULT_TARGET_MM_S ${values.maxTargetMmS}U`,
    `#define BOAT_SPEED_DEFAULT_TARGET_SLEW_STEP_MM_S ${values.targetSlewStepMmS}U`,
    '',
    '/* 3. Core/Src/boat_speed_control.c：完整替换BOAT_SPEED_DEFAULT_PARAMS */',
    initializer('BOAT_SPEED_DEFAULT_PARAMS', boat),
    '',
    '/* 4. Core/Src/heading_control.c：完整替换HEADING_DEFAULTS */',
    initializer('HEADING_DEFAULTS', heading),
    ''
  ].join('\n');
}

module.exports = { formatParameterExport };
