use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

struct TempDirGuard(PathBuf);

impl TempDirGuard {
    fn new(prefix: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{}-{nanos}", std::process::id()));
        fs::create_dir_all(&path).expect("create temp dir");
        Self(path)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn normalized(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn spawn_engine_stdio() -> (Child, ChildStdin, BufReader<ChildStdout>) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_verule-engine"))
        .args(["serve", "--stdio"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn verule-engine serve --stdio");
    let stdin = child.stdin.take().expect("stdin piped");
    let stdout = child.stdout.take().expect("stdout piped");
    (child, stdin, BufReader::new(stdout))
}

fn rpc_call(stdin: &mut ChildStdin, reader: &mut BufReader<ChildStdout>, request: &Value) -> Value {
    let line = serde_json::to_string(request).expect("serialize request");
    writeln!(stdin, "{line}").expect("write rpc line");
    stdin.flush().expect("flush rpc line");
    let mut resp = String::new();
    let bytes = reader.read_line(&mut resp).expect("read rpc response");
    assert!(bytes > 0, "expected RPC response line, got EOF");
    serde_json::from_str(&resp).expect("valid JSON response")
}

fn write_sample_project(root: &Path) -> (String, String) {
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).expect("create src dir");

    let tsconfig_path = root.join("tsconfig.json");
    fs::write(
        &tsconfig_path,
        r#"{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*.ts"]
}
"#,
    )
    .expect("write tsconfig");

    let sample_source = [
        "function sink(value: string | number): string {",
        "  return String(value);",
        "}",
        "export function classify(input: string | number): string {",
        "  if (typeof input === \"string\") {",
        "    const _prefix = \"中文😀\"; return sink(input);",
        "  }",
        "  return sink(input);",
        "}",
        "",
    ]
    .join("\n");
    fs::write(src_dir.join("sample.ts"), &sample_source).expect("write sample.ts");
    (normalized(&tsconfig_path), sample_source)
}

fn open_snapshot(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<ChildStdout>,
    cwd: &str,
    entry: &str,
) -> (u64, String, Vec<Value>) {
    let resp = rpc_call(
        stdin,
        reader,
        &json!({
            "id": 1,
            "method": "snapshot.open",
            "params": { "cwd": cwd, "entries": [entry] }
        }),
    );
    assert_eq!(resp["ok"], json!(true), "open failed: {resp}");
    assert!(
        resp.get("metrics").is_none(),
        "metrics must be omitted when observeMode is off: {resp}"
    );
    let snapshot_id = resp["result"]["snapshotId"].as_u64().expect("snapshotId");
    let project_id = resp["result"]["projects"][0]["projectId"]
        .as_str()
        .expect("projectId")
        .to_string();
    let source_files = resp["result"]["projects"][0]["sourceFiles"]
        .as_array()
        .expect("sourceFiles")
        .clone();
    (snapshot_id, project_id, source_files)
}

#[test]
fn serves_narrowed_type_queries_and_utf16_locations() {
    let temp = TempDirGuard::new("verule-engine-serve-types");
    let (tsconfig_str, sample_source) = write_sample_project(temp.path());
    let cwd_str = normalized(temp.path());
    let (child, mut stdin, mut reader) = spawn_engine_stdio();

    let (snapshot_id, project_id, source_files) =
        open_snapshot(&mut stdin, &mut reader, &cwd_str, &tsconfig_str);
    assert!(
        source_files
            .iter()
            .any(|v| v.as_str() == Some("src/sample.ts"))
    );
    assert!(
        !source_files
            .iter()
            .any(|v| v.as_str().unwrap_or("").contains("lib.es5.d.ts"))
    );

    let syntax_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 2,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "findSyntax", "kinds": ["CallExpression"] }]
            }
        }),
    );
    assert_eq!(
        syntax_resp["ok"],
        json!(true),
        "findSyntax failed: {syntax_resp}"
    );
    let sink_calls: Vec<&Value> = syntax_resp["result"]["results"][0]["items"]
        .as_array()
        .expect("items")
        .iter()
        .filter(|item| item["text"].as_str().unwrap_or("").starts_with("sink("))
        .collect();
    assert_eq!(sink_calls.len(), 2);

    let first_loc = &sink_calls[0]["location"];
    assert_eq!(first_loc["file"], json!("src/sample.ts"));
    assert_eq!(first_loc["line"], json!(6));
    let line6 = "    const _prefix = \"中文😀\"; return sink(input);";
    let prefix = line6.split("sink(input)").next().expect("prefix");
    let expected_col = u32::try_from(prefix.encode_utf16().count()).expect("fits u32") + 1;
    assert_eq!(first_loc["column"], json!(expected_col));
    let start_byte = usize::try_from(first_loc["start"].as_u64().expect("start")).expect("usize");
    let end_byte = usize::try_from(first_loc["end"].as_u64().expect("end")).expect("usize");
    assert_eq!(&sample_source[start_byte..end_byte], "sink(input)");

    let arg_if = sink_calls[0]["arguments"][0].as_str().expect("arg0");
    let arg_else = sink_calls[1]["arguments"][0].as_str().expect("arg1");
    let type_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 3,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "typeAtLocation", "targets": [arg_if, arg_else] }]
            }
        }),
    );
    assert_eq!(
        type_resp["ok"],
        json!(true),
        "typeAtLocation failed: {type_resp}"
    );
    let types = type_resp["result"]["results"][0]["items"]
        .as_array()
        .expect("items");
    assert_eq!(types[0]["typeText"], json!("string"));
    assert_eq!(types[1]["typeText"], json!("number"));

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn rejects_stale_snapshots_and_invalid_project_configs() {
    let temp = TempDirGuard::new("verule-engine-serve-errors");
    let (tsconfig_str, _) = write_sample_project(temp.path());
    let cwd_str = normalized(temp.path());
    let (child, mut stdin, mut reader) = spawn_engine_stdio();

    let open_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 1,
            "method": "snapshot.open",
            "params": { "cwd": cwd_str, "entries": [tsconfig_str] }
        }),
    );
    assert_eq!(open_resp["ok"], json!(true));
    let snapshot_id = open_resp["result"]["snapshotId"]
        .as_u64()
        .expect("snapshotId");
    let project_id = open_resp["result"]["projects"][0]["projectId"]
        .as_str()
        .expect("projectId")
        .to_string();

    let release_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 2,
            "method": "snapshot.release",
            "params": { "snapshotId": snapshot_id }
        }),
    );
    assert_eq!(release_resp["ok"], json!(true));

    let stale_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 3,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "findSyntax", "kinds": ["CallExpression"] }]
            }
        }),
    );
    assert_eq!(stale_resp["ok"], json!(false));
    assert_eq!(stale_resp["error"]["code"], json!("STALE_SNAPSHOT"));

    let missing_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 4,
            "method": "snapshot.open",
            "params": { "cwd": cwd_str, "entries": ["nonexistent.tsconfig.json"] }
        }),
    );
    assert_eq!(missing_resp["ok"], json!(false));
    assert_eq!(missing_resp["error"]["code"], json!("PROJECT_LOAD_ERROR"));

    let bad_tsconfig = temp.path().join("bad.tsconfig.json");
    fs::write(&bad_tsconfig, "{ not valid json").expect("write bad tsconfig");
    let bad_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 5,
            "method": "snapshot.open",
            "params": { "cwd": cwd_str, "entries": [normalized(&bad_tsconfig)] }
        }),
    );
    assert_eq!(bad_resp["ok"], json!(false));
    assert_eq!(bad_resp["error"]["code"], json!("PROJECT_LOAD_ERROR"));

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}

