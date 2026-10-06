import type { DependentTask, DependentTaskStatus } from '../domain/types.js';
import { Store } from '../store/store.js';

/**
 * Asynchronous refresh workers evaluate dependencies against a captured
 * snapshot. A snapshot is only usable while every prerequisite version it
 * carries still matches the live aggregate, otherwise it must not admit or
 * block anything.
 */
export interface DependencySnapshotEntry {
  status: DependentTaskStatus;
  version: number;
}

export type DependencySnapshot = Map<string, DependencySnapshotEntry>;

/** Dependency state prevents the requested transition. Nothing is mutated when thrown. */
export class DependencyConflictError extends Error {
  constructor(
    readonly taskId: string,
    readonly code:
      | 'TASK_NOT_FOUND'
      | 'DEPENDENCY_MISSING'
      | 'DEPENDENCY_NOT_COMPLETED'
      | 'ADMISSION_BASIS_STALE'
      | 'STALE_SNAPSHOT'
      | 'IN_PROGRESS_REGRESSED'
      | 'ILLEGAL_TRANSITION',
    readonly dependencyId?: string,
  ) {
    super(`dependency conflict for task ${taskId}: ${code}${dependencyId ? ` (${dependencyId})` : ''}`);
    this.name = 'DependencyConflictError';
  }
}

interface PlannedTransition {
  task: DependentTask;
  from: DependentTaskStatus;
  to: DependentTaskStatus;
  satisfied: Record<string, number>;
}

interface PlannedBasisRefresh {
  task: DependentTask;
  satisfied: Record<string, number>;
}

export class TaskDependencyService {
  constructor(private readonly store: Store) {}

  create(id: string, workOrderId: string, dependsOn: string[]): DependentTask {
    const task: DependentTask = { id, workOrderId, dependsOn: [...dependsOn], status: 'BLOCKED', version: 1 };
    this.store.dependentTasks.set(id, task);
    return task;
  }

  /**
   * Recompute dependency state for the given tasks. All reads and validation
   * happen before any write: a conflict for one task aborts the entire batch,
   * so versions, audit and outbox never end up in a half-applied state.
   *
   * @param snapshot optional asynchronous snapshot. When supplied it must be
   * current for every referenced prerequisite and target task; a stale entry
   * raises STALE_SNAPSHOT instead of letting an old snapshot admit a task.
   */
  async refresh(taskIds: string[], snapshot?: DependencySnapshot): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const uniqueTaskIds = [...new Set(taskIds)];
      if (snapshot) this.assertSnapshotCurrent(uniqueTaskIds, snapshot);

      const transitions: PlannedTransition[] = [];
      const basisRefreshes: PlannedBasisRefresh[] = [];
      for (const taskId of uniqueTaskIds) {
        const task = this.store.dependentTasks.get(taskId);
        if (!task || task.status === 'CANCELLED' || task.status === 'COMPLETED') continue;

        const satisfied = this.currentCompletedBasis(task, snapshot);
        if (satisfied) {
          if (task.status === 'BLOCKED') {
            transitions.push({ task, from: task.status, to: 'READY', satisfied });
          } else if (task.status === 'READY') {
            // READY but anchored to old prerequisite versions: the old
            // admission is invalid; re-anchor before anything may proceed.
            if (!this.basisMatches(task, satisfied)) basisRefreshes.push({ task, satisfied });
          } else if (task.status === 'IN_PROGRESS') {
            // Execution already started: a dependency regression is a hard
            // conflict rather than a silent demotion that loses work state.
            if (!this.basisMatches(task, satisfied)) {
              throw new DependencyConflictError(taskId, 'IN_PROGRESS_REGRESSED');
            }
          }
        } else if (task.status === 'READY') {
          // Prerequisite cancelled / reopened / quality-returned: revoke.
          transitions.push({ task, from: task.status, to: 'BLOCKED', satisfied: {} });
        } else if (task.status === 'IN_PROGRESS') {
          throw new DependencyConflictError(taskId, 'IN_PROGRESS_REGRESSED');
        }
      }

