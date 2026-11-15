// Only actionable public diagnostics cross the API boundary; never serialize an
// Error wholesale (it may contain paths, credentials or internal responses).
export function publicErrorDetails(cause) {
  const result = {};
  if (typeof cause.code === "string" && cause.code.length <= 80)
    result.code = cause.code;
  for (const key of [
    "dependency",
    "dependencyDecisions",
    "runtimeRequirements",
    "detectedRuntime",
    "warnings",
  ])
    if (cause[key] && JSON.stringify(cause[key]).length <= 128 * 1024)
      result[key] = cause[key];
  if (cause.requiresAcknowledgement === true)
    result.requiresAcknowledgement = true;
  return result;
}
