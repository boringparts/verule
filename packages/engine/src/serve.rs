use std::{
    collections::{BTreeMap, BTreeSet},
    fmt::Write as _,
    io::{self, Write},
    path::Path,
    sync::Arc,
    time::Instant,
};

use rustc_hash::FxHashMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tsrs_api::{Handler, Response, Session, SessionOptions, session::SnapshotData};
use tsrs_ast::{Kind, Node, SourceFile};
use tsrs_checker::{LiteralValue, Type, TypeFlags, TypeFormatFlags};
use tsrs_compiler::Program;
use tsrs_core::{
    P,
    context::{CheckerLifetime, Context, with_checker_lifetime},
};
use tsrs_diagnostics::Category;
use tsrs_project::{ID as ProjectId, Kind as ProjectKind};
use tsrs_scanner::{get_ecma_line_and_utf16_character_of_position, get_token_pos_of_node};
use tsrs_vfs::{FS, bundled, osvfs};

use crate::observe::{
    EngineRpcMetrics, EngineStepDetail, ObserveCollector, ObserveRequestConfig, elapsed_ms,
};

#[derive(Deserialize)]
struct RpcRequest {
    id: Value,
    method: String,
    #[serde(default)]
    params: Value,
    #[serde(default)]
    observe: Option<ObserveRequestConfig>,
}

#[derive(Serialize)]
struct RpcSuccessResponse<'a, T> {
    id: &'a Value,
    ok: bool,
    result: T,
    #[serde(skip_serializing_if = "Option::is_none")]
    metrics: Option<EngineRpcMetrics>,
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

struct RpcErr {
    code: &'static str,
    message: String,
}

