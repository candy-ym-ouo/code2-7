import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../app.js';
import { GameStore, buildRecoveryNotice } from '../store.js';
import { GAME_VERSION, advanceDay } from '../engine.js';
import { SaveVersionError } from '../migrations.js';

function makeTempFile(prefix) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    directory: temporaryDirectory,
    file: path.join(temporaryDirectory, 'state.json')
  };
}

// 生成一份结构合法但停留在 v1 的存档（去掉 v2 才有的字段），用于验证旧档迁移。
function writeLegacyV1State(dataFile, options = {}) {
  const store = new GameStore(dataFile, { seed: 'legacy-template' });
  const state = store.load();
  delete state.totalDistance;
  for (const letter of state.letters) delete letter.lastPenaltyDay;
  state.version = 1;
  state.seed = options.seed ?? 'legacy-v1-seed';
  if (options.reputation !== undefined) state.reputation = options.reputation;
  fs.writeFileSync(dataFile, JSON.stringify(state), 'utf8');
  return state;
}

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

test('v1 旧档补齐新字段并升级到当前版本后可继续游玩', () => {
  const { directory, file: dataFile } = makeTempFile('sky-post-legacy-v1-');
  const legacy = writeLegacyV1State(dataFile, { reputation: 73 });

  const notifications = [];
  const store = new GameStore(dataFile, {
    seed: 'ignored-for-legacy',
    onRecovery: (event) => notifications.push(event)
  });
  const migrated = store.load();
  const persisted = JSON.parse(fs.readFileSync(dataFile, 'utf8'));

  assert.equal(migrated.version, GAME_VERSION);
  assert.equal(migrated.seed, 'legacy-v1-seed');
  assert.equal(migrated.reputation, 73);
  assert.equal(migrated.day, legacy.day);
  assert.equal(migrated.totalDistance, 0);
  assert.ok(migrated.letters.every((letter) => letter.lastPenaltyDay === null));
  assert.equal(notifications.length, 0);
  assert.equal(persisted.version, GAME_VERSION);
  assert.equal(persisted.totalDistance, 0);

  // 迁移后的存档必须能正常推进一日，新字段随玩法继续累计。
  const letter = migrated.letters.find((item) => item.status === 'inbox');
  const assignment = {
    letterId: letter.id,
    courierId: 'comet',
    targetIslandId: letter.recipientIslandId,
    order: 0
  };
  const report = store.mutate((draft) => advanceDay(draft, [assignment]));
  assert.equal(report.day, 1);
  const afterAdvance = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(afterAdvance.version, GAME_VERSION);
  assert.ok(afterAdvance.totalDistance > 0);

  fs.rmSync(directory, { recursive: true, force: true });
});

test('来自未来版本的存档会被拒绝且原文件保持不变', () => {
  const { directory, file: dataFile } = makeTempFile('sky-post-future-version-');
  const futureState = { ...writeLegacyV1State(dataFile), version: GAME_VERSION + 5 };
  fs.writeFileSync(dataFile, JSON.stringify(futureState), 'utf8');
  const originalBytes = fs.readFileSync(dataFile, 'utf8');

  const store = new GameStore(dataFile, { seed: 'ignored' });
  assert.throws(
    () => store.load(),
    (error) => error instanceof SaveVersionError && error.kind === 'newer'
  );

  assert.equal(fs.readFileSync(dataFile, 'utf8'), originalBytes);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes('.corrupt-')),
    []
  );
  assert.equal(store.state, null);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('低于最低支持版本的存档会被拒绝且原文件保持不变', () => {
  const { directory, file: dataFile } = makeTempFile('sky-post-ancient-version-');
  fs.writeFileSync(dataFile, JSON.stringify({ version: 0 }), 'utf8');
  const originalBytes = fs.readFileSync(dataFile, 'utf8');

  const store = new GameStore(dataFile, { seed: 'ignored' });
  assert.throws(
    () => store.load(),
    (error) => error instanceof SaveVersionError && error.kind === 'too-old'
  );

  assert.equal(fs.readFileSync(dataFile, 'utf8'), originalBytes);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.includes('.corrupt-')),
    []
  );
  fs.rmSync(directory, { recursive: true, force: true });
});

test('迁移失败时备份保留原文件且备份与恢复提示使用同一文案', () => {
  const { directory, file: dataFile } = makeTempFile('sky-post-migration-failed-');
  const legacy = writeLegacyV1State(dataFile);
  legacy.letters = null;
  fs.writeFileSync(dataFile, JSON.stringify(legacy), 'utf8');
  const originalBytes = fs.readFileSync(dataFile, 'utf8');

  const notifications = [];
  const store = new GameStore(dataFile, {
    seed: 'migration-failure-recovery',
    onRecovery: (event) => notifications.push(event)
  });
  const recovered = store.load();
  const entries = fs.readdirSync(directory);
  const backups = entries.filter((name) => name.includes('.corrupt-'));

  assert.equal(backups.length, 1);
  // 原始字节完整保留在备份中，没有被迁移半成品覆盖。
  assert.equal(fs.readFileSync(path.join(directory, backups[0]), 'utf8'), originalBytes);
  assert.equal(recovered.phase, 'planning');
  assert.equal(recovered.seed, 'migration-failure-recovery');
  assert.ok(recovered.recovery?.reason);
  assert.ok(/存档从 v1 迁移到 v2 失败/.test(recovered.recovery.reason));
  assert.ok(recovered.recovery.reason.includes(backups[0]));

  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].reason, recovered.recovery.reason);
  // 文案构造函数与运行时产物一致，保证服务端日志和界面提示不会各说各话。
  assert.equal(
    notifications[0].reason,
    buildRecoveryNotice(backups[0], '存档从 v1 迁移到 v2 失败：letters 字段缺失或不是数组。')
  );

  fs.rmSync(directory, { recursive: true, force: true });
});
