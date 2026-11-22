use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    path::Path,
    sync::Arc,
};

use serde::{Deserialize, Serialize};
use tsrs_api::{Handler, Response, Session, session::SnapshotData};
use tsrs_ast::{Diagnostic as TsrsDiagnostic, SourceFile};
use tsrs_compiler::Program;
use tsrs_core::{
    CompilerOptions, JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget,
    resolve_project_reference_path,
};
use tsrs_diagnostics::Category;
use tsrs_project::ID as ProjectId;

#[derive(Debug)]
pub struct ProjectOpenError {
    pub code: &'static str,
    pub message: String,
}

impl ProjectOpenError {
    const fn new(code: &'static str, message: String) -> Self {
        Self { code, message }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
#[expect(
    clippy::struct_excessive_bools,
    reason = "Mirrors four independent TypeScript compiler boolean flags in JSON output."
)]
pub struct CompilerOptionsSummary {
    pub strict: bool,
    pub allow_js: bool,
    pub check_js: bool,
    pub composite: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub module_resolution: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jsx: Option<String>,
    pub paths: BTreeMap<String, Vec<String>>,
    pub custom_conditions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub project_id: String,
    pub config_file: String,
    pub entry_config: String,
    pub entry_chain: Vec<String>,
    pub referenced_by: Vec<String>,
    pub project_references: Vec<String>,
    pub compiler_options: CompilerOptionsSummary,
    pub source_files: Vec<String>,
}

pub struct OpenedProjectsSnapshot {
    pub tsrs_snapshot_id: u64,
    pub snapshot_data: Arc<SnapshotData>,
    pub project_ids: BTreeMap<String, ProjectId>,
    pub summaries: Vec<ProjectSummary>,
}

#[derive(Deserialize)]
struct TsrsSnapshotResponse {
    snapshot: u64,
}

struct ProjectProvenance {
    entry_config: String,
    entry_chain: Vec<String>,
    referenced_by: BTreeSet<String>,
}

struct DiscoveryState {
    visited_configs: BTreeSet<String>,
    discovery_order: Vec<String>,
    provenance: BTreeMap<String, ProjectProvenance>,
    project_refs_map: BTreeMap<String, Vec<String>>,
}

