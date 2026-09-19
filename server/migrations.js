import { GAME_VERSION, MIN_SUPPORTED_SAVE_VERSION } from './engine.js';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 存档版本被拒绝（来自更新版本或已停止支持的远古版本）时抛出。
// 该错误属于硬拒绝：加载流程不得移动、备份或覆盖原文件。
export class SaveVersionError extends Error {
  constructor(message, { version, kind }) {
    super(message);
    this.name = 'SaveVersionError';
    this.version = version;
    this.kind = kind; // 'newer' | 'too-old'
  }
}

function migrateV1ToV2(state) {
  // v2 新增本局累计航程，旧档补齐为 0 后继续累计。
  if (!Number.isFinite(state.totalDistance) || state.totalDistance < 0) {
    state.totalDistance = 0;
  }

  // v2 要求每封邮件都带 lastPenaltyDay（积压每日重复扣分的幂等标记）。
  if (!Array.isArray(state.letters)) {
    throw new Error('letters 字段缺失或不是数组。');
  }
  for (const letter of state.letters) {
    if (!isPlainObject(letter)) {
      throw new Error('存在损坏的邮件记录。');
    }
    if (!Object.hasOwn(letter, 'lastPenaltyDay')) {
      letter.lastPenaltyDay = null;
    }
  }

  state.version = 2;
  return state;
}

// 注册表下标 n 的迁移负责把存档从版本 n+1 升级到 n+2。
// 新增版本时只需在这里追加迁移函数，并同步提高 GAME_VERSION。
const MIGRATIONS = {
  1: migrateV1ToV2
};

export function migrateStoredState(rawState) {
  if (!isPlainObject(rawState) || !Number.isInteger(rawState.version)) {
    throw new Error('存档缺少整数 version 字段，无法确定迁移路径。');
  }

  const originalVersion = rawState.version;
  if (originalVersion > GAME_VERSION) {
    throw new SaveVersionError(
      `存档版本 v${originalVersion} 来自更新的游戏，当前程序最高支持 v${GAME_VERSION}，请升级游戏后再读取该存档。原文件保持不变。`,
      { version: originalVersion, kind: 'newer' }
    );
  }
  if (originalVersion < MIN_SUPPORTED_SAVE_VERSION) {
    throw new SaveVersionError(
      `存档版本 v${originalVersion} 已停止支持（最低支持 v${MIN_SUPPORTED_SAVE_VERSION}），无法迁移。原文件保持不变。`,
      { version: originalVersion, kind: 'too-old' }
    );
  }

  let state = rawState;
  for (let nextVersion = originalVersion; nextVersion < GAME_VERSION; nextVersion += 1) {
    const migrate = MIGRATIONS[nextVersion];
    if (typeof migrate !== 'function') {
      throw new Error(`缺少 v${nextVersion} 到 v${nextVersion + 1} 的迁移路径。`);
    }
    try {
      state = migrate(state);
    } catch (error) {
      if (error instanceof SaveVersionError) throw error;
      throw new Error(`存档从 v${nextVersion} 迁移到 v${nextVersion + 1} 失败：${error.message}`);
    }
    if (!isPlainObject(state) || state.version !== nextVersion + 1) {
      throw new Error(`存档从 v${nextVersion} 迁移到 v${nextVersion + 1} 后版本号不正确。`);
    }
  }
  return { state, migrated: state.version !== originalVersion };
}
