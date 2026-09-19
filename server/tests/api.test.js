import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { GameStore, SaveRejectedError } from '../store.js';
import { advanceDay, GAME_VERSION, MIN_SUPPORTED_SAVE_VERSION, migrateState } from '../engine.js';

test('HTTP API 完成读取、预览、结算和重置闭环', async (context) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-api-'));
  const store = new GameStore(path.join(temporaryDirectory, 'state.json'), { seed: 'api-seed' });
  store.load();
  const server = createApp({ store, clientDist: null }).listen(0);
  context.after(() => {
    server.close();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  });

  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (url, options) => {
    const response = await fetch(`${baseUrl}${url}`, {
      headers: { 'Content-Type': 'application/json' },
      ...options
    });
    return { status: response.status, body: await response.json() };
  };

  const health = await request('/api/health');
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);

  const gameResponse = await request('/api/game');
  assert.equal(gameResponse.status, 200);
  const game = gameResponse.body.state;
  assert.equal(game.day, 1);

  const letter = game.letters.find((item) => item.status === 'inbox');
  const assignment = {
    letterId: letter.id,
    courierId: 'comet',
    targetIslandId: letter.recipientIslandId,
    order: 0
  };

  const previewResponse = await request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments: [assignment] })
  });
  assert.equal(previewResponse.status, 200);
  assert.equal(previewResponse.body.preview.valid, true);

  const advanceBody = JSON.stringify({ assignments: [assignment], expectedRevision: game.revision });
  const advanceResponse = await request('/api/game/day/advance', {
    method: 'POST',
    body: advanceBody
  });
  assert.equal(advanceResponse.status, 200);
  assert.equal(advanceResponse.body.state.day, 2);
  assert.equal(advanceResponse.body.state.revision, 1);
  assert.equal(advanceResponse.body.report.day, 1);

  const duplicateAdvance = await request('/api/game/day/advance', {
    method: 'POST',
    body: advanceBody
  });
  assert.equal(duplicateAdvance.status, 409);
  const stateAfterDuplicate = await request('/api/game');
  assert.equal(stateAfterDuplicate.body.state.day, 2);

  const invalidAssignments = await request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({ assignments: '' })
  });
  assert.equal(invalidAssignments.status, 400);

  const missingAssignments = await request('/api/game/plan/preview', {
    method: 'POST',
    body: JSON.stringify({})
  });
  assert.equal(missingAssignments.status, 400);

  const resetResponse = await request('/api/game/reset', {
    method: 'POST',
    body: JSON.stringify({ seed: 'new-run' })
  });
  assert.equal(resetResponse.status, 200);
  assert.equal(resetResponse.body.state.day, 1);
  assert.equal(resetResponse.body.state.seed, 'new-run');
  assert.equal(resetResponse.body.state.phase, 'planning');
});