pub fn normalize_path(path: &str) -> String {
    let replaced = path.replace('\\', "/");
    let is_abs = replaced.starts_with('/');
    let mut parts: Vec<&str> = Vec::new();
    for segment in replaced.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if let Some(&last) = parts.last()
                    && last != ".."
                {
                    parts.pop();
                } else if !is_abs {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    if is_abs {
        if parts.is_empty() {
            "/".to_string()
        } else {
            format!("/{}", parts.join("/"))
        }
    } else if parts.is_empty() {
        ".".to_string()
    } else {
        parts.join("/")
    }
}

pub fn resolve_against_cwd(cwd: &str, candidate: &str) -> String {
    let normalized = candidate.replace('\\', "/");
    if Path::new(&normalized).is_absolute() {
        normalize_path(&normalized)
    } else if cwd == "/" {
        normalize_path(&format!("/{normalized}"))
    } else {
        normalize_path(&format!("{cwd}/{normalized}"))
    }
}

pub fn relative_to_cwd(cwd: &str, file_path: &str) -> String {
    let file_norm = normalize_path(file_path);
    let cwd_norm = normalize_path(cwd);
    let prefix = if cwd_norm == "/" {
        "/".to_string()
    } else {
        format!("{cwd_norm}/")
    };
    if let Some(stripped) = file_norm.strip_prefix(&prefix) {
        return stripped.to_string();
    }
    if file_norm == cwd_norm {
        return ".".to_string();
    }
    file_norm
}

pub fn is_project_source_file(program: &Program, sf: tsrs_core::P<SourceFile>) -> bool {
    let path = sf.path();
    !program.is_source_file_default_library(path)
        && !program.is_source_file_from_external_library(sf)
        && !program.is_source_from_project_reference(path)
}

pub fn release_tsrs_snapshot(session: &Session, tsrs_snapshot_id: u64) {
    if let Ok(payload) = serde_json::to_vec(&serde_json::json!({ "snapshot": tsrs_snapshot_id })) {
        let _ = session.handle_request("release", &payload);
    }
}

/// Opens all entry `tsconfig.json`/`jsconfig.json` files and recursively discovers `references`
/// via BFS, preventing cycles and releasing intermediate transition snapshots.
pub fn open_projects_snapshot(
    session: &Arc<Session>,
    cwd: &str,
    entries: &[String],
) -> Result<OpenedProjectsSnapshot, ProjectOpenError> {
    let (initial_entries, mut state) = collect_initial_entries(cwd, entries)?;
    let mut tsrs_snapshot_id = create_initial_snapshot(session, &initial_entries)?;
    let mut pending_inspection: VecDeque<String> = initial_entries.into_iter().collect();

    loop {
        let snapshot_data = match session.snapshot_data(tsrs_snapshot_id) {
            Ok(data) => data,
            Err(err) => {
                release_tsrs_snapshot(session, tsrs_snapshot_id);
                return Err(ProjectOpenError::new("PROJECT_LOAD_ERROR", err.to_string()));
            }
        };

        let newly_discovered = match inspect_pending_projects(
            cwd,
            &snapshot_data,
            &mut pending_inspection,
            &mut state,
        ) {
            Ok(next) => next,
            Err(err) => {
                drop(snapshot_data);
                release_tsrs_snapshot(session, tsrs_snapshot_id);
                return Err(err);
            }
        };

        if newly_discovered.is_empty() {
            let result = build_opened_snapshot(tsrs_snapshot_id, cwd, snapshot_data, &state);
            if result.is_err() {
                release_tsrs_snapshot(session, tsrs_snapshot_id);
            }
            return result;
        }

        drop(snapshot_data);
        let prev_snapshot_id = tsrs_snapshot_id;
        let next_snapshot_id =
            match update_snapshot_open_projects(session, prev_snapshot_id, &newly_discovered) {
                Ok(id) => id,
                Err(err) => {
                    release_tsrs_snapshot(session, prev_snapshot_id);
                    return Err(err);
                }
            };
        release_tsrs_snapshot(session, prev_snapshot_id);
        tsrs_snapshot_id = next_snapshot_id;
        pending_inspection.extend(newly_discovered);
    }
}

fn collect_initial_entries(
    cwd: &str,
    entries: &[String],
) -> Result<(Vec<String>, DiscoveryState), ProjectOpenError> {
    if entries.is_empty() {
        return Err(ProjectOpenError::new(
            "PROJECT_LOAD_ERROR",
            "At least one tsconfig or jsconfig entry is required.".to_string(),
        ));
    }

    let mut initial_entries = Vec::new();
    let mut visited_configs = BTreeSet::new();
    let mut discovery_order = Vec::new();
    let mut provenance = BTreeMap::new();

    for entry in entries {
        let resolved = resolve_against_cwd(cwd, entry);
        if !Path::new(&resolved).is_file() {
            return Err(ProjectOpenError::new(
                "PROJECT_LOAD_ERROR",
                format!("Project configuration file not found: {resolved}"),
            ));
        }
        if visited_configs.insert(resolved.clone()) {
            let rel = relative_to_cwd(cwd, &resolved);
            provenance.insert(
                resolved.clone(),
                ProjectProvenance {
                    entry_config: rel.clone(),
                    entry_chain: vec![rel],
                    referenced_by: BTreeSet::new(),
                },
            );
            discovery_order.push(resolved.clone());
            initial_entries.push(resolved);
        }
    }

    Ok((
        initial_entries,
        DiscoveryState {
            visited_configs,
            discovery_order,
            provenance,
            project_refs_map: BTreeMap::new(),
        },
    ))
}

fn inspect_pending_projects(
    cwd: &str,
    snapshot_data: &SnapshotData,
    pending: &mut VecDeque<String>,
    state: &mut DiscoveryState,
) -> Result<Vec<String>, ProjectOpenError> {
    let programs_by_config = collect_snapshot_programs(snapshot_data);
    let mut newly_discovered = Vec::new();

    while let Some(config_path) = pending.pop_front() {
        let Some((_, program)) = programs_by_config.get(&config_path) else {
            return Err(ProjectOpenError::new(
                "PROJECT_LOAD_ERROR",
                format!("Opened project missing program for {config_path}"),
            ));
        };

        if let Some(config_err) = first_config_error(program) {
            return Err(ProjectOpenError::new("PROJECT_LOAD_ERROR", config_err));
        }

        let parent_rel = relative_to_cwd(cwd, &config_path);
        let parent_prov = state
            .provenance
            .get(&config_path)
            .map(|p| (p.entry_config.clone(), p.entry_chain.clone()));

        let mut refs_for_project = Vec::new();
        for reference in program.command_line().project_references() {
            let raw_child = resolve_project_reference_path(reference);
            let child_abs = resolve_against_cwd(cwd, &raw_child);
            let child_rel = relative_to_cwd(cwd, &child_abs);
            if !refs_for_project.contains(&child_rel) {
                refs_for_project.push(child_rel.clone());
            }

            if state.visited_configs.insert(child_abs.clone()) {
                if !Path::new(&child_abs).is_file() {
                    return Err(ProjectOpenError::new(
                        "PROJECT_LOAD_ERROR",
                        format!(
                            "Referenced project configuration file not found: {child_abs} (referenced from {parent_rel})"
                        ),
                    ));
                }

                let (entry_config, mut entry_chain) = parent_prov
                    .clone()
                    .unwrap_or_else(|| (parent_rel.clone(), vec![parent_rel.clone()]));
                entry_chain.push(child_rel);

                let mut referenced_by = BTreeSet::new();
                referenced_by.insert(parent_rel.clone());

                state.provenance.insert(
                    child_abs.clone(),
                    ProjectProvenance {
                        entry_config,
                        entry_chain,
                        referenced_by,
                    },
                );
                state.discovery_order.push(child_abs.clone());
                newly_discovered.push(child_abs);
            } else if let Some(existing_prov) = state.provenance.get_mut(&child_abs) {
                existing_prov.referenced_by.insert(parent_rel.clone());
            }
        }
        state.project_refs_map.insert(config_path, refs_for_project);
    }

    Ok(newly_discovered)
}

fn create_initial_snapshot(
    session: &Session,
    open_projects: &[String],
) -> Result<u64, ProjectOpenError> {
    let payload = serde_json::to_vec(&serde_json::json!({
        "openProjects": open_projects,
    }))
    .map_err(|err| ProjectOpenError::new("PROJECT_LOAD_ERROR", err.to_string()))?;

    let response = session
        .handle_request("createSnapshot", &payload)
        .map_err(|err| ProjectOpenError::new("PROJECT_LOAD_ERROR", err.to_string()))?;
    parse_tsrs_snapshot_id(response)
}

fn update_snapshot_open_projects(
    session: &Session,
    snapshot_id: u64,
    open_projects: &[String],
) -> Result<u64, ProjectOpenError> {
    let payload = serde_json::to_vec(&serde_json::json!({
        "snapshot": snapshot_id,
        "changes": {
            "openProjects": open_projects,
            "ensurePrograms": true,
        },
    }))
    .map_err(|err| ProjectOpenError::new("PROJECT_LOAD_ERROR", err.to_string()))?;

    let response = session
        .handle_request("updateSnapshot", &payload)
        .map_err(|err| ProjectOpenError::new("PROJECT_LOAD_ERROR", err.to_string()))?;
    parse_tsrs_snapshot_id(response)
}

fn parse_tsrs_snapshot_id(response: Response) -> Result<u64, ProjectOpenError> {
    let Response::Json(json_text) = response else {
        return Err(ProjectOpenError::new(
            "PROJECT_LOAD_ERROR",
            "Unexpected binary response from tsrs session.".to_string(),
        ));
    };
    let parsed: TsrsSnapshotResponse = serde_json::from_str(&json_text)
        .map_err(|err| ProjectOpenError::new("PROJECT_LOAD_ERROR", err.to_string()))?;
    Ok(parsed.snapshot)
}

fn collect_snapshot_programs(
    snapshot_data: &SnapshotData,
) -> BTreeMap<String, (ProjectId, &'static Program)> {
    let mut map = BTreeMap::new();
    for proj in snapshot_data.snapshot.project_collection.projects() {
        let Some(program) = proj.get_program() else {
            continue;
        };
        let config_norm = normalize_path(proj.config_file_name());
        map.insert(config_norm, (proj.id(), program));
    }
    map
}

fn build_opened_snapshot(
    tsrs_snapshot_id: u64,
    cwd: &str,
    snapshot_data: Arc<SnapshotData>,
    state: &DiscoveryState,
) -> Result<OpenedProjectsSnapshot, ProjectOpenError> {
    let programs_by_config = collect_snapshot_programs(&snapshot_data);
    let mut project_ids = BTreeMap::new();
    let mut summaries = Vec::with_capacity(state.discovery_order.len());

    for config_abs in &state.discovery_order {
        let Some(&(ref tsrs_pid, program)) = programs_by_config.get(config_abs) else {
            return Err(ProjectOpenError::new(
                "PROJECT_LOAD_ERROR",
                format!("Opened project missing program for {config_abs}"),
            ));
        };

        let config_rel = relative_to_cwd(cwd, config_abs);
        let project_id = config_rel.clone();
        let mut source_files = Vec::new();
        for &sf in program.get_source_files() {
            if !is_project_source_file(program, sf) {
                continue;
            }
            source_files.push(relative_to_cwd(cwd, sf.file_name()));
        }
        source_files.sort();
        source_files.dedup();

        let prov = state.provenance.get(config_abs);
        let entry_config = prov.map_or_else(|| config_rel.clone(), |p| p.entry_config.clone());
        let entry_chain = prov.map_or_else(|| vec![config_rel.clone()], |p| p.entry_chain.clone());
        let referenced_by =
            prov.map_or_else(Vec::new, |p| p.referenced_by.iter().cloned().collect());
        let project_references = state
            .project_refs_map
            .get(config_abs)
            .cloned()
            .unwrap_or_default();

        project_ids.insert(project_id.clone(), tsrs_pid.clone());
        summaries.push(ProjectSummary {
            project_id,
            config_file: config_rel,
            entry_config,
            entry_chain,
            referenced_by,
            project_references,
            compiler_options: summarize_compiler_options(&program.options()),
            source_files,
        });
    }

    if summaries.is_empty() {
        return Err(ProjectOpenError::new(
            "PROJECT_LOAD_ERROR",
            "No compiler projects were opened.".to_string(),
        ));
    }

    Ok(OpenedProjectsSnapshot {
        tsrs_snapshot_id,
        snapshot_data,
        project_ids,
        summaries,
    })
}

fn summarize_compiler_options(opts: &CompilerOptions) -> CompilerOptionsSummary {
    let target = (opts.target != ScriptTarget::NONE).then(|| format!("{:?}", opts.target));
    let module = (opts.module != ModuleKind::NONE).then(|| format!("{:?}", opts.module));
    let module_resolution = (opts.module_resolution != ModuleResolutionKind::UNKNOWN)
        .then(|| format!("{:?}", opts.module_resolution));
    let jsx = (opts.jsx != JsxEmit::NONE).then(|| format!("{:?}", opts.jsx));

    let mut paths = BTreeMap::new();
    if let Some(raw_paths) = &opts.paths {
        for (pattern, targets) in raw_paths.iter() {
            paths.insert(pattern.clone(), targets.clone().unwrap_or_default());
        }
    }

    CompilerOptionsSummary {
        strict: opts.strict.is_true(),
        allow_js: opts.allow_js.is_true(),
        check_js: opts.check_js.is_true(),
        composite: opts.composite.is_true(),
        target,
        module,
        module_resolution,
        jsx,
        paths,
        custom_conditions: opts.custom_conditions.clone().unwrap_or_default(),
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

fn format_diagnostic(diag: &TsrsDiagnostic) -> String {
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
