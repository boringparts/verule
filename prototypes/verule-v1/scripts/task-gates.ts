import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type TaskGate = "check" | "check:heavy" | "check:full" | "fix";

type ScriptRole =
  | "quality:light"
  | "quality:heavy"
  | "quality:conditional"
  | "quality:entry"
  | "work:development"
  | "work:repair"
  | "work:release"
  | "work:preparation"
  | "work:lifecycle"
  | "work:on-demand";

type TurboTask = {
  readonly name: string;
  readonly fullName: string;
  readonly packageName: string;
  readonly tags: readonly string[];
  readonly executable: boolean;
  readonly role?: ScriptRole;
};

type GateLayer = {
  readonly role: "quality:light" | "quality:heavy" | "work:repair";
  readonly label: string;
};

type CommandResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error: Error | undefined;
};

const turboTaskQuery =
  "{ packages { items { name tasks { items { name fullName tags script command } } } } }";

const validRoles = new Set<ScriptRole>([
  "quality:light",
  "quality:heavy",
  "quality:conditional",
  "quality:entry",
  "work:development",
  "work:repair",
  "work:release",
  "work:preparation",
  "work:lifecycle",
  "work:on-demand",
]);

const publicGateNames = new Set<TaskGate>([
  "check",
  "check:heavy",
  "check:full",
  "fix",
]);

const defaultEntryCommand = "node --conditions=source scripts/task-gates.ts";
const maxTurboOutputBytes = 16 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function report(message: string): void {
  process.stderr.write(`${message}\n`);
}

type TurboCommand = readonly [string, ...string[]];

