/*
 * UART4 状态帧解包器。
 *
 * 固定帧格式来自 STM32 工程的 uart4_telemetry.h：
 *   0..1   A5 5A 帧头
 *   2      version
 *   3      message type（状态帧 = 1）
 *   4      length（固定 64）
 *   5      全局状态位
 *   6..9   发送序号，小端 uint32
 *   10..13 HAL tick，小端 uint32
 *   14..37 电机 1，24 字节
 *   38..61 电机 2，24 字节
 *   62..63 CRC-16/CCITT-FALSE，小端
 *
 * BLE 通知一次携带的字节数不固定，可能小于或大于一帧，因此这里使用
 * 可跨通知保留的滑动缓冲区，而不是假设“一次通知就是一帧”。
 * 参数读写使用同一帧头和 CRC，独立版本 v5 / 56 字节：读取请求 0x10、
 * 临时写入 0x11、保存 Flash 0x12、响应 0x90；20 个 uint16 位于 14..53，CRC 位于 54..55；
 * 参数响应不会参与状态帧序号统计。
 * RTK 使用 0x02 / v2 / 40 字节帧，兼容旧 v1/28 字节速度帧。
 * 原始 IMU 使用 0x04 / v1 / 36 字节，独立携带三轴角速度、欧拉角与源标志。
 */

const { HEADING_PARAMETER_KEYS } = require('./headingParameters');

const UART4 = {
  SYNC0: 0xA5,
  SYNC1: 0x5A,
  VERSION: 1,
  MESSAGE_STATUS: 1,
  MESSAGE_VELOCITY: 0x02,
  MESSAGE_BOAT: 0x03,
  MESSAGE_IMU: 0x04,
  MESSAGE_PARAMETER_READ_REQUEST: 0x10,
  MESSAGE_PARAMETER_WRITE_REQUEST: 0x11,
  MESSAGE_PARAMETER_SAVE_REQUEST: 0x12,
  MESSAGE_PARAMETER_RESPONSE: 0x90,
  FRAME_SIZE: 64,
  BOAT_VERSION: 2,
  BOAT_FRAME_SIZE: 36,
  IMU_VERSION: 1,
  IMU_FRAME_SIZE: 36,
  VELOCITY_FRAME_SIZE: 28,
  RTK_VERSION: 2,
  RTK_FRAME_SIZE: 40,
  PARAMETER_VERSION: 5,
  PARAMETER_FRAME_SIZE: 56,
  PARAMETER_COUNT: 20,
  MOTOR1_OFFSET: 14,
  MOTOR2_OFFSET: 38,
  MOTOR_SIZE: 24,
  UNKNOWN_AGE: 0xFFFF
};

// 计算 CRC-16/CCITT-FALSE；start/length 允许直接校验帧中的业务区间。
function crc16CcittFalse(bytes, start = 0, length = bytes.length - start) {
  if (!bytes || start < 0 || length < 0 || start + length > bytes.length) {
    return 0;
  }

  let crc = 0xFFFF;
  for (let i = start; i < start + length; i += 1) {
    crc ^= bytes[i] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xFFFF;
    }
  }
  return crc;
}

// 协议全部采用小端序。带符号 16 位字段需手动执行补码还原。
function readU16LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function readI16LE(bytes, offset) {
  const value = readU16LE(bytes, offset);
  return value & 0x8000 ? value - 0x10000 : value;
}

function readU32LE(bytes, offset) {
  // 最高字节使用乘法而不是左移，避免 JavaScript 有符号 32 位移位产生符号扩展。
  return (bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] * 0x1000000)) >>> 0;
}

// 写入函数只保留目标位宽，调用方负责在编码前做业务范围校验。
function writeU16LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
}

function writeU32LE(bytes, offset, value) {
  bytes[offset] = value & 0xFF;
  bytes[offset + 1] = (value >>> 8) & 0xFF;
  bytes[offset + 2] = (value >>> 16) & 0xFF;
  bytes[offset + 3] = (value >>> 24) & 0xFF;
}

// 微信 BLE API 返回 ArrayBuffer，单元测试通常传 Uint8Array；统一为只读字节视图。
function normalizeBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (input && input.buffer instanceof ArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }
  return new Uint8Array(0);
}

