export const canChangeContent = (permissions?: string[]) =>
  permissions === undefined ||
  [
    "file.create",
    "file.update",
    "file.delete",
    "control.start",
    "control.stop",
  ].every((permission) => permissions.includes(permission));
