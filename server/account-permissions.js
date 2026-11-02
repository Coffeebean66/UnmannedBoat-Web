/* 驾驶员拥有单船操作权限；账号、接入和系统配置始终由管理员管理。 */
'use strict';
const ROLES = Object.freeze(['admin', 'driver', 'guest']);
const validRole = role => ROLES.includes(role);
const canOperate = user => user?.role === 'admin' || user?.role === 'driver';
module.exports = { validRole, canOperate };
