// Errors every front-end understands. A UsageError means the user asked for something that cannot
// work (a missing flag, a bad value); front-ends show its message and exit 2, with no stack trace.

export class UsageError extends Error {}
