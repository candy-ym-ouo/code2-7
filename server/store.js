import fs from 'node:fs';
import path from 'node:path';
import {
  GameRuleError,
  createInitialState,
  GAME_VERSION,
  MIN_SUPPORTED_SAVE_VERSION,
  migrateState
} from './engine.js';

export class SaveRejectedError extends Error {
  constructor(message, { code, saveVersion } = {}) {
    super(message);
    this.name = 'SaveRejectedError';
    this.code = code;
    this.saveVersion = saveVersion;
  }
}

const VALID_PHASES = new Set(['planning', 'completed', 'failed']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasValidStats(stats) {
  return isPlainObject(stats)
    && ['totalDelivered', 'totalOnTime', 'totalLate', 'totalWrong', 'totalBacklog'].every(
      (field) => Number.isInteger(stats[field]) && stats[field] >= 0
    );
}

function hasUniqueIds(items) {
  const ids = items.map((item) => item?.id);
  return ids.every((id) => typeof id === 'string' && id.length > 0) && new Set(ids).size === ids.length;
}

function hasValidReport(report) {
  if (report == null) return true;
  if (!isPlainObject(report)) return false;
  if (!Number.isInteger(report.day)) return false;
  if (!Number.isFinite(report.reputationBefore) || !Number.isFinite(report.reputationAfter)) return false;
  if (!Number.isFinite(report.reputationDelta) || !Number.isFinite(report.creditsDelta)) return false;
  if (!Number.isFinite(report.creditsBefore) || !Number.isFinite(report.creditsAfter)) return false;
  if (!Number.isInteger(report.streak)) return false;
  if (report.generatedNextDay !== null && !Number.isInteger(report.generatedNextDay)) return false;
  if (!Array.isArray(report.routes) || !Array.isArray(report.unassignedLetterIds) || !Array.isArray(report.relationChanges)) return false;
  if (!report.unassignedLetterIds.every((letterId) => typeof letterId === 'string')) return false;
  if (!report.routes.every((route) => (
    typeof route?.courierId === 'string' &&
    typeof route.courierName === 'string' &&
    Number.isInteger(route.letterCount) &&
    Number.isFinite(route.totalDistance) &&
    Array.isArray(route.letters) &&
    route.letters.every((letter) => (
      typeof letter?.letterId === 'string' &&
      typeof letter.targetName === 'string' &&
      ['on-time', 'late', 'wrong', 'wrong-late'].includes(letter.outcome) &&
      Number.isFinite(letter.arrivalHour) &&
      typeof letter.wrong === 'boolean' &&
      typeof letter.late === 'boolean'
    ))
  ))) return false;
  return report.relationChanges.every((change) => (
    typeof change?.key === 'string' &&
    typeof change.firstIslandName === 'string' &&
    typeof change.secondIslandName === 'string' &&
    Number.isFinite(change.delta) &&
    Array.isArray(change.reasons) &&
    change.reasons.every((reason) => typeof reason === 'string')
  ));
}

function hasValidEnding(ending) {
  if (ending == null) return true;
  if (!isPlainObject(ending)) return false;
  return (
    ['completed', 'failed'].includes(ending.type) &&
    typeof ending.title === 'string' &&
    typeof ending.message === 'string' &&
    typeof ending.rank === 'string'
  );
}

function hasValidStateShape(state, expectedVersion = state.version) {
  if (!isPlainObject(state)) return false;
  if (!Number.isInteger(state.version) || state.version !== expectedVersion) return false;
  if (typeof state.seed !== 'string') return false;
  if (!Number.isInteger(state.day) || !Number.isInteger(state.days)) return false;
  if (state.day < 1 || state.days < 1 || state.day > state.days) return false;
  if (!VALID_PHASES.has(state.phase)) return false;
  if (!Number.isFinite(state.reputation) || state.reputation < 0 || state.reputation > 100) return false;
  if (!Number.isFinite(state.credits) || state.credits < 0) return false;
  if (!Number.isInteger(state.streak) || state.streak < 0) return false;
  if (!Number.isInteger(state.revision) || state.revision < 0) return false;
  if (expectedVersion >= 2 && !hasValidStats(state.stats)) return false;
  if (!Array.isArray(state.islands) || !Array.isArray(state.couriers)) return false;
  if (!Array.isArray(state.letters) || !Array.isArray(state.history)) return false;
  if (!isPlainObject(state.wind) || !isPlainObject(state.relations)) return false;
  if (!hasValidReport(state.lastReport)) return false;
  if (!hasValidEnding(state.ending)) return false;
  if (state.phase === 'planning' && state.ending != null) return false;
  if (state.phase !== 'planning' && !hasValidEnding(state.ending)) return false;

  if (!hasUniqueIds(state.islands) || !hasUniqueIds(state.couriers) || !hasUniqueIds(state.letters)) return false;
  if (!state.islands.every((island) => (
    typeof island.name === 'string' &&
    typeof island.code === 'string' &&
    typeof island.color === 'string' &&
    isPlainObject(island.position) &&
    Number.isFinite(island.position.x) &&
    Number.isFinite(island.position.y)
  ))) return false;
  if (!state.islands.some((island) => island.id === 'skyport')) return false;
  if (!state.couriers.every((courier) => (
    typeof courier.name === 'string' &&
    typeof courier.callSign === 'string' &&
    typeof courier.color === 'string' &&
    typeof courier.description === 'string' &&
    Number.isFinite(courier.capacity) &&
    courier.capacity > 0 &&
    Number.isInteger(courier.maxLetters) &&
    courier.maxLetters > 0 &&
    Number.isFinite(courier.baseSpeed) &&
    courier.baseSpeed > 0
  ))) return false;

  const islandIds = new Set(state.islands.map((island) => island.id));
  if (!state.letters.every((letter) => (
    islandIds.has(letter.originIslandId) &&
    islandIds.has(letter.recipientIslandId) &&
    letter.originIslandId !== 'skyport' &&
    letter.recipientIslandId !== 'skyport' &&
    letter.originIslandId !== letter.recipientIslandId &&
    Number.isFinite(letter.weight) &&
    letter.weight > 0 &&
    Number.isInteger(letter.urgency) &&
    letter.urgency >= 1 &&
    letter.urgency <= 3 &&
    Number.isInteger(letter.deadlineDay) &&
    Number.isInteger(letter.deadlineHour) &&
    typeof letter.sender === 'string' &&
    typeof letter.subject === 'string' &&
    ['inbox', 'backlog', 'delivered'].includes(letter.status)
  ))) return false;

  if (!Number.isInteger(state.wind.directionIndex) || state.wind.directionIndex < 0 || state.wind.directionIndex > 7) return false;
  if (typeof state.wind.direction !== 'string' || typeof state.wind.note !== 'string') return false;
  if (!Number.isFinite(state.wind.angle) || !Number.isFinite(state.wind.strength) || state.wind.strength < 0) return false;
  if (!Object.entries(state.relations).every(([key, value]) => {
    const [firstId, secondId] = key.split(':');
    return (
      firstId !== secondId &&
      firstId !== 'skyport' &&
      secondId !== 'skyport' &&
      islandIds.has(firstId) &&
      islandIds.has(secondId) &&
      Number.isFinite(value)
    );
  })) return false;
  return true;
}

function normalizeStoredState(parsed) {
  if (!isPlainObject(parsed)) {
    return { state: parsed, changed: false };
  }

  let changed = false;
  if (!Number.isInteger(parsed.revision)) {
    parsed.revision = 0;
    changed = true;
  }
  if (Number.isFinite(parsed.reputation)) {
    const reputation = Math.min(100, Math.max(0, parsed.reputation));
    if (reputation !== parsed.reputation) {
      parsed.reputation = reputation;
      changed = true;
    }
  }
  if (Number.isFinite(parsed.credits) && parsed.credits < 0) {
    parsed.credits = 0;
    changed = true;
  }
  if (isPlainObject(parsed.relations)) {
    for (const [key, value] of Object.entries(parsed.relations)) {
      if (!Number.isFinite(value)) continue;
      const relation = Math.min(100, Math.max(-100, value));
      if (relation !== value) {
        parsed.relations[key] = relation;
        changed = true;
      }
    }
  }
  return { state: parsed, changed };
}

export class GameStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.options = options;
    this.migrators = options.migrators;
    this.state = null;
    this.recovery = null;
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.recovery = null;
      const initialState = createInitialState(this.options);
      try {
        this.state = initialState;
        this.save();
      } catch (error) {
        this.state = null;
        throw error;
      }
      return this.getState();
    }

    const rawState = fs.readFileSync(this.filePath, 'utf8');
    let parsed;
    let sourceVersion;
    try {
      parsed = JSON.parse(rawState);
      if (!isPlainObject(parsed) || !Number.isInteger(parsed.version)) {
        throw new Error('存档结构不完整：缺少有效的版本号');
      }
      sourceVersion = parsed.version;

      // 版本拒绝策略：过新或过旧的存档一律拒绝，且不改动原文件。
      if (sourceVersion > GAME_VERSION) {
        throw new SaveRejectedError(
          `存档版本 ${sourceVersion} 来自更新的游戏版本，当前版本仅支持 v${GAME_VERSION} 及以下，请升级游戏后再读取。`,
          { code: 'SAVE_VERSION_NEWER', saveVersion: sourceVersion }
        );
      }
      if (sourceVersion < MIN_SUPPORTED_SAVE_VERSION) {
        throw new SaveRejectedError(
          `存档版本 ${sourceVersion} 已不再受支持（最低支持 v${MIN_SUPPORTED_SAVE_VERSION}），无法继续迁移。`,
          { code: 'SAVE_VERSION_TOO_OLD', saveVersion: sourceVersion }
        );
      }

      // 先修正越界数值等可自愈字段，再做结构校验（损坏与可迁移问题分开处理）。
      const preNormalized = normalizeStoredState(parsed);
      parsed = preNormalized.state;
      let needsSave = preNormalized.changed;

      // 迁移前先核对旧版本结构：结构损坏的旧档走损坏恢复，而非版本迁移。
      if (!hasValidStateShape(parsed, sourceVersion)) {
        throw new Error('存档结构不完整或字段损坏');
      }

      // 迁移、归一化与校验全部包在同一层 try 中：任何一步失败都拒绝加载，原文件不动。
      let migrated = parsed;
      try {
        if (sourceVersion < GAME_VERSION) {
          migrated = migrateState(parsed, this.migrators);
        }
        const normalized = normalizeStoredState(migrated);
        migrated = normalized.state;
        needsSave = needsSave || normalized.changed || sourceVersion < GAME_VERSION;
        if (!hasValidStateShape(migrated, GAME_VERSION)) {
          throw new Error('迁移后的存档结构校验未通过');
        }
      } catch (migrationError) {
        const message = migrationError instanceof SaveRejectedError
          ? migrationError.message
          : `存档从 v${sourceVersion} 迁移到 v${GAME_VERSION} 失败：${migrationError.message}，原文件未被修改。`;
        throw new SaveRejectedError(message, { code: 'SAVE_MIGRATION_FAILED', saveVersion: sourceVersion });
      }

      parsed = migrated;

      // 迁移与校验均在内存中完成，通过后才落盘；任何失败都不会覆盖原文件。
      this.state = parsed;
      this.recovery = null;
      if (needsSave) this.save();
    } catch (error) {
      if (error instanceof SaveRejectedError) {
        this.state = null;
        throw error;
      }
      if (error instanceof SyntaxError) {
        error = new Error(`存档不是有效的 JSON：${error.message}`);
      }
      return this.recoverCorruptState(error, sourceVersion);
    }

    return this.getState();
  }

  recoverCorruptState(error, sourceVersion) {
    let backupPath = `${this.filePath}.corrupt-${Date.now()}`;
    let suffix = 1;
    while (fs.existsSync(backupPath)) {
      backupPath = `${this.filePath}.corrupt-${Date.now()}-${suffix}`;
      suffix += 1;
    }

    const backupName = path.basename(backupPath);
    let renameError = null;
    try {
      fs.renameSync(this.filePath, backupPath);
    } catch (errorOnRename) {
      renameError = errorOnRename;
    }

    // 备份失败（如权限问题）时绝不能覆盖原文件：保留现场并直接报错。
    if (renameError) {
      this.state = null;
      throw new Error(`存档无法读取，且备份失败，原文件已保留：${renameError.message}。原始问题：${error.message}`);
    }

    // 统一的损坏备份与恢复提示：服务端日志与前端弹窗使用同一条文案。
    const versionLabel = Number.isInteger(sourceVersion) ? `v${sourceVersion} ` : '';
    const reason = `${versionLabel}存档无法读取，原文件已备份为 ${backupName}（${error.message}），已为你开启新一局。`;

    const recoveredState = createInitialState(this.options);
    try {
      this.state = recoveredState;
      this.save();
    } catch (saveError) {
      // 新档写入失败时把原档移回，保证提示与实际结果一致。
      try {
        fs.renameSync(backupPath, this.filePath);
      } catch (rollbackError) {
        this.state = null;
        throw new Error(
          `存档损坏且恢复失败：新档未能写入（${saveError.message}），原档备份也无法移回（${rollbackError.message}），备份位于 ${backupName}。`
        );
      }
      this.state = null;
      throw new Error(`存档无法读取（${error.message}），新档写入失败（${saveError.message}），原文件已还原。`);
    }

    this.recovery = { reason };
    return {
      ...this.getState(),
      recovery: structuredClone(this.recovery)
    };
  }

  getState() {
    if (!this.state) this.load();
    return structuredClone(this.state);
  }

  getRecovery() {
    return this.recovery ? structuredClone(this.recovery) : null;
  }

  mutate(mutator) {
    if (!this.state) this.load();
    const previousState = this.state;
    const nextState = structuredClone(this.state);
    const result = mutator(nextState);
    nextState.updatedAt = new Date().toISOString();
    try {
      this.state = nextState;
      this.save();
    } catch (error) {
      this.state = previousState;
      throw error;
    }
    return structuredClone(result);
  }

  reset(seed = Date.now()) {
    if (!this.state) this.load();
    const previousState = this.state;
    const previousRecovery = this.recovery;
    const nextState = createInitialState({ ...this.options, seed });
    nextState.revision = Number.isInteger(previousState.revision) ? previousState.revision + 1 : 1;
    try {
      this.state = nextState;
      this.save();
      this.recovery = null;
    } catch (error) {
      this.state = previousState;
      this.recovery = previousRecovery;
      throw error;
    }
    return this.getState();
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
      fs.renameSync(temporaryPath, this.filePath);
    } finally {
      if (fs.existsSync(temporaryPath)) {
        try {
          fs.unlinkSync(temporaryPath);
        } catch {
          // 临时文件清理失败不应覆盖原始写入错误。
        }
      }
    }
  }
}

export function assertPlanningPhase(state) {
  if (state.phase !== 'planning') {
    throw new GameRuleError('本局已结束，请重新开始一局。');
  }
}
