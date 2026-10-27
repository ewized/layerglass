/** Only the platform surface consumed by a fixture needs an implementation. */
export type TestDouble<T> =
  | T
  | (T extends (...args: infer Args) => infer Result
      ? (...args: Args) => TestDouble<Result>
      : T extends Promise<infer Value>
        ? Promise<TestDouble<Value>>
        : T extends ReadonlyArray<infer Item>
          ? TestDouble<Item>[]
          : T extends object
            ? { [Key in keyof T]?: TestDouble<T[Key]> }
            : T);

/** Confine partial-platform assertions to fixture construction, not test results. */
export function testDouble<T>(value: TestDouble<T>): T {
  return value as T;
}

/** Inject deliberately malformed wire data only into rejection/validation tests. */
export function untrustedInput<T>(value: unknown): T {
  return value as T;
}

/** A platform fake may expose extra internals; check the named native surface. */
export function platformDouble<T extends object, Key extends keyof T>(value: {
  [Property in Key]: TestDouble<T[Property]>;
}): T {
  return value as T;
}

export function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
