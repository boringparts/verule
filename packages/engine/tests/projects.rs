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

fn write_aggregate_and_divergent_runtime_fixture(root: &Path) {
    fs::create_dir_all(root.join("packages/shared")).expect("create shared dir");
    fs::create_dir_all(root.join("packages/web/src")).expect("create web dir");
    fs::create_dir_all(root.join("packages/node/src")).expect("create node dir");
    fs::create_dir_all(root.join("node_modules/ext-pkg")).expect("create node_modules dir");

    fs::write(
        root.join("node_modules/ext-pkg/index.d.ts"),
        "export declare const extFlag: boolean;\n",
    )
    .expect("write ext-pkg d.ts");

    fs::write(
        root.join("packages/shared/shared.ts"),
        [
            "import { mode } from \"@runtime\";",
            "import { extFlag } from \"ext-pkg\";",
            "",
            "function inspectRuntime(value: string): boolean {",
            "  return value.length > 0 && extFlag;",
            "}",
            "",
            "export const active = inspectRuntime(mode);",
            "",
        ]
        .join("\n"),
    )
    .expect("write shared.ts");

    fs::write(
        root.join("packages/web/src/web.ts"),
        "export const mode = \"web\" as const;\n",
    )
    .expect("write web.ts");

    fs::write(
        root.join("packages/node/src/node.ts"),
        "export const mode = \"node\" as const;\n",
    )
    .expect("write node.ts");

    fs::write(
        root.join("packages/web/tsconfig.json"),
        serde_json::to_string_pretty(&json!({
            "compilerOptions": {
                "composite": true,
                "strict": true,
                "target": "ES2022",
                "module": "NodeNext",
                "moduleResolution": "NodeNext",
                "baseUrl": ".",
                "paths": {
                    "@runtime": ["./src/web.ts"],
                    "ext-pkg": ["../../node_modules/ext-pkg/index.d.ts"]
                }
            },
            "include": ["src/**/*.ts", "../shared/shared.ts"]
        }))
        .expect("serialize web tsconfig"),
    )
    .expect("write web tsconfig");

    fs::write(
        root.join("packages/node/tsconfig.json"),
        serde_json::to_string_pretty(&json!({
            "compilerOptions": {
                "composite": true,
                "strict": false,
                "allowJs": true,
                "target": "ES2022",
                "module": "NodeNext",
                "moduleResolution": "NodeNext",
                "baseUrl": ".",
                "paths": {
                    "@runtime": ["./src/node.ts"],
                    "ext-pkg": ["../../node_modules/ext-pkg/index.d.ts"]
                }
            },
            "include": ["src/**/*.ts", "../shared/shared.ts"]
        }))
        .expect("serialize node tsconfig"),
    )
    .expect("write node tsconfig");

    fs::write(
        root.join("tsconfig.json"),
        serde_json::to_string_pretty(&json!({
            "files": [],
            "references": [
                { "path": "./packages/web" },
                { "path": "./packages/node" }
            ]
        }))
        .expect("serialize root tsconfig"),
    )
    .expect("write root tsconfig");
}

fn assert_runtime_literal_type(
    stdin: &mut ChildStdin,
    reader: &mut BufReader<ChildStdout>,
    snapshot_id: u64,
    proj: &Value,
    req_id: u64,
    expected_literal: &str,
) {
    let project_id = proj["projectId"].as_str().expect("projectId");
    let syntax_resp = rpc_call(
        stdin,
        reader,
        &json!({
            "id": req_id,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{
                    "op": "findSyntax",
                    "files": ["./packages/shared/shared.ts"],
                    "kinds": ["CallExpression"]
                }]
            }
        }),
    );
    assert_eq!(
        syntax_resp["ok"],
        json!(true),
        "findSyntax failed: {syntax_resp}"
    );
    let items = syntax_resp["result"]["results"][0]["items"]
        .as_array()
        .expect("items");
    assert_eq!(items.len(), 1, "expected 1 call in shared.ts");
    let arg_ref = items[0]["arguments"][0].as_str().expect("arg0 ref");

    let type_resp = rpc_call(
        stdin,
        reader,
        &json!({
            "id": req_id + 10,
            "method": "query.batch",
            "params": {
                "snapshotId": snapshot_id,
                "projectId": project_id,
                "steps": [{
                    "op": "typeAtLocation",
                    "targets": [arg_ref]
                }]
            }
        }),
    );
    assert_eq!(
        type_resp["ok"],
        json!(true),
        "typeAtLocation failed: {type_resp}"
    );
    let ty = &type_resp["result"]["results"][0]["items"][0];
    assert_eq!(ty["isLiteral"], json!(true));
    assert_eq!(ty["literalValue"], json!(expected_literal));
    assert_eq!(ty["typeText"], json!(format!("\"{expected_literal}\"")));
}

