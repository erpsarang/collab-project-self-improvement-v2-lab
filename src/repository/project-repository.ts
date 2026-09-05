import type { Project } from "../domain/project.js";

export interface ProjectRepository {
  save(project: Project): void;
  findById(id: string): Project | undefined;
}

export class InMemoryProjectRepository implements ProjectRepository {
  private readonly projects = new Map<string, Project>();

  save(project: Project): void {
    this.projects.set(project.id, project);
  }

  findById(id: string): Project | undefined {
    return this.projects.get(id);
  }
}