// 将一条固定 24 字节电机记录转换为页面使用的工程单位。
function decodeMotor(bytes, base) {
  const motorFlags = bytes[base];
  const feedbackAgeMs = readU16LE(bytes, base + 20);
  return {
    statusFlags: motorFlags,
    received: (motorFlags & 0x01) !== 0,
    displayValid: (motorFlags & 0x02) !== 0,
    feedbackFresh: (motorFlags & 0x04) !== 0,
    reverse: (motorFlags & 0x08) !== 0,
    temperatureC: bytes[base + 1],
    voltageV: readU16LE(bytes, base + 2) / 100,
    currentA: readU16LE(bytes, base + 4) / 100,
    capacityMah: readU16LE(bytes, base + 6),
    electricalRpm: readU32LE(bytes, base + 8),
    mechanicalRpm: readU32LE(bytes, base + 12),
    targetRpm: readI16LE(bytes, base + 16),
    appliedPwmX2: readI16LE(bytes, base + 18),
    appliedPwmPercent: readI16LE(bytes, base + 18) / 2,
    feedbackAgeMs: feedbackAgeMs === UART4.UNKNOWN_AGE ? null : feedbackAgeMs,
    telemetrySequence: readU16LE(bytes, base + 22)
  };
}

// 解码独立的 64 字节状态帧；帧头、版本、类型、长度和 CRC 必须全部通过。
function decodeFrame(bytes) {
  const data = normalizeBytes(bytes);
  if (data.length !== UART4.FRAME_SIZE) {
    return null;
  }

  // 对外暴露的解码入口也做完整校验，避免调用方误用未验证的字节。
  if (data[0] !== UART4.SYNC0 ||
      data[1] !== UART4.SYNC1 ||
      data[2] !== UART4.VERSION ||
      data[3] !== UART4.MESSAGE_STATUS ||
      data[4] !== UART4.FRAME_SIZE) {
    return null;
  }
  const expectedCrc = readU16LE(data, 62);
  if (expectedCrc !== crc16CcittFalse(data, 2, 60)) {
    return null;
  }

  return {
    version: data[2],
    messageType: data[3],
    length: data[4],
    statusFlags: data[5],
    sbusLinkValid: (data[5] & 0x01) !== 0,
    speedLoop: (data[5] & 0x02) !== 0,
    sbusFrameLost: (data[5] & 0x04) !== 0,
    sbusFailsafe: (data[5] & 0x08) !== 0,
    motor1Received: (data[5] & 0x10) !== 0,
    motor2Received: (data[5] & 0x20) !== 0,
    motor1Fresh: (data[5] & 0x40) !== 0,
    motor2Fresh: (data[5] & 0x80) !== 0,
    sequence: readU32LE(data, 6),
    timestampMs: readU32LE(data, 10),
    motors: [
      decodeMotor(data, UART4.MOTOR1_OFFSET),
      decodeMotor(data, UART4.MOTOR2_OFFSET)
    ]
  };
}

// 按协议字段顺序输出数组，确保写入帧的 20 个 uint16 不会错位。
function normalizeParameterValues(parameters) {
  const values = parameters || {};
  const names = [
    'feedforwardX2PerMps',
    'kpX2PerMps',
    'kiX2PerMpsS',
    'kdX2PerMps2',
    'integralLimitX2',
    'correctionLimitX2',
    'outputLimitX2',
    'outputSlewStepX2',
    'turnAtFullSpeedPercent',
    'motor1Reversed',
    'motor2Reversed',
    'maxTargetMmS',
    'targetSlewStepMmS',
    ...HEADING_PARAMETER_KEYS
  ];
  return names.map((name) => {
    const value = Number(values[name]);
    if (!Number.isInteger(value) || value < 0 || value > 0xFFFF) {
      throw new Error(`参数 ${name} 必须是 0 到 65535 的整数`);
    }
    if ((name === 'motor1Reversed' || name === 'motor2Reversed' || name === 'headingReversed') && value > 1) {
      throw new Error('方向只能为 0（正向）或 1（反向）');
    }
    return value;
  });
}

