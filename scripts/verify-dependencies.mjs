import assert from 'node:assert/strict';
import { MroApplication } from '../dist/app.js';

const app = new MroApplication();
const store = app.store;
const deps = app.taskDependencies;

let seq = 0;
function seedTask(dependsOn = [], status = 'BLOCKED', version = 1) {
  seq += 1;
  const id = `t${seq}`;
  store.dependentTasks.set(id, { id, workOrderId: `wo_${id}`, dependsOn, status, version });
  return id;
}

function snapshotOf(ids) {
  return new Map(ids.map((id) => {
    const t = store.dependentTasks.get(id);
    return [id, { status: t.status, version: t.version }];
  }));
}

const beforeCounts = () => ({ audit: store.audit.length, outbox: store.outbox.length });
// A dependency-free root starts BLOCKED; refresh promotes it, then it can complete.
const activate = async (id) => { await deps.refresh([id]); await deps.complete(id); };
function assertNoSideEffects(before) {
  assert.equal(store.audit.length, before.audit, 'audit must not change');
  assert.equal(store.outbox.length, before.outbox, 'outbox must not change');
}

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.stack ?? err.message}`);
    process.exitCode = 1;
  }
}

// A: gate releases only on live COMPLETED prerequisites; repeated refresh is a no-op
{
  const a = seedTask();
  const b = seedTask([a]);
  await check('blocked while prerequisite open', async () => {
    assert.deepEqual(await deps.refresh([b]), []);
    assert.equal(store.dependentTasks.get(b).status, 'BLOCKED');
  });
  await activate(a);
  await check('released when prerequisite completed (live), pinned to current version', async () => {
    assert.deepEqual(await deps.refresh([b]), [b]);
    const task = store.dependentTasks.get(b);
    assert.equal(task.status, 'READY');
    assert.deepEqual(task.releasedBy, { [a]: store.dependentTasks.get(a).version });
  });
  await check('repeated refresh is idempotent (no status/version/audit/outbox change)', async () => {
    const before = beforeCounts();
    const v = store.dependentTasks.get(b).version;
    assert.deepEqual(await deps.refresh([b, b]), []);
    assert.equal(store.dependentTasks.get(b).version, v);
    assertNoSideEffects(before);
  });
  await check('start then complete gate on live prerequisites', async () => {
    assert.equal(await deps.start(b), 'IN_PROGRESS');
    assert.equal(await deps.complete(b), 'COMPLETED');
  });
  await check('duplicate complete is idempotent', async () => {
    const before = beforeCounts();
    await deps.complete(b);
    assertNoSideEffects(before);
  });
}

// B: a stale async snapshot can never release and writes nothing
{
  const a = seedTask();
  const b = seedTask([a]);
  const stale = snapshotOf([a]); // snapshot of a at BLOCKED v1
  await activate(a); // live moves to COMPLETED at a newer version
  await check('stale snapshot aborts before any commit', async () => {
    const before = beforeCounts();
    const v = store.dependentTasks.get(b).version;
    await assert.rejects(() => deps.refresh([b], stale), /stale dependency snapshot/);
    assert.equal(store.dependentTasks.get(b).status, 'BLOCKED');
    assert.equal(store.dependentTasks.get(b).version, v);
    assertNoSideEffects(before);
  });
  await check('fresh snapshot releases', async () => {
    await deps.refresh([b], snapshotOf([a]));
    assert.equal(store.dependentTasks.get(b).status, 'READY');
  });
}

// C: prerequisite cancelled after release -> release revoked, completion refused
{
  const a = seedTask();
  const b = seedTask([a]);
  await activate(a);
  await deps.refresh([b]);
  assert.equal(store.dependentTasks.get(b).status, 'READY');
  await deps.cancel(a);
  await check('refresh moves successor back to BLOCKED and clears the release basis', async () => {
    assert.deepEqual(await deps.refresh([b]), [b]);
    const task = store.dependentTasks.get(b);
    assert.equal(task.status, 'BLOCKED');
    assert.equal(task.releasedBy, undefined);
  });
  await check('completion refused after prerequisite cancellation (no half write)', async () => {
    const before = beforeCounts();
    const v = store.dependentTasks.get(b).version;
    await assert.rejects(() => deps.complete(b), /not executable/);
    assert.equal(store.dependentTasks.get(b).status, 'BLOCKED');
    assert.equal(store.dependentTasks.get(b).version, v);
    assertNoSideEffects(before);
  });
  await check('reopened prerequisite still blocks until completed again', async () => {
    await deps.reopen(a);
    await deps.refresh([b]);
    assert.equal(store.dependentTasks.get(b).status, 'BLOCKED');
    assert.equal(store.dependentTasks.get(a).status, 'BLOCKED');
  });
}

// D: quality return of a prerequisite while the successor is already executing
{
  const a = seedTask();
  const b = seedTask([a]);
  await activate(a);
  await deps.refresh([b]);
  await deps.start(b);
  await deps.returnForRework(a);
  assert.equal(store.dependentTasks.get(a).status, 'IN_PROGRESS');
  await check('in-progress successor cannot complete against a returned prerequisite', async () => {
    const before = beforeCounts();
    const v = store.dependentTasks.get(b).version;
    await assert.rejects(() => deps.complete(b), /not completed/);
    assert.equal(store.dependentTasks.get(b).status, 'IN_PROGRESS');
    assert.equal(store.dependentTasks.get(b).version, v);
    assertNoSideEffects(before);
  });
  await check('gate reopens only after the prerequisite reaches a new COMPLETED version', async () => {
    await deps.complete(a);
    await deps.complete(b);
    assert.equal(store.dependentTasks.get(b).status, 'COMPLETED');
    assert.deepEqual(store.dependentTasks.get(b).releasedBy, { [a]: store.dependentTasks.get(a).version });
  });
}

// E: one conflict in a batch commits nothing
{
  const a = seedTask();
  const b = seedTask([a]);
  const c = seedTask(['missing_task']);
  await activate(a);
  await deps.refresh([b]);
  await check('a missing dependency aborts the entire refresh batch atomically', async () => {
    const before = beforeCounts();
    const vB = store.dependentTasks.get(b).version;
    const vC = store.dependentTasks.get(c).version;
    await assert.rejects(() => deps.refresh([b, c]), /dependency .* not found/);
    assert.equal(store.dependentTasks.get(b).version, vB);
    assert.equal(store.dependentTasks.get(c).version, vC);
    assert.equal(store.dependentTasks.get(c).status, 'BLOCKED');
    assertNoSideEffects(before);
  });
}

// F: lifecycle idempotency
{
  const a = seedTask();
  const b = seedTask([a]);
  await activate(a);
  await deps.refresh([b]);
  await deps.start(b);
  await check('duplicate start is idempotent', async () => {
    const before = beforeCounts();
    await deps.start(b);
    assertNoSideEffects(before);
  });
  await deps.cancel(a);
  await check('duplicate cancel is idempotent', async () => {
    const before = beforeCounts();
    await deps.cancel(a);
    assertNoSideEffects(before);
  });
  await deps.reopen(a);
  await check('duplicate reopen is idempotent', async () => {
    const before = beforeCounts();
    await deps.reopen(a);
    assertNoSideEffects(before);
  });
  await activate(a);
  await deps.refresh([b]);
  await deps.complete(b);
  await deps.returnForRework(b);
  await check('duplicate return-for-rework is idempotent', async () => {
    const before = beforeCounts();
    await deps.returnForRework(b);
    assertNoSideEffects(before);
  });
  await check('a completed prerequisite can be cancelled and re-gates successors', async () => {
    const x = seedTask();
    const y = seedTask([x]);
    await activate(x);
    await deps.refresh([y]);
    assert.equal(store.dependentTasks.get(y).status, 'READY');
    await deps.cancel(x);
    await deps.refresh([y]);
    assert.equal(store.dependentTasks.get(y).status, 'BLOCKED');
  });
}

// G: async snapshot refresh racing a prerequisite change must serialize
{
  const a = seedTask();
  const b = seedTask([a]);
  await activate(a);
  await check('concurrent refresh and prerequisite change serialize with no half state', async () => {
    const snap = snapshotOf([a]);
    const results = await Promise.allSettled([
      deps.refresh([b], snap),
      deps.returnForRework(a),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 2);
    const t = store.dependentTasks.get(b);
    if (t.status === 'READY') {
      // refresh landed first; the live gate still blocks completion afterwards
      await assert.rejects(() => deps.complete(b), /not completed/);
    } else {
      assert.equal(t.status, 'BLOCKED');
    }
    const readyEvents = store.outbox.filter((o) => o.aggregateId === b && o.topic === 'mro.task-ready').length;
    assert.ok(readyEvents <= 1);
  });
}

// H: version / audit / outbox consistency per migration
{
  const a = seedTask();
  const b = seedTask([a]);
  await activate(a);
  await deps.refresh([b]);
  await check('each transition bumps version once and writes one audit + one outbox event', async () => {
    for (const entry of [() => deps.start(b), () => deps.complete(b)]) {
      const before = beforeCounts();
      const v = store.dependentTasks.get(b).version;
      await entry();
      assert.equal(store.dependentTasks.get(b).version, v + 1);
      assert.equal(store.audit.length, before.audit + 1);
      assert.equal(store.outbox.length, before.outbox + 1);
    }
    const audits = store.audit.filter((x) => x.entityId === b).map((x) => x.action);
    assert.deepEqual(audits, ['task.ready', 'task.started', 'task.completed']);
    const outbox = store.outbox.filter((x) => x.aggregateId === b).map((x) => x.topic);
    assert.deepEqual(outbox, ['mro.task-ready', 'mro.task-started', 'mro.task-completed']);
    const last = JSON.parse(store.outbox.filter((x) => x.aggregateId === b).at(-1).payload);
    assert.equal(last.dependencyVersions[a], store.dependentTasks.get(a).version);
    assert.equal(last.workOrderId, `wo_${b}`);
    assert.ok(store.outbox.every((m) => m.status === 'PENDING'));
  });
}

console.log(`\n${passed} checks passed`);