#[test]
fn discovers_references_recursively_tracks_provenance_and_isolates_types() {
    let temp = TempDirGuard::new("verule-engine-projects-agg");
    write_aggregate_and_divergent_runtime_fixture(temp.path());
    let cwd_str = normalized(temp.path());
    let (child, mut stdin, mut reader) = spawn_engine_stdio();

    let open_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 1,
            "method": "snapshot.open",
            "params": { "cwd": cwd_str, "entries": ["tsconfig.json"] }
        }),
    );
    assert_eq!(open_resp["ok"], json!(true), "open failed: {open_resp}");

    let snapshot_id = open_resp["result"]["snapshotId"]
        .as_u64()
        .expect("snapshotId");
    let projects = open_resp["result"]["projects"]
        .as_array()
        .expect("projects");
    assert_eq!(
        projects.len(),
        3,
        "expected root + 2 subprojects: {open_resp}"
    );

    let root_proj = projects
        .iter()
        .find(|p| p["configFile"] == json!("tsconfig.json"))
        .expect("root project");
    assert_eq!(root_proj["entryConfig"], json!("tsconfig.json"));
    assert_eq!(root_proj["entryChain"], json!(["tsconfig.json"]));
    assert_eq!(root_proj["sourceFiles"], json!([]));
    assert_eq!(
        root_proj["projectReferences"],
        json!(["packages/web/tsconfig.json", "packages/node/tsconfig.json"])
    );

    let web_proj = projects
        .iter()
        .find(|p| p["configFile"] == json!("packages/web/tsconfig.json"))
        .expect("web project");
    assert_eq!(web_proj["entryConfig"], json!("tsconfig.json"));
    assert_eq!(
        web_proj["entryChain"],
        json!(["tsconfig.json", "packages/web/tsconfig.json"])
    );
    assert_eq!(web_proj["referencedBy"], json!(["tsconfig.json"]));
    assert_eq!(web_proj["compilerOptions"]["strict"], json!(true));
    assert_eq!(
        web_proj["compilerOptions"]["paths"]["@runtime"],
        json!(["./src/web.ts"])
    );
    assert_eq!(
        web_proj["sourceFiles"],
        json!(["packages/shared/shared.ts", "packages/web/src/web.ts"])
    );

    let node_proj = projects
        .iter()
        .find(|p| p["configFile"] == json!("packages/node/tsconfig.json"))
        .expect("node project");
    assert_eq!(node_proj["entryConfig"], json!("tsconfig.json"));
    assert_eq!(
        node_proj["entryChain"],
        json!(["tsconfig.json", "packages/node/tsconfig.json"])
    );
    assert_eq!(node_proj["referencedBy"], json!(["tsconfig.json"]));
    assert_eq!(node_proj["compilerOptions"]["strict"], json!(false));
    assert_eq!(node_proj["compilerOptions"]["allowJs"], json!(true));
    assert_eq!(
        node_proj["compilerOptions"]["paths"]["@runtime"],
        json!(["./src/node.ts"])
    );
    assert_eq!(
        node_proj["sourceFiles"],
        json!(["packages/node/src/node.ts", "packages/shared/shared.ts"])
    );

    assert_runtime_literal_type(&mut stdin, &mut reader, snapshot_id, web_proj, 2, "web");
    assert_runtime_literal_type(&mut stdin, &mut reader, snapshot_id, node_proj, 3, "node");

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn handles_nested_and_cyclic_references_without_looping_and_opens_jsconfig() {
    let temp = TempDirGuard::new("verule-engine-projects-cycles");
    let root = temp.path();
    fs::create_dir_all(root.join("a")).expect("create a");
    fs::create_dir_all(root.join("b")).expect("create b");
    fs::create_dir_all(root.join("jsapp")).expect("create jsapp");

    fs::write(root.join("a/a.ts"), "export const aVal = 1;\n").expect("write a.ts");
    fs::write(root.join("b/b.ts"), "export const bVal = 2;\n").expect("write b.ts");
    fs::write(root.join("jsapp/index.js"), "export const jsVal = 'ok';\n").expect("write index.js");

    fs::write(
        root.join("a/tsconfig.json"),
        serde_json::to_string_pretty(&json!({
            "compilerOptions": { "composite": true, "strict": true },
            "include": ["./a.ts"],
            "references": [{ "path": "../b", "circular": true }]
        }))
        .expect("serialize a tsconfig"),
    )
    .expect("write a tsconfig");

    fs::write(
        root.join("b/tsconfig.json"),
        serde_json::to_string_pretty(&json!({
            "compilerOptions": { "composite": true, "strict": true },
            "include": ["./b.ts"],
            "references": [{ "path": "../a", "circular": true }]
        }))
        .expect("serialize b tsconfig"),
    )
    .expect("write b tsconfig");

    fs::write(
        root.join("jsapp/jsconfig.json"),
        serde_json::to_string_pretty(&json!({
            "compilerOptions": { "checkJs": false },
            "include": ["./index.js"]
        }))
        .expect("serialize jsconfig"),
    )
    .expect("write jsconfig");

    let cwd_str = normalized(root);
    let (child, mut stdin, mut reader) = spawn_engine_stdio();

    let open_resp = rpc_call(
        &mut stdin,
        &mut reader,
        &json!({
            "id": 1,
            "method": "snapshot.open",
            "params": {
                "cwd": cwd_str,
                "entries": ["a/tsconfig.json", "jsapp/jsconfig.json"]
            }
        }),
    );
    assert_eq!(open_resp["ok"], json!(true), "open failed: {open_resp}");

    let projects = open_resp["result"]["projects"]
        .as_array()
        .expect("projects");
    assert_eq!(projects.len(), 3, "expected a, jsapp, b: {open_resp}");

    let proj_b = projects
        .iter()
        .find(|p| p["configFile"] == json!("b/tsconfig.json"))
        .expect("b project");
    assert_eq!(proj_b["entryConfig"], json!("a/tsconfig.json"));
    assert_eq!(
        proj_b["entryChain"],
        json!(["a/tsconfig.json", "b/tsconfig.json"])
    );
    assert_eq!(proj_b["referencedBy"], json!(["a/tsconfig.json"]));
    assert_eq!(proj_b["projectReferences"], json!(["a/tsconfig.json"]));

    let proj_js = projects
        .iter()
        .find(|p| p["configFile"] == json!("jsapp/jsconfig.json"))
        .expect("jsapp project");
    assert_eq!(proj_js["entryConfig"], json!("jsapp/jsconfig.json"));
    assert_eq!(proj_js["entryChain"], json!(["jsapp/jsconfig.json"]));
    assert_eq!(proj_js["sourceFiles"], json!(["jsapp/index.js"]));
    assert_eq!(proj_js["compilerOptions"]["allowJs"], json!(true));

    drop(stdin);
    let output = child.wait_with_output().expect("wait for engine exit");
    assert!(
        output.status.success(),
        "stderr={}",
        String::from_utf8_lossy(&output.stderr)
    );
}
