import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  VeruleExecutionError,
  defineConfig,
  defineModel,
  defineRule,
  isSameInstance,
  openSession,
  runCheck,
  type InstanceRef,
  type InstanceResolutionResult,
  type SyntaxRef,
} from "@verule/sdk";

function createTempProject(
  files: Record<string, string>,
  compilerOptions?: Record<string, unknown>,
): string {
  const root = mkdtempSync(join(tmpdir(), "verule-instance-identity-test-"));
  if (!("tsconfig.json" in files)) {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            ...compilerOptions,
          },
          include: ["src/**/*"],
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void describe("@verule/sdk instance identity", () => {
  void it("distinguishes separate constructor and factory calls while preserving identity across aliases, import renaming, same-name declarations, and cross-file forwarding", async () => {
    const root = createTempProject({
      "src/resource.ts": [
        "export class Store {",
        "  readonly tag = 'store';",
        "}",
        "",
        "export function createResource(): Store {",
        "  return new Store();",
        "}",
        "",
        "export function makeWrapper(): Store {",
        "  return createResource();",
        "}",
        "",
      ].join("\n"),
      "src/other.ts": [
        "import { Store } from './resource.js';",
        "",
        "export function createResource(): Store {",
        "  return new Store();",
        "}",
        "",
      ].join("\n"),
      "src/forward.ts": [
        "import type { Store } from './resource.js';",
        "",
        "export function passthrough(value: Store): Store {",
        "  const forwarded = value;",
        "  return forwarded;",
        "}",
        "",
      ].join("\n"),
      "src/app.ts": [
        "import { createResource as makeRes, makeWrapper, Store } from './resource.js';",
        "import { createResource as makeOther } from './other.js';",
        "import { passthrough } from './forward.js';",
        "",
        "export function runScenario(): void {",
        "  function createResource(): Store {",
        "    return new Store();",
        "  }",
        "  const direct1 = new Store();",
        "  const direct2 = new Store();",
        "  const fac1 = makeRes();",
        "  const fac2 = makeRes();",
        "  const aliasFac1 = fac1;",
        "  const forwardedFac1 = passthrough(aliasFac1);",
        "  const forwardedFresh = passthrough(makeRes());",
        "  const wrap1 = makeWrapper();",
        "  const wrap2 = makeWrapper();",
        "  const otherFac = makeOther();",
        "  const localFac = createResource();",
        "  void [direct1, direct2, fac2, forwardedFac1, forwardedFresh, wrap1, wrap2, otherFac, localFac];",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const resultsByVar = new Map<string, InstanceResolutionResult>();
      let projectedKey: string | undefined;
      let projectedAllocFile: string | undefined;

      const rule = defineRule({
        id: "check-factory-instances",
        run: async (ctx) => {
          const varDecls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["VariableDeclaration"],
          });
          const names = [
            "direct1",
            "direct2",
            "fac1",
            "fac2",
            "aliasFac1",
            "forwardedFac1",
            "forwardedFresh",
            "wrap1",
            "wrap2",
            "otherFac",
            "localFac",
          ];
          const targets: SyntaxRef[] = [];
          const targetNames: string[] = [];
          for (const name of names) {
            const node = varDecls.find((d) => d.text.startsWith(`${name} =`));
            assert.ok(node?.initializer, `Missing variable ${name}`);
            targets.push(node.initializer);
            targetNames.push(name);
          }

          const resolved = await ctx.resolveInstances(targets);
          for (const [idx, row] of resolved.entries()) {
            resultsByVar.set(targetNames[idx]!, row);
          }

          const fac1Ref = resultsByVar.get("fac1")?.instance;
          assert.ok(fac1Ref, "fac1 should resolve to an InstanceRef");
          const [projected] = await ctx.projectInstances([fac1Ref], {
            select: {
              instanceKey: true,
              allocationLocation: true,
              originKind: true,
              evidence: true,
            },
          });
          assert.ok(projected);
          projectedKey = projected.instanceKey;
          projectedAllocFile = projected.allocationLocation?.file;
          assert.equal(projected.originKind, "allocation");
          assert.ok(projected.evidence.some((e) => e.kind === "source"));
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      assert.deepEqual(report.gaps, []);

      const get = (name: string): InstanceResolutionResult => {
        const res = resultsByVar.get(name);
        assert.ok(res, `Missing result for ${name}`);
        assert.ok(res.instance, `Expected resolved instance for ${name}`);
        assert.equal(res.originKind, "allocation");
        assert.deepEqual(res.gaps, []);
        assert.ok(
          res.evidence.some((e) => e.kind === "source"),
          `Expected source evidence for ${name}`,
        );
        return res;
      };

      const direct1 = get("direct1");
      const direct2 = get("direct2");
      assert.equal(isSameInstance(direct1.instance, direct2.instance), false);
      assert.notEqual(direct1.instanceKey, direct2.instanceKey);
      assert.equal(direct1.allocationLocation?.file, "src/app.ts");

      const fac1 = get("fac1");
      const fac2 = get("fac2");
      const aliasFac1 = get("aliasFac1");
      const forwardedFac1 = get("forwardedFac1");
      const forwardedFresh = get("forwardedFresh");

      assert.equal(isSameInstance(fac1.instance, fac2.instance), false);
      assert.notEqual(fac1.instanceKey, fac2.instanceKey);

      assert.equal(isSameInstance(fac1.instance, aliasFac1.instance), true);
      assert.equal(fac1.instanceKey, aliasFac1.instanceKey);

      assert.equal(isSameInstance(fac1.instance, forwardedFac1.instance), true);
      assert.equal(fac1.instanceKey, forwardedFac1.instanceKey);

      assert.equal(
        isSameInstance(fac1.instance, forwardedFresh.instance),
        false,
      );
      assert.notEqual(fac1.instanceKey, forwardedFresh.instanceKey);

      const wrap1 = get("wrap1");
      const wrap2 = get("wrap2");
      assert.equal(isSameInstance(wrap1.instance, wrap2.instance), false);
      assert.equal(wrap1.allocationLocation?.file, "src/resource.ts");

      const otherFac = get("otherFac");
      const localFac = get("localFac");
      assert.equal(otherFac.allocationLocation?.file, "src/other.ts");
      assert.equal(localFac.allocationLocation?.file, "src/app.ts");
      assert.equal(isSameInstance(fac1.instance, otherFac.instance), false);
      assert.equal(isSameInstance(fac1.instance, localFac.instance), false);
      assert.equal(isSameInstance(otherFac.instance, localFac.instance), false);

      assert.equal(projectedKey, fac1.instanceKey);
      assert.equal(projectedAllocFile, "src/resource.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("tracks object and class fields per host instance and field name, closure captures, and module singletons across files", async () => {
    const root = createTempProject({
      "src/resource.ts": [
        "export class Store {",
        "  dispose(): void {}",
        "}",
        "",
        "export function createResource(): Store {",
        "  return new Store();",
        "}",
        "",
        "const moduleSingleton = createResource();",
        "export function getSingletonA(): Store {",
        "  return moduleSingleton;",
        "}",
        "export function getSingletonB(): Store {",
        "  return moduleSingleton;",
        "}",
        "",
      ].join("\n"),
      "src/holder.ts": [
        "import { createResource, Store } from './resource.js';",
        "",
        "export interface Holder {",
        "  item?: Store;",
        "  other?: Store;",
        "}",
        "",
        "export function createHolder(): Holder {",
        "  return {};",
        "}",
        "",
        "export function setItem(holder: Holder, value: Store): void {",
        "  holder.item = value;",
        "}",
        "",
        "export function getItem(holder: Holder): Store | undefined {",
        "  return holder.item;",
        "}",
        "",
        "export class Manager {",
        "  private _store: Store;",
        "  private _other: Store;",
        "  constructor(initial?: Store) {",
        "    this._store = initial ?? createResource();",
        "    this._other = createResource();",
        "  }",
        "  getStore(): Store {",
        "    return this._store;",
        "  }",
        "  getOther(): Store {",
        "    return this._other;",
        "  }",
        "  setStore(next: Store): void {",
        "    this._store = next;",
        "  }",
        "  inspectOwn(): [Store, Store] {",
        "    return [this._store, this._other];",
        "  }",
        "}",
        "",
        "export function makeGetter(): () => Store {",
        "  const captured = createResource();",
        "  return () => captured;",
        "}",
        "",
      ].join("\n"),
      "src/app.ts": [
        "import { createResource, getSingletonA, getSingletonB, Store } from './resource.js';",
        "import { createHolder, getItem, makeGetter, Manager, setItem } from './holder.js';",
        "",
        "function cleanup(_target: Store): void {}",
        "",
        "export function exerciseFieldsAndClosures(): void {",
        "  const a = createResource();",
        "  const b = createResource();",
        "  const c = createResource();",
        "",
        "  const h1 = createHolder();",
        "  const h2 = createHolder();",
        "  setItem(h1, a);",
        "  h1.other = b;",
        "  setItem(h2, c);",
        "",
        "  const readH1Item = getItem(h1);",
        "  const readH1Other = h1.other;",
        "  const readH2Item = getItem(h2);",
        "",
        "  const m1 = new Manager(a);",
        "  const m2 = new Manager(b);",
        "  const m1StoreBefore = m1.getStore();",
        "  const m1StoreAgain = m1.getStore();",
        "  const m1Other = m1.getOther();",
        "  const m2Store = m2.getStore();",
        "",
        "  m1.setStore(c);",
        "  const m1StoreAfter = m1.getStore();",
        "",
        "  const runClosure = () => {",
        "    const inner = a;",
        "    cleanup(inner);",
        "  };",
        "",
        "  const g1 = makeGetter();",
        "  const g2 = makeGetter();",
        "  const g1First = g1();",
        "  const g1Second = g1();",
        "  const g2First = g2();",
        "",
        "  const sing1 = getSingletonA();",
        "  const sing2 = getSingletonB();",
        "  void [readH1Item, readH1Other, readH2Item, m1StoreBefore, m1StoreAgain, m1Other, m2Store, m1StoreAfter, runClosure, g1First, g1Second, g2First, sing1, sing2];",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const resultsByName = new Map<string, InstanceResolutionResult>();

      const rule = defineRule({
        id: "check-fields-closures",
        run: async (ctx) => {
          const varDecls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["VariableDeclaration"],
          });
          const names = [
            "a",
            "b",
            "c",
            "readH1Item",
            "readH1Other",
            "readH2Item",
            "m1StoreBefore",
            "m1StoreAgain",
            "m1Other",
            "m2Store",
            "m1StoreAfter",
            "inner",
            "g1First",
            "g1Second",
            "g2First",
            "sing1",
            "sing2",
          ];
          const targets: SyntaxRef[] = [];
          const targetNames: string[] = [];
          for (const name of names) {
            const node = varDecls.find((d) => d.text.startsWith(`${name} =`));
            assert.ok(node?.initializer, `Missing variable ${name}`);
            targets.push(node.initializer);
            targetNames.push(name);
          }

          const resolved = await ctx.resolveInstances(targets);
          for (const [idx, row] of resolved.entries()) {
            resultsByName.set(targetNames[idx]!, row);
          }
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      assert.deepEqual(report.gaps, []);

      const getInst = (name: string) => {
        const row = resultsByName.get(name);
        assert.ok(row?.instance, `Expected instance for ${name}`);
        return row.instance;
      };

      const a = getInst("a");
      const b = getInst("b");
      const c = getInst("c");

      // Same host different fields vs different hosts same field
      const readH1Item = getInst("readH1Item");
      const readH1Other = getInst("readH1Other");
      const readH2Item = getInst("readH2Item");
      assert.equal(isSameInstance(readH1Item, a), true);
      assert.equal(isSameInstance(readH1Other, b), true);
      assert.equal(isSameInstance(readH2Item, c), true);
      assert.equal(isSameInstance(readH1Item, readH1Other), false);
      assert.equal(isSameInstance(readH1Item, readH2Item), false);

      // Class instance fields & sequential overwrite
      const m1StoreBefore = getInst("m1StoreBefore");
      const m1StoreAgain = getInst("m1StoreAgain");
      const m1Other = getInst("m1Other");
      const m2Store = getInst("m2Store");
      const m1StoreAfter = getInst("m1StoreAfter");
      assert.equal(isSameInstance(m1StoreBefore, a), true);
      assert.equal(isSameInstance(m1StoreAgain, a), true);
      assert.equal(isSameInstance(m1StoreBefore, m1Other), false);
      assert.equal(isSameInstance(m2Store, b), true);
      assert.equal(isSameInstance(m1StoreBefore, m2Store), false);
      assert.equal(isSameInstance(m1StoreAfter, c), true);
      assert.equal(isSameInstance(m1StoreAfter, m1StoreBefore), false);

      // Closure capture & closure factory
      const inner = getInst("inner");
      assert.equal(isSameInstance(inner, a), true);
      const innerRow = resultsByName.get("inner")!;
      assert.ok(innerRow.evidence.some((e) => e.kind === "source"));

      const g1First = getInst("g1First");
      const g1Second = getInst("g1Second");
      const g2First = getInst("g2First");
      assert.equal(isSameInstance(g1First, g1Second), true);
      assert.equal(isSameInstance(g1First, g2First), false);

      // Module-level singleton shared across callers
      const sing1 = getInst("sing1");
      const sing2 = getInst("sing2");
      assert.equal(isSameInstance(sing1, sing2), true);

      // Inside class method `inspectOwn()`, `this._store` and `this._other` remain distinct
      let ownStore: InstanceRef | undefined;
      let ownOther: InstanceRef | undefined;
      const ownRule = defineRule({
        id: "inspect-this-fields",
        run: async (ctx) => {
          const props = await ctx.findSyntax({
            files: ["src/holder.ts"],
            kinds: ["PropertyAccessExpression"],
          });
          const storeAccess = props.find((p) => p.text === "this._store");
          const otherAccess = props.find((p) => p.text === "this._other");
          assert.ok(storeAccess && otherAccess);
          const [r1, r2] = await ctx.resolveInstances([
            storeAccess.ref,
            otherAccess.ref,
          ]);
          ownStore = r1?.instance ?? undefined;
          ownOther = r2?.instance ?? undefined;
        },
      });
      await runCheck({
        cwd: root,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [ownRule] }),
      });
      assert.ok(ownStore && ownOther);
      assert.equal(isSameInstance(ownStore, ownOther), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("applies Model behaviors for external .d.ts factories/forwarders, reports gaps when unmodeled, invalidates on update, and rejects stale InstanceRef", async () => {
    const root = createTempProject({
      "node_modules/@acme/ui/index.d.ts": [
        "export interface Event<T> {",
        "  (listener: (e: T) => void): void;",
        "}",
        "export declare namespace Event {",
        "  function once<T>(event: Event<T>): Event<T>;",
        "}",
        "export interface IMenu {",
        "  dispose(): void;",
        "}",
        "export interface IMenuService {",
        "  createMenu(id: number): IMenu;",
        "}",
        "export interface IInstantiationService {",
        "  createInstance<T>(ctor: new (...args: unknown[]) => T): T;",
        "}",
        "export declare class DisposableStore {",
        "  add<T>(o: T): T;",
        "  dispose(): void;",
        "}",
        "export declare class Disposable {",
        "  protected _register<T>(o: T): T;",
        "}",
        "export declare function unmodeledExternal(): IMenu;",
        "",
      ].join("\n"),
      "node_modules/@acme/ui/package.json": JSON.stringify(
        {
          name: "@acme/ui",
          version: "1.0.0",
          types: "./index.d.ts",
        },
        null,
        2,
      ),
      "src/app.ts": [
        "import {",
        "  Disposable,",
        "  DisposableStore,",
        "  Event,",
        "  type IInstantiationService,",
        "  type IMenu,",
        "  type IMenuService,",
        "  unmodeledExternal,",
        "} from '@acme/ui';",
        "",
        "class Widget {",
        "  dispose(): void {}",
        "}",
        "",
        "export class Panel extends Disposable {",
        "  private readonly _store = new DisposableStore();",
        "  private _widget: Widget;",
        "  constructor(",
        "    event: Event<void>,",
        "    menuService: IMenuService,",
        "    instantiationService: IInstantiationService,",
        "    flag: boolean,",
        "    dynamicFactory: () => IMenu,",
        "  ) {",
        "    super();",
        "    const w1 = new Widget();",
        "    const registered = this._register(w1);",
        "    const added = this._store.add(w1);",
        "    this._widget = registered;",
        "    const evOnce1 = Event.once(event);",
        "    const evOnce2 = Event.once(event);",
        "    const menu1 = menuService.createMenu(1);",
        "    const menu2 = menuService.createMenu(2);",
        "    const menu1Alias = menu1;",
        "    const inst1 = instantiationService.createInstance(Widget);",
        "    const inst2 = instantiationService.createInstance(Widget);",
        "    const unknownExt = unmodeledExternal();",
        "    const partial = flag ? menu1 : unmodeledExternal();",
        "    const dyn = dynamicFactory();",
        "    void [added, this._widget, evOnce1, evOnce2, menu1Alias, menu2, inst1, inst2, unknownExt, partial, dyn];",
        "  }",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const baseModel = defineModel({
        id: "acme-ui-model",
        version: "1.0.0",
        facts: { compatible: true },
        instanceBehaviors: [
          {
            kind: "allocates-fresh-instance",
            match: { module: "@acme/ui", symbol: "Event.once" },
          },
          {
            kind: "allocates-fresh-instance",
            match: {
              module: "@acme/ui",
              container: "IMenuService",
              member: "createMenu",
            },
          },
          {
            kind: "allocates-fresh-instance",
            match: {
              container: "IInstantiationService",
              member: "createInstance",
            },
          },
          {
            kind: "forwards-argument",
            match: { container: "Disposable", member: "_register" },
            argumentIndex: 0,
          },
          {
            kind: "forwards-argument",
            match: { container: "DisposableStore", member: "add" },
            argumentIndex: 0,
          },
        ],
      });

      const resolvedMap = new Map<string, InstanceResolutionResult>();
      let staleInstRef: InstanceRef | undefined;
      let staleErrorCode: string | undefined;

      const inspectRule = defineRule({
        id: "inspect-model-and-gaps",
        run: async (ctx) => {
          const varDecls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["VariableDeclaration"],
          });
          const names = [
            "w1",
            "registered",
            "added",
            "evOnce1",
            "evOnce2",
            "menu1",
            "menu2",
            "menu1Alias",
            "inst1",
            "inst2",
            "unknownExt",
            "partial",
            "dyn",
          ];
          const targets: SyntaxRef[] = [];
          const order: string[] = [];
          for (const name of names) {
            const node = varDecls.find((d) => d.text.startsWith(`${name} =`));
            assert.ok(node?.initializer, `Missing ${name}`);
            targets.push(node.initializer);
            order.push(name);
          }

          const rows = await ctx.resolveInstances(targets);
          for (const [idx, row] of rows.entries()) {
            resolvedMap.set(order[idx]!, row);
          }

          if (staleInstRef !== undefined) {
            try {
              await ctx.projectInstances([staleInstRef], {
                select: { instanceKey: true },
              });
            } catch (err) {
              if (err instanceof VeruleExecutionError) {
                staleErrorCode = err.code;
              }
            }
          }
        },
      });

      const session = await openSession({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          models: [baseModel],
          rules: [inspectRule],
        }),
      });

      try {
        const firstReport = await session.check();
        assert.equal(firstReport.status, "clean");
        assert.ok(
          firstReport.gaps.some((g) => g.kind === "missing-instance-model"),
          "Expected missing-instance-model gap for unmodeledExternal()",
        );
        assert.ok(
          firstReport.gaps.some((g) => g.kind === "dynamic-callee"),
          "Expected dynamic-callee gap for dynamicFactory()",
        );

        const w1 = resolvedMap.get("w1")!;
        const registered = resolvedMap.get("registered")!;
        const added = resolvedMap.get("added")!;
        assert.ok(w1.instance);
        assert.equal(isSameInstance(w1.instance, registered.instance), true);
        assert.equal(isSameInstance(w1.instance, added.instance), true);
        assert.ok(registered.evidence.some((e) => e.kind === "source"));
        assert.ok(
          registered.evidence.some(
            (e) =>
              e.kind === "model" &&
              e.modelId === "acme-ui-model" &&
              e.declaration?.includes("_register"),
          ),
          `Expected model evidence for _register, got ${JSON.stringify(registered.evidence)}`,
        );
        assert.ok(
          added.evidence.some(
            (e) =>
              e.kind === "model" &&
              e.modelId === "acme-ui-model" &&
              e.declaration?.includes("add"),
          ),
        );

        const evOnce1 = resolvedMap.get("evOnce1")!;
        const evOnce2 = resolvedMap.get("evOnce2")!;
        assert.ok(evOnce1.instance && evOnce2.instance);
        assert.equal(evOnce1.originKind, "model-allocation");
        assert.equal(
          isSameInstance(evOnce1.instance, evOnce2.instance),
          false,
        );
        assert.ok(
          evOnce1.evidence.some(
            (e) => e.kind === "model" && e.modelId === "acme-ui-model",
          ),
        );

        const menu1 = resolvedMap.get("menu1")!;
        const menu2 = resolvedMap.get("menu2")!;
        const menu1Alias = resolvedMap.get("menu1Alias")!;
        assert.ok(menu1.instance && menu2.instance && menu1Alias.instance);
        assert.equal(menu1.originKind, "model-allocation");
        assert.equal(isSameInstance(menu1.instance, menu2.instance), false);
        assert.equal(
          isSameInstance(menu1.instance, menu1Alias.instance),
          true,
        );

        const inst1 = resolvedMap.get("inst1")!;
        const inst2 = resolvedMap.get("inst2")!;
        assert.ok(inst1.instance && inst2.instance);
        assert.equal(isSameInstance(inst1.instance, inst2.instance), false);

        // Unmodeled .d.ts call -> null instance + missing-instance-model gap
        const unknownExt = resolvedMap.get("unknownExt")!;
        assert.equal(unknownExt.instance, null);
        assert.equal(unknownExt.instances.length, 0);
        assert.ok(
          unknownExt.gaps.some((g) => g.kind === "missing-instance-model"),
        );

        // Partial resolution: keeps known branch `menu1` while reporting gap for `unmodeledExternal()`
        const partial = resolvedMap.get("partial")!;
        assert.equal(partial.instances.length, 1);
        assert.equal(isSameInstance(partial.instance, menu1.instance), true);
        assert.ok(
          partial.gaps.some((g) => g.kind === "missing-instance-model"),
        );

        // Dynamic callee -> null instance + dynamic-callee gap
        const dyn = resolvedMap.get("dyn")!;
        assert.equal(dyn.instance, null);
        assert.ok(dyn.gaps.some((g) => g.kind === "dynamic-callee"));

        // Capture snapshot-1 InstanceRef, then update models to cover `unmodeledExternal`
        staleInstRef = menu1.instance;
        const extendedModel = defineModel({
          ...baseModel,
          version: "1.1.0",
          instanceBehaviors: [
            ...(baseModel.instanceBehaviors ?? []),
            {
              kind: "allocates-fresh-instance",
              match: { module: "@acme/ui", symbol: "unmodeledExternal" },
            },
          ],
        });

        const updateRes = await session.update({ models: [extendedModel] });
        assert.ok(updateRes.recomputation.invalidatedBy.includes("models"));

        resolvedMap.clear();
        const secondReport = await session.check();
        assert.equal(secondReport.status, "clean");
        assert.equal(staleErrorCode, "STALE_REFERENCE");

        const nowModeled = resolvedMap.get("unknownExt")!;
        assert.ok(
          nowModeled.instance,
          "Expected unmodeledExternal to resolve after model update",
        );
        assert.equal(nowModeled.originKind, "model-allocation");
        assert.deepEqual(nowModeled.gaps, []);
        assert.ok(
          nowModeled.evidence.some(
            (e) => e.kind === "model" && e.modelId === "acme-ui-model",
          ),
        );

        const partialAfter = resolvedMap.get("partial")!;
        assert.equal(partialAfter.instances.length, 2);
        assert.deepEqual(partialAfter.gaps, []);

        // Edit source file to alias `menu2` instead of `menu1` and verify cache invalidation
        const appPath = join(root, "src/app.ts");
        const updatedApp = [
          "import {",
          "  Disposable,",
          "  DisposableStore,",
          "  Event,",
          "  type IInstantiationService,",
          "  type IMenu,",
          "  type IMenuService,",
          "  unmodeledExternal,",
          "} from '@acme/ui';",
          "",
          "class Widget {",
          "  dispose(): void {}",
          "}",
          "",
          "export class Panel extends Disposable {",
          "  private readonly _store = new DisposableStore();",
          "  private _widget: Widget;",
          "  constructor(",
          "    event: Event<void>,",
          "    menuService: IMenuService,",
          "    instantiationService: IInstantiationService,",
          "    flag: boolean,",
          "    dynamicFactory: () => IMenu,",
          "  ) {",
          "    super();",
          "    const w1 = new Widget();",
          "    const registered = this._register(w1);",
          "    const added = this._store.add(w1);",
          "    this._widget = registered;",
          "    const evOnce1 = Event.once(event);",
          "    const evOnce2 = Event.once(event);",
          "    const menu1 = menuService.createMenu(1);",
          "    const menu2 = menuService.createMenu(2);",
          "    const menu1Alias = menu2;",
          "    const inst1 = instantiationService.createInstance(Widget);",
          "    const inst2 = instantiationService.createInstance(Widget);",
          "    const unknownExt = unmodeledExternal();",
          "    const partial = flag ? menu1 : unmodeledExternal();",
          "    const dyn = dynamicFactory();",
          "    void [added, this._widget, evOnce1, evOnce2, menu1Alias, menu2, inst1, inst2, unknownExt, partial, dyn];",
          "  }",
          "}",
          "",
        ].join("\n");
        writeFileSync(appPath, updatedApp, "utf8");
        const srcUpdate = await session.update({ changed: ["src/app.ts"] });
        assert.ok(srcUpdate.recomputation.invalidatedBy.includes("changed:src/app.ts"));

        resolvedMap.clear();
        await session.check();
        const menu1AfterEdit = resolvedMap.get("menu1")!;
        const menu2AfterEdit = resolvedMap.get("menu2")!;
        const menu1AliasAfterEdit = resolvedMap.get("menu1Alias")!;
        assert.equal(
          isSameInstance(menu1AliasAfterEdit.instance, menu2AfterEdit.instance),
          true,
        );
        assert.equal(
          isSameInstance(menu1AliasAfterEdit.instance, menu1AfterEdit.instance),
          false,
        );
      } finally {
        await session.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("validates Model instanceBehaviors definitions", () => {
    assert.throws(
      () =>
        defineModel({
          id: "bad-match",
          instanceBehaviors: [
            {
              kind: "allocates-fresh-instance",
              match: {},
            },
          ],
        }),
      (err) => err instanceof VeruleExecutionError && err.code === "INVALID_CONFIG",
    );

    assert.throws(
      () =>
        defineModel({
          id: "bad-arg-index",
          instanceBehaviors: [
            {
              kind: "forwards-argument",
              match: { member: "_register" },
              argumentIndex: -1,
            },
          ],
        }),
      (err) => err instanceof VeruleExecutionError && err.code === "INVALID_CONFIG",
    );
  });
});
