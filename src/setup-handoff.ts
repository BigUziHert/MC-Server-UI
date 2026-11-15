export type SetupModpack = {
  id: string;
  platform: string;
  title: string;
  description: string;
  iconUrl?: string | null;
};
let pending: SetupModpack | null = null;
export function setSetupModpack(project: SetupModpack) {
  pending = project;
}
export function takeSetupModpack() {
  const project = pending;
  pending = null;
  return project;
}

export function peekSetupModpack() {
  return pending;
}