impl RpcErr {
    const fn new(code: &'static str, message: String) -> Self {
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
struct SnapshotUpdateParams {
    snapshot_id: u64,
    #[serde(default)]
    entries: Option<Vec<String>>,
    #[serde(default)]
    changed: Vec<String>,
    #[serde(default)]
    created: Vec<String>,
    #[serde(default)]
    deleted: Vec<String>,
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

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum QueryStep {
    FindSyntax {
        #[serde(default)]
        files: Option<Vec<String>>,
        kinds: Vec<String>,
    },
    TypeAtLocation {
        targets: Vec<String>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotOpenResult {
    snapshot_id: u64,
    snapshot_digest: String,
    projects: Vec<ProjectSummary>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_rss_bytes: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotUpdateResult {
    snapshot_id: u64,
    snapshot_digest: String,
    projects: Vec<ProjectSummary>,
    recomputed_projects: Vec<String>,
    reused_projects: Vec<String>,
    recomputed_files: Vec<String>,
    reused_files: Vec<String>,
    removed_files: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    engine_rss_bytes: Option<u64>,
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct QueryBatchResult {
    results: Vec<StepResult>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum StepResult {
    FindSyntax { items: Vec<SyntaxItem> },
    TypeAtLocation { items: Vec<TypeItem> },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SourceLocation {
    file: String,
    line: u32,
    column: u32,
    end_line: u32,
    end_column: u32,
    start: u32,
    end: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyntaxItem {
    #[serde(rename = "ref")]
    node_ref: String,
    kind: String,
    text: String,
    location: SourceLocation,
    #[serde(skip_serializing_if = "Option::is_none")]
    expression: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    arguments: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    initializer: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TypeItem {
    target: String,
    type_ref: String,
    type_text: String,
    is_union: bool,
    is_intersection: bool,
    is_literal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    literal_value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    union_members: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TsrsSnapshotResponse {
    snapshot: u64,
}

enum HandlePayload {
    Syntax(P<Node>),
    Type(#[expect(dead_code, reason = "Retained for upcoming TypeRef follow-up queries.")] P<Type>),
}

struct HandleEntry {
    project_id: String,
    payload: HandlePayload,
}

struct SnapshotState {
    tsrs_snapshot_id: u64,
    cwd: String,
    entries: Vec<String>,
    snapshot_data: Arc<SnapshotData>,
    project_ids: BTreeMap<String, ProjectId>,
    handles: FxHashMap<String, HandleEntry>,
    next_handle_id: u64,
}

impl SnapshotState {
    fn alloc_syntax(&mut self, project_id: &str, node: P<Node>) -> String {
        self.next_handle_id += 1;
        let id = format!("syn:{}", self.next_handle_id);
        self.handles.insert(
            id.clone(),
            HandleEntry {
                project_id: project_id.to_string(),
                payload: HandlePayload::Syntax(node),
            },
        );
        id
    }

    fn alloc_type(&mut self, project_id: &str, ty: P<Type>) -> String {
        self.next_handle_id += 1;
        let id = format!("typ:{}", self.next_handle_id);
        self.handles.insert(
            id.clone(),
            HandleEntry {
                project_id: project_id.to_string(),
                payload: HandlePayload::Type(ty),
            },
        );
        id
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

        let mut observer = ObserveCollector::from_request(request.observe);
        match self.dispatch(&request.method, request.params, &mut observer) {
            Ok(result) => {
                if observer.is_active() {
                    let encode_start = Instant::now();
                    let encoded = serde_json::to_string(&result);
                    observer.add_encode_ms(elapsed_ms(encode_start));
                    if let Err(err) = encoded {
                        return serialize_error(
                            &request.id,
                            "SERIALIZATION_ERROR",
                            err.to_string(),
                        );
                    }
                }
                let metrics = observer.finish();
                serde_json::to_string(&RpcSuccessResponse {
                    id: &request.id,
                    ok: true,
                    result,
                    metrics,
                })
                .unwrap_or_else(|err| {
                    serialize_error(&request.id, "SERIALIZATION_ERROR", err.to_string())
                })
            }
            Err(err) => serialize_error(&request.id, err.code, err.message),
        }
    }

    fn dispatch(
        &mut self,
        method: &str,
        params: Value,
        observer: &mut ObserveCollector,
    ) -> Result<Value, RpcErr> {
        match method {
            "snapshot.open" => {
                let parsed: SnapshotOpenParams = serde_json::from_value(params)
                    .map_err(|err| RpcErr::new("INVALID_PARAMS", err.to_string()))?;
                let result = self.open_snapshot(&parsed)?;
                serde_json::to_value(result)
                    .map_err(|err| RpcErr::new("SERIALIZATION_ERROR", err.to_string()))
            }
            "snapshot.update" => {
                let parsed: SnapshotUpdateParams = serde_json::from_value(params)
                    .map_err(|err| RpcErr::new("INVALID_PARAMS", err.to_string()))?;
                let result = self.update_snapshot(&parsed)?;
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
                let result = self.query_batch(parsed, observer)?;
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
        let cwd = normalize_path(&params.cwd);
        let resolved_entries = resolve_entry_paths(&cwd, &params.entries)?;

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

        let created: TsrsSnapshotResponse = serde_json::from_str(&json_text)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;
        let tsrs_snapshot_id = created.snapshot;

        let snapshot_data = session
            .snapshot_data(tsrs_snapshot_id)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;

        let (project_ids, summaries, snapshot_digest) =
            match collect_snapshot_projects(&cwd, &snapshot_data) {
                Ok(collected) => collected,
                Err(err) => {
                    drop(snapshot_data);
                    release_tsrs_snapshot(&session, tsrs_snapshot_id);
                    return Err(err);
                }
            };

        self.next_snapshot_id += 1;
        let snapshot_id = self.next_snapshot_id;
        self.snapshots.insert(
            snapshot_id,
            SnapshotState {
                tsrs_snapshot_id,
                cwd,
                entries: resolved_entries,
                snapshot_data,
                project_ids,
                handles: FxHashMap::default(),
                next_handle_id: 0,
            },
        );

        Ok(SnapshotOpenResult {
            snapshot_id,
            snapshot_digest,
            projects: summaries,
            engine_rss_bytes: read_process_rss_bytes(),
        })
    }

    fn update_snapshot(
        &mut self,
        params: &SnapshotUpdateParams,
    ) -> Result<SnapshotUpdateResult, RpcErr> {
        let (cwd, old_tsrs_snapshot_id, old_entries, old_snapshot_data, old_project_ids) = {
            let Some(old_state) = self.snapshots.get(&params.snapshot_id) else {
                return Err(RpcErr::new(
                    "STALE_SNAPSHOT",
                    format!("Snapshot {} is expired or unknown.", params.snapshot_id),
                ));
            };
            (
                old_state.cwd.clone(),
                old_state.tsrs_snapshot_id,
                old_state.entries.clone(),
                Arc::clone(&old_state.snapshot_data),
                old_state.project_ids.clone(),
            )
        };

        let next_entries = match &params.entries {
            Some(entries) => resolve_entry_paths(&cwd, entries)?,
            None => old_entries.clone(),
        };

        let Some(session) = self.session.as_ref().map(|(_, s)| Arc::clone(s)) else {
            return Err(RpcErr::new(
                "STALE_SNAPSHOT",
                "Analysis session is not initialized.".to_string(),
            ));
        };

        let payload = build_update_payload(
            &cwd,
            old_tsrs_snapshot_id,
            &old_entries,
            &next_entries,
            params,
        )?;
        let new_tsrs_snapshot_id = send_update_snapshot(&session, &payload)?;

        let new_snapshot_data = session
            .snapshot_data(new_tsrs_snapshot_id)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;

        let (project_ids, summaries, snapshot_digest) =
            match collect_snapshot_projects(&cwd, &new_snapshot_data) {
                Ok(collected) => collected,
                Err(err) => {
                    drop(new_snapshot_data);
                    release_tsrs_snapshot(&session, new_tsrs_snapshot_id);
                    return Err(err);
                }
            };

        let diff = compute_recomputation_scope(
            &cwd,
            &old_snapshot_data,
            &old_project_ids,
            &new_snapshot_data,
            &project_ids,
        );

        drop(old_snapshot_data);
        drop(self.snapshots.remove(&params.snapshot_id));
        release_tsrs_snapshot(&session, old_tsrs_snapshot_id);

        self.next_snapshot_id += 1;
        let snapshot_id = self.next_snapshot_id;
        self.snapshots.insert(
            snapshot_id,
            SnapshotState {
                tsrs_snapshot_id: new_tsrs_snapshot_id,
                cwd,
                entries: next_entries,
                snapshot_data: new_snapshot_data,
                project_ids,
                handles: FxHashMap::default(),
                next_handle_id: 0,
            },
        );

        Ok(SnapshotUpdateResult {
            snapshot_id,
            snapshot_digest,
            projects: summaries,
            recomputed_projects: diff.recomputed_projects,
            reused_projects: diff.reused_projects,
            recomputed_files: diff.recomputed_files,
            reused_files: diff.reused_files,
            removed_files: diff.removed_files,
            engine_rss_bytes: read_process_rss_bytes(),
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

    fn query_batch(
        &mut self,
        params: QueryBatchParams,
        observer: &mut ObserveCollector,
    ) -> Result<QueryBatchResult, RpcErr> {
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

        let mut results = Vec::with_capacity(params.steps.len());
        for step in params.steps {
            let step_start = observer.start_step();
            match step {
                QueryStep::FindSyntax { files, kinds } => {
                    let items = run_find_syntax(
                        snapshot,
                        &params.project_id,
                        program,
                        files.as_deref(),
                        &kinds,
                    )?;
                    let raw_details = if observer.is_detail() {
                        items
                            .iter()
                            .map(|item| EngineStepDetail {
                                kind: "candidate",
                                file: Some(item.location.file.clone()),
                                line: Some(item.location.line),
                                column: Some(item.location.column),
                                summary: format!("{} {}", item.kind, item.text),
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    observer.record_step("findSyntax", step_start, items.len(), raw_details);
                    results.push(StepResult::FindSyntax { items });
                }
                QueryStep::TypeAtLocation { targets } => {
                    let items =
                        run_type_at_location(snapshot, &params.project_id, program, &targets)?;
                    let raw_details = if observer.is_detail() {
                        items
                            .iter()
                            .map(|item| EngineStepDetail {
                                kind: "typeAtLocation",
                                file: None,
                                line: None,
                                column: None,
                                summary: format!("{} -> {}", item.target, item.type_text),
                            })
                            .collect()
                    } else {
                        Vec::new()
                    };
                    observer.record_step("typeAtLocation", step_start, items.len(), raw_details);
                    results.push(StepResult::TypeAtLocation { items });
                }
            }
        }

        Ok(QueryBatchResult { results })
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

fn build_update_payload(
    cwd: &str,
    old_tsrs_snapshot_id: u64,
    old_entries: &[String],
    next_entries: &[String],
    params: &SnapshotUpdateParams,
) -> Result<Vec<u8>, RpcErr> {
    let old_entry_set: BTreeSet<&str> = old_entries.iter().map(String::as_str).collect();
    let next_entry_set: BTreeSet<&str> = next_entries.iter().map(String::as_str).collect();
    let open_projects: Vec<&str> = next_entries
        .iter()
        .map(String::as_str)
        .filter(|entry| !old_entry_set.contains(entry))
        .collect();
    let close_projects: Vec<&str> = old_entries
        .iter()
        .map(String::as_str)
        .filter(|entry| !next_entry_set.contains(entry))
        .collect();
    let resolve_list = |paths: &[String]| -> Vec<String> {
        paths
            .iter()
            .map(|item| resolve_against_cwd(cwd, item))
            .collect()
    };

    serde_json::to_vec(&serde_json::json!({
        "snapshot": old_tsrs_snapshot_id,
        "changes": {
            "openProjects": open_projects,
            "closeProjects": close_projects,
            "ensurePrograms": true,
            "fileNotifications": {
                "changed": resolve_list(&params.changed),
                "created": resolve_list(&params.created),
                "deleted": resolve_list(&params.deleted),
            }
        }
    }))
    .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))
}

fn send_update_snapshot(session: &Session, payload: &[u8]) -> Result<u64, RpcErr> {
    let response = session
        .handle_request("updateSnapshot", payload)
        .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;
    let Response::Json(json_text) = response else {
        return Err(RpcErr::new(
            "PROJECT_LOAD_ERROR",
            "Unexpected binary response from tsrs session.".to_string(),
        ));
    };
    let updated: TsrsSnapshotResponse = serde_json::from_str(&json_text)
        .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;
    Ok(updated.snapshot)
}

fn release_tsrs_snapshot(session: &Session, tsrs_snapshot_id: u64) {
    if let Ok(payload) = serde_json::to_vec(&serde_json::json!({ "snapshot": tsrs_snapshot_id })) {
        let _ = session.handle_request("release", &payload);
    }
}

fn resolve_entry_paths(cwd: &str, entries: &[String]) -> Result<Vec<String>, RpcErr> {
    if entries.is_empty() {
        return Err(RpcErr::new(
            "PROJECT_LOAD_ERROR",
            "At least one tsconfig entry is required.".to_string(),
        ));
    }

    let mut resolved_entries = Vec::with_capacity(entries.len());
    for entry in entries {
        let resolved = resolve_against_cwd(cwd, entry);
        if !Path::new(&resolved).is_file() {
            return Err(RpcErr::new(
                "PROJECT_LOAD_ERROR",
                format!("Project configuration file not found: {resolved}"),
            ));
        }
        resolved_entries.push(resolved);
    }
    Ok(resolved_entries)
}

type CollectedProjects = (BTreeMap<String, ProjectId>, Vec<ProjectSummary>, String);

fn collect_snapshot_projects(
    cwd: &str,
    snapshot_data: &SnapshotData,
) -> Result<CollectedProjects, RpcErr> {
    let mut configured = Vec::new();
    for project in snapshot_data.snapshot.project_collection.projects() {
        if project.kind != ProjectKind::Configured || project.command_line.is_none() {
            continue;
        }
        configured.push(project);
    }
    configured.sort_by(|a, b| a.id().0.cmp(&b.id().0));

    let mut project_ids = BTreeMap::new();
    let mut summaries = Vec::with_capacity(configured.len());
    let mut hasher = Sha256::new();

    for project in configured {
        let id_str = project.id().0;
        let pid = ProjectId(id_str.clone());
        let program = snapshot_data
            .get_program(&pid)
            .map_err(|err| RpcErr::new("PROJECT_LOAD_ERROR", err.to_string()))?;

        if let Some(config_err) = first_config_error(program) {
            return Err(RpcErr::new("PROJECT_LOAD_ERROR", config_err));
        }

        let config_abs = project.config_file_name();
        let config_rel = relative_to_cwd(cwd, config_abs);
        let config_bytes = std::fs::read(config_abs).unwrap_or_default();

        let mut files_with_text: Vec<(String, &'static str)> = program
            .get_source_files()
            .iter()
            .copied()
            .filter(|&sf| is_project_source_file(program, sf))
            .map(|sf| (relative_to_cwd(cwd, sf.file_name()), sf.text()))
            .collect();
        files_with_text.sort_by(|a, b| a.0.cmp(&b.0));

        hasher.update_len_prefixed(id_str.as_bytes());
        hasher.update_len_prefixed(config_rel.as_bytes());
        hasher.update_len_prefixed(&config_bytes);
        for (rel_file, text) in &files_with_text {
            hasher.update_len_prefixed(rel_file.as_bytes());
            hasher.update_len_prefixed(text.as_bytes());
        }

        let source_files = files_with_text.into_iter().map(|(rel, _)| rel).collect();
        project_ids.insert(id_str.clone(), pid);
        summaries.push(ProjectSummary {
            project_id: id_str,
            config_file: config_rel,
            source_files,
        });
    }

    if summaries.is_empty() {
        return Err(RpcErr::new(
            "PROJECT_LOAD_ERROR",
            "No compiler projects were opened.".to_string(),
        ));
    }

    Ok((project_ids, summaries, hasher.finish_hex()))
}

struct RecomputationDiff {
    recomputed_projects: Vec<String>,
    reused_projects: Vec<String>,
    recomputed_files: Vec<String>,
    reused_files: Vec<String>,
    removed_files: Vec<String>,
}

fn compute_recomputation_scope(
    cwd: &str,
    old_snapshot: &SnapshotData,
    old_projects: &BTreeMap<String, ProjectId>,
    new_snapshot: &SnapshotData,
    new_projects: &BTreeMap<String, ProjectId>,
) -> RecomputationDiff {
    let mut old_all_files = BTreeSet::new();
    for pid in old_projects.values() {
        if let Ok(prog) = old_snapshot.get_program(pid) {
            for &sf in prog.get_source_files() {
                if is_project_source_file(prog, sf) {
                    old_all_files.insert(relative_to_cwd(cwd, sf.file_name()));
                }
            }
        }
    }

    let mut recomputed_projects = Vec::new();
    let mut reused_projects = Vec::new();
    let mut recomputed_files_set = BTreeSet::new();
    let mut reused_files_set = BTreeSet::new();
    let mut new_all_files = BTreeSet::new();

    for (id_str, pid) in new_projects {
        let Ok(new_prog) = new_snapshot.get_program(pid) else {
            continue;
        };
        let old_prog = old_projects
            .get(id_str)
            .and_then(|old_pid| old_snapshot.get_program(old_pid).ok());

        let project_reused = old_prog.is_some_and(|old| std::ptr::eq(old, new_prog));
        if project_reused {
            reused_projects.push(id_str.clone());
        } else {
            recomputed_projects.push(id_str.clone());
        }

        for &sf in new_prog.get_source_files() {
            if !is_project_source_file(new_prog, sf) {
                continue;
            }
            let rel = relative_to_cwd(cwd, sf.file_name());
            new_all_files.insert(rel.clone());

            let file_reused = old_prog
                .and_then(|old| old.get_source_file(sf.file_name()))
                .is_some_and(|old_sf| std::ptr::eq(&raw const *old_sf, &raw const *sf));

            if file_reused {
                reused_files_set.insert(rel);
            } else {
                recomputed_files_set.insert(rel);
            }
        }
    }

    let removed_files: Vec<String> = old_all_files.difference(&new_all_files).cloned().collect();
    let reused_files: Vec<String> = reused_files_set
        .difference(&recomputed_files_set)
        .cloned()
        .collect();
    let recomputed_files: Vec<String> = recomputed_files_set.into_iter().collect();

    RecomputationDiff {
        recomputed_projects,
        reused_projects,
        recomputed_files,
        reused_files,
        removed_files,
    }
}

fn read_process_rss_bytes() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb_str = rest.split_whitespace().next()?;
            let kb: u64 = kb_str.parse().ok()?;
            return kb.checked_mul(1024);
        }
    }
    None
}

const SHA256_K: [u32; 64] = [
    0x428a_2f98,
    0x7137_4491,
    0xb5c0_fbcf,
    0xe9b5_dba5,
    0x3956_c25b,
    0x59f1_11f1,
    0x923f_82a4,
    0xab1c_5ed5,
    0xd807_aa98,
    0x1283_5b01,
    0x2431_85be,
    0x550c_7dc3,
    0x72be_5d74,
    0x80de_b1fe,
    0x9bdc_06a7,
    0xc19b_f174,
    0xe49b_69c1,
    0xefbe_4786,
    0x0fc1_9dc6,
    0x240c_a1cc,
    0x2de9_2c6f,
    0x4a74_84aa,
    0x5cb0_a9dc,
    0x76f9_88da,
    0x983e_5152,
    0xa831_c66d,
    0xb003_27c8,
    0xbf59_7fc7,
    0xc6e0_0bf3,
    0xd5a7_9147,
    0x06ca_6351,
    0x1429_2967,
    0x27b7_0a85,
    0x2e1b_2138,
    0x4d2c_6dfc,
    0x5338_0d13,
    0x650a_7354,
    0x766a_0abb,
    0x81c2_c92e,
    0x9272_2c85,
    0xa2bf_e8a1,
    0xa81a_664b,
    0xc24b_8b70,
    0xc76c_51a3,
    0xd192_e819,
    0xd699_0624,
    0xf40e_3585,
    0x106a_a070,
    0x19a4_c116,
    0x1e37_6c08,
    0x2748_774c,
    0x34b0_bcb5,
    0x391c_0cb3,
    0x4ed8_aa4a,
    0x5b9c_ca4f,
    0x682e_6ff3,
    0x748f_82ee,
    0x78a5_636f,
    0x84c8_7814,
    0x8cc7_0208,
    0x90be_fffa,
    0xa450_6ceb,
    0xbef9_a3f7,
    0xc671_78f2,
];

struct Sha256 {
    state: [u32; 8],
    bit_len: u64,
    buffer: [u8; 64],
    buf_len: usize,
}

impl Sha256 {
    const fn new() -> Self {
        Self {
            state: [
                0x6a09_e667,
                0xbb67_ae85,
                0x3c6e_f372,
                0xa54f_f53a,
                0x510e_527f,
                0x9b05_688c,
                0x1f83_d9ab,
                0x5be0_cd19,
            ],
            bit_len: 0,
            buffer: [0; 64],
            buf_len: 0,
        }
    }

    fn update_len_prefixed(&mut self, data: &[u8]) {
        let len = u64::try_from(data.len()).unwrap_or(u64::MAX);
        self.update(&len.to_be_bytes());
        self.update(data);
    }

    fn update(&mut self, data: &[u8]) {
        let mut offset = 0;
        if self.buf_len > 0 {
            let take = (64 - self.buf_len).min(data.len());
            self.buffer[self.buf_len..self.buf_len + take].copy_from_slice(&data[..take]);
            self.buf_len += take;
            offset += take;
            if self.buf_len == 64 {
                let block = self.buffer;
                self.compress(&block);
                self.buf_len = 0;
            }
        }
        while offset + 64 <= data.len() {
            let mut block = [0u8; 64];
            block.copy_from_slice(&data[offset..offset + 64]);
            self.compress(&block);
            offset += 64;
        }
        if offset < data.len() {
            let rem = data.len() - offset;
            self.buffer[..rem].copy_from_slice(&data[offset..]);
            self.buf_len = rem;
        }
        let bits = u64::try_from(data.len()).unwrap_or(0).saturating_mul(8);
        self.bit_len = self.bit_len.wrapping_add(bits);
    }

    fn finish_hex(mut self) -> String {
        let bit_len = self.bit_len;
        self.update(&[0x80]);
        if self.buf_len > 56 {
            while self.buf_len < 64 {
                self.buffer[self.buf_len] = 0;
                self.buf_len += 1;
            }
            let block = self.buffer;
            self.compress(&block);
            self.buf_len = 0;
        }
        while self.buf_len < 56 {
            self.buffer[self.buf_len] = 0;
            self.buf_len += 1;
        }
        self.buffer[56..64].copy_from_slice(&bit_len.to_be_bytes());
        let block = self.buffer;
        self.compress(&block);

        let mut out = String::with_capacity(64);
        for word in self.state {
            let _ = write!(out, "{word:08x}");
        }
        out
    }

    fn compress(&mut self, block: &[u8; 64]) {
        let mut schedule = [0u32; 64];
        for (idx, word) in schedule.iter_mut().enumerate().take(16) {
            let off = idx * 4;
            *word =
                u32::from_be_bytes([block[off], block[off + 1], block[off + 2], block[off + 3]]);
        }
        for idx in 16..64 {
            let s0 = schedule[idx - 15].rotate_right(7)
                ^ schedule[idx - 15].rotate_right(18)
                ^ (schedule[idx - 15] >> 3);
            let s1 = schedule[idx - 2].rotate_right(17)
                ^ schedule[idx - 2].rotate_right(19)
                ^ (schedule[idx - 2] >> 10);
            schedule[idx] = schedule[idx - 16]
                .wrapping_add(s0)
                .wrapping_add(schedule[idx - 7])
                .wrapping_add(s1);
        }

        let [
            mut s0,
            mut s1,
            mut s2,
            mut s3,
            mut s4,
            mut s5,
            mut s6,
            mut s7,
        ] = self.state;
        for (idx, &k_val) in SHA256_K.iter().enumerate() {
            let sigma1 = s4.rotate_right(6) ^ s4.rotate_right(11) ^ s4.rotate_right(25);
            let choice = (s4 & s5) ^ ((!s4) & s6);
            let temp1 = s7
                .wrapping_add(sigma1)
                .wrapping_add(choice)
                .wrapping_add(k_val)
                .wrapping_add(schedule[idx]);
            let sigma0 = s0.rotate_right(2) ^ s0.rotate_right(13) ^ s0.rotate_right(22);
            let majority = (s0 & s1) ^ (s0 & s2) ^ (s1 & s2);
            let temp2 = sigma0.wrapping_add(majority);

            s7 = s6;
            s6 = s5;
            s5 = s4;
            s4 = s3.wrapping_add(temp1);
            s3 = s2;
            s2 = s1;
            s1 = s0;
            s0 = temp1.wrapping_add(temp2);
        }

        for (slot, delta) in self.state.iter_mut().zip([s0, s1, s2, s3, s4, s5, s6, s7]) {
            *slot = slot.wrapping_add(delta);
        }
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

fn is_project_source_file(program: &Program, sf: P<SourceFile>) -> bool {
    let path = sf.path();
    !program.is_source_file_default_library(path)
        && !program.is_source_file_from_external_library(sf)
}

fn run_find_syntax(
    snapshot: &mut SnapshotState,
    project_id: &str,
    program: &'static Program,
    files: Option<&[String]>,
    kinds: &[String],
) -> Result<Vec<SyntaxItem>, RpcErr> {
    if kinds.is_empty() {
        return Err(RpcErr::new(
            "INVALID_PARAMS",
            "findSyntax requires at least one syntax kind.".to_string(),
        ));
    }

    let mut target_kinds = Vec::with_capacity(kinds.len());
    for kind_name in kinds {
        let Some(kind) = parse_syntax_kind(kind_name) else {
            return Err(RpcErr::new(
                "INVALID_PARAMS",
                format!("Unsupported syntax kind: {kind_name}"),
            ));
        };
        target_kinds.push((kind, kind_name.as_str()));
    }

    let file_filter: Option<Vec<String>> = files.map(|list| {
        list.iter()
            .map(|f| relative_to_cwd(&snapshot.cwd, &resolve_against_cwd(&snapshot.cwd, f)))
            .collect()
    });

    let mut source_files: Vec<(String, P<SourceFile>)> = program
        .get_source_files()
        .iter()
        .copied()
        .filter(|&sf| is_project_source_file(program, sf))
        .filter_map(|sf| {
            let rel = relative_to_cwd(&snapshot.cwd, sf.file_name());
            if let Some(filter) = &file_filter
                && !filter.iter().any(|item| item == &rel)
            {
                return None;
            }
            Some((rel, sf))
        })
        .collect();
    source_files.sort_by(|a, b| a.0.cmp(&b.0));

    let mut items = Vec::new();
    for (rel_file, sf) in source_files {
        collect_matching_nodes(
            snapshot,
            project_id,
            sf,
            &rel_file,
            sf.as_node(),
            &target_kinds,
            &mut items,
        );
    }
    Ok(items)
}

fn collect_matching_nodes(
    snapshot: &mut SnapshotState,
    project_id: &str,
    sf: P<SourceFile>,
    rel_file: &str,
    node: P<Node>,
    target_kinds: &[(Kind, &str)],
    out: &mut Vec<SyntaxItem>,
) {
    if let Some((_, kind_label)) = target_kinds.iter().find(|(k, _)| *k == node.kind()) {
        let location = node_location(sf, rel_file, node);
        let text = slice_source_text(sf, location.start, location.end);
        let node_ref = snapshot.alloc_syntax(project_id, node);

        let expression = if matches!(
            node.kind(),
            Kind::CallExpression | Kind::NewExpression | Kind::PropertyAccessExpression
        ) {
            node.expression()
                .map(|expr| snapshot.alloc_syntax(project_id, expr))
        } else {
            None
        };

        let arguments = if node.kind() == Kind::CallExpression {
            Some(
                node.arguments()
                    .iter()
                    .map(|&arg| snapshot.alloc_syntax(project_id, arg))
                    .collect(),
            )
        } else {
            None
        };

        let name = if node.kind() == Kind::VariableDeclaration {
            node.name()
                .map(|name_node| snapshot.alloc_syntax(project_id, name_node))
        } else {
            None
        };

        let initializer = if node.kind() == Kind::VariableDeclaration {
            node.initializer()
                .map(|init_node| snapshot.alloc_syntax(project_id, init_node))
        } else {
            None
        };

        out.push(SyntaxItem {
            node_ref,
            kind: (*kind_label).to_string(),
            text,
            location,
            expression,
            arguments,
            name,
            initializer,
        });
    }

    node.for_each_child(&mut |child| {
        collect_matching_nodes(snapshot, project_id, sf, rel_file, child, target_kinds, out);
        false
    });
}

struct ComputedType {
    target_id: String,
    ty: P<Type>,
    type_text: String,
    is_union: bool,
    is_intersection: bool,
    is_literal: bool,
    literal_value: Option<Value>,
    union_members: Option<Vec<String>>,
}

fn extract_type_info(
    checker: &mut tsrs_compiler::CheckerHandle,
    target_id: String,
    node: P<Node>,
) -> ComputedType {
    let ty = checker.get_type_at_location(node);
    let enclosing = node.parent().or(Some(node));
    let type_text = checker.type_to_string_ex_exported(ty, enclosing, TypeFormatFlags::None, None);

    let is_union = ty.is_union();
    let is_intersection = ty.is_intersection();
    let is_boolean_literal = ty.flags().contains(TypeFlags::BooleanLiteral);
    let is_literal = ty.is_string_literal() || ty.is_number_literal() || is_boolean_literal;

    let literal_value = if ty.is_string_literal() || ty.is_number_literal() {
        ty.as_literal_type().value().and_then(|val| match val {
            LiteralValue::String(s) => Some(Value::String(s.to_string())),
            LiteralValue::Number(num) => serde_json::Number::from_f64(num.0).map(Value::Number),
            LiteralValue::Boolean(b) => Some(Value::Bool(b)),
            LiteralValue::BigInt(_) => None,
        })
    } else if is_boolean_literal {
        match type_text.as_str() {
            "true" => Some(Value::Bool(true)),
            "false" => Some(Value::Bool(false)),
            _ => None,
        }
    } else {
        None
    };

    let union_members = if is_union {
        Some(
            ty.types()
                .iter()
                .map(|&member| {
                    checker.type_to_string_ex_exported(
                        member,
                        enclosing,
                        TypeFormatFlags::None,
                        None,
                    )
                })
                .collect(),
        )
    } else {
        None
    };

    ComputedType {
        target_id,
        ty,
        type_text,
        is_union,
        is_intersection,
        is_literal,
        literal_value,
        union_members,
    }
}

fn run_type_at_location(
    snapshot: &mut SnapshotState,
    project_id: &str,
    program: &'static Program,
    targets: &[String],
) -> Result<Vec<TypeItem>, RpcErr> {
    let mut nodes = Vec::with_capacity(targets.len());
    for handle_id in targets {
        let Some(entry) = snapshot.handles.get(handle_id) else {
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
        let HandlePayload::Syntax(node) = entry.payload else {
            return Err(RpcErr::new(
                "INVALID_REFERENCE_KIND",
                format!("Program reference {handle_id} is not a syntax reference."),
            ));
        };
        nodes.push((handle_id.clone(), node));
    }

    let computed: Vec<ComputedType> = {
        let ctx = with_checker_lifetime(&Context::background(), CheckerLifetime::API);
        let mut checker = program.get_type_checker(&ctx);
        nodes
            .into_iter()
            .map(|(target_id, node)| extract_type_info(&mut checker, target_id, node))
            .collect()
    };

    let mut items = Vec::with_capacity(computed.len());
    for entry in computed {
        let type_ref = snapshot.alloc_type(project_id, entry.ty);
        items.push(TypeItem {
            target: entry.target_id,
            type_ref,
            type_text: entry.type_text,
            is_union: entry.is_union,
            is_intersection: entry.is_intersection,
            is_literal: entry.is_literal,
            literal_value: entry.literal_value,
            union_members: entry.union_members,
        });
    }

    Ok(items)
}

fn node_location(sf: P<SourceFile>, rel_file: &str, node: P<Node>) -> SourceLocation {
    let start = get_token_pos_of_node(node, sf, false);
    let end = node.end().source_offset().unwrap_or(start).max(start);

    let (start_line0, start_col0) = get_ecma_line_and_utf16_character_of_position(sf.get(), start);
    let (end_line0, end_col0) = get_ecma_line_and_utf16_character_of_position(sf.get(), end);

    SourceLocation {
        file: rel_file.to_string(),
        line: u32::try_from(start_line0).unwrap_or(u32::MAX - 1) + 1,
        column: start_col0 + 1,
        end_line: u32::try_from(end_line0).unwrap_or(u32::MAX - 1) + 1,
        end_column: end_col0 + 1,
        start,
        end,
    }
}

fn slice_source_text(sf: P<SourceFile>, start: u32, end: u32) -> String {
    let text = sf.text();
    let start_idx = usize::try_from(start).unwrap_or(0);
    let end_idx = usize::try_from(end).unwrap_or(start_idx);
    if start_idx <= end_idx && end_idx <= text.len() {
        text.get(start_idx..end_idx).unwrap_or("").to_string()
    } else {
        String::new()
    }
}

fn parse_syntax_kind(name: &str) -> Option<Kind> {
    match name {
        "Identifier" => Some(Kind::Identifier),
        "CallExpression" => Some(Kind::CallExpression),
        "ReturnStatement" => Some(Kind::ReturnStatement),
        "VariableDeclaration" => Some(Kind::VariableDeclaration),
        "BinaryExpression" => Some(Kind::BinaryExpression),
        "PropertyAccessExpression" => Some(Kind::PropertyAccessExpression),
        "IfStatement" => Some(Kind::IfStatement),
        "FunctionDeclaration" => Some(Kind::FunctionDeclaration),
        "ArrowFunction" => Some(Kind::ArrowFunction),
        "FunctionExpression" => Some(Kind::FunctionExpression),
        "MethodDeclaration" => Some(Kind::MethodDeclaration),
        "StringLiteral" => Some(Kind::StringLiteral),
        "NumericLiteral" => Some(Kind::NumericLiteral),
        "Parameter" => Some(Kind::Parameter),
        "NewExpression" => Some(Kind::NewExpression),
        _ => None,
    }
}

fn normalize_path(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    if replaced.len() > 1 {
        replaced.trim_end_matches('/').to_string()
    } else {
        replaced
    }
}

fn resolve_against_cwd(cwd: &str, candidate: &str) -> String {
    let normalized = normalize_path(candidate);
    if Path::new(&normalized).is_absolute() {
        normalized
    } else if cwd == "/" {
        format!("/{normalized}")
    } else {
        format!("{cwd}/{normalized}")
    }
}

fn relative_to_cwd(cwd: &str, file_path: &str) -> String {
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