// 构造参数读取请求。未使用的状态/时间戳/参数字节保持为 0。
function encodeParameterReadRequest(requestSequence = 0) {
  const bytes = new Uint8Array(UART4.PARAMETER_FRAME_SIZE);
  bytes[0] = UART4.SYNC0;
  bytes[1] = UART4.SYNC1;
  bytes[2] = UART4.PARAMETER_VERSION;
  bytes[3] = UART4.MESSAGE_PARAMETER_READ_REQUEST;
  bytes[4] = UART4.PARAMETER_FRAME_SIZE;
  writeU32LE(bytes, 6, requestSequence >>> 0);
  const crcOffset = UART4.PARAMETER_FRAME_SIZE - 2;
  writeU16LE(bytes, crcOffset,
    crc16CcittFalse(bytes, 2, UART4.PARAMETER_FRAME_SIZE - 4));
  return bytes;
}

// 构造参数写入请求；STM32 仍会对每项执行更严格的业务安全范围校验。
function encodeParameterWriteRequest(requestSequence, parameters) {
  const bytes = new Uint8Array(UART4.PARAMETER_FRAME_SIZE);
  const values = normalizeParameterValues(parameters);
  bytes[0] = UART4.SYNC0;
  bytes[1] = UART4.SYNC1;
  bytes[2] = UART4.PARAMETER_VERSION;
  bytes[3] = UART4.MESSAGE_PARAMETER_WRITE_REQUEST;
  bytes[4] = UART4.PARAMETER_FRAME_SIZE;
  writeU32LE(bytes, 6, requestSequence >>> 0);
  values.forEach((value, index) => writeU16LE(bytes, 14 + index * 2, value));
  const crcOffset = UART4.PARAMETER_FRAME_SIZE - 2;
  writeU16LE(bytes, crcOffset,
    crc16CcittFalse(bytes, 2, UART4.PARAMETER_FRAME_SIZE - 4));
  return bytes;
}

// 保存命令只持久化设备当前生效值；附带整组预期值供 STM32 比对，不隐式调参。
function encodeParameterSaveRequest(requestSequence, parameters) {
  const bytes = encodeParameterWriteRequest(requestSequence, parameters);
  bytes[3] = UART4.MESSAGE_PARAMETER_SAVE_REQUEST;
  writeU16LE(bytes, bytes.length - 2, crc16CcittFalse(bytes, 2, bytes.length - 4));
  return bytes;
}

// 参数响应与请求使用相同的 v5 / 56 字节布局，status 位于偏移 5。
function decodeParameterFrame(bytes) {
  const data = normalizeBytes(bytes);
  if (data.length !== UART4.PARAMETER_FRAME_SIZE ||
      data[0] !== UART4.SYNC0 ||
      data[1] !== UART4.SYNC1 ||
      data[2] !== UART4.PARAMETER_VERSION ||
      data[3] !== UART4.MESSAGE_PARAMETER_RESPONSE ||
      data[4] !== UART4.PARAMETER_FRAME_SIZE) {
    return null;
  }
  const crcOffset = UART4.PARAMETER_FRAME_SIZE - 2;
  if (readU16LE(data, crcOffset) !==
      crc16CcittFalse(data, 2, UART4.PARAMETER_FRAME_SIZE - 4)) {
    return null;
  }
  const values = [
    'feedforwardX2PerMps',
    'kpX2PerMps',
    'kiX2PerMpsS',
    'kdX2PerMps2',
    'integralLimitX2',
    'correctionLimitX2',
    'outputLimitX2',
    'outputSlewStepX2',
    'turnAtFullSpeedPercent',
    'motor1Reversed',
    'motor2Reversed',
    'maxTargetMmS',
    'targetSlewStepMmS',
    ...HEADING_PARAMETER_KEYS
  ];
  const parameters = {};
  values.forEach((name, index) => {
    parameters[name] = readU16LE(data, 14 + index * 2);
  });
  return {
    version: data[2],
    messageType: data[3],
    length: data[4],
    status: data[5],
    requestSequence: readU32LE(data, 6),
    timestampMs: readU32LE(data, 10),
    parameters
  };
}

