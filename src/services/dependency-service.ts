import type { DependentTask, DependencySnapshotEntry, TaskStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

interface PlannedChange {
  task: DependentTask;
  status: TaskStatus;
  release: boolean;
  dependencyVersions: Record<string, number>;
  action: string;
  topic: string;
}

export class TaskDependencyService {
  constructor(private readonly store: Store) {}

  /**
   * Recompute task readiness from the CURRENT versions of the prerequisites.
   *
   * `snapshot` is the asynchronous dependency snapshot captured by the
   * scheduler. A snapshot entry is only a freshness token: when it no longer
   * matches the live prerequisite (status or version) the whole batch aborts
   * before any write, so an outdated snapshot can never release a task.
   *
   * Planning and committing are separate phases. All validation happens while
   * planning; the commit phase only applies prevalidated changes, so a
   * conflict never leaves a half-applied batch.
   *
   * @returns ids of tasks whose status actually changed (empty on a repeated refresh).
   */
  refresh(taskIds: string[], snapshot: Map<string, DependencySnapshotEntry> = new Map()): Promise<string[]> {
    // Hold the store-wide mutex for the whole plan+commit so an asynchronous
    // snapshot refresh cannot interleave with a prerequisite lifecycle change.
    return this.store.lock.runExclusive(() => {
      const changes: PlannedChange[] = [];

      for (const taskId of [...new Set(taskIds)]) {
        const task = this.store.dependentTasks.get(taskId);
        if (!task) throw new Error('task not found');
        // Cancelled tasks are never reanimated by a refresh; running/finished
        // tasks keep their status and are governed by the live gate in start/complete.
        if (task.status !== 'BLOCKED' && task.status !== 'READY') continue;

        const dependencyVersions: Record<string, number> = {};
        let satisfied = true;
        for (const dependencyId of task.dependsOn) {
          const live = this.store.dependentTasks.get(dependencyId);
          if (!live) throw new Error(`dependency ${dependencyId} not found`);
          const snap = snapshot.get(dependencyId);
          if (snap && (snap.version !== live.version || snap.status !== live.status)) {
            throw new Error('stale dependency snapshot');
          }
          dependencyVersions[dependencyId] = live.version;
          // Only the current prerequisite state counts. A prerequisite that was
          // cancelled, reopened or returned for rework fails the gate even if an
          // older snapshot had seen it COMPLETED.
          if (live.status !== 'COMPLETED') satisfied = false;
        }

        if (satisfied && task.status === 'BLOCKED') {
          changes.push({ task, status: 'READY', release: true, dependencyVersions, action: 'task.ready', topic: 'mro.task-ready' });
        } else if (!satisfied && task.status === 'READY') {
          // Revoke a release verdict that was based on a prerequisite state
          // which no longer exists.
          changes.push({ task, status: 'BLOCKED', release: false, dependencyVersions, action: 'task.blocked', topic: 'mro.task-blocked' });
        }
        // READY that is still released, or BLOCKED that still has an open
        // prerequisite: no change, which keeps repeated refreshes idempotent.
      }

      for (const change of changes) this.commit(change);
      return changes.map((change) => change.task.id);
    });
  }

  /** Move a released task into execution, revalidating live prerequisites. */
  start(taskId: string): Promise<TaskStatus> {
    return this.store.lock.runExclusive(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'IN_PROGRESS' || task.status === 'COMPLETED' || task.status === 'CANCELLED') return task.status;
      if (task.status !== 'READY') throw new Error('task is not executable');
      const dependencyVersions = this.requireCompletedDependencies(task);
      task.status = 'IN_PROGRESS';
      task.version += 1;
      task.releasedBy = dependencyVersions;
      this.store.addAudit('system', 'task.started', 'task', task.id, this.dependencyMetadata(dependencyVersions));
      this.store.addOutbox('system', 'mro.task-started', task.id, { taskId: task.id, workOrderId: task.workOrderId, dependencyVersions });
      return task.status;
    });
  }

  /**
   * Complete a task. The previous READY verdict is never trusted: live
   * prerequisites must currently be COMPLETED at their current versions,
   * otherwise completion is refused (no status/version/audit/outbox write).
   */
  complete(taskId: string): Promise<TaskStatus> {
    return this.store.lock.runExclusive(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'COMPLETED') return task.status;
      if (task.status !== 'READY' && task.status !== 'IN_PROGRESS') throw new Error('task is not executable');
      const dependencyVersions = this.requireCompletedDependencies(task);
      task.status = 'COMPLETED';
      task.version += 1;
      task.releasedBy = dependencyVersions;
      this.store.addAudit('system', 'task.completed', 'task', task.id, this.dependencyMetadata(dependencyVersions));
      this.store.addOutbox('system', 'mro.task-completed', task.id, { taskId: task.id, workOrderId: task.workOrderId, dependencyVersions });
      return task.status;
    });
  }

  /**
   * Cancel a task in any non-terminal-cancelled state, including a COMPLETED
   * prerequisite whose work order was later called off. Successors are
   * re-gated on the next refresh / on their next live gate check.
   * Idempotent when already cancelled.
   */
  cancel(taskId: string): Promise<TaskStatus> {
    return this.store.lock.runExclusive(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'CANCELLED') return task.status;
      this.lifecycleTransition(task, 'CANCELLED', 'task.cancelled', 'mro.task-cancelled');
      return task.status;
    });
  }

  /** Reopen a cancelled task; it starts behind the gate and is re-evaluated by refresh. */
  reopen(taskId: string): Promise<TaskStatus> {
    return this.store.lock.runExclusive(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'BLOCKED') return task.status;
      if (task.status !== 'CANCELLED') throw new Error('only a cancelled task can be reopened');
      this.lifecycleTransition(task, 'BLOCKED', 'task.reopened', 'mro.task-reopened');
      return task.status;
    });
  }

  /** Quality rejection of a finished task; it returns to execution and its version moves. */
  returnForRework(taskId: string): Promise<TaskStatus> {
    return this.store.lock.runExclusive(() => {
      const task = this.requireTask(taskId);
      if (task.status === 'IN_PROGRESS') return task.status;
      if (task.status !== 'COMPLETED') throw new Error('only a completed task can be returned for rework');
      this.lifecycleTransition(task, 'IN_PROGRESS', 'task.returned-for-rework', 'mro.task-returned-for-rework');
      return task.status;
    });
  }

  private requireTask(taskId: string): DependentTask {
    const task = this.store.dependentTasks.get(taskId);
    if (!task) throw new Error('task not found');
    return task;
  }

  /**
   * Live gate used by start/complete: every prerequisite must currently be
   * COMPLETED, and the version it is currently at is returned as the basis.
   * Throws without mutating anything when the gate is not satisfied.
   */
  private requireCompletedDependencies(task: DependentTask): Record<string, number> {
    const versions: Record<string, number> = {};
    for (const dependencyId of task.dependsOn) {
      const live = this.store.dependentTasks.get(dependencyId);
      if (!live) throw new Error(`dependency ${dependencyId} not found`);
      if (live.status !== 'COMPLETED') throw new Error(`dependency ${dependencyId} is not completed`);
      versions[dependencyId] = live.version;
    }
    return versions;
  }

  private commit(change: PlannedChange): void {
    const task = change.task;
    const from = task.status;
    task.status = change.status;
    task.version += 1;
    if (change.release) task.releasedBy = { ...change.dependencyVersions };
    else delete task.releasedBy;
    this.store.addAudit('system', change.action, 'task', task.id, { from, to: change.status, ...this.dependencyMetadata(change.dependencyVersions) });
    this.store.addOutbox('system', change.topic, task.id, {
      taskId: task.id,
      workOrderId: task.workOrderId,
      from,
      to: change.status,
      dependencyVersions: { ...change.dependencyVersions },
    });
  }

  private lifecycleTransition(task: DependentTask, status: TaskStatus, action: string, topic: string): void {
    const from = task.status;
    task.status = status;
    task.version += 1;
    delete task.releasedBy;
    this.store.addAudit('system', action, 'task', task.id, { from, to: status });
    this.store.addOutbox('system', topic, task.id, { taskId: task.id, workOrderId: task.workOrderId, from, to: status });
  }

  private dependencyMetadata(versions: Record<string, number>): Record<string, string | number | boolean> {
    return Object.fromEntries(Object.entries(versions).map(([id, version]) => [`dependency:${id}`, version]));
  }
}
