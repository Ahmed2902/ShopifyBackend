import type { Event, ErrorEvent } from '@sentry/node';

// Rebuild from a small allowlist. SDK defaults can include URLs, SQL, customer
// identifiers and exception messages containing provider tokens or payloads.
export function sanitizeMonitoringEvent(event: Event): ErrorEvent | null {
  if (event.type || !event.exception?.values?.length) return null;
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    release: event.release,
    environment: event.environment,
    exception: {
      values: event.exception.values.map((exception) => ({
        type: [
          'Error',
          'TypeError',
          'RangeError',
          'ReferenceError',
          'SyntaxError',
          'URIError',
          'AggregateError',
        ].includes(exception.type ?? '')
          ? exception.type
          : 'Error',
        value: 'Unexpected Metrico application error; inspect private application logs.',
        mechanism: { type: 'generic', handled: exception.mechanism?.handled ?? true },
        stacktrace: exception.stacktrace
          ? {
              frames: exception.stacktrace.frames?.map((frame) => ({
                filename: safeFilename(frame.filename),
                function: /^[a-zA-Z0-9_.$ <>-]{1,120}$/.test(frame.function ?? '')
                  ? frame.function
                  : undefined,
                lineno: frame.lineno,
                colno: frame.colno,
                in_app: frame.in_app,
              })),
            }
          : undefined,
      })),
    },
  };
}

function safeFilename(filename: string | undefined): string | undefined {
  const basename = filename?.split(/[?#]/, 1)[0]?.replaceAll('\\', '/').split('/').pop();
  return basename && /^[a-zA-Z0-9_.-]+\.(?:[cm]?js|jsx|ts|tsx)$/.test(basename)
    ? basename
    : undefined;
}
