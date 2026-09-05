import type { Task } from "../domain/task.js";

export interface TaskRepository {
  save(task: Task): Promise<void>;
  findByProjectId(projectId: string): Promise<Task[]>;
}

export class InMemoryTaskRepository implements TaskRepository {
  private readonly tasks = new Map<string, Task>();

  async save(task: Task): Promise<void> {
    this.tasks.set(task.id, task);
  }

  async findByProjectId(projectId: string): Promise<Task[]> {
    return [...this.tasks.values()].filter((task) => task.projectId === projectId);
  }
}
