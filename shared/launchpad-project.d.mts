export function safeProjectUrl(value: unknown): string | undefined;
export function projectPageUrl(project?: {
  platform?: string | null;
  projectId?: string;
  url?: string;
}): string | undefined;