// v2 保留旧速度/年龄偏移，26..37 新增经纬度、航向、有效位；Z 不再使用。
function decodeVelocityFrame(bytes) {
  const data = normalizeBytes(bytes);
  const hasNavigation = data.length === UART4.RTK_FRAME_SIZE && data[2] === UART4.RTK_VERSION;
  const legacy = data.length === UART4.VELOCITY_FRAME_SIZE && data[2] === UART4.VERSION;
  if ((!hasNavigation && !legacy) ||
      data[0] !== UART4.SYNC0 || data[1] !== UART4.SYNC1 ||
      data[3] !== UART4.MESSAGE_VELOCITY || data[4] !== data.length ||
      readU16LE(data, data.length - 2) !== crc16CcittFalse(data, 2, data.length - 4)) {
    return null;
  }
  const age = readU16LE(data, 20);
  const result = {
    version: data[2],
    messageType: data[3],
    sequence: readU32LE(data, 6),
    timestampMs: readU32LE(data, 10),
    velocity: {
      received: !!(data[5] & 0x01),
      fresh: (data[5] & 0x03) === 0x03,
      xMps: readI16LE(data, 14) / 1000,
      yMps: readI16LE(data, 16) / 1000,
      zRadps: readI16LE(data, 18) / 1000,
      ageMs: age === UART4.UNKNOWN_AGE ? null : age,
      receivedMs: readU32LE(data, 22)
    }
  };
  if (hasNavigation) {
    // 位运算显式恢复有符号 int32；uint16 航向才能表示大于 327.67 度的值。
    const latitude = (readU32LE(data, 26) | 0) / 1e7;
    const longitude = (readU32LE(data, 30) | 0) / 1e7;
    const headingDegrees = readU16LE(data, 34) / 100;
    Object.assign(result.velocity, {
      hasNavigation: true, zRadps: null, latitude, longitude, headingDegrees,
      sourceFlags: data[36],
      fixValid: !!(data[36] & 1) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180,
      velocityValid: !!(data[36] & 2),
      headingValid: !!(data[36] & 4) && headingDegrees < 360,
      timeAligned: !!(data[36] & 8)
    });
  }
  return result;
}

// 船体遥测独立于原始RTK帧：船速曲线使用PID实际采用的三点中值合速率。
// v1/28只有船速信息，v2/36追加航向及三模式；必须同时检查版本、类型和长度。
function decodeBoatFrame(bytes) {
  const data = normalizeBytes(bytes);
  const hasHeading = data.length === UART4.BOAT_FRAME_SIZE && data[2] === UART4.BOAT_VERSION;
  const legacy = data.length === 28 && data[2] === UART4.VERSION;
  if ((!hasHeading && !legacy) || data[0] !== UART4.SYNC0 || data[1] !== UART4.SYNC1 ||
      data[3] !== UART4.MESSAGE_BOAT || data[4] !== data.length ||
      readU16LE(data, data.length - 2) !== crc16CcittFalse(data, 2, data.length - 4)) return null;
  // 模式/目标角非法时丢弃整帧；实测航向非法只清有效位，仍可显示模式与其他状态。
  if (hasHeading && (data[32] > 2 || readU16LE(data, 26) >= 36000)) return null;
  return {
    version: data[2], messageType: data[3],
    sequence: readU32LE(data, 6), timestampMs: readU32LE(data, 10),
    boat: {
      speedLoop: hasHeading ? data[32] !== 0 : !!(data[5] & 1), feedbackValid: !!(data[5] & 2),
      controlMode: hasHeading ? data[32] : (data[5] & 1 ? 1 : 0),
      hasHeading,
      headingValid: hasHeading && !!(data[33] & 1) && readU16LE(data, 28) < 36000,
      controlEnabled: hasHeading ? !!(data[33] & 2) : null,
      // cdeg转为度；角差必须按int16还原，才能正确显示向另一方向修正的负角差。
      targetHeading: hasHeading ? readU16LE(data, 26) / 100 : null,
      actualHeading: hasHeading ? readU16LE(data, 28) / 100 : null,
      headingError: hasHeading ? readI16LE(data, 30) / 100 : null,
      sbusValid: !!(data[5] & 4), motorsValid: !!(data[5] & 8),
      reversing: !!(data[5] & 16), received: !!(data[5] & 32),
      targetMps: readI16LE(data, 14) / 1000,
      actualMps: readU16LE(data, 16) / 1000,
      commonPercent: readI16LE(data, 18) / 2,
      ageMs: readU16LE(data, 20) === UART4.UNKNOWN_AGE ? null : readU16LE(data, 20),
      requestedMps: readI16LE(data, 22) / 1000,
      turnPercent: readI16LE(data, 24) / 2
    }
  };
}

