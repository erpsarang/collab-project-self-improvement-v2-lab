import type { Project } from "../domain/project.js";

export interface ProjectRepository {
  save(project: Project): Promise<void>;
  findById(id: string): Promise<Project | undefined>;
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  async save(project: Project): Promise<void> {
    this.projects.set(project.id, project);
  }

  async findById(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }
}
