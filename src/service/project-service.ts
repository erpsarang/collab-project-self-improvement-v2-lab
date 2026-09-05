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

  create(name: string): Project {
    const project = new Project(randomUUID(), name);
    this.projectRepository.save(project);
    return project;
  }

  getById(id: string): Project {
    const project = this.projectRepository.findById(id);

    if (!project) {
      throw new ProjectNotFoundError(id);
    }

    return project;
  }
}
