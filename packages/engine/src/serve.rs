use std::{
    collections::BTreeMap,
    io::{self, Write},
    path::Path,
    sync::Arc,
};

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tsrs_api::{Handler, Response, Session, SessionOptions, session::SnapshotData};
use tsrs_ast::{Node, SourceFile, Symbol};
use tsrs_checker::{Signature, Type};
use tsrs_compiler::Program;
use tsrs_core::P;
use tsrs_diagnostics::Category;
use tsrs_project::ID as ProjectId;
use tsrs_vfs::{FS, bundled, osvfs};

use crate::projection::{QueryStep, execute_query_batch};

#[derive(Deserialize)]
struct RpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Serialize)]
struct RpcSuccessResponse<'a, T> {
    id: &'a Value,
    ok: bool,
    result: T,
}

#[derive(Serialize)]
struct RpcErrorPayload<'a> {
    code: &'a str,
    message: String,
}

#[derive(Serialize)]
struct RpcErrorResponse<'a> {
    id: &'a Value,
    ok: bool,
    error: RpcErrorPayload<'a>,
}

pub struct RpcErr {
    pub code: &'static str,
    pub message: String,
}

impl RpcErr {
    pub const fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

#[derive(Deserialize)]
struct SnapshotOpenParams {
    cwd: String,
    entries: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotReleaseParams {
    snapshot_id: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryBatchParams {
    snapshot_id: u64,
    project_id: String,
    steps: Vec<QueryStep>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotOpenResult {
    snapshot_id: u64,
    projects: Vec<ProjectSummary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSummary {
    project_id: String,
    config_file: String,
    source_files: Vec<String>,
}

#[derive(Serialize)]
struct SnapshotReleaseResult {
    released: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TsrsCreateSnapshotResponse {
    snapshot: u64,
    projects: Vec<TsrsProjectResponse>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TsrsProjectResponse {
    id: String,
    config_file_name: String,
}

#[derive(Clone, Copy)]
pub enum HandlePayload {
    Syntax(P<Node>),
    Declaration {
        node: P<Node>,
        symbol: Option<P<Symbol>>,
    },
    Call(P<Node>),
    Signature {
        sig: P<Signature>,
        call_node: Option<P<Node>>,
    },
    Type {
        ty: P<Type>,
        enclosing: Option<P<Node>>,
    },
}

pub struct HandleEntry {
    pub project_id: String,
    pub payload: HandlePayload,
}

pub struct SnapshotState {
    pub tsrs_snapshot_id: u64,
    pub cwd: String,
    pub snapshot_data: Arc<SnapshotData>,
    pub project_ids: BTreeMap<String, ProjectId>,
    pub handles: FxHashMap<String, HandleEntry>,
    pub next_handle_id: u64,
}

impl SnapshotState {
    fn alloc_handle(&mut self, prefix: &str, project_id: &str, payload: HandlePayload) -> String {
        self.next_handle_id += 1;
        let id = format!("{prefix}:{}", self.next_handle_id);
        self.handles.insert(
            id.clone(),
            HandleEntry {
                project_id: project_id.to_string(),
                payload,
            },
        );
        id
    }

    pub fn alloc_syntax(&mut self, project_id: &str, node: P<Node>) -> String {
        self.alloc_handle("syn", project_id, HandlePayload::Syntax(node))
    }

    pub fn alloc_declaration(
        &mut self,
        project_id: &str,
        node: P<Node>,
        symbol: Option<P<Symbol>>,
    ) -> String {
        self.alloc_handle(
            "dec",
            project_id,
            HandlePayload::Declaration { node, symbol },
        )
    }

    pub fn alloc_call(&mut self, project_id: &str, node: P<Node>) -> String {
        self.alloc_handle("cal", project_id, HandlePayload::Call(node))
    }

    pub fn alloc_signature(
        &mut self,
        project_id: &str,
        sig: P<Signature>,
        call_node: Option<P<Node>>,
    ) -> String {
        self.alloc_handle(
            "sig",
            project_id,
            HandlePayload::Signature { sig, call_node },
        )
    }

    pub fn alloc_type(
        &mut self,
        project_id: &str,
        ty: P<Type>,
        enclosing: Option<P<Node>>,
    ) -> String {
        self.alloc_handle("typ", project_id, HandlePayload::Type { ty, enclosing })
    }

    pub fn get_entry(&self, project_id: &str, handle_id: &str) -> Result<&HandleEntry, RpcErr> {
        let Some(entry) = self.handles.get(handle_id) else {
            return Err(RpcErr::new(
                "STALE_REFERENCE",
                format!("Program reference {handle_id} is expired or unknown."),
            ));
        };
        if entry.project_id != project_id {
            return Err(RpcErr::new(
                "CROSS_PROJECT_REFERENCE",
                format!(
                    "Program reference {handle_id} belongs to project {}, not {project_id}.",
                    entry.project_id
                ),
            ));
        }
        Ok(entry)
    }

    pub fn get_syntax_node(&self, project_id: &str, handle_id: &str) -> Result<P<Node>, RpcErr> {
        let entry = self.get_entry(project_id, handle_id)?;
        let HandlePayload::Syntax(node) = entry.payload else {
            return Err(RpcErr::new(
                "INVALID_REFERENCE_KIND",
                format!("Program reference {handle_id} is not a syntax reference."),
            ));
        };
        Ok(node)
    }

    pub fn get_call_node(&self, project_id: &str, handle_id: &str) -> Result<P<Node>, RpcErr> {
        let entry = self.get_entry(project_id, handle_id)?;
        let HandlePayload::Call(node) = entry.payload else {
            return Err(RpcErr::new(
                "INVALID_REFERENCE_KIND",
                format!("Program reference {handle_id} is not a call reference."),
            ));
        };
        Ok(node)
    }

    pub fn get_signature(
        &self,
        project_id: &str,
        handle_id: &str,
    ) -> Result<(P<Signature>, Option<P<Node>>), RpcErr> {
        let entry = self.get_entry(project_id, handle_id)?;
        let HandlePayload::Signature { sig, call_node } = entry.payload else {
            return Err(RpcErr::new(
                "INVALID_REFERENCE_KIND",
                format!("Program reference {handle_id} is not a signature reference."),
            ));
        };
        Ok((sig, call_node))
    }

    pub fn get_type_entry(
        &self,
        project_id: &str,
        handle_id: &str,
    ) -> Result<(P<Type>, Option<P<Node>>), RpcErr> {
        let entry = self.get_entry(project_id, handle_id)?;
        let HandlePayload::Type { ty, enclosing } = entry.payload else {
            return Err(RpcErr::new(
                "INVALID_REFERENCE_KIND",
                format!("Program reference {handle_id} is not a type reference."),
            ));
        };
        Ok((ty, enclosing))
    }
}

struct EngineServer {
    session: Option<(String, Arc<Session>)>,
    snapshots: BTreeMap<u64, SnapshotState>,
    next_snapshot_id: u64,
}

impl EngineServer {
    const fn new() -> Self {
        Self {
            session: None,
            snapshots: BTreeMap::new(),
            next_snapshot_id: 0,
        }
    }

    fn ensure_session(&mut self, cwd: &str) -> Arc<Session> {
        if let Some((existing_cwd, existing_session)) = &self.session
            && existing_cwd == cwd
        {
            return Arc::clone(existing_session);
        }
        if let Some((_, old_session)) = self.session.take() {
            self.snapshots.clear();
            old_session.close();
        }
        let fs: Arc<dyn FS> = Arc::new(bundled::wrap_fs(osvfs::fs()));
        let session = Session::new(SessionOptions::new(
            cwd.to_string(),
            bundled::default_lib_path(),
            fs,
            false,
        ));
        self.session = Some((cwd.to_string(), Arc::clone(&session)));
        session
    }

    fn handle_line(&mut self, line: &str) -> String {
        let request: RpcRequest = match serde_json::from_str(line) {
            Ok(req) => req,
            Err(err) => {
                return serialize_error(
                    &Value::Null,
                    "INVALID_REQUEST",
                    format!("Invalid JSON request: {err}"),
                );
            }
        };

        match self.dispatch(&request.method, request.params) {
            Ok(result) => serde_json::to_string(&RpcSuccessResponse {
                id: &request.id,
                ok: true,
                result,
            })
            .unwrap_or_else(|err| {
                serialize_error(&request.id, "SERIALIZATION_ERROR", err.to_string())
            }),
            Err(err) => serialize_error(&request.id, err.code, err.message),
        }
    }

    fn dispatch(&mut self, method: &str, params: Value) -> Result<Value, RpcErr> {
        match method {
            "snapshot.open" => {
                let parsed: SnapshotOpenParams = serde_json::from_value(params)
                    .map_err(|err| RpcErr::new("INVALID_PARAMS", err.to_string()))?;
                let result = self.open_snapshot(&parsed)?;
                serde_json::to_value(result)
                    .map_err(|err| RpcErr::new("SERIALIZATION_ERROR", err.to_string()))
            }
            "snapshot.release" => {
                let parsed: SnapshotReleaseParams = serde_json::from_value(params)
                    .map_err(|err| RpcErr::new("INVALID_PARAMS", err.to_string()))?;
                let result = self.release_snapshot(parsed.snapshot_id)?;
                serde_json::to_value(result)
                    .map_err(|err| RpcErr::new("SERIALIZATION_ERROR", err.to_string()))
            }
            "query.batch" => {
                let parsed: QueryBatchParams = serde_json::from_value(params)
                    .map_err(|err| RpcErr::new("INVALID_PARAMS", err.to_string()))?;
                let result = self.query_batch(parsed)?;
                serde_json::to_value(result)
                    .map_err(|err| RpcErr::new("SERIALIZATION_ERROR", err.to_string()))
            }
            _ => Err(RpcErr::new(
                "METHOD_NOT_FOUND",
                format!("Unknown method: {method}"),
            )),
        }
    }

    fn open_snapshot(&mut self, params: &SnapshotOpenParams) -> Result<SnapshotOpenResult, RpcErr> {
        if params.entries.is_empty() {
            return Err(RpcErr::new(
                "PROJECT_LOAD_ERROR",
                "At least one tsconfig entry is required.".to_string(),
            ));
        }

        let cwd = normalize_path(&params.cwd);
        let mut resolved_entries = Vec::with_capacity(params.entries.len());
        for entry in &params.entries {
            let resolved = resolve_against_cwd(&cwd, entry);
            if !Path::new(&resolved).is_file() {
                return Err(RpcErr::new(
                    "PROJECT_LOAD_ERROR",
                    format!("Project configuration file not found: {resolved}"),
                ));
            }
            resolved_entries.push(resolved);
        }

        let session = self.ensure_session(&cwd);
        let payload = serde_json::to_vec(&serde_json::json!({
            "openProjects": resolved_entries,
        }))
        .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;

        let response = session
            .handle_request("createSnapshot", &payload)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;
        let Response::Json(json_text) = response else {
            return Err(RpcErr::new(
                "PROJECT_LOAD_ERROR",
                "Unexpected binary response from tsrs session.".to_string(),
            ));
        };

        let created: TsrsCreateSnapshotResponse = serde_json::from_str(&json_text)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;
        let tsrs_snapshot_id = created.snapshot;

        let snapshot_data = session
            .snapshot_data(tsrs_snapshot_id)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;

        let mut project_ids = BTreeMap::new();
        let mut summaries = Vec::with_capacity(created.projects.len());

        for project in created.projects {
            let pid = ProjectId(project.id.clone());
            let program = match snapshot_data.get_program(&pid) {
                Ok(prog) => prog,
                Err(err) => {
                    release_tsrs_snapshot(&session, tsrs_snapshot_id);
                    return Err(RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()));
                }
            };

            if let Some(config_err) = first_config_error(program) {
                release_tsrs_snapshot(&session, tsrs_snapshot_id);
                return Err(RpcErr::new("PROJECT_LOAD_ERROR", config_err));
            }

            let mut source_files = Vec::new();
            for &sf in program.get_source_files() {
                if !is_project_source_file(program, sf) {
                    continue;
                }
                source_files.push(relative_to_cwd(&cwd, sf.file_name()));
            }
            source_files.sort();

            project_ids.insert(project.id.clone(), pid);
            summaries.push(ProjectSummary {
                project_id: project.id,
                config_file: relative_to_cwd(&cwd, &project.config_file_name),
                source_files,
            });
        }

        if summaries.is_empty() {
            release_tsrs_snapshot(&session, tsrs_snapshot_id);
            return Err(RpcErr::new(
                "PROJECT_LOAD_ERROR",
                "No compiler projects were opened.".to_string(),
            ));
        }

        self.next_snapshot_id += 1;
        let snapshot_id = self.next_snapshot_id;
        self.snapshots.insert(
            snapshot_id,
            SnapshotState {
                tsrs_snapshot_id,
                cwd,
                snapshot_data,
                project_ids,
                handles: FxHashMap::default(),
                next_handle_id: 0,
            },
        );

        Ok(SnapshotOpenResult {
            snapshot_id,
            projects: summaries,
        })
    }

    fn release_snapshot(&mut self, snapshot_id: u64) -> Result<SnapshotReleaseResult, RpcErr> {
        let Some(state) = self.snapshots.remove(&snapshot_id) else {
            return Err(RpcErr::new(
                "STALE_SNAPSHOT",
                format!("Snapshot {snapshot_id} is not active."),
            ));
        };
        let tsrs_snapshot_id = state.tsrs_snapshot_id;
        drop(state);
        if let Some((_, session)) = &self.session {
            release_tsrs_snapshot(session, tsrs_snapshot_id);
        }
        Ok(SnapshotReleaseResult { released: true })
    }

    fn query_batch(&mut self, params: QueryBatchParams) -> Result<Value, RpcErr> {
        let Some(snapshot) = self.snapshots.get_mut(&params.snapshot_id) else {
            return Err(RpcErr::new(
                "STALE_SNAPSHOT",
                format!("Snapshot {} is expired or unknown.", params.snapshot_id),
            ));
        };

        let Some(pid) = snapshot.project_ids.get(&params.project_id).cloned() else {
            return Err(RpcErr::new(
                "UNKNOWN_PROJECT",
                format!(
                    "Project {} is not part of snapshot {}.",
                    params.project_id, params.snapshot_id
                ),
            ));
        };

        let program = snapshot
            .snapshot_data
            .get_program(&pid)
            .map_err(|err| RpcErr::new("ENGINE_ERROR", err.to_string()))?;

        let result = execute_query_batch(snapshot, &params.project_id, program, params.steps)?;
        serde_json::to_value(result)
            .map_err(|err| RpcErr::new("SERIALIZATION_ERROR", err.to_string()))
    }

    fn shutdown(mut self) {
        let snapshots = std::mem::take(&mut self.snapshots);
        if let Some((_, session)) = self.session.take() {
            for state in snapshots.into_values() {
                let id = state.tsrs_snapshot_id;
                drop(state);
                release_tsrs_snapshot(&session, id);
            }
            session.close();
        }
    }
}

fn release_tsrs_snapshot(session: &Session, tsrs_snapshot_id: u64) {
    if let Ok(payload) = serde_json::to_vec(&serde_json::json!({ "snapshot": tsrs_snapshot_id })) {
        let _ = session.handle_request("release", &payload);
    }
}

fn first_config_error(program: &Program) -> Option<String> {
    for diag in program.get_config_file_parsing_diagnostics() {
        if diag.category() == Category::Error {
            return Some(format_diagnostic(&diag));
        }
    }
    None
}

fn format_diagnostic(diag: &tsrs_ast::Diagnostic) -> String {
    let text = diag.message_text();
    if !text.is_empty() {
        return text.to_string();
    }
    if let Some(msg) = diag.message() {
        let args: Vec<&dyn std::fmt::Display> = diag
            .message_args()
            .iter()
            .map(|s| s as &dyn std::fmt::Display)
            .collect();
        return msg.format(&args);
    }
    format!("TS{}", diag.code())
}

pub fn is_project_source_file(program: &Program, sf: P<SourceFile>) -> bool {
    let path = sf.path();
    !program.is_source_file_default_library(path)
        && !program.is_source_file_from_external_library(sf)
}

pub fn normalize_path(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    if replaced.len() > 1 {
        replaced.trim_end_matches('/').to_string()
    } else {
        replaced
    }
}

pub fn resolve_against_cwd(cwd: &str, candidate: &str) -> String {
    let normalized = normalize_path(candidate);
    if Path::new(&normalized).is_absolute() {
        normalized
    } else if cwd == "/" {
        format!("/{normalized}")
    } else {
        format!("{cwd}/{normalized}")
    }
}

pub fn relative_to_cwd(cwd: &str, file_path: &str) -> String {
    let file_norm = normalize_path(file_path);
    let prefix = if cwd == "/" {
        "/".to_string()
    } else {
        format!("{cwd}/")
    };
    if let Some(stripped) = file_norm.strip_prefix(&prefix) {
        return stripped.to_string();
    }
    if file_norm == cwd {
        return ".".to_string();
    }
    file_norm
}

fn serialize_error(id: &Value, code: &str, message: String) -> String {
    serde_json::to_string(&RpcErrorResponse {
        id,
        ok: false,
        error: RpcErrorPayload { code, message },
    })
    .unwrap_or_else(|_| {
        r#"{"id":null,"ok":false,"error":{"code":"SERIALIZATION_ERROR","message":"Failed to serialize error."}}"#.to_string()
    })
}

pub fn run_stdio() -> io::Result<()> {
    let mut server = EngineServer::new();
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut line = String::new();

    loop {
        line.clear();
        let bytes = stdin.read_line(&mut line)?;
        if bytes == 0 {
            break;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let response = server.handle_line(trimmed);
        let mut out = stdout.lock();
        writeln!(out, "{response}")?;
        out.flush()?;
    }

    server.shutdown();
    Ok(())
}