fn write_projection_fixture(root: &Path) -> (String, String) {
    let src_dir = root.join("src");
    fs::create_dir_all(&src_dir).expect("create src dir");
    let tsconfig_path = root.join("tsconfig.json");
    fs::write(
        &tsconfig_path,
        r#"{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
  },
  "include": ["src/**/*.ts"]
}
"#,
    )
    .expect("write tsconfig");

    let source = [
        "export function id<T>(x: T): T { return x; }",
        "export function empty(): void {}",
        "declare const dyn: any;",
        "export function run(s: string, u: string | number) {",
        "  const a = id(s);",
        "  const b = empty();",
        "  const c = dyn(u);",
        "  return { a, b, c };",
        "}",
        "",
    ]
    .join("\n");
    fs::write(src_dir.join("mod.ts"), &source).expect("write mod.ts");
    (normalized(root), normalized(&tsconfig_path))
}

#[test]
fn projects_overloads_generics_assignability_and_three_state_fields() {
    let temp = TempDirGuard::new("verule-engine-serve-projection");
    let (cwd_str, tsconfig_str) = write_projection_fixture(temp.path());
    let (child, mut stdin, mut reader) = spawn_engine_stdio();
    let (snapshot_id, project_id, _) =
        open_snapshot(&mut stdin, &mut reader, &cwd_str, &tsconfig_str);

    // Range-scoped findSyntax on lines 5-7 of src/mod.ts
    let syntax_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 2,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{
                    "op": "findSyntax",
                    "kinds": ["CallExpression"],
                    "range": { "file": "src/mod.ts", "startLine": 5, "endLine": 7 }
                }]
            }
        }),
    );
    assert_eq!(syntax_resp["ok"], json!(true), "{syntax_resp}");
    let call_items = syntax_resp["result"]["results"][0]["items"]
        .as_array()
        .expect("items");
    assert_eq!(call_items.len(), 3);

    let resolve_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 3,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{
                    "op": "resolveCalls",
                    "targets": [
                        call_items[0]["ref"],
                        call_items[1]["ref"],
                        call_items[2]["ref"]
                    ],
                    "select": {
                        "signature": true,
                        "arguments": true,
                        "instantiatedParameterTypes": true,
                        "returnType": true
                    }
                }]
            }
        }),
    );
    assert_eq!(resolve_resp["ok"], json!(true), "{resolve_resp}");
    let rows = resolve_resp["result"]["results"][0]["items"]
        .as_array()
        .expect("resolved call rows");
    assert_eq!(rows.len(), 3);

    // Unrequested field `callee` must not be serialized; requested fields must exist.
    assert!(rows[0].get("callee").is_none());
    assert_eq!(
        rows[0]["instantiatedParameterTypes"][0]["type"]["typeText"],
        json!("string")
    );
    assert_eq!(rows[0]["returnType"]["typeText"], json!("string"));
    assert_eq!(rows[0]["gaps"], json!([]));

    // Empty 0-arg call: `arguments: []`, `instantiatedParameterTypes: []`, `gaps: []`.
    assert_eq!(rows[1]["arguments"], json!([]));
    assert_eq!(rows[1]["instantiatedParameterTypes"], json!([]));
    assert_eq!(rows[1]["returnType"]["typeText"], json!("void"));
    assert_eq!(rows[1]["gaps"], json!([]));

    // Indeterminate call on `any`: signature & returnType are explicit null, gaps non-empty.
    assert_eq!(rows[2]["signature"], json!(null));
    assert_eq!(rows[2]["returnType"], json!(null));
    assert_eq!(rows[2]["gaps"][0]["kind"], json!("unresolved-signature"));

    // Mismatched handle kind rejected with INVALID_REFERENCE_KIND.
    let bad_kind_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 4,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "projectCalls", "targets": [call_items[0]["ref"]], "select": { "location": true } }]
            }
        }),
    );
    assert_eq!(bad_kind_resp["ok"], json!(false));
    assert_eq!(
        bad_kind_resp["error"]["code"],
        json!("INVALID_REFERENCE_KIND")
    );

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn emits_observation_metrics_in_summary_and_omits_when_off() {
    let temp = TempDirGuard::new("verule-engine-serve-observe-summary");
    let (tsconfig_str, _) = write_sample_project(temp.path());
    let cwd_str = normalized(temp.path());
    let (child, mut stdin, mut reader) = spawn_engine_stdio();

    let open_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 1,
            "method": "snapshot.open",
            "params": { "cwd": cwd_str, "entries": [tsconfig_str] },
            "observe": { "mode": "summary" }
        }),
    );
    assert_eq!(open_resp["ok"], json!(true), "open failed: {open_resp}");
    assert!(open_resp["metrics"]["durationMs"].as_f64().is_some());
    assert!(open_resp["metrics"]["encodeMs"].as_f64().is_some());
    let snapshot_id = open_resp["result"]["snapshotId"]
        .as_u64()
        .expect("snapshotId");
    let project_id = open_resp["result"]["projects"][0]["projectId"]
        .as_str()
        .expect("projectId")
        .to_string();

    let summary_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 2,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "findSyntax", "kinds": ["CallExpression"] }]
            },
            "observe": { "mode": "summary" }
        }),
    );
    assert_eq!(summary_resp["ok"], json!(true));
    let summary_step = &summary_resp["metrics"]["steps"][0];
    assert_eq!(summary_step["op"], json!("findSyntax"));
    assert_eq!(summary_step["provider"], json!("engine"));
    assert_eq!(summary_step["cacheStatus"], json!("computed"));
    assert!(summary_step["candidateCount"].as_u64().unwrap_or(0) >= 2);
    assert!(summary_step.get("details").is_none());
    assert_eq!(summary_resp["metrics"]["truncated"], json!(false));
    assert_eq!(summary_resp["metrics"]["droppedCount"], json!(0));

    let off_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 3,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "findSyntax", "kinds": ["CallExpression"] }]
            },
            "observe": { "mode": "off" }
        }),
    );
    assert_eq!(off_resp["ok"], json!(true));
    assert!(off_resp.get("metrics").is_none());

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn truncates_observation_details_by_items_and_bytes() {
    let temp = TempDirGuard::new("verule-engine-serve-observe-limit");
    let (tsconfig_str, _) = write_sample_project(temp.path());
    let cwd_str = normalized(temp.path());
    let (child, mut stdin, mut reader) = spawn_engine_stdio();

    let (snapshot_id, project_id, _) =
        open_snapshot(&mut stdin, &mut reader, &cwd_str, &tsconfig_str);

    let item_limited_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 2,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "findSyntax", "kinds": ["CallExpression"] }]
            },
            "observe": { "mode": "detail", "maxItems": 1 }
        }),
    );
    assert_eq!(item_limited_resp["ok"], json!(true));
    assert_eq!(item_limited_resp["metrics"]["truncated"], json!(true));
    assert!(
        item_limited_resp["metrics"]["droppedCount"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );
    let details = item_limited_resp["metrics"]["steps"][0]["details"]
        .as_array()
        .expect("detail items array");
    assert_eq!(details.len(), 1);

    let byte_limited_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 3,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{ "op": "findSyntax", "kinds": ["CallExpression"] }]
            },
            "observe": { "mode": "detail", "maxBytes": 120 }
        }),
    );
    assert_eq!(byte_limited_resp["ok"], json!(true));
    assert_eq!(byte_limited_resp["metrics"]["truncated"], json!(true));
    assert!(
        byte_limited_resp["metrics"]["droppedCount"]
            .as_u64()
            .unwrap_or(0)
            >= 1
    );

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}
