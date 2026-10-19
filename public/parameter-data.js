// 来自小程序的参数和说明快照，由 build-bundle.js --sync 生成。
window.BoatParameters = {
  "ranges": {
    "feedforwardX2PerMps": [
      0,
      200
    ],
    "kpX2PerMps": [
      0,
      1000
    ],
    "kiX2PerMpsS": [
      0,
      1000
    ],
    "kdX2PerMps2": [
      0,
      1000
    ],
    "integralLimitX2": [
      0,
      200
    ],
    "correctionLimitX2": [
      0,
      200
    ],
    "outputLimitX2": [
      1,
      200
    ],
    "outputSlewStepX2": [
      1,
      200
    ],
    "turnAtFullSpeedPercent": [
      0,
      100
    ],
    "motor1Reversed": [
      0,
      1
    ],
    "motor2Reversed": [
      0,
      1
    ],
    "maxTargetMmS": [
      100,
      20000
    ],
    "targetSlewStepMmS": [
      1,
      400
    ],
    "headingKpX100": [
      0,
      10000
    ],
    "headingKiX100": [
      0,
      10000
    ],
    "headingKdX100": [
      0,
      10000
    ],
    "headingIntegralLimitX2": [
      0,
      200
    ],
    "headingOutputLimitX2": [
      1,
      200
    ],
    "headingDeadbandCdeg": [
      0,
      3000
    ],
    "headingReversed": [
      0,
      1
    ]
  },
  "labels": {
    "feedforwardX2PerMps": "船速前馈",
    "kpX2PerMps": "KP",
    "kiX2PerMpsS": "KI",
    "kdX2PerMps2": "KD",
    "integralLimitX2": "积分限幅",
    "correctionLimitX2": "修正限幅",
    "outputLimitX2": "输出限幅",
    "outputSlewStepX2": "输出变化步长",
    "turnAtFullSpeedPercent": "满速差速转向比例",
    "motor1Reversed": "电机 1 方向",
    "motor2Reversed": "电机 2 方向",
    "maxTargetMmS": "最大目标船速",
    "targetSlewStepMmS": "目标船速变化步长",
    "headingKpX100": "航向 KP",
    "headingKiX100": "航向 KI",
    "headingKdX100": "航向 KD",
    "headingIntegralLimitX2": "航向积分限幅",
    "headingOutputLimitX2": "自动转向输出上限",
    "headingDeadbandCdeg": "航向误差死区",
    "headingReversed": "自动转向方向"
  },
  "tuning": {
    "feedforwardX2PerMps": 80,
    "kpX2PerMps": 80,
    "kiX2PerMpsS": 20,
    "kdX2PerMps2": 0,
    "integralLimitX2": 60,
    "correctionLimitX2": 200,
    "outputLimitX2": 200,
    "outputSlewStepX2": 8,
    "maxTargetMmS": 2500,
    "targetSlewStepMmS": 100
  },
  "help": [
    {
      "key": "headingKpX100",
      "name": "航向 KP",
      "min": 0,
      "max": 10000,
      "range": "0 - 10000，默认 200",
      "unit": "X100：200 = 2 X2/度 = 1% PWM/度",
      "description": "按目标与实测航向的最短角差产生差速。359°到1°按+2°修正，不会绕大圈。P越大，转向越有力。",
      "advice": "先用默认200和较小差速上限低速测试，每次增减20～50；来回摆头时降低。速度KP只控制前后推进，与此项独立。"
    },
    {
      "key": "headingKiX100",
      "name": "航向 KI",
      "min": 0,
      "max": 10000,
      "range": "0 - 10000，默认 0",
      "unit": "X100：100 = 1 X2/(度·秒)",
      "description": "累积持续航向偏差，用于抵消风流或两侧推力不一致。仅新反馈样本积分，混控受限或换向等待时停止同向积累。",
      "advice": "先保持0。P稳定后仍有持续偏差，再从5～10小步增加；缓慢来回摆头时降低，并检查积分限幅。"
    },
    {
      "key": "headingKdX100",
      "name": "航向 KD",
      "min": 0,
      "max": 10000,
      "range": "0 - 10000，默认 0",
      "unit": "X100：100 = 1 X2/(度/秒)",
      "description": "按实际航向角速度产生阻尼，跨0°取短角差；旋转目标旋钮不会直接产生微分冲击。",
      "advice": "先保持0；存在可重复过冲且航向稳定时从10小步增加。航向噪声大时D会放大抖动，优先降低。"
    },
    {
      "key": "headingIntegralLimitX2",
      "name": "航向积分限幅",
      "min": 0,
      "max": 200,
      "range": "0 - 200 X2，默认 30",
      "unit": "2 X2 = 1% PWM；默认15%",
      "description": "限制航向I项累积的最大差速贡献。KI为0时此项不会产生额外推力。",
      "advice": "先保持30；不要靠很大的积分弥补错误的转向方向。进入误差死区、关闭控制或反馈失效时积分清零。"
    },
    {
      "key": "headingOutputLimitX2",
      "name": "自动转向输出上限",
      "min": 1,
      "max": 200,
      "range": "1 - 200 X2，默认 60",
      "unit": "每侧差速上限；60 X2 = 30% PWM",
      "description": "航向PID最多产生的差速。电机1=共同推进+差速，电机2=共同推进−差速；混合后仍受总输出上限及PWM步长限制。",
      "advice": "先在低速确认方向。这个上限太小会转弯慢，太大会急转甚至触发电机换向等待；不受人工“满速差速比例”控制。"
    },
    {
      "key": "headingDeadbandCdeg",
      "name": "航向误差死区",
      "min": 0,
      "max": 3000,
      "range": "0 - 3000（0～30°），默认 200",
      "unit": "0.01°；200 = 2°",
      "description": "绝对航向误差不超过此值时，航向PID输出和积分归零，降低测量噪声引起的左右抖动；实际PWM仍按步长回落。",
      "advice": "先试2°；船头抖动可增加到3～5°，确认航向反馈精度后再缩小。设为0可能持续微调。"
    },
    {
      "key": "headingReversed",
      "name": "自动转向方向",
      "min": 0,
      "max": 1,
      "range": "正常 / 反向，默认正常",
      "unit": "只反转航向PID产生的差速",
      "description": "正常时正角差增大电机1、减小电机2；反向时相反。用于适配左右电机布局和上位机航向角增加的方向，不改变人工左右杆。",
      "advice": "CH6低档停稳后才能修改。首次低速测试小角差，若越修正偏差越大，应立即CH6低档停推，再反转本项；不要靠增大P纠正方向。"
    },
    {
      "key": "targetSlewStepMmS",
      "name": "目标船速变化步长",
      "range": "1 - 400 mm/s / 20 ms",
      "unit": "默认 100，约 5 m/s²；旧船速存档补为 40",
      "description": "同时限制加速和减速时目标船速的变化。100 时目标从 0 到 2.5 m/s 约需 0.5 秒；40、80、160 分别约为 2、4、8 m/s²。",
      "advice": "先试 100，出现冲击或超调可降低。这里只改变目标，实际加减速仍受推力、水流和惯性影响；PWM 步长独立限速，不自动反推刹车。调好后可保存手机预设或写入 Flash。"
    },
    {
      "key": "maxTargetMmS",
      "name": "最大目标船速",
      "range": "100 - 20000 mm/s（0.1～20 m/s）",
      "unit": "2500 mm/s = 2.5 m/s；默认 2500",
      "description": "CH3 满杆、CH6 高档且 CH10 最大时的目标速率。CH6 中档为此值的 40%。CH3 符号决定推进方向，实际反馈为 √(X²+Y²)。",
      "advice": "按实测最大 2.5 m/s 设定，CH6 中档满杆为 1.0 m/s。先试 0.5～1.0 m/s，再到 1.5～2.0 m/s，接近极限时调速余量小。速度模式人工转向，角度模式自动控制 CH9 指定的航向。"
    },
    {
      "key": "motor1Reversed",
      "name": "电机 1 方向",
      "range": "正向 / 反向",
      "unit": "安装方向映射；默认正向",
      "description": "正向表示正的遥控指令输出高于中位的 PWM，反向则输出低于中位的 PWM。开环和船速闭环同步生效。实际桨叶转向还取决于电机接线。",
      "advice": "先将 CH6 切到低档零倍率，等两路停止后写入。固件要求零输出、两路新鲜反馈均不超过 150 RPM 持续 1 秒，否则整组拒绝；此项不会单独启动电机。"
    },
    {
      "key": "motor2Reversed",
      "name": "电机 2 方向",
      "range": "正向 / 反向",
      "unit": "安装方向映射；默认反向",
      "description": "独立设置电机 2 的方向，不影响电机 1。两侧推进器安装相反时，通常需要相反的方向映射。",
      "advice": "停机要求同电机 1；写入成功后先用小油门确认前进和转向。调好后“写入 Flash”，上电自动恢复；没有有效存档时才使用固件默认方向。"
    },
    {
      "key": "feedforwardX2PerMps",
      "name": "船速前馈",
      "range": "0 - 200",
      "unit": "X2 / (m/s)",
      "description": "基础推进 = 前馈系数 × 目标船速绝对值（m/s）。默认 80，按 100% PWM 对应 2.5 m/s 粗估：200 X2 ÷ 2.5。",
      "advice": "如果 2.5 m/s 并非满输出测得，应按当时 PWM X2 ÷ 船速重估。单点线性近似在低速未必准确，正反向共用系数；低速过冲可减小前馈。"
    },
    {
      "key": "kpX2PerMps",
      "name": "KP",
      "range": "0 - 1000",
      "unit": "X2 / (m/s)",
      "description": "按目标速率绝对值与实测速率的误差立即产生比例修正，决定速度环对负载变化的反应力度。",
      "advice": "建议从 80 起，每次增减 10～20。先检查输出/修正限幅和 PWM 步长；已受限时把 P 调到 1000 也不会更快，反而可能使临近目标时抖动。"
    },
    {
      "key": "kiX2PerMpsS",
      "name": "KI",
      "range": "0 - 1000",
      "unit": "X2 / ((m/s)·s)",
      "description": "按误差随时间累积修正，用于消除前馈和 KP 留下的稳定误差。",
      "advice": "建议起点 20；响应已够快但仍有稳态误差时每次增加 5，出现慢速摆动或上冲时减小。需要单独调 P 时可先置 0。"
    },
    {
      "key": "kdX2PerMps2",
      "name": "KD",
      "range": "0 - 1000",
      "unit": "X2 / (m/s²)",
      "description": "根据实际船速变化率抑制快速过冲，相当于对变化趋势做阻尼。",
      "advice": "实际船速反馈有噪声和延迟，KD 要非常谨慎；出现 PWM 高频抖动时先降到 0。"
    },
    {
      "key": "integralLimitX2",
      "name": "积分限幅",
      "range": "0 - 200 X2",
      "unit": "I 项最大幅值",
      "description": "限制积分项能够长期累积的最大修正量，200 X2 约等于 100% 逻辑 PWM。",
      "advice": "过大容易积累后上冲，过小则可能留下稳态误差；前馈较准时通常不需要很大。"
    },
    {
      "key": "correctionLimitX2",
      "name": "修正限幅",
      "range": "0 - 200 X2",
      "unit": "P + I + D 最大幅值",
      "description": "限制 PID 合成修正量，前馈输出仍会单独参与最终输出计算。",
      "advice": "太小会导致负载变化时补偿不够；太大可能让参数突变带来明显推力变化。"
    },
    {
      "key": "outputLimitX2",
      "name": "输出限幅",
      "range": "1 - 200 X2",
      "unit": "最终逻辑 PWM 上限",
      "description": "限制前馈与 PID 修正相加后的最终逻辑输出，是速度和推力的最后一道上限。",
      "advice": "2.5 m/s 建议值为 200 X2（允许 100% PWM）；原默认 40 X2 只有 20%。已到 100% 仍慢应降低目标、检查推力与供电，继续加 P 无法提高上限。"
    },
    {
      "key": "outputSlewStepX2",
      "name": "输出变化步长",
      "range": "1 - 200 X2",
      "unit": "每 20 ms",
      "description": "默认 8 X2，每 20 ms 最多变化 4% PWM；连续饱和指令从零爬至 100% 约 0.5 秒。原 1 X2 需要约 4 秒。反馈丢失时直接停推。",
      "advice": "增大响应更快，减小推力更柔和；过小会掩盖 PID 效果。实际还受目标斜坡和反馈就绪时间影响，推力冲击明显时可降到 4。"
    },
    {
      "key": "turnAtFullSpeedPercent",
      "name": "满速差速转向比例",
      "range": "0 - 100 %",
      "unit": "满速前进/后退时的转向保留量",
      "description": "PWM/速度模式中，前进或后退量越大，人工差速转向量会从 100% 平滑降低到该比例；原地转向不受影响。角度模式使用独立的自动转向上限。",
      "advice": "0% 为满速直行，50% 为常用折中，100% 保留完整差速；船体偏航不足时再逐步提高。"
    }
  ],
  "steps": [
    {
      "title": "角度模式：先核对航向和转向方向",
      "text": "CH5：282 PWM、1002速度、1722角度；CH9：0～359°。角度模式忽略左右杆，CH3前后杆控制船速。CH6低档全停，中档40%、高档由CH10调节；非零档位中前后杆归中仍可原地转向。先低速测试10°偏差，若越转偏差越大，立即CH6低档，停稳后反转“自动转向方向”。航向0°及增加方向沿用上位机，须确认它是真实船头朝向而非运动航迹角。"
    },
    {
      "title": "1. 先确认基线",
      "text": "点击“读取参数”，确认反馈稳定、方向正确；每次只改一个参数，并先清空 PID 曲线。"
    },
    {
      "title": "2. 应用 2.5 m/s 起始参数",
      "text": "先停推，读取后点击“填入 2.5 m/s 建议值”，再“写入参数”：前馈80、P80、I20、D0、输出上限200 X2（100%）、PWM步长8。先试0.5～1.0 m/s；已有 Flash 不会因更新固件自动换成新值。"
    },
    {
      "title": "3. 调 KP 再调 KI",
      "text": "保持 KI=0 逐步增加 KP，直到响应够快且不持续振荡；再从 KI=0 小步增加以消除稳态误差。"
    },
    {
      "title": "4. KD 只在必要时使用",
      "text": "反馈噪声较大时通常保持 KD=0；只有快速过冲稳定复现时才从很小的值尝试。"
    },
    {
      "title": "5. 区分目标慢与推力不足",
      "text": "目标橙线变化慢看目标步长；PWM 爬升慢看输出步长；PWM 已到上限则检查目标是否超过实际能力。目标默认步长100，即约5 m/s²；它不保证船体有同样加速度，也不会主动反推刹车。"
    },
    {
      "title": "6. 调好后保存",
      "text": "“写入参数”临时生效；“保存当前”存入手机预设；“写入 Flash”将设备已生效的全部 20 项参数掉电保存。将 CH6 切到低档，等待两路停止且反馈正常满 1 秒，点击写入 Flash 并保持供电直到成功。"
    }
  ]
};
