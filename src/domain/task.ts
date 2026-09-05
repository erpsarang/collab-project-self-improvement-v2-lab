export type TaskStatus = "TODO" | "DONE";

export class Task {
  constructor(
    public readonly id: string,
    public readonly projectId: string,
    public readonly title: string,
    public readonly status: TaskStatus,
  ) {}
}