function runCaptured(
  cwd: string,
  args: readonly string[],
  command: TurboCommand = ["pnpm", "exec", "turbo"],
): CommandResult {
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: maxTurboOutputBytes,
  });

  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function runVisible(cwd: string, args: readonly string[]): Promise<number> {
  return new Promise((resolveStatus) => {
    const command =
      process.platform === "win32"
        ? "pnpm"
        : resolve(cwd, "node_modules/.bin/turbo");
    const commandArgs =
      process.platform === "win32" ? ["exec", "turbo", ...args] : args;
    const child = spawn(command, commandArgs, {
      cwd,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    let interruptedBy: NodeJS.Signals | undefined;
    const forward = (signal: NodeJS.Signals): void => {
      if (child.exitCode === null && child.signalCode === null) {
        interruptedBy = signal;
        const turboSignal = signal === "SIGTERM" ? "SIGINT" : signal;
        if (process.platform !== "win32" && child.pid !== undefined) {
          try {
            process.kill(-child.pid, turboSignal);
          } catch {
            child.kill(turboSignal);
          }
        } else {
          child.kill(turboSignal);
        }
      }
    };
    const forwardInterrupt = (): void => forward("SIGINT");
    const forwardTerminate = (): void => forward("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", forwardInterrupt);
      process.off("SIGTERM", forwardTerminate);
    };

    process.on("SIGINT", forwardInterrupt);
    process.on("SIGTERM", forwardTerminate);
    child.once("error", (error) => {
      removeSignalHandlers();
      report(`Could not start turbo ${args.join(" ")}: ${error.message}`);
      resolveStatus(1);
    });
    child.once("close", (code, signal) => {
      removeSignalHandlers();
      if (interruptedBy !== undefined) {
        resolveStatus(interruptedBy === "SIGINT" ? 130 : 143);
      } else if (code !== null) {
        resolveStatus(code);
      } else {
        resolveStatus(
          signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1,
        );
      }
    });
  });
}

function commandFailure(label: string, result: CommandResult): string {
  const details = result.stderr.trim();
  if (result.error !== undefined) {
    return `Could not run turbo ${label}: ${result.error.message}`;
  }
  return `Turbo ${label} failed (exit ${String(result.status)})${details === "" ? "" : `:\n${details}`}`;
}

function roleTags(tags: readonly string[]): readonly string[] {
  return tags.filter(
    (tag) => tag.startsWith("quality:") || tag.startsWith("work:"),
  );
}

function publicGateTask(task: {
  readonly name: string;
  readonly packageName: string;
}): boolean {
  return (
    task.packageName === "//" && publicGateNames.has(task.name as TaskGate)
  );
}

function protectedVerificationTask(task: TurboTask): boolean {
  return (
    task.name === "check" ||
    task.name.startsWith("check:") ||
    task.name === "test" ||
    task.name.startsWith("test:") ||
    task.name === "lint" ||
    task.name === "typecheck" ||
    task.name === "format:check"
  );
}

function assignRole(
  task: Omit<TurboTask, "role">,
  diagnostics: string[],
): ScriptRole | undefined {
  const roles = roleTags(task.tags);
  const isPublicGate = publicGateTask(task);
  if (roles.length === 0) {
    diagnostics.push(
      `${task.fullName} needs exactly one task responsibility tag in turbo.json`,
    );
    return undefined;
  }
  if (roles.length > 1) {
    diagnostics.push(
      `${task.fullName} declares multiple task responsibilities: ${roles.join(", ")}`,
    );
    return undefined;
  }

  const role = roles[0]!;
  if (!validRoles.has(role as ScriptRole)) {
    diagnostics.push(
      `${task.fullName} declares an unknown responsibility: ${role}`,
    );
    return undefined;
  }
  const scriptRole = role as ScriptRole;
  const publicRole = task.name === "fix" ? "work:repair" : "quality:entry";
  if (isPublicGate && scriptRole !== publicRole) {
    diagnostics.push(
      `${task.fullName} must declare ${publicRole} at the public entry point (found ${scriptRole})`,
    );
    return undefined;
  }
  if (!isPublicGate && scriptRole === "quality:entry") {
    diagnostics.push(
      `${task.fullName} cannot declare quality:entry outside the root check commands`,
    );
    return undefined;
  }
  if (protectedVerificationTask(task) && !scriptRole.startsWith("quality:")) {
    diagnostics.push(
      `${task.fullName} is an acceptance task and cannot declare ${scriptRole}`,
    );
    return undefined;
  }

  return scriptRole;
}

function readTaskDirectory(
  cwd: string,
  entryCommand: string,
  turboCommand?: TurboCommand,
): {
  readonly tasks: readonly TurboTask[];
  readonly diagnostics: readonly string[];
} {
  const result = runCaptured(cwd, ["query", turboTaskQuery], turboCommand);
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("task query", result)],
      tasks: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Invalid JSON in turbo task query: ${error instanceof Error ? error.message : String(error)}`,
      ],
      tasks: [],
    };
  }

  const packages =
    isRecord(response) && isRecord(response.data)
      ? response.data.packages
      : undefined;
  const packageItems = isRecord(packages) ? packages.items : undefined;
  if (!Array.isArray(packageItems)) {
    return {
      diagnostics: ["Turbo task query is missing packages.items"],
      tasks: [],
    };
  }

  const diagnostics: string[] = [];
  const tasks: TurboTask[] = [];
  for (const packageItem of packageItems) {
    if (!isRecord(packageItem) || !isNonEmptyString(packageItem.name)) {
      diagnostics.push(
        "Turbo task query returned an unrecognized workspace package",
      );
      continue;
    }
    const taskConnection = packageItem.tasks;
    const taskItems = isRecord(taskConnection)
      ? taskConnection.items
      : undefined;
    if (!Array.isArray(taskItems)) {
      diagnostics.push(
        `${packageItem.name} is missing tasks.items in the turbo task query`,
      );
      continue;
    }

    for (const taskItem of taskItems) {
      if (!isRecord(taskItem)) {
        diagnostics.push(
          `${packageItem.name} has an invalid task in the turbo task query`,
        );
        continue;
      }
      const { name, fullName, tags, script, command } = taskItem;
      if (
        !isNonEmptyString(name) ||
        !isNonEmptyString(fullName) ||
        !Array.isArray(tags) ||
        !tags.every((tag) => typeof tag === "string")
      ) {
        diagnostics.push(
          `${packageItem.name} has a task with a missing name or tag`,
        );
        continue;
      }

      const executable = isNonEmptyString(script) || isNonEmptyString(command);
      const taskWithoutRole = {
        name,
        fullName,
        packageName: packageItem.name,
        tags,
        executable,
      };
      if (publicGateTask(taskWithoutRole)) {
        const expectedCommand = `${entryCommand} ${name}`;
        if (script !== expectedCommand || command !== expectedCommand) {
          diagnostics.push(
            `${fullName} must declare and execute the public command ${expectedCommand}`,
          );
        }
      }
      if (!executable && roleTags(tags).length === 0) {
        tasks.push(taskWithoutRole);
        continue;
      }

      const role = assignRole(taskWithoutRole, diagnostics);
      tasks.push(
        role === undefined ? taskWithoutRole : { ...taskWithoutRole, role },
      );
    }
  }

  for (const name of publicGateNames) {
    if (
      !tasks.some((task) => task.packageName === "//" && task.name === name)
    ) {
      diagnostics.push(`Missing public root task ${name}`);
    }
  }

  return { diagnostics, tasks };
}

function parseDryRun(
  cwd: string,
  tasks: readonly TurboTask[],
  turboCommand?: TurboCommand,
): {
  readonly taskIds: readonly string[];
  readonly diagnostics: readonly string[];
} {
  if (tasks.length === 0) {
    return { diagnostics: [], taskIds: [] };
  }
  const result = runCaptured(
    cwd,
    ["run", ...tasks.map((task) => task.fullName), "--dry=json"],
    turboCommand,
  );
  if (result.error !== undefined || result.status !== 0) {
    return {
      diagnostics: [commandFailure("dry run", result)],
      taskIds: [],
    };
  }

  let response: unknown;
  try {
    response = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    return {
      diagnostics: [
        `Invalid JSON in turbo dry run: ${error instanceof Error ? error.message : String(error)}`,
      ],
      taskIds: [],
    };
  }
  if (!isRecord(response) || !Array.isArray(response.tasks)) {
    return {
      diagnostics: ["Turbo dry run is missing tasks"],
      taskIds: [],
    };
  }

  const taskIds: string[] = [];
  const diagnostics: string[] = [];
  for (const task of response.tasks) {
    if (!isRecord(task) || !isNonEmptyString(task.taskId)) {
      diagnostics.push("Turbo dry run contains an unrecognized task ID");
      continue;
    }
    taskIds.push(task.taskId);
  }

  return { diagnostics, taskIds };
}

function validateLayerClosure(
  layer: GateLayer,
  taskIds: readonly string[],
  tasksByName: ReadonlyMap<string, TurboTask>,
): readonly string[] {
  const diagnostics: string[] = [];
  for (const taskId of taskIds) {
    const dependency = tasksByName.get(taskId);
    if (dependency === undefined) {
      diagnostics.push(
        `${layer.label} graph contains an unknown task ${taskId}`,
      );
      continue;
    }
    if (publicGateTask(dependency)) {
      diagnostics.push(
        `${layer.label} graph includes ${dependency.fullName}: leaf tasks cannot depend on a public entry`,
      );
    } else if (
      dependency.role !== undefined &&
      dependency.role !== layer.role &&
      dependency.role !== "work:preparation" &&
      !(layer.role !== "quality:light" && dependency.role === "quality:light")
    ) {
      const scope =
        layer.role === "quality:light" && dependency.role === "quality:heavy"
          ? "light checks cannot depend on heavy checks"
          : dependency.role === "quality:conditional"
            ? "general checks cannot depend on conditional checks"
            : `disallowed dependency responsibility ${dependency.role}`;
      diagnostics.push(
        `${layer.label} graph includes ${dependency.fullName}: ${scope}`,
      );
    }
  }

  return diagnostics;
}

function layerFor(role: GateLayer["role"]): GateLayer {
  return {
    role,
    label:
      role === "quality:light"
        ? "Light checks"
        : role === "quality:heavy"
          ? "Heavy checks"
          : "Repairs",
  };
}

function layersFor(gate: TaskGate): readonly GateLayer[] {
  if (gate === "check") {
    return [layerFor("quality:light")];
  }
  if (gate === "check:heavy") {
    return [layerFor("quality:heavy")];
  }
  if (gate === "fix") {
    return [layerFor("work:repair")];
  }

  return [layerFor("quality:light"), layerFor("quality:heavy")];
}

export function inspectTaskGate(
  gate: TaskGate,
  cwd = process.cwd(),
  entryCommand = defaultEntryCommand,
  turboCommand?: TurboCommand,
): {
  readonly diagnostics: readonly string[];
  readonly plans: readonly {
    readonly layer: GateLayer;
    readonly tasks: readonly TurboTask[];
  }[];
  readonly conditionalTasks: readonly TurboTask[];
} {
  if (!publicGateNames.has(gate)) {
    return {
      diagnostics: [`Unknown public task: ${String(gate)}`],
      plans: [],
      conditionalTasks: [],
    };
  }

  const directory = readTaskDirectory(cwd, entryCommand, turboCommand);
  if (directory.diagnostics.length > 0) {
    return {
      diagnostics: directory.diagnostics,
      plans: [],
      conditionalTasks: [],
    };
  }
  const tasksByName = new Map(
    directory.tasks.map((task) => [task.fullName, task]),
  );
  const layers = layersFor(gate);
  const plans: {
    readonly layer: GateLayer;
    readonly tasks: readonly TurboTask[];
  }[] = [];
  const diagnostics: string[] = [];

  for (const task of directory.tasks) {
    if (task.executable || task.role === undefined) {
      continue;
    }
    const dryRun = parseDryRun(cwd, [task], turboCommand);
    diagnostics.push(...dryRun.diagnostics);
    if (
      dryRun.diagnostics.length === 0 &&
      !dryRun.taskIds.some(
        (taskId) => tasksByName.get(taskId)?.executable === true,
      )
    ) {
      diagnostics.push(
        `${task.fullName} declares ${task.role} without a reachable executable task`,
      );
    }
  }

  for (const layer of layers) {
    const selected = directory.tasks.filter(
      (task) => task.role === layer.role && !publicGateTask(task),
    );
    const dryRun = parseDryRun(cwd, selected, turboCommand);
    diagnostics.push(...dryRun.diagnostics);
    diagnostics.push(
      ...validateLayerClosure(layer, dryRun.taskIds, tasksByName),
    );
    if (
      layer.role === "quality:light" &&
      !dryRun.taskIds.some(
        (taskId) => tasksByName.get(taskId)?.executable === true,
      )
    ) {
      diagnostics.push(
        "No light checks selected. Declare quality:light on an executable check.",
      );
    }
    plans.push({ layer, tasks: selected });
  }

  const conditionalTasks = directory.tasks.filter(
    (task) => task.role === "quality:conditional",
  );
  return { diagnostics, plans, conditionalTasks };
}

export async function runTaskGate(
  gate: TaskGate,
  cwd = process.cwd(),
  entryCommand = defaultEntryCommand,
): Promise<number> {
  const { diagnostics, plans, conditionalTasks } = inspectTaskGate(
    gate,
    cwd,
    entryCommand,
  );
  if (diagnostics.length > 0) {
    report(diagnostics.join("\n"));
    return 1;
  }

  if (gate !== "fix" && conditionalTasks.length > 0) {
    report(
      `Conditional checks skipped: ${conditionalTasks.map((task) => task.fullName).join(", ")}`,
    );
  }

  for (const plan of plans) {
    if (plan.tasks.length === 0) {
      report(`${plan.layer.label}: no tasks selected`);
      continue;
    }
    const status = await runVisible(cwd, [
      "run",
      ...plan.tasks.map((task) => task.fullName),
      "--continue=dependencies-successful",
      gate === "fix" ? "--output-logs=full" : "--output-logs=errors-only",
      "--log-order=grouped",
      "--log-prefix=task",
    ]);
    if (status !== 0) {
      return status;
    }
  }

  return 0;
}

export async function runTaskGateCli(
  entryCommand = defaultEntryCommand,
): Promise<void> {
  const [gate, ...extraArguments] = process.argv.slice(2);
  if (
    gate === undefined ||
    !publicGateNames.has(gate as TaskGate) ||
    extraArguments.length > 0
  ) {
    report(`Usage: ${entryCommand} <check|check:heavy|check:full|fix>`);
    process.exitCode = 2;
    return;
  }

  try {
    process.exitCode = await runTaskGate(
      gate as TaskGate,
      process.cwd(),
      entryCommand,
    );
  } catch (error) {
    report(
      `Public task failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

const mainFile = process.argv[1];
if (
  mainFile !== undefined &&
  pathToFileURL(resolve(mainFile)).href === import.meta.url
) {
  void runTaskGateCli();
}
