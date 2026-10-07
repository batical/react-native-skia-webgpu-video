import { createContext, runInContext } from "node:vm";

type Worklet = ((...args: any[]) => any) & {
  __workletHash?: number;
  __initData?: { code: string };
  __closure?: Record<string, unknown>;
};

/** The installed implementation is deliberately loaded instead of imitating
 * SharedValue setters: assigning a function starts an animation in Reanimated. */
export const loadInstalledValueSetter = (): Worklet => {
  const babel = require("@babel/core");
  const filename =
    require.resolve("react-native-reanimated/src/valueSetter.ts");
  const transformed = babel.transformFileSync(filename, {
    envName: "production",
    babelrc: false,
    presets: ["module:@react-native/babel-preset"],
    plugins: ["react-native-worklets/plugin"],
    configFile: false,
  });
  const exports: { valueSetter?: Worklet } = {};
  new Function("exports", transformed.code)(exports);
  if (!exports.valueSetter?.__initData?.code)
    throw new Error("Installed Reanimated valueSetter was not workletized");
  return exports.valueSetter;
};

/** Execute Babel's serialized body in a separate global environment, as the
 * Worklets value unpacker does. RN functions remain remote handles; only the
 * scheduler may invoke them. Jest/native mocks and SharedValues are hosts. */
export const createSerializedUiRuntime = () => {
  const context = createContext({ console, performance, __DEV__: false });
  runInContext("global = globalThis", context);
  const hosts = new WeakSet<object>();
  const unpacked = new WeakMap<object, unknown>();
  const originals = new WeakMap<Function, Function>();
  let evaluatedBodies = 0;

  const host = <T extends object>(value: T): T => {
    hosts.add(value);
    return value;
  };
  const unpack = (value: any): any => {
    if (
      (typeof value !== "object" || value === null) &&
      typeof value !== "function"
    )
      return value;
    if (hosts.has(value) || jest.isMockFunction(value)) return value;
    if (unpacked.has(value)) return unpacked.get(value);
    if (typeof value === "function") {
      const worklet = value as Worklet;
      if (worklet.__workletHash !== undefined) {
        if (!worklet.__initData?.code)
          throw new Error("Serialized worklet code is missing");
        const descriptor = { __closure: {} as Record<string, unknown> };
        const evaluated = runInContext(worklet.__initData.code, context);
        const fn = evaluated.bind(descriptor);
        unpacked.set(value, fn);
        for (const [key, capture] of Object.entries(worklet.__closure ?? {}))
          descriptor.__closure[key] = unpack(capture);
        evaluatedBodies++;
        return fn;
      }
      const remote = () => {
        throw new Error(
          `RN function ${value.name || "anonymous"} called synchronously on UI`,
        );
      };
      originals.set(remote, value);
      unpacked.set(value, remote);
      return remote;
    }
    if (Array.isArray(value)) {
      const array: unknown[] = [];
      unpacked.set(value, array);
      for (const item of value) array.push(unpack(item));
      return array;
    }
    const object: Record<string, unknown> = {};
    unpacked.set(value, object);
    for (const [key, property] of Object.entries(value))
      object[key] = unpack(property);
    return object;
  };

  return {
    host,
    unpackWorklet: (fn: Worklet) => {
      if (fn.__workletHash === undefined)
        throw new Error(
          "UI entrypoint was not transformed by the Worklets plugin",
        );
      return unpack(fn) as Worklet;
    },
    scheduleOnRN: (fn: Function, ...args: unknown[]) => {
      const original = originals.get(fn);
      if (!original)
        throw new Error("UI scheduler expected a captured RN function");
      return original(...args);
    },
    get evaluatedBodies() {
      return evaluatedBodies;
    },
  };
};
