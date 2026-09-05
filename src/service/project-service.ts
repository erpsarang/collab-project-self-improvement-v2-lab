import { randomUUID } from "node:crypto";

import { Project } from "../domain/project.js";
import type { ProjectRepository } from "../repository/project-repository.js";

export class ProjectNotFoundError extends Error {
  constructor(id: string) {
    super(`Project ${id} not found`);
    this.name = "ProjectNotFoundError";
  }
}

export class ProjectService {
  constructor(private readonly projectRepository: ProjectRepository) {}

  async create(name: string): Promise<Project> {
    const project = new Project(randomUUID(), name);
    await this.projectRepository.save(project);
    return project;
  }

  async getById(id: string): Promise<Project> {
    const project = await this.projectRepository.findById(id);

    if (!project) {
      throw new ProjectNotFoundError(id);
    }

    return project;
  }
}
