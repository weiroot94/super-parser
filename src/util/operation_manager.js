import array_utils from './array_utils.js';
/**
 * A utility for cleaning up AbortableOperations, to help simplify common
 * patterns and reduce code duplication.
 */
class operation_manager {
  constructor() {
    this.operations_ = [];
  }

  /**
   * Manage an operation.  This means aborting it on destroy() and removing it
   * from the management set when it complete.
   *
   * @param {!extern.IAbortableOperation} operation
   */
   manage(operation) {
    this.operations_.push(operation.finally(() => {
      array_utils.remove(this.operations_, operation);
    }));
  }

  destroy() {
    const cleanup = [];
    for (const op of this.operations_) {
      // Catch and ignore any failures.  This silences error logs in the
      // JavaScript console about uncaught Promise failures.
      op.promise.catch(() => {});

      // Now abort the operation.
      cleanup.push(op.abort());
    }

    this.operations_ = [];
    return Promise.all(cleanup);
  }
}

export default operation_manager;