// 原始IMU保持自身局部yaw，不与船体帧中的融合罗盘航向混用。
function decodeImuFrame(bytes) {
  const data = normalizeBytes(bytes);
  if (data.length !== UART4.IMU_FRAME_SIZE || data[0] !== UART4.SYNC0 || data[1] !== UART4.SYNC1 ||
      data[2] !== UART4.IMU_VERSION || data[3] !== UART4.MESSAGE_IMU || data[4] !== data.length ||
      readU16LE(data, 34) !== crc16CcittFalse(data, 2, 32)) return null;
  const gyroRadps = [14, 16, 18].map(offset => readI16LE(data, offset) / 1000);
  const eulerDegrees = [20, 22, 24].map(offset => readI16LE(data, offset) / 100);
  const sourceFlags = data[32] & 0x7F;
  const age = readU16LE(data, 26);
  return {
    version: data[2], messageType: data[3], sequence: readU32LE(data, 6), timestampMs: readU32LE(data, 10),
    imu: {
      received: !!(data[5] & 1), fresh: (data[5] & 3) === 3,
      gyroRadps, rollDegrees: eulerDegrees[0], pitchDegrees: eulerDegrees[1], yawDegrees: eulerDegrees[2],
      ageMs: age === UART4.UNKNOWN_AGE ? null : age, receivedMs: readU32LE(data, 28), sourceFlags,
      gyroValid: !!(sourceFlags & 0x20) && gyroRadps.every(value => Math.abs(value) <= 20),
      eulerValid: !!(sourceFlags & 0x40) && Math.abs(eulerDegrees[0]) <= 180 &&
        Math.abs(eulerDegrees[1]) <= 90 && Math.abs(eulerDegrees[2]) <= 180,
      timeAligned: !!(sourceFlags & 8), headingAvailable: !!(sourceFlags & 4),
      headingFresh: (sourceFlags & 0x14) === 0x14
    }
  };
}

/*
 * BLE 字节流解析器。
 * 通知可能拆包、粘包或从半帧开始，因此实例长期保留未消费字节；每次 push
 * 可以返回 0 到多帧。坏头或坏 CRC 只丢一个字节，再从下一字节继续同步。
 */
class UART4StreamParser {
  constructor() {
    this.buffer = [];
    this.resetStats();
  }

  resetStats() {
    // lastSequence 只跟踪周期状态帧，按需参数响应不会造成“序号跳变”。
    this.stats = {
      bytesReceived: 0,
      framesReceived: 0,
      syncHits: 0,
      crcErrors: 0,
      invalidHeaders: 0,
      droppedBytes: 0,
      sequenceGaps: 0,
      lastSequence: null
    };
  }

  reset() {
    // 主动断开或清除页面数据时，同时清理半帧和诊断计数。
    this.buffer = [];
    this.resetStats();
  }

