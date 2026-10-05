import { Store } from '../store/store.js';

export class TaskDependencyService {
  constructor(private readonly store: Store) {}

  refresh(taskIds: string[]): void {
    const snapshot = new Map([...this.store.dependentTasks.values()].map((task) => [task.id, { status: task.status, version: task.version }]));
    for (const taskId of taskIds) {
      const task = this.store.dependentTasks.get(taskId);
      if (!task || task.status === 'CANCELLED') continue;
      const ready = task.dependsOn.every((dependencyId) => {
        const dependency = snapshot.get(dependencyId);
        return dependency?.status === 'COMPLETED';
      });
      if (ready && task.status === 'BLOCKED') {
        task.status = 'READY';
        task.version += 1;
        this.store.addAudit('system', 'task.ready', 'task', task.id, { dependencyVersion: task.version });
        this.store.addOutbox('system', 'mro.task-ready', task.id, { taskId: task.id });
      }
    }
  }

  complete(taskId: string): void {
    const task = this.store.dependentTasks.get(taskId);
    if (!task) throw new Error('task not found');
    // BUG: completion trusts the last READY snapshot and never revalidates live dependencies.
    if (task.status !== 'READY' && task.status !== 'IN_PROGRESS') throw new Error('task is not executable');
    task.status = 'COMPLETED';
    task.version += 1;
    this.store.addAudit('system', 'task.completed', 'task', task.id, {});
    this.store.addOutbox('system', 'mro.task-completed', task.id, { taskId });
  }
}
