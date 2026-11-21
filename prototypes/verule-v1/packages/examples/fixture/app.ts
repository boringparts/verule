import { preview, register, submit } from "./api.ts";
import { pass } from "./external.js";
import { command, forward } from "./helpers.ts";

register(command);
register("serve");
register("oops");
const id = preview();
const selected = Math.random() > 0.5 ? forward(pass(id)) : "live";
submit(selected);
let changed = id;
changed = "live";
submit(changed);
submit(id + "-copy");