  push(input) {
    const bytes = normalizeBytes(input);
    const frames = [];
    this.stats.bytesReceived += bytes.length;
    // 统计输入流中真实出现过的 A5 5A，避免把“没有帧头”和“帧头存在但 CRC 错误”混为一谈。
    for (let i = 1; i < bytes.length; i += 1) {
      if (bytes[i - 1] === UART4.SYNC0 && bytes[i] === UART4.SYNC1) {
        this.stats.syncHits += 1;
      }
    }
    // 先完整追加本次通知，随后循环提取其中可能包含的多帧数据。
    for (let i = 0; i < bytes.length; i += 1) {
      this.buffer.push(bytes[i]);
    }

    while (this.buffer.length >= 2) {
      let syncIndex = -1;
      for (let i = 0; i < this.buffer.length - 1; i += 1) {
        if (this.buffer[i] === UART4.SYNC0 &&
            this.buffer[i + 1] === UART4.SYNC1) {
          syncIndex = i;
          break;
        }
      }

      if (syncIndex < 0) {
        // 保留末尾 A5，避免帧头被拆在两次 BLE 通知之间时丢失。
        const keepLast = this.buffer[this.buffer.length - 1] === UART4.SYNC0 ? 1 : 0;
        this.stats.droppedBytes += this.buffer.length - keepLast;
        this.buffer = keepLast ? [UART4.SYNC0] : [];
        break;
      }

      if (syncIndex > 0) {
        this.stats.droppedBytes += syncIndex;
        this.buffer.splice(0, syncIndex);
      }

      if (this.buffer.length < 5) {
        break;
      }

      // 电机、参数、新旧RTK、船体与IMU帧均可混合拆包/粘包接收。
      const frameSize = this.buffer[4];
      if (frameSize !== UART4.FRAME_SIZE &&
          frameSize !== UART4.PARAMETER_FRAME_SIZE && frameSize !== UART4.BOAT_FRAME_SIZE &&
          frameSize !== UART4.IMU_FRAME_SIZE &&
          frameSize !== UART4.VELOCITY_FRAME_SIZE && frameSize !== UART4.RTK_FRAME_SIZE) {
        this.stats.invalidHeaders += 1;
        this.stats.droppedBytes += 1;
        this.buffer.shift();
        continue;
      }

      if (this.buffer.length < frameSize) {
        break;
      }

      const candidate = new Uint8Array(this.buffer.slice(0, frameSize));
      const validHeader =
        (candidate[2] === UART4.IMU_VERSION && frameSize === UART4.IMU_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_IMU) ||
        (candidate[2] === UART4.BOAT_VERSION && frameSize === UART4.BOAT_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_BOAT) ||
        (candidate[2] === UART4.RTK_VERSION && frameSize === UART4.RTK_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_VELOCITY) ||
        (candidate[2] === UART4.PARAMETER_VERSION &&
         frameSize === UART4.PARAMETER_FRAME_SIZE &&
         candidate[3] === UART4.MESSAGE_PARAMETER_RESPONSE) ||
        (candidate[2] === UART4.VERSION &&
        ((frameSize === UART4.FRAME_SIZE && candidate[3] === UART4.MESSAGE_STATUS) ||
         (frameSize === UART4.VELOCITY_FRAME_SIZE &&
          (candidate[3] === UART4.MESSAGE_VELOCITY || candidate[3] === UART4.MESSAGE_BOAT))));
      const crcOffset = frameSize - 2;
      const expectedCrc = readU16LE(candidate, crcOffset);
      const actualCrc = crc16CcittFalse(candidate, 2, frameSize - 4);
      if (!validHeader || expectedCrc !== actualCrc) {
        if (!validHeader) {
          this.stats.invalidHeaders += 1;
        } else {
          this.stats.crcErrors += 1;
        }
        // 只丢一个字节再找帧头，兼容坏帧内部恰好出现 A5 5A 的情况。
        this.stats.droppedBytes += 1;
        this.buffer.shift();
        continue;
      }

      // 到这里头部和 CRC 已验证，具体解码函数再返回结构化对象。
      const frame = candidate[3] === UART4.MESSAGE_IMU ? decodeImuFrame(candidate) : frameSize === UART4.FRAME_SIZE
        ? decodeFrame(candidate)
        : frameSize === UART4.VELOCITY_FRAME_SIZE || frameSize === UART4.RTK_FRAME_SIZE || frameSize === UART4.BOAT_FRAME_SIZE
          ? (candidate[3] === UART4.MESSAGE_BOAT ? decodeBoatFrame(candidate) : decodeVelocityFrame(candidate))
          : decodeParameterFrame(candidate);
      if (frame) {
        if (frame.messageType === UART4.MESSAGE_STATUS) {
          if (this.stats.lastSequence !== null) {
            const expected = (this.stats.lastSequence + 1) >>> 0;
            if (frame.sequence !== expected) {
              this.stats.sequenceGaps += 1;
            }
          }
          this.stats.lastSequence = frame.sequence;
        }
        this.stats.framesReceived += 1;
        frames.push(frame);
      }
      this.buffer.splice(0, frameSize);
    }

    return frames;
  }

  getStats() {
    // bufferedBytes 用于判断 BLE 是否长期停在半帧或持续收到不完整数据。
    return { ...this.stats, bufferedBytes: this.buffer.length };
  }
}

module.exports = {
  UART4,
  crc16CcittFalse,
  decodeFrame,
  encodeParameterReadRequest,
  encodeParameterWriteRequest,
  encodeParameterSaveRequest,
  decodeParameterFrame,
  decodeVelocityFrame,
  decodeBoatFrame,
  decodeImuFrame,
  UART4StreamParser
};