test('游戏进度写入磁盘后可由新 Store 实例恢复', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-store-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const store = new GameStore(dataFile, { seed: 'persistent-seed' });
  store.load();
  store.mutate((state) => {
    state.reputation = 77;
    state.day = 6;
  });

  const reloadedStore = new GameStore(dataFile, { seed: 'ignored-on-existing-file' });
  const reloadedState = reloadedStore.load();

  assert.equal(reloadedState.reputation, 77);
  assert.equal(reloadedState.day, 6);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('重新开局会递增版本号以避免旧请求命中新局', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-reset-'));
  const store = new GameStore(path.join(temporaryDirectory, 'state.json'), { seed: 'reset-seed' });
  const initial = store.load();
  const firstReset = store.reset('reset-one');
  const secondReset = store.reset('reset-two');

  assert.equal(initial.revision, 0);
  assert.equal(firstReset.revision, 1);
  assert.equal(secondReset.revision, 2);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('损坏或结构不完整的存档会备份并恢复为新局', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-corrupt-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  fs.writeFileSync(dataFile, JSON.stringify({ version: 1, day: 1 }), 'utf8');

  const store = new GameStore(dataFile, { seed: 'recovered-seed' });
  const recovered = store.load();
  const backups = fs.readdirSync(temporaryDirectory).filter((name) => name.includes('.corrupt-'));

  assert.equal(recovered.phase, 'planning');
  assert.equal(recovered.day, 1);
  assert.equal(recovered.seed, 'recovered-seed');
  assert.ok(recovered.recovery);
  assert.equal(backups.length, 1);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('终局报告与结局字段不完整时会按损坏存档恢复', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-terminal-state-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const store = new GameStore(dataFile, { seed: 'terminal-valid' });
  const state = store.load();
  state.phase = 'completed';
  state.lastReport = {};
  state.ending = { type: 'completed' };
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');

  const reloadedStore = new GameStore(dataFile, { seed: 'terminal-recovered' });
  const recovered = reloadedStore.load();

  assert.equal(recovered.phase, 'planning');
  assert.equal(recovered.day, 1);
  assert.equal(recovered.seed, 'terminal-recovered');
  assert.ok(recovered.recovery);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('旧存档中的越界状态会在加载时迁移并写回', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-migration-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const store = new GameStore(dataFile, { seed: 'migration-seed' });
  const state = store.load();
  state.reputation = 250;
  state.credits = -20;
  state.relations['gale:sun'] = 150;
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');

  const migrated = new GameStore(dataFile, { seed: 'ignored' }).load();
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(migrated.reputation, 100);
  assert.equal(migrated.credits, 0);
  assert.equal(migrated.relations['gale:sun'], 100);
  assert.deepEqual(persisted, migrated);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function loadV1Save(dataFile) {
  const state = new GameStore(`${dataFile}.seed`, { seed: 'v1-save-seed' }).load();
  const v1 = structuredClone(state);
  v1.version = 1;
  delete v1.stats;
  // 同时构造一段历史，用于验证 stats 回填。
  v1.history.push({
    day: 1,
    reputationDelta: 3,
    creditsDelta: 18,
    delivered: 2,
    onTime: 1,
    late: 1,
    wrong: 0,
    backlog: 1
  });
  fs.writeFileSync(dataFile, JSON.stringify(v1), 'utf8');
  return v1;
}

test('旧版本存档补齐新字段后可继续游玩并升级到当前版本', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-v1-upgrade-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  loadV1Save(dataFile);

  const store = new GameStore(dataFile, { seed: 'ignored' });
  const migrated = store.load();

  assert.equal(migrated.version, GAME_VERSION);
  assert.deepEqual(migrated.stats, {
    totalDelivered: 2,
    totalOnTime: 1,
    totalLate: 1,
    totalWrong: 0,
    totalBacklog: 1
  });
  assert.equal(store.getRecovery(), null);

  // 旧档进度仍在，可以继续结算。
  assert.equal(migrated.phase, 'planning');
  const report = store.mutate((state) => advanceDay(state, []));
  assert.equal(report.day, 1);
  const after = store.getState();
  assert.equal(after.version, GAME_VERSION);
  assert.ok(after.stats.totalBacklog >= 1);

  // 迁移结果已原子写回磁盘。
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(persisted.version, GAME_VERSION);
  assert.ok(persisted.stats);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

function require_advanceDay() {
  // 延迟引用以保持文件顶部导入简洁。
  return { advanceDay: globalThis.__advanceDay ?? null };
}

test('来自更高版本的存档会被拒绝且原文件保持不变', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-newer-version-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const state = new GameStore(path.join(temporaryDirectory, 'seed.json'), { seed: 'future' }).load();
  state.version = GAME_VERSION + 1;
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');
  const originalContent = fs.readFileSync(dataFile, 'utf8');

  const store = new GameStore(dataFile, { seed: 'ignored' });
  assert.throws(() => store.load(), (error) => {
    assert.ok(error instanceof SaveRejectedError);
    assert.equal(error.code, 'SAVE_VERSION_NEWER');
    assert.match(error.message, /更新的游戏版本/);
    return true;
  });
  assert.equal(store.getRecovery(), null);
  assert.equal(fs.readFileSync(dataFile, 'utf8'), originalContent);
  assert.equal(fs.readdirSync(temporaryDirectory).filter((name) => name.includes('.corrupt-')).length, 0);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('低于最低支持版本的存档会被拒绝且原文件保持不变', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-older-version-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  const state = new GameStore(path.join(temporaryDirectory, 'seed.json'), { seed: 'ancient' }).load();
  state.version = MIN_SUPPORTED_SAVE_VERSION - 1;
  delete state.stats;
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');
  const originalContent = fs.readFileSync(dataFile, 'utf8');

  const store = new GameStore(dataFile, { seed: 'ignored' });
  assert.throws(() => store.load(), (error) => {
    assert.ok(error instanceof SaveRejectedError);
    assert.equal(error.code, 'SAVE_VERSION_TOO_OLD');
    assert.match(error.message, /不再受支持/);
    return true;
  });
  assert.equal(fs.readFileSync(dataFile, 'utf8'), originalContent);
  assert.equal(fs.readdirSync(temporaryDirectory).filter((name) => name.includes('.corrupt-')).length, 0);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('迁移失败时不得覆盖或移动原文件', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-migration-fail-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  loadV1Save(dataFile);
  const originalContent = fs.readFileSync(dataFile, 'utf8');

  // 注入一个必然失败的 v2 迁移器。
  const store = new GameStore(dataFile, {
    seed: 'ignored',
    migrators: {
      2() {
        throw new Error('模拟迁移失败');
      }
    }
  });

  assert.throws(() => store.load(), (error) => {
    assert.ok(error instanceof SaveRejectedError);
    assert.equal(error.code, 'SAVE_MIGRATION_FAILED');
    assert.match(error.message, /迁移失败/);
    assert.match(error.message, /原文件未被修改/);
    return true;
  });
  assert.equal(fs.readFileSync(dataFile, 'utf8'), originalContent);
  assert.equal(fs.readdirSync(temporaryDirectory).filter((name) => name.includes('.corrupt-')).length, 0);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});

test('缺少迁移路径时同样拒绝加载并保留原文件', () => {
  assert.throws(() => migrateState({ version: GAME_VERSION - 1 }, {}), /缺少对应的迁移方案/);
});

test('损坏备份与恢复提示包含统一的备份文件名和原因', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sky-post-recovery-msg-'));
  const dataFile = path.join(temporaryDirectory, 'state.json');
  fs.writeFileSync(dataFile, '{ not valid json', 'utf8');

  const store = new GameStore(dataFile, { seed: 'recovery-msg' });
  const recovered = store.load();
  const backups = fs.readdirSync(temporaryDirectory).filter((name) => name.includes('.corrupt-'));
  const recovery = store.getRecovery();

  assert.equal(backups.length, 1);
  assert.ok(recovery);
  assert.equal(recovery.reason, recovered.recovery.reason);
  assert.match(recovery.reason, new RegExp(backups[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(recovery.reason, /存档无法读取/);
  assert.match(recovery.reason, /已为你开启新一局/);
  fs.rmSync(temporaryDirectory, { recursive: true, force: true });
});