      // Commit phase runs only after the whole plan validated.
      for (const plan of basisRefreshes) this.commitBasisRefresh(plan);
      for (const plan of transitions) this.commitTransition(plan);
    });
  }

  /** READY -> IN_PROGRESS, revalidating live prerequisite state. */
  async start(taskId: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const task = this.requireLiveTask(taskId);
      if (task.status === 'IN_PROGRESS') return; // idempotent
      if (task.status !== 'READY') throw new DependencyConflictError(taskId, 'ILLEGAL_TRANSITION');
      this.assertAdmissionCurrent(task);
      this.commitTransition({ task, from: 'READY', to: 'IN_PROGRESS', satisfied: { ...task.satisfiedBy! } });
    });
  }

  /** READY/IN_PROGRESS -> COMPLETED, revalidating live prerequisite state. */
  async complete(taskId: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const task = this.requireLiveTask(taskId);
      if (task.status === 'COMPLETED') return; // idempotent
      if (task.status !== 'READY' && task.status !== 'IN_PROGRESS') {
        throw new DependencyConflictError(taskId, 'ILLEGAL_TRANSITION');
      }
      // Never trust a past READY/IN_PROGRESS snapshot: only the prerequisite
      // versions that are completed *right now* may admit completion.
      this.assertAdmissionCurrent(task);
      this.commitTransition({
        task,
        from: task.status,
        to: 'COMPLETED',
        satisfied: {},
      });
    });
  }

  /**
   * Quality rejection of a task card (upstream prerequisite or the task
   * itself). COMPLETED work may be returned for rework; downstream tasks must
   * then lose their admission on the next refresh.
   */
  async qualityReturn(taskId: string, reason: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const task = this.requireLiveTask(taskId);
      if (task.status === 'CANCELLED' || task.status === 'BLOCKED') {
        throw new DependencyConflictError(taskId, 'ILLEGAL_TRANSITION');
      }
      this.commitTransition({ task, from: task.status, to: 'BLOCKED', satisfied: {} }, { reason });
    });
  }

  async cancel(taskId: string, reason: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const task = this.requireLiveTask(taskId);
      if (task.status === 'CANCELLED') return; // idempotent
      this.commitTransition({ task, from: task.status, to: 'CANCELLED', satisfied: {} }, { reason });
    });
  }

  /**
   * Reopen a previously cancelled task card. The work must be redone, so the
   * card always returns to BLOCKED even if it had reached COMPLETED before it
   * was cancelled; it becomes READY again through a normal refresh once its
   * prerequisites hold.
   */
  async reopen(taskId: string, reason: string): Promise<void> {
    await this.store.lock.runExclusive(() => {
      const task = this.requireLiveTask(taskId);
      if (task.status !== 'CANCELLED') throw new DependencyConflictError(taskId, 'ILLEGAL_TRANSITION');
      this.commitTransition({ task, from: 'CANCELLED', to: 'BLOCKED', satisfied: {} }, { reason });
    });
  }

  // ---- internals ---------------------------------------------------------

  private requireLiveTask(taskId: string): DependentTask {
    const task = this.store.dependentTasks.get(taskId);
    if (!task) throw new DependencyConflictError(taskId, 'TASK_NOT_FOUND');
    return task;
  }

  private assertSnapshotCurrent(taskIds: string[], snapshot: DependencySnapshot): void {
    const referenced = new Set<string>(taskIds);
    for (const taskId of taskIds) {
      for (const depId of this.store.dependentTasks.get(taskId)?.dependsOn ?? []) referenced.add(depId);
    }
    for (const id of referenced) {
      const live = this.store.dependentTasks.get(id);
      const captured = snapshot.get(id);
      if (!live || !captured || captured.version !== live.version || captured.status !== live.status) {
        throw new DependencyConflictError(id, 'STALE_SNAPSHOT');
      }
    }
  }

  /**
   * Returns the prerequisite version basis if every prerequisite is currently
   * COMPLETED (live state, or the validated snapshot during an async refresh),
   * otherwise undefined.
   */
  private currentCompletedBasis(task: DependentTask, snapshot?: DependencySnapshot): Record<string, number> | undefined {
    const satisfied: Record<string, number> = {};
    for (const dependencyId of task.dependsOn) {
      const live = this.store.dependentTasks.get(dependencyId);
      const dependency = snapshot ? snapshot.get(dependencyId) : live;
      if (!live || !dependency) throw new DependencyConflictError(task.id, 'DEPENDENCY_MISSING', dependencyId);
      if (dependency.status !== 'COMPLETED') return undefined;
      satisfied[dependencyId] = dependency.version;
    }
    return satisfied;
  }

  /** A READY/IN_PROGRESS task may only proceed on its current admission basis. */
  private assertAdmissionCurrent(task: DependentTask): void {
    const live = this.currentCompletedBasis(task);
    if (!live) throw new DependencyConflictError(task.id, 'DEPENDENCY_NOT_COMPLETED');
    if (!task.satisfiedBy || !this.basisMatches(task, live)) {
      throw new DependencyConflictError(task.id, 'ADMISSION_BASIS_STALE');
    }
  }

  private basisMatches(task: DependentTask, basis: Record<string, number>): boolean {
    const current = task.satisfiedBy;
    if (!current) return false;
    // A task with no prerequisites is admitted on the empty basis.
    if (task.dependsOn.length === 0) return Object.keys(current).length === 0 && Object.keys(basis).length === 0;
    return task.dependsOn.every((id) => current[id] === basis[id]);
  }

  private tenantOf(task: DependentTask): string {
    return this.store.workOrders.get(task.workOrderId)?.tenantId ?? 'system';
  }

  private commitBasisRefresh(plan: PlannedBasisRefresh): void {
    const { task, satisfied } = plan;
    if (this.basisMatches(task, satisfied)) return; // idempotent
    task.satisfiedBy = { ...satisfied };
    task.version += 1;
    this.store.addAudit(this.tenantOf(task), 'task.dependency-basis-refreshed', 'task', task.id, {
      version: task.version,
      ...this.basisMetadata(satisfied),
    });
    // No status changed: downstream subscribers must not see a duplicate ready
    // event; audit above is the only side effect, kept version-consistent.
  }

  private static readonly NO_BASIS_STATUSES: ReadonlySet<DependentTaskStatus> = new Set(['BLOCKED', 'CANCELLED', 'COMPLETED']);

  private commitTransition(plan: PlannedTransition, extraMetadata: Record<string, string | number | boolean> = {}): void {
    const { task, from, to, satisfied } = plan;
    if (task.status === to && (TaskDependencyService.NO_BASIS_STATUSES.has(to) || this.basisMatches(task, satisfied))) return;
    task.status = to;
    // An empty {} basis is a valid admission for zero-dependency tasks; only
    // BLOCKED/CANCELLED/COMPLETED states carry no admission basis.
    if (TaskDependencyService.NO_BASIS_STATUSES.has(to)) delete task.satisfiedBy;
    else task.satisfiedBy = { ...satisfied };
    task.version += 1;
    this.store.addAudit(this.tenantOf(task), 'task.status-changed', 'task', task.id, {
      from,
      to,
      version: task.version,
      ...this.basisMetadata(satisfied),
      ...extraMetadata,
    });
    if (from !== to) {
      this.store.addOutbox(this.tenantOf(task), 'mro.task-status-changed', task.id, {
        taskId: task.id,
        from,
        to,
        version: task.version,
      });
    }
  }

  private basisMetadata(satisfied: Record<string, number>): Record<string, number> {
    const metadata: Record<string, number> = {};
    for (const [dependencyId, version] of Object.entries(satisfied)) metadata[`dep:${dependencyId}`] = version;
    return metadata;
  }
}
