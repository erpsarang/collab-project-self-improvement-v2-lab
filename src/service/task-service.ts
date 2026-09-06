import { randomUUID } from "node:crypto";

import { Task, type TaskStatus } from "../domain/task.js";
import type { ProjectRepository } from "../repository/project-repository.js";
import type { TaskRepository } from "../repository/task-repository.js";
import { ProjectNotFoundError } from "./project-service.js";

export class TaskService {
  constructor(
    private readonly projectRepository: ProjectRepository,
    private readonly taskRepository: TaskRepository,
  ) {}

  async create(projectId: string, title: string): Promise<Task> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    const task = new Task(randomUUID(), projectId, title, "TODO");
    await this.taskRepository.save(task);
    return task;
  }

  async listByProject(projectId: string, status?: TaskStatus): Promise<Task[]> {
    const project = await this.projectRepository.findById(projectId);
    if (!project) {
      throw new ProjectNotFoundError(projectId);
    }

    const tasks = await this.taskRepository.findByProjectId(projectId);
    return status === undefined ? tasks : tasks.filter((task) => task.status === status);
  }
}
