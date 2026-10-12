// Error types shared by every module (kept separate so modules that import each other can use them).
/** A problem the user or the AI model can fix; its message is shown as-is. */
export class UserError extends Error {}
/** Raised for document / NoSQL data. Its message is the statement users should see. */
export class NotTabularError extends UserError {}
/** A large file needs the user's go-ahead (or a plan) before it is read. */
export class LargeFileError extends UserError {}
